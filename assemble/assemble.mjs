/**
 * assemble.mjs — the pure logic kernel for publish.yml's "Generate" step.
 *
 * publish.yml's gather steps download every version's docs.zip into a staging
 * dir, then the extract step unzips them all into the site tree. This file is
 * the final step: given the populated site tree it orders the versions, writes
 * switcher.json + index.html, and prints the stable-alias source dir on stdout.
 * Exposed as three subcommands: two that decide what the gather should fetch, and one
 * that renders the assembled tree.
 *
 *   node assemble.mjs select-releases --default-branch <name> --out <file>
 *                                     [--seed-tag <tag>] [--max-releases <n>] < releases.json
 *       → write one TSV row per listed release to <file>, deciding whether (and
 *         where) it lands in the site; print the cache key for that exact selection
 *         on stdout. Runs BEFORE the gather, so publish.yml downloads only what it
 *         will actually publish.
 *
 *   node assemble.mjs select-artifacts --default-branch <name> --repo-id <id>
 *                                      [--prs <file>] [--max-prs <n>] < artifacts.json
 *       → print `dest \0 artifact-id \0 label \0` for every CI artifact to download
 *         (the default branch's, plus each eligible open PR's), ready for
 *         `xargs -0 -n 3`; a decision for every candidate goes to stderr.
 *
 *   node assemble.mjs generate --site-dir <dir> --base-url <url>
 *                              [--default-branch <name>] [--required <csv>]
 *       → write switcher.json + index.html into <dir>; print the stable-alias
 *         source dir (the newest deployed release) on stdout, or nothing. Also
 *         exit-1s if a --required branch is absent from the site.
 *
 * The pure functions take plain data so they unit-test without git, the network,
 * or (mostly) the filesystem. Only `discoverVersions`, `getSortedTags` and the
 * `generate` file writes touch IO.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

/** The `stable/` alias directory name (a fixed convention; see docs/ explanation). */
export const STABLE_ALIAS = "stable";

/** The release asset every gathered version arrives as (the docs.yml contract). */
export const DOCS_ZIP = "docs.zip";

/**
 * The sentinel tag carrying the pre-migration default-branch docs, published by
 * scripts/migrate.sh so a repo can cut over before `docs→main` ever builds. Not a
 * version: it stands in for the default branch, so it is exempt from `max-releases`.
 */
export const SEED_TAG = "pages-default-seed";

/**
 * Namespace for the release-zip `actions/cache` entries. Bump the version segment
 * whenever a change here would make an existing entry mean something different, so
 * old entries are abandoned rather than misread. `restore-keys` uses this bare
 * prefix, so the workflow takes it from `select-releases` too rather than repeating
 * the literal.
 */
export const RELZIPS_CACHE_PREFIX = "mvs-relzips-v1-";

/**
 * The cache key for a selection: the namespace plus a digest of the asset ids it
 * intends to publish. Content-addressed on the SET, so cutting a release misses (and
 * `restore-keys` then supplies the previous set, which shares every other zip), while
 * a deploy that changes nothing re-uses the entry exactly.
 *
 * Asset ids, not tags: an id names immutable bytes, so a re-cut release can never be
 * served from a stale entry. Skipped and capped-out releases contribute nothing, which
 * is what keeps a capped site's cache capped.
 */
export function cacheKey(rows = []) {
	const ids = rows
		.filter((row) => row.dest !== null)
		.map((row) => String(row.assetId))
		.sort();
	const digest = createHash("sha256")
		.update(ids.map((id) => `${id}\n`).join(""))
		.digest("hex")
		.slice(0, 32);
	return `${RELZIPS_CACHE_PREFIX}${digest}`;
}

/**
 * A site-size cap (`max-releases` / `max-prs`) as a non-negative integer; 0 means
 * unlimited. Throws on anything else.
 *
 * This used to be `Number(x) || 0`, which points the wrong way: `Number("3O")` is NaN
 * and `|| 0` turns NaN into 0 — so a typo in a consumer's publish.yml silently
 * DISABLED the cap that exists to stop a 1 GB deploy failure. A cap you cannot read is
 * not a cap of 0.
 */
export function parseCap(value, name = "cap") {
	if (value === undefined || value === null || value === "") return 0;
	const text = String(value).trim();
	if (!/^\d+$/.test(text)) {
		throw new Error(
			`${name} must be a non-negative integer (0 = unlimited), got ${JSON.stringify(value)}`,
		);
	}
	return Number(text);
}

/** Run a git command and return its non-empty stdout lines. */
function gitLines(args) {
	const out = execFileSync("git", args, { encoding: "utf8" });
	return out.trim().split("\n").filter(Boolean);
}

/** Directory names directly under the assembled site root (the gathered versions). */
export function discoverVersions(siteDir) {
	let entries;
	try {
		entries = readdirSync(siteDir, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((d) => d.isDirectory() && d.name !== STABLE_ALIAS)
		.map((d) => d.name);
}

/**
 * Tags newest-first, ordered by `compareTags` (NOT `git tag --sort=-v:refname`).
 * Tags containing `/` are dropped: the build trigger (`tags: ['*']`) never builds
 * them, so they have no matching `BASE_URL` build and would only create nested
 * site dirs. Every other tag is used verbatim as its `site/<tag>` dir name.
 *
 * git's version sort is not usable here: without a `versionsort.suffix` entry per
 * marker it ranks `1.1.0-beta.1` ABOVE `1.1.0`, and that list would have to be kept
 * in step with `isPrerelease` by hand. Sorting here keeps "what order" and "what
 * counts as a prerelease" in one module, sharing one marker list.
 */
export function getSortedTags() {
	return orderTags(gitLines(["tag", "-l"]).filter((tag) => !tag.includes("/")));
}

/**
 * Order the gathered versions: the default branch, then `master`/`main` if they are
 * present and distinct from it (a repo mid-rename may carry both), then tags
 * newest-first, then any leftover directories (e.g. PR previews) alphabetically.
 * `tags` must already be newest-first; `builds` are the directory names under `site/`.
 *
 * `defaultBranch` is optional so callers that have no opinion keep the historical
 * `master`/`main` behaviour: a consumer whose default branch is `develop` would
 * otherwise land it in the leftover bucket, sorted among the `pr-<n>` previews.
 */
export function orderVersions(builds, tags, defaultBranch) {
	const remaining = new Set(builds);

	const versions = [];
	for (const version of [defaultBranch, "master", "main", ...tags]) {
		if (!version) continue;
		if (remaining.has(version)) {
			versions.push(version);
			remaining.delete(version);
		}
	}
	// Leftover dirs (pr-<n> previews, feature branches) sort naturally so that,
	// e.g., pr-2 precedes pr-10 rather than sorting lexically.
	versions.push(
		...[...remaining].sort((a, b) =>
			a.localeCompare(b, undefined, { numeric: true }),
		),
	);
	return versions;
}

/**
 * Comparator: newest first, undated last. Timestamp ties break on `keyOf` ascending
 * — arbitrary, but a total order, which is what matters: an unstable ranking would
 * change the published set (and so the cache key) on identical inputs. The ONLY
 * "which of these is newest?" rule in this file: the release cap, the PR cap, the
 * default-branch artifact and the per-SHA index all reach it through `byDateDesc` or
 * `newest`, so none of them can break a tie differently from the others.
 */
function byDateDesc(keyOf) {
	return (a, b) => {
		const ta = a.date ? Date.parse(a.date) : Number.NEGATIVE_INFINITY;
		const tb = b.date ? Date.parse(b.date) : Number.NEGATIVE_INFINITY;
		if (ta !== tb) return tb - ta;
		return String(keyOf(a)).localeCompare(String(keyOf(b)));
	};
}

/**
 * Decide which releases contribute a version to the site, and why.
 *
 * Pure: takes the raw `GET /repos/{repo}/releases` array and returns one row per
 * release in input order, so publish.yml can print a decision table that accounts
 * for every release it listed. `dest` is the `site/<dir>` the release's docs.zip
 * becomes, or null when skipped.
 *
 * Selection is by release METADATA, newest first — never by parsing the version
 * number. Tags are wildly inconsistent across repos and a misparse silently drops
 * a release; the API already knows the order.
 *
 * The key is `created_at` (the tagged commit's date), NOT `published_at`, which
 * records when the release record was last published — re-publishing an old
 * release makes it look newer than releases that genuinely followed it.
 *
 * `maxReleases` caps how many releases the site publishes, because the deploy
 * uploads the WHOLE site as one artifact against a 1 GB Pages limit. 0 means
 * unlimited. The seed release is never capped — it is not a version, it stands in
 * for the default branch.
 *
 * @param {object[]} releases raw release objects
 * @param {{defaultBranch: string, seedTag?: string, maxReleases?: number}} opts
 * @returns {{tag: string, dest: string|null, date: string|null,
 *            assetId: number|null, size: number, decision: string}[]}
 */
export function selectReleases(
	releases = [],
	{ defaultBranch, seedTag = SEED_TAG, maxReleases = 0 } = {},
) {
	const cap = parseCap(maxReleases, "max-releases");

	const rows = releases.map((release) => {
		const tag = release?.tag_name ?? "";
		const asset = (release?.assets ?? []).find((a) => a?.name === DOCS_ZIP);
		const row = {
			tag,
			dest: null,
			date: release?.created_at ?? release?.published_at ?? null,
			assetId: asset?.id ?? null,
			size: asset?.size ?? 0,
			decision: "",
		};
		// Order matters: report the most fundamental reason a release is unusable.
		// A `/`-tag is never built (the `tags: ['*']` trigger excludes it), so it has
		// no BASE_URL-correct build and would nest a dir inside the site tree.
		if (!tag) row.decision = "skip: release has no tag name";
		else if (tag.includes("/")) row.decision = "skip: '/' in tag (never built)";
		else if (tag === defaultBranch)
			row.decision = "skip: same name as the default branch";
		else if (!asset) row.decision = `skip: no ${DOCS_ZIP} asset`;
		else if (tag === seedTag) {
			row.dest = defaultBranch;
			row.decision = `seed release → ${defaultBranch}`;
		} else {
			row.dest = tag;
			row.decision = "gather";
		}
		return row;
	});

	if (cap > 0) {
		// Rank only the rows that would otherwise be gathered, so a skipped release
		// never consumes a slot. Everything past the cap is demoted in place.
		const ranked = rows
			.filter((row) => row.dest !== null && row.tag !== seedTag)
			.sort(byDateDesc((row) => row.tag));
		for (const row of ranked.slice(cap)) {
			row.dest = null;
			row.decision = `skip: beyond max-releases=${cap} (dated ${row.date ?? "unknown"})`;
		}
	}
	return rows;
}

/**
 * Decide which CI artifacts contribute a version, and why.
 *
 * Pure: takes the flattened `GET /repos/{repo}/actions/artifacts?name=docs` list plus
 * the open-PR list with fork approval already resolved (that costs an API call per fork
 * PR, so the caller settles it), and returns one row per candidate — the default branch
 * and every PR — in a stable order, so the workflow can print a table accounting for all
 * of them. `dest` is the `site/<dir>` the artifact becomes, or null when skipped.
 *
 * Two different lookups, deliberately:
 *
 *   - The DEFAULT BRANCH takes the newest artifact built from THIS repo on that branch.
 *     `repoId` is a security boundary, not an optimisation: a fork's pull_request run
 *     executes in the upstream repo's Actions, so without it a fork branch named `main`
 *     could land in `site/main`. The chosen artifact is that filtered one — never a
 *     re-lookup by SHA, which could hand back a fork's artifact for the same commit.
 *   - A PR takes the newest artifact at its head SHA with NO repo filter, because a fork
 *     PR's artifact legitimately belongs to the fork. `approved` is what gates those.
 *
 * `maxPrs` caps how many previews the site carries, ranked by build date. As with
 * releases, the cap applies AFTER eligibility, so a PR with no artifact or an
 * unapproved fork PR never consumes a slot. 0 means unlimited.
 *
 * @param {object[]} artifacts flattened artifact objects (expired ones are dropped here)
 * @param {{defaultBranch: string, repoId: number|string,
 *          prs?: {num: string, sha: string, approved: boolean}[],
 *          maxPrs?: number}} opts
 * @returns {{dest: string|null, label: string, artifactId: number|null, sha: string,
 *            date: string|null, size: number, runId: number|null, decision: string}[]}
 */
export function selectArtifacts(
	artifacts = [],
	{ defaultBranch, repoId, prs = [], maxPrs = 0 } = {},
) {
	const cap = parseCap(maxPrs, "max-prs");
	const live = artifacts.filter((a) => a && !a.expired);

	const meta = (artifact) => ({
		artifactId: artifact?.id ?? null,
		date: artifact?.created_at ?? null,
		size: artifact?.size_in_bytes ?? 0,
		runId: artifact?.workflow_run?.id ?? null,
	});
	// byDateDesc reads `.date`; artifacts carry `created_at`, so map before sorting
	// rather than silently comparing undefined against undefined.
	const newest = (candidates) =>
		candidates.length === 0
			? null
			: candidates
					.map((a) => ({ date: a?.created_at ?? null, key: String(a?.id), a }))
					.sort(byDateDesc((x) => x.key))[0].a;

	// Newest artifact per head SHA, for the PR lookups — through `newest`, so BOTH
	// lookups break a timestamp tie the same way. This loop used to keep whichever
	// artifact the API happened to return last, i.e. page order, which is not a rule
	// at all: two artifacts created in the same second (a matrix, a re-run) could
	// swap the preview between deploys.
	const groups = new Map();
	for (const artifact of live) {
		const sha = artifact?.workflow_run?.head_sha;
		if (!sha) continue;
		const list = groups.get(sha);
		if (list) list.push(artifact);
		else groups.set(sha, [artifact]);
	}
	const bySha = new Map([...groups].map(([sha, list]) => [sha, newest(list)]));

	const rows = [];

	const branchArtifact = newest(
		live.filter(
			(a) =>
				a?.workflow_run?.head_branch === defaultBranch &&
				String(a?.workflow_run?.head_repository_id) === String(repoId),
		),
	);
	rows.push({
		dest: branchArtifact ? defaultBranch : null,
		label: `default-branch CI (${defaultBranch})`,
		sha: branchArtifact?.workflow_run?.head_sha ?? "",
		...meta(branchArtifact),
		decision: branchArtifact
			? "gather"
			: "skip: no non-expired 'docs' artifact for the default branch",
	});

	const prRows = prs.map((pr) => {
		const artifact = pr.approved ? bySha.get(pr.sha) : undefined;
		const row = {
			dest: null,
			label: `PR #${pr.num}`,
			num: pr.num,
			sha: pr.sha,
			...meta(artifact),
			decision: "",
		};
		if (!pr.approved) {
			row.decision = `skip: fork PR, head ${pr.sha.slice(0, 8)} not preview-approved`;
		} else if (!artifact) {
			row.decision = `skip: no non-expired 'docs' artifact for ${pr.sha.slice(0, 8)}`;
		} else {
			row.dest = `pr-${pr.num}`;
			row.decision = "gather";
		}
		return row;
	});

	if (cap > 0) {
		const ranked = prRows
			.filter((row) => row.dest !== null)
			.sort(byDateDesc((row) => row.num));
		for (const row of ranked.slice(cap)) {
			row.dest = null;
			row.decision = `skip: beyond max-prs=${cap} (built ${row.date ?? "unknown"})`;
		}
	}
	rows.push(...prRows);
	return rows;
}

/**
 * The prerelease markers, longest-first so `preview` is not shadowed by `pre`.
 * ONE list, used three ways: to test a tag (`isPrerelease`), to rank a prerelease
 * below the release it qualifies (`compareTags`), and — as the identical literal —
 * by release.yml's `--prerelease` test, which `test_release_prerelease.py` holds to
 * this file. Covers PEP 440 (`1.0a1`, `2.0rc1`, `1.0.dev0`) and the hyphenated
 * semver spellings (`1.1.0-beta.1`, `2.0.0-rc.1`).
 */
const MARKERS = "alpha|beta|preview|pre|rc|dev|a|b|c";

/**
 * A marker anywhere in the tag, immediately after a digit (with an optional `.`,
 * `-` or `_` between). The digit anchor keeps tags that merely contain those
 * letters (`release-1.0`, `beta-program`) out of the prerelease set; the trailing
 * lookahead keeps a longer word (`1.0-candidate`, `1.0-canary`) out of it too.
 */
const PRERELEASE_RE = new RegExp(`\\d[._-]?(${MARKERS})(?![a-z])`, "i");

/** The same marker, but anchored at the START of a version's trailing segment. */
const PRERELEASE_SUFFIX_RE = new RegExp(`^[._-]?(${MARKERS})(?![a-z])`, "i");

/**
 * Is `tag` a prerelease? Mirrors `release.yml`'s `--prerelease` test so "stable"
 * means the same thing repo-wide — the two are held together by a drift test
 * (`test/workflow-harness/test_release_prerelease.py`) rather than by comment alone.
 */
export function isPrerelease(tag) {
	return PRERELEASE_RE.test(tag);
}

/** A tag split into runs of digits and non-digits, for segment-wise comparison. */
function tagTokens(tag) {
	// A leading `v` is a spelling of the same version (`v1.2.3` ≡ `1.2.3`), so drop
	// it — but only before a digit, or `version-2` would become `ersion-2`.
	return (
		String(tag)
			.replace(/^v(?=\d)/i, "")
			.match(/\d+|\D+/g) ?? []
	);
}

/**
 * Compare two tags, NEWEST FIRST (so it sorts descending), with one invariant that
 * `git tag --sort=-v:refname` does not give us: **every prerelease of X sorts after
 * X**. Digit runs compare numerically (so `1.10` > `1.9`), other runs as strings.
 *
 * When one tag is the other plus a trailing segment, that segment decides: a
 * prerelease marker (`1.1.0` vs `1.1.0-beta.1`) demotes the longer tag, anything
 * else (`1.1` vs `1.1.1`) promotes it. Ties fall back to the raw string, so the
 * order is total — an unstable ranking would change the published set on identical
 * inputs.
 */
export function compareTags(a, b) {
	const ta = tagTokens(a);
	const tb = tagTokens(b);
	for (let i = 0; i < Math.min(ta.length, tb.length); i += 1) {
		if (ta[i] === tb[i]) continue;
		const na = /^\d+$/.test(ta[i]);
		const nb = /^\d+$/.test(tb[i]);
		if (na && nb) return Number(tb[i]) - Number(ta[i]);
		return ta[i] < tb[i] ? 1 : -1;
	}
	if (ta.length !== tb.length) {
		const longer = ta.length > tb.length ? ta : tb;
		const rest = longer.slice(Math.min(ta.length, tb.length)).join("");
		const demoted = PRERELEASE_SUFFIX_RE.test(rest);
		// `sign` is +1 when `a` is the longer tag: demoted ⇒ a sorts later.
		const sign = ta.length > tb.length ? 1 : -1;
		return demoted ? sign : -sign;
	}
	return String(a).localeCompare(String(b));
}

/** Tags newest-first by `compareTags`. Pure; `getSortedTags` is the IO wrapper. */
export function orderTags(tags = []) {
	return [...tags].sort(compareTags);
}

/**
 * The preferred (stable) version: the newest non-prerelease tag that is actually
 * deployed, else the default branch, else `main`, else `master`, else the first
 * version. `tags` must be newest-first; `versions` is the deployed set (output of
 * `orderVersions`). `defaultBranch` is optional — see `orderVersions`.
 */
export function preferredVersion(versions, tags, defaultBranch) {
	for (const tag of tags) {
		if (!isPrerelease(tag) && versions.includes(tag)) return tag;
	}
	for (const branch of [defaultBranch, "main", "master"]) {
		if (branch && versions.includes(branch)) return branch;
	}
	return versions[0] ?? null;
}

/**
 * Decide the root redirect target and the stable-alias source.
 *
 * When `preferred` is a genuine deployed non-prerelease *tag*, the site publishes
 * a `stable/` alias pointing at it and the root redirects to the constant
 * `stable/` URL. Before the first release (preferred is the default branch or a
 * leftover, or a prerelease-only fallback) there is no `stable/` and the root
 * redirects straight to that fallback version.
 *
 * @returns {{preferred: string|null, stableSrc: string|null, redirectTarget: string|null}}
 *   `stableSrc` is the version dir to alias as `stable/` (or null); `redirectTarget`
 *   is the dir the root `index.html` should redirect to.
 */
export function stablePlan(versions, tags, defaultBranch) {
	const preferred = preferredVersion(versions, tags, defaultBranch);
	if (preferred && tags.includes(preferred) && !isPrerelease(preferred)) {
		return { preferred, stableSrc: preferred, redirectTarget: STABLE_ALIAS };
	}
	return { preferred, stableSrc: null, redirectTarget: preferred };
}

/**
 * Required branches that did not end up in the assembled site. Pure. `versions`
 * are the discovered site dirs; a required branch is present iff its name is among
 * them. Guards that a branch the site cannot do without (default: the repo's
 * default branch) did not silently vanish — `generate` hard-fails on a non-empty
 * result rather than publishing a hole.
 *
 * @param {string[]} [required] branches that must be present (raw names)
 * @param {string[]} [versions] discovered site dir names
 * @returns {string[]} the absent required branches
 */
export function missingRequired(required = [], versions = []) {
	const have = new Set(versions);
	return required.filter((branch) => !have.has(branch));
}

/**
 * Build the pydata switcher array rooted at `baseUrl` (the site's live Pages
 * URL — publish.yml resolves it from the Pages API, so custom domains work),
 * flagging the stable entry.
 */
export function switcherStruct(baseUrl, versions, preferred) {
	const base = String(baseUrl).replace(/\/+$/, "");
	return versions.map((version) => {
		const entry = {
			version,
			url: `${base}/${version}/`,
		};
		if (version === preferred) entry.preferred = true;
		return entry;
	});
}

/** Serialise the switcher as pydata-style 2-space JSON. */
export function renderSwitcher(baseUrl, versions, preferred) {
	return JSON.stringify(switcherStruct(baseUrl, versions, preferred), null, 2);
}

/** Escape a value for an HTML attribute or text node. */
function escapeHtml(value) {
	return String(value)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/**
 * Root redirect to `target` (relative, so it is host- and repo-agnostic).
 *
 * `target` is a version name, which docs.yml validates down to `[A-Za-z0-9._-]` — so
 * the escaping is belt-and-braces. It stays because this renders HTML from a value
 * that ultimately derives from a ref name, and the two rules live in different files:
 * loosening the workflow's character set should not be able to inject markup here.
 */
export function renderRedirect(target) {
	const safe = escapeHtml(target);
	return `<!DOCTYPE html>
<html>

<head>
    <title>Redirecting to ${safe}</title>
    <meta charset="utf-8">
    <meta http-equiv="refresh" content="0; url=./${safe}/index.html">
    <link rel="canonical" href="${safe}/index.html">
</head>

</html>
`;
}

/* ------------------------------- subcommands ------------------------------ */

/** Split a comma-separated CLI list into trimmed, non-empty entries. */
function csv(value) {
	return (value ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

/**
 * A TSV field that is never empty. `read` treats tab as IFS whitespace and
 * COLLAPSES runs of it, so one empty field would shift every column after it in
 * the consuming bash loop. "-" is the empty marker on the wire.
 */
function field(value) {
	const s = value === null || value === undefined ? "" : String(value);
	return s === "" ? "-" : s;
}

/**
 * `select-releases --default-branch <name> [--seed-tag <tag>] [--max-releases <n>]`
 * — read the releases JSON (as `gh api --paginate .../releases | jq -rs 'add'`
 * gives it) on stdin, write one TSV row per release on stdout:
 *
 *     tag <TAB> dest <TAB> date <TAB> size <TAB> assetId <TAB> decision
 *
 * `dest` is "-" for a release that contributes nothing. Every listed release gets
 * a row, so publish.yml's decision table accounts for all of them.
 */
function cmdSelectReleases(rest) {
	const { values } = parseArgs({
		args: rest,
		options: {
			"default-branch": { type: "string" },
			"seed-tag": { type: "string" },
			"max-releases": { type: "string" },
			out: { type: "string" },
		},
	});
	const defaultBranch = values["default-branch"];
	const out = values.out;
	if (!defaultBranch || !out) {
		throw new Error(
			"usage: assemble.mjs select-releases --default-branch <name> --out <file> [--seed-tag <tag>] [--max-releases <n>] < releases.json",
		);
	}
	const raw = readFileSync(0, "utf8").trim();
	const releases = raw ? JSON.parse(raw) : [];
	const cap = parseCap(values["max-releases"], "--max-releases");

	const rows = selectReleases(releases, {
		defaultBranch,
		seedTag: values["seed-tag"] || SEED_TAG,
		maxReleases: cap,
	});
	const gathered = rows.filter((row) => row.dest !== null);

	console.error(
		`${rows.length} release(s) listed, ${gathered.length} selected` +
			(cap > 0 ? ` (max-releases=${cap})` : " (max-releases unlimited)"),
	);
	const dropped = rows.filter((row) => row.decision.startsWith("skip: beyond"));
	if (dropped.length > 0) {
		console.error(
			`${dropped.length} release(s) dropped by the cap — oldest kept: ` +
				`${gathered.map((r) => r.tag).slice(-1)[0] ?? "(none)"}`,
		);
	}

	const tsv = rows
		.map((row) =>
			[
				field(row.tag),
				field(row.dest),
				field(row.date),
				field(row.size),
				field(row.assetId),
				field(row.decision),
			].join("\t"),
		)
		.map((line) => `${line}\n`)
		.join("");
	writeFileSync(out, tsv, "utf8");

	// The only stdout: the cache key for exactly this selection.
	console.log(cacheKey(rows));
}

/**
 * `select-artifacts --default-branch <name> --repo-id <id> [--prs <file>]
 *                  [--max-prs <n>] [--server-url <url>] [--repo <owner/name>]`
 * — read the flattened artifacts JSON on stdin (`gh api --paginate … | jq -rs
 * '[.[].artifacts[]]'`) and print, for every artifact to download, three NUL-separated
 * fields: dest, artifact id, label. That feeds `xargs -0 -n 3` directly, which hands
 * them to the worker as positional args — data, never script text. NUL because a label
 * carries spaces and a delimiter the payload cannot contain is the only kind that
 * cannot be spoofed by it. Decisions go to stderr, so the log stays readable.
 *
 * `--prs` is TSV: `number <TAB> head-sha <TAB> approved`, with fork approval already
 * resolved by the caller (it costs an API call per fork PR).
 */
function cmdSelectArtifacts(rest) {
	const { values } = parseArgs({
		args: rest,
		options: {
			"default-branch": { type: "string" },
			"repo-id": { type: "string" },
			"max-prs": { type: "string" },
			prs: { type: "string" },
			"server-url": { type: "string" },
			repo: { type: "string" },
		},
	});
	const { "default-branch": defaultBranch, "repo-id": repoId } = values;
	if (!defaultBranch || !repoId) {
		throw new Error(
			"usage: assemble.mjs select-artifacts --default-branch <name> --repo-id <id> [--prs <file>] [--max-prs <n>] [--server-url <url>] [--repo <owner/name>] < artifacts.json",
		);
	}
	const raw = readFileSync(0, "utf8").trim();
	const artifacts = raw ? JSON.parse(raw) : [];

	const prs = (values.prs ? readFileSync(values.prs, "utf8") : "")
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [num, sha, approved] = line.split("\t");
			return { num, sha: sha ?? "", approved: approved === "true" };
		});

	const cap = parseCap(values["max-prs"], "--max-prs");
	const rows = selectArtifacts(artifacts, {
		defaultBranch,
		repoId,
		prs,
		maxPrs: cap,
	});
	const wanted = rows.filter((row) => row.dest !== null);

	console.error(
		`${artifacts.filter((a) => a && !a.expired).length} non-expired 'docs' artifact(s), ` +
			`${prs.length} open PR(s), ${wanted.length} to gather` +
			(cap > 0 ? ` (max-prs=${cap})` : ""),
	);
	const runUrl = (row) =>
		values.repo && row.runId
			? ` from ${values["server-url"] || "https://github.com"}/${values.repo}/actions/runs/${row.runId}`
			: "";
	for (const row of rows) {
		console.error(
			row.dest === null
				? `  ${row.label} → ${row.decision}`
				: `  ${row.label} → artifact ${row.artifactId} (${row.size} B, built ${row.date})${runUrl(row)} @ ${row.sha.slice(0, 8)}`,
		);
	}

	// The only stdout: NUL-separated triples for `xargs -0 -n 3`.
	process.stdout.write(
		wanted
			.map((row) => `${row.dest}\0${row.artifactId}\0${row.label}\0`)
			.join(""),
	);
}

/**
 * `generate --site-dir --base-url [--default-branch <name>] [--required <csv>]` — write switcher.json +
 * index.html and emit the stable-alias source. Runs after all gathering, so it
 * also hard-fails (exit 1) if a `--required` branch is absent from the site.
 */
function cmdGenerate(rest) {
	const { values } = parseArgs({
		args: rest,
		options: {
			"site-dir": { type: "string" },
			"base-url": { type: "string" },
			"default-branch": { type: "string" },
			required: { type: "string" },
		},
	});
	const siteDir = values["site-dir"];
	const baseUrl = values["base-url"];
	if (!siteDir || !baseUrl) {
		throw new Error(
			"usage: assemble.mjs generate --site-dir <dir> --base-url <url> [--default-branch <name>] [--required <csv>]",
		);
	}

	const builds = discoverVersions(siteDir);

	// Guard the required branches before writing anything: a required branch
	// with no gathered dir means the deploy would publish a hole.
	const missing = missingRequired(csv(values.required), builds);
	if (missing.length > 0) {
		console.error(
			`Required branch(es) not present in the assembled site (no current build or recent CI artifact): ${missing.join(", ")}`,
		);
		process.exitCode = 1;
		return;
	}

	// Tags are used verbatim as site dirs (getSortedTags drops `/`-tags), so
	// ordering + preferred + stable compare directly against the discovered dirs.
	// The default branch is not assumed to be main/master: it heads the switcher and
	// is the preferred version until a release is deployed.
	const defaultBranch = values["default-branch"];
	const tags = getSortedTags();
	const versions = orderVersions(builds, tags, defaultBranch);
	const preferred = preferredVersion(versions, tags, defaultBranch);
	const { stableSrc, redirectTarget } = stablePlan(
		versions,
		tags,
		defaultBranch,
	);

	// Diagnostics go to stderr so stdout carries only the stable-alias source.
	console.error(`Sorted versions: ${JSON.stringify(versions)}`);
	console.error(`Preferred version: ${preferred}`);
	console.error(`Redirect target: ${redirectTarget}`);
	console.error(`Stable alias source: ${stableSrc ?? "(none)"}`);

	writeFileSync(
		join(siteDir, "switcher.json"),
		renderSwitcher(baseUrl, versions, preferred),
		"utf8",
	);
	if (redirectTarget) {
		writeFileSync(
			join(siteDir, "index.html"),
			renderRedirect(redirectTarget),
			"utf8",
		);
	}

	// The only stdout: the dir to symlink as stable/ (empty when no release yet).
	if (stableSrc) console.log(stableSrc);
}

export function main(argv = process.argv.slice(2)) {
	const [cmd, ...rest] = argv;
	switch (cmd) {
		case "generate":
			return cmdGenerate(rest);
		case "select-releases":
			return cmdSelectReleases(rest);
		case "select-artifacts":
			return cmdSelectArtifacts(rest);
		default:
			throw new Error(
				"usage: assemble.mjs generate|select-releases|select-artifacts ...",
			);
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main();
}

/**
 * assemble.mjs — the pure logic kernel for publish.yml's "Generate" step.
 *
 * publish.yml's gather steps download every version's docs.zip into a staging
 * dir, then the extract step unzips them all into the site tree. This file is
 * the final step: given the populated site tree it orders the versions, writes
 * switcher.json + index.html, and prints the stable-alias source dir on stdout.
 * Exposed as two subcommands, one at each end of the gather:
 *
 *   node assemble.mjs select-releases --default-branch <name> [--seed-tag <tag>]
 *                                     [--max-releases <n>] < releases.json
 *       → one TSV row per listed release deciding whether (and where) it lands in
 *         the site. Runs BEFORE the gather, so publish.yml downloads only what it
 *         will actually publish.
 *
 *   node assemble.mjs generate --site-dir <dir> --base-url <url> [--required <csv>]
 *       → write switcher.json + index.html into <dir>; print the stable-alias
 *         source dir (the newest deployed release) on stdout, or nothing. Also
 *         exit-1s if a --required branch is absent from the site.
 *
 * The pure functions take plain data so they unit-test without git, the network,
 * or (mostly) the filesystem. Only `discoverVersions`, `getSortedTags` and the
 * `generate` file writes touch IO.
 */
import { execFileSync } from "node:child_process";
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
 * The DEPRECATED in-site durable store (`_sources/<default>.zip`). publish.yml used
 * to persist the default branch's docs.zip here every deploy; it now caches it
 * instead, so newly assembled trees never contain this directory. The exclusion
 * stays as insurance — it costs nothing, and a stray `_sources` dir must never be
 * mistaken for a version.
 */
export const SOURCES_DIR = "_sources";

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
		.filter(
			(d) =>
				d.isDirectory() && d.name !== STABLE_ALIAS && d.name !== SOURCES_DIR,
		)
		.map((d) => d.name);
}

/**
 * Tags newest-first (semver-aware), matching `git tag -l --sort=-v:refname`.
 * Tags containing `/` are dropped: the build trigger (`tags: ['*']`) never builds
 * them, so they have no matching `BASE_URL` build and would only create nested
 * site dirs. Every other tag is used verbatim as its `site/<tag>` dir name.
 */
export function getSortedTags() {
	return gitLines(["tag", "-l", "--sort=-v:refname"]).filter(
		(tag) => !tag.includes("/"),
	);
}

/**
 * Order the gathered versions: `master`, `main`, then tags newest-first, then any
 * leftover directories (e.g. feature-branch previews) alphabetically. `tags` must
 * already be newest-first. Versions are the directory names under `site/` — the
 * current build is already among them, so there is no `add` parameter.
 */
export function orderVersions(builds, tags) {
	const remaining = new Set(builds);

	const versions = [];
	for (const version of ["master", "main", ...tags]) {
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
 * Newest first. Releases with no date sort last, and ties break on tag name so
 * the selection is deterministic (two releases can share a timestamp).
 */
function byDateDesc(a, b) {
	const ta = a.date ? Date.parse(a.date) : Number.NEGATIVE_INFINITY;
	const tb = b.date ? Date.parse(b.date) : Number.NEGATIVE_INFINITY;
	if (ta !== tb) return tb - ta;
	return a.tag.localeCompare(b.tag);
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
 * The key is `created_at` (the tagged commit's date), NOT `published_at`.
 * `published_at` records when the release record was last published, so
 * re-publishing an old release makes it look new: blueapi has `1.3.2-a9` created
 * 2025-10-01 but published 2026-07-30, which under `published_at` outranks the
 * genuinely newer `1.11.3`. `created_at` is immune to that.
 *
 * `maxReleases` caps how many releases the site publishes. It exists because the
 * deploy uploads the WHOLE site as one artifact and GitHub Pages caps that at 1 GB:
 * a repo with 131 released docs.zips was at 452 MB and climbing ~5 MB per release.
 * 0 means unlimited. The seed release is never capped — it is not a version, it
 * stands in for the default branch.
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
	const cap = Number(maxReleases) > 0 ? Number(maxReleases) : 0;

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
			.sort(byDateDesc);
		for (const row of ranked.slice(cap)) {
			row.dest = null;
			row.decision = `skip: beyond max-releases=${cap} (dated ${row.date ?? "unknown"})`;
		}
	}
	return rows;
}

/**
 * Is `tag` a prerelease? Mirrors `release.yml`'s test (a PEP 440-style `a`,
 * `b`, or `rc` marker *following a digit*, e.g. `1.0a1`/`2.0rc1`) so "stable"
 * means the same thing repo-wide. Anchoring on the digit keeps tags that merely
 * contain those letters (`release-1.0`, `beta-program`) out of the prerelease set.
 */
export function isPrerelease(tag) {
	return /\d(a|b|rc)/i.test(tag);
}

/**
 * The preferred (stable) version: the newest non-prerelease tag that is actually
 * deployed, else `main`, else `master`, else the first version. `tags` must be
 * newest-first; `versions` is the deployed set (output of `orderVersions`).
 */
export function preferredVersion(versions, tags) {
	for (const tag of tags) {
		if (!isPrerelease(tag) && versions.includes(tag)) return tag;
	}
	if (versions.includes("main")) return "main";
	if (versions.includes("master")) return "master";
	return versions[0] ?? null;
}

/**
 * Decide the root redirect target and the stable-alias source.
 *
 * When `preferred` is a genuine deployed non-prerelease *tag*, the site publishes
 * a `stable/` alias pointing at it and the root redirects to the constant
 * `stable/` URL. Before the first release (preferred is `main`/`master`/a
 * leftover, or a prerelease-only fallback) there is no `stable/` and the root
 * redirects straight to that fallback version, as today.
 *
 * @returns {{preferred: string|null, stableSrc: string|null, redirectTarget: string|null}}
 *   `stableSrc` is the version dir to alias as `stable/` (or null); `redirectTarget`
 *   is the dir the root `index.html` should redirect to.
 */
export function stablePlan(versions, tags) {
	const preferred = preferredVersion(versions, tags);
	if (preferred && tags.includes(preferred) && !isPrerelease(preferred)) {
		return { preferred, stableSrc: preferred, redirectTarget: STABLE_ALIAS };
	}
	return { preferred, stableSrc: null, redirectTarget: preferred };
}

/**
 * Required branches that did not end up in the assembled site. Pure. `versions`
 * are the discovered site dirs; a required branch is present iff its name is
 * among them. By the time `generate` runs, the current
 * ref and every gathered branch are already dirs, so this needs no separate
 * "present" bookkeeping. The action gathers a preview for every branch with a
 * recent CI build (dumb bash); this only guards that the required branches
 * (default: the repo's default branch) didn't silently vanish. `generate`
 * hard-fails on a non-empty result.
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

/** Serialise the switcher exactly as the Python tool did (2-space JSON). */
export function renderSwitcher(baseUrl, versions, preferred) {
	return JSON.stringify(switcherStruct(baseUrl, versions, preferred), null, 2);
}

/** Root redirect to `target` (relative, so it is host- and repo-agnostic). */
export function renderRedirect(target) {
	return `<!DOCTYPE html>
<html>

<head>
    <title>Redirecting to ${target}</title>
    <meta charset="utf-8">
    <meta http-equiv="refresh" content="0; url=./${target}/index.html">
    <link rel="canonical" href="${target}/index.html">
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
		},
	});
	const defaultBranch = values["default-branch"];
	if (!defaultBranch) {
		throw new Error(
			"usage: assemble.mjs select-releases --default-branch <name> [--seed-tag <tag>] [--max-releases <n>] < releases.json",
		);
	}
	const raw = readFileSync(0, "utf8").trim();
	const releases = raw ? JSON.parse(raw) : [];
	const cap = Number(values["max-releases"] ?? 0) || 0;

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
	if (cap > 0 && rows.length - gathered.length > 0) {
		const dropped = rows.filter((row) =>
			row.decision.startsWith("skip: beyond"),
		);
		if (dropped.length > 0) {
			console.error(
				`${dropped.length} release(s) dropped by the cap — oldest kept: ` +
					`${gathered.map((r) => r.tag).slice(-1)[0] ?? "(none)"}`,
			);
		}
	}

	for (const row of rows) {
		const cells = [
			field(row.tag),
			field(row.dest),
			field(row.date),
			field(row.size),
			field(row.assetId),
			field(row.decision),
		];
		process.stdout.write(`${cells.join("\t")}\n`);
	}
}

/**
 * `generate --site-dir --base-url [--required <csv>]` — write switcher.json +
 * index.html and emit the stable-alias source. Runs after all gathering, so it
 * also hard-fails (exit 1) if a `--required` branch is absent from the site.
 */
function cmdGenerate(rest) {
	const { values } = parseArgs({
		args: rest,
		options: {
			"site-dir": { type: "string" },
			"base-url": { type: "string" },
			required: { type: "string" },
		},
	});
	const siteDir = values["site-dir"];
	const baseUrl = values["base-url"];
	if (!siteDir || !baseUrl) {
		throw new Error(
			"usage: assemble.mjs generate --site-dir <dir> --base-url <url> [--required <csv>]",
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
	const tags = getSortedTags();
	const versions = orderVersions(builds, tags);
	const preferred = preferredVersion(versions, tags);
	const { stableSrc, redirectTarget } = stablePlan(versions, tags);

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
		default:
			throw new Error("usage: assemble.mjs generate|select-releases ...");
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main();
}

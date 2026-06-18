/**
 * assemble — the logic kernel behind the `assemble` composite action.
 *
 * The action reconstructs the *whole* versioned docs site on every deploy from
 * durable sources (this build, `docs.zip` release assets, branch CI artifacts),
 * then the caller publishes it directly to GitHub Pages. Bash does the IO
 * plumbing (`gh` downloads, `unzip`, `mv`); this file is the pure-ish kernel it
 * shells into, exposed as three subcommands:
 *
 *   node assemble.mjs sanitize <ref-name>
 *       → print the sanitised version (the BASE_URL sub-path + site/ dir name).
 *
 *   node assemble.mjs plan-branches --ref-name <r> --required <csv> \
 *       --optional <csv> --ci <json>
 *       → print the fetch list as `<runId>\t<destDir>` TSV lines (one per
 *         branch, so bash reads it with `while read` and never parses JSON);
 *         exit 1 if a required branch is neither the current ref nor present in
 *         the CI catalogue.
 *
 *   node assemble.mjs generate --site-dir <dir> --repo <org/repo>
 *       → write switcher.json + index.html into <dir>; print the stable-alias
 *         source dir (the newest deployed release) on stdout, or nothing.
 *
 *   node assemble.mjs migrate [--pages-ref <ref>] [--repo <org/repo>] [--dry-run]
 *       → one-time gh-pages → durable-source backfill: for each release tag with a
 *         gh-pages version dir but no docs.zip asset, zip that dir as bare html/
 *         and `gh release upload --clobber`. Prints each backfilled tag; --dry-run
 *         prints the plan and uploads nothing. Used by the cutover script.
 *
 * The pure functions take plain data so they unit-test without git, the network,
 * or (mostly) the filesystem. Only `discoverVersions`, `getSortedTags` and the
 * `generate` file writes touch IO.
 */
import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

/** The `stable/` alias directory name (a fixed convention; see DESIGN). */
export const STABLE_ALIAS = "stable";

/** Run a git command and return its non-empty stdout lines. */
function gitLines(args) {
	const out = execFileSync("git", args, { encoding: "utf8" });
	return out.trim().split("\n").filter(Boolean);
}

/**
 * Sanitise a raw ref name into the single token used in two byte-identical
 * places: the build-time `BASE_URL` sub-path and the `site/<version>` directory.
 * Mirrors the shell rule `${GITHUB_REF_NAME//[^A-Za-z0-9._-]/_}` — every
 * character outside `[A-Za-z0-9._-]` becomes `_`. Shared with `current-version`
 * so there is one implementation and no bash-vs-JS drift.
 */
export function sanitize(name) {
	return String(name).replace(/[^A-Za-z0-9._-]/g, "_");
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

/** Tags newest-first (semver-aware), matching `git tag -l --sort=-v:refname`. */
export function getSortedTags() {
	return gitLines(["tag", "-l", "--sort=-v:refname"]);
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
	versions.push(...[...remaining].sort());
	return versions;
}

/**
 * Is `tag` a prerelease? Mirrors `_release.yml`'s test (an `a`, `b`, or `rc`
 * marker in the name, PEP 440 style) so "stable" means the same thing repo-wide.
 */
export function isPrerelease(tag) {
	return /a|b|rc/i.test(tag);
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
 * Resolve which branch previews to fetch, given the current ref, the required and
 * optional branch lists, and the CI catalogue (latest successful `docs` run per
 * branch). Pure — fed plain data, so it tests with fixtures.
 *
 * The current ref's build is already staged as a directory, so it is never
 * fetched. A required branch that is neither the current ref nor present in the
 * catalogue is unsatisfiable; the caller hard-fails on a non-empty
 * `missingRequired`. Optional-and-absent branches are silently dropped.
 *
 * @param {object}   args
 * @param {string}   args.refName    unsanitised current ref
 * @param {string[]} [args.required] branches that must be present
 * @param {string[]} [args.optional] branches to include if available
 * @param {Array<{branch:string, runId:(string|number)}>} [args.ci]
 *        latest successful run id per branch (newest-first; first wins on dupes)
 * @returns {{fetch: Array<{runId:(string|number), destDir:string}>, missingRequired: string[]}}
 */
export function planBranches({
	refName,
	required = [],
	optional = [],
	ci = [],
}) {
	const currentDir = sanitize(refName);
	const ciMap = new Map();
	for (const { branch, runId } of ci) {
		if (!ciMap.has(branch)) ciMap.set(branch, runId); // newest-first: first wins
	}

	const requiredSet = new Set(required);
	const all = [...new Set([...required, ...optional])];
	const fetch = [];
	const missingRequired = [];
	const seenDirs = new Set([currentDir]); // current build already staged

	for (const branch of all) {
		const destDir = sanitize(branch);
		if (seenDirs.has(destDir)) continue;
		if (ciMap.has(branch)) {
			fetch.push({ runId: ciMap.get(branch), destDir });
			seenDirs.add(destDir);
		} else if (requiredSet.has(branch)) {
			missingRequired.push(branch);
		}
		// optional & absent → skip silently
	}
	return { fetch, missingRequired };
}

/**
 * Plan the docs.zip backfill for the one-time gh-pages → durable-source
 * migration. Pure. A tag needs backfilling iff it has a gh-pages version
 * directory, is a real release tag, and lacks a docs.zip asset. Branch dirs
 * (`main/`, …) are ignored — they self-heal on the next branch CI.
 *
 * @param {object}   args
 * @param {string[]} [args.pagesDirs]  top-level dirs on the gh-pages branch
 * @param {string[]} [args.tags]       release tag names
 * @param {string[]} [args.withDocsZip] tags that already have a docs.zip asset
 * @returns {{backfill: string[]}} tags to backfill, in `pagesDirs` order
 */
export function planMigration({ pagesDirs = [], tags = [], withDocsZip = [] }) {
	const tagSet = new Set(tags);
	const have = new Set(withDocsZip);
	const backfill = pagesDirs.filter((d) => tagSet.has(d) && !have.has(d));
	return { backfill };
}

/** Build the pydata switcher array for `org/repo`, flagging the stable entry. */
export function switcherStruct(repository, versions, preferred) {
	const [org, repoName] = repository.split("/");
	return versions.map((version) => {
		const entry = {
			version,
			url: `https://${org}.github.io/${repoName}/${version}/`,
		};
		if (version === preferred) entry.preferred = true;
		return entry;
	});
}

/** Serialise the switcher exactly as the Python tool did (2-space JSON). */
export function renderSwitcher(repository, versions, preferred) {
	return JSON.stringify(
		switcherStruct(repository, versions, preferred),
		null,
		2,
	);
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

/** `sanitize <ref-name>` — print the sanitised version. */
function cmdSanitize(rest) {
	const [name] = rest;
	if (name === undefined) {
		throw new Error("usage: assemble.mjs sanitize <ref-name>");
	}
	console.log(sanitize(name));
}

/** Split a comma-separated CLI list into trimmed, non-empty entries. */
function csv(value) {
	return (value ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

/** `plan-branches --ref-name --required --optional --ci` — print the fetch list. */
function cmdPlanBranches(rest) {
	const { values } = parseArgs({
		args: rest,
		options: {
			"ref-name": { type: "string" },
			required: { type: "string" },
			optional: { type: "string" },
			ci: { type: "string" },
		},
	});
	if (!values["ref-name"]) {
		throw new Error("plan-branches: --ref-name is required");
	}
	const ci = values.ci ? JSON.parse(values.ci) : [];
	const { fetch, missingRequired } = planBranches({
		refName: values["ref-name"],
		required: csv(values.required),
		optional: csv(values.optional),
		ci,
	});
	if (missingRequired.length > 0) {
		console.error(
			`Required branch(es) have no current build or recent CI artifact: ${missingRequired.join(", ")}`,
		);
		process.exitCode = 1;
		return;
	}
	// TSV (`<runId>\t<destDir>`) so the action reads it with `while read` rather
	// than parsing JSON in bash.
	for (const { runId, destDir } of fetch) {
		console.log(`${runId}\t${destDir}`);
	}
}

/** `generate --site-dir --repo` — write switcher.json + index.html; emit stable src. */
function cmdGenerate(rest) {
	const { values } = parseArgs({
		args: rest,
		options: {
			"site-dir": { type: "string" },
			repo: { type: "string" },
		},
	});
	const siteDir = values["site-dir"];
	const repo = values.repo;
	if (!siteDir || !repo) {
		throw new Error(
			"usage: assemble.mjs generate --site-dir <dir> --repo <org/repo>",
		);
	}

	const builds = discoverVersions(siteDir);
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
		renderSwitcher(repo, versions, preferred),
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

/** Top-level directory names on a git ref (e.g. `origin/gh-pages`). */
function getBranchDirs(ref) {
	try {
		return gitLines(["ls-tree", "-d", "--name-only", ref]);
	} catch {
		return [];
	}
}

/** Does `tag`'s GitHub Release carry a `docs.zip` asset? (false on any gh error.) */
function releaseHasDocsZip(tag, repo) {
	const args = [
		"release",
		"view",
		tag,
		"--json",
		"assets",
		"-q",
		'any(.assets[]; .name=="docs.zip")',
	];
	if (repo) args.push("--repo", repo);
	try {
		const out = execFileSync("gh", args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return out.trim() === "true";
	} catch {
		return false;
	}
}

/**
 * Zip the gh-pages `<tag>/` subtree as a bare `html/` archive and attach it as the
 * release's `docs.zip` (clobbering any prior one). All IO; the operator runs this
 * locally with their own `gh auth` (see DESIGN "Migration").
 */
function backfillTag(tag, pagesRef, repo) {
	const tmp = mkdtempSync(join(tmpdir(), `migrate-${sanitize(tag)}-`));
	const tarPath = join(tmp, "src.tar");
	// git archive emits entries under `<tag>/…`; capture the tar (binary) to a file
	// then extract, rather than piping through a shell.
	writeFileSync(
		tarPath,
		execFileSync("git", ["archive", "--format=tar", pagesRef, tag], {
			maxBuffer: 1024 * 1024 * 1024,
		}),
	);
	const extract = join(tmp, "extract");
	mkdirSync(extract);
	execFileSync("tar", ["-xf", tarPath, "-C", extract]);
	renameSync(join(extract, tag), join(tmp, "html"));
	execFileSync("zip", ["-rq", "docs.zip", "html"], { cwd: tmp });
	const args = ["release", "upload", tag, join(tmp, "docs.zip"), "--clobber"];
	if (repo) args.push("--repo", repo);
	execFileSync("gh", args, { stdio: "inherit" });
}

/** `migrate [--pages-ref --repo --dry-run]` — backfill docs.zip from gh-pages. */
function cmdMigrate(rest) {
	const { values } = parseArgs({
		args: rest,
		options: {
			"pages-ref": { type: "string" },
			repo: { type: "string" },
			"dry-run": { type: "boolean" },
		},
	});
	const pagesRef = values["pages-ref"] || "origin/gh-pages";
	const repo = values.repo;
	const dryRun = Boolean(values["dry-run"]);

	const pagesDirs = getBranchDirs(pagesRef);
	const tags = getSortedTags();
	const withDocsZip = tags.filter((t) => releaseHasDocsZip(t, repo));
	const { backfill } = planMigration({ pagesDirs, tags, withDocsZip });

	console.error(`gh-pages (${pagesRef}) dirs: ${JSON.stringify(pagesDirs)}`);
	console.error(`already have docs.zip: ${JSON.stringify(withDocsZip)}`);
	console.error(
		`${dryRun ? "would backfill" : "backfilling"}: ${JSON.stringify(backfill)}`,
	);

	for (const tag of backfill) {
		if (!dryRun) backfillTag(tag, pagesRef, repo);
		console.log(tag); // stdout: the backfilled (or planned) tags, one per line
	}
}

export function main(argv = process.argv.slice(2)) {
	const [cmd, ...rest] = argv;
	switch (cmd) {
		case "sanitize":
			return cmdSanitize(rest);
		case "plan-branches":
			return cmdPlanBranches(rest);
		case "generate":
			return cmdGenerate(rest);
		case "migrate":
			return cmdMigrate(rest);
		default:
			throw new Error(
				"usage: assemble.mjs <sanitize|plan-branches|generate|migrate> ...",
			);
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main();
}

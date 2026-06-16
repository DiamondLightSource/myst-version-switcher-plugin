/**
 * make-switcher — generate the pydata `switcher.json` AND the root `index.html`
 * redirect for a versioned docs site.
 *
 * A dependency-free Node port of the DLS `make_switcher.py`. The version list is
 * derived from git: directories on the gh-pages branch (the deployed builds) plus
 * the tag list (used to order them). Ordering is `master`, `main`, then tags
 * newest-first, then any remaining dirs alphabetically.
 *
 * The newest non-prerelease tag is the "preferred" (stable) version: it is
 * flagged `preferred: true` in switcher.json and is where the site root
 * redirects. When no stable tag is deployed yet, both fall back to `main`.
 *
 * The pure functions take plain arrays so they can be unit-tested without a git
 * repo; only `main()` shells out to git and writes the files.
 *
 *   node make-switcher.mjs --add <version> <org/repo> <output-dir>
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

/** Run a git command and return its non-empty stdout lines. */
function gitLines(args) {
	const out = execFileSync("git", args, { encoding: "utf8" });
	return out.trim().split("\n").filter(Boolean);
}

/** Directory names on a branch (i.e. the deployed builds). */
export function getBranchContents(ref) {
	try {
		return gitLines(["ls-tree", "-d", "--name-only", ref]);
	} catch {
		// Branch may not exist yet (first deploy).
		console.warn(`Cannot get ${ref} contents`);
		return [];
	}
}

/** Tags newest-first (semver-aware), matching `git tag -l --sort=-v:refname`. */
export function getSortedTags() {
	return gitLines(["tag", "-l", "--sort=-v:refname"]);
}

/**
 * Order the deployed builds: `master`, `main`, then tags newest-first, then any
 * leftover directories alphabetically. `add` folds in the build being published.
 * `tags` must already be newest-first.
 */
export function orderVersions(builds, tags, add) {
	const remaining = new Set(builds);
	if (add) remaining.add(add);

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

/** Root redirect to `version` (relative, so it is host- and repo-agnostic). */
export function renderRedirect(version) {
	return `<!DOCTYPE html>
<html>

<head>
    <title>Redirecting to ${version}</title>
    <meta charset="utf-8">
    <meta http-equiv="refresh" content="0; url=./${version}/index.html">
    <link rel="canonical" href="${version}/index.html">
</head>

</html>
`;
}

export function main(argv = process.argv.slice(2)) {
	const { values, positionals } = parseArgs({
		args: argv,
		options: { add: { type: "string" } },
		allowPositionals: true,
	});
	const [repository, outputDir] = positionals;
	if (!repository || !outputDir) {
		throw new Error(
			"usage: make-switcher.mjs --add <version> <org/repo> <output-dir>",
		);
	}

	const builds = getBranchContents("origin/gh-pages");
	const tags = getSortedTags();
	const versions = orderVersions(builds, tags, values.add);
	const preferred = preferredVersion(versions, tags);
	console.log(`Sorted versions: ${JSON.stringify(versions)}`);
	console.log(`Preferred version: ${preferred}`);

	const switcher = renderSwitcher(repository, versions, preferred);
	console.log(`JSON switcher:\n${switcher}`);
	writeFileSync(join(outputDir, "switcher.json"), switcher, "utf8");

	if (preferred) {
		writeFileSync(
			join(outputDir, "index.html"),
			renderRedirect(preferred),
			"utf8",
		);
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main();
}

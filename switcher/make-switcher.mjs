/**
 * make-switcher — generate the pydata `switcher.json` for a versioned docs site.
 *
 * A dependency-free Node port of the DLS `make_switcher.py`. The version list is
 * derived from git: directories on the gh-pages branch (the deployed builds) plus
 * the tag list (used only to order them). Ordering is `master`, `main`, then tags
 * newest-first, then any remaining dirs alphabetically.
 *
 * The pure functions (`orderVersions`, `switcherStruct`, `renderSwitcher`) take
 * plain arrays so they can be unit-tested without a git repo; only `main()` shells
 * out to git and writes the file.
 *
 *   node make-switcher.mjs --add <version> <org/repo> <output.json>
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
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

/** Build the pydata switcher array for `org/repo`. */
export function switcherStruct(repository, versions) {
	const [org, repoName] = repository.split("/");
	return versions.map((version) => ({
		version,
		url: `https://${org}.github.io/${repoName}/${version}/`,
	}));
}

/** Serialise the switcher exactly as the Python tool did (2-space JSON). */
export function renderSwitcher(repository, versions) {
	return JSON.stringify(switcherStruct(repository, versions), null, 2);
}

export function main(argv = process.argv.slice(2)) {
	const { values, positionals } = parseArgs({
		args: argv,
		options: { add: { type: "string" } },
		allowPositionals: true,
	});
	const [repository, output] = positionals;
	if (!repository || !output) {
		throw new Error(
			"usage: make-switcher.mjs --add <version> <org/repo> <output.json>",
		);
	}

	const builds = getBranchContents("origin/gh-pages");
	const tags = getSortedTags();
	const versions = orderVersions(builds, tags, values.add);
	console.log(`Sorted versions: ${JSON.stringify(versions)}`);

	const text = renderSwitcher(repository, versions);
	console.log(`JSON switcher:\n${text}`);
	writeFileSync(output, text, "utf8");
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main();
}

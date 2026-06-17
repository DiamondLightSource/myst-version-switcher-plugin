/**
 * Tests for assemble.mjs — the kernel behind the `assemble` action.
 *
 * Covers the pure functions carried over from make-switcher (ordering,
 * prerelease/preferred, switcher shape + serialisation) plus the new pieces:
 * directory discovery, mixed branch+tag ordering, sanitisation, branch planning
 * (incl. required-missing → fail), and the redirect/stable-alias decision.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	discoverVersions,
	isPrerelease,
	orderVersions,
	planBranches,
	preferredVersion,
	renderRedirect,
	renderSwitcher,
	sanitize,
	stablePlan,
	switcherStruct,
} from "../assemble/assemble.mjs";

let passed = 0;
function ok(name) {
	passed += 1;
	console.log("  ok -", name);
}

// tags come newest-first (as `git tag --sort=-v:refname` produces).
const tags = ["2.1", "2.0", "1.0"];

// --- orderVersions: main first, tags newest-first, leftovers alphabetical ---
// (the current build is already a discovered dir, so it is just another build.)
assert.deepEqual(orderVersions(["main", "2.1", "2.0"], tags), [
	"main",
	"2.1",
	"2.0",
]);
ok("orders main first, then tags newest-first");

// first deploy: only the current build's dir is present.
assert.deepEqual(orderVersions(["main"], []), ["main"]);
ok("handles a single-version site (first deploy)");

// master wins over main when both somehow present; leftovers sort alphabetically.
assert.deepEqual(orderVersions(["main", "master", "zzz", "aaa"], []), [
	"master",
	"main",
	"aaa",
	"zzz",
]);
ok("master before main; unknown dirs appended alphabetically");

// mixed branch + tag ordering: branches and feature previews around tags.
assert.deepEqual(
	orderVersions(["feature-x", "2.1", "main", "2.0", "dev"], tags),
	["main", "2.1", "2.0", "dev", "feature-x"],
);
ok(
	"mixed branch + tag ordering: main, tags newest-first, branches alphabetical",
);

// --- discoverVersions: directory names under the site root ---
const site = mkdtempSync(join(tmpdir(), "assemble-site-"));
for (const d of ["main", "2.1", "2.0"]) mkdirSync(join(site, d));
writeFileSync(join(site, "switcher.json"), "[]"); // file, ignored
writeFileSync(join(site, "index.html"), "x"); // file, ignored
symlinkSync("2.1", join(site, "stable")); // the alias, excluded
assert.deepEqual(discoverVersions(site).sort(), ["2.0", "2.1", "main"]);
ok("discoverVersions returns dirs only, excluding files and the stable alias");

assert.deepEqual(discoverVersions(join(site, "does-not-exist")), []);
ok("discoverVersions returns [] for a missing dir");

// --- sanitize: mirrors ${REF//[^A-Za-z0-9._-]/_} ---
assert.equal(sanitize("v2.1.0"), "v2.1.0");
assert.equal(sanitize("main"), "main");
assert.equal(sanitize("feature/foo bar"), "feature_foo_bar");
assert.equal(sanitize("a@b#c"), "a_b_c");
assert.equal(sanitize("keep_-.dots"), "keep_-.dots");
ok("sanitize replaces every char outside [A-Za-z0-9._-] with _");

// --- isPrerelease: rc/a/b markers (parity with _release.yml) ---
assert.equal(isPrerelease("2.1"), false);
assert.equal(isPrerelease("2.1.0"), false);
assert.ok(isPrerelease("2.1rc1"));
assert.ok(isPrerelease("3.0a2"));
assert.ok(isPrerelease("3.0b1"));
ok("isPrerelease flags rc/a/b tags only");

// --- preferredVersion: newest deployed stable tag, else main ---
assert.equal(preferredVersion(["main", "2.1", "2.0"], tags), "2.1");
ok("preferredVersion picks the newest deployed stable tag");

assert.equal(
	preferredVersion(["main", "3.0rc1", "2.1"], ["3.0rc1", "2.1"]),
	"2.1",
);
ok("preferredVersion skips prereleases");

assert.equal(preferredVersion(["main"], []), "main");
ok("preferredVersion falls back to main when no stable tag is deployed");

assert.equal(preferredVersion(["main", "2.0"], ["2.1", "2.0"]), "2.0");
ok("preferredVersion ignores tags with no deployed build");

// --- stablePlan: redirect target + stable-alias source ---
// a deployed non-prerelease release → stable/ alias + root → stable/.
assert.deepEqual(stablePlan(["main", "2.1", "2.0"], tags), {
	preferred: "2.1",
	stableSrc: "2.1",
	redirectTarget: "stable",
});
ok("stablePlan aliases the newest release and redirects root to stable/");

// no release yet → no alias, root → main fallback.
assert.deepEqual(stablePlan(["main"], []), {
	preferred: "main",
	stableSrc: null,
	redirectTarget: "main",
});
ok("stablePlan falls back to main with no stable alias before first release");

// only a prerelease deployed → never aliased as stable; root → that prerelease.
assert.deepEqual(stablePlan(["3.0rc1"], ["3.0rc1"]), {
	preferred: "3.0rc1",
	stableSrc: null,
	redirectTarget: "3.0rc1",
});
ok("stablePlan never aliases a prerelease as stable");

// --- planBranches: resolve required ∪ optional to a fetch list ---
const ci = [
	{ branch: "main", runId: 111 },
	{ branch: "dev", runId: 222 },
	{ branch: "dev", runId: 999 }, // older dup, ignored (newest-first)
	{ branch: "feature/x", runId: 333 },
];

// current ref is never fetched; optional present → fetched; optional absent → skipped.
let plan = planBranches({
	refName: "main",
	required: ["main"],
	optional: ["dev", "ghost"],
	ci,
});
assert.deepEqual(plan, {
	fetch: [{ runId: 222, destDir: "dev" }],
	missingRequired: [],
});
ok(
	"planBranches fetches optional branches with CI, skips absent, omits current ref",
);

// dest dirs are sanitised.
plan = planBranches({ refName: "main", optional: ["feature/x"], ci });
assert.deepEqual(plan.fetch, [{ runId: 333, destDir: "feature_x" }]);
ok("planBranches sanitises dest dirs");

// a required branch with neither a current build nor CI → missingRequired.
plan = planBranches({ refName: "main", required: ["main", "release-2"], ci });
assert.deepEqual(plan.fetch, []);
assert.deepEqual(plan.missingRequired, ["release-2"]);
ok("planBranches reports an unsatisfiable required branch");

// a required branch that IS the current ref is satisfied (not fetched, not missing).
plan = planBranches({ refName: "release-2", required: ["release-2"], ci });
assert.deepEqual(plan, { fetch: [], missingRequired: [] });
ok("planBranches treats the current ref as satisfying a required branch");

// --- switcherStruct shape, with the stable entry flagged ---
assert.deepEqual(
	switcherStruct(
		"DiamondLightSource/myst-version-switcher-plugin",
		["main", "2.1"],
		"2.1",
	),
	[
		{
			version: "main",
			url: "https://DiamondLightSource.github.io/myst-version-switcher-plugin/main/",
		},
		{
			version: "2.1",
			url: "https://DiamondLightSource.github.io/myst-version-switcher-plugin/2.1/",
			preferred: true,
		},
	],
);
ok("switcherStruct builds the pydata array and flags the preferred entry");

// --- exact serialisation (2-space, no trailing newline), parity with json.dumps(indent=2) ---
const text = renderSwitcher("acme/widget", ["main", "2.0"], "2.0");
assert.equal(
	text,
	`[
  {
    "version": "main",
    "url": "https://acme.github.io/widget/main/"
  },
  {
    "version": "2.0",
    "url": "https://acme.github.io/widget/2.0/",
    "preferred": true
  }
]`,
);
ok("renderSwitcher matches make_switcher.py 2-space JSON output");

// --- redirect targets stable/ (constant) for a release, or the fallback dir ---
const toStable = renderRedirect("stable");
assert.match(toStable, /url=\.\/stable\/index\.html/);
assert.match(toStable, /<link rel="canonical" href="stable\/index\.html">/);
ok("renderRedirect emits a relative refresh to stable/");

const toMain = renderRedirect("main");
assert.match(toMain, /url=\.\/main\/index\.html/);
ok("renderRedirect targets the fallback dir before the first release");

console.log(`\nAll ${passed} checks passed.`);

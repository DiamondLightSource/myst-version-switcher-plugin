/**
 * Parity tests for make-switcher.mjs against the behaviour of make_switcher.py:
 * ordering (master/main first, tags newest-first, leftovers alphabetical),
 * `--add`, and the exact JSON shape/serialisation.
 */
import assert from "node:assert/strict";
import {
	isPrerelease,
	orderVersions,
	preferredVersion,
	renderRedirect,
	renderSwitcher,
	switcherStruct,
} from "../switcher/make-switcher.mjs";

let passed = 0;
function ok(name) {
	passed += 1;
	console.log("  ok -", name);
}

// tags come newest-first (as `git tag --sort=-v:refname` produces).
const tags = ["2.1", "2.0", "1.0"];

// main + a subset of tags deployed; --add folds in the build being published.
assert.deepEqual(orderVersions(["main", "2.0"], tags, "2.1"), [
	"main",
	"2.1",
	"2.0",
]);
ok("orders main first, then tags newest-first");

// first deploy: no branch dirs, only the build being added.
assert.deepEqual(orderVersions([], [], "main"), ["main"]);
ok("handles an empty gh-pages branch (first deploy)");

// master wins over main when both somehow present; leftovers sort alphabetically.
assert.deepEqual(orderVersions(["main", "master", "zzz", "aaa"], [], null), [
	"master",
	"main",
	"aaa",
	"zzz",
]);
ok("master before main; unknown dirs appended alphabetically");

// a deployed tag not in --add still orders by the tag list.
assert.deepEqual(orderVersions(["main", "2.1", "2.0"], tags, null), [
	"main",
	"2.1",
	"2.0",
]);
ok("existing deployed tags ordered newest-first");

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

// a newer prerelease is skipped in favour of the newest stable
assert.equal(
	preferredVersion(["main", "3.0rc1", "2.1"], ["3.0rc1", "2.1"]),
	"2.1",
);
ok("preferredVersion skips prereleases");

// no tags deployed yet -> fall back to main
assert.equal(preferredVersion(["main"], []), "main");
ok("preferredVersion falls back to main when no stable tag is deployed");

// a tag that exists but was never deployed is not preferred
assert.equal(preferredVersion(["main", "2.0"], ["2.1", "2.0"]), "2.0");
ok("preferredVersion ignores tags with no deployed build");

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

// --- redirect points (relatively) at the preferred version ---
const redirect = renderRedirect("2.1");
assert.match(redirect, /url=\.\/2\.1\/index\.html/);
assert.match(redirect, /<link rel="canonical" href="2\.1\/index\.html">/);
ok("renderRedirect emits a relative refresh to the preferred version");

console.log(`\nAll ${passed} checks passed.`);

/**
 * Tests for lib/assemble.mjs — the shared kernel behind the actions.
 *
 * Covers the pure functions carried over from make-switcher (ordering,
 * prerelease/preferred, switcher shape + serialisation) plus the new pieces:
 * directory discovery, mixed branch+tag ordering, sanitisation, the
 * required-branch check (incl. required-missing → fail), migration planning, and
 * the redirect/stable-alias decision.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	discoverVersions,
	isPrerelease,
	missingRequired,
	orderVersions,
	planMigration,
	preferredVersion,
	renderRedirect,
	renderSwitcher,
	sanitize,
	stablePlan,
	switcherStruct,
} from "../lib/assemble.mjs";

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

// --- missingRequired: required branches absent from the site dirs (sanitised) ---
// versions are the discovered site dirs (already sanitised); the current ref and
// every gathered branch are among them by generate time.
assert.deepEqual(missingRequired(["main"], ["main", "dev", "2.1"]), []);
ok("missingRequired passes when the required branch dir is present");

// a required branch with no dir is reported.
assert.deepEqual(missingRequired(["main", "release-2"], ["main", "dev"]), [
	"release-2",
]);
ok("missingRequired reports a required branch absent from the site");

// required names are sanitised before comparison (feature/x → feature_x dir).
assert.deepEqual(missingRequired(["feature/x"], ["main", "feature_x"]), []);
assert.deepEqual(missingRequired(["feature/y"], ["main", "feature_x"]), [
	"feature/y",
]);
ok("missingRequired sanitises required names to match dir names");

// no required branches → nothing missing.
assert.deepEqual(missingRequired([], ["main"]), []);
ok("missingRequired is a no-op with no required branches");

// --- planMigration: which tags need a docs.zip backfilled from gh-pages ---
// returns RAW tags (in tags order) whose sanitised dir is on gh-pages and which
// lack docs.zip; branch dirs (main) and tags without a dir are skipped.
assert.deepEqual(
	planMigration({
		pagesDirs: ["main", "v0.1.0", "v0.2.0"],
		tags: ["v0.2.0", "v0.1.0"],
		withDocsZip: [],
	}),
	{ backfill: ["v0.2.0", "v0.1.0"] },
);
ok("planMigration backfills release dirs lacking docs.zip, skips branches");

// tags that already have docs.zip are not re-backfilled.
assert.deepEqual(
	planMigration({
		pagesDirs: ["main", "v0.1.0", "v0.2.0"],
		tags: ["v0.2.0", "v0.1.0"],
		withDocsZip: ["v0.1.0"],
	}),
	{ backfill: ["v0.2.0"] },
);
ok("planMigration skips tags that already have docs.zip");

// a release tag with no gh-pages dir is nothing to backfill from.
assert.deepEqual(
	planMigration({ pagesDirs: ["main"], tags: ["v1.0"], withDocsZip: [] }),
	{ backfill: [] },
);
ok("planMigration ignores tags with no gh-pages directory");

// a tag with `/` matches its sanitised gh-pages dir; the RAW tag is returned.
assert.deepEqual(
	planMigration({
		pagesDirs: ["main", "release_1.0"],
		tags: ["release/1.0"],
		withDocsZip: [],
	}),
	{ backfill: ["release/1.0"] },
);
ok(
	"planMigration matches a slash tag by its sanitised dir, returns the raw tag",
);

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

/**
 * Tests for assemble/assemble.mjs — the kernel behind the assemble scripts.
 *
 * Covers the pure functions carried over from make-switcher (ordering,
 * prerelease/preferred, switcher shape + serialisation) plus the new pieces:
 * directory discovery, mixed branch+tag ordering, the required-branch check
 * (incl. required-missing → fail), and the redirect/stable-alias decision.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	cacheKey,
	discoverVersions,
	isPrerelease,
	missingRequired,
	orderTags,
	orderVersions,
	preferredVersion,
	RELZIPS_CACHE_PREFIX,
	renderRedirect,
	renderSwitcher,
	selectArtifacts,
	selectReleases,
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

// pr-<n> preview dirs sort numerically (pr-2 before pr-10), not lexically.
assert.deepEqual(orderVersions(["pr-10", "pr-2", "main"], []), [
	"main",
	"pr-2",
	"pr-10",
]);
ok("orderVersions sorts pr-<n> previews numerically, not lexically");

// a `develop` default branch heads the list instead of landing in the leftover
// bucket among the pr-<n> previews.
assert.deepEqual(orderVersions(["pr-3", "2.1", "develop"], tags, "develop"), [
	"develop",
	"2.1",
	"pr-3",
]);
ok("orderVersions puts a named default branch first");

// main/master still come after it when a repo mid-rename carries both.
assert.deepEqual(orderVersions(["main", "develop"], [], "develop"), [
	"develop",
	"main",
]);
ok("orderVersions keeps main after the named default branch");

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

// --- isPrerelease: digit-anchored rc/a/b markers (parity with release.yml) ---
assert.equal(isPrerelease("2.1"), false);
assert.equal(isPrerelease("2.1.0"), false);
assert.ok(isPrerelease("2.1rc1"));
assert.ok(isPrerelease("3.0a2"));
assert.ok(isPrerelease("3.0b1"));
ok("isPrerelease flags rc/a/b tags only");

// tags that merely contain a/b/rc letters (no digit before) are NOT prereleases.
assert.equal(isPrerelease("release-1.0"), false);
assert.equal(isPrerelease("beta-program"), false);
assert.equal(isPrerelease("stable-2.0"), false);
ok("isPrerelease ignores a/b/rc letters not following a digit");

// the hyphenated/dotted semver spellings, and the long marker words. These used to
// read as STABLE, which made `stable/` alias a beta.
assert.ok(isPrerelease("1.1.0-beta.1"));
assert.ok(isPrerelease("1.0.0-rc1"));
assert.ok(isPrerelease("v1.2.3-alpha"));
assert.ok(isPrerelease("2.0.0-pre.1"));
assert.ok(isPrerelease("1.0.dev0"));
assert.ok(isPrerelease("1.3.2-a9"));
ok("isPrerelease flags hyphenated semver + long-form markers");

// a longer word that merely STARTS with a marker is not one (the trailing lookahead).
assert.equal(isPrerelease("1.0-candidate"), false);
assert.equal(isPrerelease("2.0-canary"), false);
assert.equal(isPrerelease("1.0-preflight"), false);
ok("isPrerelease ignores longer words starting with a marker");

// --- compareTags/orderTags: newest first, prereleases below their own release ---
// THE invariant: for any tag X, every prerelease of X sorts after X. git's
// -v:refname does the opposite for the hyphenated forms.
assert.deepEqual(
	orderTags([
		"1.0.0",
		"1.1.0-beta.1",
		"1.1.0",
		"1.0.0-rc1",
		"2.0.0a1",
		"2.0.0",
	]),
	["2.0.0", "2.0.0a1", "1.1.0", "1.1.0-beta.1", "1.0.0", "1.0.0-rc1"],
);
ok("orderTags ranks each prerelease below the release it qualifies");

// digit runs compare numerically, so 1.10 is newer than 1.9 (not lexically before).
assert.deepEqual(orderTags(["1.9.0", "1.10.0", "1.9.1"]), [
	"1.10.0",
	"1.9.1",
	"1.9.0",
]);
ok("orderTags compares numeric segments numerically");

// a trailing segment that is NOT a prerelease marker means a newer version.
assert.deepEqual(orderTags(["1.1", "1.1.1"]), ["1.1.1", "1.1"]);
ok("orderTags treats a non-marker trailing segment as newer");

// a `v` prefix is a spelling of the same version, so it does not reorder anything.
assert.deepEqual(orderTags(["v1.0.0", "v1.2.0", "v1.1.0"]), [
	"v1.2.0",
	"v1.1.0",
	"v1.0.0",
]);
ok("orderTags ignores a leading v when comparing");

// total order: reordering the input cannot change the result (an unstable ranking
// would change the published set, and so the cache key, on identical inputs).
const shuffled = ["1.1.0-beta.1", "2.0.0", "1.0.0", "2.0.0a1", "1.1.0"];
assert.deepEqual(orderTags(shuffled), orderTags([...shuffled].reverse()));
ok("orderTags is a total order (input order cannot change it)");

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

// the bug this pair guards: with the beta ranked above 1.1.0 by git's sort AND read
// as stable, preferredVersion returned the beta.
const semverTags = orderTags(["1.1.0", "1.1.0-beta.1"]);
assert.equal(
	preferredVersion(["main", "1.1.0", "1.1.0-beta.1"], semverTags),
	"1.1.0",
);
ok("preferredVersion prefers a release over its own hyphenated prerelease");

// a consumer whose default branch is neither main nor master.
assert.equal(preferredVersion(["develop", "pr-3"], [], "develop"), "develop");
ok("preferredVersion falls back to the named default branch");

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

// ...including the hyphenated spelling, which used to slip through as a real release.
assert.deepEqual(stablePlan(["main", "1.1.0-beta.1"], ["1.1.0-beta.1"]), {
	preferred: "main",
	stableSrc: null,
	redirectTarget: "main",
});
ok("stablePlan never aliases a hyphenated prerelease as stable");

// --- missingRequired: required branches absent from the discovered site dirs ---
// versions are the discovered site dirs; the default branch and every gathered
// PR/preview are among them by generate time. Names compare verbatim (no rule).
assert.deepEqual(missingRequired(["main"], ["main", "dev", "2.1"]), []);
ok("missingRequired passes when the required branch dir is present");

// a required branch with no dir is reported.
assert.deepEqual(missingRequired(["main", "release-2"], ["main", "dev"]), [
	"release-2",
]);
ok("missingRequired reports a required branch absent from the site");

// no required branches → nothing missing.
assert.deepEqual(missingRequired([], ["main"]), []);
ok("missingRequired is a no-op with no required branches");

// --- switcherStruct shape, with the stable entry flagged ---
assert.deepEqual(
	switcherStruct(
		"https://diamondlightsource.github.io/myst-version-switcher-plugin/",
		["main", "2.1"],
		"2.1",
	),
	[
		{
			version: "main",
			url: "https://diamondlightsource.github.io/myst-version-switcher-plugin/main/",
		},
		{
			version: "2.1",
			url: "https://diamondlightsource.github.io/myst-version-switcher-plugin/2.1/",
			preferred: true,
		},
	],
);
ok("switcherStruct builds the pydata array and flags the preferred entry");

// a custom-domain base URL (no trailing slash) roots the entries verbatim.
assert.deepEqual(switcherStruct("https://docs.example.com", ["main"], null), [
	{ version: "main", url: "https://docs.example.com/main/" },
]);
ok("switcherStruct roots entries at a custom-domain base URL");

// --- exact serialisation (2-space, no trailing newline), parity with json.dumps(indent=2) ---
const text = renderSwitcher(
	"https://acme.github.io/widget",
	["main", "2.0"],
	"2.0",
);
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

// defence in depth: docs.yml validates the version name, but the two rules live in
// different files and this one renders HTML.
const nasty = renderRedirect('x"><script>&');
assert.ok(!nasty.includes("<script>"));
assert.ok(nasty.includes("&quot;&gt;&lt;script&gt;&amp;"));
ok("renderRedirect escapes HTML metacharacters in the target");

// --- selectReleases: which releases become site dirs, and why -----------------
// Shaped like the raw `GET /repos/{repo}/releases` payload publish.yml pipes in.
const rel = (tag, created, { docsZip = true, size = 100 } = {}) => ({
	tag_name: tag,
	created_at: created,
	// Deliberately NOT the ranking key: re-publishing an old release stamps a fresh
	// published_at, which is why selectReleases ranks on created_at instead.
	published_at: "2026-07-30T16:07:14Z",
	assets: docsZip ? [{ name: "docs.zip", id: `id-${tag}`, size }] : [],
});

// Deliberately NOT in date order, to prove the cap ranks by date rather than by
// the order the API happened to return. Every one shares a published_at, so any
// test that passes here is ranking on created_at.
const releases = [
	rel("1.0", "2026-01-01T00:00:00Z"),
	rel("3.0", "2026-03-01T00:00:00Z"),
	rel("2.0", "2026-02-01T00:00:00Z"),
];
const gatheredOf = (rows) =>
	rows.filter((r) => r.dest !== null).map((r) => r.dest);

assert.deepEqual(
	gatheredOf(selectReleases(releases, { defaultBranch: "main" })),
	["1.0", "3.0", "2.0"],
);
ok("selectReleases gathers every release when max-releases is unlimited");

// A row per listed release either way — the decision table must account for all.
assert.equal(selectReleases(releases, { defaultBranch: "main" }).length, 3);
ok("selectReleases returns one row per listed release");

const capped = selectReleases(releases, {
	defaultBranch: "main",
	maxReleases: 2,
});
assert.deepEqual(gatheredOf(capped).sort(), ["2.0", "3.0"]);
assert.match(
	capped.find((r) => r.tag === "1.0").decision,
	/beyond max-releases=2 \(dated 2026-01-01/,
);
ok(
	"selectReleases keeps the newest max-releases by created_at, not published_at",
);

assert.deepEqual(
	gatheredOf(
		selectReleases(releases, { defaultBranch: "main", maxReleases: 0 }),
	),
	["1.0", "3.0", "2.0"],
);
ok("selectReleases treats max-releases 0 as unlimited");

assert.deepEqual(
	gatheredOf(
		selectReleases(releases, { defaultBranch: "main", maxReleases: 9 }),
	),
	["1.0", "3.0", "2.0"],
);
ok("selectReleases is a no-op when there are fewer releases than the cap");

// The seed release stands in for the default branch, so it is not a version and
// must never lose its slot to the cap — even when it is the oldest release there is.
const withSeed = selectReleases(
	[rel("pages-default-seed", "2020-01-01T00:00:00Z"), ...releases],
	{ defaultBranch: "main", maxReleases: 1 },
);
assert.deepEqual(gatheredOf(withSeed).sort(), ["3.0", "main"]);
ok("selectReleases exempts the seed release from the cap");

// Skipped releases must not consume a cap slot either.
const withJunk = selectReleases(
	[
		rel("release/1.0", "2026-04-01T00:00:00Z"),
		rel("4.0", "2026-04-02T00:00:00Z"),
		...releases,
	],
	{ defaultBranch: "main", maxReleases: 2 },
);
assert.deepEqual(gatheredOf(withJunk).sort(), ["3.0", "4.0"]);
ok("selectReleases does not spend a cap slot on a skipped release");

const skips = selectReleases(
	[
		rel("release/1.0", "2026-01-01T00:00:00Z"),
		rel("main", "2026-01-02T00:00:00Z"),
		rel("5.0", "2026-01-03T00:00:00Z", { docsZip: false }),
	],
	{ defaultBranch: "main" },
);
assert.deepEqual(gatheredOf(skips), []);
assert.match(skips[0].decision, /'\/' in tag/);
assert.match(skips[1].decision, /same name as the default branch/);
assert.match(skips[2].decision, /no docs.zip asset/);
ok(
	"selectReleases skips '/'-tags, default-branch-named tags and asset-less releases",
);

// The asset id rides along so publish.yml can key its download cache on it.
assert.equal(
	selectReleases(releases, { defaultBranch: "main" })[0].assetId,
	"id-1.0",
);
ok("selectReleases carries the docs.zip asset id through for cache keying");

// --- selectArtifacts: which CI artifact lands where ---
const art = (id, sha, created, extra = {}) => ({
	id,
	created_at: created,
	size_in_bytes: 4096,
	expired: false,
	workflow_run: {
		id: 900,
		head_sha: sha,
		head_branch: extra.branch ?? null,
		head_repository_id: extra.repoId ?? 42,
	},
});
const pr = (num, sha, approved = true) => ({ num: String(num), sha, approved });
const destOf = (rows, label) =>
	rows.find((r) => r.label === label)?.dest ?? null;
const rowOf = (rows, label) => rows.find((r) => r.label === label);

// The newest artifact on the branch wins — compared on created_at, not artifact id.
// A comparator reading the wrong field ties every artifact and silently returns the
// oldest, which is a stale site nobody notices.
const branchRows = selectArtifacts(
	[
		art(9000, "mainsha", "2026-04-01T00:00:00Z", { branch: "main" }),
		art(9001, "mainsha", "2026-05-01T00:00:00Z", { branch: "main" }),
	],
	{ defaultBranch: "main", repoId: 42 },
);
assert.equal(rowOf(branchRows, "default-branch CI (main)").artifactId, 9001);
ok("selectArtifacts takes the newest default-branch artifact by build date");

// A fork's pull_request run executes in the UPSTREAM repo's Actions, so a fork branch
// called `main` is visible here. Landing it in site/main would serve fork content as
// the default branch.
const forkBranch = selectArtifacts(
	[
		art(9100, "mainsha", "2026-05-01T00:00:00Z", { branch: "main" }),
		art(9200, "forksha", "2026-06-01T00:00:00Z", {
			branch: "main",
			repoId: 777,
		}),
	],
	{ defaultBranch: "main", repoId: 42 },
);
assert.equal(rowOf(forkBranch, "default-branch CI (main)").artifactId, 9100);
ok(
	"selectArtifacts excludes a fork-owned branch of the same name, even when newer",
);

// ...including when the fork's artifact shares the default branch's head SHA, which a
// SHA-keyed re-lookup would hand back despite the repo filter.
const forkSameSha = selectArtifacts(
	[
		art(9300, "mainsha", "2026-05-01T00:00:00Z", { branch: "main" }),
		art(9400, "mainsha", "2026-06-01T00:00:00Z", {
			branch: "main",
			repoId: 777,
		}),
	],
	{ defaultBranch: "main", repoId: 42 },
);
assert.equal(rowOf(forkSameSha, "default-branch CI (main)").artifactId, 9300);
ok(
	"selectArtifacts keeps a fork out of the default branch at an identical head SHA",
);

// A PR's artifact is looked up with NO repo filter: a fork PR's build legitimately
// belongs to the fork, and `approved` is what gates it.
const prRows = selectArtifacts(
	[art(9500, "forkpr", "2026-05-01T00:00:00Z", { repoId: 777 })],
	{ defaultBranch: "main", repoId: 42, prs: [pr(7, "forkpr")] },
);
assert.equal(destOf(prRows, "PR #7"), "pr-7");
ok("selectArtifacts previews an approved fork PR's own artifact");

const unapproved = selectArtifacts(
	[art(9600, "forkpr", "2026-05-01T00:00:00Z", { repoId: 777 })],
	{ defaultBranch: "main", repoId: 42, prs: [pr(7, "forkpr", false)] },
);
assert.equal(destOf(unapproved, "PR #7"), null);
assert.match(rowOf(unapproved, "PR #7").decision, /not preview-approved/);
ok("selectArtifacts skips an unapproved fork PR");

// Expired artifacts are not a source at all.
const expired = selectArtifacts(
	[{ ...art(9700, "prsha", "2026-05-01T00:00:00Z"), expired: true }],
	{ defaultBranch: "main", repoId: 42, prs: [pr(7, "prsha")] },
);
assert.equal(destOf(expired, "PR #7"), null);
ok("selectArtifacts ignores expired artifacts");

// The cap ranks by build date and applies AFTER eligibility, so an ineligible PR
// never costs a slot — same rule as selectReleases.
const cappedPrs = selectArtifacts(
	[
		art(1, "a", "2026-05-01T00:00:00Z"),
		art(2, "b", "2026-05-03T00:00:00Z"),
		art(3, "c", "2026-05-02T00:00:00Z"),
	],
	{
		defaultBranch: "main",
		repoId: 42,
		maxPrs: 2,
		prs: [pr(20, "a"), pr(21, "b"), pr(22, "c"), pr(23, "nothing")],
	},
);
assert.deepEqual(
	cappedPrs.filter((r) => r.dest).map((r) => r.dest),
	["pr-21", "pr-22"],
);
assert.match(rowOf(cappedPrs, "PR #20").decision, /beyond max-prs=2/);
assert.match(rowOf(cappedPrs, "PR #23").decision, /no non-expired/);
ok("selectArtifacts caps PRs by build date, after eligibility");

assert.equal(
	selectArtifacts([], { defaultBranch: "main", repoId: 42 }).length,
	1,
);
ok("selectArtifacts still reports the default branch when nothing was found");

// --- cacheKey: the release-zip cache key is derived from the SELECTION ---
const keyRows = selectReleases(
	[rel("3.0", "2026-03-01T00:00:00Z"), rel("2.0", "2026-02-01T00:00:00Z")],
	{ defaultBranch: "main" },
);
assert.match(cacheKey(keyRows), /^mvs-relzips-v1-[0-9a-f]{32}$/);
ok("cacheKey is the namespace prefix plus a 32-char digest");

assert.equal(cacheKey(keyRows), cacheKey(keyRows.slice().reverse()));
ok("cacheKey is order-independent — it names a set, not a listing");

// Cutting a release must MISS, or the new version never gets downloaded.
const withNew = selectReleases(
	[
		rel("4.0", "2026-04-01T00:00:00Z"),
		rel("3.0", "2026-03-01T00:00:00Z"),
		rel("2.0", "2026-02-01T00:00:00Z"),
	],
	{ defaultBranch: "main" },
);
assert.notEqual(cacheKey(withNew), cacheKey(keyRows));
ok("cacheKey changes when a release joins the published set");

// ...and capping one out must miss too, so the entry stays pruned to what is served.
const threeReleases = [
	rel("4.0", "2026-04-01T00:00:00Z"),
	rel("3.0", "2026-03-01T00:00:00Z"),
	rel("2.0", "2026-02-01T00:00:00Z"),
];
assert.notEqual(
	cacheKey(
		selectReleases(threeReleases, { defaultBranch: "main", maxReleases: 1 }),
	),
	cacheKey(
		selectReleases(threeReleases, { defaultBranch: "main", maxReleases: 2 }),
	),
);
ok("cacheKey changes when max-releases changes the published set");

// A release contributing no zip must not perturb the key, or a repo with one
// asset-less release would miss on every single deploy.
assert.equal(
	cacheKey([
		...keyRows,
		{
			tag: "junk",
			dest: null,
			date: null,
			assetId: null,
			size: 0,
			decision: "",
		},
	]),
	cacheKey(keyRows),
);
ok("cacheKey ignores rows that contribute nothing to the site");

assert.equal(RELZIPS_CACHE_PREFIX, "mvs-relzips-v1-");
ok(
	"the cache namespace is exported so the workflow need not repeat the literal",
);

// A release with no created_at at all must not win the cap, and must not throw.
const undated = selectReleases(
	[
		{ tag_name: "9.9", assets: [{ name: "docs.zip", id: "id-9.9", size: 1 }] },
		rel("3.0", "2026-03-01T00:00:00Z"),
	],
	{ defaultBranch: "main", maxReleases: 1 },
);
assert.deepEqual(gatheredOf(undated), ["3.0"]);
ok("selectReleases sorts undated releases last rather than failing");

console.log(`\nAll ${passed} checks passed.`);

/**
 * Tests for the pure URL logic and the plugin directive output.
 * Runs in plain Node (no DOM, no myst) — `node --test` or directly.
 * Live anywidget rendering is a browser job.
 */
import assert from "node:assert/strict";
import {
	computeTargetUrl,
	detectCurrent,
	entryLabel,
	isLocalHost,
	relativePath,
	resolveTargetUrl,
	withLocalFallback,
	withTrailingSlash,
} from "../plugins/version-switcher.mjs";
import plugin from "../plugins/version-switcher.mjs";

const switcher = [
	{
		version: "dev",
		name: "dev (main)",
		url: "https://acme.github.io/widget/main/",
	},
	{
		version: "2.1",
		name: "2.1 (stable)",
		url: "https://acme.github.io/widget/2.1/",
		preferred: true,
	},
	{ version: "2.0", url: "https://acme.github.io/widget/2.0/" },
];

let passed = 0;
function ok(name) {
	passed += 1;
	console.log("  ok -", name);
}

// --- withTrailingSlash ---
assert.equal(withTrailingSlash("/a/b"), "/a/b/");
assert.equal(withTrailingSlash("/a/b/"), "/a/b/");
assert.equal(withTrailingSlash(""), "/");
ok("withTrailingSlash normalises");

// --- entryLabel ---
assert.equal(entryLabel({ name: "2.1 (stable)" }), "2.1 (stable)");
assert.equal(entryLabel({ version: "2.0" }), "2.0");
assert.equal(entryLabel({ url: "https://x/" }), "https://x/");
assert.equal(entryLabel({ name: "2.1", preferred: true }), "2.1 ★");
ok("entryLabel falls back name->version->url and stars the preferred entry");

// --- relativePath ---
assert.equal(relativePath("/a/b/c", "/a/b/d/plugin.mjs"), "../d/plugin.mjs");
assert.equal(relativePath("/a/b", "/a/b/plugin.mjs"), "plugin.mjs");
assert.equal(relativePath("/x/y", "/a/b/plugin.mjs"), "../../a/b/plugin.mjs");
ok("relativePath computes POSIX relative paths");

// --- detectCurrent by URL prefix (gh-pages project path) ---
const detected2_0 = detectCurrent(switcher, "/widget/2.0/guide/install.html");
const cur = detected2_0.entry;
assert.equal(cur.version, "2.0");
assert.equal(detected2_0.base, "/widget/2.0/");
ok("detectCurrent picks 2.0 from pathname and reports its base");

// longest-prefix wins, not first match
const cur2 = detectCurrent(switcher, "/widget/2.1/");
assert.equal(cur2.entry.version, "2.1");
ok("detectCurrent picks 2.1 root page");

// no match -> null (e.g. local preview at /)
assert.equal(detectCurrent(switcher, "/").entry, null);
ok("detectCurrent returns null when nothing matches");

// --- detectCurrent via explicit version-match, incl. loose semver ---
assert.equal(detectCurrent(switcher, "/", "2.1").entry.version, "2.1");
assert.equal(detectCurrent(switcher, "/", "2.1.3").entry.version, "2.1"); // loose
ok("detectCurrent honours version_match (exact + loose)");

// --- detectCurrent maps a /stable/ page to the concrete preferred release ---
const stableHit = detectCurrent(switcher, "/widget/stable/guide/install.html");
assert.equal(stableHit.entry.version, "2.1"); // the preferred (★) entry
assert.equal(stableHit.base, "/widget/stable/"); // the actual served base
ok("detectCurrent maps /stable/ to the preferred entry with the stable base");

// not under stable, no version match -> still null
assert.equal(detectCurrent(switcher, "/widget/other/").entry, null);
ok("detectCurrent does not over-match the stable alias");

// --- computeTargetUrl preserves page path across versions ---
const t1 = computeTargetUrl(
	switcher[0], // -> dev
	cur, // from 2.0
	detected2_0.base,
	{ pathname: "/widget/2.0/guide/install.html", hash: "#setup" },
	true,
);
assert.equal(t1, "https://acme.github.io/widget/main/guide/install.html#setup");
ok("computeTargetUrl carries page + hash to dev");

// --- from a /stable/ page, strip the stable base onto the pinned version ---
const tStable = computeTargetUrl(
	switcher[2], // -> 2.0
	stableHit.entry,
	stableHit.base, // /widget/stable/
	{ pathname: "/widget/stable/guide/install.html", hash: "" },
	true,
);
assert.equal(tStable, "https://acme.github.io/widget/2.0/guide/install.html");
ok("computeTargetUrl strips the stable base onto the chosen pinned version");

// --- preserve_path = false goes to version root ---
const t2 = computeTargetUrl(
	switcher[1], // -> 2.1
	cur,
	detected2_0.base,
	{ pathname: "/widget/2.0/guide/install.html", hash: "" },
	false,
);
assert.equal(t2, "https://acme.github.io/widget/2.1/");
ok("computeTargetUrl with preserve_path=false -> target root");

// --- no current detected: still navigates to target root ---
const t3 = computeTargetUrl(
	switcher[2],
	null,
	null,
	{ pathname: "/somewhere/else/", hash: "" },
	true,
);
assert.equal(t3, "https://acme.github.io/widget/2.0/");
ok("computeTargetUrl with no current -> target root");

// --- isLocalHost ---
assert.ok(isLocalHost("localhost"));
assert.ok(isLocalHost("127.0.0.1"));
assert.ok(isLocalHost("foo.localhost"));
assert.ok(!isLocalHost("pandablocks.github.io"));
ok("isLocalHost recognises local dev hosts");

// --- withLocalFallback: synthesise a "local" current on localhost ---
const lf = withLocalFallback(switcher, null, null, {
	hostname: "localhost",
	origin: "http://localhost:3043",
});
assert.equal(lf.current.version, "local");
assert.equal(lf.current.url, "http://localhost:3043/");
assert.equal(lf.base, "/");
assert.equal(lf.entries[0], lf.current);
assert.equal(lf.entries.length, switcher.length + 1);
ok("withLocalFallback adds a local entry rooted at / when nothing matched");

const localFromCommands = computeTargetUrl(
	switcher[1],
	lf.current,
	lf.base,
	{ pathname: "/commands", hash: "" },
	true,
);
assert.equal(localFromCommands, "https://acme.github.io/widget/2.1/commands");
ok("local current (base /) carries the page path to the target version");

const lf2 = withLocalFallback(switcher, switcher[2], "/widget/2.0/", {
	hostname: "localhost",
	origin: "http://localhost:3043",
});
assert.equal(lf2.current, switcher[2]);
assert.equal(lf2.base, "/widget/2.0/");
assert.equal(lf2.entries, switcher);
ok("withLocalFallback leaves a detected version untouched");

const lf3 = withLocalFallback(switcher, null, null, {
	hostname: "pandablocks.github.io",
	origin: "https://pandablocks.github.io",
});
assert.equal(lf3.current, null);
assert.equal(lf3.entries, switcher);
ok("withLocalFallback is a no-op in production");

// --- resolveTargetUrl: probe the target page, fall back to version root ---
function mockExists(verdict) {
	const calls = [];
	const fn = async (url) => {
		calls.push(url);
		return verdict;
	};
	fn.calls = calls;
	return fn;
}
const fromDev = { pathname: "/widget/main/guide/install.html", hash: "#setup" };
const devDetected = detectCurrent(switcher, fromDev.pathname); // dev entry
const devCur = devDetected.entry;
const devBase = devDetected.base;

const exists = mockExists(true);
assert.equal(
	await resolveTargetUrl({
		targetEntry: switcher[1],
		currentEntry: devCur,
		currentBase: devBase,
		location: fromDev,
		preservePath: true,
		pageExists: exists,
	}),
	"https://acme.github.io/widget/2.1/guide/install.html#setup",
);
assert.deepEqual(exists.calls, [
	"https://acme.github.io/widget/2.1/guide/install.html#setup",
]);
ok("resolveTargetUrl keeps path when target page exists");

const missing = mockExists(false);
assert.equal(
	await resolveTargetUrl({
		targetEntry: switcher[1],
		currentEntry: devCur,
		currentBase: devBase,
		location: fromDev,
		preservePath: true,
		pageExists: missing,
	}),
	"https://acme.github.io/widget/2.1/",
);
ok("resolveTargetUrl falls back to root when target page 404s");

assert.equal(
	await resolveTargetUrl({
		targetEntry: switcher[1],
		currentEntry: devCur,
		currentBase: devBase,
		location: fromDev,
		preservePath: true,
		pageExists: mockExists(null),
	}),
	"https://acme.github.io/widget/2.1/guide/install.html#setup",
);
ok("resolveTargetUrl keeps path when probe is indeterminate");

const notCalled1 = mockExists(false);
assert.equal(
	await resolveTargetUrl({
		targetEntry: switcher[1],
		currentEntry: devCur,
		currentBase: devBase,
		location: fromDev,
		preservePath: false,
		pageExists: notCalled1,
	}),
	"https://acme.github.io/widget/2.1/",
);
assert.equal(notCalled1.calls.length, 0);
ok("resolveTargetUrl skips probe when preserve_path is false");

const notCalled2 = mockExists(false);
assert.equal(
	await resolveTargetUrl({
		targetEntry: switcher[2],
		currentEntry: null,
		currentBase: null,
		location: fromDev,
		preservePath: true,
		pageExists: notCalled2,
	}),
	"https://acme.github.io/widget/2.0/",
);
assert.equal(notCalled2.calls.length, 0);
ok("resolveTargetUrl skips probe when no current version");

const rootDetected = detectCurrent(switcher, "/widget/main/");
const notCalled3 = mockExists(false);
assert.equal(
	await resolveTargetUrl({
		targetEntry: switcher[1],
		currentEntry: rootDetected.entry,
		currentBase: rootDetected.base,
		location: { pathname: "/widget/main/", hash: "" },
		preservePath: true,
		pageExists: notCalled3,
	}),
	"https://acme.github.io/widget/2.1/",
);
assert.equal(notCalled3.calls.length, 0);
ok("resolveTargetUrl skips probe when current page is the version root");

// --- plugin directive emits a correct anywidget node ---
const dir = plugin.directives[0];
assert.equal(dir.name, "version-switcher");
assert.equal(typeof plugin.render, "function"); // anywidget runtime on default export

const nodes = dir.run({
	options: { "json-url": "https://acme.github.io/widget/switcher.json" },
});
assert.equal(nodes.length, 1);
const node = nodes[0];
assert.equal(node.type, "anywidget");
assert.equal(
	node.model.json_url,
	"https://acme.github.io/widget/switcher.json",
);
assert.equal(node.model.preserve_path, true);
assert.equal(node.model.probe_target, true);
assert.ok(node.esm && typeof node.esm === "string"); // self-referential path
assert.ok(node.id && typeof node.id === "string");
ok("plugin directive emits a valid anywidget node with a self-referential esm");

// boolean options flow through
const nodes2 = dir.run({
	options: {
		"json-url": "/widget/switcher.json",
		"preserve-path": false,
		"probe-target": false,
		"version-match": "dev",
	},
});
assert.equal(nodes2[0].model.preserve_path, false);
assert.equal(nodes2[0].model.probe_target, false);
assert.equal(nodes2[0].model.version_match, "dev");
ok(
	"plugin directive honours preserve-path / probe-target / version-match options",
);

console.log(`\nAll ${passed} checks passed.`);

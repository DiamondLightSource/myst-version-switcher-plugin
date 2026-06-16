/**
 * Tests for the pure URL logic and the plugin directive output.
 * Runs in plain Node (no DOM, no myst) — `node --test` or directly.
 * Live anywidget rendering is a browser job.
 */
import assert from 'node:assert/strict';
import {
  detectCurrent,
  computeTargetUrl,
  resolveTargetUrl,
  withTrailingSlash,
  relativePath,
  isLocalHost,
  withLocalFallback,
} from '../plugins/version-switcher/version-switcher.mjs';
import plugin from '../plugins/version-switcher/version-switcher.mjs';

const switcher = [
  { version: 'dev', name: 'dev (main)', url: 'https://acme.github.io/widget/main/' },
  { version: '2.1', name: '2.1 (stable)', url: 'https://acme.github.io/widget/2.1/', preferred: true },
  { version: '2.0', url: 'https://acme.github.io/widget/2.0/' },
];

let passed = 0;
function ok(name) { passed += 1; console.log('  ok -', name); }

// --- withTrailingSlash ---
assert.equal(withTrailingSlash('/a/b'), '/a/b/');
assert.equal(withTrailingSlash('/a/b/'), '/a/b/');
assert.equal(withTrailingSlash(''), '/');
ok('withTrailingSlash normalises');

// --- relativePath ---
assert.equal(relativePath('/a/b/c', '/a/b/d/plugin.mjs'), '../d/plugin.mjs');
assert.equal(relativePath('/a/b', '/a/b/plugin.mjs'), 'plugin.mjs');
assert.equal(relativePath('/x/y', '/a/b/plugin.mjs'), '../../a/b/plugin.mjs');
ok('relativePath computes POSIX relative paths');

// --- detectCurrent by URL prefix (gh-pages project path) ---
const cur = detectCurrent(switcher, '/widget/2.0/guide/install.html');
assert.equal(cur.version, '2.0');
ok('detectCurrent picks 2.0 from pathname');

// longest-prefix wins, not first match
const cur2 = detectCurrent(switcher, '/widget/2.1/');
assert.equal(cur2.version, '2.1');
ok('detectCurrent picks 2.1 root page');

// no match -> null (e.g. local preview at /)
assert.equal(detectCurrent(switcher, '/'), null);
ok('detectCurrent returns null when nothing matches');

// --- detectCurrent via explicit version-match, incl. loose semver ---
assert.equal(detectCurrent(switcher, '/', '2.1').version, '2.1');
assert.equal(detectCurrent(switcher, '/', '2.1.3').version, '2.1'); // loose
ok('detectCurrent honours version_match (exact + loose)');

// --- computeTargetUrl preserves page path across versions ---
const t1 = computeTargetUrl(
  switcher[0], // -> dev
  cur,         // from 2.0
  { pathname: '/widget/2.0/guide/install.html', hash: '#setup' },
  true,
);
assert.equal(t1, 'https://acme.github.io/widget/main/guide/install.html#setup');
ok('computeTargetUrl carries page + hash to dev');

// --- preserve_path = false goes to version root ---
const t2 = computeTargetUrl(
  switcher[1], // -> 2.1
  cur,
  { pathname: '/widget/2.0/guide/install.html', hash: '' },
  false,
);
assert.equal(t2, 'https://acme.github.io/widget/2.1/');
ok('computeTargetUrl with preserve_path=false -> target root');

// --- no current detected: still navigates to target root ---
const t3 = computeTargetUrl(
  switcher[2],
  null,
  { pathname: '/somewhere/else/', hash: '' },
  true,
);
assert.equal(t3, 'https://acme.github.io/widget/2.0/');
ok('computeTargetUrl with no current -> target root');

// --- isLocalHost ---
assert.ok(isLocalHost('localhost'));
assert.ok(isLocalHost('127.0.0.1'));
assert.ok(isLocalHost('foo.localhost'));
assert.ok(!isLocalHost('pandablocks.github.io'));
ok('isLocalHost recognises local dev hosts');

// --- withLocalFallback: synthesise a "local" current on localhost ---
const lf = withLocalFallback(switcher, null, { hostname: 'localhost', origin: 'http://localhost:3043' });
assert.equal(lf.current.version, 'local');
assert.equal(lf.current.url, 'http://localhost:3043/');
assert.equal(lf.entries[0], lf.current);
assert.equal(lf.entries.length, switcher.length + 1);
ok('withLocalFallback adds a local entry rooted at / when nothing matched');

const localFromCommands = computeTargetUrl(
  switcher[1], lf.current, { pathname: '/commands', hash: '' }, true,
);
assert.equal(localFromCommands, 'https://acme.github.io/widget/2.1/commands');
ok('local current (base /) carries the page path to the target version');

const lf2 = withLocalFallback(switcher, switcher[2], { hostname: 'localhost', origin: 'http://localhost:3043' });
assert.equal(lf2.current, switcher[2]);
assert.equal(lf2.entries, switcher);
ok('withLocalFallback leaves a detected version untouched');

const lf3 = withLocalFallback(switcher, null, { hostname: 'pandablocks.github.io', origin: 'https://pandablocks.github.io' });
assert.equal(lf3.current, null);
assert.equal(lf3.entries, switcher);
ok('withLocalFallback is a no-op in production');

// --- resolveTargetUrl: probe the target page, fall back to version root ---
function mockExists(verdict) {
  const calls = [];
  const fn = async (url) => { calls.push(url); return verdict; };
  fn.calls = calls;
  return fn;
}
const fromDev = { pathname: '/widget/main/guide/install.html', hash: '#setup' };
const devCur = detectCurrent(switcher, fromDev.pathname); // dev entry

const exists = mockExists(true);
assert.equal(
  await resolveTargetUrl({
    targetEntry: switcher[1], currentEntry: devCur, location: fromDev,
    preservePath: true, pageExists: exists,
  }),
  'https://acme.github.io/widget/2.1/guide/install.html#setup',
);
assert.deepEqual(exists.calls, ['https://acme.github.io/widget/2.1/guide/install.html#setup']);
ok('resolveTargetUrl keeps path when target page exists');

const missing = mockExists(false);
assert.equal(
  await resolveTargetUrl({
    targetEntry: switcher[1], currentEntry: devCur, location: fromDev,
    preservePath: true, pageExists: missing,
  }),
  'https://acme.github.io/widget/2.1/',
);
ok('resolveTargetUrl falls back to root when target page 404s');

assert.equal(
  await resolveTargetUrl({
    targetEntry: switcher[1], currentEntry: devCur, location: fromDev,
    preservePath: true, pageExists: mockExists(null),
  }),
  'https://acme.github.io/widget/2.1/guide/install.html#setup',
);
ok('resolveTargetUrl keeps path when probe is indeterminate');

const notCalled1 = mockExists(false);
assert.equal(
  await resolveTargetUrl({
    targetEntry: switcher[1], currentEntry: devCur, location: fromDev,
    preservePath: false, pageExists: notCalled1,
  }),
  'https://acme.github.io/widget/2.1/',
);
assert.equal(notCalled1.calls.length, 0);
ok('resolveTargetUrl skips probe when preserve_path is false');

const notCalled2 = mockExists(false);
assert.equal(
  await resolveTargetUrl({
    targetEntry: switcher[2], currentEntry: null, location: fromDev,
    preservePath: true, pageExists: notCalled2,
  }),
  'https://acme.github.io/widget/2.0/',
);
assert.equal(notCalled2.calls.length, 0);
ok('resolveTargetUrl skips probe when no current version');

const notCalled3 = mockExists(false);
assert.equal(
  await resolveTargetUrl({
    targetEntry: switcher[1],
    currentEntry: detectCurrent(switcher, '/widget/main/'),
    location: { pathname: '/widget/main/', hash: '' },
    preservePath: true, pageExists: notCalled3,
  }),
  'https://acme.github.io/widget/2.1/',
);
assert.equal(notCalled3.calls.length, 0);
ok('resolveTargetUrl skips probe when current page is the version root');

// --- plugin directive emits a correct anywidget node ---
const dir = plugin.directives[0];
assert.equal(dir.name, 'version-switcher');
assert.equal(typeof plugin.render, 'function'); // anywidget runtime on default export

const nodes = dir.run({
  options: { 'json-url': 'https://acme.github.io/widget/switcher.json' },
});
assert.equal(nodes.length, 1);
const node = nodes[0];
assert.equal(node.type, 'anywidget');
assert.equal(node.model.json_url, 'https://acme.github.io/widget/switcher.json');
assert.equal(node.model.preserve_path, true);
assert.equal(node.model.probe_target, true);
assert.ok(node.esm && typeof node.esm === 'string'); // self-referential path
assert.ok(node.id && typeof node.id === 'string');
ok('plugin directive emits a valid anywidget node with a self-referential esm');

// boolean options flow through
const nodes2 = dir.run({
  options: {
    'json-url': '/widget/switcher.json',
    'preserve-path': false,
    'probe-target': false,
    'version-match': 'dev',
  },
});
assert.equal(nodes2[0].model.preserve_path, false);
assert.equal(nodes2[0].model.probe_target, false);
assert.equal(nodes2[0].model.version_match, 'dev');
ok('plugin directive honours preserve-path / probe-target / version-match options');

console.log(`\nAll ${passed} checks passed.`);

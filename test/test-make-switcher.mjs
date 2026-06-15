/**
 * Parity tests for make-switcher.mjs against the behaviour of make_switcher.py:
 * ordering (master/main first, tags newest-first, leftovers alphabetical),
 * `--add`, and the exact JSON shape/serialisation.
 */
import assert from 'node:assert/strict';
import {
  orderVersions,
  switcherStruct,
  renderSwitcher,
} from '../switcher/make-switcher.mjs';

let passed = 0;
function ok(name) { passed += 1; console.log('  ok -', name); }

// tags come newest-first (as `git tag --sort=-v:refname` produces).
const tags = ['2.1', '2.0', '1.0'];

// main + a subset of tags deployed; --add folds in the build being published.
assert.deepEqual(
  orderVersions(['main', '2.0'], tags, '2.1'),
  ['main', '2.1', '2.0'],
);
ok('orders main first, then tags newest-first');

// first deploy: no branch dirs, only the build being added.
assert.deepEqual(orderVersions([], [], 'main'), ['main']);
ok('handles an empty gh-pages branch (first deploy)');

// master wins over main when both somehow present; leftovers sort alphabetically.
assert.deepEqual(
  orderVersions(['main', 'master', 'zzz', 'aaa'], [], null),
  ['master', 'main', 'aaa', 'zzz'],
);
ok('master before main; unknown dirs appended alphabetically');

// a deployed tag not in --add still orders by the tag list.
assert.deepEqual(
  orderVersions(['main', '2.1', '2.0'], tags, null),
  ['main', '2.1', '2.0'],
);
ok('existing deployed tags ordered newest-first');

// --- switcherStruct shape ---
assert.deepEqual(
  switcherStruct('DiamondLightSource/myst-version-switcher-plugin', ['main', '2.1']),
  [
    { version: 'main', url: 'https://DiamondLightSource.github.io/myst-version-switcher-plugin/main/' },
    { version: '2.1', url: 'https://DiamondLightSource.github.io/myst-version-switcher-plugin/2.1/' },
  ],
);
ok('switcherStruct builds the pydata {version,url} array');

// --- exact serialisation (2-space, no trailing newline), parity with json.dumps(indent=2) ---
const text = renderSwitcher('acme/widget', ['main', '2.0']);
assert.equal(
  text,
  `[
  {
    "version": "main",
    "url": "https://acme.github.io/widget/main/"
  },
  {
    "version": "2.0",
    "url": "https://acme.github.io/widget/2.0/"
  }
]`,
);
ok('renderSwitcher matches make_switcher.py 2-space JSON output');

console.log(`\nAll ${passed} checks passed.`);

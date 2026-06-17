# myst-version-switcher-plugin

A pydata-style version-switcher for [MyST](https://mystmd.org) docs, delivered as
a single `anywidget` plugin **plus** a CI composite action that generates the
`switcher.json` the widget reads and a root `index.html` redirect to the newest
stable release.

## Repo layout

```
plugins/version-switcher/version-switcher.mjs  # MyST directive + anywidget runtime (single file, no README — docs are in docs/)
switcher/action.yml                            # composite action: writes switcher.json + index.html
switcher/make-switcher.mjs                     # dependency-free Node switcher + redirect generator
test/                                          # npm test suite (node, no framework)
docs/                                          # this repo's own docs (dogfoods the plugin)
.github/workflows/ci.yml                       # orchestrator → _test / _docs / _release
```

## Two halves, different lifecycles

| half | file | how consumers use it |
|------|------|----------------------|
| Plugin (widget) | `plugins/version-switcher/version-switcher.mjs` | release-asset URL in `myst.yml` `plugins` |
| Switcher action | `switcher/` | `uses: DiamondLightSource/myst-version-switcher-plugin/switcher@<tag>` |

One `vX.Y.Z` tag versions both. The plugin is published as a GitHub Release asset;
the action is consumed from the repo tree at the same tag.

## Key design decisions

### `switcher` action only writes the two derived files
The action writes `switcher.json` and a root `index.html` (a redirect to the
newest stable release) into the caller-supplied `output-dir` — the gh-pages
publish root — and nothing else. It does NOT `mv` the built docs, does NOT
`git fetch`. Staging the versioned dir (`mv`) and `fetch-depth: 0` (for tags +
`origin/gh-pages`) are the caller's responsibility (pattern lifted from
`python-copier-template-example`). Both files are derived purely from the git
version ordering, so regenerating them every deploy is intentional — with
`keep_files: true` each deploy refreshes the root redirect to the latest release.

### BASE_URL must be set before `myst build`
```yaml
env:
  BASE_URL: /<repo>/$DOCS_VERSION
run: cd docs && myst build --html
```
Without this, assets and links break under the versioned GitHub Pages sub-path.

### `make-switcher.mjs` degrades gracefully on first deploy
When `origin/gh-pages` does not yet exist (no deployed builds, no tags), it
produces a single-entry `switcher.json` for just the current version and an
`index.html` redirecting to it, rather than failing. The "preferred" version (the
`index.html` target, flagged `preferred: true` in switcher.json) is the newest
non-prerelease tag with a deployed build, falling back to `main`/`master`.
Prerelease detection mirrors `_release.yml` (an `a`/`b`/`rc` marker).

## CI structure

Mirrors `python-copier-template-example` as closely as possible:

- `ci.yml` — orchestrator; triggers on `push: main`, tags, and PRs
- `_test.yml` — `npm test`
- `_docs.yml` — full docs build + deploy (see deviations below)
- `_release.yml` — publishes `version-switcher.mjs` as a GitHub Release asset (tag-only)

### `_docs.yml` deviations from template
1. `npm install -g mystmd@1.10.1` instead of `uv run tox -e docs` (no Python here)
2. `BASE_URL` env var set before `myst build`
3. `uses: ./switcher` writes `switcher.json` + `index.html` (instead of `make_switcher.py`)

`mystmd` is pinned at `1.10.1` (not `latest`).

## Developing

```bash
npm test                    # run the test suite
npm run docs                # build docs (same command CI uses)
npm run docs-dev            # live-preview docs with the plugin loaded from local plugins/
```

`docs/myst.yml` loads the plugin from `../plugins/version-switcher/version-switcher.mjs`
(not a release URL), so edits are reflected on rebuild.

**Browser caveat:** `<select>` popups don't open in VS Code Simple Browser. Open the
forwarded port in a real browser and hard-reload (MyST caches the localized esm).

## Releasing

```bash
git tag vX.Y.Z && git push origin vX.Y.Z
```

CI runs tests + docs deploy, then `_release.yml` creates a GitHub Release with
`version-switcher.mjs` as an asset. Both the plugin URL and the action reference the
same tag.

## Consuming this in another repo

Pin `<tag>` in two places (with copier, one Jinja variable fills both):

```yaml
# docs/myst.yml
project:
  plugins:
    - https://github.com/DiamondLightSource/myst-version-switcher-plugin/releases/download/<tag>/version-switcher.mjs
site:
  template: book-theme
  parts:
    navbar_end: navbar_end.md
```

```markdown
<!-- docs/navbar_end.md -->
:::{version-switcher}
:json-url: https://ORG.github.io/REPO/switcher.json
:::
```

```yaml
# .github/workflows/docs.yml
- uses: actions/checkout@v5
  with:
    fetch-depth: 0   # required: tags + origin/gh-pages for version list
- run: echo "DOCS_VERSION=${GITHUB_REF_NAME//[^A-Za-z0-9._-]/_}" >> $GITHUB_ENV
- run: cd docs && myst build --html
  env:
    BASE_URL: /<repo>/${{ env.DOCS_VERSION }}
- run: |
    mkdir -p _site
    mv docs/_build/html _site/$DOCS_VERSION
- uses: DiamondLightSource/myst-version-switcher-plugin/switcher@<tag>
  with:
    version: ${{ env.DOCS_VERSION }}
    repo: ${{ github.repository }}
    output-dir: _site   # required: writes switcher.json + index.html into the publish root
- uses: peaceiris/actions-gh-pages@v4
  with:
    publish_dir: _site
    keep_files: true
```

## Planned: versioned-publish redesign

[`DESIGN.md`](DESIGN.md) proposes replacing the current "switcher writes two
files + caller stages/publishes with `keep_files: true`" model with a single
`deploy` action that reconstructs the whole versioned site every deploy from
durable sources (`docs.zip` release assets for tags, latest CI artifact for
branches), then publishes the complete tree. Not yet implemented. The pure
`make-switcher.mjs` functions carry over; only version discovery changes
(directory scan instead of `git ls-tree origin/gh-pages`).

## Upstreaming

`plugins/version-switcher/` mirrors
[`jupyter-book/myst-plugins`](https://github.com/jupyter-book/myst-plugins)
conventions (single self-contained `.mjs`, distributed as a release asset) so it
can later be contributed there. The `switcher/` producer is DLS deployment
infrastructure and stays here.

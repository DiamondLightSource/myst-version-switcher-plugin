# myst-version-switcher-plugin

A pydata-style version-switcher for [MyST](https://mystmd.org) docs, delivered as
a single `anywidget` plugin **plus** a CI composite action that generates the
`switcher.json` the widget reads.

## Repo layout

```
plugins/version-switcher/version-switcher.mjs  # MyST directive + anywidget runtime (single file, no README — docs are in docs/)
switcher/action.yml                            # composite action: writes switcher.json ONLY
switcher/make-switcher.mjs                     # dependency-free Node switcher generator
test/                                          # npm test suite (node, no framework)
docs/                                          # this repo's own docs (dogfoods the plugin)
.github/workflows/ci.yml                       # orchestrator → _test / _docs / _release
.github/pages/index.html                       # MUST stay committed — bootstraps .github/pages/
                                               # dir (so mv step works) + redirects root to main/
```

## Two halves, different lifecycles

| half | file | how consumers use it |
|------|------|----------------------|
| Plugin (widget) | `plugins/version-switcher/version-switcher.mjs` | release-asset URL in `myst.yml` `plugins` |
| Switcher action | `switcher/` | `uses: DiamondLightSource/myst-version-switcher-plugin/switcher@<tag>` |

One `vX.Y.Z` tag versions both. The plugin is published as a GitHub Release asset;
the action is consumed from the repo tree at the same tag.

## Key design decisions

### `switcher` action is write-only
The action writes `.github/pages/switcher.json` and nothing else. It does NOT `mv`
the built docs, does NOT `git fetch`. Staging the versioned dir (`mv`) and
`fetch-depth: 0` (for tags + `origin/gh-pages`) are the caller's responsibility
(pattern lifted from `python-copier-template-example`).

### BASE_URL must be set before `myst build`
```yaml
env:
  BASE_URL: /<repo>/$DOCS_VERSION
run: cd docs && myst build --html
```
Without this, assets and links break under the versioned GitHub Pages sub-path.

### `.github/pages/index.html` must stay committed
- Redirects the Pages root to `./main/index.html`.
- CI copies it into `_staging/` before publishing, so it always lands on gh-pages.
- `.github/pages/` is source-only; CI writes nothing there — versioned builds stage in `_staging/`.

### `make-switcher.mjs` degrades gracefully on first deploy
When `origin/gh-pages` does not yet exist, it produces a single-entry `switcher.json`
for just the current version rather than failing.

## CI structure

Mirrors `python-copier-template-example` as closely as possible:

- `ci.yml` — orchestrator; triggers on `push: main`, tags, and PRs
- `_test.yml` — `npm test`
- `_docs.yml` — full docs build + deploy (see deviations below)
- `_release.yml` — publishes `version-switcher.mjs` as a GitHub Release asset (tag-only)

### `_docs.yml` deviations from template
1. `npm install -g mystmd@1.10.1` instead of `uv run tox -e docs` (no Python here)
2. `BASE_URL` env var set before `myst build`
3. `uses: ./switcher` writes `switcher.json` (instead of `make_switcher.py`)

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
- run: mv docs/_build/html .github/pages/$DOCS_VERSION
- uses: DiamondLightSource/myst-version-switcher-plugin/switcher@<tag>
  with:
    version: ${{ env.DOCS_VERSION }}
    repo: ${{ github.repository }}
- uses: peaceiris/actions-gh-pages@v4
  with:
    publish_dir: .github/pages
    keep_files: true
```

## Upstreaming

`plugins/version-switcher/` mirrors
[`jupyter-book/myst-plugins`](https://github.com/jupyter-book/myst-plugins)
conventions (single self-contained `.mjs`, distributed as a release asset) so it
can later be contributed there. The `switcher/` producer is DLS deployment
infrastructure and stays here.

# myst-version-switcher-plugin

A pydata-style version-switcher for [MyST](https://mystmd.org) docs, delivered as
a single `anywidget` plugin **plus** a pair of CI composite actions that
reconstruct the whole versioned docs site from durable sources every deploy and
publish it directly to GitHub Pages.

## Repo layout

```
plugins/version-switcher.mjs                   # MyST directive + anywidget runtime (single file, no README — docs are in docs/)
current-version/action.yml                     # pre-build: sanitise ref → version token (BASE_URL sub-path)
assemble/action.yml                            # post-build: gather all versions, write switcher.json + redirect, output site dir
lib/assemble.mjs                               # dependency-free Node kernel shared by both actions (sanitize / generate)
scripts/migrate.sh                             # one-shot operator gh-pages → durable-source migration (bash)
test/                                          # npm test suite (node, no framework)
docs/                                          # this repo's own docs (dogfoods the plugin)
.github/workflows/ci.yml                       # orchestrator → _lint / _test / _docs / _release
```

## Two halves, different lifecycles

| half | file | how consumers use it |
|------|------|----------------------|
| Plugin (widget) | `plugins/version-switcher.mjs` | release-asset URL in `myst.yml` `plugins` |
| Site actions | `current-version/`, `assemble/` | `uses: DiamondLightSource/myst-version-switcher-plugin/{current-version,assemble}@<tag>` |

One `vX.Y.Z` tag versions both. The plugin is published as a GitHub Release asset
(alongside the tag's `docs.zip`); the actions are consumed from the repo tree at
the same tag.

## Key design decisions

See [`DESIGN.md`](DESIGN.md) for the full rationale. In short:

### Reconstruct from durable sources, publish the whole tree
Every deploy rebuilds the **complete** site from authoritative inputs — this
build, each release's `docs.zip` asset, recent branch CI artifacts — and deploys
it as the *entire* Pages site via `upload-pages-artifact` + `deploy-pages` (no
`gh-pages` branch; Pages source = "GitHub Actions"). A version that is no longer
gathered (e.g. a deleted branch) is correctly dropped — no `keep_files` drift.
The **caller** owns the Pages publish because `deploy-pages` is job-scoped.

### Two actions around the build
`current-version` (before the build) sanitises the ref into the version token so
`BASE_URL` can be set; `assemble` (after) gathers + generates + uploads the `docs`
artifact + outputs the site dir. Both share one `sanitize()` in `lib/assemble.mjs`, so
the `BASE_URL` sub-path and the `site/<version>` dir name can never drift. Bash
does the `gh`/`unzip`/`mv` IO (incl. the dumb branch-preview fetch); the JS kernel
does the pure logic (`sanitize`, `generate`, and the folded-in `missingRequired`
guard) and is unit-tested without git/network/fs.

### BASE_URL must be set before `myst build`
```yaml
env:
  BASE_URL: /<repo>/$DOCS_VERSION
run: cd docs && myst build --html
```
Without this, assets and links break under the versioned GitHub Pages sub-path.

### `assemble` degrades gracefully on first deploy
With no releases and no other branches, `assemble` produces a single-entry
`switcher.json` for the current build and an `index.html` redirecting to it,
rather than failing. The "preferred" version (the redirect target, flagged
`preferred: true` in switcher.json, rendered with a ★) is the newest deployed
non-prerelease tag, falling back to `main`/`master`. Prerelease detection mirrors
`_release.yml` (an `a`/`b`/`rc` marker).

### `stable/` alias
When a non-prerelease release is deployed, the site serves a `stable/` symlink
(inflated to a real copy by `upload-pages-artifact`'s `--dereference`) to the
newest release, and the root redirect targets the constant `stable/` URL — a
stable inventory URL for cross-project `objects.inv`. `switcher.json` has no
`stable` entry; the widget maps a `…/stable/` page back to the concrete release.

## CI structure

- `ci.yml` — orchestrator; triggers on push (all branches) + tags + PRs, with a per-job `if` that skips bare upstream non-default-branch pushes (so they don't double-run with the PR)
- `_lint.yml` — biome
- `_test.yml` — `npm test`
- `_docs.yml` — build + deploy to Pages (see below)
- `_release.yml` — publishes `version-switcher.mjs` + `docs.zip` as Release assets (tag-only)

### `_docs.yml`
Split into a **build** job (checkout `fetch-depth: 0` → `current-version` →
`myst build` with `BASE_URL` → `assemble` → `upload-pages-artifact`) and a
**deploy** job (`deploy-pages`, carrying the `github-pages` environment +
`pages`/`id-token` perms + `concurrency`). The build job always assembles (so PRs
verify the site + upload their branch's `docs` artifact); only **deploy** runs
(`if: github.event_name == 'push'`) and only it enters the environment, so PR
builds aren't gated by its deployment-branch protection. Which events reach the
docs job is gated in `ci.yml` (`event=='pull_request' || tag || main || repository
!= UPSTREAM`) so a bare upstream branch push is inert. Net: PRs build+verify (no
publish); main/tag pushes → upstream Pages; a fork's own push → the fork's Pages
(see DESIGN "External-PR previews").

`assemble` packs the build into a `docs.zip` (bare `html/` root) and uploads it
verbatim as the `docs` artifact; `_release.yml` attaches that same file as the
release asset (no repack) — the durable source `assemble` reconstructs that
release from. Branch previews gather + unzip the same artifact.

`mystmd` is pinned at `1.10.1` (not `latest`).

## Developing

```bash
npm test                    # run the test suite
npm run docs                # build docs (same command CI uses)
npm run docs-dev            # live-preview docs with the plugin loaded from local plugins/
```

`docs/myst.yml` loads the plugin from `../plugins/version-switcher.mjs`
(not a release URL), so edits are reflected on rebuild.

**Browser caveat:** `<select>` popups don't open in VS Code Simple Browser. Open the
forwarded port in a real browser and hard-reload (MyST caches the localized esm).

## Releasing

```bash
git tag vX.Y.Z && git push origin vX.Y.Z
```

CI runs lint + tests + docs deploy, then `_release.yml` creates a GitHub Release
with `version-switcher.mjs` and the tag's `docs.zip` as assets. The plugin URL and
both actions reference the same tag.

## Consuming this in another repo

Pin `<tag>` in three places (with copier, one Jinja variable fills all):

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

Set the repo's **Pages source to "GitHub Actions"**, then a build + deploy job
pair (`current-version` → `myst build` with `BASE_URL` → `assemble` →
`upload-pages-artifact` → `deploy-pages`). See the full snippet in
[`DESIGN.md`](DESIGN.md) "What stays in the caller workflow" and `docs/index.md`.
Attach each tag's built docs as a `docs.zip` Release asset (bare `html/` root) so
`assemble` can reconstruct released versions.

## Upstreaming

`plugins/version-switcher.mjs` follows
[`jupyter-book/myst-plugins`](https://github.com/jupyter-book/myst-plugins)
conventions (single self-contained `.mjs`, distributed as a release asset) so it
can later be contributed there. The `current-version/` + `assemble/` producers are
DLS deployment infrastructure and stay here.

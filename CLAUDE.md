# myst-version-switcher-plugin

A pydata-style version-switcher for [MyST](https://mystmd.org) docs, delivered as
a single `anywidget` plugin **plus** reusable CI workflows (`docs.yml` to build,
`publish.yml` to reconstruct the whole versioned site from durable sources and
deploy it to GitHub Pages). The site-reconstruction logic (`assemble/`) is internal
to `publish.yml`, not a separately consumed action.

## Repo layout

```
plugins/version-switcher.mjs                   # MyST directive + anywidget runtime (single file, no README — docs are in docs/)
assemble/assemble.mjs                          # INTERNAL: dependency-free Node kernel for the engine's "Select releases" + "Generate" steps
scripts/migrate.sh                             # operator gh-pages → durable-source migration (bash); two-phase: reversible cutover, then guarded --delete-gh-pages
test/                                          # npm test suite (node, no framework) + test/workflow-harness/ (python: loads publish.yml's gather steps out of the YAML and runs them against a mock gh)
docs/                                          # this repo's own docs (dogfoods the plugin)
.github/workflows/docs.yml                     # PUBLIC reusable: build at the versioned BASE_URL → pack docs.zip → upload `docs` artifact (workflow_call; build-command input)
.github/workflows/publish-gh-pages.yml         # PUBLIC reusable ENGINE (PRIVILEGED): ONE `deploy` job — gather+extract inline bash + assemble.mjs@job.workflow_sha + Pages + verify. workflow_call ONLY. No event branching left: the caller has already gated on success + non-fork
.github/workflows/publish.yml                  # PUBLIC: the file each consumer carries. workflow_run (their CI completing, matched by NAME) + workflow_dispatch (fork-PR preview via `pr`, manual re-deploy) → publish-gh-pages.yml. The one place <tag> is pinned
.github/workflows/release.yml                  # PUBLIC reusable: attach the run's build artifacts (docs.zip; + version-switcher.mjs via _test.yml) to the tag's GitHub Release via gh (create-or-upload, immutable-safe). Consumers `uses:` it directly
.github/workflows/ci.yml                       # this repo's own entry: _lint / _test / docs.yml / release. Does NOT publish — publish.yml picks the run up on workflow_run. Its `name: CI` is load-bearing (publish.yml matches on it)
```

## Two halves, different lifecycles

| half | file | how consumers use it |
|------|------|----------------------|
| Plugin (widget) | `plugins/version-switcher.mjs` | release-asset URL in `myst.yml` `plugins` |
| Reusable CI workflows | `.github/workflows/{docs,publish}.yml` | `uses: DiamondLightSource/myst-version-switcher-plugin/.github/workflows/{docs,publish}.yml@<tag>` in their `ci.yml` |

One `vX.Y.Z` tag versions both. The plugin is published as a GitHub Release asset
(alongside the tag's `docs.zip`); the workflows are consumed by `uses:` at the same
tag (and `publish.yml` self-checks-out `assemble.mjs` at that tag via
`job.workflow_sha`). `assemble/` is internal — consumed only by `publish.yml`, not a
public action.

## Key design decisions

See [`docs/explanations/architecture.md`](docs/explanations/architecture.md) for the
full rationale. In short:

### The default branch's durable copy lives in the Actions cache
Releases are durable (Release `docs.zip` assets) and PRs are ephemeral by design, but
the **default branch** has no permanent source — gathered from its latest CI artifact,
which expires, after which it drops out and the guard hard-fails. So each
default-branch deploy keeps a copy of its `docs.zip` in the Actions cache
(content-addressed key `mvs-default-v1-<sha>`, so an unchanged branch adds no entry),
and a deploy whose fresh artifact is gone restores from there.

This used to be published *into the site* at `_sources/<branch>.zip`. That was
permanent, but it shipped a multi-megabyte zip inside every Pages artifact forever on a
site already pressing the 1 GB cap (see "The site has a hard size ceiling"). The cache
is evicted after 7 days unread and by LRU past 10 GB, so a repo quiet for >1 week whose
main artifact ALSO expired loses the rung and hard-fails loudly — accepted trade.
`_sources` is no longer written; the READ survives as a deprecated one-shot rung so a
site last deployed by an older `publish.yml` still has a source on its first upgraded
deploy (fetched from `$PAGES_URL` — the live Pages URL from the Pages API, so custom
domains work; the same URL roots the `switcher.json` entries).

Before the branch ever builds docs (mid gh-pages migration) a final rung reads a
**published seed release** (`pages-default-seed`, created by `scripts/migrate.sh` from
the old gh-pages `<default>/` tree) — so a repo can cut over to the reusable workflow in
one PR, before `docs→main`. Drafts can't be used: a `contents:read` deploy token can't
read them (verified), so the seed is a published release on a sentinel tag, deleted at
finalize. `migrate.sh --delete-gh-pages`'s guard now requires the default branch to be
live in the new site AND to have a non-expired `docs` artifact of its own (it used to
probe `_sources/<default>.zip`, which passed even while the content came from the seed
— i.e. while gh-pages was still the only real copy).

### The site has a hard size ceiling — cap the releases
`upload-pages-artifact` tars the WHOLE site into one artifact and Pages rejects it over
**1 GB**. blueapi at 131 released `docs.zip`s was at 452 MB, +~5 MB/release: a few years
from deploys simply failing, silently, with no warning on the way. The engine takes
**`max-releases`** (default `0` = unlimited, so upgrading never silently deletes
versions); the tutorial ships `20`. Set it as a LITERAL in `publish.yml`'s `with:` —
that is the single caller on every path, so a literal there can't be bypassed by a
manual dispatch. A deploy past 700 MB warns — measured on
the PACKED artifact (the cap is on the gzipped tar; this repo's site is 734 MiB on disk
and 223 MiB deployed, so `du` would cry wolf at a third of real usage). The tree is only
packed to measure once it exceeds `SIZE_PROBE_BYTES`, since packing costs seconds; `tar
-ch` matches upload-pages-artifact's `--dereference`, which inflates `stable/` into a
full copy.

Selection is `assemble.mjs`'s `selectReleases` (pure, unit-tested; it replaced an
untested bash `case`), ranked by **`created_at`** — NOT `published_at`, which lies when
an old release is re-published (blueapi's `1.3.2-a9`: created 2025-10, published
2026-07, and under `published_at` it outranked the newer `1.11.3`). No version-number
parsing: tags are too inconsistent across repos. The seed release is exempt from the cap.
`getSortedTags()`/`orderVersions()` are untouched — that's switcher DISPLAY order, a
separate concern.

### The gather is cached, indexed and parallel
The deploy's cost is O(whole site), not O(the change) — identical work whatever fired
it. On blueapi that was 654 s against a 27–45 s docs build. Fixed by: an `actions/cache`
entry of release zips keyed on the exact set of asset ids to publish (assets are
immutable; files named by ASSET ID so a re-cut release can't serve stale bytes; pruned to
the published set), the artifacts API paginated ONCE and indexed newest-per-head-SHA
(it was re-paginated per open PR — 27× for blueapi, ~175 s), and parallel downloads
(`xargs -P 8`). **Caches are saved only on the default branch**: a cache written on a PR
ref is scoped to that PR and unreadable elsewhere.

### Reconstruct from durable sources, publish the whole tree
Every deploy rebuilds the **complete** site from authoritative inputs — `main`'s
latest build, each release's `docs.zip` asset, every open PR's build artifact — and
deploys it as the *entire* Pages site via `upload-pages-artifact` + `deploy-pages`
(no `gh-pages` branch; Pages source = "GitHub Actions"). A version no longer
gathered (a merged/closed PR, a deleted release) is correctly dropped — no
`keep_files` drift. The **publish workflow** owns the Pages publish because
`deploy-pages` is job-scoped.

### Split build (unprivileged) from publish (privileged); publish LISTENS
`ci.yml` builds + uploads the `docs` artifact for every event including fork PRs, and
never publishes. `publish.yml` (in each consumer's repo; this repo carries an identical
one) triggers on **`workflow_run`** when their CI workflow completes — matched by its
`name:`, not filename — and calls the `publish-gh-pages.yml` engine. It also takes
`workflow_dispatch` for fork-PR previews (`pr`) and manual re-deploys.

Publish used to be a job nested in `ci.yml`, for status visibility on the PR. That was
wrong twice over: reconstructing the site is **O(the whole site)** and independent of the
change, so it put a large constant on every PR's critical path (blueapi switched PR
previews off one day after adopting, a 654s deploy on a 40s build); and a wedged Pages
origin is not the PR author's to fix, so the red check was noise.

**The trigger change was SUBTRACTION.** Proven live 2026-08-21 (see
[[pages-origin-wedge]]): `workflow_run` forces a Pages re-serve at an already-deployed
SHA exactly as `workflow_dispatch` does — four consecutive deploys at identical
`pages_build_version b24237484c3b445469c2db4ef161410a185fcdbc` all updated the origin. So:
- the **tag re-dispatch trampoline** is gone (a tag's deploy re-serves directly);
- **`publish-dispatch.yml`** is gone — it existed ONLY because a reusable workflow can't
  be `workflow_dispatch`'d cross-repo, so the trampoline needed a local file to re-fire;
- the **`version-name` injection** is gone: `workflow_run` fires after the triggering run
  COMPLETED, so its `docs` artifact is discoverable by the ordinary gather (verified — both
  injection steps skipped and the site still assembled);
- the **`warn` job**, `retry-until` and the wedged-origin retry-dispatch are gone, and the
  engine no longer needs `actions: write`.

### THE workflow_run TRAP: `github.ref` is always the default branch
In a `workflow_run` run `GITHUB_SHA` and `github.ref` are **always the default branch's
HEAD**, never the built commit (a PR-triggered deploy reports `refs/heads/main`). Anything
asking "was this the default branch?" must read `github.event.workflow_run.head_branch`.
Both cache-save steps got this wrong initially — gating on `github.ref` would have every
PR-triggered deploy writing caches scoped to a PR nothing can read.

`test/workflow-harness/test_shape.py` asserts this, plus the caller's two guards
(`conclusion == 'success'`, `head_repository == this repo`). All three **fail OPEN**, and
they live in `if:` expressions the gather harness can't reach.

**The fork guard is not optional:** `workflow_run` runs with a WRITE token even when a
fork's PR triggered it (pwn-request). Fork builds reach the site only via a maintainer
dispatching `publish.yml` with `pr`, which pins approval to that head SHA.

### Self-referencing assemble.mjs (no separate action)
`publish.yml` sparse-checks-out **this** repo's `assemble/` at `job.workflow_repository`
+ `job.workflow_sha` — the `job` context resolves to the file that defines the running
job, i.e. the *reusable* workflow (unlike `github.workflow_*`, which resolve to the
*caller's* entry workflow). So a consumer pinning `publish-gh-pages.yml@vX` gets
`assemble.mjs@vX` automatically, with no hardcoded repo and no release-time bump,
and this repo's own publish job tests the working-tree script (no dogfood gap). The
consumer's repo stays checked out at the root so `assemble.mjs`'s `git tag` lists
*their* versions; `assemble.mjs` runs from `.mvs`. (`uses:` can't take an expression,
so a composite action could only be pinned to a literal tag — the `job` context is
the only way to self-reference at the running ref.) Note: actionlint's `job`-context
schema is stale and false-flags `job.workflow_sha`/`job.workflow_repository`; the
GitHub docs confirm both, so `_lint.yml` runs actionlint with exactly those two
suppressed (`-ignore 'property "workflow_(repository|sha)" is not defined'`).

### BASE_URL must be set before `myst build`
```yaml
env:
  BASE_URL: /<repo>/<version-name>   # version-name = pr-<n> | main | <tag>
run: cd docs && myst build --html
```
Without this, assets and links break under the versioned GitHub Pages sub-path. The
version name is computed in `docs.yml` and is exactly the `site/<version-name>` dir
`assemble` files this build's artifact at, so the two cannot drift.

### `assemble` degrades gracefully on first deploy
With no releases and no other branches, `assemble` produces a single-entry
`switcher.json` for the current build and an `index.html` redirecting to it,
rather than failing. The "preferred" version (the redirect target, flagged
`preferred: true` in switcher.json, rendered with a ★) is the newest deployed
non-prerelease tag, falling back to `main`/`master`. Prerelease detection mirrors
`release.yml` (an `a`/`b`/`rc` marker following a digit, PEP 440 style — so
`1.0a1`/`2.0rc1` are prereleases but `release-1.0` is not).

### `stable/` alias
When a non-prerelease release is deployed, the site serves a `stable/` symlink
(inflated to a real copy by `upload-pages-artifact`'s `--dereference`) to the
newest release, and the root redirect targets the constant `stable/` URL — a
stable inventory URL for cross-project `objects.inv`. `switcher.json` has no
`stable` entry; the widget maps a `…/stable/` page back to the concrete release.

## CI structure

Two top-level workflows: `ci.yml` builds, `publish.yml` listens for it finishing.

- `ci.yml` — **build + verify only; never publishes.** Triggers on `pull_request` +
  push to `main`/tags (no other-branch pushes; `*` excludes `/`-tags). Orchestrates
  `_lint` / `_test` / `docs` / `release`, runs for forks, uploads the `docs` artifact.
  Needs no elevated permissions. Its `name: CI` is **load-bearing** — `publish.yml`'s
  `workflow_run` matches workflows by name, not filename, so renaming it silently stops
  publishing.
- `publish.yml` — **the file each consumer carries**, and the one place `<tag>` is
  pinned. `workflow_run` (CI completing) + `workflow_dispatch` (fork-PR preview via `pr`,
  manual re-deploy) → `publish-gh-pages.yml`. Its job `if:` carries the two guards that
  fail open (`conclusion == 'success'`, `head_repository == this repo`) and a
  `max-releases` literal. This repo's copy is identical to a consumer's but for the
  `uses:` path (local vs pinned) and `max-releases: "0"` vs the tutorial's `"20"` — our
  site is ~223 MB packed across 24 releases, a fifth of the cap.
- `publish-gh-pages.yml` — **assemble + deploy ENGINE, privileged.** `workflow_call`
  ONLY. **One** job, `deploy`: sparse-checks out `assemble.mjs` at `job.workflow_sha` so
  it matches the pinned ref (see "Self-referencing assemble.mjs"), runs inline
  gather + extract, then `assemble.mjs generate`, `upload-pages-artifact`,
  `deploy-pages` and the origin verify — carrying the `github-pages` environment, perms,
  and `concurrency: {group: pages, cancel-in-progress: true}`. No event branching: the
  caller already established success + non-fork. Inputs are just `pr` and `max-releases`.

Sub-workflows of `ci.yml`:
- `_lint.yml` — biome
- `_test.yml` — `npm test`
- `docs.yml` — **reusable build, parameterised for cross-repo reuse.** Compute the
  version name (`pr-<n>` / default-branch / tag) → run `build-command` (required
  input) with `BASE_URL` + `VERSION_NAME` set (the latter for builds that need the
  bare token, e.g. a Sphinx conf.py setting pydata's switcher `version_match`) →
  pack `docs.zip` (single root dir `html/`, staged so any `html-dir` works) → upload the `docs`
  artifact. No deploy; `contents: read` only (the fork-PR hint lives in publish.yml's
  `warn` job). Installs uv unconditionally and relies on the runner's
  preinstalled Node, so `build-command` can be `make docs` / `npx … myst build` /
  `tox -e docs` regardless of project. This repo passes `npm ci && npm run docs`. It
  OWNS the build↔publish contract (version name, BASE_URL, docs.zip's single root
  dir, `docs` artifact name — publish.yml gathers cross-run artifacts by that NAME via
  the artifacts API, never by workflow filename) so consumers only choose a command.
- `release.yml` — **PUBLIC reusable, tag-only.** Downloads every artifact in the run
  and attaches them to the tag's GitHub Release via `gh` — `gh release create` if no
  Release exists yet (draft→upload→publish atomically, so immutable-safe), else
  `gh release upload --clobber` to an existing (UI-published, mutable) Release. No
  third-party action. For this repo the artifacts are the tag's `docs.zip` (the `docs`
  artifact, verbatim) + `version-switcher.mjs` (uploaded by `_test.yml` as an artifact,
  so the generic workflow needs no plugin-specific step). Consumers `uses:` it directly.

**Publish flow.** `ci.yml` builds and stops. When that run *completes*, `publish.yml`
fires on `workflow_run` and calls the engine, which gathers `main`, the newest
`max-releases` releases, and every open PR's artifact from durable sources, then deploys
the whole site. Same path for every event — a PR, a `main` push and a tag all just
produce a completed CI run. A **tag** additionally has `release.yml` attach its
`docs.zip` first, within that same CI run, so by the time publish gathers, the asset is
already there (this is why the old tag/asset race is gone rather than fixed). An
**external fork PR** is excluded by the caller's guard and never deploys; a maintainer
dispatches `publish.yml` with the PR number (`pr`), which sets a `preview-approved`
commit status pinned to that **head SHA** — so a later push to the PR drops the preview
until re-approved. `assemble` gathers an open PR's artifact via its head SHA; internal
PRs always, fork PRs only when the SHA carries that status.

`mystmd` is pinned at `1.10.1` (not `latest`).

## Developing

```bash
npm test                    # run the unit tests
npm run test:workflows      # gather steps against a mock gh + workflow shape asserts (needs uv)
npm run docs                # build docs (same command CI uses)
npm run docs-dev            # live-preview docs with the plugin loaded from local plugins/
```

`docs/myst.yml` loads the plugin from `../plugins/version-switcher.mjs`
(not a release URL), so edits are reflected on rebuild.

**Browser caveat:** `<select>` popups don't open in VS Code Simple Browser. Open the
forwarded port in a real browser and hard-reload (MyST caches the localized esm).

## Releasing

Releasing is a tag push (immutable releases rule out the UI "publish release" flow for
attaching assets). Tag the merged commit on `origin/main` directly — you're usually on a
feature branch, so tag `origin/main` rather than your branch HEAD:

```bash
git fetch origin
git tag vX.Y.Z origin/main
git push origin --tags   # or: git push origin vX.Y.Z to push just this tag
```

CI runs lint + tests + docs build, then `release.yml` creates the GitHub Release with
`version-switcher.mjs` + the tag's `docs.zip` attached (via `gh`). When that CI run
completes, `publish.yml` fires on `workflow_run` and reconstructs + deploys the site
including the new tag — the release asset is already attached by then, because
`release.yml` ran inside the CI run publish is waiting on. The plugin URL and the
`uses:` refs for `docs.yml`/`release.yml`/`publish-gh-pages.yml` all resolve to the
same tag.

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

Set the repo's **Pages source to "GitHub Actions"**, then add a `ci.yml` that builds:

```yaml
jobs:
  docs:
    uses: DiamondLightSource/myst-version-switcher-plugin/.github/workflows/docs.yml@<tag>
    with:
      build-command: make docs        # or: tox -e docs / npx … myst build / npm ci && npm run docs
  release:                            # tag-only; attaches docs.zip to the Release
    needs: [docs]
    if: github.ref_type == 'tag'
    uses: DiamondLightSource/myst-version-switcher-plugin/.github/workflows/release.yml@<tag>
    permissions: { contents: write }
```

…and a **separate** `publish.yml` that listens for it:

```yaml
on:
  workflow_run: { workflows: [CI], types: [completed] }   # matches ci.yml's `name:`
  workflow_dispatch: { inputs: { pr: { required: false, default: "" } } }
jobs:
  publish:
    if: >-
      github.event_name == 'workflow_dispatch' ||
      (github.event.workflow_run.conclusion == 'success' &&
       github.event.workflow_run.head_repository.full_name == github.repository)
    uses: DiamondLightSource/myst-version-switcher-plugin/.github/workflows/publish-gh-pages.yml@<tag>
    with: { max-releases: "20" }
    permissions: { pages: write, id-token: write, contents: read, actions: read, statuses: write }
```

`ci.yml` has **no** publish job. Copy `publish.yml` verbatim from the
[tutorial](docs/tutorials/adding-to-a-fresh-repo.md) rather than hand-rolling it — both
`if:` guards fail OPEN, and `workflows: [CI]` matches the entry workflow by NAME, so
renaming it silently stops publishing.

## Upstreaming

`plugins/version-switcher.mjs` follows
[`jupyter-book/myst-plugins`](https://github.com/jupyter-book/myst-plugins)
conventions (single self-contained `.mjs`, distributed as a release asset) so it
can later be contributed there. The `assemble/` producer is DLS deployment
infrastructure and stays here.

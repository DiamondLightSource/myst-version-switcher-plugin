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

The alternative — publishing it *into the site* at `_sources/<branch>.zip` — is
permanent, but ships a multi-megabyte zip inside every Pages artifact forever on a site
already pressing the 1 GB cap (see "The site has a hard size ceiling"). The cache is
evicted after 7 days unread and by LRU past 10 GB, so a repo quiet for >1 week whose
main artifact ALSO expired loses the rung and hard-fails loudly — accepted trade.
`_sources` is gone entirely (no write, no read fallback). `$PAGES_URL` — the live Pages
URL from the Pages API, so custom domains work — now only roots the `switcher.json`
entries.

Before the branch ever builds docs (mid gh-pages migration) a final rung reads a
**published seed release** (`pages-default-seed`, created by `scripts/migrate.sh` from
the old gh-pages `<default>/` tree) — so a repo can cut over to the reusable workflow in
one PR, before `docs→main`. Drafts can't be used: a `contents:read` deploy token can't
read them (verified), so the seed is a published release on a sentinel tag, deleted at
finalize. `migrate.sh --delete-gh-pages`'s guard requires the default branch to be live
in the new site AND to have a non-expired `docs` artifact of its own — being live alone
is still satisfied while the content comes from the seed, i.e. while gh-pages is the only
real copy.

### The site has a hard size ceiling — cap the releases and PRs
`upload-pages-artifact` tars the WHOLE site into one artifact and Pages rejects it over
**1 GB**. blueapi at 131 released `docs.zip`s was at 452 MB, +~5 MB/release. The engine
takes **`max-releases`** and **`max-prs`** (both default `0` = unlimited, so upgrading
never silently deletes versions); the paved path ships `30`/`20`, and this repo's
`publish.yml` is now IDENTICAL to a consumer's but for the `uses:` path. Set them as
LITERALS in `publish.yml`'s `with:` — that is the single caller on every path, so a
literal there can't be bypassed by a manual dispatch. The caps also bound the release-zip
cache entry, which competes with the repo's other caches for a 10 GB quota (blueapi is at
7.5 GB of 62 caches before adopting; an uncapped entry there would be 458 MB per release
set).

There is NO size guard in the workflow. `actions/deploy-pages` already compares the
uploaded artifact against 1 GB and warns (`ONE_GIGABYTE` in `src/internal/deployment.js`,
reading the artifact's stored/compressed size), so packing the tree to re-measure it was
duplicated work with a worse number. The engine just reports `du -shL` of the assembled
tree — with -L, and AFTER the `stable/` symlink exists, because upload-pages-artifact
dereferences it and the newest release is therefore uploaded twice; the recovery — lower the caps, re-run, nothing is deleted — lives in
docs/how-to/keep-the-site-small.md and in the tutorial's copy-paste `publish.yml`.

Selection is `assemble.mjs`'s `selectReleases` (pure, unit-tested), ranked by
**`created_at`** — NOT `published_at`, which lies when
an old release is re-published (blueapi's `1.3.2-a9`: created 2025-10, published
2026-07, and under `published_at` it outranked the newer `1.11.3`). No version-number
parsing: tags are too inconsistent across repos. The seed release is exempt from the cap.
`getSortedTags()`/`orderVersions()` are untouched — that's switcher DISPLAY order, a
separate concern.

### The gather is cached and indexed
The deploy's cost is O(whole site), not O(the change) — identical work whatever fired
it. On blueapi that was 654 s against a 27–45 s docs build. Fixed by: an `actions/cache`
entry of release zips keyed on the exact set of asset ids to publish (assets are
immutable; files named by ASSET ID so a re-cut release can't serve stale bytes; pruned to
the published set), and the artifacts API paginated ONCE and indexed newest-per-head-SHA
(it was re-paginated per open PR — 27× for blueapi, ~175 s). **Caches are saved only when
the default branch was BUILT**: entries are scoped to the writing ref, so one written by a
deploy dispatched from another ref is unreadable by every ordinary deploy.

The gather's two selection steps are IO-only: they call `gh`, then hand the payloads to
`assemble.mjs`. `select-artifacts` decides the default-branch artifact and the PR
previews; `select-releases` decides the releases. Both rank with the SAME comparator
(`byDateDesc`), which is why the caps can't drift on tie-breaks — they did: the old inline
bash used `sort -r`, keeping PR #9 over #10, while releases kept `1.10` over `1.9`.

`select-artifacts` carries a security boundary: the default branch is the newest artifact
matching `head_branch == DEFAULT && head_repository_id == <this repo>`, and it uses THAT
artifact — never a re-lookup by head SHA, which is how the old bash did it and which could
return a fork's artifact for the same commit (a fork's `pull_request` run executes in the
UPSTREAM repo's Actions, so its artifacts are listed here). PR lookups deliberately have
no repo filter — a fork PR's artifact belongs to the fork, and `preview-approved` is the
gate.

`select-releases` writes the decision TSV to `--out` and prints the release-zip
**cache key on stdout** (`cacheKey()` + `RELZIPS_CACHE_PREFIX`, both unit-tested): the key
is a digest of the selection, so it is derived where the selection is made rather than by
re-deriving it with `awk`/`sha256sum` in the workflow. The workflow also emits
`cache-prefix` (the bare namespace) so `restore-keys` doesn't repeat the literal.

**Neither key holds a branch or a commit.** The branch is already the cache's SCOPE (all
entries here read `refs/heads/main`). Both keys are CONTENT hashes: `mvs-relzips-v1-<sha256
of the sorted asset-id set>` and `mvs-default-v1-<sha256 of docs.zip's bytes>`. A commit
SHA would mint a fresh multi-MB entry on every push even when the docs are byte-identical.
Consequence: the default-branch RESTORE can't name its key (you don't know the hash until
you have the content), so `key:` is the bare prefix `mvs-default-v1-` — which can never
match exactly — and `restore-keys` returns the newest entry. That looks like a bug; it
isn't.

**Release downloads are SERIAL; PR-artifact downloads are PARALLEL** (`xargs -P 8`), and
the asymmetry is deliberate. With the cache the release gather fetches 0–1 zips on almost
every deploy (measured here: 0–2 s warm), so parallelising it bought only a rare cold
start in exchange for a three-pass download-and-stage structure. PR artifacts can never be
cached — a head SHA changes on every push — so that gather pays 1 + open-PR downloads on
EVERY deploy (~0.8 s each; 27 of them at blueapi scale).

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

### The version name is computed twice, never passed
`docs.yml` derives `pr-<n>` / the ref name for `BASE_URL`; the gather independently
derives the same string for each source's `site/<dir>` (a release's tag, a PR's number,
the repo's `default_branch`). Nothing is threaded between them — `docs.yml` has no
`version-name` output any more (it existed only for the deleted injection step). The two
rules must change together.

The name is now VALIDATED (`[A-Za-z0-9._-]`, non-empty) rather than assumed clean: it is
clean by construction HERE, but docs.yml is reusable and a consumer can trigger it on any
ref, and git allows `$( )` and backticks in a ref name. Related invariant, enforced by
`test_shape.py` across every workflow: **no `${{ }}` inside any `run:` body** — context
values come through `env:` only.

### The PR gets a link, never a red check
A successful deploy posts a `docs-preview` commit status on
`workflow_run.head_sha` (or, for a dispatched fork preview, the SHA the Approve step
pinned) with the published URL as `target_url`. `if: success()` plus `state=success` only:
the whole reason publishing moved off the PR's critical path is that a wedged Pages origin
is not the author's to fix, so a status that could go red would undo it. The step also
fails CLOSED — no `site/<dest>` dir, no status — rather than posting a 404 link.
`test_shape.py` asserts both properties.

### THE workflow_run TRAP: `github.ref` is always the default branch
In a `workflow_run` run `GITHUB_SHA` and `github.ref` are **always the default branch's
HEAD**, never the built commit (a PR-triggered deploy reports `refs/heads/main`). Anything
asking "was this the default branch?" must read `github.event.workflow_run.head_branch`.
Both cache-save steps ask this question — gated on `github.ref` they would fire on every
deploy, including one dispatched from a non-default ref, whose entry only that ref can
read.

`test/workflow-harness/test_shape.py` asserts this, plus the caller's two guards
(`conclusion == 'success'`, `head_repository == this repo`). All three **fail OPEN**, and
they live in `if:` expressions the gather harness can't reach.

**The fork guard is not optional:** `workflow_run` runs with a WRITE token even when a
fork's PR triggered it (pwn-request). Fork builds reach the site only via a maintainer
dispatching `publish.yml` with `pr`, which pins approval to that head SHA.

### PR previews are IN the public switcher — deliberately
`switcherStruct` maps every discovered dir, `pr-<n>` included, so open PR numbers show in
the dropdown of the live site. That is intended (a reviewer can jump to a preview from any
page), not an oversight — don't "fix" it without asking.

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
version name is computed in `docs.yml` and re-derived identically by the gather as the
`site/<version-name>` dir — see "The version name is computed twice, never passed".

The `/<repo>` half is `docs.yml`'s **`base-path`** input (default: `/<repo>`). A custom
domain or an `ORG.github.io` repo serves at the ROOT, so those pass `base-path: "/"` —
otherwise switcher.json (which takes its URLs from the Pages API, and so follows the
CNAME automatically) would be right while every page it links to 404s its assets.

### `assemble` degrades gracefully on first deploy
With no releases and no other branches, `assemble` produces a single-entry
`switcher.json` for the current build and an `index.html` redirecting to it,
rather than failing. The "preferred" version (the redirect target, flagged
`preferred: true` in switcher.json, rendered with a ★) is the newest deployed
non-prerelease tag, falling back to the default branch (threaded in as
`generate --default-branch`, so it need not be `main`/`master`). Prerelease detection
mirrors `release.yml` — one marker list (`MARKERS`) covering PEP 440 and hyphenated
semver, following a digit with an optional separator, so `1.0a1`/`2.0rc1`/`1.1.0-beta.1`
are prereleases while `release-1.0` and `1.0-candidate` are not. The two implementations
are held together by `test/workflow-harness/test_release_prerelease.py`, not by comment.
Tag ORDER is `compareTags`, not `git tag --sort=-v:refname`, which ranks a hyphenated
prerelease above its own release.

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
  fail open (`conclusion == 'success'`, `head_repository == this repo`) and the
  `max-releases`/`max-prs` literals. This repo's copy is identical to a consumer's but
  for the `uses:` path (local vs pinned) — same `30`/`20` caps, so the file people copy
  is the file that is actually exercised.
- `publish-gh-pages.yml` — **assemble + deploy ENGINE, privileged.** `workflow_call`
  ONLY. **One** job, `deploy`: sparse-checks out `assemble.mjs` at `job.workflow_sha` so
  it matches the pinned ref (see "Self-referencing assemble.mjs"), runs inline
  gather + extract, then `assemble.mjs generate`, `upload-pages-artifact`,
  `deploy-pages` and the origin verify (which polls `site/deploy-id.txt`, a per-deploy
  stamp — `switcher.json` alone can't detect a wedge, since it is byte-identical whenever
  the version set is unchanged) — carrying the `github-pages` environment, perms,
  and `concurrency: {group: pages, cancel-in-progress: false}` — a superseded deploy is
  QUEUED, never killed mid-`deploy-pages`. No event branching: the
  caller already established success + non-fork. Inputs are `pr`, `max-releases` and
  `max-prs`.

Sub-workflows of `ci.yml`:
- `_lint.yml` — biome
- `_test.yml` — `npm test`
- `docs.yml` — **reusable build, parameterised for cross-repo reuse.** Compute the
  version name (`pr-<n>` / default-branch / tag) and `BASE_URL` (from `base-path`) →
  run `build-command` (required input) with `BASE_URL` + `VERSION_NAME` set (the latter for builds that need the
  bare token, e.g. a Sphinx conf.py setting pydata's switcher `version_match`) →
  pack `docs.zip` (single root dir `html/`, staged so any `html-dir` works) → upload the `docs`
  artifact. No deploy; `contents: read` only. Installs uv unconditionally and relies on
  the runner's preinstalled Node, so `build-command` can be `make docs` /
  `npx … myst build` / `tox -e docs` regardless of project. This repo passes
  `npm ci && npm run docs`. It defines the build↔publish contract (version-name rule,
  BASE_URL, docs.zip's single root dir, `docs` artifact name — publish.yml gathers
  cross-run artifacts by that NAME via the artifacts API, never by workflow filename) so
  consumers only choose a command. It has no outputs: nothing is passed to publish.
- `release.yml` — **PUBLIC reusable, tag-only.** Downloads every artifact in the run
  and attaches them to the tag's GitHub Release via `gh` — `gh release create` if no
  Release exists yet (draft→upload→publish atomically, so immutable-safe), else
  `gh release upload --clobber` to an existing (UI-published, mutable) Release. No
  third-party action. For this repo the artifacts are the tag's `docs.zip` (the `docs`
  artifact, verbatim) + `version-switcher.mjs` (uploaded by `_test.yml` as an artifact,
  so the generic workflow needs no plugin-specific step). Consumers `uses:` it directly.

**Publish flow.** `ci.yml` builds and stops. When that run *completes*, `publish.yml`
fires on `workflow_run` and calls the engine, which gathers `main`, the newest
`max-releases` releases, and the newest `max-prs` open PRs' artifacts from durable
sources, then deploys the whole site. Same path for every event — a PR, a `main` push and a tag all just
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
    with: { pr: "${{ inputs.pr }}", max-releases: "30", max-prs: "20" }
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

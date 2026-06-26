# myst-version-switcher-plugin

A pydata-style version-switcher for [MyST](https://mystmd.org) docs, delivered as
a single `anywidget` plugin **plus** reusable CI workflows (`docs.yml` to build,
`publish.yml` to reconstruct the whole versioned site from durable sources and
deploy it to GitHub Pages). The site-reconstruction logic (`assemble/`) is internal
to `publish.yml`, not a separately consumed action.

## Repo layout

```
plugins/version-switcher.mjs                   # MyST directive + anywidget runtime (single file, no README — docs are in docs/)
assemble/assemble.sh                           # INTERNAL: reconstruct the whole site from durable sources (gh/unzip plumbing); run directly by publish.yml; runnable standalone for local testing
assemble/assemble.mjs                          # INTERNAL: dependency-free Node kernel behind assemble.sh (the `generate` subcommand)
scripts/migrate.sh                             # operator gh-pages → durable-source migration (bash); two-phase: reversible cutover, then guarded --delete-gh-pages
test/                                          # npm test suite (node, no framework)
docs/                                          # this repo's own docs (dogfoods the plugin)
.github/workflows/docs.yml                     # PUBLIC reusable: build at the versioned BASE_URL → pack docs.zip → upload `docs` artifact (workflow_call; build-command input)
.github/workflows/publish.yml                  # PUBLIC reusable ENGINE: run assemble/ (checked out at job.workflow_sha) + deploy to Pages (PRIVILEGED). workflow_call ONLY; its sole caller is publish-dispatch.yml
.github/workflows/publish-dispatch.yml         # PUBLIC wrapper around publish.yml: workflow_call (ci.yml's inline publish) + workflow_dispatch (tag trampoline + fork-PR opt-in + manual re-deploy). Dogfoods the wrapper consumers add
.github/workflows/ci.yml                       # this repo's own entry: _lint / _test / docs.yml / _release, then nests publish-dispatch.yml for internal non-tag events (tags trampoline via publish-tag → gh workflow run publish-dispatch.yml)
```

## Two halves, different lifecycles

| half | file | how consumers use it |
|------|------|----------------------|
| Plugin (widget) | `plugins/version-switcher.mjs` | release-asset URL in `myst.yml` `plugins` |
| Reusable CI workflows | `.github/workflows/{docs,publish}.yml` | `uses: DiamondLightSource/myst-version-switcher-plugin/.github/workflows/{docs,publish}.yml@<tag>` in their `ci.yml` |

One `vX.Y.Z` tag versions both. The plugin is published as a GitHub Release asset
(alongside the tag's `docs.zip`); the workflows are consumed by `uses:` at the same
tag (and `publish.yml` self-checks-out its `assemble/` scripts at that tag via
`job.workflow_sha`). `assemble/` is internal — consumed only by `publish.yml`, not a
public action.

## Key design decisions

See [`docs/explanation/architecture.md`](docs/explanation/architecture.md) for the
full rationale. In short:

### The default branch is self-durable in the site (`_sources/`)
Releases are durable (Release `docs.zip` assets) and PRs are ephemeral by design, but
the **default branch** had no permanent source — gathered from its latest CI artifact,
which expires, after which it drops out and the guard hard-fails. So each deploy
persists the default branch's `docs.zip` (the one it arrived as — current build,
gathered run, or the fallback — copied verbatim) into the published site at
`_sources/<branch>.zip` (excluded from version discovery), and a deploy whose fresh
artifact is gone restores the branch from that durable in-site copy (fetched from
`PAGES_URL`, default `https://<owner>.github.io/<repo>`). Before the branch ever builds
docs (mid gh-pages migration) a final rung reads a **published seed release**
(`pages-default-seed`, created by `scripts/migrate.sh` from the old gh-pages `<default>/`
tree) and persists it to `_sources` on that deploy — so a repo can cut over to the
reusable workflow in one PR, before `docs→main`. Drafts can't be used: a `contents:read`
deploy token can't read them (verified), so the seed is a published release on a
sentinel tag, deleted at finalize once `_sources/<default>.zip` is live.

### Reconstruct from durable sources, publish the whole tree
Every deploy rebuilds the **complete** site from authoritative inputs — `main`'s
latest build, each release's `docs.zip` asset, every open PR's build artifact — and
deploys it as the *entire* Pages site via `upload-pages-artifact` + `deploy-pages`
(no `gh-pages` branch; Pages source = "GitHub Actions"). A version no longer
gathered (a merged/closed PR, a deleted release) is correctly dropped — no
`keep_files` drift. The **publish workflow** owns the Pages publish because
`deploy-pages` is job-scoped.

### Split build (unprivileged) from publish (privileged), but nest publish for visibility
`ci.yml` builds + uploads the `docs` artifact for every event including fork PRs.
It then nests the privileged `publish.yml` (`workflow_call`) as a `publish` job —
but **only for internal, non-tag events** (an internal PR, or a push to main): the
job's `if` excludes fork PRs (`head.repo.full_name != github.repository`), whose
builds run with a read-only token and must never deploy. So publish status is
**visible on the PR/commit** for internal work, while untrusted fork-PR code still
never reaches a write token. A fork PR instead gets a warning step in `docs.yml`'s
build job that links the manual opt-in (`publish.yml`'s `workflow_dispatch`).
**Tags don't nest** — a tag shares the merge commit's SHA and GitHub Pages drops a
second same-SHA deploy unless it's a `workflow_dispatch` (deploy-pages#383), so the
`publish-tag` job re-triggers `publish.yml` via `workflow_dispatch` instead (see
the Publish flow below).

Because the inline publish runs **inside the build's own CI run**, the current build
isn't a *completed* successful run the gather can discover (and for a main push the
gather would find the *previous* build). So `ci.yml` passes `publish.yml` the build's
version name (`needs.docs.outputs.version-name`); `publish.yml` hands it to assemble
as `ARTIFACT_VERSION_NAME`. `publish.yml` downloads the same-run `docs` artifact and
`assemble.sh` unzips + stages it directly, **skipping the re-gather of that version**.
Everything else (other releases, other open PRs, the rest) still comes from durable
sources.

`publish.yml` runs **`assemble/assemble.sh`** (checked out from this repo at
`job.workflow_sha`, so the scripts match the workflow's own ref) to gather + generate
+ output the site dir, then `deploy-pages`. Operator note: because internal PRs/tags now deploy from
their **own ref** (not only the default branch), the `github-pages` environment's
deployment-branch policy must allow those refs (or be unrestricted) — this is the
cost of nesting publish for visibility. Bash in `assemble` does the `gh`/`unzip`/`mv`
IO (gather); the JS kernel does the pure logic (`generate` + the folded-in
`missingRequired` guard) and is unit-tested without git/network/fs. There is **no
sanitisation**: version names are clean by construction — `main`, `pr-<number>`, or
a tag without `/` (the `tags: ['*']` trigger never builds `/`-tags).

### Self-referencing the assemble scripts (no separate action)
`publish.yml` runs `assemble/assemble.sh` directly rather than wrapping it in a
composite action. To version-match the scripts to the workflow, it sparse-checks-out
**this** repo's `assemble/` at `job.workflow_repository` + `job.workflow_sha` — the
`job` context resolves to the file that defines the running job, i.e. the *reusable*
workflow (unlike `github.workflow_*`, which resolve to the *caller's* entry
workflow). So a consumer pinning `publish.yml@vX` gets `assemble@vX` automatically,
with no hardcoded repo and no release-time bump, and this repo's own publish job
tests the working-tree scripts (no dogfood gap). The consumer's repo stays checked
out at the root so `assemble.mjs`'s `git tag` lists *their* versions; the scripts run
from `.mvs`. (`uses:` can't take an expression, so a composite action could only be
pinned to a literal tag — the `job` context is the only way to self-reference at the
running ref.) Note: actionlint's `job`-context schema is stale and false-flags
`job.workflow_sha`/`job.workflow_repository`; the GitHub docs confirm both. This repo
lints with biome, not actionlint.

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
`_release.yml` (an `a`/`b`/`rc` marker).

### `stable/` alias
When a non-prerelease release is deployed, the site serves a `stable/` symlink
(inflated to a real copy by `upload-pages-artifact`'s `--dereference`) to the
newest release, and the root redirect targets the constant `stable/` URL — a
stable inventory URL for cross-project `objects.inv`. `switcher.json` has no
`stable` entry; the widget maps a `…/stable/` page back to the concrete release.

## CI structure

One entry workflow (`ci.yml`) that nests the privileged publish:

- `ci.yml` — **build + verify, then publish on internal events.** Triggers on
  `pull_request` + push to `main`/tags (no other-branch pushes; `*` excludes
  `/`-tags). Orchestrates `_lint` / `_test` / `_docs` / `_release`, runs for forks,
  and uploads the `docs` artifact. It then nests the `publish` job
  (`uses: publish.yml`) — runs only for the **canonical repo on internal** events
  (the `if` is `repository == '…' && (event != pull_request ||
  head.repo.full_name == github.repository)`); grants `pages`/`id-token`/`statuses`
  perms to the call and passes `version-name: needs.docs.outputs.version-name`. The
  fork-PR warning is a step inside `docs.yml`'s build job (not a separate ci.yml
  job), keeping the top-level workflow lean. The `publish` job's `if` also excludes
  **tags** (`ref_type != 'tag'`) — a separate `publish-tag` job (tags only, `needs:
  [_release]`, `actions: write`) re-triggers the deploy via
  `gh workflow run publish-dispatch.yml --ref <default-branch>` (`workflow_dispatch`),
  because a same-SHA tag deploy is silently dropped by Pages unless it's a dispatch
  event (deploy-pages#383). Both the inline `publish` job and `publish-tag` route
  through `publish-dispatch.yml`, never `publish.yml` directly.
- `publish-dispatch.yml` — **the one wrapper around the engine.** `workflow_call`
  (ci.yml's inline `publish` job) + `workflow_dispatch` (the tag trampoline + fork-PR
  opt-in + manual re-deploy); both just `uses: publish.yml` and pass `version-name` /
  `pr` / `guard-default-branch` through, carrying the privileged perms. This repo
  dogfoods the exact wrapper consumers add (theirs pins `publish.yml@<tag>`; this one
  uses the local path).
- `publish.yml` — **assemble + deploy ENGINE, privileged.** `workflow_call` ONLY
  (sole caller: `publish-dispatch.yml`). Sparse-checks-out this repo's `assemble/` at
  `job.workflow_sha` (so the scripts match the ref the consumer pinned
  `publish.yml@<ref>` to — see "Self-referencing the assemble scripts" below), runs
  `assemble.sh`, then `upload-pages-artifact` + `deploy-pages`, carrying the
  `github-pages` environment + `pages`/`id-token`/`statuses` perms + `concurrency`.
  Its job has **no `if`** — the canonical-repo guard lives upstream in ci.yml's
  `publish` job + the wrapper's dispatch (which needs write access).
  On `workflow_call` with a non-empty `version-name` it injects the in-run build (see
  the split design decision). See the architecture explanation in docs/.

Sub-workflows of `ci.yml`:
- `_lint.yml` — biome
- `_test.yml` — `npm test`
- `docs.yml` — **reusable build, parameterised for cross-repo reuse.** Compute the
  version name (`pr-<n>` / default-branch / tag) → run `build-command` (input,
  default `make docs`) with `BASE_URL` set → pack `docs.zip` (bare `html/`, staged so
  any `html-dir` works) → upload the `docs` artifact → warn on fork PRs. No deploy;
  `contents: read` only. Installs uv unconditionally and relies on the runner's
  preinstalled Node, so `build-command` can be `make docs` / `npx … myst build` /
  `tox -e docs` regardless of project. This repo passes `npm ci && npm run docs`. It
  OWNS the build↔publish contract (version name, BASE_URL, docs.zip `html/` root,
  `docs` artifact name) so consumers only choose a command.
- `_release.yml` — attaches `version-switcher.mjs` + the tag's `docs.zip` (the
  `docs` artifact, verbatim — no repack) as Release assets (tag-only).

**Publish flow.** Internal PRs and `main` publish as part of the same CI run once
lint/test/docs pass (`ci.yml`'s `publish` job → `publish.yml` injects this build +
`assemble` gathers `main`, releases, and every other open PR → deploy), so the deploy
is a visible check on the PR/commit. **Tags are the exception:** a release tag shares
the merge commit's SHA, and GitHub Pages silently drops a second deploy of an
already-deployed SHA *unless* the event is `workflow_dispatch`
([`actions/deploy-pages#383`](https://github.com/actions/deploy-pages/issues/383)) —
so the `publish-tag` job (after `_release`) re-triggers `publish.yml` via
`gh workflow run` (`workflow_dispatch`), which re-gathers from durable sources (incl.
the new release) and deploys with the origin actually updating. The dispatched run
carries the deploy status (not the tag's CI run). An **external fork PR** builds +
verifies in CI but does **not** auto-publish (its `publish` job is skipped); a
maintainer runs `publish.yml` with the PR number (`workflow_dispatch` → `pr`),
which sets a `preview-approved` commit status pinned to that **head SHA** and
assembles — so a later push to the PR (new SHA) drops the preview until re-approved.
`assemble` gathers an open PR's artifact via its head SHA; internal PRs always,
fork PRs only when the SHA carries that status. Consumers can't dispatch `publish.yml`
cross-repo, so they trampoline via a small `publish-dispatch.yml` wrapper (which also
serves the fork-preview opt-in) — see the how-to.

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

CI runs lint + tests + docs build, `_release.yml` creates a GitHub Release with
`version-switcher.mjs` and the tag's `docs.zip` as assets, and `publish.yml`
(triggered by CI completing) reconstructs + deploys the site including the new tag.
The plugin URL and the `uses:` refs for `docs.yml`/`publish.yml` all resolve to the
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

Set the repo's **Pages source to "GitHub Actions"**, then add a `ci.yml` that calls
the two shared reusable workflows by full path at `<tag>`:

```yaml
jobs:
  docs:
    uses: DiamondLightSource/myst-version-switcher-plugin/.github/workflows/docs.yml@<tag>
    with:
      build-command: make docs        # or: tox -e docs / npx … myst build / npm ci && npm run docs
  publish:                            # internal, non-tag events (fork PRs + tags excluded by the if)
    needs: [docs]
    if: >-
      github.repository == 'ORG/REPO' &&
      github.ref_type != 'tag' &&
      ( github.event_name != 'pull_request' ||
        github.event.pull_request.head.repo.full_name == github.repository )
    uses: ./.github/workflows/publish-dispatch.yml   # your wrapper; it pins publish.yml@<tag>
    with:
      version-name: ${{ needs.docs.outputs.version-name }}
    permissions: { pages: write, id-token: write, contents: read, actions: read, statuses: write }
  publish-tag:                        # tags: re-deploy via workflow_dispatch (see how-to)
    needs: [docs, release]
    if: github.repository == 'ORG/REPO' && github.ref_type == 'tag'
    runs-on: ubuntu-latest
    permissions: { actions: write }
    steps:
      - env: { GH_TOKEN: "${{ github.token }}", DEFAULT_BRANCH: "${{ github.event.repository.default_branch }}" }
        run: gh workflow run publish-dispatch.yml --repo "$GITHUB_REPOSITORY" --ref "$DEFAULT_BRANCH"
```

Add a `_release.yml`-style job that attaches each tag's built `docs.zip` (bare
`html/` root) + the plugin as Release assets so `assemble` can reconstruct released
versions, and a small `publish-dispatch.yml` wrapper around `publish.yml` — the single
caller of the engine and the one place you pin `publish.yml@<tag>`. It's
`workflow_call` (your `publish` job nests it for the inline non-tag deploy) **and**
`workflow_dispatch` (the **tag trampoline** target — `publish-tag` dispatches it so the
deploy runs as a `workflow_dispatch`, required for a release's same-SHA deploy to go
live — plus the fork-PR preview opt-in via `pr`). See the full how-to + snippets in
`docs/`.

## Upstreaming

`plugins/version-switcher.mjs` follows
[`jupyter-book/myst-plugins`](https://github.com/jupyter-book/myst-plugins)
conventions (single self-contained `.mjs`, distributed as a release asset) so it
can later be contributed there. The `assemble/` producer is DLS deployment
infrastructure and stays here.

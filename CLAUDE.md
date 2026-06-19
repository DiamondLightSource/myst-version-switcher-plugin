# myst-version-switcher-plugin

A pydata-style version-switcher for [MyST](https://mystmd.org) docs, delivered as
a single `anywidget` plugin **plus** a CI composite action (`assemble`) that
reconstructs the whole versioned docs site from durable sources every deploy and
publishes it directly to GitHub Pages.

## Repo layout

```
plugins/version-switcher.mjs                   # MyST directive + anywidget runtime (single file, no README — docs are in docs/)
assemble/action.yml                            # thin wrapper → runs assemble.sh
assemble/assemble.sh                           # reconstruct the whole site from durable sources (gh/unzip plumbing); runnable standalone for local testing
assemble/assemble.mjs                          # dependency-free Node kernel behind assemble.sh (the `generate` subcommand)
scripts/migrate.sh                             # one-shot operator gh-pages → durable-source migration (bash)
test/                                          # npm test suite (node, no framework)
docs/                                          # this repo's own docs (dogfoods the plugin)
.github/workflows/ci.yml                       # build + verify + publish-on-internal: _lint / _test / _docs / _release, then nests _publish for internal events
.github/workflows/_publish.yml                 # assemble + deploy to Pages (PRIVILEGED): workflow_call (internal, from ci.yml) + workflow_dispatch (manual fork-PR opt-in)
```

## Two halves, different lifecycles

| half | file | how consumers use it |
|------|------|----------------------|
| Plugin (widget) | `plugins/version-switcher.mjs` | release-asset URL in `myst.yml` `plugins` |
| Site action | `assemble/` | `uses: DiamondLightSource/myst-version-switcher-plugin/assemble@<tag>` in their publish workflow |

One `vX.Y.Z` tag versions both. The plugin is published as a GitHub Release asset
(alongside the tag's `docs.zip`); the action is consumed from the repo tree at the
same tag.

## Key design decisions

See [`docs/explanation/architecture.md`](docs/explanation/architecture.md) for the
full rationale. In short:

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
It then nests the privileged `_publish.yml` (`workflow_call`) as a `publish` job —
but **only for internal events** (an internal PR, or a push to main/tag): the job's
`if` excludes fork PRs (`head.repo.full_name != github.repository`), whose builds
run with a read-only token and must never deploy. So publish status is **visible on
the PR/commit** for internal work, while untrusted fork-PR code still never reaches
a write token. A fork PR instead gets a warning step in `_docs.yml`'s build job that
links the manual opt-in (`_publish.yml`'s `workflow_dispatch`).

Because publish now runs **inside the build's own CI run**, the current build isn't
a *completed* successful run the gather can discover (and for a main/tag push the
gather would find the *previous* build). So `ci.yml` passes `_publish.yml` the build's
version name (`needs.docs.outputs.version-name`); `_publish` hands it to `assemble` as
`artifact-version-name`. The action downloads the same-run `docs` artifact and
`assemble.sh` unzips + stages it directly, **skipping the re-gather of that version**.
Everything else (other releases, other open PRs, the rest) still comes from durable
sources.

`_publish.yml` runs the **`assemble`** action to gather + generate + output the site
dir, then `deploy-pages`. Operator note: because internal PRs/tags now deploy from
their **own ref** (not only the default branch), the `github-pages` environment's
deployment-branch policy must allow those refs (or be unrestricted) — this is the
cost of nesting publish for visibility. Bash in `assemble` does the `gh`/`unzip`/`mv`
IO (gather); the JS kernel does the pure logic (`generate` + the folded-in
`missingRequired` guard) and is unit-tested without git/network/fs. There is **no
sanitisation**: version names are clean by construction — `main`, `pr-<number>`, or
a tag without `/` (the `tags: ['*']` trigger never builds `/`-tags).

### BASE_URL must be set before `myst build`
```yaml
env:
  BASE_URL: /<repo>/<version-name>   # version-name = pr-<n> | main | <tag>
run: cd docs && myst build --html
```
Without this, assets and links break under the versioned GitHub Pages sub-path. The
version name is computed in `ci.yml` and is exactly the `site/<version-name>` dir
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
  (`uses: _publish.yml`) — runs only for the **canonical repo on internal** events
  (the `if` is `repository == '…' && (event != pull_request ||
  head.repo.full_name == github.repository)`); grants `pages`/`id-token`/`statuses`
  perms to the call and passes `version-name: needs.docs.outputs.version-name`. The
  fork-PR warning is a step inside `_docs.yml`'s build job (not a separate ci.yml
  job), keeping the top-level workflow lean.
- `_publish.yml` — **assemble + deploy, privileged.** `workflow_call` (the nested
  internal path) + `workflow_dispatch` (the fork-PR opt-in). Runs the `assemble`
  action + `upload-pages-artifact` + `deploy-pages`, carrying the `github-pages`
  environment + `pages`/`id-token`/`statuses` perms + `concurrency`. Its job has **no
  `if`** — the canonical-repo guard lives in ci.yml's `publish` job, and both entry
  points are trusted (ci.yml gates the call; dispatch needs write access).
  On `workflow_call` it injects the in-run build via `artifact-version-name` (see the
  split design decision). See the architecture explanation in docs/.

Sub-workflows of `ci.yml`:
- `_lint.yml` — biome
- `_test.yml` — `npm test`
- `_docs.yml` — build only: compute the version name (`pr-<n>` / `main` / tag) →
  `myst build` with `BASE_URL` → pack `docs.zip` (bare `html/`) → upload the `docs`
  artifact. No deploy.
- `_release.yml` — attaches `version-switcher.mjs` + the tag's `docs.zip` (the
  `docs` artifact, verbatim — no repack) as Release assets (tag-only).

**Publish flow.** Internal PRs, `main`, and tags publish as part of the same CI run
once lint/test/docs pass (`ci.yml`'s `publish` job → `_publish.yml` injects this
build + `assemble` gathers `main`, releases, and every other open PR → deploy), so
the deploy is a visible check on the PR/commit. An **external fork PR** builds +
verifies in CI but does **not** auto-publish (its `publish` job is skipped); a
maintainer runs `_publish.yml` with the PR number (`workflow_dispatch` → `pr`),
which sets a `preview-approved` commit status pinned to that **head SHA** and
assembles — so a later push to the PR (new SHA) drops the preview until re-approved.
`assemble` gathers an open PR's artifact via its head SHA; internal PRs always,
fork PRs only when the SHA carries that status.

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
The plugin URL and the `assemble` action reference the same tag.

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

Set the repo's **Pages source to "GitHub Actions"**, then add the workflows: a
**CI** that builds (`BASE_URL` set to `/REPO/<version-name>` → pack `docs.zip` → upload
`docs` artifact; attach `docs.zip` + the plugin on tags) and then nests a
**`_publish`** reusable workflow (`workflow_call` → `assemble` → `upload-pages-artifact`
→ `deploy-pages`) as a job, run for internal events only, plus a `workflow_dispatch`
on `_publish` for the fork-PR opt-in. See the full how-to + workflow snippets in
`docs/`. Attach each tag's built docs as a `docs.zip` Release asset (bare `html/`
root) so `assemble` can reconstruct released versions.

## Upstreaming

`plugins/version-switcher.mjs` follows
[`jupyter-book/myst-plugins`](https://github.com/jupyter-book/myst-plugins)
conventions (single self-contained `.mjs`, distributed as a release asset) so it
can later be contributed there. The `assemble/` producer is DLS deployment
infrastructure and stays here.

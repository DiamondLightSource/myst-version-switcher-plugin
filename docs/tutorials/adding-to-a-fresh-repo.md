# Tutorial: add versioned docs to a fresh repo

This walks you, start to finish, through giving a MyST docs site a pydata-style
version switcher and a versioned GitHub Pages deployment. By the end you will have:

- the switcher dropdown in your navbar,
- every push to `main`, tag, and internal PR published at its own URL, and
- a `stable/` alias pointing at your latest release.

It assumes a repo that already builds docs with `myst build --html` from a `docs/`
directory. Replace `ORG/REPO` throughout, and pin a real `<tag>` from this project's
[releases](https://github.com/DiamondLightSource/myst-version-switcher-plugin/releases).

## 1. Add the plugin to your MyST project

In `docs/myst.yml`, load the plugin from its release asset and route a navbar part:

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

Then place the directive (see the [directive reference](../reference/directive.md)
for all options):

```markdown
<!-- docs/navbar_end.md -->
:::{version-switcher}
:json-url: https://ORG.github.io/REPO/switcher.json
:::
```

The `json-url` points at a `switcher.json` that does not exist yet — `publish.yml`
will generate it on your first deploy.

## 2. Set the Pages source to "GitHub Actions"

In **Settings → Pages**, set **Source** to **GitHub Actions** (not "Deploy from a
branch"). `deploy-pages` refuses to publish otherwise.

## 3. Add a `ci.yml` that calls the shared workflows

You don't copy any workflows into your repo — you **call** this project's two reusable
workflows by full path, pinned to `<tag>`. `docs.yml` builds and uploads the `docs`
artifact for every event (including fork PRs); `publish.yml` reconstructs the whole
versioned site and deploys it, nested as a job that runs **only for internal events**
on your repo (the canonical-repo + non-fork guard). Fork PRs build to verify but never
reach a write token.

```yaml
# .github/workflows/ci.yml
name: CI
on:
  pull_request:
  push: { branches: [main], tags: ['*'] }   # '*' never matches '/'

jobs:
  docs:
    uses: DiamondLightSource/myst-version-switcher-plugin/.github/workflows/docs.yml@<tag>
    with:
      # Whatever turns your sources into docs/_build/html at $BASE_URL.
      # uv and Node are preinstalled, so this can be make / tox / npx / npm.
      build-command: myst build --html      # e.g. make docs · tox -e docs · npm ci && npm run docs

  # a tag-only release job attaching docs.zip — REQUIRED once you cut releases (step 6).

  publish:
    needs: [docs]
    if: >-
      github.repository == 'ORG/REPO' &&
      ( github.event_name != 'pull_request' ||
        github.event.pull_request.head.repo.full_name == github.repository )
    uses: DiamondLightSource/myst-version-switcher-plugin/.github/workflows/publish.yml@<tag>
    with:
      version-name: ${{ needs.docs.outputs.version-name }}
    permissions:
      contents: read
      actions: read
      pages: write
      id-token: write
      statuses: write
```

That's the whole integration. `build-command` is the only thing most repos customise:
`docs.yml` owns the versioning contract (the `BASE_URL`, the `docs.zip` bare-`html/`
root, the `docs` artifact name), and `publish.yml` runs the site reconstruction
internally — it checks out this project's `assemble` scripts at the same `<tag>` via
`job.workflow_sha`, so there is no action or script for you to wire.

### (optional) Fork-PR preview opt-in

Internal PRs publish automatically; fork PRs build and verify but never auto-deploy.
To let a maintainer manually publish a fork PR's preview, add a small
`workflow_dispatch` wrapper — a reusable workflow can't be dispatched cross-repo, so
the wrapper lives in your repo and passes the PR number through `workflow_call`:

```yaml
# .github/workflows/preview-fork.yml
name: Preview fork PR
on:
  workflow_dispatch:
    inputs:
      pr: { description: Fork PR number to approve + preview, required: true }
jobs:
  preview:
    uses: DiamondLightSource/myst-version-switcher-plugin/.github/workflows/publish.yml@<tag>
    with:
      version-name: ""          # no in-run build to inject → pure durable gather
      pr: ${{ inputs.pr }}      # pins the fork's head SHA as preview-approved, then assembles
    permissions:
      contents: read
      actions: read
      pages: write
      id-token: write
      statuses: write
```

Run it from the Actions tab with the PR number. It approves that fork PR's current
head commit and deploys a preview; a later push to the PR (new SHA) drops the preview
until you re-run it.

## 4. Allow the deploying refs in the `github-pages` environment

Because internal PRs and tags now deploy from **their own ref** (the publish job
runs inside their CI run), the `github-pages` environment's deployment policy must
allow those refs. In **Settings → Environments → github-pages**, it is recommended
to set **Deployment branches and tags** to **No restriction**.

## 5. First deploy

Push to `main`. CI builds `main`, the `publish` job assembles a single-entry
`switcher.json` and an `index.html` redirecting to `main/`, and deploys. Visit
`https://ORG.github.io/REPO/` — the redirect lands you on `main/` with the switcher
showing one entry. (The single-entry first deploy is graceful by design; no release
is required.)

## 6. Add the release job (required for versioned releases)

`assemble` reconstructs each released version from a **`docs.zip` asset on its GitHub
Release** — that asset is the only durable source for a tag (unlike the default branch,
tags get no `_sources/` copy). Without a job that attaches it, a tag's docs appear only
on its *own* deploy and **drop on the next** unrelated deploy. So add a tag-only job —
gated with `if: github.ref_type == 'tag'`, `runs-on: ubuntu-latest`, and
`permissions: { contents: write }` — whose steps download the build's `docs` artifact
and attach `docs.zip` to the Release. Those steps are exactly what this repo's
`_release.yml` runs (minus its plugin-specific `version-switcher.mjs` handling):

```{literalinclude} ../../.github/workflows/_release.yml
:language: yaml
:start-after: docs-literalinclude:release-steps:start
:end-before: docs-literalinclude:release-steps:end
```

`actions/download-artifact` pulls the `docs` artifact `docs.yml` uploaded (the
`docs.zip`); `action-gh-release`'s `files: "*"` then attaches everything in the working
directory — here, just that `docs.zip` — to the tag's Release.

## 7. Cut your first release

```bash
git tag v1.0.0 && git push origin v1.0.0
```

On the next deploy, `assemble` gathers that release, flags it `preferred` (★),
creates the `stable/` alias pointing at it, and the root redirect now targets the
constant `stable/` URL. Your switcher now lists `main` and `1.0.0`, and
`https://ORG.github.io/REPO/stable/` always resolves to the latest release — a
stable URL for cross-project `objects.inv` references.

## Where next

- The [architecture explanation](../explanations/architecture.md) — why it works
  this way.
- The [workflow reference](../reference/workflows.md) — the `docs.yml`/`publish.yml`
  inputs and the `docs.zip` contract.
- Migrating an existing site? See
  [how-to: migrate from `gh-pages`](../how-to/migrate-from-gh-pages.md).

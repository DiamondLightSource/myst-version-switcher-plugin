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

## 3. Add the `ci.yml` (build · release · publish)

This is the one workflow file you add. You don't copy the build/publish logic into your
repo — you **call** this project's two reusable workflows by full path, pinned to
`<tag>`. Three jobs:

- **`docs`** — `docs.yml` builds your site at the versioned `BASE_URL` and uploads the
  `docs` artifact, for every event (fork PRs included).
- **`release`** — a small tag-only job that attaches the built `docs.zip` to the GitHub
  Release. **Required:** that asset is a tag's *only* durable source (tags get no
  `_sources/` copy, unlike the default branch), so without it a release drops on the
  next deploy.
- **`publish`** — `publish.yml` reconstructs the whole versioned site and deploys it,
  nested so its status shows on the PR/commit, but it runs **only for internal events**
  (the canonical-repo + non-fork guard). Fork PRs build to verify but never reach a
  write token.

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

  release:
    needs: [docs]
    if: github.ref_type == 'tag'            # tag pushes only
    runs-on: ubuntu-latest
    permissions:
      contents: write                       # create the Release + attach assets
    steps:
      # ↓ paste the two steps from the literalinclude below ↓

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

The `release` job's `steps:` are exactly what this repo's own `_release.yml` runs (minus
its plugin-specific `version-switcher.mjs` handling) — drop these in under `steps:`
above (`download-artifact` pulls the `docs` artifact; `action-gh-release`'s `files: "*"`
attaches everything in the working directory, here just that `docs.zip`):

```{literalinclude} ../../.github/workflows/_release.yml
:language: yaml
:start-after: docs-literalinclude:release-steps:start
:end-before: docs-literalinclude:release-steps:end
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

## 5. Push your branch and open a PR

Steps 2 and 4 are repo settings (done once in the UI); steps 1 and 3 are file changes —
commit them on a branch and open a PR. On the PR you'll see:

- **`docs / build`** go green — it builds your docs at the versioned `BASE_URL` and
  uploads the `docs` artifact. This runs for every PR, forks included.
- **`publish / publish`** runs for an *internal* PR (a branch in your own repo) and
  deploys a preview of just this PR at `https://ORG.github.io/REPO/pr-<n>/`, linked from
  the PR's checks/Deployments. A **fork** PR builds but never auto-publishes (its token
  is read-only) — use the opt-in from step 3 to preview one.

> **First-time exception:** on a brand-new repo the `publish` check is **red on this
> setup PR** — there's no `main` build yet for the versioned site to anchor on, and the
> default-branch guard refuses to publish a site missing it. It clears the moment you
> merge (step 6). Every PR after that previews normally.

## 6. Merge to main — your first deploy

Merging pushes to `main`, which builds `main` and runs `publish`: it assembles a
single-entry `switcher.json` and an `index.html` redirecting to `main/`, and deploys.
Visit `https://ORG.github.io/REPO/` — the redirect lands you on `main/` with the
switcher showing one entry. (The single-entry first deploy is graceful by design; no
release required.) From here on, every push to `main` redeploys and every internal PR
gets its own `/pr-<n>/` preview.

## 7. Cut your first release

```bash
git tag v1.0.0 && git push origin v1.0.0
```

The tag build runs, the **`release`** job attaches its `docs.zip` to the GitHub Release,
and the next deploy's `assemble` gathers that release, flags it `preferred` (★), creates
the `stable/` alias pointing at it, and points the root redirect at the constant
`stable/` URL. Your switcher now lists `main` and `1.0.0`, and
`https://ORG.github.io/REPO/stable/` always resolves to the latest release — a stable
URL for cross-project `objects.inv` references.

## Where next

- The [architecture explanation](../explanations/architecture.md) — why it works
  this way.
- The [workflow reference](../reference/workflows.md) — the `docs.yml`/`publish.yml`
  inputs and the `docs.zip` contract.
- Migrating an existing site? See
  [how-to: migrate from `gh-pages`](../how-to/migrate-from-gh-pages.md).

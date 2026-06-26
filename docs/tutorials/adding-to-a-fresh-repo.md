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

## 2. Set the Pages source to "GitHub Actions" and allow deploys from any ref

In **Settings → Pages**, set **Source** to **GitHub Actions** (not "Deploy from a
branch"). `deploy-pages` refuses to publish otherwise.

Because internal PRs deploy from their own ref, the `github-pages` environment's
deployment policy must allow those refs. In **Settings → Environments →
github-pages**, it is recommended to set **Deployment branches and tags** to
**No restriction**.

## 3. Add the workflow files

Your project will use this project's two reusable workflows to build a single
version of the docs, then publish all available versions of the docs into a
single GitHub Pages site.

It is recommended that you use the structure below.

### `ci.yml`

This is the entry point, it defines three jobs:

- **`docs`** — `docs.yml` builds your site at the versioned `BASE_URL` and uploads the
  `docs` artifact, for every event (fork PRs included).
- **`release`** — a small tag-only job that attaches the built `docs.zip` to the GitHub
  Release.
- **`publish`** — calls your `publish-dispatch.yml` wrapper which publishes the complete
  built site (with all versions) to GitHub Pages.

```yaml
# .github/workflows/ci.yml
name: CI
on:
  pull_request:
  push: 
    branches: [main]
    tags: ['*']

jobs:
  docs:   # Call the docs building workflow directly
    uses: DiamondLightSource/myst-version-switcher-plugin/.github/workflows/docs.yml@<tag>
    with:
      # Whatever turns your sources into docs/_build/html at $BASE_URL.
      # uv and Node are preinstalled, so this can be make / tox / npx / npm.
      build-command: myst build --html      # e.g. make docs · tox -e docs · npm ci && npm run docs

  release: 
    needs: [docs]
    if: github.ref_type == 'tag'            # tag pushes only
    uses: DiamondLightSource/myst-version-switcher-plugin/.github/workflows/release.yml@<tag>
    permissions:
      contents: write                       # create the Release + attach assets

  publish:
    needs: [docs]
    if: github.repository == 'ORG/REPO'     # don't publish a pages site in the fork's org
    uses: ./.github/workflows/publish-dispatch.yml   # your workflow (below)
    with:
      version-name: ${{ needs.docs.outputs.version-name }}
    permissions:
      contents: read
      actions: write
      pages: write
      id-token: write
      statuses: write
```

### `publish-dispatch.yml`

`publish.yml` is a pure `workflow_call` engine, and this wrapper in your repo is the
**only** thing that calls it — also the single place you pin the engine's `@<tag>`. It
owns all the branching, so your `ci.yml` `publish` job stays a one-liner. Copy it
verbatim, changing only `<tag>`:

```yaml
# .github/workflows/publish-dispatch.yml
name: Publish (dispatch)
on:
  workflow_call:                    # ci.yml's `publish` job, for every event
    inputs:
      version-name:          { required: false, default: "", type: string }
      guard-default-branch:  { required: false, default: "true", type: string }
      pr:                    { required: false, default: "", type: string }
  workflow_dispatch:                # tag trampoline's re-dispatch + fork-PR preview + manual re-deploy
    inputs:
      pr: { description: "Fork PR number to approve + preview (leave empty to just re-deploy)", required: false, default: "" }
jobs:
  # Internal PR / default-branch push (inline), or any workflow_dispatch → deploy.
  deploy:
    if: >-
      github.event_name == 'workflow_dispatch' ||
      (github.event_name == 'push' && github.ref_type != 'tag') ||
      (github.event_name == 'pull_request' &&
       github.event.pull_request.head.repo.full_name == github.repository)
    permissions: { contents: read, actions: read, pages: write, id-token: write, statuses: write }
    uses: DiamondLightSource/myst-version-switcher-plugin/.github/workflows/publish.yml@<tag>
    with:
      version-name: ${{ inputs.version-name }}                       # "" on dispatch → pure durable gather
      guard-default-branch: ${{ inputs.guard-default-branch || 'true' }}
      pr: ${{ inputs.pr }}                                           # set → pin that fork head SHA

  # A tag can't deploy inline (same SHA as the default-branch push → Pages drops it
  # unless the event is workflow_dispatch). Re-dispatch this workflow after the release.
  trampoline:
    if: github.event_name == 'push' && github.ref_type == 'tag'
    runs-on: ubuntu-latest
    permissions: { contents: read, actions: write }
    steps:
      - env: { GH_TOKEN: "${{ github.token }}", REPO: "${{ github.repository }}", TAG: "${{ github.ref_name }}", DEFAULT_BRANCH: "${{ github.event.repository.default_branch }}" }
        run: |
          set -euo pipefail
          for _ in $(seq 1 36); do gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1 && break; sleep 5; done
          gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1 || { echo "::error::release $TAG not found"; exit 1; }
          gh workflow run publish-dispatch.yml --repo "$REPO" --ref "$DEFAULT_BRANCH"

  # Fork PR: read-only token, never deploys — just surface the manual-opt-in hint.
  warn:
    if: >-
      github.event_name == 'pull_request' &&
      github.event.pull_request.head.repo.full_name != github.repository
    runs-on: ubuntu-latest
    permissions: {}
    steps:
      - run: |
          echo "::warning title=Docs preview not published::Fork PR — not auto-published. A maintainer \
          can preview it by running publish-dispatch.yml with pr=${{ github.event.pull_request.number }}: \
          https://github.com/${{ github.repository }}/actions/workflows/publish-dispatch.yml"
```

The three branches: **deploy** (internal PR / `main` push inline, or any dispatch),
**trampoline** (a tag re-dispatches itself so the deploy runs as a `workflow_dispatch`
— [why](../explanations/architecture.md)), and **warn** (a fork PR, read-only, never
deploys). A maintainer publishes a fork preview by running this workflow from the
Actions tab with the `pr` number.

## 4. Push your branch and open a PR

Make the changes from steps 1 and 3 in a branch and open a PR. On the PR you'll
see:

- **`docs / build`** go green — it builds your docs at the versioned `BASE_URL` and
  uploads the `docs` artifact. This runs for every PR, forks included.
- **`publish / deploy`** runs for an *internal* PR (a branch in your own repo) and
  deploys a preview of just this PR at `https://ORG.github.io/REPO/pr-<n>/`, linked from
  the PR's checks/Deployments. A **fork** PR instead gets **`publish / warn`** (a
  read-only hint — forks never auto-publish); a maintainer dispatches the wrapper with
  the `pr` number to preview one.

> **First-time exception:** on a brand-new repo the `publish` check is **red on this
> setup PR** — there's no `main` build yet for the versioned site to anchor on, and the
> default-branch guard refuses to publish a site missing it. It clears the moment you
> merge (step 6). Every PR after that previews normally.

## 5. Merge to main — your first deploy

Merging pushes to `main`, which builds `main` and runs `publish`: it assembles a
single-entry `switcher.json` and an `index.html` redirecting to `main/`, and deploys.
Visit `https://ORG.github.io/REPO/` — the redirect lands you on `main/` with the
switcher showing one entry. (The single-entry first deploy is graceful by design; no
release required.) From here on, every push to `main` redeploys and every internal PR
gets its own `/pr-<n>/` preview.

## 6. Cut your first release

Use the GitHub UI to make a new release. This will create a tag, which triggers the **`release`** job to attach its `docs.zip` to the GitHub Release. 
Then `publish` gathers that release, flags it `preferred` (★), creates
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

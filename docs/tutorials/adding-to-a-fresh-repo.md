# Tutorial: add versioned docs to a fresh repo

This walks you, start to finish, through giving a MyST docs site a pydata-style
version switcher and a versioned GitHub Pages deployment. By the end you will have:

- the switcher dropdown in your navbar,
- every push to `main`, tag, and internal PR published at its own URL, and
- a `stable/` alias pointing at your latest release.

It assumes a repo that already builds docs with `myst build --html` from a `docs/`
directory. Replace `ORG/REPO` throughout. The snippets below are pinned to the
latest release (`__LATEST_TAG__`); bump that pin to any version from this project's
[releases](https://github.com/DiamondLightSource/myst-version-switcher-plugin/releases)
when you need a different one.

## 1. Add the plugin to your MyST project

In `docs/myst.yml`, load the plugin from its release asset and route a navbar part:

```yaml
# docs/myst.yml
project:
  plugins:
    - https://github.com/DiamondLightSource/myst-version-switcher-plugin/releases/download/__LATEST_TAG__/version-switcher.mjs
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

This is the entry point, it defines two jobs:

- **`docs`** — `docs.yml` builds your site at the versioned `BASE_URL` and uploads the
  `docs` artifact, for every event (fork PRs included).
- **`release`** — a small tag-only job that attaches the built `docs.zip` to the GitHub
  Release.

It does *not* publish. `publish.yml` (below) picks this run up once it completes, which
keeps the site's reconstruction cost off your PRs and stops a Pages failure showing as a
red check against an author who cannot act on it.

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
    uses: DiamondLightSource/myst-version-switcher-plugin/.github/workflows/docs.yml@__LATEST_TAG__
    with:
      # Whatever turns your sources into docs/_build/html at $BASE_URL. uv and Node
      # are preinstalled, so: make docs · tox -e docs · npm ci && npm run docs
      build-command: myst build --html

  release: 
    needs: [docs]
    if: github.ref_type == 'tag'            # tag pushes only
    uses: DiamondLightSource/myst-version-switcher-plugin/.github/workflows/release.yml@__LATEST_TAG__
    permissions:
      contents: write                       # create the Release + attach assets
```

`ci.yml` has no publish job at all — publishing is a separate workflow that picks this
run up once it finishes.

### `publish.yml`

The one file you carry, and the one place you pin `@__LATEST_TAG__`. It calls the engine
(`publish-gh-pages.yml`) when CI completes. Copy it verbatim:

```yaml
# .github/workflows/publish.yml
name: Publish
on:
  # Matches your CI workflow by its `name:`, NOT its filename. Rename that and you must
  # change it here too, or publishing silently stops.
  workflow_run:
    workflows: [CI]
    types: [completed]
  # Fork-PR previews and manual re-deploys.
  workflow_dispatch:
    inputs:
      pr:
        description: "Fork PR to approve + preview (empty = plain re-deploy)"
        required: false
        default: ""

jobs:
  publish:
    # Both guards matter. `conclusion` because workflow_run fires on failed runs too, and
    # a failed run has no usable docs artifact. `head_repository` because workflow_run
    # gets a WRITE token even when a fork's PR triggered it — without this, untrusted
    # code reaches your live site. Both fail OPEN if removed.
    if: >-
      github.event_name == 'workflow_dispatch' ||
      (github.event.workflow_run.conclusion == 'success' &&
       github.event.workflow_run.head_repository.full_name == github.repository)
    uses: DiamondLightSource/myst-version-switcher-plugin/.github/workflows/publish-gh-pages.yml@__LATEST_TAG__
    with:
      pr: ${{ inputs.pr }}
      # Publish only the N most recent releases; 0 = all. A LITERAL, so it holds on every
      # path — the site deploys as one Pages artifact against a hard 1 GB cap. See
      # docs/how-to/keep-the-site-small.md.
      max-releases: "20"
    permissions:
      contents: read
      actions: read
      pages: write
      id-token: write
      statuses: write
```

That is the whole publish setup: no job in `ci.yml`, no shim, nothing to thread through.
A maintainer publishes a fork preview by running this workflow from the Actions tab with
the `pr` number.

## 4. Push your branch and open a PR

Make the changes from steps 1 and 3 in a branch and open a PR. On the PR you'll
see:

- **`docs / build`** go green — it builds your docs at the versioned `BASE_URL` and
  uploads the `docs` artifact. This runs for every PR, forks included.
Then, once CI finishes, a **`Publish`** run appears under the **Actions** tab — not as a
check on the PR — and deploys a preview of this PR at
`https://ORG.github.io/REPO/pr-<n>/`. A **fork** PR is skipped: forks never auto-publish,
because that run would hold a write token. A maintainer previews one by dispatching
`publish.yml` with the `pr` number.

:::{note} First-time exception
On a brand-new repo that first `Publish` run **fails** — there's no `main` build yet for
the versioned site to anchor on, and the default-branch guard refuses to publish a site
missing it. It clears the moment you merge (step 6). Every PR after that previews
normally. Because publishing is its own run, this failure does not mark your setup PR
red.
:::

## 5. Merge to main — your first deploy

Merging pushes to `main`, which builds `main`; the `Publish` run that follows assembles a
single-entry `switcher.json` and an `index.html` redirecting to `main/`, and deploys.
Visit `https://ORG.github.io/REPO/` — the redirect lands you on `main/` with the
switcher showing one entry. (The single-entry first deploy is graceful by design; no
release required.) From here on, every push to `main` redeploys and every internal PR
gets its own `/pr-<n>/` preview — each one a separate `Publish` run in the Actions tab.

## 6. Cut your first release

Tag the merged commit on `origin/main` and push the tag (tagging `origin/main`
rather than your local HEAD means you can release straight from a feature branch):

```bash
git fetch origin
git tag v1.0.0 origin/main
git push origin --tags   # or: git push origin v1.0.0 to push just this tag
```

The tag build runs and the **`release`** job creates the GitHub Release with that
build's `docs.zip` attached. This works on any repo, including ones with [immutable
releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
enabled (it attaches the asset as the release is created, before it's sealed).

:::{note} Without immutable releases
You can instead **publish a release from the GitHub UI** — that also creates the tag,
and the `release` job attaches `docs.zip` to the release you published. (This doesn't
work under immutable releases: a published immutable release can't receive assets
after the fact, so use the tag push above.)
:::

Either way, the next deploy's `publish` gathers that release, flags it `preferred` (★),
creates the `stable/` alias pointing at it, and points the root redirect at the constant
`stable/` URL. Your switcher now lists `main` and `1.0.0`, and
`https://ORG.github.io/REPO/stable/` always resolves to the latest release — a stable
URL for cross-project `objects.inv` references.

## Where next

- The [architecture explanation](../explanations/architecture.md) — why it works
  this way.
- The [workflow reference](../reference/workflows.md) — the `docs.yml`/`publish-gh-pages.yml`
  inputs and the `docs.zip` contract.
- Migrating an existing site? See
  [how-to: migrate from `gh-pages`](../how-to/migrate-from-gh-pages.md).

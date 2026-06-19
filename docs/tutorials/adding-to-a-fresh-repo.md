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

The `json-url` points at a `switcher.json` that does not exist yet — the `assemble`
action will generate it on your first deploy.

## 2. Set the Pages source to "GitHub Actions"

In **Settings → Pages**, set **Source** to **GitHub Actions** (not "Deploy from a
branch"). `deploy-pages` refuses to publish otherwise.

## 3. Add the CI workflows (a generic build + a thin entry)

The **build half is generic** — compute the version name, build at the versioned
`BASE_URL`, pack `docs.zip`, upload the `docs` artifact, and (on a fork PR) warn that
the preview won't auto-publish. This project's own reusable build workflow is below
verbatim; reuse it as-is, adapting the install/build steps (`npm ci` / `npm run docs`)
if you don't drive MyST through npm:

:::{literalinclude} ../../.github/workflows/_docs.yml
:language: yaml
:caption: .github/workflows/_docs.yml (a reusable `workflow_call` build)
:::

Then a thin **`ci.yml`** runs that build for every event and nests the publish
workflow — but only for internal events on your repo (the canonical-repo + non-fork
guard). Fork PRs build to verify, but never deploy:

```yaml
# .github/workflows/ci.yml
name: CI
on:
  pull_request:
  push: { branches: [main], tags: ['*'] }   # '*' never matches '/'

jobs:
  docs:
    uses: ./.github/workflows/_docs.yml

  # (optional) a tag-only release job attaching docs.zip + version-switcher.mjs.

  publish:
    needs: [docs]
    if: >-
      github.repository == 'ORG/REPO' &&
      ( github.event_name != 'pull_request' ||
        github.event.pull_request.head.repo.full_name == github.repository )
    uses: ./.github/workflows/_publish.yml
    with:
      version-name: ${{ needs.docs.outputs.version-name }}
    permissions:
      contents: read
      actions: read
      pages: write
      id-token: write
      statuses: write
```

## 4. Add the publish workflow (assemble + deploy)

This is the privileged half. It is reusable (`workflow_call`, nested by `ci.yml` for
internal events) and also directly dispatchable (`workflow_dispatch`, the fork-PR
opt-in). On the nested path it injects the just-built artifact so a `main`/tag push
publishes *this* build, not the previous one.

```yaml
# .github/workflows/_publish.yml
name: Publish
on:
  workflow_call:
    inputs:
      version-name: { required: true, type: string }
  workflow_dispatch:
    inputs:
      pr: { required: false }          # external fork PR number to approve + preview
permissions:
  contents: read
  actions: read
  pages: write
  id-token: write
  statuses: write
concurrency: { group: pages, cancel-in-progress: false }

jobs:
  publish:
    # The canonical-repo guard lives in ci.yml's publish job, not here.
    runs-on: ubuntu-latest
    environment: { name: github-pages, url: '${{ steps.deployment.outputs.page_url }}' }
    steps:
      - uses: actions/checkout@v5
        with: { fetch-depth: 0 }       # tags, for ordering + prerelease detection

      # Dispatch path: pin the fork PR's current head SHA as approved.
      - if: github.event_name == 'workflow_dispatch' && inputs.pr != ''
        env: { GH_TOKEN: '${{ github.token }}', REPO: '${{ github.repository }}', PR: '${{ inputs.pr }}' }
        run: |
          sha=$(gh pr view "$PR" --repo "$REPO" --json headRefOid -q .headRefOid)
          gh api --method POST "repos/$REPO/statuses/$sha" \
            -f state=success -f context=preview-approved -f description="Fork docs preview approved"

      # On the nested call, assemble downloads THIS run's `docs` artifact and stages
      # it as `artifact-version-name` (it isn't a completed success yet). Empty on
      # dispatch → a pure durable gather.
      - id: site
        uses: DiamondLightSource/myst-version-switcher-plugin/assemble@<tag>
        with:
          repo: ${{ github.repository }}
          artifact-version-name: ${{ inputs.version-name }}
      - uses: actions/upload-pages-artifact@v3
        with: { path: ${{ steps.site.outputs.dir }} }
      - id: deployment
        uses: actions/deploy-pages@v4
```

## 5. Allow the deploying refs in the `github-pages` environment

Because internal PRs and tags now deploy from **their own ref** (the publish job
runs inside their CI run), the `github-pages` environment's deployment policy must
allow those refs. In **Settings → Environments → github-pages**, it is recommended
to set **Deployment branches and tags** to **No restriction**.

## 6. First deploy

Push to `main`. CI builds `main`, the `publish` job assembles a single-entry
`switcher.json` and an `index.html` redirecting to `main/`, and deploys. Visit
`https://ORG.github.io/REPO/` — the redirect lands you on `main/` with the switcher
showing one entry. (The single-entry first deploy is graceful by design; no release
is required.)

## 7. Cut your first release

Tag a release and attach the built docs as a `docs.zip` asset (bare `html/` root) —
the easiest way is a tag-only job in `ci.yml` that downloads the `docs` artifact and
uploads it verbatim, alongside `version-switcher.mjs`.

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
- The [`assemble` action reference](../reference/action.md) — inputs, outputs, the
  `docs.zip` contract.
- Migrating an existing site? See
  [how-to: migrate from `gh-pages`](../how-to/migrate-from-gh-pages.md).

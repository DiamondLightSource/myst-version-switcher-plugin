---
site:
  hide_outline: false
---

# myst-version-switcher-plugin

A pydata-style documentation **version switcher** for [MyST](https://mystmd.org),
packaged as a single `anywidget` plugin — plus a CI action that generates the
`switcher.json` it reads.

The dropdown in the top-right corner of this page is the plugin itself. It also
works in any page body:

:::{version-switcher}
:json-url: https://diamondlightsource.github.io/myst-version-switcher-plugin/switcher.json
:::

## Quick start

Add the plugin to `myst.yml` and place the directive in your `navbar_end`:

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

The single `.mjs` is both the build-time MyST plugin and the browser runtime —
MyST localises it into your site and there is no second asset to host.

## Directive options

| option | required | default | meaning |
| --- | --- | --- | --- |
| `json-url` | yes | — | URL (absolute or root-relative) to `switcher.json` |
| `version-match` | no | auto-detect from URL | force the "current" version |
| `preserve-path` | no | `true` | carry the page path across versions vs go to the version root |
| `probe-target` | no | `true` | HEAD the target page and fall back to the version root if it 404s; set `false` for cross-origin switchers where the probe is CORS-blocked |
| `class` | no | — | extra container classes |

## Behaviour

**Path preservation + existence fallback.** On `/v1/x/y`, switching to v2 goes to
`/v2/x/y` when a HEAD probe finds it, else `/v2`. The probe is reliable
same-origin (the production gh-pages case); cross-origin probes can be
CORS-blocked and are treated as indeterminate — the path is kept rather than
stranding users at the root.

**Local dev.** On `localhost`, where no version URL prefixes the page path, the
widget synthesises a `local (dev)` entry rooted at `/` so the switcher is usable
during `myst start`.

**Stable alias.** The site serves a `stable/` copy of the newest release, so the
canonical entry URL never changes (handy for inter-project `objects.inv`
cross-references). Visiting a `…/stable/` page selects the concrete release it
aliases in the dropdown, and switching to a pinned version preserves the page
path onto it.

## Assembling + publishing the versioned site

Publishing is split into **two workflows**, so untrusted fork-PR builds can never
deploy:

- An **unprivileged CI workflow** builds the docs at `BASE_URL=/REPO/<token>` and
  uploads the build as a `docs` artifact (`docs.zip`, bare `html/` root). It runs
  for every PR (including forks), push to `main`, and tag — but never publishes.
  The version `<token>` is `pr-<number>` for PRs, else the ref name (`main`, or a
  tag without `/`).
- A **privileged publish workflow**, triggered by CI completing (`workflow_run`),
  runs the **`assemble`** action: it reconstructs the *whole* site from durable
  sources — `main`'s latest build, every release's `docs.zip` asset, and each
  **open PR**'s build artifact — writes `switcher.json` + a root redirect, creates
  the `stable/` alias, and outputs the site dir for `deploy-pages`. It publishes
  **directly to GitHub Pages** (no `gh-pages` branch).

Because the publish workflow always runs from the **default branch**, the
`github-pages` environment only needs to allow that one ref — tags and PRs deploy
through it, not from their own refs.

`switcher.json` is the standard pydata format, with the newest non-prerelease tag
flagged `preferred` (rendered with a ★):

```json
[
  { "version": "main", "url": "https://ORG.github.io/REPO/main/" },
  { "version": "2.1", "url": "https://ORG.github.io/REPO/2.1/", "preferred": true },
  { "version": "2.0", "url": "https://ORG.github.io/REPO/2.0/" }
]
```

Set your repo's **Pages source to "GitHub Actions"** (Settings → Pages), then add
the two workflows:

```yaml
# .github/workflows/ci.yml — build + verify (unprivileged; runs for forks)
name: CI
on:
  pull_request:
  push: { branches: [main], tags: ['*'] }   # '*' never matches '/'
jobs:
  docs:
    runs-on: ubuntu-latest
    permissions: { contents: read }
    steps:
      - uses: actions/checkout@v5
      - id: ver                              # pr-<n> on PRs, else main / a no-slash tag
        run: |
          if [ "${{ github.event_name }}" = pull_request ]; then
            echo "token=pr-${{ github.event.pull_request.number }}"
          else echo "token=${{ github.ref_name }}"; fi >> "$GITHUB_OUTPUT"
      - run: cd docs && myst build --html
        env: { BASE_URL: /REPO/${{ steps.ver.outputs.token }} }
      - run: ( cd docs/_build && zip -rq "$RUNNER_TEMP/docs.zip" html )
      - uses: actions/upload-artifact@v4
        with: { name: docs, path: ${{ runner.temp }}/docs.zip, compression-level: 0 }
  # + a tag-only `release` job attaching that docs.zip + version-switcher.mjs.
```

```yaml
# .github/workflows/publish.yml — assemble + deploy (privileged; upstream only)
name: Publish
on:
  workflow_run: { workflows: [CI], types: [completed] }
  workflow_dispatch: { inputs: { pr: { required: false } } }   # fork-PR opt-in
permissions: { contents: read, actions: read, pages: write, id-token: write, statuses: write }
concurrency: { group: pages, cancel-in-progress: false }
jobs:
  publish:
    if: >-
      github.repository == 'ORG/REPO' &&
      ( github.event_name == 'workflow_dispatch' ||
        ( github.event.workflow_run.conclusion == 'success' &&
          github.event.workflow_run.head_repository.full_name == github.repository ) )
    runs-on: ubuntu-latest
    environment: { name: github-pages, url: '${{ steps.deployment.outputs.page_url }}' }
    steps:
      - uses: actions/checkout@v5
        with: { fetch-depth: 0 }            # tags, for ordering + prerelease
      - id: site
        uses: DiamondLightSource/myst-version-switcher-plugin/assemble@<tag>
        with: { repo: ${{ github.repository }} }
      - uses: actions/upload-pages-artifact@v3
        with: { path: ${{ steps.site.outputs.dir }} }
      - id: deployment
        uses: actions/deploy-pages@v4
```

Released versions live as `docs.zip` assets — the CI build uploads the `docs`
artifact, your tag-only release step attaches that *same file* to the GitHub
Release verbatim, and `assemble` reconstructs the release from it. **Every PR
(internal or fork) builds the full site** to verify it; **internal PRs, `main`, and
tags publish** as soon as CI passes; an **external fork PR** publishes only after a
maintainer opts it in by running the publish workflow with its PR number
(`workflow_dispatch` → `pr`), which pins that commit as approved (a later push
drops it until re-approved). The first deploy (no releases) produces a single-entry
`switcher.json` and a redirect to the current version rather than failing.

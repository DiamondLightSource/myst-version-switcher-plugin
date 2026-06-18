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

Two composite actions reconstruct the whole versioned site from durable sources on
every deploy and publish it **directly to GitHub Pages** (no `gh-pages` branch):

- **`current-version`** (before the build) sanitises the ref into the version
  token so `BASE_URL` can be set.
- **`assemble`** (after the build) gathers this build, every release's `docs.zip`
  asset, and recent branch CI artifacts; writes `switcher.json` + a root redirect;
  uploads this build's `docs` artifact; creates the `stable/` alias; and outputs
  the assembled site dir for **you** to publish.

`switcher.json` is the standard pydata format, with the newest non-prerelease tag
flagged `preferred` (rendered with a ★):

```json
[
  { "version": "main", "url": "https://ORG.github.io/REPO/main/" },
  { "version": "2.1", "url": "https://ORG.github.io/REPO/2.1/", "preferred": true },
  { "version": "2.0", "url": "https://ORG.github.io/REPO/2.0/" }
]
```

Set your repo's **Pages source to "GitHub Actions"** (Settings → Pages), then wire
a build + deploy job pair:

```yaml
env:
  UPSTREAM: ORG/REPO    # pushes to a fork publish the contributor's own preview

jobs:
  build:
    runs-on: ubuntu-latest
    permissions: { contents: read, actions: read }
    steps:
      - uses: actions/checkout@v5
        with: { fetch-depth: 0 }          # tags, for version ordering
      - id: ver
        uses: DiamondLightSource/myst-version-switcher-plugin/current-version@<tag>
        with: { ref-name: ${{ github.ref_name }} }
      - run: cd docs && myst build --html
        env:
          BASE_URL: /REPO/${{ steps.ver.outputs.version }}   # versioned sub-path
      - id: site
        if: ${{ github.ref_type == 'tag' || github.ref_name == 'main' || github.repository != env.UPSTREAM }}
        uses: DiamondLightSource/myst-version-switcher-plugin/assemble@<tag>
        with:
          html-dir: docs/_build/html
          ref-name: ${{ github.ref_name }}
          required-branches: ${{ github.repository == env.UPSTREAM && 'main' || github.ref_name }}
      - if: ${{ steps.site.outcome == 'success' }}
        uses: actions/upload-pages-artifact@v3
        with: { path: ${{ steps.site.outputs.dir }} }

  deploy:
    needs: build
    if: ${{ github.ref_type == 'tag' || github.ref_name == 'main' || github.repository != 'ORG/REPO' }}
    runs-on: ubuntu-latest
    environment: { name: github-pages, url: '${{ steps.deployment.outputs.page_url }}' }
    permissions: { pages: write, id-token: write }
    concurrency: { group: pages, cancel-in-progress: false }
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

Released versions live as `docs.zip` assets — `assemble` packs the build into a
`docs.zip` (bare `html/` root) and uploads it as the `docs` artifact, so your
release step can attach that same file to the tag's GitHub Release verbatim and
`assemble` can later reconstruct it. Base-repo PRs only build-check; a fork's own push
publishes a preview to the fork's Pages. The first deploy (no releases) produces a
single-entry `switcher.json` and a redirect to the current version rather than
failing.

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

**Local dev.** On `localhost`, where no gh-pages version URL prefixes the page
path, the widget synthesises a `local (dev)` entry rooted at `/` so the switcher
is usable during `myst start`.

## Generating switcher.json

The `switcher` composite action reads your repo's tags and `origin/gh-pages` to
produce a `switcher.json` in the standard pydata format:

```json
[
  { "version": "main", "name": "main (dev)", "url": "https://ORG.github.io/REPO/main/" },
  { "version": "2.1", "name": "2.1 (stable)", "url": "https://ORG.github.io/REPO/2.1/", "preferred": true },
  { "version": "2.0", "url": "https://ORG.github.io/REPO/2.0/" }
]
```

Wire it into your docs workflow after staging the built HTML and before publishing:

```yaml
- uses: actions/checkout@v5
  with:
    fetch-depth: 0            # tags + origin/gh-pages, for the version list
- run: echo "DOCS_VERSION=${GITHUB_REF_NAME//[^A-Za-z0-9._-]/_}" >> $GITHUB_ENV
- run: cd docs && myst build --html
  env:
    BASE_URL: /<repo>/${{ env.DOCS_VERSION }}  # required for versioned sub-path
- run: mv docs/_build/html .github/pages/$DOCS_VERSION
- uses: DiamondLightSource/myst-version-switcher-plugin/switcher@<tag>
  with:
    version: ${{ env.DOCS_VERSION }}
    repo: ${{ github.repository }}
    output: .github/pages/switcher.json   # where to write it (required)
- uses: peaceiris/actions-gh-pages@v4
  with:
    publish_dir: .github/pages
    keep_files: true
```

The action **only writes `switcher.json`** — staging (`mv`) and publishing stay in
the workflow. `fetch-depth: 0` is the consumer's responsibility. On the first
deploy, when `origin/gh-pages` does not yet exist, the action produces a
single-entry `switcher.json` for the current version rather than failing.

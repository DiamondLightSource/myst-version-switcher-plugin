# version-switcher

A pydata-style documentation **version switcher** for [MyST](https://mystmd.org),
packaged as a single MyST plugin that renders through the `anywidget` interface —
no theme source changes.

The `{version-switcher}` directive emits an `anywidget` node. At runtime the widget
fetches a pydata `switcher.json`, works out which version the current page belongs
to (from the URL), and renders a `<select>` that navigates to the **same page** in
the chosen version — falling back to that version's root when the page doesn't
exist there.

## Usage

Register the plugin and place the directive (typically in the `navbar_end` part of
the book theme):

```yaml
# myst.yml
project:
  plugins:
    - https://github.com/DiamondLightSource/myst-version-switcher-plugin/releases/download/v0.1.0/version-switcher.mjs
site:
  template: book-theme
  parts:
    navbar_end: navbar_end.md
```

```markdown
<!-- navbar_end.md -->
:::{version-switcher}
:json-url: https://ORG.github.io/REPO/switcher.json
:::
```

The single `.mjs` is **both** the build-time plugin and the browser runtime: the
directive points the widget's `esm` back at this file (via `import.meta.url`), so
MyST localizes it into your site — there is no second asset and no module URL to
host.

## switcher.json (standard pydata format)

```json
[
  { "version": "main", "name": "main (dev)", "url": "https://ORG.github.io/REPO/main/" },
  { "version": "2.1", "name": "2.1 (stable)", "url": "https://ORG.github.io/REPO/2.1/", "preferred": true },
  { "version": "2.0", "url": "https://ORG.github.io/REPO/2.0/" }
]
```

Generate it in CI with the bundled [`switcher` action](../../switcher/action.yml).

## Directive options

| option | required | default | meaning |
| --- | --- | --- | --- |
| `json-url` | yes | — | URL (absolute or root-relative) to `switcher.json` |
| `version-match` | no | auto-detect from URL | force the "current" version |
| `preserve-path` | no | `true` | carry the page path across versions vs go to the version root |
| `probe-target` | no | `true` | HEAD the target page and fall back to the version root if it 404s; set `false` for cross-origin switchers where the probe is CORS-blocked |
| `esm` | no | self-reference | dev override pointing at a locally served copy of this module |
| `class` | no | — | extra container classes |

## Behaviour notes

- **Path preservation + existence fallback.** On `/v1/x/y`, switching to v2 goes to
  `/v2/x/y` when a HEAD probe finds it, else `/v2`. The probe is reliable
  same-origin (the production gh-pages case); cross-origin probes can be
  CORS-blocked and are treated as indeterminate → the path is kept (never
  stranding users at the root).
- **Local dev.** On `localhost`, where no gh-pages version URL prefixes the page
  path, the widget synthesizes a `local (dev)` entry rooted at `/` so the switcher
  is usable in `myst start`.

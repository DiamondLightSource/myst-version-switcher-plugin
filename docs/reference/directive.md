# Reference: the `version-switcher` directive

The plugin registers one MyST directive, `version-switcher`, rendered as an
`anywidget`. Place it wherever you want the dropdown — typically the `navbar_end`
part, but it works in any page body.

```markdown
:::{version-switcher}
:json-url: https://ORG.github.io/REPO/switcher.json
:::
```

## Options

| option | required | default | meaning |
| --- | --- | --- | --- |
| `json-url` | yes | — | URL (absolute or root-relative) to a pydata-format `switcher.json`. |
| `version-match` | no | auto-detect from the URL | Force the "current" version instead of detecting it from the page path. |
| `preserve-path` | no | `true` | Carry the current page path across versions (vs. jumping to the version root). |
| `probe-target` | no | `true` | HEAD-probe the target page and fall back to the version root if it 404s. Set `false` for cross-origin switchers where the probe is CORS-blocked. |
| `class` | no | — | Extra class names for the widget container. |

Booleans default to `true` unless explicitly set to `false`.

## `switcher.json` format

Standard pydata format — an array of `{ version, url }`, with the preferred
(newest non-prerelease) entry flagged `preferred` and rendered with a ★:

```json
[
  { "version": "main", "url": "https://ORG.github.io/REPO/main/" },
  { "version": "2.1", "url": "https://ORG.github.io/REPO/2.1/", "preferred": true },
  { "version": "2.0", "url": "https://ORG.github.io/REPO/2.0/" }
]
```

The `assemble` action generates this file for you (see the
[workflow reference](./workflows.md)); you only point `json-url` at it.

## Behaviour

**Path preservation + existence fallback.** On `/v1/x/y`, switching to v2 goes to
`/v2/x/y` when a HEAD probe finds it, else `/v2`. The probe is reliable same-origin
(the production GitHub Pages case); cross-origin probes can be CORS-blocked and are
treated as indeterminate — the path is kept rather than stranding users at the root.
Set `probe-target: false` to skip probing entirely.

**Local dev.** On `localhost`, where no version prefix precedes the page path, the
widget synthesises a `local (dev)` entry rooted at `/` so the switcher is usable
during `myst start`.

**Stable alias.** The site serves a `stable/` copy of the newest release, so the
canonical entry URL never changes (handy for inter-project `objects.inv`
cross-references). Visiting a `…/stable/` page selects the concrete release it
aliases in the dropdown, and switching to a pinned version preserves the page path
onto it. The `stable` segment name is a fixed convention. See the
[architecture explanation](../explanations/architecture.md#stable-alias).

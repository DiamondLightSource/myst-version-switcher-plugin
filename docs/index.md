---
site:
  hide_outline: true
---

# myst-version-switcher-plugin

A pydata-style documentation **version switcher** for MyST, packaged as a single
`anywidget` plugin — plus a CI action that generates the `switcher.json` it reads.

The dropdown in the top-right of this site is the plugin itself, configured in
[`navbar_end.md`](https://github.com/DiamondLightSource/myst-version-switcher-plugin/blob/main/docs/navbar_end.md).

- **Plugin usage & options** — see the [plugin README](https://github.com/DiamondLightSource/myst-version-switcher-plugin/blob/main/plugins/version-switcher/README.md).
- **Directive demo** — see the [example page](../plugins/version-switcher/example.md).
- **CI switcher generation** — the [`switcher` composite action](https://github.com/DiamondLightSource/myst-version-switcher-plugin/blob/main/switcher/action.yml).

## What it does

At runtime the widget fetches `switcher.json`, detects the current version from the
page URL, and renders a `<select>` that navigates to the **same page** in the
chosen version — falling back to that version's root when the page doesn't exist
there.

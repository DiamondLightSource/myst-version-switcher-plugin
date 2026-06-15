---
title: version-switcher example
---

# version-switcher

The `{version-switcher}` directive renders a pydata-style version dropdown. It is
normally placed in the book theme's `navbar_end` part, but works in any page body.

:::{version-switcher}
:json-url: https://diamondlightsource.github.io/myst-version-switcher-plugin/switcher.json
:::

The dropdown above is populated at runtime from `switcher.json`; picking a version
navigates to the same page in that version (or the version root if the page does
not exist there).

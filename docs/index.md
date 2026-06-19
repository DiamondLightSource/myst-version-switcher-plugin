---
site:
  hide_outline: true
---

```{include} ../README.md
:end-before: <!-- README only content
```

The dropdown in the top-right corner of this page is the plugin itself. It also
works in any page body:

:::{version-switcher}
:json-url: https://diamondlightsource.github.io/myst-version-switcher-plugin/switcher.json
:::

## How the documentation is structured

Documentation is split into [four categories](https://diataxis.fr), also accessible
from the links in the top bar.

::::{grid} 2

:::{card} Tutorial
:link: tutorials.md

Add versioned docs to a fresh repo, start to finish. New users start here.
:::

:::{card} How-to Guides
:link: how-to.md

Practical step-by-step guides — e.g. migrating from an existing `gh-pages` site.
:::

:::{card} Explanation
:link: explanations.md

How the reconstruct-from-sources model works, and why it works that way.
:::

:::{card} Reference
:link: reference.md

The `version-switcher` directive options and the `assemble` action contract.
:::

::::

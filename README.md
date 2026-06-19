# myst-version-switcher-plugin

A pydata-style documentation **version switcher** for [MyST](https://mystmd.org),
delivered as a single `anywidget` plugin **plus** an `assemble` CI action that
reconstructs the whole versioned docs site from durable sources every deploy and
publishes it directly to GitHub Pages.

The two halves are versioned together under one `vX.Y.Z` tag but consumed
differently — the plugin as a release asset, the action from the repo tree:

What            | Where
:---:           | :---:
Plugin (widget) | `plugins/version-switcher.mjs` → a release-asset URL in `myst.yml` `plugins`
Site action     | `assemble/` → `uses: …/assemble@<tag>` in your CI workflow
Source          | <https://github.com/DiamondLightSource/myst-version-switcher-plugin>
Documentation   | <https://diamondlightsource.github.io/myst-version-switcher-plugin>
Releases        | <https://github.com/DiamondLightSource/myst-version-switcher-plugin/releases>

The single `.mjs` is both the build-time MyST plugin and the browser runtime — MyST
localises it into your site, so there is no second asset to host. The `assemble`
action rebuilds the *complete* site every deploy (main's build, each release's
`docs.zip`, every open PR's artifact), so deletions self-heal and there is no
`gh-pages` branch to drift.

<!-- README only content. Anything below this line won't be included in index.md -->

See <https://diamondlightsource.github.io/myst-version-switcher-plugin> for the full
documentation: a [tutorial](https://diamondlightsource.github.io/myst-version-switcher-plugin/tutorials/adding-to-a-fresh-repo)
for adding it to a fresh repo, how-to guides, the architecture explanation, and the
directive + action reference.

Contributing: see [`.github/CONTRIBUTING.md`](.github/CONTRIBUTING.md).

## License

Apache-2.0.

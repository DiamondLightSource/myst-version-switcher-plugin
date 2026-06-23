# myst-version-switcher-plugin

A pydata-style documentation **version switcher** for [MyST](https://mystmd.org),
delivered as a single `anywidget` plugin **plus** reusable CI workflows that build
your docs and reconstruct the whole versioned site from durable sources every deploy,
publishing it directly to GitHub Pages.

The two halves are versioned together under one `vX.Y.Z` tag but consumed
differently — the plugin as a release asset, the workflows by `uses:` at that tag:

What                  | Where
:---:                 | :---:
Plugin (widget)       | `plugins/version-switcher.mjs` → a release-asset URL in `myst.yml` `plugins`
Reusable CI workflows | `.github/workflows/{docs,publish}.yml` → `uses: …/.github/workflows/{docs,publish}.yml@<tag>` in your `ci.yml`
Source                | <https://github.com/DiamondLightSource/myst-version-switcher-plugin>
Documentation         | <https://diamondlightsource.github.io/myst-version-switcher-plugin>
Releases              | <https://github.com/DiamondLightSource/myst-version-switcher-plugin/releases>

The single `.mjs` is both the build-time MyST plugin and the browser runtime — MyST
localises it into your site, so there is no second asset to host. The `publish.yml`
workflow rebuilds the *complete* site every deploy (the default branch's build, each
release's `docs.zip`, every open PR's artifact), so deletions self-heal and there is
no `gh-pages` branch to drift.

<!-- README only content. Anything below this line won't be included in index.md -->

See <https://diamondlightsource.github.io/myst-version-switcher-plugin> for the full
documentation: a [tutorial](https://diamondlightsource.github.io/myst-version-switcher-plugin/tutorials/adding-to-a-fresh-repo)
for adding it to a fresh repo, how-to guides, the architecture explanation, and the
directive + workflow reference.

Contributing: see [`.github/CONTRIBUTING.md`](.github/CONTRIBUTING.md).

## License

Apache-2.0.

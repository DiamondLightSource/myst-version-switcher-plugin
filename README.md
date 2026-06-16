# myst-version-switcher-plugin

A pydata-style documentation **version switcher** for [MyST](https://mystmd.org),
delivered as a single `anywidget` plugin plus a CI action that generates the
`switcher.json` the widget reads.

**[Full documentation and usage guide →](https://diamondlightsource.github.io/myst-version-switcher-plugin/)**

The two halves are versioned together under a single `vX.Y.Z` tag but consumed
differently:

| half | file | how consumers use it |
|------|------|----------------------|
| Plugin (widget) | `plugins/version-switcher/version-switcher.mjs` | release-asset URL in `myst.yml` `plugins` |
| Switcher action | `switcher/` | `uses: DiamondLightSource/myst-version-switcher-plugin/switcher@<tag>` |

## Developing

```bash
npm test                    # run the test suite
cd docs && myst start       # live-preview docs with the plugin loaded from local plugins/
```

`docs/myst.yml` loads the plugin from the local `plugins/` path (not a release
URL), so edits are reflected on rebuild. `<select>` popups don't open in the
VS Code Simple Browser — open the forwarded port in a real browser and
hard-reload (MyST caches the localised esm).

## Releasing

```bash
git tag vX.Y.Z && git push origin vX.Y.Z
```

CI runs tests and the docs build/deploy, then `_release.yml` publishes a GitHub
Release with `version-switcher.mjs` as an asset. The `switcher` action is
consumed from the repo tree at the same tag, so one tag versions both halves.

## License

Apache-2.0.

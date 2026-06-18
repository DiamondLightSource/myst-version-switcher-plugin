# myst-version-switcher-plugin

A pydata-style documentation **version switcher** for [MyST](https://mystmd.org),
delivered as a single `anywidget` plugin plus a pair of CI actions that
reconstruct the whole versioned docs site every deploy and publish it to GitHub
Pages.

**[Full documentation and usage guide →](https://diamondlightsource.github.io/myst-version-switcher-plugin/)**

The two halves are versioned together under a single `vX.Y.Z` tag but consumed
differently:

| half | file | how consumers use it |
|------|------|----------------------|
| Plugin (widget) | `plugins/version-switcher.mjs` | release-asset URL in `myst.yml` `plugins` |
| Site actions | `current-version/`, `assemble/` | `uses: DiamondLightSource/myst-version-switcher-plugin/{current-version,assemble}@<tag>` |

## Developing

```bash
npm test                    # run the test suite
npm run docs                # build docs (same command CI uses)
npm run docs-dev            # live-preview docs with the plugin loaded from local plugins/
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
Release with `version-switcher.mjs` (and the tag's `docs.zip`) as assets. The
`current-version` + `assemble` actions are consumed from the repo tree at the
same tag, so one tag versions both halves.

## License

Apache-2.0.

# myst-version-switcher-plugin

A pydata-style documentation **version switcher** for [MyST](https://mystmd.org),
delivered as a single `anywidget` plugin, **plus** a CI action that generates the
`switcher.json` the widget reads.

The two halves have different lifecycles and are kept separate:

| half | what | where | how consumers use it |
| --- | --- | --- | --- |
| **consumer** (build/runtime) | the `{version-switcher}` directive + anywidget runtime | [`plugins/version-switcher/version-switcher.mjs`](plugins/version-switcher/version-switcher.mjs) — one self-referential `.mjs` | a release-asset URL in `myst.yml` `plugins` |
| **producer** (CI/deploy) | generate `switcher.json` from the deployed versions | [`switcher/`](switcher/) — composite action + `make-switcher.mjs` | `uses: …/switcher@<tag>` |

## Repository layout

```
plugins/version-switcher/   # the plugin (mirrors jupyter-book/myst-plugins /plugins/<name>/)
  version-switcher.mjs       #   single file: MyST directive + anywidget render + self-esm
  example.md                 #   directive demo
  README.md                  #   plugin usage + options
switcher/                    # DLS producer (NOT a MyST plugin)
  action.yml                 #   composite action: stage versioned dir + write switcher.json
  make-switcher.mjs          #   dependency-free Node switcher generator (git-derived)
test/                        # node unit tests (widget logic + make-switcher parity)
docs/                        # this repo's own MyST docs, dogfooding the plugin
.github/workflows/           # ci.yml (tests + docs build), release.yml (tag → asset)
```

## Using it in another repo

Pin one version (`<tag>`) in two template-rendered files; with copier, a single
Jinja variable fills both and `copier update` keeps them in step.

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

```yaml
# .github/workflows/docs.yml — after `myst build --html`, before the gh-pages publish
- uses: DiamondLightSource/myst-version-switcher-plugin/switcher@<tag>
  with:
    version: ${{ env.DOCS_VERSION }}
    repo: ${{ github.repository }}
# then publish `pages_dir` (default .github/pages) with peaceiris keep_files: true
```

The action fetches its own tags + `gh-pages` tree, so the consumer's `checkout`
needs **no** `fetch-depth: 0`. No `esm` to configure: the directive points the
widget back at its own module file, which MyST localizes into your site.

## Developing

```bash
npm test                      # widget logic + make-switcher parity
cd docs && myst start         # live-preview this repo's docs with the plugin
```

`docs/myst.yml` loads the plugin from the local `plugins/` path (not a release
URL), so edits show up on rebuild. For browser caveats (`<select>` popups don't
open in the VS Code Simple Browser; MyST caches the localized esm), open the
forwarded port in a real browser and hard-reload.

## Releasing

Push a `vX.Y.Z` tag. `release.yml` runs the tests and publishes a GitHub Release
whose asset is `version-switcher.mjs` (the plugin URL consumers pin). The
`switcher` action is consumed from the repo tree at the same tag, so the tag is the
single version for both halves.

## Upstreaming

The `plugins/version-switcher/` directory mirrors
[`jupyter-book/myst-plugins`](https://github.com/jupyter-book/myst-plugins)
conventions (a self-contained, self-referential single `.mjs` distributed via
GitHub releases) so the plugin can later be contributed there; the `switcher/`
producer is DLS deployment infrastructure and stays here.

## License

Apache-2.0.

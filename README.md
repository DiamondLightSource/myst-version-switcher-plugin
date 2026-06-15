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
.github/workflows/           # ci.yml orchestrator -> reusable _test/_docs/_release.yml
                             #   (docs part mirrors python-copier-template-example)
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
# .github/workflows/docs.yml (mirrors python-copier-template-example _docs.yml)
- uses: actions/checkout@v5
  with:
    fetch-depth: 0            # tags + origin/gh-pages, for the version list
# … build: `cd docs && myst build --html` (BASE_URL=/REPO/$DOCS_VERSION) …
- run: mv docs/_build/html .github/pages/$DOCS_VERSION
- uses: DiamondLightSource/myst-version-switcher-plugin/switcher@<tag>
  with:
    version: ${{ env.DOCS_VERSION }}
    repo: ${{ github.repository }}
    # output defaults to .github/pages/switcher.json
- uses: peaceiris/actions-gh-pages@v4        # publish_dir: .github/pages, keep_files: true
```

The `switcher` action **only writes `switcher.json`** — staging the versioned dir
(`mv`) and publishing stay in the workflow, matching the template's step layout. It
reads tags + `origin/gh-pages`, so the consumer's `checkout` uses `fetch-depth: 0`.
No `esm` to configure: the directive points the widget back at its own module file,
which MyST localizes into your site.

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

Push a `vX.Y.Z` tag. `ci.yml` runs the tests and the docs build/deploy, then (on a
tag) `_release.yml` publishes a GitHub Release whose asset is `version-switcher.mjs`
(the plugin URL consumers pin). The `switcher` action is consumed from the repo tree
at the same tag, so the tag is the single version for both halves. This repo's own
docs deploy to gh-pages on `main` and on tags, dogfooding the action.

## Upstreaming

The `plugins/version-switcher/` directory mirrors
[`jupyter-book/myst-plugins`](https://github.com/jupyter-book/myst-plugins)
conventions (a self-contained, self-referential single `.mjs` distributed via
GitHub releases) so the plugin can later be contributed there; the `switcher/`
producer is DLS deployment infrastructure and stays here.

## License

Apache-2.0.

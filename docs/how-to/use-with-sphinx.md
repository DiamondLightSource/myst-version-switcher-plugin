# How-to: use the workflows with a Sphinx project

The two reusable workflows are build-tool-agnostic: `docs.yml` only needs a command
that turns your sources into HTML, and `publish.yml` only needs the `docs.zip`
contract. A Sphinx project using
[pydata-sphinx-theme](https://pydata-sphinx-theme.readthedocs.io) doesn't even need
this project's plugin — the theme has a **built-in version switcher that reads the
same pydata-format `switcher.json`** that `publish.yml` generates.

:::{note} python-copier-template
This setup will be rolled into a copier update in a later release of
[python-copier-template](https://github.com/DiamondLightSource/python-copier-template),
so repos generated from that template will pick it up via `copier update` rather than
by following this page by hand.
:::

## 1. Configure the theme's switcher in `conf.py`

`docs.yml` exports two env vars to your build: `BASE_URL` (the sub-path this build is
served at, `/REPO/<version-name>`) and `VERSION_NAME` (the bare version token —
`pr-<n>`, the default branch, or the tag). Wire them into the theme:

```python
# docs/conf.py
import os

version_name = os.environ.get("VERSION_NAME", "local")

html_theme = "pydata_sphinx_theme"
html_theme_options = {
    "switcher": {
        "json_url": "https://ORG.github.io/REPO/switcher.json",
        "version_match": version_name,
    },
    "navbar_end": ["version-switcher", "theme-switcher", "navbar-icon-links"],
    # switcher.json doesn't exist until the first deploy; don't fail the build on it.
    "check_switcher": False,
}
```

Unlike MyST's book-theme, Sphinx emits *relative* asset URLs, so the build doesn't
strictly need `BASE_URL` to render correctly — but `version_match` is what makes the
dropdown highlight the version being viewed.

## 2. Call the workflows from your CI

Exactly as in the [tutorial](../tutorials/adding-to-a-fresh-repo.md), with a Sphinx
build command and its output directory:

```yaml
# .github/workflows/ci.yml (docs + publish jobs)
jobs:
  docs:
    uses: DiamondLightSource/myst-version-switcher-plugin/.github/workflows/docs.yml@__LATEST_TAG__
    with:
      build-command: uv run --locked tox -e docs        # or: sphinx-build -T docs build/html
      html-dir: build/html              # wherever your build writes the HTML

  release:
    needs: [docs]
    if: github.ref_type == 'tag'
    uses: DiamondLightSource/myst-version-switcher-plugin/.github/workflows/release.yml@__LATEST_TAG__
    permissions:
      contents: write
```

`ci.yml` has no publish job: `publish.yml` picks the run up on `workflow_run` once CI
completes.

`uv` is preinstalled by `docs.yml` (honouring a committed `.python-version`), so
`build-command` can equally be `uv run sphinx-build …`. Add `publish.yml` and set the
Pages source / environment policy exactly as the
[tutorial](../tutorials/adding-to-a-fresh-repo.md) describes — none of that is
MyST-specific.

## 3. Intersphinx via the `stable/` alias

Sphinx writes relative URIs into `objects.inv`, so other projects can point
intersphinx at the constant alias and their references always resolve against your
latest release:

```python
intersphinx_mapping = {
    "REPO": ("https://ORG.github.io/REPO/stable/", None),
}
```

## Migrating an existing Sphinx `gh-pages` site

The [gh-pages migration](./migrate-from-gh-pages.md) applies unchanged — it operates
on the `gh-pages` tree and Releases, not on the build tool. If the old site published
the default branch's docs under a directory not named after the branch (some setups
use `latest/`), pass `--seed-from <dir>` to the prepare run.

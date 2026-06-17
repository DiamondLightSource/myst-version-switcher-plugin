# Design note: versioned docs publishing

Status: **proposed** (not yet implemented). Captures the planned move from the
current "switcher writes two files, caller stages + publishes to a `gh-pages`
branch with `keep_files`" model to a single action that **reconstructs the whole
versioned site from durable sources on every deploy and deploys it directly to
GitHub Pages** (no `gh-pages` branch).

## Why change

The current model (mirrored from `python-copier-template-example`) has three
problems for a MyST/book-theme site:

1. **The CI `docs.zip` artifact is not locally previewable.** book-theme emits
   *root-absolute* asset URLs (`/build/_assets/app.css`) regardless of `BASE_URL`,
   so opening `index.html` over `file://` resolves assets against the filesystem
   root → 404 → unstyled, un-hydrated, broken inter-page links. There is no
   relative-path mode. The Sphinx-style "download zip, double-click index.html"
   workflow simply does not apply. Local preview = `myst start`, or serve a
   `BASE_URL`-free build over HTTP.
2. **`BASE_URL` is mandatory and per-version.** Each version lives at
   `/<repo>/<version>/` and must be built with `BASE_URL=/<repo>/<version>`. One
   build cannot serve two paths.
3. **`keep_files: true` accumulation drifts.** The published site is whatever has
   piled up on `gh-pages` over time; there is no single source of truth, and the
   branch history grows without bound.

## New model: reconstruct from durable sources

Every deploy rebuilds the **complete** site tree from authoritative inputs and
deploys it **directly to GitHub Pages** via `actions/upload-pages-artifact` +
`actions/deploy-pages`. There is **no `gh-pages` branch** — `deploy-pages`
publishes one artifact as the *entire* site, which is exactly the
whole-site-replace model this design wants. (Repo setting: Settings → Pages →
Source must be **GitHub Actions**, not "Deploy from a branch".)

| version kind | source | durability |
|---|---|---|
| current build | the `_build/html` passed in to the action | n/a (just built) |
| released tags | `docs.zip` attached to each **GitHub Release** | permanent |
| branch previews (e.g. `main`) | latest successful CI run's `docs` **artifact** | ephemeral (fine — branches move) |

Releases are permanent, so old versions never vanish. Branch previews come from
CI artifacts and silently drop if the artifact has expired and the branch hasn't
rebuilt — acceptable for dev/preview docs.

There is no `gh-pages` branch at all — neither source nor target. This removes the
`origin/gh-pages` fetch requirement (we still need tags for ordering).

### `docs.zip` contract

- Contains a **bare `html/` directory** at its root (`unzip docs.zip` → `html/`).
- Built with `BASE_URL=/<repo>/<version>` matching the sub-path it will be served
  at. A mismatch produces a version whose assets 404 — the build step (caller's
  responsibility) owns this.
- Published two ways by the action: as a CI artifact named `docs` (every run), and
  attached to the GitHub Release (tag runs) so it is durable.

## The expanded action

One composite action does the full pipeline, starting from an already-built
`_build/html`. The action does **not** run `myst build` — `BASE_URL` is set by the
caller at build time (see contract above).

Proposed location: rename `switcher/` → `deploy/` (it is no longer just the
switcher). The Node logic stays co-located and unit-testable.

### Inputs

| input | required | default | meaning |
|---|---|---|---|
| `html-dir` | yes | — | path to the freshly built docs (e.g. `docs/_build/html`) |
| `version` | yes | — | sanitised name for this build (`main`, `v2.1.0`) |
| `repo` | no | `${{ github.repository }}` | `org/repo`, for version URLs |
| `branches` | no | default branch | branch previews to include (besides released tags) |
| `deploy` | no | `false` | actually push to gh-pages (gate off for PRs) |
| `token` | no | `${{ github.token }}` | API access: release assets + cross-run artifacts |

### Pipeline

```
work/site/                      ← assembled publish root
  index.html                    ← redirect to preferred (newest stable) version
  switcher.json
  <version>/ …                  ← every gathered version

1. Stage current build
     cp -r $html-dir  work/site/$version/

2. Package + publish this build's docs.zip   (bare html/ inside)
     (cd "$(dirname "$html-dir")" && zip -r work/docs.zip html)
     actions/upload-artifact  name=docs  path=work/docs.zip      # every run
     if tag:  gh release upload "$version" work/docs.zip --clobber   # durable

3. Gather released versions (durable, authoritative)
     for tag in $(gh release list --json tagName -q '.[].tagName'):
       [ "$tag" = "$version" ] && continue
       gh release download "$tag" -p docs.zip -O r.zip || continue   # missing → skip
       unzip r.zip 'html/*' -d t && mv t/html work/site/$tag

4. Gather branch previews (ephemeral)
     for br in $branches:
       [ "$br" = "$version" ] && continue
       rid=$(gh run list --branch "$br" --workflow ci.yml --status success \
               -L1 --json databaseId -q '.[0].databaseId')
       gh run download "$rid" -n docs -D t || continue              # expired → skip
       unzip t/docs.zip 'html/*' -d t2 && mv t2/html work/site/$br

5. Generate switcher.json + redirect
     node assemble.mjs --site-dir work/site --repo "$repo"
       # versions discovered from work/site/ subdirs; tags (git) drive ordering
       # + prerelease detection; preferred = newest stable tag present

6. Publish to Pages (gated; needs job environment + permissions — see below)
     if deploy:
       actions/upload-pages-artifact  path=work/site
       actions/deploy-pages
```

`deploy-pages` publishes the uploaded tree as the *entire* site (no merge), so a
stale branch preview that is no longer gathered is correctly dropped — exactly the
whole-tree-replace this design relies on. Note the `github-pages` artifact that
`upload-pages-artifact` produces is distinct from the per-version `docs` artifact
in step 2. Because `deploy-pages` is job-scoped, the **caller's job** must set
`environment: github-pages` and the Pages permissions; a composite action cannot
declare those itself.

### What stays in the caller workflow

Only build + invoke — but the job must carry the Pages `environment` and
permissions, since `deploy-pages` (run inside the action) is job-scoped:

```yaml
jobs:
  docs:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
    permissions:
      contents: read    # checkout + read release assets (write only if THIS action attaches docs.zip — decision #2)
      actions: read     # download other runs' artifacts (cross-run)
      pages: write      # deploy to Pages
      id-token: write   # deploy-pages OIDC
    steps:
      - uses: actions/checkout@v5
        with: { fetch-depth: 0 }          # tags, for ordering + prerelease
      - run: cd docs && myst build --html
        env:
          BASE_URL: /<repo>/${{ env.DOCS_VERSION }}
      - uses: DiamondLightSource/myst-version-switcher-plugin/deploy@<tag>
        with:
          html-dir: docs/_build/html
          version: ${{ env.DOCS_VERSION }}
          deploy: ${{ github.ref_type == 'tag' || github.ref_name == 'main' }}
```

## Reused vs. new logic

The pure functions already in `make-switcher.mjs` carry over unchanged:
`orderVersions`, `isPrerelease`, `preferredVersion`, `switcherStruct`,
`renderSwitcher`, `renderRedirect`. Only the **version source** changes:

- **Drop** `getBranchContents("origin/gh-pages")` (git ls-tree of the publish
  branch).
- **Add** `discoverVersions(siteDir)` = directory names under the assembled
  `work/site/`. The current version is already a dir (step 1), so the `--add`
  flag goes away.
- `main()`/`assemble.mjs` reads `--site-dir` instead of an `--output-dir`, and
  writes `switcher.json` + `index.html` into that same dir.

This keeps the testable core intact; the new IO (gh download, unzip, publish) is
shell/`gh`/actions glue, integration-tested via a dry run.

### Permissions

```yaml
permissions:
  pages: write      # deploy to Pages
  id-token: write   # deploy-pages OIDC
  contents: read    # checkout + download release assets
  actions: read     # download other runs' artifacts (cross-run)
```

Plus `environment: { name: github-pages }` at job level. `contents: write` is only
needed if *this* action attaches `docs.zip` to releases (decision #2); otherwise
`_release.yml` owns that. `gh` is preinstalled on GitHub runners. Cross-run
artifact download needs `gh run download <id>` (the `actions/download-artifact`
action only sees the current run).

## Edge cases

- **First deploy:** no releases, `branches=main`, current=`main` → site has only
  `main/`; switcher is single-entry; redirect → `main`. Graceful, same as today.
- **Release without `docs.zip`** (cut before this scheme): `gh release download`
  fails for that asset → skip that version. No hard failure.
- **Expired branch artifact:** skip; that preview is absent until the branch
  rebuilds.
- **Prereleases:** still excluded from `preferred`/redirect (the `a`/`b`/`rc`
  test, parity with `_release.yml`), but they still appear in the switcher if
  their `docs.zip`/artifact was gathered.
- **Concurrency:** gate with `concurrency: { group: "pages", cancel-in-progress: false }`.
  `deploy-pages` replaces the *entire* site, so it is last-writer-wins;
  reconstructing from durable sources makes this mostly self-healing, except a
  release created moments earlier may not yet be visible to an in-flight run.
  GitHub also serialises deployments to the `github-pages` environment.
- **Scaling:** every deploy downloads every release's `docs.zip`. Fine for tens of
  releases; if it grows, cache downloads keyed by release id / asset digest.

## Open decisions

1. **Action name/path.** Recommend `deploy/` (consumed as `…/deploy@<tag>`); keep
   the Node modules beside it. `switcher/` is now a misnomer. No back-compat
   required, so a clean rename is fine.
2. **Who attaches `docs.zip` to the Release?** Either this action on tag runs
   (`gh release upload --clobber`, must run after the release exists) or
   `_release.yml` (which already creates the release) downloads the `docs`
   artifact and attaches it. Leaning toward `_release.yml` owning release assets
   for separation of concerns; the deploy action only uploads the CI artifact.
3. ~~Direct Pages publish vs. `gh-pages` branch.~~ **Resolved: direct publish.**
   Step 6 uses `actions/upload-pages-artifact` + `actions/deploy-pages`; there is
   no `gh-pages` branch. Requires the repo's Pages source set to **GitHub
   Actions** and the job `environment`/permissions above.

## Implementation phases

1. Refactor `make-switcher.mjs` → `assemble.mjs`: replace gh-pages discovery with
   `discoverVersions(siteDir)`; keep pure functions + their tests; add tests for
   directory discovery.
2. Write the `deploy/action.yml` pipeline (steps 1–6) with `gh`-based gathering.
3. Switch `_docs.yml` to build-then-invoke; add the `github-pages` environment,
   Pages permissions, and `concurrency`. Set the repo's Pages source to GitHub
   Actions.
4. Add `docs.zip` attachment to `_release.yml` (decision #2).
5. Update `docs/index.md` + `CLAUDE.md` consuming instructions.
6. Backfill: attach `docs.zip` to existing releases (or accept they show only if
   rebuilt).
```

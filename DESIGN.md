# Design note: versioned docs publishing

Status: **implemented** (phases 1–7 in code; see "Implementation phases"). Two
operator actions remain, called out at the end. Captures the move from the
current "switcher writes two files, caller stages + publishes to a `gh-pages`
branch with `keep_files`" model to a pair of small actions that **reconstruct the
whole versioned site from durable sources on every deploy and publish it directly
to GitHub Pages** (no `gh-pages` branch). The action assembles the site tree; the
**caller** owns the Pages publish.

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
rebuilt — acceptable for *optional* dev/preview docs (see required vs optional
branches below).

There is no `gh-pages` branch at all — neither source nor target. This removes the
`origin/gh-pages` fetch requirement (we still need tags for ordering).

### The `docs` artifact / `docs.zip` contract

`assemble` packs **one `docs.zip` with a bare `html/` root** from the build, then
delivers that *same file* two ways — so there is a single contract and no repack:

- uploaded **verbatim** as the CI artifact named `docs` (every run), with
  `compression-level: 0` since it is already compressed. Pre-zipping (rather than
  letting `upload-artifact` zip a staged `html/` parent) also drops a `cp` of the
  build: `zip` reads the tree in place.
- attached **verbatim** as the `docs.zip` Release asset on tag runs —
  `_release.yml` just downloads the `docs` artifact (which *is* `docs.zip`) and
  uploads it (see resolved decision #2). No download-and-re-zip.

Both release and branch gather therefore unzip the same `html/` shape (`unzip
'html/*'`).

Built with `BASE_URL=/<repo>/<version>` matching the sub-path they will be served
at. A mismatch produces a version whose assets 404 — the build step (caller's
responsibility) owns this.

## The two actions

The pipeline is split into two small composite actions, sequenced around the
caller's `myst build`:

- **`current-version`** runs *before* the build. It sanitises the raw ref name so
  `BASE_URL` can be set at build time.
- **`assemble`** runs *after* the build. It gathers every version, generates
  `switcher.json` + `index.html`, uploads this build's `docs` artifact, and
  outputs the assembled site directory for the caller to publish.

Proposed layout: rename `switcher/` → `assemble/` (the action no longer just
writes the switcher, and it no longer deploys — the *caller* does). The Node
logic stays co-located beside `assemble/action.yml` as `assemble.mjs`, and a
sibling `current-version/action.yml` holds the tiny pre-build action.

### Why `current-version` is its own action

The sanitised version is consumed in **two** places that must be byte-identical or
assets 404: the build-time `BASE_URL` sub-path, and the `site/<version>`
directory name written by `assemble`. To guarantee they match, sanitisation has a
**single implementation** — `sanitize()`, exported by `assemble.mjs` — that both
actions invoke (`current-version` reaches it via the sibling path, since the whole
repo is checked out with the action). `current-version` surfaces the value as an
output *before* the build (when `assemble` hasn't run yet); `assemble` calls the
same function for the version dir and for branch-preview dirs. One implementation
means no bash-vs-JS drift and no parity test to maintain.

### `assemble` inputs

| input | required | default | meaning |
|---|---|---|---|
| `html-dir` | yes | — | path to the freshly built docs (e.g. `docs/_build/html`) |
| `ref-name` | yes | — | the **unsanitised** ref (`${{ github.ref_name }}`); sanitised internally |
| `repo` | no | `${{ github.repository }}` | `org/repo`, for version URLs |
| `required-branches` | no | default branch | branches that **must** be present, else the deploy hard-fails (satisfied by being the current ref or having a recent successful CI `docs` artifact) |
| `optional-branches` | no | all branches with recent CI | branch previews to include if they have a recent CI artifact; missing → silently skipped |
| `token` | no | `${{ github.token }}` | `gh` access: release assets + cross-run artifacts |

### `assemble` outputs

| output | meaning |
|---|---|
| `dir` | path to the assembled publish root, for the caller to hand to `upload-pages-artifact` |

### `assemble` pipeline

Everything lives under the runner temp dir.

```
$RUNNER_TEMP/
  docs.zip                ← current build packed (bare html/); the artifact + asset
  site/                   ← assembled publish root (the action's `dir` output)
    index.html            ← redirect to the preferred (newest stable) version
    switcher.json
    <version>/ …          ← every gathered version

1. Stage current build (bash; sanitise via the shared sanitize())
     ver=$(node assemble.mjs sanitize "$ref-name")
     ( cd "$(dirname $html-dir)" && zip -rq "$RUNNER_TEMP/docs.zip" html )  # bare html/
     cp -r "$html-dir"  "$RUNNER_TEMP/site/$ver"

2. Upload this build's docs artifact (every run)         ← IS docs.zip, verbatim
     actions/upload-artifact  name=docs  path=$RUNNER_TEMP/docs.zip  compression-level=0
       # _release.yml later attaches this same file as the release asset (no repack)

3. Gather released tags (bash plumbing; gh's built-in -q, never a `jq` pipe)
     for tag in $(git tag -l):                            # ordering done later, in JS
       [ "$tag" = "$ver" ] && continue
       gh release download "$tag" -p docs.zip -O r.zip || continue   # no asset → skip
       unzip r.zip 'html/*' -d t && mv t/html "$RUNNER_TEMP/site/$tag"

4. Plan branch previews (JS kernel — pure, unit-tested)
     ci=$(gh run list --workflow ci.yml --status success \
            --json headBranch,databaseId -q '<latest run id per branch>')
     plan=$(node assemble.mjs plan-branches --ref-name "$ref-name" \
              --required "$required" --optional "$optional" --ci "$ci")
       # planBranches() resolves required ∪ optional, sanitises each dest dir, and
       # emits the {runId, destDir} fetch list. Any required branch that is neither
       # the current ref nor present in $ci → exit 1 (hard-fail). Optional & absent
       # → simply omitted from the plan.

5. Fetch planned branches (bash plumbing; dumb IO)
     for {runId, destDir} in plan:
       gh run download "$runId" -n docs -D t           # → t/docs.zip
       unzip t/docs.zip 'html/*' -d t && mv t/html "$RUNNER_TEMP/site/$destDir"

6. Generate switcher.json + redirect, decide stable (JS — the pure core)
     stable_src=$(node assemble.mjs generate --site-dir "$RUNNER_TEMP/site" --repo "$repo")
       # writes switcher.json (★ on the latest-release entry) + index.html.
       # versions discovered from site/ subdirs; git tags drive ordering +
       # prerelease detection; preferred = newest deployed non-prerelease tag.
       # index.html → stable/ when preferred is a release tag, else → the main
       # fallback. Prints the preferred release dir to alias, or nothing if none.

7. Stable alias (bash; symlink, inflated to a copy at deploy — see Stable alias)
     [ -n "$stable_src" ] && ln -s "$stable_src" "$RUNNER_TEMP/site/stable"

8. Output the assembled dir
     echo "dir=$RUNNER_TEMP/site" >> "$GITHUB_OUTPUT"
```

The split is deliberate: **bash does the IO plumbing** (`gh` calls, `unzip`, `mv`)
where shelling out is concise, and the **JS kernel does the logic** — `sanitize()`,
`planBranches()`, and the pure generation. The kernel functions take plain data
(ref name, branch lists, the `ci` catalogue JSON) and return plans/strings, so
they unit-test without mocking `gh`, the network, or the filesystem. Bash never
touches JSON itself: every extraction uses `gh`'s built-in `-q`/`--jq` (it embeds
the real jq) or `gh api --jq`, never a piped standalone `jq`. That keeps `gh`'s
exit code intact — a `gh … | jq` pipe would mask an API failure as empty output
unless `pipefail` is set — and gets field-name validation from `--json`. Gather
order is irrelevant (a directory is a directory); all ordering and prerelease
logic lives in `generate`.

`required-branches` defaults to the default branch (so `main`'s preview can never
silently vanish); `optional-branches` defaults to every branch with a recent
successful CI run (distinct head branches of recent successful `ci.yml` runs).

## What stays in the caller workflow

The caller builds, invokes the two actions, and owns the Pages publish. It is
split into a **build** job and a **deploy** job: only `deploy` enters the
`github-pages` environment (and carries `pages`/`id-token` + `concurrency`),
because `deploy-pages` is job-scoped — a composite action cannot declare any of
those. The split matters because the environment's deployment-branch protection
is evaluated when a job *enters* it, so a single job carrying the environment
would block PR build-checks that never deploy. Keeping all Pages concerns in the
caller is why the action stops at "assemble" (see resolved decision #5).

```yaml
env:
  UPSTREAM: <org>/<repo>    # the canonical repo; pushes elsewhere = a fork preview

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read     # checkout + read release assets
      actions: read      # download other runs' artifacts (cross-run)
    steps:
      - uses: actions/checkout@v5
        with: { fetch-depth: 0 }            # tags, for ordering + prerelease
      - id: ver
        uses: DiamondLightSource/myst-version-switcher-plugin/current-version@<tag>
        with: { ref-name: ${{ github.ref_name }} }
      - run: cd docs && myst build --html
        env:
          BASE_URL: /<repo>/${{ steps.ver.outputs.version }}
      - id: site
        if: ${{ github.ref_type == 'tag' || github.ref_name == 'main' || github.repository != env.UPSTREAM }}
        uses: DiamondLightSource/myst-version-switcher-plugin/assemble@<tag>
        with:
          html-dir: docs/_build/html
          ref-name: ${{ github.ref_name }}
          # forks guard only their own ref; upstream guards main
          required-branches: ${{ github.repository == env.UPSTREAM && 'main' || github.ref_name }}
      - if: ${{ steps.site.outcome == 'success' }}
        uses: actions/upload-pages-artifact
        with: { path: ${{ steps.site.outputs.dir }} }

  deploy:
    needs: build
    # NB: env context is unavailable in a job-level `if`, so the upstream slug is
    # inlined here (it can be templated by copier).
    if: ${{ github.ref_type == 'tag' || github.ref_name == 'main' || github.repository != '<org>/<repo>' }}
    runs-on: ubuntu-latest
    environment: { name: github-pages, url: '${{ steps.deployment.outputs.page_url }}' }
    permissions:
      pages: write       # deploy to Pages
      id-token: write    # deploy-pages OIDC
    concurrency: { group: pages, cancel-in-progress: false }
    steps:
      - id: deployment
        uses: actions/deploy-pages
```

`current-version` runs unconditionally (the PR build still needs the right
`BASE_URL`). `assemble` + publish are gated off for *base-repo* PRs by the `if:`
— the build itself still runs on PRs to catch breakages; nothing is published and
no `docs` artifact is uploaded (PR builds are not previews). The `github.repository
!= UPSTREAM` arm lets a **fork's own push** publish to the fork's Pages (see
External-PR previews). `deploy-pages` publishes the uploaded tree as the *entire*
site (no merge), so a stale branch preview that is no longer gathered is correctly
dropped.

## Reused vs. new logic

The pure functions already in `make-switcher.mjs` carry over unchanged into
`assemble.mjs`: `orderVersions`, `isPrerelease`, `preferredVersion`,
`switcherStruct`, `renderSwitcher`. `renderRedirect` retargets to `stable/` (see
Stable alias). The **version source** changes, and two small pure functions join
them:

- **Drop** `getBranchContents("origin/gh-pages")` (git ls-tree of the publish
  branch).
- **Add** `discoverVersions(siteDir)` = directory names under the assembled
  `site/`. The current version is already a dir (step 1), so the `--add` flag goes
  away.
- **Add** `sanitize(name)` — the single sanitisation implementation, shared with
  `current-version` (replaces the duplicated rule + parity test).
- **Add** `planBranches({ refName, required, optional, ci })` — resolves which
  branches to fetch, their sanitised dest dirs, and which required branches are
  unsatisfiable (→ hard-fail). Pure: fed the `ci` catalogue as data, tested with
  fixtures.
- `assemble.mjs` exposes `sanitize` / `plan-branches` / `generate` subcommands;
  `generate` reads `--site-dir` instead of an `--output-dir`, and writes
  `switcher.json` + `index.html` into that same dir.

This keeps the testable core intact and pulls the only error-prone glue logic
(branch resolution, sanitisation) into it; the remaining IO (`gh` download, unzip,
upload) is bash plumbing, integration-tested via a dry run. `orderVersions`
already has to order branch names (e.g. `main`) alongside version tags — that path
matters more now, so the backfill adds an explicit mixed branch+tag ordering test.

## Stable alias

Other projects fetch this site's `objects.inv` for cross-references, so they need
a **stable URL that always points at the latest release** — not a version number
that changes every release. The site therefore publishes a `stable/` alias.

- **`stable/` is the newest deployed non-prerelease tag — never `main`.** Before
  the first release there is no `stable/`; the root redirect falls back to `main`
  as today (there is nothing stable to serve an inventory from yet).
- **It is a symlink, not a copy, in the assembled tree** (`ln -s "$preferred"
  stable`). `actions/upload-pages-artifact` tars with `--dereference`, so the link
  is inflated to a real copy at deploy — Pages serves `stable/` as a full
  duplicate of the release build.
- **The root `index.html` redirects to `stable/`** (a constant target) whenever it
  exists, so the canonical entry URL never changes.

### Why a copy resolves correctly

MyST writes **base-relative** URIs into `objects.inv` (the root doc's `uri` is the
empty string — relative to the configured base, not a root-absolute
`/repo/<version>/…`). So a consumer pointing intersphinx at `…/repo/stable/`
fetches `stable/objects.inv` and resolves every target under `/stable/` — the
links stay stable rather than pinning to the concrete version. (Verified on this
repo's build; re-confirm on a richer multi-page site, but the relative-URI format
is structural.)

### Switcher behaviour: `/stable/` shows the concrete version

Requirement: visiting `/stable/` must show **the release it aliases** selected in
the dropdown (e.g. `v2.0`), not a separate "stable" item. So `switcher.json` gets
**no** `stable` entry — it lists real versions only, with `preferred: true` on the
latest-release entry as today. The widget (`version-switcher.mjs`) gains the alias
handling instead:

- `detectCurrent` falls back, when no version path matches, to the `preferred`
  entry if the path is under `<base>/stable/` (where `<base>` is the preferred
  entry's pathname with its version segment swapped for the literal `stable`). The
  dropdown then shows the concrete release selected.
- Detection returns the **actual base pathname** (`/repo/stable/`) alongside the
  selected entry, and `computeTargetUrl` strips *that* base rather than the
  entry's canonical pathname. For ordinary version pages the two coincide (no
  behaviour change); on `/stable/guide.html`, switching to a pinned version
  preserves the path → `/repo/v1.0/guide.html` (then the existing `pageExists`
  probe handles pages absent in that version).

`stable` is a fixed convention, so the widget hardcodes the segment name
(`STABLE_ALIAS = "stable"`).

## Permissions

```yaml
permissions:
  pages: write      # deploy to Pages
  id-token: write   # deploy-pages OIDC
  contents: read    # checkout + download release assets
  actions: read     # download other runs' artifacts (cross-run)
```

Plus `environment: { name: github-pages }` and `concurrency: { group: pages }` at
job level. `assemble` needs only `contents: read` — it uploads the `docs` CI
artifact and reads release assets, but does **not** attach release assets;
`_release.yml` keeps `contents: write` for that (resolved decision #2). `gh` is
preinstalled on GitHub runners. Cross-run artifact download needs
`gh run download <id>` (the `actions/download-artifact` action only sees the
current run).

## Release-layer cache (optional optimisation)

Re-downloading and unzipping every release's `docs.zip` on every deploy is the one
cost this design carries (the Scaling edge case). A GitHub Actions cache removes
it — but only for the **immutable release layer**, never the whole site. The
distinction matters because GH cache semantics actively fight the obvious
"cache the expanded site" idea:

- **Cache scoping is one-directional.** A cache written on a branch is visible
  only to that branch and its descendants; the *default branch's* cache is the
  only one all other branches/PRs can restore. Writes never flow upward — a
  feature branch **cannot** write into the cache `main`'s deploy reads. So
  "active branches write their build into a shared cache" is impossible; that is
  exactly why branch previews come from cross-run CI **artifacts**
  (`gh run download`), which *do* cross the run/branch boundary. The cache cannot
  replace artifact gathering for branches.
- **A cached site reintroduces drift.** An accumulating tree never forgets a
  deleted branch unless actively pruned — the very `keep_files` problem (#3) this
  redesign kills. Reconstructing the live set every deploy and letting
  `deploy-pages` replace the whole site is what makes deletion self-healing; a
  cached tree forfeits that.
- **A cache is never a source of truth.** GH caches evict after 7 idle days (and
  under a 10 GB/repo LRU cap), so the full durable-source gather must exist
  regardless. The cache only ever *accelerates* it.

So cache **only the released-tags layer**, which is immutable and permanent. A
composite action can't express a dynamic per-tag cache step, so the realisation
is a single extracted-releases bundle dir (`<tag>/html` per release) behind one
`actions/cache` step:

- Key `docs-releases-v1-<hash of the sorted tag set>` with restore-keys prefix
  `docs-releases-v1-`. Adding a release changes the key ⇒ the prefix restores the
  previous superset (every prior release), the gather loop downloads only the one
  new tag, and the post-step save stores the new superset. Released `docs.zip` is
  immutable, so a restored tag dir is never stale (a deliberate `--clobber`
  re-upload is out of scope — bump the `v1` key prefix if ever needed). On a miss
  the loop falls back to `gh release download` + `unzip` as today. Branches (incl.
  `main`) stay fresh from CI artifacts every deploy.

This is a transparent enhancement to step 3 of the `assemble` pipeline, not a
change to the action's contract. It is optional — correctness rests entirely on
the durable sources whether or not the cache hits.

## External-PR previews via the contributor's fork

A `pull_request` run from a **fork** gets a read-only `GITHUB_TOKEN` and no
secrets, and cannot deploy to the base repo's Pages — a deliberate security
boundary (otherwise any PR could deface the site or exfiltrate secrets). So the
canonical Pages site cannot show external-PR docs. Of the three escape hatches:

- **`pull_request_target`** runs privileged but defaults to base code; checking
  out + *building* PR-head content under it is the classic RCE footgun (a MyST
  build executes PR-authored plugins/transforms = untrusted code). Rejected.
- **`workflow_run`** (PR build uploads an artifact unprivileged; a base-context
  job publishes it) is GitHub's documented fork-preview pattern and is safe, but
  publishes on our infra/domain and is the most machinery.
- **Publish to the contributor's own fork Pages** — chosen. The contributor's
  `push` to their fork runs in the fork with the fork's own write-scoped token
  and deploys to `https://<contributor>.github.io/<repo>/<branch>/`. Zero
  base-repo resources or secrets are touched; compute is on the contributor's
  account.

It composes with this design with **no action changes** — only caller-workflow
gating:

- It is driven by `push` in the fork, not the base repo's `pull_request` run
  (which still only build-checks, publishing nothing). Base-repo PR behaviour is
  unchanged.
- The only adjustment: the publish gate must not be hardcoded `main`-only. Gate
  publish as `ref_type == 'tag' || ref_name == 'main' || github.repository != <upstream>`.
  On the fork, `repository != upstream` ⇒ its branch pushes deploy to the fork's
  Pages; on upstream, feature-branch pushes still never publish.
- `BASE_URL=/<repo>/<version>` is identical on a fork (same repo name) ⇒ builds
  unchanged. On the fork, `gh release download` finds no releases (forks don't
  copy them) ⇒ `assemble` gathers only the fork's current branch — a
  self-contained single-branch preview, which is correct.

The cost is UX/opt-in, not security: the contributor must enable Actions + Pages
on their fork (off by default), and a fork run **cannot** comment the preview URL
back on the base PR (read-only to base) — the link is pasted by the contributor
or surfaced by an optional base-repo `workflow_run` job. For an org reviewing
community PRs this is acceptable, and arguably cleaner: no base-repo surface at
all.

## Edge cases

- **First deploy:** no releases, `required-branches=main`, current=`main` → site
  has only `main/`; switcher is single-entry; redirect → `main`. Graceful.
- **Release without `docs.zip`** (cut before this scheme): `gh release download`
  fails for that asset → skip that version. No hard failure.
- **Required branch missing:** a `required-branches` entry that is neither the
  current ref nor has a recent successful CI artifact → **hard-fail the deploy**
  rather than publish a site missing a version declared required.
- **Optional / expired branch artifact:** skip silently; that preview is absent
  until the branch rebuilds.
- **Prereleases:** still excluded from `preferred`/redirect (the `a`/`b`/`rc`
  test, parity with `_release.yml`), but they still appear in the switcher if
  their `docs.zip`/artifact was gathered.
- **Stable alias:** `stable/` symlinks the newest deployed non-prerelease tag
  (never `main`), inflated to a copy at deploy; root `index.html` → `stable/`.
  Before the first release there is no `stable/` and the root → `main` fallback.
  See Stable alias.
- **Concurrency:** `concurrency: { group: pages, cancel-in-progress: false }` on
  the caller job. `deploy-pages` replaces the *entire* site, so it is
  last-writer-wins; reconstructing from durable sources makes this mostly
  self-healing, except a release created moments earlier may not yet be visible to
  an in-flight run. GitHub also serialises deployments to the `github-pages`
  environment.
- **Scaling:** every deploy downloads every release's `docs.zip`. Fine for tens of
  releases; beyond that the **release-layer cache** (below) keys extracted
  releases by tag + asset digest so unchanged releases are restored, not
  re-downloaded.

## Resolved decisions

1. **Action layout.** Two actions: `current-version/` (pre-build sanitise) and
   `assemble/` (post-build gather + generate + artifact upload). Renamed from
   `switcher/`; `assemble.mjs` and its tests sit beside `assemble/action.yml`. No
   back-compat required, so a clean rename is fine.
2. **Who attaches `docs.zip` to the Release?** `_release.yml` (which already
   creates the release): it downloads the run's `docs` artifact and attaches it as
   `docs.zip`. `assemble` uploads only the CI artifact. This needs
   `_release.yml` to declare `needs: _docs` so the `docs` artifact exists when it
   runs; there is no same-run dependency for the tag being released (its build is
   staged directly in step 1), so ordering is otherwise unconstrained.
3. **Direct Pages publish vs. `gh-pages` branch.** Direct publish, via
   `actions/upload-pages-artifact` + `actions/deploy-pages`; no `gh-pages` branch.
   The two publish steps live in the **caller** (not the action), since
   `deploy-pages` is job-scoped. Requires the repo's Pages source set to **GitHub
   Actions**.
4. **Language.** JS core + bash glue. The pure functions (and their existing
   node-based tests) carry over to `assemble.mjs` unchanged; bash does the
   `gh`/`unzip`/`mv` IO. Pure bash is ruled out — semver ordering, prerelease
   detection and JSON rendering are not unit-testable in bash. Python was a
   contender (team is Python-heavy; this half stays DLS infra, not upstreamed) but
   loses on the one-time port plus a second toolchain on a JS-only repo.
5. **Action scope.** `assemble` gathers, generates, and uploads the `docs`
   artifact, then outputs the site dir; it does **not** publish. The caller owns
   the Pages trio. `deploy-pages` being job-scoped forces the caller to declare
   the environment/permissions regardless, so publishing from inside the action
   would only fragment Pages knowledge across two files. The `docs`-artifact upload
   stays inside the action so the bare-`html/` contract lives next to the gather
   side that depends on it.

## Migration from an existing `gh-pages` branch

Repos already on the old `keep_files`/`gh-pages` model have their version history
living as directories on the `gh-pages` branch, not as `docs.zip` release assets.
Moving them onto the new model is a **one-time, guarded cutover**, not a backfill —
it ends with two irreversible steps (flipping the Pages source, deleting the
branch) that want a human watching with their own admin credentials.

This is therefore a **local one-shot script** run by the operator with their own
`gh auth`, **not** a CI job:

- A CI `GITHUB_TOKEN` typically cannot change the Pages source
  (`PATCH /repos/{owner}/{repo}/pages` needs repo-admin); the operator's `gh`
  already can.
- The cutover needs a human pause-and-verify gate before anything destructive,
  which a fire-and-forget workflow handles poorly.
- It leaves nothing behind — no `workflow_dispatch` stub to add to (and later
  delete from) each consumer repo. The same script serves DLS and external
  adopters alike.

The non-destructive **backfill** is the reusable, unit-tested `migrate` subcommand
of `assemble.mjs` (read `gh-pages` → zip each tag dir as bare `html/` →
`gh release upload`). The **flip / verify / delete** steps are thin interactive
`gh api` calls the script orchestrates around it.

### Cutover sequence

```
1. Backfill (non-destructive, idempotent)
     for each release tag with a matching gh-pages dir lacking docs.zip:
       stage <dir> as html/ ; zip ; gh release upload <tag> docs.zip --clobber
     # MUST be first: the reconstructed site is built from these assets.
     # Branch dirs (main/) need nothing — they self-heal on the next branch CI.

2. Flip Pages source → GitHub Actions          (gh api PATCH …/pages)
     # Forced to be here: deploy-pages refuses to publish unless the source is
     # already "GitHub Actions", so you cannot verify a new deploy before flipping.

3. Trigger a deploy                            (gh workflow run docs.yml)
     # Reconstructs the full tree (backfilled docs.zip + current build) + publishes.

4. PAUSE + verify (auto-probe AND explicit human OK)
     # switcher.json lists every expected version; each <version>/ URL returns 200
     # and is styled (not a bare-HTML 404).

5. Delete gh-pages — only after step 4 is green.
```

Between steps 2 and 5 the `gh-pages` branch is no longer *served* but still
*exists*: it is the **rollback**. If verification fails, flip the Pages source
back to "Deploy from a branch / `gh-pages`" and serving is restored instantly with
no data lost — which is exactly why the delete is last and gated. The script
should say this out loud when it pauses.

(This repo is the test bed: `gh-pages` already holds `v0.1.0/`, `v0.2.0/`, and
`main/`, with no `docs.zip` assets yet. A dry run exercising step 1 + step 4's
probe — skipping the flip and delete — validates the real path.)

## Implementation phases

1. **[done]** Refactor `make-switcher.mjs` → `assemble.mjs`: replace gh-pages
   discovery with `discoverVersions(siteDir)`; add `sanitize()` and
   `planBranches()`; retarget `renderRedirect` to `stable/` and have `generate`
   emit the stable-alias source; keep the pure functions + their tests; add tests
   for directory discovery, mixed branch+tag ordering, sanitisation, branch
   planning (incl. required-missing → fail), and the redirect/stable-source
   decision (incl. the no-release fallback).
2. **[done]** Add stable-alias handling to `version-switcher.mjs`: `detectCurrent`
   selects the `preferred` entry under `<base>/stable/` and returns the actual base
   pathname; `computeTargetUrl`/`resolveTargetUrl` strip the passed base.
3. **[done]** Write `current-version/action.yml` (shared `sanitize()` → `version`
   output) and `assemble/action.yml` (pipeline steps 1–8) with `gh`-based plumbing
   (gh's built-in `-q`, never a `jq` pipe). Step 3 caches the extracted release
   bundle (`docs-releases-v1-<tag-set-hash>`; see Release-layer cache).
   `plan-branches` emits `<runId>\t<destDir>` TSV for the bash loop.
4. **[done]** Switch `_docs.yml` to current-version → build → assemble → publish,
   split into build + deploy jobs (only deploy carries the `github-pages`
   environment + `pages`/`id-token` perms + `concurrency`). Gate publish on
   tag/main/fork so fork pushes deploy to the fork's Pages. *(Operator: set the
   repo's Pages source to GitHub Actions.)*
5. **[done]** Attach `docs.zip` in `_release.yml` (downloads the `docs` artifact);
   ci.yml's release job already `needs: docs` (decision #2).
6. **[done]** Update `docs/index.md` + `CLAUDE.md` consuming instructions.
7. **[done]** `migrate` subcommand of `assemble.mjs` (+ `planMigration` tests) and
   the cutover script `scripts/cutover.sh` (backfill → flip → deploy → pause/verify
   → gated delete). *(Operator: dry-run it against this repo's `gh-pages` branch
   before the real cutover.)*

### Remaining operator actions (not code)

- Set this repo's **Pages source → GitHub Actions** (Settings → Pages) before the
  first new-model deploy; `deploy-pages` refuses to publish otherwise.
- Run `scripts/cutover.sh <org/repo> --dry-run` against this repo's `gh-pages`
  (which holds `v0.1.0/`, `v0.2.0/`, `main/` with no `docs.zip` yet) to validate
  the backfill + probe, then the real cutover when ready.

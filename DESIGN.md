# Design note: versioned docs publishing

Status: **implemented**. Captures the move from the
current "switcher writes two files, caller stages + publishes to a `gh-pages`
branch with `keep_files`" model to a **single `assemble` action** that
**reconstructs the whole versioned site from durable sources on every deploy and
publishes it directly to GitHub Pages** (no `gh-pages` branch). The action
assembles the site tree; a **privileged publish workflow** (split from the
unprivileged build) owns the Pages publish.

> **Note on history.** Earlier drafts of this doc described a `current-version`
> pre-build action, a shared `sanitize()`, all-branch-push triggers with per-job
> `if` gates, and fork previews published to the *fork's own* Pages. Those were
> superseded by: clean version tokens (`pr-<n>` / `main` / no-`/` tag, **no
> sanitisation**), a **build-vs-publish workflow split** (`workflow_run`), and
> **per-commit fork-PR opt-in** to the canonical site. Sections below reflect the
> shipped model; a few rationale passages (stable alias, reconstruct-from-sources,
> the deferred cache, migration) carry over unchanged.

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

## One action, two workflows

There is a **single composite action, `assemble`**, run by the privileged publish
workflow. The unprivileged build (`ci.yml`) needs no action — it computes the
version token inline and uploads the `docs` artifact.

- **build (`ci.yml`)** runs `myst build` with `BASE_URL=/<repo>/<token>` and
  uploads the build as the `docs` artifact. The `<token>` is `pr-<number>` for
  PRs, else the ref name (`main`, or a tag without `/`). No action, no
  sanitisation — every token is filesystem/URL-safe by construction.
- **`assemble`** runs in the publish workflow. It gathers every version
  (`main`'s build, release `docs.zip` assets, open-PR artifacts), generates
  `switcher.json` + `index.html`, creates the `stable/` alias, and outputs the
  assembled site directory for `deploy-pages`.

Layout: everything lives under `assemble/`. `action.yml` is a thin wrapper that runs
`assemble.sh` (the `gh`/`unzip` plumbing) via `$GITHUB_ACTION_PATH/assemble.sh`;
`assemble.sh` shells into `assemble.mjs` (the Node kernel) beside it. Keeping the
script standalone means the `gh` plumbing is **runnable locally**
(`REPO=… GH_TOKEN=$(gh auth token) assemble/assemble.sh`), not only inside the
action.

### Why no `current-version` action / no sanitisation

The version token is consumed in **two** places that must be identical or assets
404: the build-time `BASE_URL` sub-path, and the `site/<token>` directory `assemble`
files the build's artifact at. Earlier this needed a shared `sanitize()` and a
pre-build action to surface it. But the tokens are now **clean by construction** —
`pr-<number>` (an integer), `main` (the default branch), or a tag without `/` (the
`tags: ['*']` trigger never matches `/`, so `/`-tags never build). With nothing to
transform, both sides just use the literal token: `ci.yml` computes it for
`BASE_URL`; `assemble` derives the same `pr-<n>` from the PR number, `main` from the
default branch, and the tag verbatim. No transformation means no drift and no
parity test — `sanitize()` is gone.

### `assemble` inputs

| input | required | default | meaning |
|---|---|---|---|
| `repo` | no | `${{ github.repository }}` | `org/repo`, for version URLs and `gh` lookups |
| `guard-default-branch` | no | `true` | when true, hard-fail if the repo's **default branch** is not in the site (guards the canonical site against publishing a hole when its latest build artifact expired). Set false only for throwaway previews |
| `token` | no | `${{ github.token }}` | `gh` access: release assets + cross-run artifacts + the `preview-approved` status |

### `assemble` outputs

| output | meaning |
|---|---|
| `dir` | path to the assembled publish root, for the caller to hand to `upload-pages-artifact` |

### `assemble` pipeline

The build's `docs.zip` is uploaded by `ci.yml` (the unprivileged build), not the
action. `assemble` only *gathers* from durable sources into the site tree under the
runner temp dir.

```
$RUNNER_TEMP/site/        ← assembled publish root (the action's `dir` output)
  index.html              ← redirect to the preferred (newest stable) version
  switcher.json
  <version>/ …            ← main, every release tag, each gathered open PR (pr-<n>)

1. Resolve the default branch (bash); mkdir site
     default=$(gh repo view "$repo" --json defaultBranchRef -q .defaultBranchRef.name)

2. Gather main (bash): the default branch's latest successful PUSH build
     run=$(gh run list --workflow ci.yml --branch "$default" --event push \
             --status success --limit 1 --json databaseId -q '.[0].databaseId')
     gh run download "$run" -n docs -D t && unzip t/docs.zip 'html/*' … → site/$default

3. Gather released tags (bash; gh's built-in -q, never a `jq` pipe)
     tags=$(gh api --paginate repos/$repo/releases \
              -q '.[] | select(any(.assets[]; .name=="docs.zip")) | .tag_name')
     for tag in $tags:                          # ordering done later, in JS
       case "$tag" in */*) continue;; esac      # /-tags never build → never publish
       gh release download "$tag" -p docs.zip -O r.zip
       unzip r.zip 'html/*' … → site/$tag       # tag verbatim as the dir name

4. Gather open PRs (bash): internal always; external forks only when approved
     prs=$(gh pr list --state open --json number,headRefOid,isCrossRepository \
             -q '.[] | [.number,.headRefOid,.isCrossRepository] | @tsv')
     for {num, sha, cross} in prs:
       if cross: approved=$(gh api repos/$repo/commits/$sha/statuses \
                   -q 'any(.[]; .context=="preview-approved" and .state=="success")')
                 [ approved = true ] || continue          # unapproved fork → skip
       # the successful CI run for THIS head commit (empty if not yet green / SHA moved):
       run=$(gh api "repos/$repo/actions/runs?head_sha=$sha&status=success" \
               -q 'first(.workflow_runs[] | select(.name=="CI") | .id)')
       gh run download "$run" -n docs -D t && unzip t/docs.zip 'html/*' … → site/pr-$num

5. Generate switcher.json + redirect, decide stable, guard required (JS — the core)
     stable_src=$(node assemble.mjs generate --site-dir "$RUNNER_TEMP/site" \
                    --repo "$repo" --required "$default")   # required empty if guard off
       # writes switcher.json (★ on the latest-release entry) + index.html.
       # versions discovered from site/ subdirs; git tags drive ordering +
       # prerelease detection; preferred = newest deployed non-prerelease tag.
       # index.html → stable/ when preferred is a release tag, else → the main
       # fallback. Prints the preferred release dir to alias, or nothing if none.
       # Runs after all gathering, so it also exit-1s (hard-fail) if the --required
       # (default) branch's dir is absent — the only must-not-be-wrong branch logic.

6. Stable alias (bash; symlink, inflated to a copy at deploy — see Stable alias)
     [ -n "$stable_src" ] && ln -s "$stable_src" "$RUNNER_TEMP/site/stable"

7. Output the assembled dir
     echo "dir=$RUNNER_TEMP/site" >> "$GITHUB_OUTPUT"
```

The split is deliberate: **bash does the IO plumbing** (`gh` calls, `unzip`, `mv`)
where shelling out is concise, and the **JS kernel does the logic** — the pure
generation and the folded-in required-branch guard. The kernel functions take plain
data (dir-name lists, etc.) and return strings/verdicts, so they unit-test without
mocking `gh`, the network, or the filesystem. Bash never touches JSON itself: every
extraction uses `gh`'s built-in `-q`/`--jq` (it embeds the real jq), never a piped
standalone `jq`. That keeps `gh`'s exit code intact — a `gh … | jq` pipe would mask
an API failure as empty output unless `pipefail` is set. Gather order is irrelevant;
all ordering and prerelease logic lives in `generate`.

**PR-preview lifecycle.** Previews are gathered for **open PRs only**, keyed by each
PR's current head SHA — so a preview tracks the live PR and **drops on the next
deploy when the PR merges/closes** (no `~90d` staleness window, no live-branch
list). The head-SHA key also means a fork preview pinned by `preview-approved`
silently drops when the contributor pushes a new commit (new SHA), until a
maintainer re-approves. With `guard-default-branch: true` the deploy hard-fails if
`main` isn't in the site, so it can never silently vanish.

## What stays in the caller workflow

The caller owns two workflows, split by privilege. **`ci.yml` (build) never
deploys; `publish.yml` (assemble + deploy) is the only privileged half.** Behaviour
by event:

| event | repo | CI build (+ upload `docs`) | publish |
|---|---|---|---|
| `push` | upstream | `main` / tag | yes | → upstream Pages |
| `pull_request` (internal) | upstream | yes | → upstream Pages (on CI success) |
| `pull_request` (fork) | upstream | yes (read-only) | **no** — opt-in only |
| any | fork-of-project | yes | **no** — `publish.yml` is inert off-upstream |

So **every PR builds the full docs** (verifying it + priming its `docs` artifact);
**internal PRs, `main`, and tags publish** as soon as CI passes; an **external fork
PR** publishes only after a maintainer opts it in (see "External-PR previews"). The
split exists because GitHub gives a **fork** `pull_request` run a read-only token —
it can build but must never deploy. Keeping the deploy in a separate workflow that
only ever runs from the trusted default branch enforces that structurally.

Two gating mechanisms:
1. **Triggers (`ci.yml`):** `on: pull_request` + `push: { branches: [main], tags:
   ['*'] }`. No other-branch pushes (so no push-vs-PR double runs; previews come
   from the PR run). No per-job `if` — every triggered event runs lint/test/build.
2. **The publish job `if` (`publish.yml`):** `workflow_run` on CI completing (plus
   `workflow_dispatch` for the fork opt-in), gated:

```yaml
# publish.yml
on:
  workflow_run: { workflows: [CI], types: [completed] }
  workflow_dispatch: { inputs: { pr: { required: false } } }
permissions: { contents: read, actions: read, pages: write, id-token: write, statuses: write }
concurrency: { group: pages, cancel-in-progress: false }
jobs:
  publish:
    if: >-
      github.repository == '<org>/<repo>' &&
      ( github.event_name == 'workflow_dispatch' ||
        ( github.event.workflow_run.conclusion == 'success' &&
          github.event.workflow_run.head_repository.full_name == github.repository ) )
    runs-on: ubuntu-latest
    environment: { name: github-pages, url: '${{ steps.deployment.outputs.page_url }}' }
    steps:
      - uses: actions/checkout@v5
        with: { fetch-depth: 0 }            # tags, for ordering + prerelease
      # (workflow_dispatch only) pin the fork PR's head SHA as approved, then assemble
      - id: site
        uses: DiamondLightSource/myst-version-switcher-plugin/assemble@<tag>
        with: { repo: ${{ github.repository }} }
      - uses: actions/upload-pages-artifact
        with: { path: ${{ steps.site.outputs.dir }} }
      - id: deployment
        uses: actions/deploy-pages
```

The `if` is three parts (see the inline comments in `publish.yml`): **(1)** only the
canonical repo publishes — a fork running this file is inert; **(2)** the manual fork
opt-in; or **(3)** a *successful* CI run whose build came from this repo
(`head_repository.full_name == github.repository`) — so an **unapproved fork PR**
build (head repo = the fork) never auto-publishes. Because `workflow_run` and
`workflow_dispatch` both run from the **default branch**, `deploy-pages` always
deploys from one ref. `deploy-pages` publishes the uploaded tree as the *entire*
site (no merge), so a merged/closed PR no longer gathered is correctly dropped.
**Operator note:** the `github-pages` environment's deployment-branch policy only
needs to allow the **default branch** — tags and PRs deploy through the publish
workflow's default-branch run, not from their own refs.

## Reused vs. new logic

The pure functions already in `make-switcher.mjs` carry over unchanged into
`assemble.mjs`: `orderVersions`, `isPrerelease`, `preferredVersion`,
`switcherStruct`, `renderSwitcher`. `renderRedirect` retargets to `stable/` (see
Stable alias). The **version source** changes, and two small pure functions join
them:

- **Drop** `getBranchContents("origin/gh-pages")` (git ls-tree of the publish
  branch).
- **Add** `discoverVersions(siteDir)` = directory names under the assembled
  `site/` (excluding the `stable` alias). Every gathered version is already a dir,
  so there is no `--add` flag.
- **No `sanitize`.** Version tokens are clean by construction (`pr-<n>` / `main` /
  no-`/` tag), so tags are used verbatim — `getSortedTags()` just **drops `/`-tags**
  (they never build) and `orderVersions` numeric-sorts the `pr-<n>`/branch tail so
  `pr-2` precedes `pr-10`.
- **Add** `missingRequired(required, versions)` — the required branch(es) absent
  from the discovered site dirs (names compared verbatim). Pure, tested with
  fixtures. Called *inside* `generate` (which already discovers the dirs), so there
  is no separate plan/check step and no `present` bookkeeping in bash; the gather
  stays dumb bash (resolve default branch, list open PRs, download, unzip).
- `assemble/assemble.mjs` exposes a single `generate` subcommand; it reads `--site-dir`
  instead of an `--output-dir`, takes `--required` (exit-1 on a missing one), and
  writes `switcher.json` + `index.html` into that same dir.

This keeps the testable core intact and pulls the only must-not-be-wrong logic (the
required-branch guarantee) into it; the remaining IO (`gh` download, unzip) is bash
plumbing. `orderVersions` already has to order branch names (e.g. `main`) and
`pr-<n>` previews alongside version tags, so the tests cover mixed branch+tag
ordering and numeric `pr-<n>` ordering.

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

## Release-layer cache (deferred — not implemented)

Re-downloading and unzipping every release's `docs.zip` on every deploy is the one
recurring cost this design carries (the Scaling edge case). A GitHub Actions cache
could remove it — but the analysis below concluded it is **not worth building
yet**, so the gather (`assemble` step 3) is deliberately cache-free.

**Why deferred:**
- The likely-dominant cost is the *N sequential `gh` API round-trips*, not the
  downloads. That is addressed instead by listing all releases in **one**
  `gh api --paginate repos/$repo/releases` call (vs N `gh release view`), which is
  both faster and simpler — and needs no cache.
- The cache's benefit is **zero at adoption** (a freshly-migrated repo has no
  `docs.zip` releases yet) and grows only as releases accumulate; for a handful of
  releases it is within noise.
- It is a real readability cost *now* for an unproven, future, N-dependent saving.

Bring it back only if profiling on a repo with many `docs.zip` releases shows the
download/unzip phase dominating. The design that would apply, and why it must be
scoped to the **immutable release layer** and never the whole site (GH cache
semantics fight the obvious "cache the expanded site" idea):

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

It would be a transparent enhancement to step 3, not a change to the action's
contract; correctness rests entirely on the durable sources whether or not a cache
hits. Deferred until there is profiling evidence to justify the complexity.

## External-PR previews: per-commit maintainer opt-in

A `pull_request` run from a **fork** gets a read-only `GITHUB_TOKEN` and no
secrets, and cannot deploy to the base repo's Pages — a deliberate security
boundary (otherwise any PR could deface the site or exfiltrate secrets). The
build-vs-publish split *is* that boundary: the fork's PR run builds + uploads a
`docs` artifact unprivileged, but only the trusted `publish.yml` (running from the
default branch) ever deploys.

The risk is not the build (it never runs with a write token), but **serving
fork-authored HTML/JS under the canonical `*.github.io` domain** — phishing /
defacement under a trusted URL, and free arbitrary-content hosting. (`github.io` is
on the Public Suffix List, so cross-tenant *cookie* theft is off the table, but the
reputational/abuse surface is real.) So a fork preview is **never automatic** — it
requires an explicit maintainer action, **pinned to a specific commit**:

- A maintainer who has reviewed the PR runs `publish.yml` via `workflow_dispatch`
  with the PR number. That privileged run (only people with write access can
  dispatch it) sets a `preview-approved` **commit status** on the PR's *current head
  SHA*, then assembles — so the fork preview goes live.
- `assemble`'s open-PR gather includes a fork PR **only when its head SHA carries
  that status**. Approval is therefore **per-commit, not per-PR**: when the
  contributor pushes a new commit, the head SHA changes, the status no longer
  matches, and the preview **silently drops on the next deploy** until a maintainer
  re-approves the new commit. This closes the bait-and-switch hole (approve benign
  docs, then push malicious content).
- The approval is durable GitHub state (a commit status), re-read by **every**
  assemble — so it survives unrelated deploys (an internal PR push, a release)
  rather than living in one workflow run. Closing/merging the PR drops it (gather is
  open-PRs only); a maintainer can also `POST` a `failure` status to revoke early.

Rejected alternatives: **`pull_request_target`** (privileged but checks out base
code — *building* PR-head content under it is the classic RCE footgun, since a MyST
build runs PR-authored plugins). **Auto-publishing every fork PR** (unattended
untrusted content on the canonical domain — the abuse surface above). **Fork's own
Pages** (an earlier choice — required all-branch push triggers and gave contributors
no canonical preview; dropped for the simpler opt-in).

The cost is UX: a fork preview is a deliberate maintainer click per reviewed commit,
and the run **cannot** comment the URL back on the base PR — surfaced by the
maintainer or an optional `workflow_run` job. For an org reviewing community PRs
that gate is a feature, not a cost.

## Edge cases

- **First deploy:** no releases, only `main` built → site has only `main/` (which
  satisfies `guard-default-branch`); switcher is single-entry; redirect → `main`.
  Graceful.
- **Release without `docs.zip`** (cut before this scheme): not selected by the
  `releases` query (it filters on a `docs.zip` asset) → skipped. No hard failure.
- **Default branch missing** (`guard-default-branch: true`): `main` has no recent
  successful CI build artifact (e.g. its run aged out and nothing rebuilt it) →
  `generate` **hard-fails** rather than publish a site missing it.
- **PR build not yet green / SHA moved:** an open PR whose current head SHA has no
  *successful* CI run is skipped (the gather keys on `head_sha=<current>&status=
  success`) — its preview appears once the build passes, and a just-pushed commit
  shows nothing until its build finishes.
- **Merged/closed PR:** drops from the gather (open-PRs only) on the next deploy —
  no lingering preview, no live-branch list to prune.
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
- **Scaling:** every deploy lists releases in one `gh api --paginate` call, then
  downloads + unzips each release's `docs.zip`. Fine for tens of releases; beyond
  that the deferred **release-layer cache** (above) would skip the re-downloads.

## Resolved decisions

1. **Action layout.** One thin action wrapper, `assemble/`, over the
   `assemble/assemble.mjs` kernel (+ its tests in `test/`). The build half needs no
   action — it computes the clean version token inline and uploads the `docs`
   artifact. No back-compat required.
2. **Who attaches `docs.zip` to the Release?** `_release.yml` (which already
   creates the release): it downloads the run's `docs` artifact and attaches it as
   `docs.zip`. The build job uploads the CI artifact. This needs `_release.yml` to
   declare `needs: docs` so the `docs` artifact exists when it runs.
3. **Direct Pages publish vs. `gh-pages` branch.** Direct publish, via
   `actions/upload-pages-artifact` + `actions/deploy-pages`; no `gh-pages` branch.
   The publish lives in a separate **privileged workflow** (`publish.yml`), since
   `deploy-pages` is job-scoped and must run from the trusted default branch.
   Requires the repo's Pages source set to **GitHub Actions**.
4. **Language.** JS core + bash glue. The pure functions (and their existing
   node-based tests) carry over to `assemble.mjs`; bash does the `gh`/`unzip`/`mv`
   IO. Pure bash is ruled out — semver ordering, prerelease detection and JSON
   rendering are not unit-testable in bash. Python was a contender (team is
   Python-heavy; this half stays DLS infra, not upstreamed) but loses on the
   one-time port plus a second toolchain on a JS-only repo.
5. **Build vs publish split.** The unprivileged `ci.yml` builds + uploads the
   `docs` artifact for every event (forks included) but never deploys; the
   privileged `publish.yml` runs `assemble` + the Pages trio. This is the security
   boundary: a fork PR's build can never reach a write token, and `deploy-pages`
   being job-scoped + default-branch-only keeps all Pages concerns in one trusted
   workflow.

## Migration from an existing `gh-pages` branch

Repos already on the old `keep_files`/`gh-pages` model have their version history
living as directories on the `gh-pages` branch, not as `docs.zip` release assets.
Moving them onto the new model is a **one-time, guarded migration**, not just a
backfill — it ends with two irreversible steps (flipping the Pages source,
deleting the branch) that want a human watching with their own admin credentials.

This is therefore a **local one-shot script** run by the operator with their own
`gh auth`, **not** a CI job:

- A CI `GITHUB_TOKEN` typically cannot change the Pages source
  (`PATCH /repos/{owner}/{repo}/pages` needs repo-admin); the operator's `gh`
  already can.
- The migration needs a human pause-and-verify gate before anything destructive,
  which a fire-and-forget workflow handles poorly.
- It leaves nothing behind — no `workflow_dispatch` stub to add to (and later
  delete from) each consumer repo. The same script serves DLS and external
  adopters alike.

It is all one bash script, `scripts/migrate.sh`. The non-destructive **backfill**
is a bash loop (read `gh-pages` → zip each tag dir as bare `html/` →
`gh release upload`), using the **tag verbatim** as the dir name (skipping `/`-tags)
so the tag→dir rule matches the deploy path — IO in bash, no JS needed. The **flip /
verify / delete** steps are thin interactive `gh api` calls in the same script.

### Migration sequence

```
1. Backfill (non-destructive, idempotent)
     for each release tag with a matching gh-pages dir lacking docs.zip:
       stage <dir> as html/ ; zip ; gh release upload <tag> docs.zip --clobber
     # MUST be first: the reconstructed site is built from these assets.
     # Branch dirs (main/) need nothing — they self-heal on the next branch CI.

2. Flip Pages source → GitHub Actions          (gh api PATCH …/pages)
     # Forced to be here: deploy-pages refuses to publish unless the source is
     # already "GitHub Actions", so you cannot verify a new deploy before flipping.

3. Trigger a deploy           (push to main, or `gh workflow run publish.yml`)
     # Reconstructs the full tree (backfilled docs.zip + main's build) + publishes.

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
   discovery with `discoverVersions(siteDir)`; add `missingRequired()`; retarget
   `renderRedirect` to `stable/` and have `generate` emit the stable-alias source;
   `getSortedTags` drops `/`-tags and `orderVersions` numeric-sorts the `pr-<n>`
   tail; keep the pure functions + tests; tests cover directory discovery, mixed
   branch+tag + numeric `pr-<n>` ordering, the required-branch check (incl.
   required-missing → fail), and the redirect/stable-source decision.
2. **[done]** Add stable-alias handling to `version-switcher.mjs`: `detectCurrent`
   selects the `preferred` entry under `<base>/stable/` and returns the actual base
   pathname; `computeTargetUrl`/`resolveTargetUrl` strip the passed base.
3. **[done]** `assemble/action.yml`: gather `main` (latest push build) + release
   `docs.zip` assets + open-PR artifacts (internal always, fork PRs only when the
   head SHA carries `preview-approved`), all via `gh`'s built-in `-q` (never a `jq`
   pipe); the required-branch guard is folded into `generate`. **No `sanitize`** —
   tokens are clean by construction.
4. **[done]** Split the docs pipeline into **`ci.yml`** (build + verify,
   unprivileged: compute token → `myst build` with `BASE_URL` → pack + upload `docs`
   artifact; never deploys) and **`publish.yml`** (assemble + deploy, privileged:
   `workflow_run` on CI + `workflow_dispatch` fork opt-in; carries the
   `github-pages` environment + `pages`/`id-token`/`statuses` perms + `concurrency`).
   *(Operator: set the repo's Pages source to GitHub Actions.)*
5. **[done]** Attach `docs.zip` in `_release.yml` (downloads the `docs` artifact);
   ci.yml's release job `needs: docs` (decision #2).
6. **[done]** Update `docs/index.md` + `CLAUDE.md` consuming instructions.
7. **[done]** `scripts/migrate.sh` — the one-shot operator migration in bash
   (backfill via `git archive`/`zip`/`gh release upload`, tag verbatim as the dir →
   flip → deploy → pause/verify → gated delete). *(Operator: dry-run it against this
   repo's `gh-pages` branch before the real run.)*

### Remaining operator actions (not code)

- Set this repo's **Pages source → GitHub Actions** (Settings → Pages) before the
  first new-model deploy; `deploy-pages` refuses to publish otherwise. The
  `github-pages` environment only needs to allow the **default branch** (publish
  always runs from it).
- Run `scripts/migrate.sh <org/repo> --dry-run` against this repo's `gh-pages`
  (which holds `v0.1.0/`, `v0.2.0/`, `main/` with no `docs.zip` yet) to validate
  the backfill plan + probe, then the real run when ready.
- `migrate.sh`'s "trigger a deploy" step is now a push to `main` (or re-running the
  publish workflow), not a `docs.yml` dispatch.

# Explanation: architecture

This explains *why* the versioned site is built the way it is — the design
reasoning behind the `assemble` scripts and the build/publish workflow split. For
the *what* (inputs, options, copy-paste snippets), see the
[reference](../reference/workflows.md) and [tutorial](../tutorials/adding-to-a-fresh-repo.md).

## The core idea: reconstruct the whole site every deploy

Every deploy rebuilds the **complete** site tree from authoritative sources and
publishes it **directly to GitHub Pages** via `actions/upload-pages-artifact` +
`actions/deploy-pages`. There is **no `gh-pages` branch** — `deploy-pages` publishes
one artifact as the *entire* site, which is a whole-site-replace. The four source
kinds and their durability are in the
[reference](../reference/workflows.md#what-publish-yml-gathers).

Releases are permanent, so old versions never vanish. PR previews come from CI
artifacts and silently drop if the artifact expires and nothing rebuilds — fine for
*optional* preview docs. The **default branch** is the one fragile *required* version
(artifact-only, yet guarded — `assemble` hard-fails rather than publish a site missing
it), so each deploy keeps a copy of its `docs.zip` in the **Actions cache**; a deploy
whose fresh artifact has expired restores the branch from there.

That copy used to be published into the site itself, at `_sources/<branch>.zip`. That
was permanent, which the cache is not — but it also shipped a multi-megabyte zip inside
every Pages artifact, forever, on a site already pressing against a hard 1 GB ceiling
(see [below](#why-the-site-has-a-size-limit)). The cache is evicted after 7 days without
a read, and by LRU past 10 GB, so a repo that goes quiet for over a week *and* whose
default-branch CI artifact has also expired loses the rung and the deploy hard-fails —
loudly, and fixed by one push. That is the accepted trade. (A gh-pages migration keeps
its old `/main/` content only until the default branch builds docs under the new
pipeline — see [migrate-from-gh-pages](../how-to/migrate-from-gh-pages.md).)

(why-the-site-has-a-size-limit)=
### Why the site has a size limit

Reconstructing everything has one cost that grows without bound: `upload-pages-artifact`
tars the **whole** site into a single artifact, and GitHub Pages rejects that artifact
over **1 GB**. A long-lived project reaches it. blueapi, at 131 released `docs.zip`s, was
already at 452 MB and adding ~5 MB per release — a few years from deploys simply failing,
with nothing on the way to say so.

Two things follow.

`publish.yml` takes a **`max-releases`** input: publish only the N most recent releases,
ranked by the tagged commit's date. It defaults to `0` (unlimited), so upgrading never
silently deletes versions from an existing site — but the paved path in the
[tutorial](../tutorials/adding-to-a-fresh-repo.md) sets it, and any deploy whose assembled
site passes 700 MB says so in a warning. Older releases keep their `docs.zip` assets and
come back the moment you raise the cap. See
[keep-the-site-small](../how-to/keep-the-site-small.md).

Ranking is on the release's `created_at`, never on parsing the version number: tags are
too inconsistent across repos for a parser to be safe, and `published_at` lies whenever an
old release is re-published (blueapi has a `1.3.2-a9` created in 2025 and published in
2026, which under `published_at` outranks the genuinely newer `1.11.3`).

The same pressure is why the default branch's durable copy moved out of the site and into
the Actions cache, and why the gather caches release assets rather than re-downloading
~450 MB of immutable zips on every event.

### Why this replaced the `gh-pages` + `keep_files` model

The previous model (mirrored from `python-copier-template-example`) had three
problems for a MyST/book-theme site:

1. **The CI `docs.zip` artifact is not locally previewable.** book-theme emits
   *root-absolute* asset URLs (`/build/_assets/app.css`) regardless of `BASE_URL`,
   so opening `index.html` over `file://` resolves assets against the filesystem root
   → 404 → unstyled, broken. There is no relative-path mode. Local preview means
   `myst start`, or serving a `BASE_URL`-free build over HTTP.
2. **`BASE_URL` is mandatory and per-version.** Each version lives at
   `/<repo>/<version>/` and must be built with `BASE_URL=/<repo>/<version>`. One
   build cannot serve two paths.
3. **`keep_files: true` accumulation drifts.** The published site becomes whatever
   has piled up on `gh-pages` over time; there is no single source of truth, and the
   branch history grows without bound.

Reconstructing the live set every deploy and letting `deploy-pages` replace the
whole site makes deletion self-healing: a merged PR or a deleted release simply
isn't gathered next time, so it disappears — no `keep_files` drift, no branch to
prune.

### Migrating from gh-pages

Two facts make the [cutover](../how-to/migrate-from-gh-pages.md) safe and fix its
ordering:

- **Flipping the Pages source from a branch to GitHub Actions is non-destructive.**
  The last `gh-pages` deployment keeps serving until the first Actions deploy
  supersedes it ([community
  discussion #158055](https://github.com/orgs/community/discussions/158055)) — so the
  source can be flipped up front, with no downtime and no blank window.
- **A publish replaces the *whole* site, so the default branch must have a source before
  any publish runs.** A publish with nothing to stage at `/<default>/` would drop it. The migration therefore *seeds* the default branch (a published
  `pages-default-seed` release captured from the old gh-pages tree) before the first
  publish — which is the pipeline PR's own CI. This makes that first publish safe even
  when the repo already serves Pages from Actions (where a publish deploys live
  immediately); an un-seeded publish fails loudly rather than silently dropping the branch.

## The `docs.zip` / version-name contracts

Two contracts (described in the [reference](../reference/workflows.md#the-docs-zip-version-name-contracts))
keep build and reconstruction in sync. The design rationale in both is to eliminate
sanitisation:

- **`docs.zip`**: packing and delivering the same file verbatim (once as the `docs`
  artifact, once as the Release asset) means a single contract with no repack step —
  nothing to drift between the two delivery paths.
- **Version name**: the name must be both the site sub-dir *and* the `BASE_URL` — a
  mismatch produces root-absolute asset 404s. Making them identical by construction
  (clean tokens: `pr-<n>`, `main`, or a tag without `/`) means nothing to transform,
  nothing to drift, and no parity test to maintain.

## Split build (unprivileged) from publish (privileged)

A `pull_request` run from a **fork** gets a read-only `GITHUB_TOKEN` and no secrets —
a deliberate security boundary, so a PR can't deface the site or exfiltrate secrets.
The architecture makes that boundary structural by splitting build from publish:

- **CI (unprivileged)** runs `myst build` and uploads the `docs` artifact for
  *every* event, forks included. It never holds a write token.
- **`publish.yml` (privileged)** runs `assemble` + the Pages deploy. It runs only in
  the trusted upstream context.

So a fork's build can never reach a write token; only trusted code deploys.

### Why publish is *nested* in CI (for internal events)

The deploy is surfaced as a **job inside the CI run** (`ci.yml`'s `publish` job →
`publish-dispatch.yml` shim → `publish.yml` via `workflow_call`) so its status and URL are
visible on the PR / commit — rather than running invisibly after the fact. A single
`publish` job runs for **every** event; `publish.yml` does the branching.

`publish.yml` is the `workflow_call` **engine** and owns all the publish branching,
reached only through a thin `publish-dispatch.yml` shim that exposes it as both
`workflow_call` (the inline `publish` job) and `workflow_dispatch` (the tag
re-dispatch, the fork-PR opt-in, manual re-deploys). It routes each event to one of three
jobs: **deploy** (internal PR / default-branch push, or a dispatch), **re-dispatch** (a tag
— below), or **warn** (a fork PR — read-only, never deploys, just posts the manual-opt-in
hint; this replaced the old warning step in the build job). A fork PR can't reach a write
token (its `GITHUB_TOKEN` is read-only and `deploy` is `if`-excluded for forks), so the
security boundary holds while the hint lives next to the rest of the publish logic. The
shim exists only because a reusable workflow can't be `workflow_dispatch`'d cross-repo, so
the re-dispatch job needs a local file to re-fire — it `gh workflow run`s the shim by name
(`dispatch-workflow`), which works because a called workflow runs with the *caller's* repo
and token. This repo dogfoods the exact shim a consumer adds (theirs just pins
`publish.yml@<tag>`).

The cost of nesting is an environment-policy change: because internal PRs now deploy
from **their own ref**, the `github-pages` environment's deployment-branch policy must
allow those refs. The alternative — triggering publish via `workflow_run` after CI
completes — keeps deploys on the default branch only, but at the price of the deploy
being invisible on the PR. This project chose visibility. (Tags are the exception —
they deploy from the default-branch ref via the re-dispatch below, not their own ref.)

### Why tags deploy via a `workflow_dispatch` re-dispatch

A release tag is cut on the merge commit, so it shares the default branch's
just-deployed SHA. `deploy-pages` stamps every deployment with
`pages_build_version = GITHUB_SHA` — it has no input to change it, and the value is
server-validated against the deploy OIDC token's commit claim, so a unique value
can't be forced (it 404s; see [`actions/deploy-pages#383`](https://github.com/actions/deploy-pages/issues/383)).
The Pages backend then silently **drops a second deploy of an already-deployed SHA**
on a non-`workflow_dispatch` event — it reports success and flips the deployment
record active, but the origin keeps serving the *first* artifact. So an inline tag
deploy would "succeed" while the site stayed on the pre-tag build.

The one documented escape hatch: a `workflow_dispatch` deploy of that same SHA
*forces* a re-serve. So tags don't deploy inline — `publish.yml`'s `re-dispatch` job
waits for `ci.yml`'s parallel `release` job to attach the new `docs.zip`, then
`gh workflow run`s the shim as a `workflow_dispatch`; that run re-gathers from durable
sources (now including the new release) and deploys, and because its event is
`workflow_dispatch` the origin updates. `main` and internal-PR deploys are the *first* of
their SHA, so they serve fine inline and keep their PR/commit visibility. This all lives
in the shared engine — the consumer's only dispatch-related file is the thin shim (a
reusable workflow can't be dispatched cross-repo, so the re-dispatch job needs a local file
to re-fire).
The post-deploy origin-verify step in `publish.yml` backstops any residual stale
origin by failing the run instead of serving stale docs silently.

### Why the current build is *injected*

Because the inline publish runs *inside* the build's own CI run, that run isn't a
*completed* successful run yet — so `assemble`'s normal gather can't discover it. For
a `main` push it would be worse than missing: the gather would find the **previous**
successful run and publish a build behind by one commit. So `ci.yml` passes the
build's version name to `publish.yml`, which downloads this run's `docs` artifact and
stages it into the gather dir as the **highest-priority** source — overwriting any
same-name zip gathered from durable sources. Everything else still comes from durable
sources. The dispatch paths (the tag re-dispatch and the fork opt-in) pass no current
build — they gather entirely from durable sources, the tag from its just-attached
`docs.zip` Release asset and a fork from its approved head SHA's successful run.

## The inline-bash / JS split inside `assemble`

The `assemble` logic is split between `publish.yml` inline steps and `assemble.mjs`
(sparse-checked-out at `job.workflow_sha`):

- **`publish.yml`'s gather and extract steps** do the IO plumbing — `gh` downloads,
  `unzip`, `mv`, the `stable/` symlink — as inline bash. The steps are individually
  named so each one's timing and failures are visible in the GH Actions UI.
- **`assemble.mjs`** is the pure-ish kernel: ordering, prerelease detection,
  `switcher.json`/redirect rendering, and the folded-in required-branch guard. Its
  functions take plain data and return strings/verdicts, so they unit-test without
  git, the network, or the filesystem.

Pure bash is ruled out — semver ordering, prerelease detection and JSON rendering
are not unit-testable in bash. Bash never parses JSON itself: every extraction uses
`gh`'s built-in `-q`/`--jq` (it embeds real jq), never a piped standalone `jq` — a
`gh … | jq` pipe would mask an API failure as empty output. Gather order encodes
priority — releases first, then branch CI overwrites them, then the current build
overwrites those; all version-ordering and prerelease logic lives in `generate`.

## Fork-PR previews: per-commit maintainer opt-in

The risk with a fork PR is not the build (it never holds a write token) but
**serving fork-authored HTML/JS under the canonical `*.github.io` domain** —
phishing/defacement under a trusted URL, and free arbitrary-content hosting. So a
fork preview is **never automatic** and is **pinned to a specific commit**:

- A maintainer who has reviewed the PR runs `publish.yml` via `workflow_dispatch`
  with the PR number. That privileged run (only write-access users can dispatch it)
  sets a `preview-approved` **commit status** on the PR's *current head SHA*, then
  assembles.
- `assemble` includes a fork PR **only when its head SHA carries that status**.
  Approval is therefore **per-commit**: a new push changes the head SHA, the status
  no longer matches, and the preview **silently drops on the next deploy** until a
  maintainer re-approves — closing the bait-and-switch hole (approve benign docs,
  then push malicious content).
- The approval is durable GitHub state (a commit status), re-read by *every*
  assemble, so it survives unrelated deploys. Closing/merging the PR drops it (gather
  is open-PRs only); a maintainer can `POST` a `failure` status to revoke early.

Rejected alternatives: **`pull_request_target`** (privileged but checks out base code
— building PR-head content under it is the classic RCE footgun, since a MyST build
runs PR-authored plugins); **auto-publishing every fork PR** (unattended untrusted
content on the canonical domain); **the fork's own Pages** (required all-branch push
triggers and gave contributors no canonical preview).

## Stable alias

Other projects fetch this site's `objects.inv` for cross-references, so they need a
**stable URL that always points at the latest release** — not a version number that
changes every release. The site therefore publishes a `stable/` alias.

- **`stable/` is the newest deployed non-prerelease tag — never `main`.** Before the
  first release there is no `stable/`; the root redirect falls back to `main`.
- **It is a symlink in the assembled tree** (`ln -s "$preferred" stable`).
  `upload-pages-artifact` tars with `--dereference`, so it is inflated to a real copy
  at deploy.
- **The root `index.html` redirects to `stable/`** (a constant target) whenever it
  exists, so the canonical entry URL never changes.

MyST writes **base-relative** URIs into `objects.inv`, so a consumer pointing
intersphinx at `…/repo/stable/` resolves every target under `/stable/` — the links
stay stable rather than pinning to a concrete version.

The widget keeps `switcher.json` listing **real versions only** (no `stable` entry),
with `preferred: true` on the latest release. Visiting `/stable/` selects the
concrete release it aliases (so the dropdown shows e.g. `v2.0`, not a separate
"stable" item), and switching to a pinned version preserves the page path onto it.
The `stable` segment name is a fixed convention, hardcoded in the widget.

## Edge cases

- **First deploy:** no releases, only `main` built → single-entry `switcher.json`,
  redirect → `main/`. Graceful; no release required.
- **Release without `docs.zip`** (cut before this scheme): not selected by the
  releases query (it filters on a `docs.zip` asset) → skipped, no hard failure.
- **Release with a differently-rooted `docs.zip`**: served fine. The extract takes
  the zip's single top-level directory whatever it is named, so an immutable release
  asset packed by another pipeline (python-copier-template's `_release.yml` roots
  its zip at the tag name, not `html/`) still deploys. A zip with *no* single root
  directory is malformed → warning, skipped.
- **Default branch missing**: if `main` has no recent successful CI artifact, no cached
  copy, and no migration seed release, the deploy **hard-fails** rather than publish a
  site missing it.
- **PR build not yet green / SHA moved:** an open PR whose current head SHA has no
  successful CI run is skipped; its preview appears once the build passes.
- **Merged/closed PR:** drops from the gather (open-PRs only) on the next deploy.
- **Prereleases:** excluded from `preferred`/redirect (an `a`/`b`/`rc` marker
  following a digit, PEP 440 style — parity with the release workflow; a tag that
  merely contains those letters, like `release-1.0`, is not a prerelease), but still
  listed in the switcher if gathered.
- **Concurrency:** `concurrency: { group: pages, cancel-in-progress: false }` makes
  deploys last-writer-wins; reconstructing from durable sources keeps that mostly
  self-healing.

## Deferred: a release-layer cache

Re-downloading and unzipping every release's `docs.zip` on every deploy is the one
recurring cost that scales with the number of releases. A GitHub Actions cache of the
immutable released-tags layer could skip those re-downloads, but it is **deliberately
not built yet** — the dominant cost (N sequential `gh` round-trips) is already
addressed by one paginated releases call, and the benefit is zero at adoption. The
full analysis and an implementation sketch are tracked as future work in
[issue #6](https://github.com/DiamondLightSource/myst-version-switcher-plugin/issues/6).

## Key resolved decisions

- **No action wrapper — `publish.yml` runs `assemble/` directly** (self-checked-out
  at `job.workflow_sha`, so the scripts match the workflow's own ref). The build half
  (`docs.yml`) computes the clean token inline and uploads the `docs` artifact.
- **Direct Pages publish, no `gh-pages` branch** (`upload-pages-artifact` +
  `deploy-pages`), requiring the repo's Pages source set to "GitHub Actions".
- **JS core + inline-bash glue.** Pure functions (and their node tests) live in
  `assemble.mjs`; the `gh`/`unzip`/`mv` IO lives as inline bash steps in
  `publish.yml` — individually named so step timing and failures are visible in
  the GH Actions UI. Python was a contender (the team is Python-heavy) but loses
  on a second toolchain in a JS-only repo.
- **`release.yml` attaches `docs.zip`** (it downloads the run's artifacts and
  creates/uploads the Release via `gh`, verbatim), so `assemble` only ever *reads*
  release assets.

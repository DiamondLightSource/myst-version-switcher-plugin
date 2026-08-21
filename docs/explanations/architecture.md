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
[reference](../reference/workflows.md#what-the-engine-gathers).

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

The engine takes a **`max-releases`** input: publish only the N most recent releases,
ranked by the tagged commit's date. It defaults to `0` (unlimited), so upgrading never
silently deletes versions from an existing site — but the paved path in the
[tutorial](../tutorials/adding-to-a-fresh-repo.md) sets it, and a deploy whose *packed*
artifact passes 700 MB says so in a warning. Packed, not the tree on disk: HTML and JS
compress around 3×, so measuring the directory would cry wolf at a third of real usage. Older releases keep their `docs.zip` assets and
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
- **`publish-gh-pages.yml` (privileged)** runs `assemble` + the Pages deploy. It runs only in
  the trusted upstream context.

So a fork's build can never reach a write token; only trusted code deploys.

(why-publishing-listens-instead-of-being-called)=
### Why publishing listens instead of being called

Publishing is **not** a job in `ci.yml`. It is a separate `publish.yml` in the consumer's
repo, triggered by `workflow_run` when their CI workflow completes, which then calls the
`publish-gh-pages.yml` engine.

It used to be nested, deliberately, so the deploy's status and URL showed on the PR. Two
things made that wrong.

The first is cost. Reconstructing the site is **O(the whole site)** and completely
independent of what changed — the same 24 releases, the same open PRs, the same upload,
whichever PR triggered it. Nesting that put a large constant inside every PR's critical
path. The first consumer to adopt this switched PR previews off one day later, because a
650-second deploy had been bolted onto a 40-second docs build.

The second is that the visibility was never the PR author's to act on. A red check for a
wedged Pages origin, on a dependency-bump PR, is noise that trains people to ignore CI.

`workflow_run` fixes both: the deploy runs afterwards on its own run, and a failure is
visible where the people who can fix it are looking.

### What listening deleted

The trigger change was mostly **subtraction**, because three separate pieces of machinery
existed only to work around the old shape.

**The tag trampoline.** A release tag is cut on the merge commit, so it shares the default
branch's just-deployed SHA, and `deploy-pages` stamps every deployment with
`pages_build_version = GITHUB_SHA` — no input to change it, and the value is
server-validated against the OIDC commit claim, so a unique one can't be forced (it 404s;
see [`actions/deploy-pages#383`](https://github.com/actions/deploy-pages/issues/383)).
Pages silently drops a *second* deploy of an already-deployed SHA on some events: it
reports success and flips the deployment record active, but the origin keeps serving the
first artifact. A tag deploy would "succeed" while the site stayed on the pre-tag build.

The old fix was a trampoline: tags re-fired a locally dispatchable shim so the deploy
landed as a `workflow_dispatch`, which does force a re-serve.

`workflow_run` forces a re-serve too. That was established by experiment rather than
inference, because the documented rule does not predict it — on 2026-08-21 four
consecutive deploys at the *identical* build version
`b24237484c3b445469c2db4ef161410a185fcdbc` (a push to `main`, a tag cut on that same
commit, and two pushes to one PR) each updated the live origin. So a tag's deploy re-serves
directly, and the trampoline is gone.

**The shim.** `publish-dispatch.yml` existed *only* because a reusable workflow cannot be
`workflow_dispatch`'d cross-repo, so the trampoline needed a local file to re-fire. No
trampoline, no shim. What consumers carry now is one `publish.yml` that calls the engine.

**The in-run artifact injection.** A nested publish runs *inside* the build's own run, so
that run is not yet a completed success and the gather cannot discover it — worse, on a
`main` push the gather would find the *previous* run and publish a build one commit behind.
So the build's version name was threaded through `ci.yml` and the shim, and its artifact
staged as the highest-priority source. `workflow_run` fires *after* the triggering run
completes, so the ordinary gather finds it. Nothing to inject, nothing to thread.

The read-only `warn` job went the same way: a fork's CI never reaches the engine, because
the caller excludes it.

### The trap `workflow_run` brings with it

In a `workflow_run` run, `GITHUB_SHA` and `github.ref` are **always the default branch's
HEAD** — never the commit that was built. A PR-triggered deploy reports `refs/heads/main`.

That is mostly harmless (it is why the same-SHA question mattered at all), but it silently
breaks anything that asks "was this the default branch?". Both of the engine's cache-save
steps did exactly that, and gating on `github.ref` would have had every PR-triggered deploy
writing caches scoped to a PR that nothing else can read. They test
`github.event.workflow_run.head_branch` instead.

Because that lives in an `if:` expression rather than a shell script, the gather harness
cannot reach it; `test/workflow-harness/test_shape.py` asserts it structurally, along with
the caller's two guards — all of which fail *open*, and so would never announce themselves.

### Fork PRs still cannot deploy themselves

`workflow_run` runs with a **write token even when a fork's pull request triggered it** —
the classic pwn-request shape, and a real hazard rather than a theoretical one. The caller
therefore requires `head_repository.full_name == github.repository`, so a fork's build
never reaches the engine automatically. A maintainer publishes a preview by dispatching
`publish.yml` with the PR number, which records approval against that exact head SHA; a
later push to the PR drops the preview until re-approved.

## The inline-bash / JS split inside `assemble`

The `assemble` logic is split between `publish-gh-pages.yml` inline steps and
`assemble.mjs` (sparse-checked-out at `job.workflow_sha`):

- **the engine's gather and extract steps** do the IO plumbing — `gh` downloads,
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
priority — releases first, then branch CI overwrites them; all version-ordering and
prerelease logic lives in `generate`.

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
- **Concurrency:** `concurrency: { group: pages, cancel-in-progress: true }`. Cancelling
  a superseded deploy is safe *because* every deploy reconstructs the whole site — the
  one that replaces it gathers everything the cancelled one would have. This was unsafe
  while publish was nested in CI, where cancelling marked an unrelated PR's run cancelled.

## The release-layer cache

Re-downloading and unzipping every release's `docs.zip` on every deploy was the one
recurring cost that scaled with the number of releases, and it stopped being theoretical
once a consumer reached 131 of them: 114 seconds per deploy, on every event, fetching the
same immutable bytes.

The engine now caches them (`actions/cache`, keyed on the exact set of asset ids it
intends to publish, files named by **asset id** so a re-cut release cannot be served from
a stale entry, and pruned to the published set so a capped site keeps a capped cache).
Steady state is a total hit; cutting a release downloads exactly one zip.

Caches are written only when the **default branch** was what got built — one saved while
a PR is the trigger is scoped to that PR and unreadable by anything else, so saving there
would only churn the 10 GB repo quota.

## Key resolved decisions

- **No action wrapper — the engine runs `assemble/` directly** (self-checked-out
  at `job.workflow_sha`, so the scripts match the workflow's own ref). The build half
  (`docs.yml`) computes the clean token inline and uploads the `docs` artifact.
- **Direct Pages publish, no `gh-pages` branch** (`upload-pages-artifact` +
  `deploy-pages`), requiring the repo's Pages source set to "GitHub Actions".
- **JS core + inline-bash glue.** Pure functions (and their node tests) live in
  `assemble.mjs`; the `gh`/`unzip`/`mv` IO lives as inline bash steps in
  `publish-gh-pages.yml` — individually named so step timing and failures are visible in
  the GH Actions UI. Python was a contender (the team is Python-heavy) but loses
  on a second toolchain in a JS-only repo.
- **`release.yml` attaches `docs.zip`** (it downloads the run's artifacts and
  creates/uploads the Release via `gh`, verbatim), so `assemble` only ever *reads*
  release assets.

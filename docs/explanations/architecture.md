# Explanation: architecture

This explains *why* the versioned site is built the way it is — the design
reasoning behind the `assemble` action and the build/publish workflow split. For
the *what* (inputs, options, copy-paste snippets), see the
[reference](../reference/action.md) and [tutorial](../tutorials/adding-to-a-fresh-repo.md).

## The core idea: reconstruct the whole site every deploy

Every deploy rebuilds the **complete** site tree from authoritative sources and
publishes it **directly to GitHub Pages** via `actions/upload-pages-artifact` +
`actions/deploy-pages`. There is **no `gh-pages` branch** — `deploy-pages` publishes
one artifact as the *entire* site, which is a whole-site-replace.

| version kind | source | durability |
|---|---|---|
| current build | the build injected into the action this run | n/a (just built) |
| released tags | the `docs.zip` asset attached to each **GitHub Release** | permanent |
| branch previews (e.g. `main`) | the latest successful CI run's `docs` **artifact** | ephemeral (fine — branches move) |
| open PRs (`pr-<n>`) | each PR's build artifact, keyed by head SHA | ephemeral (drops on merge/close) |

Releases are permanent, so old versions never vanish. Branch and PR previews come
from CI artifacts and silently drop if the artifact expires and nothing rebuilds —
acceptable for *optional* dev/preview docs. A required branch (the default branch)
is guarded: `assemble` hard-fails rather than publish a site missing it. This
asymmetry — releases durable, the default branch only ever an ephemeral artifact —
also drives the gh-pages migration: keep `gh-pages` until the default branch is
itself publishing `docs.zip`, because until then it is the only durable copy of that
branch's docs (see [migrate-from-gh-pages](../how-to/migrate-from-gh-pages.md)).

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

## The `docs.zip` and version-token contracts

Two small contracts let the build (in CI) and the reconstruction (in `assemble`)
agree without coordinating:

- **`docs.zip` is one zip with a bare `html/` root.** The CI build packs it once and
  delivers the *same file* two ways — uploaded verbatim as the `docs` artifact
  (every run, `compression-level: 0` since it is already compressed) and attached
  verbatim as the `docs.zip` Release asset on tags. So there is a single contract and
  no repack; both release and branch/PR gather unzip the same `html/` shape.
- **The version name is both the site sub-dir and the `BASE_URL`.** A mismatch
  produces a version whose root-absolute assets 404, so the two must be identical.
  They are, by construction: the name is `pr-<n>` (an integer), `main` (the default
  branch), or a tag without `/` (the `tags: ['*']` trigger never matches `/`). The
  build sets `BASE_URL=/<repo>/<version-name>` and `assemble` files the artifact at
  `site/<version-name>` — the same literal name on both sides. There is **no
  sanitisation**: with nothing to transform, there is nothing to drift, and no parity
  test to maintain.

## Split build (unprivileged) from publish (privileged)

A `pull_request` run from a **fork** gets a read-only `GITHUB_TOKEN` and no secrets —
a deliberate security boundary, so a PR can't deface the site or exfiltrate secrets.
The architecture makes that boundary structural by splitting build from publish:

- **CI (unprivileged)** runs `myst build` and uploads the `docs` artifact for
  *every* event, forks included. It never holds a write token.
- **`_publish` (privileged)** runs `assemble` + the Pages deploy. It runs only in the
  trusted upstream context.

So a fork's build can never reach a write token; only trusted code deploys.

### Why publish is *nested* in CI (for internal events)

The deploy is surfaced as a **job inside the CI run** (`ci.yml`'s `publish` job →
`_publish.yml` via `workflow_call`) so its status and URL are visible on the PR /
commit — rather than running invisibly after the fact. But this is gated to
**internal events only**: the `publish` job's `if` excludes fork PRs
(`head.repo.full_name != github.repository`). A fork PR's build instead emits a
warning (a step in the build job) that the preview was not published, linking the
manual opt-in. The privileged `_publish` is therefore reachable two ways, both
trusted: `workflow_call` (nested, internal) and `workflow_dispatch` (the maintainer
fork opt-in).

The cost of nesting is an environment-policy change: because internal PRs and tags
now deploy from **their own ref**, the `github-pages` environment's deployment-branch
policy must allow those refs. The alternative — triggering publish via
`workflow_run` after CI completes — keeps deploys on the default branch only, but at
the price of the deploy being invisible on the PR. This project chose visibility.

### Why the current build is *injected*

Because publish now runs *inside* the build's own CI run, that run isn't a
*completed* successful run yet — so `assemble`'s normal gather can't discover it. For
a `main` or tag push it would be worse than missing: the gather would find the
**previous** successful run and publish a build behind by one commit. So `ci.yml`
passes the build's version name to `_publish`, which hands it to `assemble` as
`artifact-version-name`; the action downloads this run's `docs` artifact and
`assemble` unzips + stages it directly, **skipping the re-gather of that version**.
Everything else still comes from durable sources. The fork opt-in path passes no current build — there the fork is
gathered from durable sources via its approved head SHA's successful run.

## The bash / JS split inside `assemble`

`assemble` is a composite action (`action.yml`) over two implementation files:

- **`assemble.sh`** does the IO plumbing — `gh` downloads, `unzip`, `mv`, the
  `stable/` symlink — where shelling out is concise. It is also runnable standalone,
  so the `gh` plumbing can be exercised locally.
- **`assemble.mjs`** is the pure-ish kernel: ordering, prerelease detection,
  `switcher.json`/redirect rendering, and the folded-in required-branch guard. Its
  functions take plain data and return strings/verdicts, so they unit-test without
  git, the network, or the filesystem.

Pure bash is ruled out — semver ordering, prerelease detection and JSON rendering
are not unit-testable in bash. Bash never parses JSON itself: every extraction uses
`gh`'s built-in `-q`/`--jq` (it embeds real jq), never a piped standalone `jq` — a
`gh … | jq` pipe would mask an API failure as empty output. Gather order is
irrelevant; all ordering and prerelease logic lives in `generate`.

## Fork-PR previews: per-commit maintainer opt-in

The risk with a fork PR is not the build (it never holds a write token) but
**serving fork-authored HTML/JS under the canonical `*.github.io` domain** —
phishing/defacement under a trusted URL, and free arbitrary-content hosting. So a
fork preview is **never automatic** and is **pinned to a specific commit**:

- A maintainer who has reviewed the PR runs `_publish.yml` via `workflow_dispatch`
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
- **Default branch missing** (`guard-default-branch: true`): if `main` has no recent
  successful build to gather and none was injected, `generate` **hard-fails** rather
  than publish a site missing it.
- **PR build not yet green / SHA moved:** an open PR whose current head SHA has no
  successful CI run is skipped; its preview appears once the build passes.
- **Merged/closed PR:** drops from the gather (open-PRs only) on the next deploy.
- **Prereleases:** excluded from `preferred`/redirect (an `a`/`b`/`rc` marker, parity
  with the release workflow), but still listed in the switcher if gathered.
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

- **One thin action wrapper, `assemble/`, over the `assemble.mjs` kernel.** The build
  half needs no action — it computes the clean token inline and uploads the `docs`
  artifact.
- **Direct Pages publish, no `gh-pages` branch** (`upload-pages-artifact` +
  `deploy-pages`), requiring the repo's Pages source set to "GitHub Actions".
- **JS core + bash glue.** Pure functions (and their node tests) live in
  `assemble.mjs`; bash does the `gh`/`unzip`/`mv` IO. Python was a contender (the
  team is Python-heavy) but loses on a second toolchain in a JS-only repo.
- **`_release.yml` attaches `docs.zip`** (it downloads the run's `docs` artifact and
  uploads it verbatim), so the action only ever *reads* release assets.

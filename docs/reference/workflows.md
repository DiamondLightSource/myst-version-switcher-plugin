# Reference: the reusable workflows + contracts

The public interface is two reusable workflows consumed by `uses:` at a `<tag>`, from two
different files in your repo:

```yaml
# ci.yml — builds, never publishes
jobs:
  docs:
    uses: DiamondLightSource/myst-version-switcher-plugin/.github/workflows/docs.yml@<tag>
    with:
      build-command: make docs
```

```yaml
# publish.yml — a separate workflow, triggered by ci.yml FINISHING
on:
  workflow_run: { workflows: [CI], types: [completed] }
  workflow_dispatch: { inputs: { pr: { required: false, default: "" } } }
jobs:
  publish:
    if: >-
      github.event_name == 'workflow_dispatch' ||
      (github.event.workflow_run.conclusion == 'success' &&
       github.event.workflow_run.head_repository.full_name == github.repository)
    uses: DiamondLightSource/myst-version-switcher-plugin/.github/workflows/publish-gh-pages.yml@<tag>
    with:
      pr: ${{ inputs.pr }}
      max-releases: "30"
      max-prs: "20"
    permissions:
      pages: write
      id-token: write
      contents: read
      actions: read
      statuses: write
```

The full copy-paste versions are in the
[tutorial](../tutorials/adding-to-a-fresh-repo.md). The site-reconstruction logic
(`assemble/`) is **internal** — `publish-gh-pages.yml` runs it directly; it is not a
separately consumed action.

## `docs.yml` — build (unprivileged)

Builds the docs at the versioned `BASE_URL`, packs `docs.zip` (single `html/` root dir),
and uploads the `docs` artifact. Declares `contents: read` only —
it never holds a write token. Installs `uv` unconditionally and relies on the runner's
preinstalled Node, so `build-command` can be `make` / `npx` / `tox` / `npm` driven.

| input | required | default | meaning |
|---|---|---|---|
| `build-command` | **yes** | — | Command that builds the HTML site. Run with `BASE_URL` and `VERSION_NAME` set. Fold any project setup (`npm ci`, `cp CONFIG`, apt deps) into it. |
| `html-dir` | no | `docs/_build/html` | Directory the build writes the site to. Its contents are staged into `docs.zip`'s `html/` root, so any name works. |
| `base-path` | no | `""` (→ `/<repo>`) | URL path the site is served at, without the version segment. Set to `/` for a custom domain or an `ORG.github.io` repo — see [custom domains](../how-to/use-a-custom-domain.md). |

## `publish-gh-pages.yml` — assemble + deploy (privileged)

`workflow_call` only, one `deploy` job: gather → extract → `assemble.mjs generate` →
`upload-pages-artifact` → `deploy-pages` → verify the served origin. Call it from a
`publish.yml` that triggers on your CI workflow completing.

| input | required | default | meaning |
|---|---|---|---|
| `pr` | no | `""` | Fork PR number to approve (pins its head SHA as `preview-approved`) and preview. Set on the caller's `workflow_dispatch` path. |
| `max-releases` | no | `"0"` | Publish only the N most recent releases, ranked by the tagged commit's date (`created_at`); `0` = all of them. |
| `max-prs` | no | `"0"` | Publish previews for only the N most recently built open PRs; `0` = all of them. |

Both caps exist because the site deploys as **one** Pages artifact against a hard
**1 GB** limit, which a long-lived project will eventually hit. Set them as **literals**
in `publish.yml`'s `with:` block so they apply on every path. See
[keep-the-site-small](../how-to/keep-the-site-small.md). A cap that is not a
non-negative integer fails the deploy rather than being read as `0`/unlimited.

:::{note} `.mvs/` is reserved
The job checks your repo out at the workspace root and this project's `assemble/` into
`.mvs/` beside it, so a repo of your own with a `.mvs/` directory would collide. Nothing
else in the workspace is touched, and the checkout is discarded with the runner.
:::

### What approving a fork preview grants

The `pr` input publishes fork-authored HTML and JavaScript to your Pages site, and a
project Pages site shares an **origin** with every other Pages site in the org:
`https://ORG.github.io`. Same origin means the same `localStorage`, the same
service-worker scope and any cookies scoped to that host — so an approved preview is not
sandboxed from the rest of the organisation's documentation.

The mechanism is deliberately tight: the approval is a commit status **pinned to the head
SHA**, so a later push drops the preview until a maintainer re-approves, which closes the
approve-then-push hole. What it cannot do is judge the content for you. Treat approving as
a **code review of the built output** — look at what the PR adds to the docs, not only at
whether CI is green. If you only need to check that the docs build, CI already told you
that without publishing anything.

## What it reports back

On a successful deploy the engine posts a `docs-preview` commit status on the commit that
triggered it, with the published URL as its target — so a PR carries a link to its own
preview, and a default-branch or tag build links the version it produced.

It is posted **only on success, and only ever as a success**. Publishing runs off the PR's
critical path because a wedged Pages origin is not the author's to fix; a status that could
turn red would hand that straight back to them. A missing status means "not published
(yet)". If the version directory is not in the deployed tree — a fork PR whose number
cannot be resolved, say — nothing is posted rather than a link that 404s.

Requires `statuses: write`, which the caller already grants for fork-preview approval.

## What the engine gathers

Every deploy rebuilds the complete tree from authoritative inputs:

| version kind | source | durability |
|---|---|---|
| default branch (e.g. `main`) | newest `docs` artifact built from that branch → the **Actions cache** copy (hard-fail if neither exists) | cached — re-saved on each default-branch deploy; evicted after 7 days unread |
| released tags | the `docs.zip` asset attached to each **GitHub Release**, newest `max-releases` of them (the migration seed release, if present, seeds the default-branch zip and is never capped) | permanent |
| open PRs (`pr-<n>`) | each PR's `docs` artifact, keyed by current head SHA, newest `max-prs` of them — internal always, fork PRs only when the SHA carries a `preview-approved` status | ephemeral — drops when the PR merges/closes |

Branch and PR artifacts are found via the **artifacts API by name** (`docs` — the
artifact name is the contract), not by workflow filename, so the consumer's entry
workflow can be called anything. The URLs baked into `switcher.json` use the site's
live Pages URL from the **Pages API**, so a custom domain (CNAME) is reflected there
without configuration — but the *pages* those URLs point at are built at whatever
`docs.yml`'s `base-path` says, so a custom domain needs that input set too. See
[use-a-custom-domain](../how-to/use-a-custom-domain.md).

Release assets are immutable, so the gather caches them (`actions/cache`, keyed on the
exact set of asset ids it intends to publish) and downloads only what it has not seen —
usually nothing, or one zip for a new release. PR artifacts cannot be cached (a head SHA
changes on every push), so those downloads run in parallel and the artifacts API is
paginated **once** and indexed by head SHA rather than re-queried per PR.

Both caches are keyed on a **content hash** — the set of asset ids to publish, and
`docs.zip`'s own bytes — never on a commit, so an unchanged input adds no entry. The
branch is not in either key because GitHub scopes entries to the ref that wrote them, and
saves are gated on the default branch having been the thing that was built.

A version no longer gathered (a merged/closed PR, a deleted release) is correctly
dropped, because `deploy-pages` replaces the *entire* site. Sources are gathered in
priority order, so a fresher source always wins when names collide. There are two rungs,
not three: a release's `docs.zip` (or the migration seed) first, then the branch/PR CI
artifact over the top. The build that triggered the deploy is not a rung of its own —
under `workflow_run` the engine runs *after* that build completed, so its `docs`
artifact is simply the newest one the artifacts API lists. The default branch has a
third fallback below both: the Actions cache copy, used only when its CI artifact has
expired.

## The `docs.zip` / version-name contracts

Two contracts let the build (`docs.yml`) and the reconstruction (`assemble`) agree
without passing anything between them:

- **`docs.zip` unzips to exactly one top-level directory.** `docs.yml` packs it once,
  rooted at `html/`, and it is delivered the *same file* two ways: uploaded verbatim as
  the `docs` artifact (every run), and attached verbatim as the `docs.zip` Release asset
  on tags. The extract side is deliberately looser than the pack side: it takes that
  single directory's **contents** and ignores its **name**, because release assets are
  durable and may predate this pipeline — python-copier-template's `_release.yml` roots
  its zip at the tag name (`1.2.3/`), and an immutable release cannot be re-cut. Zero
  entries, several entries, or files loose at the zip root are malformed: that version
  is skipped with a warning rather than guessed at.
- **The version name is the site sub-dir *and* the `BASE_URL`.** It is `pr-<n>` for
  PRs, else the ref name (the default branch, or a tag without `/`). `docs.yml` sets
  `BASE_URL=<base-path>/<version-name>`; nothing passes that name onward, because the
  gather re-derives the identical string from the same facts (a release's tag, a PR's
  number, the repo's `default_branch`) and unpacks the zip at `site/<version-name>`.
  Same name on both sides, so assets never 404. The name is **validated**, not assumed
  clean: it must be non-empty and match `[A-Za-z0-9._-]`, or the build fails with the
  reason. In this repo it is clean by construction (the `tags: ['*']` trigger never
  builds `/`-tags), but `docs.yml` is reusable and a consumer can trigger it on any ref
  they like — git allows `$( )`, backticks and quotes in a ref name.

## Internals: `assemble.mjs`

The pure logic lives in `assemble/assemble.mjs` and is unit-tested (`npm test`) without
git, the network, or the filesystem. Three subcommands, all deciding *what* while the
workflow does the IO:

- **`select-releases`** — which releases contribute a version, and the `actions/cache`
  key for exactly that set (so a capped site cannot end up with an uncapped cache entry).
- **`select-artifacts`** — which CI artifact becomes the default branch, and which open
  PRs get a preview, with fork approval resolved by the caller beforehand.
- **`generate`** — version ordering, prerelease detection, `switcher.json` and the root
  redirect, the `stable/` alias source, and the required-branch guard. (The deploy stamp
  the verify step polls, `deploy-id.txt`, is written by the workflow alongside it — it is
  runner state, not a decision.)

Every version the site serves appears in `switcher.json`, **PR previews included** — a
`pr-<n>` entry in the dropdown is deliberate, so a reviewer can jump to a preview from
any page. They are ordered after the default branch and the tags, and disappear when the
PR closes.

Tags are ordered by `compareTags`, not by `git tag --sort=-v:refname`: git's version sort
ranks `1.1.0-beta.1` *above* `1.1.0`, and the prerelease rule and the ordering rule are
better off sharing one marker list than being kept in step by hand.

All the "which of these is newest?" questions — the release cap, the PR cap, the
default-branch artifact, the newest artifact per head SHA — go through one comparator, so
they cannot break a timestamp tie differently from each other. The `gh`/`unzip`/`mv` IO
plumbing lives as inline bash steps in `publish-gh-pages.yml`'s `deploy` job — named
and separated so step timing and failures are visible in the GH Actions UI, and covered
by a harness that loads those steps out of the YAML and runs them against a mock `gh`.

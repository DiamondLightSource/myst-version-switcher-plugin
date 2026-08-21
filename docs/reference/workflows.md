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
      max-releases: "20"
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
| `pr` | no | `""` | Fork PR number to approve (pins its head SHA as `preview-approved`) and preview. Set on the caller's `workflow_dispatch` path. |
| `max-releases` | no | `"0"` | Publish only the N most recent releases, ranked by the tagged commit's date (`created_at`); `0` = all of them. The site deploys as **one** Pages artifact against a hard **1 GB** cap, which a long-lived project will eventually hit. Set it as a **literal** in `publish.yml`'s `with:` block so it applies on every path. See [keep-the-site-small](../how-to/keep-the-site-small.md). |

## What the engine gathers

Every deploy rebuilds the complete tree from authoritative inputs:

| version kind | source | durability |
|---|---|---|
| default branch (e.g. `main`) | newest `docs` artifact built from that branch → the **Actions cache** copy (hard-fail if neither exists) | cached — re-saved on each default-branch deploy; evicted after 7 days unread |
| released tags | the `docs.zip` asset attached to each **GitHub Release**, newest `max-releases` of them (the migration seed release, if present, seeds the default-branch zip and is never capped) | permanent |
| open PRs (`pr-<n>`) | each PR's `docs` artifact, keyed by current head SHA — internal always, fork PRs only when the SHA carries a `preview-approved` status | ephemeral — drops when the PR merges/closes |

Branch and PR artifacts are found via the **artifacts API by name** (`docs` — the
artifact name is the contract), not by workflow filename, so the consumer's entry
workflow can be called anything. The URLs baked into `switcher.json` use the site's
live Pages URL from the **Pages API**, so a custom domain (CNAME) works.

Release assets are immutable, so the gather caches them (`actions/cache`, keyed on the
exact set of asset ids it intends to publish) and downloads only what it has not seen;
downloads run in parallel, and the artifacts API is paginated **once** and indexed by
head SHA rather than re-queried per PR. Caches are written only from the default branch,
because a cache saved on a PR ref is scoped to that PR and unreadable by any other run.

A version no longer gathered (a merged/closed PR, a deleted release) is correctly
dropped, because `deploy-pages` replaces the *entire* site. Sources are gathered in
priority order (releases lowest, then branch CI, then the current build highest), so a
fresher source always wins when names collide.

## The `docs.zip` / version-name contracts

Two contracts let the build (`docs.yml`) and the reconstruction (`assemble`) agree
without coordination — `docs.yml` owns both:

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
  `BASE_URL=/REPO/<version-name>` and `assemble` files the artifact at
  `site/<version-name>` — the same literal name on both sides, so assets never 404.
  There is **no sanitisation**: version names are clean by construction (the
  `tags: ['*']` trigger never builds `/`-tags).

## Internals: `assemble.mjs`

The pure logic (ordering, prerelease detection, `switcher.json`/redirect rendering,
the required-branch guard) lives in `assemble/assemble.mjs` and is unit-tested
(`npm test`) without git, the network, or the filesystem. The `gh`/`unzip`/`mv` IO
plumbing lives as inline bash steps in `publish.yml`'s `deploy` job — named and
separated so step timing and failures are visible in the GH Actions UI.

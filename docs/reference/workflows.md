# Reference: the reusable workflows + contracts

The public interface is two reusable workflows consumed by `uses:` at a `<tag>` —
`docs.yml` directly from `ci.yml`, and `publish.yml` via a local `publish-dispatch.yml`
shim (one per repo — see the [tutorial](../tutorials/adding-to-a-fresh-repo.md)):

```yaml
jobs:
  docs:
    uses: DiamondLightSource/myst-version-switcher-plugin/.github/workflows/docs.yml@<tag>
    with:
      build-command: make docs
  publish:
    needs: [docs]
    if: github.repository == 'ORG/REPO'
    uses: ./.github/workflows/publish-dispatch.yml
    with:
      version-name: ${{ needs.docs.outputs.version-name }}
    permissions:
      pages: write
      id-token: write
      contents: read
      actions: write
      statuses: write
```

The site-reconstruction logic (`assemble/`) is **internal** — `publish.yml` runs it
directly; it is not a separately consumed action.

## `docs.yml` — build (unprivileged)

Builds the docs at the versioned `BASE_URL`, packs `docs.zip` (single `html/` root dir),
and uploads the `docs` artifact. Declares `contents: read` only —
it never holds a write token. Installs `uv` unconditionally and relies on the runner's
preinstalled Node, so `build-command` can be `make` / `npx` / `tox` / `npm` driven.

| input | required | default | meaning |
|---|---|---|---|
| `build-command` | **yes** | — | Command that builds the HTML site into `html-dir` at `$BASE_URL`. Fold any project setup (`cp CONFIG`, `npm ci`, apt deps) behind it. |
| `html-dir` | no | `docs/_build/html` | Directory the build writes the site to; staged into `docs.zip` as its single root directory, `html/`. |

| output | meaning |
|---|---|
| `version-name` | The version this build was served at (`pr-<n>` \| default-branch \| `<tag>`) — pass to `publish.yml`. |

`build-command` runs with two env vars set: **`BASE_URL`**
(`/REPO/<version-name>` — the sub-path the build is served at) and
**`VERSION_NAME`** (the bare version token — for builds that need it directly,
e.g. a Sphinx `conf.py` setting the pydata theme's switcher `version_match`; see
[how-to: use with Sphinx](../how-to/use-with-sphinx.md)).

## `publish.yml` — the engine, owns the branching (privileged)

Reconstructs the whole site and deploys it to Pages, routing each event to one of three
jobs. The `deploy` job carries the `github-pages` environment, `concurrency: pages`, and
`pages`/`id-token`/`statuses` write. Reached only via the `publish-dispatch.yml` shim
(below); the canonical-repo guard lives upstream (in `ci.yml`), so the engine stays
generic.

- **`deploy`** — internal PR / default-branch push (inline), or any `workflow_dispatch`.
  Self-checks-out `assemble.mjs` at `job.workflow_sha` / `job.workflow_repository`
  (the `job` context resolves to the reusable file, not the caller), so the kernel
  matches the `<tag>` the consumer pinned — no version bump; the consumer's repo stays
  checked out at the root so `assemble.mjs`'s `git tag` lists *their* versions. The
  inline path injects the in-run build via `version-name`; the dispatch paths pure-gather.
- **`re-dispatch`** — a tag push. Waits for the tag's **`docs.zip` release asset** —
  not merely for the release record, which a UI-published release creates *before* CI
  even starts, so the deploy would list releases before the asset landed and drop the
  tag from its own site — then re-fires the shim
  (`dispatch-workflow`, a file in the consumer's repo — a `workflow_call` run executes with
  the caller's token, so it can dispatch it) so the deploy lands as a `workflow_dispatch`
  and re-serves.
- **`warn`** — a fork PR. Read-only, never deploys; just posts the manual-opt-in hint.

**Tags must deploy via `workflow_dispatch`**: GitHub Pages silently drops a second deploy
of an already-deployed SHA (a release tag shares the merge commit's SHA) unless the event
is `workflow_dispatch`
([`actions/deploy-pages#383`](https://github.com/actions/deploy-pages/issues/383); see the
[architecture explanation](../explanations/architecture.md)).

## `publish-dispatch.yml` — the thin shim (one per repo)

The only thing that calls `publish.yml`, the single place you pin `publish.yml@<tag>`, and
the **dispatchable file** the re-dispatch job re-fires. It just forwards to the engine via
`workflow_call` (ci.yml's `publish`, every event) and `workflow_dispatch` (the tag
re-dispatch, a fork-PR preview, a manual re-deploy). A reusable workflow can't be
`workflow_dispatch`'d cross-repo, which is why this file lives in each repo.

### `publish.yml` inputs (threaded through by the shim)

| input | required | default | meaning |
|---|---|---|---|
| `version-name` | no | `""` | Version name of **this run's** `docs` artifact to stage directly, instead of gathering it from durable sources. Set by `ci.yml`'s inline publish (the run isn't a completed success yet, so the gather can't discover it — or would find a stale previous build). Empty → pure durable gather (the dispatch paths). |
| `pr` | no | `""` | Fork PR number to approve (pins its head SHA as `preview-approved`) and preview. Set on the shim's `workflow_dispatch` path. |
| `dispatch-workflow` | no | `publish-dispatch.yml` | Filename of the shim in the consumer's repo, re-fired by the `re-dispatch` job. Override only if you renamed the shim. |
| `retry-until` | no | `""` | Internal — epoch-seconds deadline for auto-retrying a wedged Pages origin. Set only by the `re-dispatch` job (15 min from the moment the tag's `docs.zip` asset lands — i.e. from when a deploy first becomes possible, *not* from the release's publish time, which a UI-published release stamps before CI even starts) when it re-fires the shim; carried unchanged through any retries. **The shim must declare + forward this input** (`workflow_dispatch` + the `with:` block below) even though consumers never set it themselves — `re-dispatch` always passes it, and a shim missing the input rejects the dispatch. Don't set manually. |

## What `publish.yml` gathers

Every deploy rebuilds the complete tree from authoritative inputs:

| version kind | source | durability |
|---|---|---|
| current build | this run's `docs` artifact, staged via `version-name` (highest priority — overwrites any same-name gathered source) | n/a (just built) |
| default branch (e.g. `main`) | newest `docs` artifact built from that branch → durable `_sources/<branch>.zip` in the live site (hard-fail if neither exists) | durable — re-persisted into the site each deploy |
| released tags | the `docs.zip` asset attached to each **GitHub Release** (the migration seed release, if present, seeds the default-branch zip) | permanent |
| open PRs (`pr-<n>`) | each PR's `docs` artifact, keyed by current head SHA — internal always, fork PRs only when the SHA carries a `preview-approved` status | ephemeral — drops when the PR merges/closes |

Branch and PR artifacts are found via the **artifacts API by name** (`docs` — the
artifact name is the contract), not by workflow filename, so the consumer's entry
workflow can be called anything. The URLs baked into `switcher.json` (and the
`_sources` restore) use the site's live Pages URL from the **Pages API**, so a
custom domain (CNAME) works.

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

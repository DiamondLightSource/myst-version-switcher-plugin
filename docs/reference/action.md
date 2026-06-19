# Reference: the `assemble` action + workflow contract

`assemble` is a composite action that reconstructs the **whole** versioned docs
site from durable sources and outputs its directory for the caller to publish to
GitHub Pages. It does **not** deploy (that is `deploy-pages`, which is job-scoped and
owned by the caller).

```yaml
- id: site
  uses: DiamondLightSource/myst-version-switcher-plugin/assemble@<tag>
  with:
    repo: ${{ github.repository }}
- uses: actions/upload-pages-artifact@v3
  with: { path: ${{ steps.site.outputs.dir }} }
- uses: actions/deploy-pages@v4
```

It requires Node + `gh` on PATH (preinstalled on GitHub runners) and the repo
checked out with tags (`fetch-depth: 0`, for version ordering + prerelease
detection).

## Inputs

| input | required | default | meaning |
|---|---|---|---|
| `repo` | no | `${{ github.repository }}` | `org/repo`, for version URLs and `gh` lookups. |
| `guard-default-branch` | no | `true` | When `true`, hard-fail if the repo's **default branch** is not in the site — guards against publishing a hole when its latest build artifact has expired. Set `false` only for throwaway previews. |
| `token` | no | `${{ github.token }}` | Token for `gh`: release assets, cross-run artifacts, and the `preview-approved` status. |
| `artifact-version-name` | no | `""` | Version name (`pr-<n>` \| `main` \| `<tag>`) of **this run's** `docs` artifact. When set, the action downloads that artifact and `assemble` unzips + stages it as this version directly, instead of gathering it from durable sources. Used when publishing **inside the build's own CI run** (the run isn't a completed success yet, so the gather can't discover it — or would find a stale previous build). Empty → pure durable gather. |

## Outputs

| output | meaning |
|---|---|
| `dir` | Path to the assembled publish root, for `upload-pages-artifact`. |

## What it gathers

Every deploy rebuilds the complete tree from authoritative inputs:

| version kind | source | durability |
|---|---|---|
| current build | this run's `docs` artifact, downloaded + staged via `artifact-version-name` | n/a (just built) |
| default branch (e.g. `main`) | latest successful CI **push** run's `docs` artifact | ephemeral — self-heals on the next branch CI |
| released tags | the `docs.zip` asset attached to each **GitHub Release** | permanent |
| open PRs (`pr-<n>`) | each PR's build artifact, keyed by current head SHA — internal always, fork PRs only when the SHA carries a `preview-approved` status | ephemeral — drops when the PR merges/closes |

A version no longer gathered (a merged/closed PR, a deleted release) is correctly
dropped, because `deploy-pages` replaces the *entire* site. The version passed as
`artifact-version-name` is staged first and **skipped** by every gather, so a stale
previous build never clobbers the fresh one.

## The `docs.zip` / version-name contracts

Two contracts let the build (in CI) and the reconstruction (in `assemble`) agree
without coordination:

- **`docs.zip` is one zip with a bare `html/` root.** The CI build packs it once and
  delivers the *same file* two ways: uploaded verbatim as the `docs` artifact
  (every run), and attached verbatim as the `docs.zip` Release asset on tags. Both
  the release gather and the branch/PR gather unzip the same `html/` shape.
- **The version name is the site sub-dir *and* the `BASE_URL`.** It is `pr-<n>` for
  PRs, else the ref name (`main`, or a tag without `/`). The build sets
  `BASE_URL=/REPO/<version-name>` and `assemble` files the artifact at
  `site/<version-name>` — the same literal name on both sides, so assets never 404.
  There is **no sanitisation**: version names are clean by construction (the
  `tags: ['*']` trigger never builds `/`-tags).

## Running it standalone

`assemble.sh` is runnable outside the action so the `gh` plumbing can be exercised
locally:

```bash
REPO=DiamondLightSource/myst-version-switcher-plugin GH_TOKEN=$(gh auth token) \
  assemble/assemble.sh
```

It is driven entirely by env (`REPO`, `GUARD_DEFAULT_BRANCH`, `GH_TOKEN`, `SITE`,
and — for injection — `ARTIFACT_VERSION_NAME` + `ARTIFACT_ZIP`, the `docs.zip` the
action downloads before calling the script). The pure logic
(ordering, prerelease detection, `switcher.json`/redirect rendering, the
required-branch guard) lives in `assemble.mjs` and is unit-tested without git, the
network, or the filesystem.

## Caller workflow shape

The caller owns two workflows split by privilege; see the
[architecture explanation](../explanations/architecture.md) for the why and the
[tutorial](../tutorials/adding-to-a-fresh-repo.md) for the full copy-paste snippets:

- An **unprivileged CI** builds at `BASE_URL=/REPO/<version-name>`, uploads the `docs`
  artifact, and (on tags) attaches `docs.zip` + the plugin to the Release. It then
  nests the publish reusable workflow as a job — **for internal events only**.
- A **privileged `_publish`** reusable workflow runs `assemble` →
  `upload-pages-artifact` → `deploy-pages`, carrying the `github-pages` environment +
  `pages`/`id-token`/`statuses` permissions + `concurrency`. It is reachable two
  ways: `workflow_call` (the nested internal path) and `workflow_dispatch` (the
  maintainer fork-PR opt-in).

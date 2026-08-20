# How-to: choose which events publish the site

The [tutorial](../tutorials/adding-to-a-fresh-repo.md)'s `publish` job runs on **every**
event and lets `publish.yml` do the branching:

```yaml
  publish:
    needs: [docs]
    if: github.repository == 'ORG/REPO'
    uses: ./.github/workflows/publish-dispatch.yml
```

Every deploy rebuilds the *whole* site from durable sources, so this is also what makes
the site **self-healing**: any deploy that came out wrong is corrected by the next one,
whatever triggered it. Narrowing the gate trades that away, so narrow it deliberately.

## If per-PR deploys are too noisy

Each deploy takes a few minutes and they serialise on the `pages` concurrency group, so
a busy repo may not want one per PR push. Publish on **tags and the default branch**:

```yaml
  publish:
    needs: [docs]
    if: >-
      github.repository == 'ORG/REPO' &&
      (github.ref_type == 'tag' || github.ref == 'refs/heads/main')
```

You keep PR previews — **any** deploy gathers every open PR's build artifact, so
`/pr-<n>/` still appears; it just refreshes on the next merge to the default branch
rather than on every push to the PR. And you keep self-healing, at merge cadence.

:::{warning}
**Do not narrow it to tags alone.** With

```yaml
    if: github.repository == 'ORG/REPO' && github.ref_type == 'tag'   # ← don't
```

the *only* deploys are release deploys, so nothing corrects a bad one until the next
release. A single missed source then persists for weeks: a real repo that did this
shipped a site that was permanently one release behind, because each release's deploy
was the only chance that release had to reach the site.
:::

## What you cannot narrow away

The `publish` job must still be reached on a **tag** push, even if you only want release
deploys. That is the event that triggers `publish.yml`'s `re-dispatch` job — the
`workflow_dispatch` bounce that is the only way a release's same-SHA deploy reaches the
Pages origin at all (see [the architecture explanation](../explanations/architecture.md)).

Fork PRs are already handled without a gate: they reach the read-only `warn` job, never a
deploy.

## Checking what your gate actually does

On any run, `publish` showing as `skipped` in the job list means no deploy happened for
that event. Compare against the deploy's own job summary — every deploy publishes a
table of each deployed version and the source it came from, so you can see at a glance
whether a version is present and how it got there.

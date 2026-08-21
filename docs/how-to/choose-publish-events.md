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

Deploys serialise on the `pages` concurrency group, so a repo with a lot of PR churn may
not want one per push.

Check the cost before narrowing, though. A deploy that reconstructs a large site used to
take many minutes, and most of that is gone: release assets are cached rather than
re-downloaded, the artifacts API is paginated once instead of once per open PR, and
downloads run in parallel. If it still takes minutes, the site itself is probably too
big — see [keep-the-site-small](keep-the-site-small.md) before trading away
self-healing.

To narrow it anyway, publish on **tags and the default branch**:

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
that event. When one does run, its `Gather release artifacts` step prints a decision for
every release the API listed — gathered, skipped and why — and the extract step reports
the assembled size and version count, so you can see whether a version made it in and
what kept it out.

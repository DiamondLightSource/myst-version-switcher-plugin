# How-to: choose which events publish the site

`publish.yml` fires on **every** completed CI run — pull requests, pushes to the default
branch, and tags alike:

```yaml
on:
  workflow_run:
    workflows: [CI]
    types: [completed]
```

Every deploy rebuilds the *whole* site from durable sources, so this is what makes the
site **self-healing**: any deploy that came out wrong is corrected by the next one,
whatever triggered it. Narrowing the trigger trades that away, so narrow it deliberately.

## Check the cost first

Publishing is no longer on any PR's critical path — it runs after CI, on its own run — so
"it slows my PRs down" is not a reason to narrow it any more. Deploys do still serialise
on the `pages` concurrency group, but each one supersedes the last (`cancel-in-progress:
true`), which is safe precisely because every deploy reconstructs everything.

If a deploy takes minutes, the site itself is probably too big rather than the trigger too
broad — see [keep-the-site-small](keep-the-site-small.md).

## If you still want fewer deploys

Narrow the job's `if:` in your `publish.yml`. To publish only on the default branch and
tags, skip the runs whose triggering event was a pull request:

```yaml
jobs:
  publish:
    if: >-
      github.event_name == 'workflow_dispatch' ||
      (github.event.workflow_run.conclusion == 'success' &&
       github.event.workflow_run.head_repository.full_name == github.repository &&
       github.event.workflow_run.event != 'pull_request')
```

You keep PR previews either way — **any** deploy gathers every open PR's build artifact,
so `/pr-<n>/` still appears; it just refreshes on the next merge rather than on every
push. And you keep self-healing, at merge cadence.

:::{danger}
**Never narrow it to tags alone.** With only release deploys, nothing corrects a bad one
until the next release, and a single missed source persists for weeks. A real repo did
exactly this and shipped a site that was permanently one release behind, because each
release's deploy was the only chance that release ever had to reach the site.
:::

## What you must not remove

The two guards in the shipped `if:` are not style:

- **`conclusion == 'success'`** — `workflow_run` fires on failed runs too, and a failed
  run has no usable `docs` artifact.
- **`head_repository.full_name == github.repository`** — `workflow_run` runs with a
  **write token** even when a fork's pull request triggered it. Dropping this hands
  untrusted code a privileged path to your live site. Fork builds reach the site only
  when a maintainer dispatches `publish.yml` with a `pr` number, which records approval
  against that exact head SHA.

Both fail *open* if removed — the site keeps deploying and nothing looks wrong — so
`test/workflow-harness/test_shape.py` asserts them in this repo. Consider the same if you
edit your copy.

## Checking what your trigger actually does

`publish.yml` runs appear under Actions as their own runs, not as checks on the PR. A run
that skipped shows the `publish` job as skipped. When one does deploy, its
`Gather release artifacts` step prints a decision for every release the API listed —
gathered, skipped, and why — and the extract step reports the assembled size and version
count, so you can see whether a version made it in and what kept it out.

# How-to: migrate from an existing `gh-pages` site

If your docs already publish to a `gh-pages` branch (the `keep_files` model), this
moves you onto the reconstruct-from-durable-sources model **in a single pipeline PR**,
**without losing any served version**, and with an instant rollback until the very last
step. It is **two local `migrate.sh` runs, with your pipeline PR doing the deploy in
between**:

1. **`migrate.sh ORG/REPO`** — backfill releases, seed the default branch, flip the
   Pages source to Actions + open the environment policy. *Uploads and flips only — no
   deploy.*
2. **Open + merge your pipeline PR** — its CI runs the first publish, which reads the
   seed to stage the default branch, and then builds the branch's own docs.
3. **`migrate.sh ORG/REPO --delete-gh-pages`** — verify the live site, then delete
   `gh-pages` + the seed release.

## What you are migrating onto (read this first)

Every deploy reconstructs the whole site from sources with **very different
durability** — and the safety of the migration hinges on that difference (see the
[architecture explanation](../explanations/architecture.md)):

| version | source under the new model | durable? |
|---|---|---|
| released tags | a `docs.zip` asset on each **GitHub Release** | **yes, permanent** — but only once attached |
| default branch (`main`) | its own CI `docs` artifact, with a copy kept in the Actions cache | **yes** — once the branch builds its own docs (seeded in run 1 until then) |
| open PRs (`pr-<n>`) | each PR's build artifact | no — drops on merge/close |

Two consequences drive the procedure:

1. **Your old releases are not durable yet.** Their docs exist only as directories on
   `gh-pages`; the matching Releases have no `docs.zip`. So run 1 includes a one-time
   **backfill** of `docs.zip` onto those Releases — not just a config flip. (A tag with
   a `gh-pages` directory but **no Release at all** gets one *created* with the
   `docs.zip` — covering repos that tag without releasing, and fork rehearsals, since
   forking copies tags but not Releases.) If your Releases *already* carry a `docs.zip`
   from a previous pipeline, the backfill leaves them alone and they are used as-is —
   the extract takes the zip's single root directory whatever it is named, so
   python-copier-template's tag-name-rooted zips (`1.2.3/` rather than `html/`) need no
   re-cutting, which matters because an immutable release cannot be re-cut anyway.
2. **The default branch has no source until it builds docs itself.** Each deploy
   gathers it from its own CI artifact, keeping a copy in the Actions cache for when
   that artifact expires — but before the branch has ever built under the new pipeline
   there is nothing to gather. So run 1 **seeds** it: it captures the gh-pages
   `<default>/` tree as a published seed release, which the first publish reads and
   stages as `/<default>/` — *before* the default branch ever builds docs itself. The
   seed carries it until the branch's own build takes over.

For *why* this ordering is safe — the non-destructive source flip and the
seed-before-publish rule — see the [architecture explanation](../explanations/architecture.md#migrating-from-gh-pages).

:::{important} The one rule that matters
*Keep `gh-pages` until the default branch builds its own docs under the new pipeline.*
Until then the seed — and `gh-pages` behind it — is the only copy there is. The
`--delete-gh-pages` guard checks exactly that, and will not delete before it holds.
Deleting `gh-pages` is the **separate, gated final run**, never part of run 1, and it
removes the seed release too.
:::

## Optional: rehearse on a fork first

To de-risk the real migration, run the whole thing on a fork before touching the
upstream site. A fork copies the repo's `gh-pages` branch and tags — but **not the
Releases** — so the backfill *creates* a Release (with the `docs.zip`) for every tag
that has a `gh-pages` directory. The migration therefore has the same inputs and keeps
every version, and it deploys to *your* `github.io`, never upstream's.

1. **Fork the repo and enable Actions on the fork** (the **Actions** tab → enable
   workflows; forks start with Actions disabled). You have admin on your own fork,
   which is what the Pages-source flip in step 2 needs.
2. **Run `migrate.sh` against the fork** — dry-run first, then for real:

   ```bash
   scripts/migrate.sh FORKORG/REPO --dry-run
   scripts/migrate.sh FORKORG/REPO
   ```

3. **Point the publish guard at your fork.** The pipeline's `publish` job is gated
   `if: github.repository == 'ORG/REPO'` so only the canonical repo deploys — on a fork
   that is false, so nothing publishes. On your pipeline branch, comment that line out
   (or set it to `FORKORG/REPO`) so the fork deploys.
4. **Open and merge the pipeline PR on the fork**, working on the fork's `main`. Its CI
   runs the first publish and deploys to `https://FORKORG.github.io/REPO/` — open that
   and check the site and switcher.
5. **When it works, undo the trial change and go upstream.** Restore the guard to
   `github.repository == 'ORG/REPO'` (uncomment / set it back) and open the real PR
   against upstream, then follow the steps below on the upstream repo.

:::{note} What the fork trial does and doesn't cover
It exercises the full prepare → publish path (backfill, seed, the first deploy that
stages `/<default>/` from the seed), and you can even rehearse the destructive finalize
(`migrate.sh FORKORG/REPO --delete-gh-pages`) without risk — it only touches the fork.
The `<tag>` pins still resolve to this project's upstream releases, so the reusable
workflows behave identically. The only path it doesn't auto-cover is a release: push a
tag to the fork if you also want to rehearse the tag re-dispatch.
:::

## Before you start

- Run the script from the **myst-version-switcher-plugin devcontainer** (it needs `gh`,
  `zip`, and `node`, which the devcontainer provides).
- Authenticate `gh` with **repo-admin** on the target repo — run `gh auth login` if
  needed (flipping the Pages source and setting the environment policy need admin; a CI
  token can't — which is why this is a local script).
- If the script detects it is running in a clone of the target repo it will use that,
  otherwise it will clone the repo itself.

## Step 1 — dry-run (recommended)

```bash
scripts/migrate.sh ORG/REPO --dry-run
```

It prints the backfill + seed plan, then a **drop report**: every version the live
site's `switcher.json` currently lists that the new model will *not* serve (not the
default branch, not an open-PR preview, and no tag + `gh-pages` directory to backfill
from or existing `docs.zip` Release). Dropped versions stay on `gh-pages` until
finalize, so they are recoverable — cut a real Release (or restore the tag) for any you
want to keep before proceeding. It ends by probing the current site; nothing is
uploaded and nothing is flipped.

## Step 2 — prepare (uploads + flips; no deploy)

```bash
scripts/migrate.sh ORG/REPO
```

It does the following, then **stops with `gh-pages` intact and still serving**:

1. **Backfill (non-destructive, idempotent).** For each tag that is a `gh-pages`
   directory: zip that directory (bare `html/` root) and attach it as `docs.zip` to its
   Release — or, if no Release exists for the tag, *create* one with the `docs.zip`
   (flagged prerelease for `a`/`b`/`rc` tags). Tags containing `/` are skipped.
2. **Seed the default branch.** Capture the gh-pages `<default>/` tree (or the
   `--seed-from <dir>` directory, if the old site published it under another name) as
   the published `pages-default-seed` release, so the default branch has a source before
   any publish.
3. **Flip the Pages source → GitHub Actions** and **open the `github-pages` environment's
   `deployment_branch_policy`** to "no restriction" (so deploys from PR/tag refs — which
   run under the nested-publish model — aren't rejected by the environment). The flip is
   non-destructive; the site keeps serving the last `gh-pages` deployment until step 3
   publishes.

No deploy is triggered here — that is your pipeline PR's job.

## Step 3 — publish, via your pipeline PR

Prepare the new pipeline + `myst.yml` changes from the
[tutorial](../tutorials/adding-to-a-fresh-repo.md) on a branch, and **open the PR only
after run 1 has seeded the default branch** (so its first publish is safe). Then open
and merge it: its CI runs the first **publish** — with the source on Actions, the seed
present, and the env policy open, it reconstructs the whole site
(default branch from the seed, the backfilled releases, any open PRs) and deploys it.
Merging then has the default branch build its own docs, which supersede the seed and make
it redundant.

Confirm the site is live on the new model (visit `https://ORG.github.io/REPO/` and the
switcher) before finalizing.

## Step 4 — finalize (irreversible)

Once the publish has deployed **and the default branch has built its own docs**:

```bash
scripts/migrate.sh ORG/REPO --delete-gh-pages
```

(Or run it right after merging with `--wait`: the guard then polls until it passes — up
to 30 minutes — instead of failing immediately.)

This **guards** the deletion. It refuses unless both hold:

1. `https://ORG.github.io/REPO/<default>/` returns `200` — the default branch is live in
   the new Actions-deployed site; and
2. a non-expired `docs` artifact exists for the default branch — its CI really builds
   `docs.zip` now.

Condition 1 alone is not enough: it is satisfied while `/<default>/` is still coming from
the migration seed, which is precisely the state where `gh-pages` remains the only real
copy. Only once the branch builds its own docs is `gh-pages` genuinely redundant.

The guard then verifies the live site, asks you to type the repo name, deletes
`gh-pages`, **and deletes the seed release** (the branch's own build supersedes it).
After this, the rollback is gone.

:::{warning} Old pages that reference `gh-pages` at runtime
Docs built under the old model sometimes embed a hardcoded version switcher that reads
`gh-pages` live — via the GitHub *contents API* (`…/contents?ref=gh-pages`) or by
loading assets from a `gh-pages` URL. Those pages are reconstructed verbatim from their
`docs.zip`, so the references remain. After deletion, a switcher that only *queries the
API* degrades harmlessly: the request `404`s, its populate script throws an uncaught
promise (console-only), and the version list simply empties — the page itself is intact.
Anything that *loads assets* (CSS/JS/images) from `gh-pages`, though, will break. `grep`
your old release pages for `gh-pages` before finalizing and accept (the switcher
emptying is usually fine) or fix what you find.
:::

## Rollback

Between run 1 (step 2) and the deletion (step 4), `gh-pages` is no longer *served* but
still *exists* — your rollback. If anything is wrong, flip the Pages source back to
**Deploy from a branch / `gh-pages`** and serving is restored instantly, with nothing
lost. That is exactly why the deletion is a separate, gated run.

## Flags

| flag | effect |
|---|---|
| `--dry-run` | Print the backfill + seed plan and the drop report + probe the current site only; upload nothing; skip the flip. |
| `--delete-gh-pages` | **The only mode that deletes.** Guard that the default branch is live *and* builds its own `docs` artifact, verify the live site, then delete `gh-pages` **and the seed release**. |
| `--pages-ref <ref>` | `gh-pages` ref to read (default `origin/gh-pages`). |
| `--seed-from <dir>` | `gh-pages` directory to seed the default branch from, when the old site published it under a different name (e.g. `latest/`). |
| `--yes` | Skip the typed confirmation before deleting `gh-pages` (with `--delete-gh-pages`; use with care). |
| `--wait` | With `--delete-gh-pages`: poll (up to 30 min) until the guard passes instead of failing immediately — lets you finalize right after merging the pipeline PR. |

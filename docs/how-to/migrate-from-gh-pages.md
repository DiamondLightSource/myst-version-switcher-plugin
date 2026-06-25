# How-to: migrate from an existing `gh-pages` site

If your docs already publish to a `gh-pages` branch (the `keep_files` model), this
moves you onto the reconstruct-from-durable-sources model **in a single PR into your
default branch**, **without losing any served version**, and with an instant
rollback until the very last step.

## What you are migrating onto (read this first)

Every deploy reconstructs the whole site from sources with **very different
durability** — and the safety of the migration hinges entirely on that difference
(see the [architecture explanation](../explanations/architecture.md)):

| version | source under the new model | durable? |
|---|---|---|
| released tags | a `docs.zip` asset on each **GitHub Release** | **yes, permanent** — but only once attached |
| default branch (`main`) | persisted each deploy into the site at `_sources/<branch>.zip` | **yes** — once one deploy has captured it (seeded at cutover) |
| open PRs (`pr-<n>`) | each PR's build artifact | no — drops on merge/close |

Two consequences drive the whole procedure:

1. **Your old releases are not durable yet.** Their docs exist only as directories on
   `gh-pages`; the matching Releases have no `docs.zip`. So migration includes a
   one-time **backfill** of `docs.zip` onto those Releases — not just a config flip.
2. **The default branch has no permanent source until a deploy captures it.** Each
   deploy persists the branch's `docs.zip` into the published site
   (`_sources/<branch>.zip`) and restores it from there when the CI artifact expires —
   but before the *first* such capture there is nothing in the site, and `gh-pages` is
   the only recoverable copy of `/main/`. So the cutover **seeds** it: it captures the
   gh-pages `<default>/` tree as a published seed release, which the first deploy reads
   and persists to `_sources/<branch>.zip`. After that the in-site copy carries `/main/`
   — *before* the default branch ever builds docs itself — which is what lets a repo cut
   over to the reusable workflow in **one PR**, ahead of `docs→main`.

> **The load-bearing rule:** *keep `gh-pages` until `_sources/<default>.zip` is live in
> the deployed site* (the cutover seed gets you there on the first deploy; the
> `--delete-gh-pages` guard probes exactly this). Deleting `gh-pages` is a **separate,
> gated step**, never part of the cutover — and it removes the seed release too.

## Before you start

- `gh` authenticated with **repo-admin** on the target repo (flipping the Pages
  source needs admin; a CI token can't — which is why this is a local script).
- Prepare the new pipeline + `myst.yml` changes from the
  [tutorial](../tutorials/adding-to-a-fresh-repo.md) as **one PR**, but **don't merge it
  (or let its `publish` deploy) until the cutover has seeded the default branch** — the
  cutover (Step 2) seeds first, then uses that PR's CI as the first Actions deploy, and
  you merge afterwards. See the ordering note below.
- Run the script from **inside a clone of the target repo**: it reads the repo's tags
  and `gh-pages` tree from the working directory (it fetches `origin/gh-pages` for
  you). Running it from anywhere else will find no tags/branches.

> **Ordering — seed before any publish.** Flipping the Pages source to GitHub Actions
> is **non-destructive**: the last `gh-pages` deployment keeps serving until the first
> Actions deploy supersedes it ([confirmed
> here](https://github.com/orgs/community/discussions/158055)), so there is no downtime
> and no "blank site" window. The one rule that matters is **seed the default branch
> before any v0.7.0 `publish` runs** — a `publish` reassembles and *replaces the whole
> site*, so if it runs before a durable `main` exists it drops `/<default>/`. The
> cutover does exactly that (seed first, deploy second), which is why you run it
> **before merging the pipeline PR**, and let that PR's CI be the first deploy.
>
> This matters most if your repo **already serves Pages from GitHub Actions** (you are
> upgrading an earlier Actions deploy, not a classic `gh-pages` branch): there an
> internal PR's `publish` deploys live the moment it runs, so an un-seeded publish would
> drop `/<default>/` immediately. Seeding first — with `guard-default-branch` at its
> default `true` — makes every publish safe. (On a classic `gh-pages` repo a too-early
> publish instead just fails closed, since `deploy-pages` won't publish until the flip;
> seeding first keeps it green regardless.)

## Step 1 — always dry-run

`scripts/migrate.sh` drives the sequence. Start with `--dry-run`: it prints the
backfill plan and probes the current site, uploading nothing and skipping every
destructive step.

```bash
scripts/migrate.sh ORG/REPO --dry-run
```

Compare the **backfill plan** against the **probe list**: any version the live site
serves that is *not* in the backfill plan is a `gh-pages` directory with **no
matching GitHub Release** — it will be **dropped** from the reconstructed site (it
stays on `gh-pages`, so it is recoverable, but it won't be served). Decide whether
that is acceptable, or cut real Releases for the versions you want to keep first.

## Step 2 — cutover (reversible)

Run it for real:

```bash
scripts/migrate.sh ORG/REPO
```

It executes, in order, then **stops with `gh-pages` intact**:

1. **Backfill (non-destructive, idempotent).** For each release tag that is a
   `gh-pages` directory and whose Release lacks a `docs.zip`, zip that directory as a
   bare `html/` root and attach it as `docs.zip`. Tags containing `/` are skipped.
   This is first: the reconstructed site is built from these assets.
2. **Seed the default branch.** Capture the gh-pages `<default>/` tree as a published
   `pages-default-seed` release, so the default branch is durable *before* any publish
   runs (the whole point of the ordering note above).
3. **Flip the Pages source → GitHub Actions** and **open the `github-pages`
   environment's deployment-branch policy** (to "no restriction", so deploys from
   PR/tag refs — which run under the nested-publish model — aren't rejected). Both are
   done for you. The flip is non-destructive: the last `gh-pages` deployment keeps
   serving until the first Actions deploy; `deploy-pages` only publishes once the source
   is "GitHub Actions", so this precedes the deploy.
4. **Trigger the first Actions deploy.** Pass `--deploy-workflow <file>` to dispatch
   one, or — the recommended path — when prompted, open/merge the pipeline PR (or push
   the default branch) so its CI's `publish` runs. It gathers the default branch from
   the seed and persists `_sources/<default>.zip`.
5. **Verify.** The script fetches `switcher.json` and checks every listed version URL
   returns `200`. Probes are cache-busted, so a too-early probe can't pin a cached
   `404` at the CDN.

It does **not** delete `gh-pages`. You are now live on the new model. The cutover
deploy should have **seeded** the default branch — captured its gh-pages content as a
seed release that this deploy persisted to `_sources/<default>.zip` — so `/main/` is
now served from the in-site copy. `gh-pages` is retained only as the rollback.

## Step 3 — finalize (irreversible), once `_sources/<default>.zip` is live

When the deployed site serves `_sources/<default>.zip` (the cutover seed gets you there;
or, later, the default branch building `docs.zip` itself keeps it fresh), delete
`gh-pages`:

```bash
scripts/migrate.sh ORG/REPO --delete-gh-pages
```

This **guards** the deletion: it refuses unless `https://ORG.github.io/REPO/_sources/<default>.zip`
returns `200` — i.e. the deployed site holds a durable copy of the default branch, so
the new model can reconstruct `/main/` without `gh-pages`. It then re-verifies the live
site, asks you to type the repo name, deletes `gh-pages`, **and deletes the seed
release** (the in-site `_sources` copy supersedes it). After this, the rollback is gone.

> **Caveat — old pages that reference `gh-pages` at runtime.** Docs built under the old
> model sometimes embed a hardcoded version switcher that reads `gh-pages` live — via
> the GitHub *contents API* (`…/contents?ref=gh-pages`) or by loading assets from a
> `gh-pages` URL. Those pages are reconstructed verbatim from their `docs.zip`, so the
> references remain. After deletion, a switcher that only *queries the API* degrades
> harmlessly: the request `404`s, its populate script throws an uncaught promise
> (console-only), and the version list simply empties — the page itself is intact.
> Anything that *loads assets* (CSS/JS/images) from `gh-pages`, though, will break.
> `grep` your old release pages for `gh-pages` before finalizing and accept (the
> switcher emptying is usually fine) or fix what you find.

## Rollback

Between the cutover (step 2) and the deletion (step 3), `gh-pages` is no longer
*served* but still *exists* — your rollback. If anything is wrong, flip the Pages
source back to **Deploy from a branch / `gh-pages`** and serving is restored
instantly, with nothing lost. That is exactly why the deletion is a separate, gated
step.

## Flags

| flag | effect |
|---|---|
| `--dry-run` | Print the backfill plan + probe the current site only; upload nothing; skip flip/deploy. |
| `--delete-gh-pages` | **The only mode that deletes.** Guard that `_sources/<default>.zip` is live (`200`), re-verify, then delete `gh-pages` **and the seed release**. |
| `--pages-ref <ref>` | `gh-pages` ref to read (default `origin/gh-pages`). |
| `--deploy-workflow <file>` | `gh workflow run <file>` to trigger the cutover deploy; omit to be prompted to deploy by hand. |
| `--yes` | Skip the typed confirmation before deleting `gh-pages` (with `--delete-gh-pages`; use with care). |

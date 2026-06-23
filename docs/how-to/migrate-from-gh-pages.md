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
| default branch (`main`) | the **latest CI run's `docs` artifact** | **no** — ephemeral; exists only after the new pipeline runs on the default branch |
| open PRs (`pr-<n>`) | each PR's build artifact | no — drops on merge/close |

Two consequences drive the whole procedure:

1. **Your old releases are not durable yet.** Their docs exist only as directories on
   `gh-pages`; the matching Releases have no `docs.zip`. So migration includes a
   one-time **backfill** of `docs.zip` onto those Releases — not just a config flip.
2. **The default branch is *never* durably stored.** `/main/` is served from an
   ephemeral CI artifact that only exists once the new pipeline has run on the default
   branch. **`gh-pages` is therefore the only recoverable copy of the default branch's
   docs until the default branch is itself building and publishing `docs.zip` under
   the new CI.** Delete `gh-pages` before that and you create an unrecoverable
   `/main/` hole — and trip `assemble`'s default-branch guard on every later deploy.

> **The load-bearing rule:** *keep `gh-pages` until your default branch is publishing
> `docs.zip`.* Deleting it is a **separate, gated step** (`--delete-gh-pages`), never
> part of the cutover.

## Before you start

- `gh` authenticated with **repo-admin** on the target repo (flipping the Pages
  source needs admin; a CI token can't — which is why this is a local script).
- Land the new pipeline + `myst.yml` changes from the
  [tutorial](../tutorials/adding-to-a-fresh-repo.md) as **one PR, and merge it into
  your default branch.** Merging is safe: `gh-pages` keeps serving until you flip the
  Pages source, so the only effect is that the default branch's CI now produces a
  `docs.zip` artifact — which is exactly the precondition the deletion later checks
  for.
- Run the script from **inside a clone of the target repo**: it reads the repo's tags
  and `gh-pages` tree from the working directory (it fetches `origin/gh-pages` for
  you). Running it from anywhere else will find no tags/branches.

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
2. **Flip the Pages source → GitHub Actions** (`gh api PUT …/pages`). `deploy-pages`
   refuses to publish unless the source is already "GitHub Actions", so this must
   precede the deploy.
3. **Trigger a deploy.** Pass `--deploy-workflow <file>` to dispatch one (your
   `publish.yml` `workflow_dispatch` works: the default branch is *gathered* from its
   latest CI artifact, so a pure dispatch still reconstructs `main` + the backfilled
   releases), or push to the default branch / re-run its CI when prompted.
4. **Verify.** The script fetches `switcher.json` and checks every listed version URL
   returns `200`. Probes are cache-busted, so a too-early probe can't pin a cached
   `404` at the CDN.

It does **not** delete `gh-pages`. You are now live on the new model, with `gh-pages`
retained as both the rollback **and** the only durable copy of the default branch's
docs.

## Step 3 — finalize (irreversible), once the default branch publishes `docs.zip`

When the default branch is reliably building + publishing `docs.zip` under the new CI
(it has had a green `ci.yml` run on a push), delete `gh-pages`:

```bash
scripts/migrate.sh ORG/REPO --delete-gh-pages
```

This **guards** the deletion: it refuses unless the default branch has a successful
`ci.yml` push run carrying a live (non-expired) `docs` artifact — i.e. the default
branch really is publishing `docs.zip`, so the new model can reconstruct it without
`gh-pages`. It then re-verifies the live site and asks you to type the repo name
before deleting. After this, the `gh-pages` rollback is gone.

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
| `--delete-gh-pages` | **The only mode that deletes.** Guard that the default branch publishes `docs.zip`, re-verify, then delete `gh-pages`. |
| `--pages-ref <ref>` | `gh-pages` ref to read (default `origin/gh-pages`). |
| `--deploy-workflow <file>` | `gh workflow run <file>` to trigger the cutover deploy; omit to be prompted to deploy by hand. |
| `--yes` | Skip the typed confirmation before deleting `gh-pages` (with `--delete-gh-pages`; use with care). |

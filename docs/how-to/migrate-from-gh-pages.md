# How-to: migrate from an existing `gh-pages` site

If your docs already publish to a `gh-pages` branch (the `keep_files` model), this
moves you onto the reconstruct-from-durable-sources model **without losing any
served version** and with an instant rollback until the very last step.

Your old version history lives as directories on `gh-pages` (e.g. `v0.1.0/`,
`v0.2.0/`, `main/`). The new model reconstructs released versions from `docs.zip`
**Release assets**, which those tags don't have yet — so migration is a one-time,
guarded backfill plus a Pages-source flip, not just a config change.

## Before you start

- You need `gh` authenticated with **repo-admin** on the target repo (flipping the
  Pages source needs admin; a CI token can't do it — which is why this is a local
  script, not a workflow).
- Add the two workflows from the
  [tutorial](../tutorials/adding-to-a-fresh-repo.md) first (CI + `_publish`), so a
  deploy exists to verify against.

## Always dry-run first

`scripts/migrate.sh` performs the whole sequence. Start with `--dry-run`, which
prints the backfill plan and probes the current site but uploads nothing and skips
every destructive step:

```bash
scripts/migrate.sh ORG/REPO --dry-run
```

Check that the backfill plan lists exactly the release tags you expect to recover.

## The migration sequence

Run it for real (drop `--dry-run`):

```bash
scripts/migrate.sh ORG/REPO
```

It executes, in order:

1. **Backfill (non-destructive, idempotent).** For each release tag that is a
   `gh-pages` directory and whose Release lacks a `docs.zip`, it zips that directory
   as a bare `html/` root and attaches it as `docs.zip`. Tags containing `/` are
   skipped (they are never published under the new model). Branch dirs like `main/`
   need nothing — they self-heal on the next branch CI. **This must be first:** the
   reconstructed site is built from these assets.
2. **Flip the Pages source → GitHub Actions** (`gh api PUT …/pages`). It must happen
   here: `deploy-pages` refuses to publish unless the source is already "GitHub
   Actions", so you can't verify a new deploy before flipping.
3. **Trigger a deploy.** Either pass `--deploy-workflow <file>` to dispatch one
   automatically, or push to `main` / re-run CI when prompted. This reconstructs the
   full tree (backfilled `docs.zip` + `main`'s build) and publishes it.
4. **Pause + verify.** The script fetches `switcher.json`, checks every listed
   version URL returns `200`, and waits for your explicit confirmation.
5. **Delete `gh-pages`** — only after step 4 is green.

## Rollback

Between steps 2 and 5 the `gh-pages` branch is no longer *served* but still
*exists* — it is your rollback. If verification fails, flip the Pages source back to
**Deploy from a branch / `gh-pages`** and serving is restored instantly, with no
data lost. That is exactly why the delete is last and gated behind an explicit
confirmation; the script says so when it pauses.

## Useful flags

| flag | effect |
|---|---|
| `--dry-run` | Print the backfill plan + probe the current site only; upload nothing; skip flip/deploy/delete. |
| `--pages-ref <ref>` | `gh-pages` ref to read (default `origin/gh-pages`). |
| `--deploy-workflow <file>` | `gh workflow run <file>` to trigger step 3 automatically; omit to be prompted to deploy by hand. |
| `--yes` | Skip the interactive confirmation before deleting `gh-pages` (use with care). |

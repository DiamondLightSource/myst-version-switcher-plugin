#!/usr/bin/env bash
#
# One-time gh-pages → durable-source migration, run LOCALLY by an operator from
# inside a clone of the TARGET repo (it reads that repo's tags and gh-pages tree
# from the working directory; it fetches origin/gh-pages itself).
#
# Why local, not CI (see docs/how-to/migrate-from-gh-pages.md):
#   - flipping the Pages source needs repo-admin, which a CI GITHUB_TOKEN lacks;
#   - the destructive step wants a human watching with their own `gh auth`;
#   - it leaves no workflow_dispatch stub behind in each consumer repo.
#
# TWO PHASES, because the new model's sources differ in durability. Releases become
# permanent once their docs.zip is attached (backfill). The DEFAULT BRANCH has no
# permanent source until it builds docs.zip itself — so we SEED it: capture the
# gh-pages <default>/ tree as a published seed release, which the cutover deploy reads
# and persists to _sources/<default>.zip in the site. After that the in-site copy is
# the durable source; gh-pages is no longer needed and deleting it is split off behind
# a guard:
#
#   cutover  (default)          backfill → seed → flip Pages → deploy → verify, STOP
#                               (gh-pages retained as the rollback)
#   finalize (--delete-gh-pages) guard _sources/<default>.zip is live → re-verify →
#                               delete gh-pages + the seed release  (rollback dies here)
#
# Until the finalize step, gh-pages still EXISTS (just unserved) and is the rollback:
# flip the Pages source back to "Deploy from a branch" to restore serving instantly.
#
# Usage:
#   scripts/migrate.sh <org/repo> [--dry-run] [--pages-ref <ref>]
#                                 [--deploy-workflow <file>]
#   scripts/migrate.sh <org/repo> --delete-gh-pages [--pages-ref <ref>] [--yes]
#
#   --dry-run            print the backfill + seed plan + probe the current site only;
#                        upload nothing, skip the flip / deploy.
#   --delete-gh-pages    finalize: guard _sources/<default>.zip is live, re-verify,
#                        then delete gh-pages + the seed release. The only mode that
#                        deletes.
#   --pages-ref <ref>    gh-pages ref to read (default: origin/gh-pages)
#   --deploy-workflow    `gh workflow run <file>` to trigger the cutover deploy;
#                        omit to be prompted to trigger a deploy by hand.
#   --yes                skip the typed confirmation before deleting gh-pages.
set -euo pipefail

REPO=""
PAGES_REF="origin/gh-pages"
DEPLOY_WORKFLOW=""
DRY_RUN=false
DELETE_GH_PAGES=false
ASSUME_YES=false
SEED_TAG="pages-default-seed"   # published seed release holding the default branch's docs

usage() {
  echo "usage: scripts/migrate.sh <org/repo> [--dry-run] [--pages-ref <ref>] [--deploy-workflow <file>]" >&2
  echo "       scripts/migrate.sh <org/repo> --delete-gh-pages [--pages-ref <ref>] [--yes]" >&2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --delete-gh-pages) DELETE_GH_PAGES=true; shift ;;
    --yes) ASSUME_YES=true; shift ;;
    --pages-ref) PAGES_REF="$2"; shift 2 ;;
    --deploy-workflow) DEPLOY_WORKFLOW="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "unknown flag: $1" >&2; exit 2 ;;
    *) if [ -z "$REPO" ]; then REPO="$1"; else echo "unexpected arg: $1" >&2; exit 2; fi; shift ;;
  esac
done

if [ -z "$REPO" ]; then usage; exit 2; fi
if $DELETE_GH_PAGES && $DRY_RUN; then
  echo "--delete-gh-pages and --dry-run are mutually exclusive" >&2; exit 2
fi

OWNER="${REPO%%/*}"
NAME="${REPO##*/}"
BASE="https://$(echo "$OWNER" | tr '[:upper:]' '[:lower:]').github.io/$NAME"

# Fetch the gh-pages ref into its remote-tracking ref (a bare `git fetch origin
# gh-pages` only guarantees FETCH_HEAD; we read `$PAGES_REF` by name).
fetch_pages_ref() {
  case "$PAGES_REF" in
    origin/*) git fetch --tags --quiet origin "${PAGES_REF#origin/}:refs/remotes/$PAGES_REF" 2>/dev/null \
                || git fetch --tags --quiet origin "${PAGES_REF#origin/}" || true ;;
    *) git fetch --tags --quiet origin 2>/dev/null || true ;;
  esac
}

# --- backfill docs.zip from the gh-pages tree (non-destructive) --------------
# For each release tag that is a gh-pages dir and whose release lacks a docs.zip,
# zip that dir as a bare html/ and attach it. Tags containing `/` are skipped:
# they are never built/published under the new model. Branch dirs (main/) are NOT
# backfilled here — the default branch self-heals from its own CI artifact once it
# runs the new pipeline (and is the reason gh-pages is kept until then).
backfill() {
  echo
  echo "-- 1. Backfilling docs.zip from $PAGES_REF --"
  fetch_pages_ref
  local pages_dirs tag dir has tmp
  pages_dirs=$(git ls-tree -d --name-only "$PAGES_REF")
  for tag in $(git tag -l); do
    case "$tag" in */*) continue ;; esac                          # not published
    dir="$tag"
    if ! grep -qxF "$dir" <<<"$pages_dirs"; then continue; fi      # no gh-pages dir
    has=$(gh release view "$tag" --repo "$REPO" --json assets \
            -q 'any(.assets[]; .name=="docs.zip")' 2>/dev/null || echo false)
    if [ "$has" = "true" ]; then continue; fi                      # already has it
    echo "   backfill $tag  (from $dir/)"
    if $DRY_RUN; then continue; fi
    tmp=$(mktemp -d)
    git archive "$PAGES_REF" "$dir" | tar -x -C "$tmp"             # → $tmp/$dir/…
    mv "$tmp/$dir" "$tmp/html"
    ( cd "$tmp" && zip -rq docs.zip html )                         # bare html/ root
    gh release upload "$tag" "$tmp/docs.zip" --repo "$REPO" --clobber
    rm -rf "$tmp"
  done
}

# --- seed the default branch durably (so we can cut over before it builds docs) ---
# The default branch has no durable source until it builds docs.zip under the new
# pipeline, and a contents:read deploy can't read a draft — so capture the gh-pages
# <default>/ tree as a docs.zip and PUBLISH it on a sentinel tag (not the branch name).
# assemble reads it once, stages /<default>/, and persists _sources/<default>.zip; from
# then on the in-site copy carries it and this seed is dormant (deleted at finalize).
# This lets a repo cut over to the reusable workflow in ONE PR, before docs→default.
seed_default_branch() {
  echo
  echo "-- 1b. Seeding the default branch durably (published release '$SEED_TAG') --"
  fetch_pages_ref
  local default tmp
  default=$(gh repo view "$REPO" --json defaultBranchRef -q .defaultBranchRef.name)
  if ! git ls-tree -d --name-only "$PAGES_REF" | grep -qxF "$default"; then
    echo "   no '$default/' dir on $PAGES_REF — nothing to seed (skipping)"
    return 0
  fi
  echo "   seed $default  (from $default/ on $PAGES_REF → release '$SEED_TAG')"
  if $DRY_RUN; then return 0; fi
  tmp=$(mktemp -d)
  git archive "$PAGES_REF" "$default" | tar -x -C "$tmp"
  mv "$tmp/$default" "$tmp/html"
  ( cd "$tmp" && zip -rq docs.zip html )                           # bare html/ root
  if gh release view "$SEED_TAG" --repo "$REPO" >/dev/null 2>&1; then
    gh release upload "$SEED_TAG" "$tmp/docs.zip" --repo "$REPO" --clobber
  else
    gh release create "$SEED_TAG" "$tmp/docs.zip" --repo "$REPO" --latest=false \
      --title "Default-branch docs seed (migration)" \
      --notes "Temporary: seeds /$default/ until the default branch builds docs.zip under the new pipeline. Safe to delete once _sources/$default.zip is live in the site."
  fi
  rm -rf "$tmp"
}

# Delete the seed release + its tag (the durable _sources copy supersedes it).
delete_seed_release() {
  if gh release view "$SEED_TAG" --repo "$REPO" >/dev/null 2>&1; then
    echo "-- Deleting the migration seed release '$SEED_TAG' (superseded by _sources) --"
    $DRY_RUN || gh release delete "$SEED_TAG" --repo "$REPO" --cleanup-tag --yes
  fi
}

# --- verify helper (auto-probe) ---------------------------------------------
# Cache-bust every request: probing a path before the deploy has propagated lets
# the CDN cache a 404 for the path's TTL, which would fail a later honest probe.
verify() {
  echo "-- probing $BASE --"
  local versions code ok=true cb
  cb="cb=$(date +%s%N)"
  if ! versions=$(curl -fsSL "$BASE/switcher.json?$cb" | node -e \
        'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const e of JSON.parse(s))console.log(e.version)})'); then
    echo "  FAIL: could not fetch/parse $BASE/switcher.json" >&2
    return 1
  fi
  for v in $versions; do
    code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/$v/?cb=$(date +%s%N)")
    if [ "$code" = "200" ]; then
      echo "  ok   $BASE/$v/  ($code)"
    else
      echo "  FAIL $BASE/$v/  ($code)"; ok=false
    fi
  done
  $ok
}

# --- guard for the irreversible delete --------------------------------------
# gh-pages is the only recoverable copy of the default branch's docs until the SITE
# itself holds a durable copy at _sources/<default>.zip — written each deploy once the
# branch has been gathered (from its own build, or from the migration seed). Probe the
# live site directly: if that copy is served, the default branch survives a gh-pages
# delete (and a later artifact expiry), so it is safe to remove.
guard_default_durable() {
  local default url code
  default=$(gh repo view "$REPO" --json defaultBranchRef -q .defaultBranchRef.name)
  url="$BASE/_sources/$default.zip"
  echo "-- guard: is the default branch ($default) durable in the site (_sources)? --"
  code=$(curl -s -o /dev/null -w '%{http_code}' "$url?cb=$(date +%s%N)")
  if [ "$code" != "200" ]; then
    echo "::error::REFUSING to delete gh-pages: $url is not live ($code)." >&2
    echo "  The deployed site has no durable copy of '$default' yet, so gh-pages is still" >&2
    echo "  the only recoverable copy. Run a deploy (seed, or the default branch's own CI)" >&2
    echo "  so assemble persists _sources/$default.zip, then retry." >&2
    exit 1
  fi
  echo "   ok: $url is live — '$default' is durable independently of gh-pages"
}

echo "== migrate: $REPO (pages-ref=$PAGES_REF, dry-run=$DRY_RUN, delete=$DELETE_GH_PAGES) =="

# ============================================================================
# Finalize: --delete-gh-pages. Guard → re-verify → delete. Nothing else.
# ============================================================================
if $DELETE_GH_PAGES; then
  echo
  guard_default_durable
  echo
  echo "-- Re-verifying the live site before deleting gh-pages --"
  if ! verify; then
    echo
    echo "Verification FAILED — NOT deleting gh-pages. Flip the Pages source back to" >&2
    echo "'Deploy from a branch / gh-pages' to roll back." >&2
    exit 1
  fi
  if ! $ASSUME_YES; then
    echo
    read -r -p "Probes passed and the default branch is durable in the site. Type the repo name ($REPO) to delete gh-pages: " confirm
    if [ "$confirm" != "$REPO" ]; then
      echo "Not confirmed — leaving gh-pages in place (rollback still available)."
      exit 0
    fi
  fi
  echo
  echo "-- Deleting gh-pages (rollback gone after this) --"
  git push origin --delete "${PAGES_REF#origin/}"
  delete_seed_release          # the in-site _sources copy now carries the default branch
  echo "Done. Site is served from GitHub Actions; gh-pages removed."
  exit 0
fi

# ============================================================================
# Cutover: backfill → seed → flip → deploy → verify, then STOP (gh-pages retained).
# ============================================================================
backfill
seed_default_branch

if $DRY_RUN; then
  echo
  echo "-- (dry-run) probing current site --"
  verify || echo "(dry-run probe failed — expected if the site isn't deployed yet)"
  echo
  echo "Dry run complete: backfill + seed plan shown (nothing uploaded); flip/deploy skipped."
  exit 0
fi

# --- Flip Pages source → GitHub Actions -------------------------------------
echo
echo "-- 2. Flipping Pages source → GitHub Actions --"
echo "   (gh-pages still exists after this and is the rollback: set the source"
echo "    back to 'Deploy from a branch' to restore serving with no data lost.)"
gh api --method PUT "repos/$REPO/pages" -f build_type=workflow

# --- Trigger a deploy -------------------------------------------------------
echo
echo "-- 3. Triggering a deploy --"
if [ -n "$DEPLOY_WORKFLOW" ]; then
  gh workflow run "$DEPLOY_WORKFLOW" --repo "$REPO"
  echo "   dispatched $DEPLOY_WORKFLOW; wait for it to finish before continuing."
else
  echo "   No --deploy-workflow given. Trigger a deploy now (push to the default"
  echo "   branch / re-run the latest CI), wait for it to finish, then continue."
fi
read -r -p "   Press Enter once the deploy has completed… " _

# --- Verify -----------------------------------------------------------------
echo
echo "-- 4. Verifying the reconstructed site --"
if ! verify; then
  echo
  echo "Verification FAILED. gh-pages is intact — flip the Pages source back to" >&2
  echo "'Deploy from a branch / gh-pages' to roll back." >&2
  exit 1
fi

echo
echo "Cutover complete. The site is served from GitHub Actions; gh-pages is RETAINED"
echo "as the rollback. This deploy should have persisted the default branch durably to"
echo "_sources/<default>.zip (from the seed); once that is live, gh-pages is no longer"
echo "the only copy."
echo
echo "Finalize (deletes gh-pages AND the seed release) once _sources/<default>.zip is"
echo "live in the site — the finalize guard checks exactly that:"
echo "    scripts/migrate.sh $REPO --delete-gh-pages"

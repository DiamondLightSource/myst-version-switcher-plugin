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
# permanent once their docs.zip is attached (backfill); the DEFAULT BRANCH is only
# ever served from an EPHEMERAL CI artifact, which exists only after the new pipeline
# has run on it. So gh-pages is the only recoverable copy of the default branch's
# docs until that branch is itself publishing docs.zip — and deleting it is split off
# behind a guard:
#
#   cutover  (default)          backfill → flip Pages → deploy → verify, then STOP
#                               (gh-pages retained: rollback AND default-branch copy)
#   finalize (--delete-gh-pages) guard the default branch is publishing docs.zip →
#                               re-verify → delete gh-pages  (the rollback dies here)
#
# Until the finalize step, gh-pages still EXISTS (just unserved) and is the rollback:
# flip the Pages source back to "Deploy from a branch" to restore serving instantly.
#
# Usage:
#   scripts/migrate.sh <org/repo> [--dry-run] [--pages-ref <ref>]
#                                 [--deploy-workflow <file>]
#   scripts/migrate.sh <org/repo> --delete-gh-pages [--pages-ref <ref>] [--yes]
#
#   --dry-run            print the backfill plan + probe the current site only;
#                        upload nothing, skip the flip / deploy.
#   --delete-gh-pages    finalize: guard that the default branch publishes docs.zip,
#                        re-verify, then delete gh-pages. The only mode that deletes.
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
# gh-pages is the ONLY recoverable copy of the default branch's docs until the
# default branch is publishing docs.zip under the new CI. Refuse to delete until a
# successful ci.yml push run on the default branch carries a LIVE docs artifact.
guard_default_publishing() {
  local default run has
  default=$(gh repo view "$REPO" --json defaultBranchRef -q .defaultBranchRef.name)
  echo "-- guard: is the default branch ($default) publishing docs.zip? --"
  run=$(gh run list --repo "$REPO" --workflow ci.yml --branch "$default" \
          --event push --status success --limit 1 --json databaseId -q '.[0].databaseId // empty')
  if [ -z "$run" ]; then
    echo "::error::REFUSING to delete gh-pages: the default branch '$default' has no" >&2
    echo "  successful ci.yml push run — it is not building/publishing docs.zip under the" >&2
    echo "  new pipeline yet. Merge the migration into '$default', let CI run, then retry." >&2
    exit 1
  fi
  has=$(gh api "repos/$REPO/actions/runs/$run/artifacts" \
          -q 'any(.artifacts[]; .name=="docs" and (.expired | not))' 2>/dev/null || echo false)
  if [ "$has" != "true" ]; then
    echo "::error::REFUSING to delete gh-pages: the latest successful ci.yml run on" >&2
    echo "  '$default' (run $run) has no live 'docs' artifact — gh-pages is still the only" >&2
    echo "  durable copy of $default's docs. Re-run the default-branch CI, then retry." >&2
    exit 1
  fi
  echo "   ok: $default is publishing docs.zip (run $run has a live docs artifact)"
}

echo "== migrate: $REPO (pages-ref=$PAGES_REF, dry-run=$DRY_RUN, delete=$DELETE_GH_PAGES) =="

# ============================================================================
# Finalize: --delete-gh-pages. Guard → re-verify → delete. Nothing else.
# ============================================================================
if $DELETE_GH_PAGES; then
  echo
  guard_default_publishing
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
    read -r -p "Probes passed and the default branch is publishing docs.zip. Type the repo name ($REPO) to delete gh-pages: " confirm
    if [ "$confirm" != "$REPO" ]; then
      echo "Not confirmed — leaving gh-pages in place (rollback still available)."
      exit 0
    fi
  fi
  echo
  echo "-- Deleting gh-pages (rollback gone after this) --"
  git push origin --delete "${PAGES_REF#origin/}"
  echo "Done. Site is served from GitHub Actions; gh-pages removed."
  exit 0
fi

# ============================================================================
# Cutover: backfill → flip → deploy → verify, then STOP (gh-pages retained).
# ============================================================================
backfill

if $DRY_RUN; then
  echo
  echo "-- (dry-run) probing current site --"
  verify || echo "(dry-run probe failed — expected if the site isn't deployed yet)"
  echo
  echo "Dry run complete: backfill plan shown (nothing uploaded); flip/deploy skipped."
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
echo "as the rollback AND the only durable copy of the default branch's docs."
echo
echo "Once the default branch is publishing docs.zip under the new CI (a green ci.yml"
echo "push run), finalize the migration and remove the rollback with:"
echo "    scripts/migrate.sh $REPO --delete-gh-pages"

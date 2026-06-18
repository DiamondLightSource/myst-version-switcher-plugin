#!/usr/bin/env bash
#
# One-time gh-pages → durable-source cutover, run LOCALLY by an operator.
#
# Why local, not CI (see DESIGN.md "Migration"):
#   - flipping the Pages source needs repo-admin, which a CI GITHUB_TOKEN lacks;
#   - the destructive steps want a human watching with their own `gh auth`;
#   - it leaves no workflow_dispatch stub behind in each consumer repo.
#
# Sequence:
#   1. Backfill docs.zip release assets from the gh-pages tree   (non-destructive)
#   2. Flip the Pages source → GitHub Actions                    (gh api)
#   3. Trigger a deploy                                          (guided / dispatch)
#   4. PAUSE + verify (auto-probe AND explicit human OK)
#   5. Delete gh-pages — only after step 4 is green              (the rollback dies)
#
# Until step 5, gh-pages still EXISTS (just unserved) and is the rollback: flip
# the Pages source back to "Deploy from a branch" to restore serving instantly.
#
# Usage:
#   scripts/cutover.sh <org/repo> [--dry-run] [--pages-ref <ref>]
#                                 [--deploy-workflow <file>] [--yes]
#
#   --dry-run            do steps 1 + 4 only (real, idempotent backfill + probe);
#                        skip the flip, the deploy trigger, and the delete.
#   --pages-ref <ref>    gh-pages ref to read (default: origin/gh-pages)
#   --deploy-workflow    `gh workflow run <file>` to trigger step 3 automatically;
#                        omit to be prompted to trigger a deploy by hand.
#   --yes                skip the interactive confirmation before deleting gh-pages.
set -euo pipefail

REPO=""
PAGES_REF="origin/gh-pages"
DEPLOY_WORKFLOW=""
DRY_RUN=false
ASSUME_YES=false

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --yes) ASSUME_YES=true; shift ;;
    --pages-ref) PAGES_REF="$2"; shift 2 ;;
    --deploy-workflow) DEPLOY_WORKFLOW="$2"; shift 2 ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    -*) echo "unknown flag: $1" >&2; exit 2 ;;
    *) if [ -z "$REPO" ]; then REPO="$1"; else echo "unexpected arg: $1" >&2; exit 2; fi; shift ;;
  esac
done

if [ -z "$REPO" ]; then
  echo "usage: scripts/cutover.sh <org/repo> [--dry-run] [--pages-ref <ref>] [--deploy-workflow <file>] [--yes]" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OWNER="${REPO%%/*}"
NAME="${REPO##*/}"
BASE="https://$(echo "$OWNER" | tr '[:upper:]' '[:lower:]').github.io/$NAME"

echo "== cutover: $REPO (pages-ref=$PAGES_REF, dry-run=$DRY_RUN) =="

# --- Step 1: backfill (non-destructive, idempotent) -------------------------
echo
echo "-- 1. Backfilling docs.zip from $PAGES_REF --"
git fetch --tags --quiet origin "${PAGES_REF#origin/}" || true
node "$ROOT/lib/assemble.mjs" migrate --repo "$REPO" --pages-ref "$PAGES_REF"

# --- verify helper (step 4 body) --------------------------------------------
verify() {
  echo "-- probing $BASE --"
  local versions code ok=true
  if ! versions=$(curl -fsSL "$BASE/switcher.json" | node -e \
        'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const e of JSON.parse(s))console.log(e.version)})'); then
    echo "  FAIL: could not fetch/parse $BASE/switcher.json" >&2
    return 1
  fi
  for v in $versions; do
    code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/$v/")
    if [ "$code" = "200" ]; then
      echo "  ok   $BASE/$v/  ($code)"
    else
      echo "  FAIL $BASE/$v/  ($code)"; ok=false
    fi
  done
  $ok
}

if $DRY_RUN; then
  echo
  echo "-- 4. (dry-run) verifying current site --"
  verify || echo "(dry-run probe failed — expected if the site isn't deployed yet)"
  echo
  echo "Dry run complete: backfill done; flip/deploy/delete skipped."
  exit 0
fi

# --- Step 2: flip Pages source → GitHub Actions -----------------------------
echo
echo "-- 2. Flipping Pages source → GitHub Actions --"
echo "   (gh-pages still exists after this and is the rollback: set the source"
echo "    back to 'Deploy from a branch' to restore serving with no data lost.)"
gh api --method PUT "repos/$REPO/pages" -f build_type=workflow

# --- Step 3: trigger a deploy -----------------------------------------------
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

# --- Step 4: verify (auto-probe + human OK) ---------------------------------
echo
echo "-- 4. Verifying the reconstructed site --"
if ! verify; then
  echo
  echo "Verification FAILED. gh-pages is intact — flip the Pages source back to"
  echo "'Deploy from a branch / gh-pages' to roll back. NOT deleting gh-pages." >&2
  exit 1
fi

if ! $ASSUME_YES; then
  echo
  read -r -p "Probes passed. Type the repo name ($REPO) to delete gh-pages: " confirm
  if [ "$confirm" != "$REPO" ]; then
    echo "Not confirmed — leaving gh-pages in place (rollback still available)."
    exit 0
  fi
fi

# --- Step 5: delete gh-pages (rollback gone after this) ---------------------
echo
echo "-- 5. Deleting gh-pages --"
git push origin --delete "${PAGES_REF#origin/}"
echo "Done. Site is now served from GitHub Actions; gh-pages removed."

#!/usr/bin/env bash
#
# One-time gh-pages → durable-source migration, run LOCALLY by an operator.
#
# Why local, not CI (see docs/how-to/migrate-from-gh-pages.md):
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
#   scripts/migrate.sh <org/repo> [--dry-run] [--pages-ref <ref>]
#                                 [--deploy-workflow <file>] [--yes]
#
#   --dry-run            print the backfill plan + probe the current site only;
#                        upload nothing, skip the flip / deploy / delete.
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

usage() {
  echo "usage: scripts/migrate.sh <org/repo> [--dry-run] [--pages-ref <ref>] [--deploy-workflow <file>] [--yes]" >&2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --yes) ASSUME_YES=true; shift ;;
    --pages-ref) PAGES_REF="$2"; shift 2 ;;
    --deploy-workflow) DEPLOY_WORKFLOW="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "unknown flag: $1" >&2; exit 2 ;;
    *) if [ -z "$REPO" ]; then REPO="$1"; else echo "unexpected arg: $1" >&2; exit 2; fi; shift ;;
  esac
done

if [ -z "$REPO" ]; then usage; exit 2; fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OWNER="${REPO%%/*}"
NAME="${REPO##*/}"
BASE="https://$(echo "$OWNER" | tr '[:upper:]' '[:lower:]').github.io/$NAME"

echo "== migrate: $REPO (pages-ref=$PAGES_REF, dry-run=$DRY_RUN) =="

# --- Step 1: backfill docs.zip from the gh-pages tree (non-destructive) ------
# For each release tag that is a gh-pages dir and whose release lacks a docs.zip,
# zip that dir as a bare html/ and attach it. Tags containing `/` are skipped:
# they are never built/published under the new model. Branch dirs (main/) need
# nothing — they self-heal on the next branch CI. The tag is used verbatim as the
# dir name, matching the deploy path (no sanitisation under the new model).
backfill() {
  echo
  echo "-- 1. Backfilling docs.zip from $PAGES_REF --"
  git fetch --tags --quiet origin "${PAGES_REF#origin/}" || true
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

backfill

if $DRY_RUN; then
  echo
  echo "-- 4. (dry-run) probing current site --"
  verify || echo "(dry-run probe failed — expected if the site isn't deployed yet)"
  echo
  echo "Dry run complete: backfill plan shown (nothing uploaded); flip/deploy/delete skipped."
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

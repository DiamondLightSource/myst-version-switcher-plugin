#!/usr/bin/env bash
#
# One-time gh-pages → durable-source migration, run LOCALLY by an operator from
# the myst-version-switcher-plugin devcontainer. If the script detects it is
# already running inside a clone of the target repo it will use that; otherwise
# it clones the repo itself into a temporary directory.
#
# Why local, not CI (see docs/how-to/migrate-from-gh-pages.md):
#   - flipping the Pages source needs repo-admin, which a CI GITHUB_TOKEN lacks;
#   - the destructive step wants a human watching with their own `gh auth`;
#   - it leaves no workflow_dispatch stub behind in each consumer repo.
#
# TWO RUNS, with your pipeline PR doing the deploy in between, because the new model's
# sources differ in durability. Releases become permanent once their docs.zip is
# attached (backfill). The DEFAULT BRANCH has no permanent source until it builds
# docs.zip itself — so we SEED it: capture the gh-pages <default>/ tree as a published
# seed release, which the first publish reads and stages as /<default>/. gh-pages stops
# being needed once the branch builds its OWN docs.zip, and deleting it is split off
# behind a guard that waits for exactly that:
#
#   1. prepare (default)        backfill releases → seed default branch → flip Pages
#                               source to Actions + open the env policy, then STOP.
#                               Uploads + flips only; no deploy. (Flipping is
#                               non-destructive: the last gh-pages deployment keeps
#                               serving until the first Actions deploy supersedes it.)
#   2. (you) open + merge your pipeline PR — its CI does the first publish, which reads
#      the seed, and (once merged to the default branch) builds the branch's own docs.
#   3. finalize (--delete-gh-pages)  guard the default branch builds + serves its own
#                               docs → verify the live site → delete gh-pages + the seed.
#
# Between runs 1 and 3, gh-pages still EXISTS (just unserved) and is the rollback: flip
# the Pages source back to "Deploy from a branch" to restore serving instantly.
#
# Usage:
#   scripts/migrate.sh <org/repo> [--dry-run] [--pages-ref <ref>] [--seed-from <dir>]
#   scripts/migrate.sh <org/repo> --delete-gh-pages [--pages-ref <ref>] [--yes] [--wait]
#
#   --dry-run            print the backfill + seed plan, the versions the new model
#                        will DROP, + probe the current site; upload nothing, skip
#                        the flip.
#   --delete-gh-pages    finalize: guard the default branch builds and serves its own
#                        docs, verify the live site, then delete gh-pages + the seed
#                        release. The only mode that deletes.
#   --pages-ref <ref>    gh-pages ref to read (default: origin/gh-pages)
#   --seed-from <dir>    gh-pages dir to seed the default branch from, when it isn't
#                        named after the branch (e.g. an old site publishing latest/).
#   --yes                skip the typed confirmation before deleting gh-pages.
#   --wait               with --delete-gh-pages: poll until the guard passes (up to
#                        30 min) instead of failing immediately — lets you run finalize
#                        right after merging the pipeline PR.
set -euo pipefail

REPO=""
PAGES_REF="origin/gh-pages"
DRY_RUN=false
DELETE_GH_PAGES=false
ASSUME_YES=false
WAIT=false
SEED_FROM=""
SEED_TAG="pages-default-seed"   # published seed release holding the default branch's docs

usage() {
  echo "usage: scripts/migrate.sh <org/repo> [--dry-run] [--pages-ref <ref>] [--seed-from <dir>]" >&2
  echo "       scripts/migrate.sh <org/repo> --delete-gh-pages [--pages-ref <ref>] [--yes] [--wait]" >&2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --delete-gh-pages) DELETE_GH_PAGES=true; shift ;;
    --yes) ASSUME_YES=true; shift ;;
    --wait) WAIT=true; shift ;;
    --pages-ref) PAGES_REF="$2"; shift 2 ;;
    --seed-from) SEED_FROM="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "unknown flag: $1" >&2; exit 2 ;;
    *) if [ -z "$REPO" ]; then REPO="$1"; else echo "unexpected arg: $1" >&2; exit 2; fi; shift ;;
  esac
done

if [ -z "$REPO" ]; then usage; exit 2; fi
if $DELETE_GH_PAGES && $DRY_RUN; then
  echo "--delete-gh-pages and --dry-run are mutually exclusive" >&2; exit 2
fi
if $WAIT && ! $DELETE_GH_PAGES; then
  echo "--wait only makes sense with --delete-gh-pages" >&2; exit 2
fi

OWNER="${REPO%%/*}"
NAME="${REPO##*/}"
BASE="https://$(echo "$OWNER" | tr '[:upper:]' '[:lower:]').github.io/$NAME"

# Clone the target repo if not already running inside it.
_tmp_clone=""
trap '[ -n "$_tmp_clone" ] && rm -rf "$_tmp_clone"' EXIT
_current_origin=$(git remote get-url origin 2>/dev/null || echo "")
_normalized=$(printf '%s' "$_current_origin" | sed 's|.*github\.com[:/]||; s|\.git$||')
if [ "$_normalized" != "$REPO" ]; then
  _tmp_clone=$(mktemp -d)
  # Blobless partial clone: all refs + tags but no file contents up front — the
  # gh-pages blobs (the bulk of a docs repo) are fetched lazily by `git archive`
  # only for the dirs actually backfilled/seeded.
  git clone --filter=blob:none "https://github.com/$REPO.git" "$_tmp_clone"
  cd "$_tmp_clone"
fi
unset _current_origin _normalized

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
# For each tag that is a gh-pages dir: if its release lacks a docs.zip, zip that
# dir as a bare html/ and attach it; if there is NO release at all, CREATE one
# with the docs.zip (created-with-asset, so immutable-release-safe). The create
# path is what makes a fork rehearsal faithful — forking copies branches and tags
# but not releases, so without it every released version would drop — and also
# covers repos that tag without cutting releases. Tags containing `/` are
# skipped: they are never built/published under the new model. Branch dirs
# (main/) are NOT backfilled here — the default branch self-heals from its own CI
# artifact once it runs the new pipeline (and is the reason gh-pages is kept
# until then).
backfill() {
  echo
  echo "-- 1. Backfilling docs.zip from $PAGES_REF --"
  fetch_pages_ref
  local pages_dirs tag dir has tmp action prerelease
  pages_dirs=$(git ls-tree -d --name-only "$PAGES_REF")
  for tag in $(git tag -l); do
    case "$tag" in */*) continue ;; esac                          # not published
    dir="$tag"
    if ! grep -qxF "$dir" <<<"$pages_dirs"; then continue; fi      # no gh-pages dir
    if gh release view "$tag" --repo "$REPO" >/dev/null 2>&1; then
      has=$(gh release view "$tag" --repo "$REPO" --json assets \
              -q 'any(.assets[]; .name=="docs.zip")')
      if [ "$has" = "true" ]; then continue; fi                    # already has it
      action="attach to existing release"
    else
      action="create release"
    fi
    echo "   backfill $tag  (from $dir/ — $action)"
    if $DRY_RUN; then continue; fi
    tmp=$(mktemp -d)
    git archive "$PAGES_REF" "$dir" | tar -x -C "$tmp"             # → $tmp/$dir/…
    mv "$tmp/$dir" "$tmp/html"
    ( cd "$tmp" && zip -rq docs.zip html )                         # bare html/ root
    if [ "$action" = "create release" ]; then
      # Prerelease marker: a/b/rc following a digit (parity with release.yml).
      prerelease=""
      case "$tag" in *[0-9]a*|*[0-9]b*|*[0-9]rc*) prerelease="--prerelease" ;; esac
      gh release create "$tag" "$tmp/docs.zip" --repo "$REPO" --verify-tag \
        --latest=false $prerelease --title "$tag" \
        --notes "Docs backfilled from the gh-pages branch by migrate.sh."
    else
      gh release upload "$tag" "$tmp/docs.zip" --repo "$REPO" --clobber
    fi
    rm -rf "$tmp"
  done
}

# --- report versions the reconstructed site will DROP -------------------------
# The new model serves: the default branch (seeded), tags whose release has (or
# will get, via backfill) a docs.zip, and open PRs. Anything else the LIVE site
# currently lists in switcher.json — extra branch dirs, dirs whose tag was
# deleted — is never gathered, so it drops from the reconstructed site. It stays
# on gh-pages until finalize (recoverable), but say so up front instead of
# leaving the operator to diff the plan against the probe by eye.
report_drops() {
  echo
  echo "-- Versions the reconstructed site will DROP --"
  fetch_pages_ref
  local versions v default drops=0
  default=$(gh repo view "$REPO" --json defaultBranchRef -q .defaultBranchRef.name)
  if ! versions=$(curl -fsSL "$BASE/switcher.json?cb=$(date +%s%N)" 2>/dev/null | node -e \
        'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const e of JSON.parse(s))console.log(e.version)})' 2>/dev/null); then
    echo "   (no live switcher.json at $BASE — skipping the drop report)"
    return 0
  fi
  for v in $versions; do
    [ "$v" = "$default" ] && continue                              # seeded
    case "$v" in pr-*) continue ;; esac                            # own artifact
    if git tag -l | grep -qxF "$v"; then
      # a tag: kept if backfill covers it (gh-pages dir) or a docs.zip exists
      if git ls-tree -d --name-only "$PAGES_REF" | grep -qxF "$v"; then continue; fi
      has=$(gh release view "$v" --repo "$REPO" --json assets \
              -q 'any(.assets[]; .name=="docs.zip")' 2>/dev/null || echo false)
      [ "$has" = "true" ] && continue
    fi
    echo "   DROP $v  (no tag+gh-pages dir to backfill and no release docs.zip)"
    drops=$((drops + 1))
  done
  if [ "$drops" = "0" ]; then
    echo "   none — every currently served version survives the migration"
  else
    echo "   ($drops version(s) will no longer be served. They remain on gh-pages"
    echo "    until finalize; cut a real Release for any you want to keep.)"
  fi
}

# --- seed the default branch durably (so we can cut over before it builds docs) ---
# The default branch has no durable source until it builds docs.zip under the new
# pipeline, and a contents:read deploy can't read a draft — so capture the gh-pages
# <default>/ tree as a docs.zip and PUBLISH it on a sentinel tag (not the branch name).
# assemble reads it and stages /<default>/; once the branch builds its own docs.zip
# that supersedes the seed, which then goes dormant (deleted at finalize).
# This lets a repo cut over to the reusable workflow in ONE PR, before docs→default.
seed_default_branch() {
  echo
  echo "-- 1b. Seeding the default branch durably (published release '$SEED_TAG') --"
  fetch_pages_ref
  local default srcdir tmp
  default=$(gh repo view "$REPO" --json defaultBranchRef -q .defaultBranchRef.name)
  # The gh-pages dir usually shares the branch name; --seed-from overrides for
  # old sites that published it under another name (e.g. latest/).
  srcdir="${SEED_FROM:-$default}"
  if ! git ls-tree -d --name-only "$PAGES_REF" | grep -qxF "$srcdir"; then
    echo "   no '$srcdir/' dir on $PAGES_REF — nothing to seed (skipping)."
    echo "   (If the default branch's docs live under another dir, rerun with --seed-from <dir>;"
    echo "    without a seed, the pipeline PR's publish stays red until it merges.)"
    return 0
  fi
  echo "   seed $default  (from $srcdir/ on $PAGES_REF → release '$SEED_TAG')"
  if $DRY_RUN; then return 0; fi
  tmp=$(mktemp -d)
  git archive "$PAGES_REF" "$srcdir" | tar -x -C "$tmp"
  mv "$tmp/$srcdir" "$tmp/html"
  ( cd "$tmp" && zip -rq docs.zip html )                           # bare html/ root
  if gh release view "$SEED_TAG" --repo "$REPO" >/dev/null 2>&1; then
    gh release upload "$SEED_TAG" "$tmp/docs.zip" --repo "$REPO" --clobber
  else
    gh release create "$SEED_TAG" "$tmp/docs.zip" --repo "$REPO" --latest=false \
      --title "Default-branch docs seed (migration)" \
      --notes "Temporary: seeds /$default/ until the default branch builds docs.zip under the new pipeline. Safe to delete once $default builds its own docs."
  fi
  rm -rf "$tmp"
}

# Delete the seed release + its tag (the branch's own docs.zip supersedes it).
delete_seed_release() {
  if gh release view "$SEED_TAG" --repo "$REPO" >/dev/null 2>&1; then
    echo "-- Deleting the migration seed release '$SEED_TAG' (superseded by the branch's own build) --"
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
# gh-pages is the only recoverable copy of the default branch's docs until the branch
# BUILDS ITS OWN under the new pipeline. Two conditions, both required:
#
#   1. /<default>/ is served from the new Actions-deployed site, and
#   2. a non-expired `docs` artifact exists for the default branch, built from this
#      repo — i.e. its CI really produces docs.zip now.
#
# (1) alone is not enough: it is still satisfied while /<default>/ is coming from the
# migration seed, which is exactly the state where gh-pages is still the only real
# copy. This guard used to probe the in-site `_sources/<default>.zip` instead; that
# file is no longer published (the default branch's durable copy lives in the Actions
# cache, which has no public URL to probe and is evictable), so the guard now waits for
# the stronger and more honest condition it always should have used.
guard_default_durable() {
  local default url code repo_id arts deadline
  default=$(gh repo view "$REPO" --json defaultBranchRef -q .defaultBranchRef.name)
  repo_id=$(gh api "repos/$REPO" -q .id)
  url="$BASE/$default/index.html"
  echo "-- guard: does '$default' build and serve its own docs yet? --"
  deadline=$(( $(date +%s) + 1800 ))
  while :; do
    code=$(curl -s -o /dev/null -w '%{http_code}' "$url?cb=$(date +%s%N)")
    arts=$(gh api --paginate "repos/$REPO/actions/artifacts?name=docs&per_page=100" 2>/dev/null \
      | jq -rs --arg b "$default" --argjson r "$repo_id" '[.[].artifacts[]
          | select((.expired | not)
                   and .workflow_run.head_branch == $b
                   and .workflow_run.head_repository_id == $r)] | length' 2>/dev/null || echo 0)
    if [ "$code" = "200" ] && [ "${arts:-0}" -gt 0 ]; then break; fi
    if ! $WAIT; then
      echo "::error::REFUSING to delete gh-pages — '$default' is not yet self-sufficient." >&2
      echo "  /$default/ live in the new site : $code (want 200)" >&2
      echo "  non-expired 'docs' artifacts    : ${arts:-0} (want at least 1)" >&2
      echo "  gh-pages is still the only recoverable copy. Merge your pipeline PR so the" >&2
      echo "  default branch builds its own docs, let that publish deploy, then retry" >&2
      echo "  (or rerun with --wait to poll)." >&2
      exit 1
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "::error::gave up after 30 min: /$default/ is $code and '$default' has ${arts:-0}" >&2
      echo "  non-expired 'docs' artifacts. Has the pipeline PR merged and published?" >&2
      echo "  Check the repo's Actions runs, then retry." >&2
      exit 1
    fi
    echo "   not ready yet (site $code, ${arts:-0} artifact(s)) — waiting 15s (Ctrl-C to abort; gh-pages is untouched)"
    sleep 15
  done
  echo "   ok: /$default/ is live and '$default' builds its own docs — gh-pages is redundant"
}

echo "== migrate: $REPO (pages-ref=$PAGES_REF, dry-run=$DRY_RUN, delete=$DELETE_GH_PAGES) =="

# ============================================================================
# Finalize: --delete-gh-pages. Guard → verify → delete. Nothing else.
# ============================================================================
if $DELETE_GH_PAGES; then
  echo
  guard_default_durable
  echo
  echo "-- Verifying the live site before deleting gh-pages --"
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
  # Via the API, not `git push --delete`: gh is the auth we required, whereas a
  # git-over-https push from the temp clone would need a separately configured
  # credential helper (`gh auth setup-git`).
  gh api --method DELETE "repos/$REPO/git/refs/heads/${PAGES_REF#origin/}"
  delete_seed_release          # the branch's own docs.zip now carries the default branch
  echo "Done. Site is served from GitHub Actions; gh-pages removed."
  exit 0
fi

# ============================================================================
# Prepare: backfill → seed → flip + open env policy, then STOP (gh-pages retained).
# The first deploy is your pipeline PR's own publish; verification is the 2nd run.
# ============================================================================
backfill
seed_default_branch
report_drops

if $DRY_RUN; then
  echo
  echo "-- (dry-run) probing current site --"
  verify || echo "(dry-run probe failed — expected if the site isn't deployed yet)"
  echo
  echo "Dry run complete: backfill + seed + drop plan shown (nothing uploaded); flip skipped."
  exit 0
fi

# --- Flip Pages source → GitHub Actions -------------------------------------
echo
echo "-- 2. Flipping Pages source → GitHub Actions --"
echo "   (gh-pages still exists after this and is the rollback: set the source"
echo "    back to 'Deploy from a branch' to restore serving with no data lost.)"
gh api --method PUT "repos/$REPO/pages" -f build_type=workflow

# --- Allow deploys from any ref in the github-pages environment -------------
# Under the nested-publish model, internal PRs and tags deploy from THEIR OWN ref
# (publish runs inside their CI run), so the github-pages environment's
# deployment-branch policy must allow those refs or deploy-pages is rejected by the
# environment. Set it to "no restriction" (deployment_branch_policy: null) so any
# branch/tag can deploy. Idempotent; PUT creates the environment if absent.
echo
echo "-- 2b. Allowing github-pages deploys from any branch/tag --"
echo '{"deployment_branch_policy":null}' \
  | gh api --method PUT "repos/$REPO/environments/github-pages" --input - >/dev/null

echo
echo "Prepared. Releases are backfilled, the default branch is seeded ('$SEED_TAG'),"
echo "and Pages is served from GitHub Actions (gh-pages RETAINED as the rollback —"
echo "flip the source back to 'Deploy from a branch' to restore it instantly)."
echo
echo "Next:"
echo "  1. Open + merge your pipeline PR. Its CI runs the first publish, which reads"
echo "     the seed to stage /<default>/ in the deployed site."
echo "  2. Once the default branch has built its own docs, finalize (verify + delete"
echo "     gh-pages and the seed). The guard waits for that build first:"
echo "         scripts/migrate.sh $REPO --delete-gh-pages"
echo "     (add --wait to run it right after merging — it polls until the guard passes)"

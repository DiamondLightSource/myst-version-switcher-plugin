#!/usr/bin/env bash
#
# assemble — reconstruct the whole versioned docs site from durable sources into
# $SITE, write switcher.json + a root redirect + the stable/ alias, and print the
# site dir. The action/action.yml is a thin wrapper around this; it is also
# runnable standalone so the `gh` plumbing can be exercised locally:
#
#   REPO=DiamondLightSource/myst-version-switcher-plugin GH_TOKEN=$(gh auth token) \
#     assemble/assemble.sh
#
# Driven by env (the action passes these; set them yourself to run locally):
#   REPO                  org/repo for gh lookups + version URLs        (required)
#   GUARD_DEFAULT_BRANCH  'true' (default) → hard-fail if the default branch is
#                         absent from the site; any other value disables the guard
#   GH_TOKEN              token for gh (release assets, runs, statuses)
#   SITE                  output dir (default: $RUNNER_TEMP/site, else ./_site)
#
# Requires node + gh on PATH. assemble.mjs sits next to this script.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

: "${REPO:?REPO is required (org/repo)}"
GUARD_DEFAULT_BRANCH="${GUARD_DEFAULT_BRANCH:-true}"
if [ -n "${SITE:-}" ]; then :
elif [ -n "${RUNNER_TEMP:-}" ]; then SITE="$RUNNER_TEMP/site"
else SITE="$PWD/_site"
fi
TMP="${RUNNER_TEMP:-$(mktemp -d)}"

default=$(gh repo view "$REPO" --json defaultBranchRef -q .defaultBranchRef.name)
mkdir -p "$SITE"

# Unzip a docs.zip (bare html/ root) into SITE/<dest>, replacing any prior.
extract() {  # $1=zip  $2=dest dir  $3=label
  local t="$TMP/x-$2"
  rm -rf "$t"; mkdir -p "$t"
  if unzip -q "$1" 'html/*' -d "$t" && [ -d "$t/html" ]; then
    rm -rf "${SITE:?}/$2"
    mv "$t/html" "$SITE/$2"
  else
    echo "::warning::$3 docs.zip has no html/ root — skipping"
  fi
  rm -rf "$t"
}

# Download a run's `docs` artifact (→ <out>/docs.zip); skip on miss (expired).
download_run() {  # $1=runId  $2=out dir  $3=label
  rm -rf "$2"; mkdir -p "$2"
  if ! gh run download "$1" --repo "$REPO" -n docs -D "$2"; then
    echo "::warning::$3 docs artifact unavailable (expired?) — skipping"
    return 1
  fi
}

# --- main: latest successful push build on the default branch ---
main_run=$(gh run list --repo "$REPO" --workflow ci.yml --branch "$default" \
  --event push --status success --limit 1 --json databaseId -q '.[0].databaseId // empty')
if [ -n "$main_run" ]; then
  if download_run "$main_run" "$TMP/dl-$default" "branch $default"; then
    extract "$TMP/dl-$default/docs.zip" "$default" "branch $default"
  fi
else
  echo "::warning::no successful CI build found for default branch $default"
fi

# --- releases: tags whose release has a docs.zip (one paginated call) ---
tags=$(gh api --paginate "repos/$REPO/releases" \
  -q '.[] | select(any(.assets[]; .name=="docs.zip")) | .tag_name')
for tag in $tags; do
  case "$tag" in */*) continue ;; esac          # never built/published; skip
  [ "$tag" = "$default" ] && continue
  if gh release download "$tag" --repo "$REPO" -p docs.zip -O "$TMP/rel-$tag.zip"; then
    extract "$TMP/rel-$tag.zip" "$tag" "release $tag"
  else
    echo "::warning::release $tag docs.zip download failed — skipping"
  fi
done

# --- open PRs: internal always, external forks only when approved ---
prs=$(gh pr list --repo "$REPO" --state open --limit 200 \
  --json number,headRefOid,isCrossRepository \
  -q '.[] | [.number, .headRefOid, .isCrossRepository] | @tsv')
while IFS=$'\t' read -r num sha cross; do
  [ -z "$num" ] && continue
  if [ "$cross" = "true" ]; then
    approved=$(gh api "repos/$REPO/commits/$sha/statuses" \
      -q 'any(.[]; .context=="preview-approved" and .state=="success")')
    [ "$approved" = "true" ] || continue       # unapproved fork → skip
  fi
  # The successful CI run for this PR's CURRENT head commit (empty if the latest
  # build hasn't passed yet, or the SHA changed since approval).
  run=$(gh api "repos/$REPO/actions/runs?head_sha=$sha&status=success" \
    -q 'first(.workflow_runs[] | select(.name=="CI") | .id) // empty')
  [ -n "$run" ] || continue
  if download_run "$run" "$TMP/dl-pr-$num" "PR #$num"; then
    extract "$TMP/dl-pr-$num/docs.zip" "pr-$num" "PR #$num"
  fi
done <<< "$prs"

# --- generate switcher.json + redirect + stable-alias source ---
# `generate` discovers the gathered dirs, orders them, writes switcher.json +
# index.html, and prints the stable-alias source dir (or nothing). It also exit-1s
# (→ set -e) if the --required (default) branch is absent — the load-bearing guard.
required=""
[ "$GUARD_DEFAULT_BRANCH" = "true" ] && required="$default"
stable_src=$(node "$here/assemble.mjs" generate \
  --site-dir "$SITE" --repo "$REPO" --required "$required")

# --- stable alias: a symlink, inflated to a real copy by upload-pages-artifact ---
[ -n "$stable_src" ] && ln -s "$stable_src" "$SITE/stable"

echo "Assembled site at $SITE"
[ -n "${GITHUB_OUTPUT:-}" ] && echo "dir=$SITE" >> "$GITHUB_OUTPUT"

#!/usr/bin/env bash
# $1 = out (may be /dev/stdout), $2 = marker, $3 = ok|nodocs
set -euo pipefail
d=$(mktemp -d)
if [ "$3" = ok ]; then
  "$(dirname "$0")/mkzip.sh" "$d/docs.zip" "artifact-$2"
  ( cd "$d" && zip -rq artifact.zip docs.zip )
else
  echo hi > "$d/other.txt"; ( cd "$d" && zip -rq artifact.zip other.txt )
fi
cat "$d/artifact.zip" > "$1"; rm -rf "$d"

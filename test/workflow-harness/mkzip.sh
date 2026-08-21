#!/usr/bin/env bash
# $1 = output path, $2 = marker. Produces a valid single-root docs.zip.
set -euo pipefail
d=$(mktemp -d); mkdir -p "$d/html"; echo "$2" > "$d/html/index.html"
( cd "$d" && zip -rq out.zip html )
mkdir -p "$(dirname "$1")"; cp "$d/out.zip" "$1"; rm -rf "$d"

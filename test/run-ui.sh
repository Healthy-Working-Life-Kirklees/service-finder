#!/usr/bin/env bash
# Browser test of the MVP pages: builds the site twice (MVP tools on and off), serves both locally,
# and drives them with headless Chromium against a mocked Worker. No real API or credit is used.
#   bash test/run-ui.sh
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
W=$(mktemp -d)

build() { # build <dir> <mvp: true|false>
  mkdir -p "$1"
  cp -r "$ROOT/site/." "$1/"
  cp "$ROOT/data/services.json" "$1/services.json"
  if [ "$2" = true ]; then cp -r "$ROOT/mvp" "$1/mvp"; fi
  python3 -c "import json,sys; print('window.FINDER_CONFIG = ' + json.dumps({'apiBase': 'https://mock.workers.dev', 'mvpTools': sys.argv[1] == 'true'}, separators=(',', ':')) + ';')" "$2" > "$1/config.js"
}
build "$W/on" true
build "$W/off" false

(cd "$W/on" && exec python3 -m http.server 18480 --bind 127.0.0.1 >/dev/null 2>&1) & P1=$!
(cd "$W/off" && exec python3 -m http.server 18481 --bind 127.0.0.1 >/dev/null 2>&1) & P2=$!
trap 'kill $P1 $P2 2>/dev/null || true; rm -rf "$W"' EXIT
sleep 1

docker run --rm --network host --user "$(id -u):$(id -g)" \
  -e HOME=/tmp -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright -e NODE_PATH=/tmp/pw/node_modules \
  -v "$ROOT":/repo:ro -w /tmp mcr.microsoft.com/playwright:v1.48.0-jammy \
  bash -c 'mkdir -p /tmp/pw && cd /tmp/pw && npm init -y >/dev/null && npm i playwright@1.48.0 --ignore-scripts --no-audit --no-fund >/dev/null 2>&1 && node /repo/test/ui-mvp.cjs'

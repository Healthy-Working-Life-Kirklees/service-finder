#!/usr/bin/env bash
# Browser test of the main page and the Admin pages: builds the site as the Pages workflow does, serves it
# locally, and drives it with headless Chromium against a mocked Worker. No real API or credit is used.
#   bash test/run-ui.sh      (uses Docker, or a local Playwright if Docker isn't running)
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
W=$(mktemp -d)
node "$ROOT/scripts/build-data.mjs" # data/services.json is generated from data/services/

mkdir -p "$W/site"
cp -r "$ROOT/site/." "$W/site/"
cp "$ROOT/data/services.json" "$W/site/services.json"
cp -r "$ROOT/admin" "$W/site/admin"
cp "$ROOT/data/services-all.json" "$W/site/admin/services-all.json"
echo 'window.FINDER_CONFIG = {"apiBase":"https://mock.workers.dev"};' > "$W/site/config.js"

(cd "$W/site" && exec python3 -m http.server 18480 --bind 127.0.0.1 >/dev/null 2>&1) & P1=$!
trap 'kill $P1 2>/dev/null || true; rm -rf "$W"' EXIT
sleep 1

# Without Docker, use a Playwright installed on this machine (for example in a cloud session).
if ! docker info >/dev/null 2>&1 && node -e "require('playwright')" >/dev/null 2>&1; then
  node "$ROOT/test/ui-admin.cjs"
  exit $?
fi

docker run --rm --network host --user "$(id -u):$(id -g)" \
  -e HOME=/tmp -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright -e NODE_PATH=/tmp/pw/node_modules \
  -v "$ROOT":/repo:ro -w /tmp mcr.microsoft.com/playwright:v1.48.0-jammy \
  bash -c 'mkdir -p /tmp/pw && cd /tmp/pw && npm init -y >/dev/null && npm i playwright@1.48.0 --ignore-scripts --no-audit --no-fund >/dev/null 2>&1 && node /repo/test/ui-admin.cjs'

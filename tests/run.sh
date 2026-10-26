#!/usr/bin/env bash
# Unit tests always; integration only where a Playwright Chromium exists
# (inside the docker image, or after `npx playwright install chromium`).
set -e
cd "$(dirname "$0")/.."

[ -d node_modules ] || npm ci

node tests/unit.mjs

if node -e "const {chromium}=require('rebrowser-playwright'); require('fs').existsSync(chromium.executablePath()) || process.exit(1)" 2>/dev/null; then
  node tests/integration.mjs
elif docker image inspect longbrowse-core >/dev/null 2>&1; then
  # no local Chromium: run the integration test inside the built image
  docker run --rm --entrypoint node \
    -e HEADLESS=1 -e DATA_DIR=/tmp/it-data -e PROFILES_DIR=/tmp/it-profiles \
    -v "$PWD/tests:/app/tests:ro" \
    longbrowse-core tests/integration.mjs
else
  echo "integration: skipped (no Playwright Chromium and no longbrowse-core image)"
fi

echo "tests: ok"

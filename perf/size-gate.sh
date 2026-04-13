#!/bin/bash
# perf/size-gate.sh
# CI-ready size gate. Run after build to enforce bundle size limits.
# Usage: bash perf/size-gate.sh
# Exit 0 = pass, Exit 1 = fail.

set -euo pipefail

MAX_CONTENT_SCRIPT_KB=200
MAX_BACKGROUND_KB=800
MAX_INJECT_KB=20
MAX_TOTAL_KB=2000

BUILD_DIR=".output/chrome-mv3"
PASS=true

if [ ! -d "$BUILD_DIR" ]; then
  echo "ERROR: $BUILD_DIR not found. Run 'bun run build' first."
  exit 1
fi

echo "=== Size Gate Check ==="
echo ""

# Content scripts
for f in "$BUILD_DIR"/content-scripts/*.js; do
  [ -f "$f" ] || continue
  size_kb=$(( $(wc -c < "$f") / 1024 ))
  label="PASS"
  if [ "$size_kb" -gt "$MAX_CONTENT_SCRIPT_KB" ]; then
    label="FAIL"
    PASS=false
  fi
  echo "[$label] Content script: $(basename "$f") = ${size_kb}KB (limit: ${MAX_CONTENT_SCRIPT_KB}KB)"
done

# Background script
if [ -f "$BUILD_DIR/background.js" ]; then
  size_kb=$(( $(wc -c < "$BUILD_DIR/background.js") / 1024 ))
  label="PASS"
  if [ "$size_kb" -gt "$MAX_BACKGROUND_KB" ]; then
    label="FAIL"
    PASS=false
  fi
  echo "[$label] Background: background.js = ${size_kb}KB (limit: ${MAX_BACKGROUND_KB}KB)"
fi

# Inject script
if [ -f "$BUILD_DIR/inject.js" ]; then
  size_kb=$(( $(wc -c < "$BUILD_DIR/inject.js") / 1024 ))
  label="PASS"
  if [ "$size_kb" -gt "$MAX_INJECT_KB" ]; then
    label="FAIL"
    PASS=false
  fi
  echo "[$label] Inject: inject.js = ${size_kb}KB (limit: ${MAX_INJECT_KB}KB)"
fi

# Total
total_kb=$(du -sk "$BUILD_DIR" | cut -f1)
label="PASS"
if [ "$total_kb" -gt "$MAX_TOTAL_KB" ]; then
  label="FAIL"
  PASS=false
fi
echo "[$label] Total extension: ${total_kb}KB (limit: ${MAX_TOTAL_KB}KB)"

echo ""
if [ "$PASS" = true ]; then
  echo "PASS: All size gates met."
  exit 0
else
  echo "FAIL: One or more size gates exceeded."
  exit 1
fi

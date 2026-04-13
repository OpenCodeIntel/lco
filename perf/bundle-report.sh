#!/bin/bash
# perf/bundle-report.sh
# Generates a size inventory of the built extension.
# Usage: bash perf/bundle-report.sh

set -euo pipefail

BUILD_DIR=".output/chrome-mv3"

if [ ! -d "$BUILD_DIR" ]; then
  echo "ERROR: $BUILD_DIR not found. Run 'bun run build' first."
  exit 1
fi

echo "=== Bundle Size Report ==="
echo "Date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Commit: $(git rev-parse --short HEAD 2>/dev/null || echo 'unknown')"
echo ""

echo "--- JS files (sorted by size) ---"
find "$BUILD_DIR" -name '*.js' -exec wc -c {} + | sort -n
echo ""

echo "--- CSS files ---"
find "$BUILD_DIR" -name '*.css' -exec wc -c {} + 2>/dev/null | sort -n
echo ""

echo "--- Total extension size ---"
du -sh "$BUILD_DIR"
echo ""

echo "--- Top 10 largest files ---"
find "$BUILD_DIR" -type f -exec wc -c {} + | sort -rn | head -11
echo ""

echo "--- React leak check ---"
react_found=0
for f in $(find "$BUILD_DIR" -name '*.js'); do
  count=$(grep -c "React\.createElement\|__REACT_DEVTOOLS\|ReactDOM" "$f" 2>/dev/null || true)
  if [ "$count" -gt 0 ]; then
    echo "REACT FOUND: $f ($count references)"
    react_found=1
  fi
done
[ "$react_found" -eq 0 ] && echo "OK: No React framework code found in bundles."
echo ""

echo "--- Tokenizer placement check ---"
for f in $(find "$BUILD_DIR/content-scripts" -name '*.js' 2>/dev/null); do
  count=$(grep -c "bpe_ranks\|cl100k\|getEncoding" "$f" 2>/dev/null || true)
  if [ "$count" -gt 0 ]; then
    echo "WARNING: Tokenizer code in content script: $f ($count refs)"
  else
    echo "OK: No tokenizer code in content script: $f"
  fi
done
echo ""

echo "--- Lines > 10000 chars (large embedded data) ---"
for f in $(find "$BUILD_DIR" -name '*.js'); do
  long_lines=$(awk 'length > 10000 {count++} END {print count+0}' "$f")
  if [ "$long_lines" -gt 0 ]; then
    echo "$f: $long_lines lines with >10K chars (likely embedded data/vocab)"
  fi
done

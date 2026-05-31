#!/bin/bash
OUTPUT="repo_audit_dump.txt"
echo "REPO AUDIT DUMP - $(date)" > "$OUTPUT"
echo "ROOT: $(pwd)" >> "$OUTPUT"
echo "" >> "$OUTPUT"

echo "=== DIRECTORY TREE ===" >> "$OUTPUT"
find . -maxdepth 4 -not -path '*/node_modules/*' -not -path '*/.git/*' | head -200 >> "$OUTPUT"
echo "" >> "$OUTPUT"

echo "=== SOURCE FILES ===" >> "$OUTPUT"
find . -type f \
  \( -name "*.js" -o -name "*.toml" -o -name "*.yml" -o -name "*.yaml" -o -name "*.json" -o -name "*.html" -o -name "*.md" \) \
  ! -path "*/node_modules/*" \
  ! -path "*/.git/*" \
  ! -name "*.min.js" \
  -print0 | while IFS= read -r -d '' file; do
    echo "" >> "$OUTPUT"
    echo "=== FILE: $file ===" >> "$OUTPUT"
    cat "$file" >> "$OUTPUT"
done

echo "Dump complete: $OUTPUT"
echo "Size: $(du -h $OUTPUT | cut -f1)"

#!/usr/bin/env bash
# Discover the current whiteboard token from an explicitly configured Lark
# document section. This script is read-only and has no product-specific token.
#
# Usage:
#   whiteboard-token.sh [<doc-token>] [<section-block-id>]
#
# Environment:
#   COGNIA_MINDMAP_DOC_TOKEN
#   COGNIA_MINDMAP_SECTION_ID
set -euo pipefail

DOC="${1:-${COGNIA_MINDMAP_DOC_TOKEN:-}}"
SECTION="${2:-${COGNIA_MINDMAP_SECTION_ID:-}}"

if [ -z "$DOC" ] || [ -z "$SECTION" ]; then
  echo "ERROR: pass <doc-token> and <section-block-id>, or set COGNIA_MINDMAP_DOC_TOKEN and COGNIA_MINDMAP_SECTION_ID" >&2
  exit 2
fi

lark-cli docs +fetch \
  --api-version v2 \
  --doc "$DOC" \
  --scope section \
  --start-block-id "$SECTION" \
  --detail with-ids \
  2>&1 \
  | python3 -c "
import json
import re
import sys

raw = sys.stdin.read()
try:
    content = json.loads(raw)['data']['document']['content']
except Exception:
    print('fetch failed:', raw[:300], file=sys.stderr)
    raise SystemExit(1)

matches = re.findall(r'<whiteboard[^>]*\\btoken=\"([^\"]+)\"', content)
if len(matches) != 1:
    print(f'expected exactly one whiteboard token in the configured section, found {len(matches)}', file=sys.stderr)
    raise SystemExit(1)
print(matches[0])
"

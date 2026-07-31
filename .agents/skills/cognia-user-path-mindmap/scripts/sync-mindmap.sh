#!/usr/bin/env bash
# Validate and regenerate a repository-owned Cognia journey mindmap, then
# optionally replace an explicitly approved Lark whiteboard.
#
# Usage:
#   sync-mindmap.sh lint  [<mindmap-dir>]
#   sync-mindmap.sh build [<mindmap-dir>]
#   sync-mindmap.sh push  [<mindmap-dir>] [<whiteboard-token>]
#
# Environment:
#   COGNIA_MINDMAP_DIR       default mindmap source directory
#   COGNIA_MINDMAP_VALIDATOR explicit repository validator
#   COGNIA_MINDMAP_GENERATOR explicit generator
#   COGNIA_MINDMAP_DOC_TOKEN / COGNIA_MINDMAP_SECTION_ID for token discovery
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="${1:-build}"
INPUT_DIR="${2:-${COGNIA_MINDMAP_DIR:-}}"
TOKEN="${3:-}"

case "$MODE" in
  lint|build|push) ;;
  *)
    echo "ERROR: mode must be lint, build, or push (received: $MODE)" >&2
    exit 2
    ;;
esac

if [ -n "$INPUT_DIR" ]; then
  if [ ! -d "$INPUT_DIR" ]; then
    echo "ERROR: mindmap directory does not exist: $INPUT_DIR" >&2
    exit 1
  fi
  DIR="$(cd "$INPUT_DIR" && pwd)"
  REPO="$(git -C "$DIR" rev-parse --show-toplevel 2>/dev/null || true)"
else
  REPO="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  if [ -z "$REPO" ]; then
    echo "ERROR: run inside a git checkout or pass <mindmap-dir>" >&2
    exit 1
  fi
  DIR="$REPO/docs/cognia-user-path-mindmap"
fi

if [ -z "$REPO" ]; then
  echo "ERROR: $DIR is not inside a git repository" >&2
  exit 1
fi

if [ ! -f "$DIR/tree.json" ]; then
  echo "ERROR: missing source file $DIR/tree.json" >&2
  echo "Do not reconstruct journey source from generated or remote artifacts." >&2
  exit 1
fi

resolve_file() {
  local explicit="$1"
  shift
  if [ -n "$explicit" ]; then
    if [ ! -f "$explicit" ]; then
      echo "ERROR: configured file does not exist: $explicit" >&2
      exit 1
    fi
    printf '%s/%s\n' "$(cd "$(dirname "$explicit")" && pwd)" "$(basename "$explicit")"
    return
  fi
  local candidate
  for candidate in "$@"; do
    if [ -f "$candidate" ]; then
      printf '%s/%s\n' "$(cd "$(dirname "$candidate")" && pwd)" "$(basename "$candidate")"
      return
    fi
  done
  return 1
}

VALIDATOR="$(
  resolve_file "${COGNIA_MINDMAP_VALIDATOR:-}" \
    "$DIR/lint-tree.cjs" \
    "$DIR/lint-tree.mjs" \
    "$REPO/scripts/validate-cuj-tree.js" \
    "$REPO/scripts/validate-cuj-tree.mjs" \
    "$REPO/scripts/validate-journey-tree.mjs"
)" || {
  echo "ERROR: repository-owned journey validator was not found" >&2
  exit 1
}

GENERATOR="$(
  resolve_file "${COGNIA_MINDMAP_GENERATOR:-}" \
    "$DIR/gen.cjs" \
    "$DIR/gen.mjs" \
    "$DIR/generate.cjs" \
    "$DIR/generate.mjs"
)" || {
  echo "ERROR: repository-owned mindmap generator was not found" >&2
  exit 1
}

echo "== 1) repository journey validation =="
(cd "$REPO" && node "$VALIDATOR")

if [ "$MODE" = "lint" ]; then
  exit 0
fi

cd "$DIR"
echo "== 2) tree.json -> diagram.json =="
node "$GENERATOR"

if [ ! -f "$DIR/diagram.json" ]; then
  echo "ERROR: generator did not produce $DIR/diagram.json" >&2
  exit 1
fi

echo "== 3) diagram.json -> openapi.json =="
TMP_OPENAPI="$(mktemp "${TMPDIR:-/tmp}/cognia-mindmap-openapi.XXXXXX")"
trap 'rm -f "$TMP_OPENAPI"' EXIT
npx -y @larksuite/whiteboard-cli@^0.2.12 \
  -i diagram.json --to openapi --format json > "$TMP_OPENAPI"
node -e "const fs=require('node:fs');const d=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));if(d.code!==0){console.error('whiteboard-cli conversion failed:',JSON.stringify(d.error));process.exit(1)}console.log('openapi conversion OK (code=0)')" "$TMP_OPENAPI"
mv "$TMP_OPENAPI" openapi.json
trap - EXIT

if [ "$MODE" = "build" ]; then
  echo "BUILD complete (no remote write). Review source diff and generated counts before push."
  exit 0
fi

if [ -z "$TOKEN" ]; then
  echo "== 4) discover current whiteboard token =="
  TOKEN="$("$SCRIPT_DIR/whiteboard-token.sh")"
fi

if [ -z "$TOKEN" ]; then
  echo "ERROR: unable to resolve a whiteboard token" >&2
  exit 1
fi

echo "== 5) replace approved Lark whiteboard: $TOKEN =="
lark-cli whiteboard +update \
  --whiteboard-token "$TOKEN" \
  --source - \
  --input_format raw \
  --idempotent-token "cognia-mindtree-$(date +%s)" \
  --as user \
  --overwrite \
  --json \
  < openapi.json \
  | python3 -c "
import json, sys
d = json.load(sys.stdin)
ok = d.get('ok') is True
ids = (d.get('data', {}).get('created_node_ids', '') or '')
count = ids.count(',') + 1 if ids else 0
print(f'ok: {ok} | created nodes+connectors: {count}')
if not ok:
    print(d.get('error') or d, file=sys.stderr)
    raise SystemExit(1)
"

echo "PUSH complete. Re-query or inspect after Lark preview caching clears."

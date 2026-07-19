#!/bin/sh
set -eu

install -d -o pwuser -g pwuser /workspace /profiles
chown pwuser:pwuser /workspace /profiles
if [ -n "${COGNIA_WORKSPACE_ID:-}" ] && [ -n "${COGNIA_WORKSPACE_RUNTIME_SECRET:-}" ] && [ -d /runtime-secrets ]; then
  case "$COGNIA_WORKSPACE_ID" in
    *[!A-Za-z0-9._-]*|'') echo "invalid COGNIA_WORKSPACE_ID" >&2; exit 64 ;;
  esac
  umask 077
  printf '%s' "$COGNIA_WORKSPACE_RUNTIME_SECRET" > "/runtime-secrets/$COGNIA_WORKSPACE_ID"
  chmod 0444 "/runtime-secrets/$COGNIA_WORKSPACE_ID"
fi
exec gosu pwuser node /opt/cognia-runtime/src/main.mjs

#!/usr/bin/env bash
# Single source of truth for the external agent CLIs preinstalled into the
# cognia-server `runtime-full` image and the per-workspace `cognia-runner`
# image (ADR-0059 W6 / D9). Keeping one script means the two images can never
# drift on agent versions.
#
# Versions are pinned via env vars so images.yml / compose builds can override
# without editing the script; bump the defaults deliberately.
#
# Note: the in-app claude-code ACP preset spawns
# `npx -y @zed-industries/claude-code-acp` territory — the zed ACP bridge wraps
# @anthropic-ai/claude-code. Both are installed globally so `npx -y` resolves
# offline. cursor-agent ships through Cursor's own installer (no npm package);
# it is optional — a missing cursor-agent degrades that one preset only.
set -euo pipefail

: "${CLAUDE_CODE_VERSION:=latest}"
: "${CLAUDE_CODE_ACP_VERSION:=latest}"
: "${CODEX_VERSION:=latest}"
: "${CODEX_ACP_VERSION:=latest}"
: "${GEMINI_CLI_VERSION:=latest}"
: "${OPENCODE_VERSION:=latest}"
: "${CLINE_VERSION:=latest}"
: "${INSTALL_CURSOR_AGENT:=1}"

# Every binary in SpawnPolicy's BINARY_ALLOWLIST (external_agent/presets.rs)
# must resolve in these images — an allowlisted-but-absent CLI fails every
# spawn with command-not-found. `cline` is the npm package of that name
# (bin: cline); cursor-agent is the only non-npm install below.
npm install -g --no-audit --no-fund \
  "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
  "@zed-industries/claude-code-acp@${CLAUDE_CODE_ACP_VERSION}" \
  "@openai/codex@${CODEX_VERSION}" \
  "@zed-industries/codex-acp@${CODEX_ACP_VERSION}" \
  "@google/gemini-cli@${GEMINI_CLI_VERSION}" \
  "opencode-ai@${OPENCODE_VERSION}" \
  "cline@${CLINE_VERSION}"

if [ "${INSTALL_CURSOR_AGENT}" = "1" ]; then
  # Cursor's CLI has no npm distribution; its installer drops `cursor-agent`
  # into ~/.local/bin. Tolerate failure — the vendor endpoint is outside our
  # control and every other agent remains usable. The install tree must be
  # world-readable: the symlink alone is not enough if the image later runs
  # as a non-root uid.
  if curl -fsSL https://cursor.com/install | bash; then
    ln -sf /root/.local/bin/cursor-agent /usr/local/bin/cursor-agent || true
    chmod -R a+rX /root/.local 2>/dev/null || true
  else
    echo "install-agents: cursor-agent installer failed — continuing without it" >&2
  fi
fi

npm cache clean --force

# Cognia Claude Sidecar

A small Node host that runs the [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) and bridges it to the Tauri parent process over stdio (JSON-lines protocol).

## Requirements

- Node.js **>= 20**
- `pnpm install` from this directory (it is intentionally outside the root pnpm workspace because it has Node-only deps and ships separately as a Tauri resource).

## Usage

This package is not invoked by hand — Tauri spawns it on app start. For local debugging:

```bash
node claude-host.mjs        # runs the JSON-line protocol on stdio
node claude-host.mjs --smoke # one-shot smoke test, prints to stderr
```

Auth comes from the same sources the Claude Code CLI uses (`ANTHROPIC_API_KEY`, the OAuth token in `~/.claude/`, etc.). The parent passes per-call settings via the `options` field of `send`.

## Protocol

See the comment block at the top of `claude-host.mjs`.

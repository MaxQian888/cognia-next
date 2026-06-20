# @cognia/agent-cli — `cognia-agent`

A standalone, desktop-independent Cognia coding agent for the terminal.

It runs the **same** agent loop and option assembly as the Cognia desktop app
(`resolveSendOptions` + `runAndCaptureAssistantReply`), driven through a
`StdioTransport` that spawns the Node sidecar (`sidecar/claude-host.mjs`)
directly. Config comes from `~/.cognia/` + env + flags — never the desktop's
IndexedDB or OS keyring — so behaviour is identical without the desktop running.

## Commands

```bash
# One-shot, headless (CI-friendly)
cognia-agent run "create hello.txt with the text hi" --cwd . --allow write --yes
cognia-agent run "summarize the repo" --json        # JSONL stream + final result

# Credentials (stored in ~/.cognia/credentials.json, 0600)
cognia-agent auth login --provider anthropic --api-key sk-...
cognia-agent auth status
cognia-agent auth logout --provider anthropic

# Config (~/.cognia/config.json)
cognia-agent config path
cognia-agent config get [key]
cognia-agent config set model claude-opus-4-8
```

## Configuration

Layered, low → high precedence:

1. defaults
2. `~/.cognia/config.json`
3. `~/.cognia/credentials.json` (api keys)
4. `./.cognia/config.json` (project)
5. env (`ANTHROPIC_API_KEY`, `COGNIA_PROVIDER`, `COGNIA_MODEL`, …)
6. CLI flags

Provider routing mirrors the sidecar dispatch router: `anthropic` uses the
native claude-agent-sdk path (auth via `ANTHROPIC_API_KEY`); any other provider
uses the ai-sdk path (auth via the resolved provider credentials).

## Development

```bash
pnpm cli:test      # jest cli/
pnpm cli:dev ...   # run from source (requires tsx)
pnpm cli:build     # bundle to cli/dist/cognia-agent.mjs (requires esbuild)
```

The sidecar is located via `$COGNIA_SIDECAR_SCRIPT` or by walking up to
`sidecar/claude-host.mjs`.

## Interactive TUI

Beyond the headless `run`, `cognia-agent` ships a full **interactive terminal UI**
(`cli/src/tui/`) — an Ink/React app with a slash-command system, runtime
controllers (goal / workflow / team / mcp / memory / plugins / skills / …),
overlays, and a readline-style composer (`/`-palette, `@`-mentions, history,
rebindable editing chords). It reuses the same agent loop and option assembly as
the desktop app. See the subsystem docs:
[Agent CLI TUI](../docs/content/docs/en/subsystems/cognia-agent-tui.mdx) and
[ADR-0050](../docs/content/docs/en/adr/0050-cli-tui-operation-experience.md).

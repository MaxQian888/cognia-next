# @cognia/agent-cli — `cognia-agent`

A standalone, desktop-independent Cognia coding agent for the terminal.

With the default `builtin` backend, it runs the **same** agent loop and option assembly as the Cognia desktop app
(`resolveSendOptions` + `runAndCaptureAssistantReply`), driven through a
`StdioTransport` that spawns the Node sidecar (`sidecar/claude-host.mjs`)
directly. Config comes from `~/.cognia/` + env + flags — never the desktop's
IndexedDB or OS keyring — so behaviour is identical without the desktop running.

## Commands

```bash
# One-shot, headless (CI-friendly)
cognia-agent run "create hello.txt with the text hi" --cwd . --allow write --yes
cognia-agent -p "summarize the repo"                 # -p == run, no keyword
echo "context body" | cognia-agent -p "summarize this"   # piped stdin merges into the prompt

# Output formats (pi / Claude-Code aligned)
cognia-agent -p "list TODOs" --output-format text         # default: final text
cognia-agent -p "list TODOs" --output-format json         # one {type:"result"} object
cognia-agent -p "list TODOs" --output-format stream-json   # JSONL events + final result
cognia-agent -p "list TODOs" --json                        # alias of stream-json
cognia-agent -p "do a quick fix" --max-turns 4 --yes       # bound the agentic loop

# In-tree plugins (off by default)
cognia-agent -p "search the web for X" --plugin-tools --yes   # expose first-party plugin tools
cognia-agent chat --dev-plugins                               # dev: load repo plugins/<id> live
cognia-agent chat --dev-plugins --dev-plugins-dir ./plugins   #   …from an explicit directory

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

### Dev plugins (`--dev-plugins`)

`--dev-plugins` discovers the repo's in-tree `plugins/<id>/plugin.json` and loads
each `type: "frontend"` plugin as a **live** disk plugin (hot-reloadable via
`/plugin reload`), supplementing the compiled-in builtin registry. It implies
`--plugin-tools`. The directory is auto-located by walking up to the repo root
(nearest ancestor with both `plugins/` and `package.json`), or set explicitly with
`--dev-plugins-dir <dir>`. A plugin's `main` must be runnable under the active
loader — under `pnpm cli:dev` (tsx) the `@/` aliases in-tree plugins use resolve
via tsconfig paths; the packaged binary cannot resolve them, so this is a
dev-from-source feature. Ids already in the static builtin registry are skipped
(no duplicate-registration noise). Loaded dev plugins appear in `/plugin list`.

## Interactive TUI

Beyond the headless `run`, `cognia-agent` ships a full **interactive terminal UI**
(`cli/src/tui/`) — an Ink/React app with a slash-command system, runtime
controllers (goal / workflow / team / mcp / memory / plugins / skills / …),
overlays, and a readline-style composer (`/`-palette, `@`-mentions, history,
rebindable editing chords). It reuses the same agent loop and option assembly as
the desktop app. See the subsystem docs:
[Agent CLI TUI](../docs/content/docs/en/subsystems/cognia-agent-tui.mdx) and
[ADR-0050](../docs/content/docs/en/adr/0050-cli-tui-operation-experience.md).

The TUI can also host executable external agents directly, without a running
desktop app. This path reuses the desktop external-agent presets, manager, ACP /
Codex adapters, permissions, and event contracts, while a CLI-native Node host
launches the selected process through a strict native sandbox:

```bash
cognia-agent chat --backend codex
cognia-agent chat --backend claude-code
cognia-agent config set agentBackend codex   # persist the default
```

macOS uses Seatbelt and Linux requires bubblewrap; unsupported platforms or a
missing launcher fail closed, with no unsandboxed fallback. Cognia credentials,
plain provider environment variables, and the external CLI's own native login
are supported. See [Agent CLI External Hosting](../docs/content/docs/en/subsystems/cognia-agent-external-hosting/)
and [ADR-0077](../docs/content/docs/en/adr/0077-tui-external-agent-hosting.md).

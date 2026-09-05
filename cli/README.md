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

## Calling a Cognia Host

Beyond running an agent, the CLI is a complete client for a Host's command
plane. The surface is generated from the frozen protocol contract
(`protocol/companion-commands.json` plus the two Companion OpenAPI specs), so
every command the Host exposes is reachable without the CLI growing a
hand-written verb for each one.

```bash
# Where to call. Records live in ~/.cognia/hosts.json at 0600.
cognia-agent host add local --endpoint https://127.0.0.1:27890 --token "$COGNIA_SERVICE_TOKEN"
cognia-agent host login desktop --endpoint https://127.0.0.1:27890 --pair-code ABC123
cognia-agent host show          # every value, and where it came from
cognia-agent host use local

# Discover.
cognia-agent api groups --wire http
cognia-agent api list --group plugin --search install
cognia-agent api describe scheduled_task_create
cognia-agent api schema adapter_update_policy --template > body.json

# Call. Flags come from the request schema.
cognia-agent api call adapter_update_policy --id bot_1 --default-mode auto
cognia-agent api call agent_send --data @body.json --wait
cognia-agent api request GET /api/devices

# Derived resource commands mirror the wire names.
cognia-agent plugin list
cognia-agent adapter update-policy --id bot_1 --muted
cognia-agent plugin list --help   # describes that command's own fields
```

### Two wires

The Host admits exactly two authority modes, and the CLI speaks both.

| Wire       | Route                        | Credential             | Reach                                | Capability check   | Approval check               |
| ---------- | ---------------------------- | ---------------------- | ------------------------------------ | ------------------ | ---------------------------- |
| `internal` | `POST /internal/_rpc/{name}` | loopback service token | **656** commands                     | bypassed by design | bypassed by design           |
| `http`     | `POST /api/_rpc/{name}`      | DPoP device session    | **527** (`execution` / `host-admin`) | per-device grant   | admin lease or signed policy |

A loopback service principal is the policy authority for the Brain plane, which
is why the internal wire carries everything unchecked. On the device wire the
CLI is a device like any other: the owner grants and revokes it in the Device
Console, and an `interactive` command needs a lease a human granted on the host.

The desktop is reached through the device wire, by pairing with its Companion
API. Its CLI bridge (ADR-0078) carries 18 routes and does not dispatch
commands.

### Output and failures

```
--format raw|json|pretty   compact JSON | indented JSON | rendered
-o, --output <dir>         write into <dir> instead of stdout (implies raw)
--timeout 30s|1m|500ms     per-request budget
--debug                    log the request envelope to stderr
--json                     alias for --format raw
```

An explicit `--format` always wins. Otherwise `-o` implies `raw` and a bare
terminal gets `pretty`.

Failures print a block on stderr:

```
Error: adapter_update_policy has no field for --muted-x
Details: --muted-x is not a field of adapter_update_policy (did you mean --muted?)
Cause: invalid-request
Fix: cognia-agent api describe adapter_update_policy
Fix: the host rejects unknown fields outright, so this would have failed on the wire
```

Because the index carries the whole request shape, a bad call fails locally.
Unknown fields, missing required fields and out-of-range enums are refused
before anything is sent, rather than arriving as the 422 that
`additionalProperties: false` guarantees. Exit codes are 0 for success, 2 for a
usage mistake, and 1 for everything the host or the network refused.

### Regenerating the index

```bash
pnpm cli:api:gen     # rebuild cli/src/api/generated/command-index.ts
pnpm cli:api:check   # fail if it drifts from the protocol contract
```

Run it after changing `protocol/companion-commands.json` or regenerating the
Companion specs with `pnpm companion-api:gen`.

## Configuration

Layered, low → high precedence for model providers:

1. defaults
2. `~/.cognia/config.json`
3. `~/.cognia/credentials.json` (api keys)
4. `./.cognia/config.json` (project)
5. env (`ANTHROPIC_API_KEY`, `COGNIA_PROVIDER`, `COGNIA_MODEL`, …)
6. CLI flags

Provider routing mirrors the sidecar dispatch router: `anthropic` uses the
native claude-agent-sdk path (auth via `ANTHROPIC_API_KEY`); any other provider
uses the ai-sdk path (auth via the resolved provider credentials).

Web search is configured under `search` and projected into the same shared
search executor used by the desktop app:

```json
{
  "webTools": true,
  "search": {
    "defaultProvider": "tavily",
    "maxResults": 8,
    "fallbackEnabled": true,
    "safeSearch": "moderate",
    "providers": { "tavily": { "enabled": true, "priority": 1 } }
  }
}
```

Search secrets live in `credentials.json` under
`searchProviders.<provider>.apiKey` (Google may also carry `cx`). Their
precedence is env → credentials → project config → user config. Environment
keys are `COGNIA_SEARCH_<PROVIDER>_API_KEY` with `-` changed to `_`, for example
`COGNIA_SEARCH_GOOGLE_AI_API_KEY`; Google CX uses
`COGNIA_SEARCH_GOOGLE_CX`.

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
cognia-agent chat --backend codex-app-server  # native Codex, explicitly
cognia-agent chat --backend codex-acp         # ACP adapter, explicitly
cognia-agent chat --backend claude-code
cognia-agent config set agentBackend codex   # persist the default
```

`codex` prefers the installed native app-server and otherwise selects the ACP
adapter. The explicit engine names keep that choice stable. The ACP route launches
`@zed-industries/codex-acp` through `npx`, which may download the adapter on first
use. Native reasoning and extra skill roots are forwarded only to the native
engine. ACP model and mode controls use the options advertised by that adapter.

macOS uses Seatbelt and Linux requires bubblewrap; unsupported platforms or a
missing launcher fail closed, with no unsandboxed fallback. Cognia credentials,
plain provider environment variables, and the external CLI's own native login
are supported. See [Agent CLI External Hosting](../docs/content/docs/en/subsystems/cognia-agent-external-hosting/)
and [ADR-0077](../docs/content/docs/en/adr/0077-tui-external-agent-hosting.md).

# Cognia-managed DeepSeek Harness runtime

This directory owns the launch boundary, Cognia services bridge, and permission overlays for DeepSeek Harness.
It uses the official `@deepseek-ai/dsh` product launcher and the shipped
`@deepseek-ai/dsh-sdk-minimal` bundle. The former hand-written Cordis root and
`dsh-agent-spine-demo` composition are no longer supported.

## Supported release and protocol

The supported npm `latest` release is **0.1.5-rc.1**, verified on 2026-09-12.
`0.1.5-rc.2` is the separate `next` channel. The runtime manifest pins the product,
transport packages, and the complete DSH dependency namespace to rc.1: upstream's
caret dependencies otherwise resolve 210 transitive packages from the next channel.
The explicit overrides come from the installed product's dependency closure and
must be refreshed together on the next supported release upgrade. The installer
retains a lockfile and validates its digest.

The SDK requests are `initialize`, `session/prompt`, and `shutdown`; notifications
remain `session.event`, `session.status`, `subagent.started`, and `subagent.finished`.
Durable sessions use format **3**. The transport's `serverInfo.version` is still
`0.0.1`, so it cannot establish package compatibility. The launcher checks installed
package versions before loading upstream code and rejects older releases.

## Profiles

The existing `host.*.yml` artifact names now contain **patch overlays**, applied
last through the official `dsh --profile <name> --patch <absolute-overlay>` grammar.
All profiles inherit the maintained minimal agent kernel, projection registry,
LLM service, and session persistence, then add sandboxed filesystem tools and a
local image attachment store.

| Artifact                 | Managed profile        | Authority                                                                               |
| ------------------------ | ---------------------- | --------------------------------------------------------------------------------------- |
| `host.sdk-readonly.yml`  | `cognia-sdk-readonly`  | Read-only files; shell, PTY, jobs, and approval service disabled/absent.                |
| `host.sdk-workspace.yml` | `cognia-sdk-workspace` | Workspace-write files and persistent shell; requires Cognia launch-time preapproval.    |
| `host.acp.yml`           | `cognia-acp`           | Workspace-write files; no shell; wider one-shot operations require ACP client approval. |

Readonly writes and model-requested escalation fail closed. SDK workspace also has
no approval provider, so it cannot grant itself a broader mode. ACP replaces both
SDK startup and transport rows with the official ACP app and server; its approval
service forwards `session/request_permission` to Cognia. Neither SDK composition
advertises an interactive approval capability.

## Cognia tools and model gateway

`launcher.mjs` also exports a Cordis startup plugin, mounted through the overlay's
relative `./launcher.mjs` entry. Both transports wait for `cogniaServicesReady`,
so the first prompt cannot race MCP discovery or gateway route registration.

For SDK, Cognia creates one runtime per session and supplies
`COGNIA_DSH_MCP_SERVERS` as a JSON array of standard ACP server declarations:
stdio `{name, command, args, env:[{name,value}]}` or HTTP
`{type:"http", name, url, headers:[{name,value}]}`. The launcher validates them,
normalizes names identically to ACP, and mounts the official `dsh-mcp-client`
with `failOnStartupError:true`. For ACP, use the same declarations through
`session/new` and `session/resume`; upstream already mounts them per agent.
MCP tools retain `mcp__cognia-tools__<tool>` / `mcp__cognia-plugin-tools__<tool>`
identity. Cognia's broker owns permissions, approvals, extra workspace roots,
and actual tool execution; the DSH bridge does not duplicate those decisions.
MCP resources/prompts are not upstream bridged capabilities.

A Cognia model lease sets `COGNIA_DSH_PROVIDER=cognia`, `COGNIA_DSH_MODEL`,
`COGNIA_DSH_GATEWAY_TOKEN`, and `COGNIA_DSH_GATEWAY_CONFIG`. The latter contains
`{providers:{cognia:{api:"openai-completions",baseURL,apiKeyEnv:"COGNIA_DSH_GATEWAY_TOKEN",models:[...]}}}`.
The startup plugin registers this route through official `dsh-llm-pi-ai`, while
the overlay disables the direct DeepSeek adapter. No DeepSeek credential is
required for this route. The host owns lease lifetime and credential cleanup.

`COGNIA_DSH_ALLOWED_TOOLS` is preapproval metadata, not a visibility allowlist.
`COGNIA_DSH_ADDITIONAL_DIRECTORIES` is broker policy scope. Both are validated
JSON string arrays; extra roots do not widen native DSH filesystem/shell policy.
Upstream's native sandbox supports one workspace root plus platform temporary
roots; additional-root work goes through the Cognia broker's governed tools.

## Isolation

The runtime manager must set `COGNIA_DSH_RUNTIME_HOME` and `DSH_HOME`. The latter
must resolve to a strict child of the runtime home. The launcher validates canonical
paths, including nonexistent children behind symlinked ancestors, and accepts only
the three managed overlays inside the runtime home.

Each profile gets a deterministic manifest at
`$DSH_HOME/profiles/<managed-profile>/package.json`, with exactly one bundle,
`@deepseek-ai/dsh-sdk-minimal`, and `patchReload: startup`. Existing manifests must
match exactly; additional dependencies or changed bundle lists are rejected.
Home/profile `cordis.patch.yml` files and a home `.env` are rejected. The product
launches with cwd set to the isolated Harness home, preventing workspace `.env`
credentials from reentering Cognia's scrubbed process environment. The original
workspace is pinned in `COGNIA_DSH_WORKSPACE`, SDK `initialize.cwd`, and ACP
`session/new.cwd`. Session persistence stays inside the runtime home, and image
attachments stay under `DSH_HOME`. Telemetry is disabled.

The official launcher supplies Cordis startup services, module fallback links,
stdin lifetime, and bounded signal shutdown. Stdout carries JSON-RPC exclusively;
Cognia preflight failures go to stderr.

## Verification

```sh
node --test launcher.test.mjs
npm install --ignore-scripts --no-audit --no-fund
node --test launcher.smoke.test.mjs services.smoke.test.mjs
```

Install this package into an isolated directory, never into Cognia's application
workspace. `launcher.test.mjs` checks argument validation, path containment, hidden
patches, manifest injection, and stale release refusal. `launcher.smoke.test.mjs`
launches actual product subprocesses using `mock-deepseek.mjs`, a loopback SSE
provider with a dummy credential. It exercises SDK initialize, prompt receipts,
tool execution/denial, final output, idle, shutdown, image input, persisted v3
headers, and ACP initialize/new/prompt/permission rejection/disconnect. It rejects
the obsolete dotted `session.prompt` request. `services.smoke.test.mjs` also drives SDK startup MCP, ACP session MCP, the generic Cognia model route, and denied-tool-result propagation without duplicate approvals. These tests spend no model credits.

The package carries the full official launcher closure, including optional native
providers. The smoke results establish the local macOS installation; other platforms
still need their own native-binding and sandbox checks before claiming device support.

Upstream: [product launcher](https://www.npmjs.com/package/@deepseek-ai/dsh/v/0.1.5-rc.1),
[SDK minimal bundle](https://www.npmjs.com/package/@deepseek-ai/dsh-sdk-minimal/v/0.1.5-rc.1).

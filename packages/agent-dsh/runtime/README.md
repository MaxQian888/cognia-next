# Cognia-managed DeepSeek Harness runtime

This directory owns the launch boundary, Cognia services bridge, and permission overlays for DeepSeek Harness.
It uses the official `@deepseek-ai/dsh` product launcher and the shipped
`@deepseek-ai/dsh-sdk-minimal` bundle. The former hand-written Cordis root and
`dsh-agent-spine-demo` composition are no longer supported.

## Supported release and protocol

The managed release is **0.2.1-rc.2**, verified against the published package
sources on 2026-10-18. The runtime pins the product, transport packages, and
DSH dependency namespace together so caret dependencies cannot mix releases.
The explicit overrides cover all **295 DSH packages** in the exact published
product/runtime dependency closure, including optional and peer dependencies,
and must be refreshed together on the next supported release upgrade. The installer
retains a lockfile and validates its digest.

The Cognia SDK adapter uses `initialize`, `session/prompt`, `session/wait`, and
`shutdown`. Upstream also supports working-directory get/set and native
`session/resume`; native SDK resume remains excluded from this integration upgrade.
Notifications remain `session.event`, `session.status`, `subagent.started`, and `subagent.finished`.
Durable sessions use format **4**. The transport's `serverInfo.version` is still
`0.0.1`, so it cannot establish package compatibility. The launcher checks installed
package versions before loading upstream code and rejects older releases.

## Profiles

The existing `host.*.yml` artifact names now contain **patch overlays**, applied
last through the official `dsh --profile <name> --patch <absolute-overlay>` grammar.
All profiles inherit the maintained minimal agent kernel, projection registry,
LLM service, session persistence, working-directory service/tools, and automatic
compaction/image offload. The new minimal bundle already owns filesystem tools
and the attachment store. Cognia configures those inherited rows rather than
inserting duplicate IDs.

Cordis patch rows cannot replace a plugin by changing its `name`. Each overlay
explicitly disables the inherited `filesystem` (`dsh-fs-local`) row and inserts
`fs-sandboxed` (`dsh-fs-sandbox`). The smoke test verifies the active package
inventory contains only the sandboxed provider. Working-directory changes keep
the original session workspace as the sandbox policy root.

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
MCP tools are mounted through the upstream client; the minimal bundle also owns its resource services.

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
rtk node --test launcher.test.mjs
rtk npm install --ignore-scripts --no-audit --no-fund
rtk node --test launcher.smoke.test.mjs services.smoke.test.mjs
```

Install this package into an isolated directory, never into Cognia's application
workspace. `launcher.test.mjs` checks argument validation, path containment, hidden
patches, manifest injection, and stale release refusal. `launcher.smoke.test.mjs`
launches actual product subprocesses using `mock-deepseek.mjs`, a loopback SSE
provider with a dummy credential. It exercises SDK initialize, prompt receipts,
tool execution/denial, `session/wait`, final output, idle, shutdown, image input,
working-directory get/set and missing-directory rejection, durable directory
change events, persisted v4 headers, and ACP initialize/new/prompt/permission rejection/disconnect. It rejects
the obsolete dotted `session.prompt` request. `services.smoke.test.mjs` also drives SDK startup MCP, ACP session MCP, the generic Cognia model route, and denied-tool-result propagation without duplicate approvals. These tests spend no model credits.

On 2026-10-18, an isolated npm installation on macOS arm64 with Node 26.5.0
installed 613 packages, and all **17 tests passed** (10 launcher unit checks plus
7 actual-runtime/closure checks). The closure check verifies every DSH entry in
the installed lockfile is exactly `0.2.1-rc.2` and covered by the managed override
list. No user-managed runtime, credentials, or persistent sessions were migrated
or activated during this validation.

The production-adapter smoke also passed **5 sessions and 7 prompts** through
the actual DSH subprocess, Cognia Node host, CLI tool broker, renderer helper,
and sidecar, with event counts `[7, 7, 6, 7, 42, 42, 6]`. It covered concurrent
sessions, follow-ups, reconnects, tool reads/writes, `ask_user`, additional roots,
denied writes, and renderer approval hooks. The provider was a local Messages API
fixture, not an authenticated public model call. Native DSH sandbox policies were
active; this adapter smoke did not exercise a packaged Tauri or host OS sandbox.
The real run also corrected Cognia's old nested tool-result assumption: published
DSH tool messages carry `toolCallId`, `content`, and `isError` on the message itself.
The codec checks the tool role and source call identity before forwarding results.

Run the production-adapter regression from the Cognia repository root after
installing this runtime into an isolated directory:

```sh
rtk node scripts/smoke/build-and-run-smoke.mjs --deepseek-harness /path/to/installed/runtime
```

The package carries the full official launcher closure, including optional native
providers. The smoke results establish the local macOS installation; other platforms
still need their own native-binding and sandbox checks before claiming device support.

Upstream: [product launcher](https://www.npmjs.com/package/@deepseek-ai/dsh/v/0.2.1-rc.2),
[SDK minimal bundle](https://www.npmjs.com/package/@deepseek-ai/dsh-sdk-minimal/v/0.2.1-rc.2).

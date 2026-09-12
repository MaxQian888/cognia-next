# DeepSeek Harness protocol coverage audit

Date: 2026-09-12

## Version and evidence

Cognia targets the npm `latest` release `0.1.5-rc.1`, inspected from the published packages on 2026-09-12. The `next` tag (`0.1.5-rc.2`) is not the selected channel. Older session formats, old notification envelopes, and older certified channels are rejected. SDK `serverInfo.version` is the internal wire implementation version, not the npm release, so certification checks the pinned channel and digests instead.

Primary sources:

- [Published SDK protocol 0.1.5-rc.1](https://www.npmjs.com/package/@deepseek-ai/dsh-sdk-protocol/v/0.1.5-rc.1), especially the README method table and emitted event vocabulary.
- [SDK protocol source](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/protocol/README.md).
- [SDK server source](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/sdk/server).
- [SDK client source](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/sdk/client).
- [Published ACP package 0.1.5-rc.1](https://www.npmjs.com/package/@deepseek-ai/dsh-acp/v/0.1.5-rc.1) and [ACP adapter source](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/acp).
- [Published MCP client 0.1.5-rc.1](https://www.npmjs.com/package/@deepseek-ai/dsh-mcp-client/v/0.1.5-rc.1).

GitHub `master` links are navigational; the installed npm version and local certification are authoritative for this audit.

## Interface coverage

| Surface                                      | Upstream behavior                                                              | Cognia handling                                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| SDK `initialize`                             | Resolves provider/model route and returns server identity                      | Awaited and identity-checked before accepting prompts; Cognia assigns UUID session IDs                              |
| SDK `session/prompt`                         | Accepts content blocks; result is an inbox admission receipt                   | Receipt is not treated as completed assistant output                                                                |
| SDK `shutdown`                               | Cooperative runtime shutdown                                                   | Close attempts shutdown, then host process teardown                                                                 |
| SDK `session.event`                          | Committed durable session events, current session format                       | Strict current event decoder; tools, reasoning, usage and assistant output derived from committed events            |
| SDK `session.status`                         | Runtime running/idle transition                                                | Tracks turn completion separately from prompt admission                                                             |
| SDK `subagent.started` / `subagent.finished` | Parent-child lineage and final child output                                    | Observations are attributed to the correct child/parent                                                             |
| SDK live token deltas                        | Not emitted                                                                    | Not advertised; settings state committed-event latency                                                              |
| SDK cancel / permission requests             | Not supported                                                                  | Cancellation closes runtime; launch profile defines authority                                                       |
| SDK session resume/load/list                 | No corresponding wire method                                                   | Not fabricated as SDK methods                                                                                       |
| ACP initialize/new/prompt                    | ACP version 1, committed replies                                               | Existing ACP adapter plus managed launch preparation                                                                |
| ACP permission requests/cancel               | Interactive approval and turn cancellation                                     | Existing broker/notification path; session permission policy is client-local                                        |
| ACP `session/set_mode`                       | Unsupported                                                                    | Client broker policy changes without sending this method                                                            |
| ACP session list/resume/close                | Advertised stable session capabilities                                         | Generic ACP adapter uses current methods and fresh per-session MCP configuration                                    |
| ACP model/reasoning configuration            | `session/set_config_option` and typed config options                           | Existing ACP option selection path                                                                                  |
| ACP MCP servers                              | Native per-session stdio and HTTP mounting                                     | Cognia built-in/plugin broker and assigned MCP servers forwarded through `session/new` and resume                   |
| SDK MCP servers                              | Official MCP plugin supports startup mounting; initialize has no MCP parameter | Each Cognia session launches an isolated SDK runtime with its own server configuration and leases                   |
| Cognia model routing                         | Official configurable provider plugin                                          | Task-scoped Cognia gateway route and lease preserved through managed launch; own-provider credentials omitted       |
| Cognia skills and context                    | SDK prompt has user-content blocks, no system-role override                    | Existing instruction envelope and selected skills become a gated first-prompt preamble; no invented SDK system role |

## Invocation path repairs

The old presets intentionally had empty process commands, but the settings and chat forms required a command before saving. Managed profiles now save with empty commands, select the certified composition at connect, and accept the DeepSeek API key through the existing lifecycle service. That service extracts the key into its keyring before storing the configuration. Editing with a blank key preserves the existing reference.

Both SDK and ACP now pass through the same `prepareDshManagedLaunch` function before connecting. It gathers fresh runtime facts, runs the shared doctor, checks profile/protocol agreement, resolves the current host executable/workspace/runtime paths, resolves keyring credentials, and constructs a transient launch configuration. It does not write resolved credentials back to the saved config. The new helper is necessary because the prior pure installation policy and transport wrapper had no shared async host-facts/keyring orchestration entry point.

Desktop and CLI facts expose runtime home, Node path, default workspace and an allowlisted parent environment. The subprocess environment is rebuilt with the existing isolation policy; unrelated provider keys are not inherited. Settings descriptions distinguish committed output from live token deltas and expose MCP tool availability.

## Verification boundaries

Focused unit tests cover managed save and key handoff, SDK/ACP launch preparation, preflight rejection before credential reads, profile/protocol mismatch, absence of unrelated credentials, current event decoding, ACP local permission policies, MCP forwarding, Cognia gateway lease preservation/keyring bypass, and host facts. Runtime launcher tests exercise composition and confinement separately.

A mocked host or transport test does not establish a successful authenticated DeepSeek model completion, a packaged Tauri launch, or remote-host operation. Those require an installed certified runtime, compatible Node, actual credentials and the relevant host. See the task's final verification report for checks actually run and failures encountered in the concurrent tree.

## Recorded verification on 2026-09-12

The actual published DSH runtime was executed through `NodeExternalAgentBackend` and Cognia's SDK adapter using a local mock provider. `scripts/smoke/deepseek-harness-adapter-smoke.ts` passed with three sessions, four prompts and observed event counts `[6, 6, 5, 6]`, including concurrent sessions, a follow-up and reconnection against the same persisted storage. This establishes subprocess launch, handshake, prompt admission, committed reply and completion against real DSH while the model HTTP endpoint is mocked; it does not claim an authenticated public DeepSeek request.

Follow-up launch checks cover explicit endpoint forwarding (without inheriting ambient endpoints), reasoning effort, max output tokens, context window and persona. Persona content passes the outbound PII gate before launch. The doctor accepts only exact generated manifests for the three managed profiles after first launch; modified manifests and symlinked profile paths remain rejected.

The consolidated focused Jest run passed 740 tests across 13 suites. The SDK adapter, event codec, channel policy, launch helper and transport each exceeded 90% scoped line/branch/function coverage; transport coverage is 100% lines/functions and 93.47% branches. The focused Rust DSH suite passed 19 tests, including child environment isolation and omission of credentials from process metadata. Launcher unit and installed-runtime subprocess tests passed all 10 cases, including actual read-only denial, workspace file/image handling and ACP permission rejection.

Browser verification at `/settings` covered choosing the read-only preset, its API key field, managed command fields, and successful save with an empty command. The plain browser correctly disabled process connection without a native process host. This does not establish packaged Tauri UI or remote-host support. No real API key was entered or used.

Full-repository `pnpm test:coverage` was attempted but failed in shard 1 with unrelated recording test failures and a Node heap abort. A sufficient-heap whole-repository TypeScript check completed with errors in other concurrent work; these global checks are not reported as passing. Focused tests and scoped coverage are the validation boundary for this change.

The final TypeScript pass exposed missing required fields in a test config and sparse process-environment fixtures introduced here. These were corrected; semantic diagnostics for the affected backend source/tests, SDK test and adapter smoke script passed in full project context. A follow-up six-suite run passed 215 tests after those edits. Focused ESLint, i18n generation/freshness/lint and `git diff --check` also passed.

## Corrected ACP findings and Cognia capability parity

The initial ACP text-only/no-MCP/no-resume finding was incorrect. Reinspection explicitly checked `package.json` for `@deepseek-ai/dsh`, `@deepseek-ai/dsh-acp`, and `@deepseek-ai/dsh-mcp-client`: all are `0.1.5-rc.1`. The shipped `host.acp.yml` composes `@deepseek-ai/dsh-acp`, not an alternate ACP adapter. In that published package, `lib/index.js` lines 217–257 mount session MCP clients, lines 695–721 install them before publishing new/resumed agents, lines 566–618 publish reasoning/text/tool updates, and lines 1148–1160 advertise list/resume/close and HTTP MCP. These are current-package facts, not claims inferred from the newer `next` tag.

Accordingly, Cognia removes the incorrect DSH MCP/list guards and marks both managed transports MCP-capable. ACP supports model/reasoning config options but has no native `session/set_mode`; permission changes remain broker policy. SDK mounting is an adapter-level equivalent achieved by one isolated runtime per Cognia session. Native DSH read-only file policy and Cognia broker tool policy are separate enforcement points.

The six wiring suites pass 323 tests after these corrections, including both transports' task-scoped model routing and absence of own-provider keys when routed through Cognia. The broader counts above describe the preceding protocol baseline; the final parity smoke and regression report supersede them for the expanded capability work.

## Desktop and CLI Cognia tool parity verification

The desktop chat dispatch now projects its complete `SendOptions` into a conversation-owned sidecar MCP host. This reuses Cognia's existing built-in tool executor, plugin and synthetic-tool handler (including skills, `ask_user`, and nested dispatch when enabled), permission UI, confinement, tool selection, and PII gates. The host is registered through the existing feature-call IPC operations rather than a second native command family. User-assigned MCP servers and instruction context are forwarded alongside that host.

Each conversation owns its authenticated loopback endpoints. Each turn refreshes tool policy, scopes approval and plugin replies to the lease and generation, and pauses execution after completion or cancellation. Closing the conversation disposes the external session and host. A tool catalog fingerprint distinguishes schema changes from policy-only updates; cached external catalogs must be refreshed when the manifest changes. SDK lacks a native durable resume method, so a recreated SDK context must receive Cognia's preserved transcript explicitly rather than pretending to resume the old DSH session.

Run the installed-runtime test with:

```sh
node scripts/smoke/build-and-run-smoke.mjs --deepseek-harness /path/to/installed/runtime
```

The expanded test passed **five sessions and seven prompts**, with event counts `[6, 6, 5, 6, 36, 36, 5]`. It drives the real DSH process through the production SDK adapter, the CLI broker, and the renderer helper connected to a real sidecar process. It verifies actual workspace reads/writes, a read from an additional directory, `ask_user` through the existing store, denied writes leaving no file, reuse of the desktop endpoint across turns, and round trips through the existing PreToolUse/PostToolUse dispatchers. The fixture supplies a local model HTTP endpoint and acknowledges the native background-job cleanup RPC because it creates no native jobs. It does not test paid provider calls, packaged Tauri transport, terminal jobs, or every installed plugin individually.

The final focused adapter/transport/Node host/renderer helper/feature-call/gateway run passed **189 tests across seven suites**. The new sidecar MCP host and feature-call suites passed **32 tests**, including pre-hook denial/rewrites, post-hook rewrites, PII rejection, lease expiry and cancellation. The new renderer helper and sidecar host each exceed 90% line, branch and function coverage. The full CLI external-session suite passed 87 of 88 tests before the final history fixture was added; its existing Claude permission-overlay case produced an extra error cell and is not reported as passing. The final six focused DSH credential, MCP forwarding and persisted-transcript replay cases passed. Full-repository validation remains subject to the concurrent-tree failures recorded above.

The final parity review also covers SDK gateway follow-ups: the gateway still revokes each turn's credentials and disposes its process. A following SDK turn starts a fresh native session with an explicit Cognia conversation transcript while retaining the logical gateway task. The renderer and CLI supply their persisted transcripts; missing history on a restored task fails clearly instead of fabricating native resume or silently starting an empty conversation. Managed DSH presets are recognized as gateway-capable before their intentionally empty command is resolved by the managed launcher.

The Tauri feature-call allowlist was extended with the tool host controls and its in-file test. Running that native test was blocked by concurrent compilation errors in `code_sandbox.rs` (`LaunchScope.denied_readable`), `provider_admin.rs` (`MintRequest.provider_overrides` and `set_snapshot`), and `cli_bridge/detect.rs` (partially moved test value). Consequently the main native crate is not reported as compiled or passing. The standalone external-agent Rust tests and real Node/sidecar subprocess checks remain separate evidence.

The final desktop/controller/approval/manager/ACP/MCP-converter run passed **556 tests across six suites**. It covers scoped persistent grants, automatic approval through Cognia's existing evaluator, SDK gateway follow-ups (regular and streaming calls), explicit restored-task transcript recovery, catalog changes, and ACP instruction delivery through actual prompt content. Targeted semantic diagnostics for the changed integration files passed in full project context. Current requests are excluded from replayed history so continuation does not duplicate the new prompt.

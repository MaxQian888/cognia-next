# Cognia capabilities across external agents

Date: 2026-09-12

## Scope

Extend the DSH Cognia tool-host integration across every registered external protocol: native Pi RPC, ACP, Codex app-server, OpenCode V2, DSH SDK and A2A. Reuse the renderer tool host and CLI broker. The retired Pi ACP bridge and OpenCode V1 adapter are not reintroduced.

## Capability coverage

| Runtime              | Cognia tools and assigned MCP                                                                                | Instructions, skills and context                                                                                    | Model routing                                                         | Lifecycle                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Pi 0.85.1 native RPC | First-party extension with official MCP SDK; stdio, Streamable HTTP and SSE                                  | Session and updated turn instructions; refreshed resume/fork options                                                | Task-owned Cognia provider configuration                              | Startup readiness after discovery, cancellation, close, resume and fork isolation              |
| Current ACP agents   | Native session MCP definitions; Cognia broker owns delegated tool authorization                              | Canonical instructions and semantic context also delivered as prompt content when metadata has no native meaning    | Existing supported runtime gateway routes                             | Session new/load/resume/fork options preserved; unchanged context not duplicated on every turn |
| Codex app-server     | Native thread configuration, including fresh fork MCP definitions                                            | Native developer instructions at creation, updated turn context when changed                                        | Task-owned Responses gateway                                          | Native thread lifecycle and current per-thread permission settings                             |
| OpenCode V2          | Authenticated per-session local service; no mutation of a shared service's location-scoped MCP configuration | Native instruction entries and safe semantic context                                                                | Current plural `providers` configuration and task-owned gateway lease | Separate child service per conversation; kill on close, retain resumable native state          |
| DSH SDK / ACP        | Existing full tool-host integration retained                                                                 | Existing current-protocol instruction paths                                                                         | Task-owned Cognia gateway                                             | SDK transcript-backed restart; ACP native resume                                               |
| Remote A2A           | Standard A2A cannot mount client-local tools or grant local workspace roots; explicit requests fail clearly  | Session instructions, skills summary and safe task context are carried in message parts; per-turn overrides honored | Remote agent owns its provider                                        | Existing task/context continuation and cancellation                                            |

An operator-owned remote OpenCode endpoint remains usable for conversation, but cannot receive a local per-chat tool lease. An explicitly configured local process can instead run a Cognia-owned service. Capability controls use the effective host/protocol profile, not a hard-coded list of three protocols.

Paired-host execution uses the existing run-turn command with canonical instructions and the tool allowlist forwarded. Caller-local MCP mounts are explicitly rejected: there is no reverse tool-host tunnel, and forwarding `127.0.0.1` would address the target host. The target agent's configured tools remain available. This change does not add an automatic Cognia broker to the paired-host run service.

Pi custom state directories remain subject to the existing sandbox. Managed gateway state and normal Pi/workspace roots are supported; accepting the two configuration environment keys does not grant arbitrary writable filesystem roots.

## Shared execution guarantees

- The CLI MCP bridge advertises the installed official SDK current protocol (`2025-11-25`) instead of a stale version literal.
- Built-in tools and plugin tools run through the same tool catalog, confinement and permission decisions as other Cognia external agents.
- CLI broker calls now include PreToolUse argument rewriting followed by schema/policy revalidation, and PostToolUse result review before returning to the model. Renderer calls already use that pipeline.
- Cognia-mounted tool namespaces acknowledge the runtime's preliminary permission request while the Cognia broker remains the authorization authority. Native agent tools retain the runtime permission path.
- Instruction or policy changes invalidate session signatures. Runtimes without native resume receive the persisted transcript when restarted. Session facts and tool leases remain scoped to the chat.
- Tool descriptions, arguments and results cross the existing PII gates. Native process metadata omits structured MCP/provider configuration and credentials.
- Standalone Pi packaging verifies the source digest and bundles runtime dependencies into the shipped extension; readiness waits for MCP discovery. The exact Pi configuration-directory environment keys survive both native and Node launch policies.

## Verification

- Installed Pi `0.85.1`, using the staged, digest-verified standalone extension: five real sessions and eight prompts passed against a deterministic localhost model fixture. Covered concurrent sessions, reconnect, replacement of tool-host credentials followed by native session resume and updated skill/context, CLI stdio broker, renderer HTTP tool host, read/write, `ask_user`, additional roots, denied write and pre/post tool callbacks.
- Installed OpenCode `2.0.0`: a five-session, seven-prompt tool parity smoke passed with per-session private services and current gateway configuration. This exposed and fixed the actual fixed `opencode` Basic-auth username and the need to allow only mounted Cognia tool namespaces ahead of native restrictive policy.
- Pi: 181 adapter/policy tests, 18 extension integration tests and 12 packaging tests pass. Adapter coverage is 97.57% lines, 90.26% branches, 95.29% functions; extension coverage is 99.84% lines, 90.52% branches, 95.92% functions. Source digest checks pass and extension tests are wired into the standard sidecar test commands. The focused Pi Jest run used `--forceExit` for retained handles in the existing imported module graph; real Pi smoke and Node transport tests terminate normally.
- Leaf adapter regression suite: 502 passing tests across five suites; one pre-existing skipped test. OpenCode client, event mapper and launcher exceed 90% lines, branches and functions.
- Shared renderer/CLI capability suites: 549 tests across eleven suites, plus 142 CLI parity tests across three suites and 23 sidecar bridge tests. The known unrelated Claude overlay assertion was excluded from the latter focused run.
- DSH current SDK regression: a five-session, seven-prompt smoke passes after the shared CLI hook changes.
- Root A2A and gateway tests pass. A2A coverage is 98.54% lines, 90.9% branches and 100% functions; gateway coverage is 100% lines/functions and 98.02% branches. Node process-host tests: 35 passing.
- Paired-host and controller tests: 380 passing tests across five suites. Companion contract generation and freshness checks pass (693 commands, 101 routes).
- Semantic TypeScript diagnostics for 19 affected production/smoke files pass in the full project context; focused ESLint and diff checks pass.
- Native focused checks pass for exact Pi environment-key propagation and omission of credentials from public process metadata.

These are real installed agent processes against a local model fixture, not paid-provider or public-network certification. The process sandbox was an explicitly injected test seam; production still uses the mandatory launcher. Full repository coverage/typecheck and the full Tauri crate were already blocked by unrelated concurrent changes (recording tests/heap limits and existing Rust compilation errors). No full-repository clean claim is made.

## Primary sources

- [Pi current extension contract](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)
- [Pi current model configuration](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/models.md)
- [OpenCode V2 provider configuration](https://opencode.ai/v2/docs/providers/)
- [OpenCode V2 MCP configuration](https://opencode.ai/v2/docs/mcp-servers/)
- [A2A current specification](https://a2a-protocol.org/latest/specification/)

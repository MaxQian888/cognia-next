# External Agent SDK benchmark and Cognia closure record (2026-08-11)

> This document supersedes the 2026-08-05 analysis. That version identified the
> wrong Pi project, compared internal Cognia source capabilities with public SDK
> surfaces, and therefore overstated parity. The benchmark below uses public,
> primary documentation and checks the external `@cognia/agent` contract rather
> than treating an internal equivalent as shipped SDK functionality.

## Scope and decision

The benchmark covers the Pi coding-agent SDK/RPC, OpenAI Agents SDK, Claude
Agent SDK, Vercel AI SDK agents, LangGraph persistence/interrupts, and Pydantic
AI durable/deferred execution. These projects do not expose one identical API;
the comparison is the mature behavioral baseline that an external agent SDK is
expected to cover.

Cognia's chosen boundary is RPC-first:

- `@cognia/agent` is a dependency-light Node client and typed protocol;
- `cognia-agent rpc` is the local host and the sole owner of credentials,
  runtimes, persistence, permissions, sandboxing, plugins, and model calls;
- the SDK does not add a fourth execution rail or claim Pi wire compatibility;
- unsupported behavior returns a typed error and is never represented by a
  success-shaped stub.

## Mature baseline comparison

| Capability            | External baseline                                                            | Cognia public result                                                                                                                           |
| --------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Installable client    | Published packages with declarations and documented runtime support          | Standalone ESM/CJS package, declarations, source maps, Node `>=20.19`, clean tarball consumer test                                             |
| Runtime lifecycle     | Explicit initialization, version negotiation, health, cancellation, disposal | Protocol v2 `initialize`/`initialized`/`shutdown`, method and capability catalogs, runtime health, abort propagation                           |
| Streaming             | Typed event streams with cancellation and backpressure                       | Canonical envelope replay plus live notifications, `eventId` dedupe, frame and outbound-buffer limits                                          |
| Multi-turn sessions   | Create/resume/list and a durable conversation identity                       | Create/open/list/state/messages/entries/close/delete on the canonical store with a durable provider-session lease                              |
| Branching/portability | Forking or checkpoint-derived branches; export where available               | Fork, clone, tree, canonical export/import, digest validation, and explicit rejection of lossy imports                                         |
| Model controls        | Model and reasoning configuration, live controls when supported              | Model, thinking level, permission mode, steer, follow-up, wait, and abort routed to real control authorities                                   |
| Compaction            | Explicit/automatic compaction; some runtimes retain recovery state           | Real sidecar boundary capture; an undo token is returned only for a real pre-compaction snapshot; live single-use restore                      |
| Tools                 | Typed tool schemas and application callbacks                                 | Bidirectional client tool registration/invocation with stable invocation and idempotency identities                                            |
| Hooks/guardrails      | Lifecycle hooks, input/output guardrails, fail-open/fail-closed policies     | Reverse-RPC hook registration through the existing plugin runtime; callback failures are typed and policy-controlled                           |
| MCP                   | Host-managed MCP tools/resources and dynamic server configuration            | Secret-free server configuration and status; host retains transport and credential ownership                                                   |
| HITL                  | Serializable approvals, interruptions, deferred tool results                 | Durable permission, `ask_user` elicitation, and external-tool records with explicit settlement methods                                         |
| Crash recovery        | Checkpoints or durable runs; explicit replay semantics                       | Append-only canonical log, persisted command receipts and pending actions, `recovery_required`, no automatic replay of unknown side effects    |
| Idempotency           | Stable run/tool identities and retry-aware execution                         | Caller `commandId`, stable callback idempotency keys, bounded persisted receipts, at-least-once event delivery                                 |
| Sandbox               | Tool policy or execution sandbox configured outside prompts                  | Effective `SandboxResourcePolicy` status/snapshot/restore; no false claim that a policy snapshot captures workspace files                      |
| Observability         | Traces, lifecycle events, usage, and export hooks                            | Payload-free rotating audit JSONL, redacted trace subscription/export, canonical usage and lifecycle events                                    |
| Distribution          | Versioned runtime packages or a separately installed host                    | Version-matched optional host packages for Darwin arm64, Linux x64, and Windows x64; explicit path and `PATH` fallbacks; no runtime downloader |

## Complete gap inventory and closure

| Previously verified gap                                                  | Closure in the RPC-first implementation                                                                             | Evidence                                                            |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Package could not independently build or emit valid declarations         | Removed app aliases/runtime imports; `tsup` emits both module formats, declarations, maps, and `./protocol`         | `packages/agent/tsup.config.ts`, packed-consumer smoke              |
| RPC export and package files disagreed                                   | Replaced the prototype server export with two real public entry points                                              | `packages/agent/package.json` export map                            |
| SDK directly embedded Cognia runtime and credential logic                | Client now discovers/spawns or connects to a host; provider secrets never enter the SDK                             | `packages/agent/src/host.ts`, `client.ts`                           |
| Protocol advertised successful no-ops                                    | Protocol v2 has one Valibot schema map; server delegates only advertised service methods                            | `packages/agent/src/rpc/protocol.ts`, `cli/src/agent/rpc/server.ts` |
| No negotiation or version-skew failure                                   | Host selects v2 and returns versions, methods, capabilities, limits, and instance identity                          | client/server negotiation tests                                     |
| No full lifecycle or graceful shutdown                                   | Added public lifecycle catalog and real service/readline/process teardown                                           | real subprocess smoke                                               |
| `steer` discarded input                                                  | Routed to live session control and returns a deduplicated command receipt                                           | runtime-service tests                                               |
| Model/thinking/permission controls returned placeholders                 | Wired to session config, cache invalidation, and live provider controls                                             | runtime-service and provider-lease tests                            |
| Compaction returned a fabricated token; undo was absent                  | Waits for the real sidecar boundary, captures `pre_messages`, and restores through the existing PII-gated authority | compaction/undo runtime-service test                                |
| Session open/list/branch/import/export/delete were incomplete            | All route through canonical store APIs and single-writer leases                                                     | session-store and runtime-service tests                             |
| No replay cursor or live stream dedupe                                   | `session/entries` pages by opaque `afterEventId`; the client deduplicates notifications                             | protocol/client tests                                               |
| Pending permissions were process-local                                   | Persist-before-expose state and restart recovery with explicit settlement                                           | durable-state and runtime-service tests                             |
| `ask_user` could not cross the process boundary                          | Intercepted as durable elicitation and resumed through `elicitation/respond`                                        | runtime-service elicitation test                                    |
| External client tools/hooks were unavailable                             | Reverse JSON-RPC callbacks, registration rollback, bounded timeout/cancellation, stable identities                  | client/peer/runtime-service tests                                   |
| MCP configuration required an active turn                                | Validated configuration is stored, applied to live sessions, and injected into future turns                         | runtime-service tests                                               |
| Sandbox and tracing APIs were placeholders                               | Real policy snapshot/restore, redacted trace stream/export, and rotating audit query                                | sandbox and observability tests                                     |
| Host executable distribution was unspecified                             | Added three gated optional packages and a packaging script that copies certified native CLI output                  | platform-package tests                                              |
| No clean consumer or process-boundary proof                              | Added packed-tarball install checks and a subprocess handshake/crash-recovery/shutdown smoke                        | `pack-test.mjs`, `agent-sdk-rpc.mjs`                                |
| Public docs described internal behavior instead of the external contract | Added bilingual Agent SDK subsystem documentation and a package README                                              | `docs/content/docs/{en,zh}/subsystems/agent-sdk`                    |

## Recovery and honesty boundaries

The implementation intentionally follows the conservative semantics shared by
mature durable-agent systems:

- events are at least once, not exactly once;
- a stable receipt prevents a duplicate SDK command from reapplying its local
  mutation, but Cognia does not claim global exactly-once external side effects;
- unresolved permissions, elicitations, and external tool calls block the next
  turn as `recovery_required` until explicitly settled;
- non-idempotent external work is not automatically retried after an unknown
  transport outcome;
- compaction undo is available only while the provider session and captured
  snapshot remain live; restart never manufactures an undo token;
- sandbox snapshots restore resource policy, not arbitrary filesystem state;
- targeted plugin/skill reload may return `unsupported_capability` when the
  underlying runtime cannot reload one item safely.

These are contract boundaries, not hidden gaps.

## Deliberate non-goals

- Browser/Edge or in-process runtime execution.
- A Pi-compatible API or RPC dialect.
- A hosted Cognia Agent service or realtime voice transport.
- Raw provider-request mutation hooks or inline provider secrets.
- A second workflow/DAG engine inside the Agent SDK.
- Automatic re-execution of unknown non-idempotent side effects.

## Verification status

Local verification covers focused SDK/host/store/runtime tests, standalone
package typechecking, ESM/CJS/declaration pack installation, CLI bundling,
native external-agent launcher compilation, bilingual docs build, and a real
subprocess kill/restart test. Release certification must still run the same
artifact checks on the declared Node version matrix and all three target OS/CPU
CI runners; local macOS verification is not evidence for Linux or Windows
artifacts.

## Primary sources (retrieved 2026-08-11)

- Pi SDK and RPC: <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md>, <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md>
- OpenAI Agents SDK TypeScript and HITL: <https://openai.github.io/openai-agents-js/>, <https://openai.github.io/openai-agents-js/guides/human-in-the-loop/>
- Claude Agent SDK: <https://code.claude.com/docs/en/agent-sdk/overview>, <https://code.claude.com/docs/en/agent-sdk/typescript>
- Vercel AI SDK ToolLoopAgent: <https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent>
- LangGraph persistence and interrupts: <https://docs.langchain.com/oss/javascript/langgraph/persistence>, <https://docs.langchain.com/oss/javascript/langgraph/interrupts>
- Pydantic AI durable execution and deferred tools: <https://pydantic.dev/docs/ai/capabilities/durable_execution/overview/>, <https://pydantic.dev/docs/ai/tools-toolsets/deferred-tools/>

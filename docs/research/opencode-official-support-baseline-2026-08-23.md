# OpenCode support: official contract baseline and Cognia gap assessment

Date: 2026-08-23  
Status: Primary-source research  
Scope: OpenCode stable HTTP/SSE and ACP integration, plus the separately evolving V2 preview. This note compares those contracts with Cognia's current adapter shape but does not change implementation.

## Executive decision

OpenCode should be treated as three distinct integration rails, not one versioned API:

1. **ACP subprocess** is the preferred standardized execution rail. `opencode acp` exposes NDJSON JSON-RPC over stdio, negotiates capabilities at initialization, and covers session creation/loading/resume/fork/close, streaming text/reasoning/tool updates, permissions, model/effort/mode selection, image and embedded-context prompt inputs, and session-scoped MCP registration.
2. **Stable native HTTP/SSE** is the OpenCode-specific full-fidelity rail. It exposes the broadest session, provider, authentication, permission, question, file, MCP, and management surfaces through an OpenAPI-described server and generated SDK.
3. **V2 preview must remain explicitly experimental.** It is developed on a separate `v2` branch and shipped through the `opencode2` CLI/beta channel. Its service discovery, version contract, prompt schema, event replay, lifecycle, and MCP API have materially changed since Cognia's pinned preview client.

The current stable baseline is OpenCode `v1.18.21`, released on 2026-08-21. The current official V2 source inspected for this report is commit [`1def4aa35afe8fe96343ea5976930cda7d381041`](https://github.com/anomalyco/opencode/commit/1def4aa35afe8fe96343ea5976930cda7d381041) from 2026-08-23. Sources: [stable release](https://github.com/anomalyco/opencode/releases/tag/v1.18.21), [stable package manifest](https://github.com/anomalyco/opencode/blob/v1.18.21/packages/opencode/package.json), [V2 CLI manifest](https://github.com/anomalyco/opencode/blob/1def4aa35afe8fe96343ea5976930cda7d381041/packages/cli/package.json), and [official beta build script](https://github.com/anomalyco/opencode/blob/v1.18.21/script/beta.ts).

## 1. Integration surface matrix

| Dimension                | Stable HTTP/SSE                                                                                               | ACP subprocess                                                                              | Current V2 preview                                                                                                    | Cognia consequence                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Transport                | HTTP plus project-scoped `/event` and global `/global/event` SSE                                              | NDJSON JSON-RPC over stdin/stdout                                                           | Authenticated local service plus HTTP/SSE; durable session log is experimental                                        | Keep separate adapters and conformance fixtures. Do not infer protocol from the preset name alone. |
| Capability/version probe | `/global/health` returns `healthy` and `version`; `/doc` exposes OpenAPI 3.1                                  | `initialize` returns protocol, agent info, and capabilities                                 | `/api/health` returns version and PID; official service discovery validates registration, PID, version, and channel   | Probe endpoint shape and negotiated capabilities. Avoid major-version regexes.                     |
| Session lifecycle        | Create/get/list/update/delete, children, status, fork, abort, share, diff, summarize, revert, message history | New/load/list/resume/close/fork; close and cancel abort but do not delete persisted history | Import/export/remove, fork at boundary, model/agent switching, inbox, wait, compact, interrupt, background operations | Preserve close, cancel, delete, and fork as distinct domain actions.                               |
| Streaming/completion     | Direct SSE event union; status is `busy`, `retry`, or `idle`                                                  | ACP updates derived from stable events; prompt returns after idle                           | Global live SSE plus experimental durable per-session log; `session.wait` is the completion primitive                 | Never treat a single step-end as turn completion. Reconcile state after stable SSE reconnect.      |
| Models/providers         | Dynamic provider/model catalog, auth methods, per-prompt model override, global config                        | Per-session model, effort/variant, and mode configuration options                           | Explicit session model and agent switching                                                                            | Do not present a global config mutation as a session-local change.                                 |
| Tools/permissions        | OpenCode permission rules and `once`/`always`/`reject`; question events available natively                    | Tool updates and permission requests; no current `question.asked` bridge found              | Permission/question/session-next event families continue to evolve                                                    | Map native semantics honestly; do not reuse Claude permission-mode labels as equivalents.          |
| Attachments              | File parts plus model input capability metadata for text/audio/image/video/PDF                                | Advertises image and embedded context; converts ACP resources into OpenCode parts           | Prompt accepts `files`; current server materializes data/file URIs under preview-specific constraints                 | Gate transport support by the selected model's modalities. ACP does not advertise audio/video.     |
| MCP                      | Local/remote, connect/disconnect/status, HTTP/SSE, headers, OAuth                                             | Session registration of local/remote MCP servers                                            | First-class list/add/remove/connect/disconnect/resource API now exists                                                | Cognia's V2 `mcp: unsupported` declaration is stale against current source.                        |
| Authentication           | Server Basic auth; provider credentials/OAuth; MCP OAuth are separate stores/flows                            | Advertises an external `opencode auth login` method; does not return provider tokens        | Private service password in a mode-0600 registration file; Basic auth username `opencode`                             | Keep server, provider, and MCP authentication separate and never log secrets.                      |
| Errors                   | Structured assistant/provider/API errors plus HTTP errors                                                     | JSON-RPC invalid params/method/auth/internal errors and prompt stop reasons                 | Typed public HTTP errors were expanded during the preview                                                             | Preserve structured errors and unknown future variants rather than flattening to text.             |

Sources: [Server docs](https://opencode.ai/docs/server/), [SDK docs](https://opencode.ai/docs/sdk/), [ACP docs](https://opencode.ai/docs/acp/), [stable generated types](https://github.com/anomalyco/opencode/blob/v1.18.21/packages/sdk/js/src/v2/gen/types.gen.ts), [V2 session protocol](https://github.com/anomalyco/opencode/blob/1def4aa35afe8fe96343ea5976930cda7d381041/packages/protocol/src/groups/session.ts), and [V2 MCP protocol](https://github.com/anomalyco/opencode/blob/1def4aa35afe8fe96343ea5976930cda7d381041/packages/protocol/src/groups/mcp.ts).

## 2. Stable native server contract

### 2.1 Process, discovery, and authentication

`opencode serve` starts the stable HTTP server. Its documented defaults are `127.0.0.1:4096`, mDNS disabled, and no cross-origin access unless origins are explicitly added. `OPENCODE_SERVER_PASSWORD` enables HTTP Basic authentication; the username defaults to `opencode` and can be changed with `OPENCODE_SERVER_USERNAME`. The OpenAPI 3.1 document is available at `/doc`. Source: [Server docs](https://opencode.ai/docs/server/).

The stable SDK supports both `createOpencode()`, which launches a server and returns a client, and `createOpencodeClient()`, which connects to an existing server. Launch options include host, port, abort signal, timeout, and merged OpenCode configuration. The generated client should remain the source of endpoint and error shapes because the official permission routes have already drifted from older prose examples. Sources: [SDK docs](https://opencode.ai/docs/sdk/), [current permission routes](https://github.com/anomalyco/opencode/blob/v1.18.21/packages/opencode/src/server/routes/instance/httpapi/groups/permission.ts), and [generated SDK](https://github.com/anomalyco/opencode/blob/v1.18.21/packages/sdk/js/src/v2/gen/sdk.gen.ts).

Capability probing should begin with `GET /global/health`, whose response includes `{ healthy: true, version }`, then use the live `/doc` or the SDK generated for that runtime. OpenCode's own app probes `/global/health` first and `/api/health` second, using the response shape to distinguish stable from V2 rather than relying on a preset or semver major. Source: [OpenCode server-protocol detector](https://github.com/anomalyco/opencode/blob/v1.18.21/packages/app/src/utils/server-protocol.ts).

### 2.2 Session lifecycle and prompt admission

The stable server exposes session create/list/status/get/delete/update, children, todos, initialization, fork, abort, share/unshare, diff, summarize, revert/unrevert, synchronous prompt, asynchronous prompt, command, and shell operations. A host should model deletion separately from aborting an active turn and separately from closing a local view. Source: [Server API reference](https://opencode.ai/docs/server/).

The asynchronous prompt endpoint is the safer streaming admission primitive, but SSE does not provide a durable replay cursor. The host should subscribe before admission, persist the admitted session/message identifiers, and after disconnection reconcile via session status and message history. It must not automatically resend a prompt solely because SSE failed: the server may already have admitted it. The need for this ordering is reinforced by the official `v1.15.5` fix for missed `/event` updates caused by a subscription race. Sources: [Server API reference](https://opencode.ai/docs/server/) and [v1.15.5 release](https://github.com/anomalyco/opencode/releases/tag/v1.15.5).

### 2.3 Event model and completion

`/event` is scoped to the selected directory/project and emits direct `{ type, properties }` events. `/global/event` covers all instances and uses a global envelope. The server sends `server.connected` first and heartbeats while the connection is alive. Stable event families include session create/update/delete/status/error/diff/compaction, message and part create/update/remove/delta, permission requests/replies, question requests/replies/rejections, todos, file edits, PTY updates, and MCP changes/failures. Sources: [Server docs](https://opencode.ai/docs/server/), [project event handler](https://github.com/anomalyco/opencode/blob/v1.18.21/packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts), [global event handler](https://github.com/anomalyco/opencode/blob/v1.18.21/packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts), and [generated event union](https://github.com/anomalyco/opencode/blob/v1.18.21/packages/sdk/js/src/v2/gen/types.gen.ts).

Session completion should be keyed to `session.status: idle`. The legacy `session.idle` event is deprecated. `retry` is a first-class nonterminal state and contains retry timing/reason information; clients must not collapse it into either success or generic failure. Sources: [session event schema](https://github.com/anomalyco/opencode/blob/v1.18.21/packages/schema/src/v1/session.ts) and [session-status schema](https://github.com/anomalyco/opencode/blob/v1.18.21/packages/schema/src/session-status-event.ts).

### 2.4 Providers, models, and authentication

OpenCode model identifiers use `provider/model`. Providers and models are dynamically discoverable, and a prompt can select `{ providerID, modelID }` for that turn. Configuration also exposes default and small models, provider options, authentication methods, OAuth authorization/callback, and credential setting. Custom OpenAI-compatible providers can declare an npm adapter, base URL, API key, headers, models, and model limits. Sources: [Provider docs](https://opencode.ai/docs/providers/), [Models docs](https://opencode.ai/docs/models/), [Config docs](https://opencode.ai/docs/config/), and [provider configuration schema](https://github.com/anomalyco/opencode/blob/v1.18.21/packages/core/src/v1/config/provider.ts).

Provider authentication is independent from server Basic auth and MCP OAuth. Credentials are normally established through `opencode auth login` or provider-specific environment variables and stored by OpenCode in its auth store. Cognia should not ask ACP to return tokens or merge these three authentication domains. Sources: [Provider docs](https://opencode.ai/docs/providers/), [Server docs](https://opencode.ai/docs/server/), and [MCP docs](https://opencode.ai/docs/mcp-servers/).

### 2.5 Tools and permissions

OpenCode permissions are ordered rules whose action is `allow`, `ask`, or `deny`; when multiple patterns match, the last matching rule wins. Interactive answers are `once`, `always`, and `reject`. Defaults are generally permissive, but access outside the project and doom-loop detection ask by default, while sensitive environment files have deny rules. Per-agent rules can override global rules. Source: [Permissions docs](https://opencode.ai/docs/permissions/).

`--auto` approves unresolved asks but does not override an explicit deny. It is therefore not equivalent to an unrestricted bypass mode. The legacy boolean `tools` configuration was deprecated in `v1.1.1` and is retained only for compatibility; new configuration should use `permission`. Sources: [Permissions docs](https://opencode.ai/docs/permissions/) and [prompt schema](https://github.com/anomalyco/opencode/blob/v1.18.21/packages/opencode/src/session/prompt.ts).

### 2.6 Attachments and model capability gates

The stable prompt file part is `{ type: "file", mime, filename?, url, source? }`. Separately, provider metadata describes input/output modalities including text, audio, image, video, and PDF. OpenCode transforms an unsupported modality into an explanatory error part rather than proving at transport time that the selected model can consume it. Cognia must therefore check both transport capability and selected-model modalities before advertising or sending an attachment. Sources: [stable file-part schema](https://github.com/anomalyco/opencode/blob/v1.18.21/packages/schema/src/v1/session.ts), [provider capability computation](https://github.com/anomalyco/opencode/blob/v1.18.21/packages/opencode/src/provider/provider.ts), and [unsupported-media transform](https://github.com/anomalyco/opencode/blob/v1.18.21/packages/opencode/src/provider/transform.ts).

### 2.7 MCP

Stable OpenCode supports local MCP processes and remote MCP servers. Local definitions include command, working directory, environment, enablement, and timeout. Remote definitions include URL, headers, enablement, OAuth, and timeout. Remote OAuth supports automatic discovery/registration plus explicit login, logout, list, and debug flows. MCP status distinguishes connected, disabled, failed, needs-auth, and needs-client-registration; tool names are namespaced by server and can be enabled or disabled globally or per agent. Sources: [MCP docs](https://opencode.ai/docs/mcp-servers/) and [stable MCP generated types](https://github.com/anomalyco/opencode/blob/v1.18.21/packages/sdk/js/src/v2/gen/types.gen.ts).

## 3. ACP subprocess contract

### 3.1 Initialization and lifecycle

`opencode acp` is an official entry point using ACP JSON-RPC over newline-delimited JSON on stdin/stdout. At `v1.18.21` it uses `@agentclientprotocol/sdk` `0.21.0`. The host must manage stdin EOF, stderr, exit code, cancellation, malformed messages, and abnormal process exit as transport failures rather than model errors. Sources: [ACP docs](https://opencode.ai/docs/acp/), [ACP CLI source](https://github.com/anomalyco/opencode/blob/v1.18.21/packages/opencode/src/cli/cmd/acp.ts), and [package manifest](https://github.com/anomalyco/opencode/blob/v1.18.21/packages/opencode/package.json).

`initialize` currently reports protocol version `1`, OpenCode agent name/version, session load/close/fork/list/resume support, MCP HTTP/SSE support, and prompt embedded-context/image support. Some ACP methods retain unstable names, so every spawned runtime must be capability-probed after initialization rather than selected only by OpenCode version. Source: [ACP service initialization](https://github.com/anomalyco/opencode/blob/v1.18.21/packages/opencode/src/acp/service.ts).

ACP `new` creates a persisted OpenCode session at a working directory. `load` loads history and replays the transcript; `resume` restores recent state without transcript replay; `fork` creates a distinct backing session and replays the forked transcript. `close` drops the live ACP state and aborts active work but does not delete the persisted session. `cancel` also aborts. These are intentionally different lifecycle operations. Source: [ACP session service](https://github.com/anomalyco/opencode/blob/v1.18.21/packages/opencode/src/acp/service.ts).

### 3.2 Streaming, tools, and completion

The ACP bridge subscribes to OpenCode's global event stream, maps text and reasoning deltas, file updates, tool pending/running/completed/error states, permission requests, usage, and cost into ACP updates, and completes a prompt when the backing session becomes idle. It reconnects the event stream after disconnect but rejects the current idle waiter; there is no durable replay cursor in this bridge. The host must surface that failure, reconcile persisted session state, and avoid blind prompt resubmission. Sources: [ACP event bridge](https://github.com/anomalyco/opencode/blob/v1.18.21/packages/opencode/src/acp/event.ts) and [ACP prompt lifecycle](https://github.com/anomalyco/opencode/blob/v1.18.21/packages/opencode/src/acp/service.ts).

The official bridge currently handles `session.status`, `permission.asked`, `message.part.updated`, and `message.part.delta`; it does not contain a `question.asked` branch. This is a source-based inference: Cognia should not claim that the interactive `question` tool is end-to-end supported over ACP without a conformance test. Use the native HTTP rail for that interaction or disable the tool for ACP sessions. Source: [ACP event bridge](https://github.com/anomalyco/opencode/blob/v1.18.21/packages/opencode/src/acp/event.ts).

The `v1.18.14` release is an important minimum-tested compatibility point because it fixed draining queued ACP updates before end-of-turn and corrected cache-write usage accounting. Supporting an older runtime may be possible, but Cognia should test it explicitly rather than assuming equivalent ordering. Source: [v1.18.14 release](https://github.com/anomalyco/opencode/releases/tag/v1.18.14).

### 3.3 Model, mode, permission, and attachment semantics

ACP exposes model, effort/variant, and mode as session configuration options. Provider/model and available variants are dynamically derived from the OpenCode instance. Prompt execution preserves the selected provider, model, variant, and agent mode. Sources: [ACP config options](https://github.com/anomalyco/opencode/blob/v1.18.21/packages/opencode/src/acp/config-option.ts) and [ACP service](https://github.com/anomalyco/opencode/blob/v1.18.21/packages/opencode/src/acp/service.ts).

ACP permission requests support `once`, `always`, and `reject`, include tool metadata and proposed locations/diffs, and fail closed when the client lacks the permission callback. Edit approval may delegate a proposed file write to the client. Permission interactions should have a host timeout because the bridge's event handler deliberately contains failures after rejecting the backing request. Source: [ACP permission bridge](https://github.com/anomalyco/opencode/blob/v1.18.21/packages/opencode/src/acp/permission.ts).

ACP advertises image and embedded-context prompt capabilities. It converts text, image, resource link, and embedded text/blob resource blocks into OpenCode parts; it does not advertise direct audio/video input. A generic ACP host should follow the negotiated capability and still apply the selected model's modality gate. Source: [ACP content conversion](https://github.com/anomalyco/opencode/blob/v1.18.21/packages/opencode/src/acp/content.ts).

### 3.4 MCP and authentication

ACP can register local and remote MCP servers per session, mapping local commands/arguments/environment and remote URL/headers. Registration errors are ignored inside the current bridge, so a successful session creation is not proof that MCP connected; the product should query and display MCP status separately. Sources: [ACP MCP registration](https://github.com/anomalyco/opencode/blob/v1.18.21/packages/opencode/src/acp/service.ts) and [MCP docs](https://opencode.ai/docs/mcp-servers/).

ACP advertises an `opencode-login` authentication method that instructs the user to run `opencode auth login`; `authenticate` validates the method but does not return provider credentials to the client. Cognia should present a terminal-login handoff and then retry discovery, not expect an OAuth token in the ACP response. Source: [ACP authentication implementation](https://github.com/anomalyco/opencode/blob/v1.18.21/packages/opencode/src/acp/service.ts).

### 3.5 Errors

ACP maps malformed or missing session/config/model/mode values to invalid params, unsupported operations to method-not-found, credential failures to auth-required, and unexpected defects to a sanitized internal error. Prompt stop reasons distinguish cancellation, maximum tokens, refusal/content filtering, authentication required, and generic failure. A host must handle both JSON-RPC transport/method errors and model/provider errors carried in assistant state. Sources: [ACP error mapping](https://github.com/anomalyco/opencode/blob/v1.18.21/packages/opencode/src/acp/error.ts) and [ACP prompt error mapping](https://github.com/anomalyco/opencode/blob/v1.18.21/packages/opencode/src/acp/service.ts).

## 4. V2 preview boundary and protocol drift

The official V2 documentation still describes the Effect-native `@opencode-ai/sdk@dev` as preview and says the general SDK is forthcoming. The branch is distributed through the `opencode2` binary even though its current manifest version is `1.18.4`, not `2.x`. Consequently, `/^2\./` is not a valid compatibility probe. Sources: [V2 SDK docs](https://opencode.ai/v2/docs/build/sdk), [V2 CLI manifest](https://github.com/anomalyco/opencode/blob/1def4aa35afe8fe96343ea5976930cda7d381041/packages/cli/package.json), and [V2 service configuration](https://github.com/anomalyco/opencode/blob/1def4aa35afe8fe96343ea5976930cda7d381041/packages/cli/src/services/service-config.ts).

The current V2 service writes a private registration containing URL, PID, version, and password, and protects it with mode `0600`. `/api/health` returns health, version, and PID. The official client validates the registration and health response, including process identity and build/channel compatibility. Cognia should either reuse that discovery contract or reproduce it exactly; accepting any reported major version is insufficient. Sources: [V2 service configuration](https://github.com/anomalyco/opencode/blob/1def4aa35afe8fe96343ea5976930cda7d381041/packages/cli/src/services/service-config.ts), [V2 client discovery](https://github.com/anomalyco/opencode/blob/1def4aa35afe8fe96343ea5976930cda7d381041/packages/client/src/effect/service.ts), and [V2 health handler](https://github.com/anomalyco/opencode/blob/1def4aa35afe8fe96343ea5976930cda7d381041/packages/server/src/handlers/health.ts).

Material changes since Cognia's pinned preview client include:

- The V2 HTTP prompt body is now flattened as `{ id?, text, files?, agents?, skills?, metadata?, delivery?, resume? }`, while Cognia's [`@opencode-ai/sdk` `1.18.18`](../../package.json) V2 client serializes the older nested `{ id?, prompt: { text, ... }, delivery?, resume? }` body. Sources: [current prompt-input schema](https://github.com/anomalyco/opencode/blob/1def4aa35afe8fe96343ea5976930cda7d381041/packages/schema/src/prompt-input.ts) and [current V2 session protocol](https://github.com/anomalyco/opencode/blob/1def4aa35afe8fe96343ea5976930cda7d381041/packages/protocol/src/groups/session.ts).
- The current source exposes an experimental durable session log at `/api/experimental/session/:id/log`, with an exclusive aggregate `after` sequence and follow mode. Cognia's pinned client still consumes the older session-events surface. Source: [current V2 session protocol](https://github.com/anomalyco/opencode/blob/1def4aa35afe8fe96343ea5976930cda7d381041/packages/protocol/src/groups/session.ts).
- A `session.next.step.ended` event marks one agent-loop step, not completion of an entire tool-using turn. The current protocol exposes `session.wait` to wait for loop idleness. Cognia currently terminates on the first step-end and can therefore truncate multi-step runs. Source: [current V2 session protocol](https://github.com/anomalyco/opencode/blob/1def4aa35afe8fe96343ea5976930cda7d381041/packages/protocol/src/groups/session.ts).
- V2 now exposes first-class MCP list/add-or-replace/remove/connect/disconnect and resource catalog operations, while Cognia declares V2 MCP unsupported. Source: [current V2 MCP protocol](https://github.com/anomalyco/opencode/blob/1def4aa35afe8fe96343ea5976930cda7d381041/packages/protocol/src/groups/mcp.ts).
- V2 prompt attachments use a preview-specific file list and materialization path, not the stable `FilePartInput` contract. Official preview docs currently constrain accepted source/format/size behavior. Source: [V2 attachments docs](https://opencode.ai/v2/docs/attachments) and [current prompt-input schema](https://github.com/anomalyco/opencode/blob/1def4aa35afe8fe96343ea5976930cda7d381041/packages/schema/src/prompt-input.ts).
- Current V2 sessions expose substantially more lifecycle operations, including import/export, removal, bounded fork, explicit model/agent switching, prompt/command/skill/shell actions, compact, wait, interrupt, inbox, instruction entries, and background work. A generated client pinned to an older branch is not forward-compatible merely because health succeeds. Source: [current V2 session protocol](https://github.com/anomalyco/opencode/blob/1def4aa35afe8fe96343ea5976930cda7d381041/packages/protocol/src/groups/session.ts).

The V2 global `/api/event` stream remains live/non-replayable, whereas the session log is durable but explicitly experimental. A preview adapter should persist the last accepted aggregate sequence, resume with `after`, deduplicate defensively, and use `session.wait` or equivalent active-session state for terminal completion. It must pin an exact preview build and regenerate the client/schema together. Sources: [V2 event handler](https://github.com/anomalyco/opencode/blob/1def4aa35afe8fe96343ea5976930cda7d381041/packages/server/src/handlers/event.ts) and [V2 session protocol](https://github.com/anomalyco/opencode/blob/1def4aa35afe8fe96343ea5976930cda7d381041/packages/protocol/src/groups/session.ts).

## 5. Cognia gap assessment

This assessment is based on Cognia's current [stable adapter](../../lib/ai/agent/external/opencode-client.ts), [V2 preview adapter](../../lib/ai/agent/external/opencode-v2-client.ts), [presets](../../lib/ai/agent/external/presets.ts), [permission-mode mapping](../../lib/ai/agent/external/permission-modes.ts), [application SDK dependency](../../package.json), and [sidecar preview pin](../../sidecar/package.json).

### P0: correctness and compatibility

1. **Replace name/semver inference with protocol detection.** Probe `/global/health` and `/api/health` by endpoint and response shape, record runtime version, and load only the adapter proven compatible. For ACP, always use `initialize` capabilities.
2. **Do not claim current V2 compatibility.** Cognia's preview sidecar is pinned to official commit `95636bd3caa7935eba3ae91ec92a81560c8520e1` and an older generated client, while the active V2 branch has incompatible prompt, log, completion, version, and MCP surfaces. Regenerate against an exact build and add recorded conformance fixtures before enabling it as supported.
3. **Fix V2 completion semantics.** A step end is not a turn end. Stream/replay through the durable log and use `session.wait` or active-session state to prove completion.
4. **Complete stable SSE recovery with reconciliation.** The current adapter already subscribes before async admission and correctly refuses to resend after `promptAsync` has been accepted. Retain that safeguard, then add session/message/status reconciliation after disconnect so recovery is more than a surfaced stream error.
5. **Represent permission semantics accurately.** OpenCode's native rules plus `once`/`always`/`reject` do not exactly implement Cognia's generic `default`, `acceptEdits`, `bypassPermissions`, and `plan` vocabulary. `plan` can select the plan agent; auto-approval still honors denies; `acceptEdits` has no exact native equivalent. Unsupported semantic mappings should be unavailable or explicitly qualified.
6. **Correct session-model semantics on stable HTTP.** The current stable adapter's `setSessionModel()` updates server configuration globally, while per-prompt model selection is genuinely local to a turn. Rename/gate the mutation or implement session-local selection through ACP/V2 rather than presenting a global write as session state.

### P1: feature completeness

1. Add a first-class OpenCode ACP preset backed by Cognia's generic ACP transport, including process/version display, `opencode auth login` handoff, capability-derived controls, and distinction between load/resume/close/delete.
2. Gate every attachment by both adapter transport and provider/model modality. Stable HTTP can express broad media file parts; ACP currently advertises only image and embedded context; V2 has its own preview file contract.
3. Surface MCP connection/auth states rather than treating registration as success. Update V2 feature declarations once its exact pinned protocol is chosen.
4. Preserve OpenCode's `retry`, permission, question, provider-auth, content-filter, context-overflow, abort, and structured API error variants. Unknown future events should be observable and nonfatal.
5. Expose native HTTP question handling only where end-to-end supported; do not advertise it through ACP until a real runtime conformance test passes.

### Existing strengths to retain

- The stable adapter subscribes before async prompt admission and already maps many session, message, tool, permission, question, usage, and file events.
- Stable prompt construction already supports per-turn provider/model selection and file parts.
- The stable SDK dependency is close to the current stable release, so its gap is primarily patch-level validation rather than a protocol generation mismatch.
- The V2 preset is visibly marked preview; keep that boundary until the compatibility work above is complete.

## 6. Required conformance suite

A supported OpenCode runtime should pass these black-box checks against the exact binary Cognia launches or connects to:

1. Probe stable, V2, wrong-password, stale-registration, incompatible-version, and non-OpenCode endpoints without mutating server state.
2. Create, list, load/resume, fork, cancel/abort, close, and delete sessions; verify that each operation has the documented persistence effect.
3. Start streaming before prompt admission, run a text-only turn, then a multi-tool/multi-step turn, and prove terminal idle without truncation.
4. Drop SSE mid-turn, reconnect, reconcile/replay, and verify no duplicate prompt or duplicate event reaches product state.
5. Exercise text, image, PDF, and one unsupported modality against models with different advertised capabilities.
6. Switch model/provider/variant/mode and prove the scope of each change: prompt, session, or global config.
7. Exercise permission allow-once, always, reject, explicit deny under auto, external-directory ask, and a missing ACP permission callback.
8. Exercise provider auth required, server Basic auth, MCP OAuth required, MCP registration failure, and MCP reconnect as separate states.
9. Verify native question flow and verify ACP either handles or explicitly disables it.
10. Inject unknown event variants, structured provider errors, content filtering, context overflow, retry, cancellation, abrupt process exit, malformed NDJSON, and HTTP/SSE disconnect.
11. For V2, persist an aggregate log sequence, reconnect with `after`, deduplicate events, and prove `session.wait` completes only after the whole loop.
12. Capture `/doc`, initialization capabilities, CLI version, and the generated SDK/schema checksum as test artifacts for every supported runtime matrix entry.

## 7. Recent compatibility signals

| Release/date                                                                                                                                                  | Official change                                                                   | Integration meaning                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [`v1.15.5`](https://github.com/anomalyco/opencode/releases/tag/v1.15.5), 2026-05-23                                                                           | Reduced missed `/event` updates caused by subscription race                       | Subscribe before prompt admission and still reconcile after disconnect. |
| [`v1.15.12`](https://github.com/anomalyco/opencode/releases/tag/v1.15.12), 2026-05-28                                                                         | Introduced the new ACP preview                                                    | Older ACP drafts are not a safe contract baseline.                      |
| [`v1.16.0`](https://github.com/anomalyco/opencode/releases/tag/v1.16.0), 2026-06-05                                                                           | Restored full transcript replay and made cancel abort work                        | Test load/replay and cancel on the chosen minimum version.              |
| [`v1.18.5`](https://github.com/anomalyco/opencode/releases/tag/v1.18.5), 2026-07-24                                                                           | Added current/legacy server detection and event/action gating in the official app | Stable and V2 protocols intentionally coexist.                          |
| [`v1.18.8`](https://github.com/anomalyco/opencode/releases/tag/v1.18.8) / [`v1.18.9`](https://github.com/anomalyco/opencode/releases/tag/v1.18.9), 2026-07-28 | Updated MCP/OAuth SDK, then restored older MCP SDK-client compatibility           | MCP behavior needs runtime tests across pins.                           |
| [`v1.18.12`](https://github.com/anomalyco/opencode/releases/tag/v1.18.12), 2026-08-01                                                                         | Official app skipped legacy config reads for V2                                   | Do not call stable config endpoints after detecting V2.                 |
| [`v1.18.14`](https://github.com/anomalyco/opencode/releases/tag/v1.18.14), 2026-08-05                                                                         | Drained queued ACP updates before ending a turn and corrected cache usage         | Recommended minimum ACP regression target.                              |
| [`v1.18.15`](https://github.com/anomalyco/opencode/releases/tag/v1.18.15), 2026-08-07                                                                         | Fixed attachment blob handling                                                    | Include blob/data attachment regression coverage.                       |
| [`v1.18.17`](https://github.com/anomalyco/opencode/releases/tag/v1.18.17), 2026-08-09                                                                         | Changed PDF attachment handling based on model support                            | Model capability checks are part of attachment correctness.             |
| [`v1.18.21`](https://github.com/anomalyco/opencode/releases/tag/v1.18.21), 2026-08-21                                                                         | Continued after unknown model finish reasons                                      | Preserve unknown finish reasons without prematurely terminating.        |

## Primary sources

### Stable documentation and release

- [OpenCode `v1.18.21`](https://github.com/anomalyco/opencode/releases/tag/v1.18.21)
- [Server](https://opencode.ai/docs/server/)
- [SDK](https://opencode.ai/docs/sdk/)
- [ACP](https://opencode.ai/docs/acp/)
- [CLI](https://opencode.ai/docs/cli/)
- [Providers](https://opencode.ai/docs/providers/)
- [Models](https://opencode.ai/docs/models/)
- [Configuration](https://opencode.ai/docs/config/)
- [Permissions](https://opencode.ai/docs/permissions/)
- [MCP servers](https://opencode.ai/docs/mcp-servers/)

### Version-pinned stable source

- [ACP service](https://github.com/anomalyco/opencode/blob/v1.18.21/packages/opencode/src/acp/service.ts)
- [ACP event bridge](https://github.com/anomalyco/opencode/blob/v1.18.21/packages/opencode/src/acp/event.ts)
- [ACP content conversion](https://github.com/anomalyco/opencode/blob/v1.18.21/packages/opencode/src/acp/content.ts)
- [ACP permission bridge](https://github.com/anomalyco/opencode/blob/v1.18.21/packages/opencode/src/acp/permission.ts)
- [ACP error mapping](https://github.com/anomalyco/opencode/blob/v1.18.21/packages/opencode/src/acp/error.ts)
- [Generated stable SDK types](https://github.com/anomalyco/opencode/blob/v1.18.21/packages/sdk/js/src/v2/gen/types.gen.ts)
- [Stable server protocol detector](https://github.com/anomalyco/opencode/blob/v1.18.21/packages/app/src/utils/server-protocol.ts)

### Version-pinned V2 preview source

- [V2 CLI manifest](https://github.com/anomalyco/opencode/blob/1def4aa35afe8fe96343ea5976930cda7d381041/packages/cli/package.json)
- [V2 service discovery](https://github.com/anomalyco/opencode/blob/1def4aa35afe8fe96343ea5976930cda7d381041/packages/client/src/effect/service.ts)
- [V2 session protocol](https://github.com/anomalyco/opencode/blob/1def4aa35afe8fe96343ea5976930cda7d381041/packages/protocol/src/groups/session.ts)
- [V2 prompt schema](https://github.com/anomalyco/opencode/blob/1def4aa35afe8fe96343ea5976930cda7d381041/packages/schema/src/prompt-input.ts)
- [V2 event handler](https://github.com/anomalyco/opencode/blob/1def4aa35afe8fe96343ea5976930cda7d381041/packages/server/src/handlers/event.ts)
- [V2 MCP protocol](https://github.com/anomalyco/opencode/blob/1def4aa35afe8fe96343ea5976930cda7d381041/packages/protocol/src/groups/mcp.ts)

# Claude Agent SDK and Codex App Server: official contract baseline

Date: 2026-08-23  
Status: Primary-source research  
Scope: Current official capabilities and compatibility constraints for Anthropic Claude Agent SDK and OpenAI Codex App Server. This note does not audit Cognia's implementation; it defines the external baseline against which that implementation should be checked.

## Source and version baseline

Only first-party documentation, repositories, schemas, and release notes are used.

- Anthropic renamed **Claude Code SDK** to **Claude Agent SDK**. The supported packages are `@anthropic-ai/claude-agent-sdk` for TypeScript and `claude-agent-sdk` for Python. Both bundle a Claude Code binary for normal installs. Sources: [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview), [agent loop](https://code.claude.com/docs/en/agent-sdk/agent-loop), [TypeScript repository](https://github.com/anthropics/claude-agent-sdk-typescript), and [Python repository](https://github.com/anthropics/claude-agent-sdk-python).
- At the research cutoff, the current first-party sources report TypeScript SDK `0.3.241`, in parity with Claude Code `2.1.241`, and Python SDK `0.2.143`. Sources: [TypeScript changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md) and [Python `pyproject.toml`](https://github.com/anthropics/claude-agent-sdk-python/blob/main/pyproject.toml).
- The latest stable OpenAI Codex release visible at the cutoff is `0.149.0` from 2026-08-20; `0.150.0-alpha.*` prereleases also exist. Sources: [Codex `0.149.0` release](https://github.com/openai/codex/releases/tag/rust-v0.149.0) and [Codex releases](https://github.com/openai/codex/releases).
- Codex App Server schemas are explicitly binary-version-specific. A client should generate TypeScript or JSON Schema from the exact `codex` binary it embeds or launches, not copy a schema from `main`. Source: [Codex App Server, Message schema](https://learn.chatgpt.com/docs/app-server#message-schema).

## Executive comparison

| Dimension           | Claude Agent SDK                                                                                       | Codex App Server                                                                                          | Integration consequence                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Product boundary    | A TypeScript/Python library that launches the bundled Claude Code runtime and exposes an agent loop    | A long-running Codex host protocol for rich clients                                                       | They are not interchangeable adapters. Claude exposes language APIs; Codex exposes a bidirectional client/server protocol. |
| Primary entry point | `query()` async stream; Python also exposes stateful `ClaudeSDKClient`                                 | JSON-RPC-like requests, responses, notifications, and server requests over stdio/WebSocket/Unix socket    | A shared Cognia facade needs separate transport/lifecycle implementations.                                                 |
| Conversation model  | Session plus model/tool turns hidden behind the agent loop                                             | Explicit `Thread -> Turn -> Item` primitives                                                              | Normalize at the product-domain level, not by pretending message envelopes are identical.                                  |
| Version contract    | SDK release tracks a bundled Claude Code version; TypeScript and Python do not have identical features | Exact generated schema per Codex binary; stable and experimental surfaces are separated at initialization | Pin and test every bundled runtime upgrade. Do not use loose feature detection from package names alone.                   |
| Custom tools        | In-process SDK MCP servers plus external stdio/SSE/HTTP MCP                                            | Experimental client-hosted `dynamicTools`, direct MCP calls, configured MCP servers, apps/plugins         | Tool-result and approval routing require provider-specific handling.                                                       |

## 1. Claude Agent SDK official surface

### 1.1 Execution and message lifecycle

`query()` is the primary API. It returns an asynchronous stream while the bundled Claude Code loop evaluates the prompt, emits assistant content and tool requests, executes tools, feeds results back, and repeats until a text-only final response. The terminal sequence is a final `AssistantMessage` followed by `ResultMessage`, which carries the result, usage, cost, and session ID. Consumers should continue iterating after `ResultMessage` because a small number of trailing system events can follow it. Source: [How the agent loop works](https://code.claude.com/docs/en/agent-sdk/agent-loop).

Core message families are:

- `SystemMessage`, including initialization, compaction boundaries, informational status, and worker shutdown;
- `AssistantMessage`, containing text and tool-use blocks;
- `UserMessage`, commonly carrying tool results back into the loop;
- `ResultMessage`, including success/error subtype, result, usage, cost, and session ID;
- optional raw `StreamEvent` / TypeScript `SDKPartialAssistantMessage` events when partial-message streaming is enabled.

Source: [Agent loop message types](https://code.claude.com/docs/en/agent-sdk/agent-loop#message-types).

Python's `ClaudeSDKClient` is the stateful, bidirectional interface for interactive multi-turn conversations and runtime controls such as changing permission mode. The convenience `query()` API remains the recommended one-shot or streamed entry point. Source: [Python Agent SDK reference](https://code.claude.com/docs/en/agent-sdk/python).

Unlike Codex App Server, Anthropic does not present the SDK's CLI subprocess/control framing as an independent, stable integration protocol. The supported client contracts are the published TypeScript/Python APIs and their typed message unions; the bundled CLI/control-message parity changes with SDK releases. A Cognia adapter should therefore depend on the SDK package rather than treating observed subprocess JSON as a version-independent wire standard. Sources: [TypeScript SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md), [Python public types](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/types.py), and [Python SDK internal transport](https://github.com/anthropics/claude-agent-sdk-python/tree/main/src/claude_agent_sdk/_internal).

### 1.2 Sessions, resume, and fork

The SDK persists session conversation history automatically. Sessions contain prompts, tool calls, tool results, and responses; they do **not** snapshot the filesystem. Resume therefore restores model-visible history, not project files. Capture `session_id` from the result (or TypeScript init message), then pass `resume` to continue or combine resume with forking to branch. Source: [Work with sessions](https://code.claude.com/docs/en/agent-sdk/sessions).

Current session-related contract details include:

- `resume` continues an existing session; session forking creates a new session without mutating the source;
- `SessionStart` distinguishes `source: "fork"` from `source: "resume"`;
- truncated resume is guarded by `resumeSessionAt` plus the explicit `resumeDropsTurn` safety declaration;
- restored sessions recover background-agent, workflow, and MCP task state in recent releases;
- the experimental TypeScript V2 session API (`createSession()` / `send` / `stream`, formerly `unstable_v2_*` and `SDKSession`) was removed in `0.3.142`; use `query()` and `resume`.

Sources: [Work with sessions](https://code.claude.com/docs/en/agent-sdk/sessions) and [TypeScript changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md).

### 1.3 Tools, MCP, and hooks

Claude Code's built-in tools are present through the SDK. `allowedTools` / `allowed_tools` is an **auto-approval allowlist**, not a tool-availability boundary. To remove or block tools, use deny rules / `disallowedTools`, permission mode, hooks, or `canUseTool`. Source: [Configure permissions](https://code.claude.com/docs/en/agent-sdk/permissions).

MCP support covers:

- local stdio servers;
- remote SSE and streamable HTTP servers;
- in-process SDK MCP servers for application-defined tools;
- MCP tool search, enabled by default to avoid injecting every tool definition into context;
- MCP authentication via environment variables, headers, and OAuth flows.

Source: [Connect to external tools with MCP](https://code.claude.com/docs/en/agent-sdk/mcp).

The Python in-process MCP bridge has documented limits in its current public type source: server-to-client sampling, elicitation, roots, logging, and progress are not forwarded yet; under MCP 1.x, abandoned calls are not cancelled and may run to completion. MCP connection status is typed as `connected`, `failed`, `needs-auth`, `pending`, or `disabled`, with server info and tool metadata when available. Source: [Python SDK MCP types](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/types.py#L859-L983).

Hooks are deterministic host callbacks, not model decisions. The shared Python/TypeScript events include `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `UserPromptSubmit`, `Stop`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PermissionRequest`, and `Notification`. TypeScript additionally exposes events including `PostToolBatch`, `SessionStart`, `SessionEnd`, `Setup`, `TeammateIdle`, `TaskCompleted`, `ConfigChange`, and worktree lifecycle. Hooks can block or modify tool input, inject context, replace tool output, or run asynchronously for side effects. Decision precedence is `deny > defer > ask > allow`. Source: [Agent SDK hooks](https://code.claude.com/docs/en/agent-sdk/hooks).

### 1.4 Permissions and security

Permission evaluation is ordered: hooks, deny rules, permission mode, allow rules, then `canUseTool`; `dontAsk` skips the callback and denies unresolved requests. Current modes are `default`, `dontAsk`, `acceptEdits`, `bypassPermissions`, `plan`, and TypeScript-only model-classified `auto`. Subagents inherit permissive parent modes in important cases, so `bypassPermissions` is especially high risk. Source: [Configure permissions](https://code.claude.com/docs/en/agent-sdk/permissions).

`canUseTool` is the interactive approval seam. The callback receives tool input plus context such as tool-use ID, permission suggestions, subagent identity, blocked path, decision reason, and presentation text. An allow response can revise input and persist permission updates; a deny response can explain the denial and interrupt execution. Source: [Python Agent SDK permission types](https://code.claude.com/docs/en/agent-sdk/python#permission-types).

Security interpretation for hosts:

- `allowedTools` alone is insufficient as a security boundary;
- `bypassPermissions` grants broad autonomous access and should only be used inside a separately trusted isolation boundary;
- bare-name deny rules can remove tools from model context, while scoped deny rules are enforced at permission evaluation;
- hooks remain active in bypass mode and can still deny operations.

Source: [Permission mode details](https://code.claude.com/docs/en/agent-sdk/permissions#permission-modes).

### 1.5 Streaming and errors

Normal iteration yields accumulated SDK messages. Setting `includePartialMessages` / `include_partial_messages` adds raw Claude API streaming events; consumers must accumulate text and tool-input deltas themselves. Raw token-level stream events are emitted only for the main session, not subagents; complete messages carry `parent_tool_use_id` for attribution. Source: [Stream responses in real time](https://code.claude.com/docs/en/agent-sdk/streaming-output).

Recent protocol-visible events include command lifecycle states, interrupt receipts, API retry notices, background-task snapshots, model-fallback notices, per-turn `usage`, and cumulative `modelUsage`. These additions are version-coupled to the bundled Claude Code runtime. Source: [TypeScript SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md).

Python's documented exception hierarchy includes `ClaudeSDKError`, `CLINotFoundError`, `CLIConnectionError`, `ProcessError`, and `CLIJSONDecodeError`. A one-shot `query()` that ends with an error result currently yields the final result and then raises a plain `Exception`, rather than necessarily a `ClaudeSDKError` subtype. Source: [Python Agent SDK errors](https://code.claude.com/docs/en/agent-sdk/python#error-types).

### 1.6 Renames and deprecations to enforce

- Use **Claude Agent SDK**, not Claude Code SDK, in new product/UI naming.
- Use `ClaudeAgentOptions`, not the former `ClaudeCodeOptions`.
- Do not implement the removed TypeScript V2 session API; use `query()` and `resume`.
- Do not put `Skill` in an agent's generic `tools` / `allowed_tools`; use the dedicated `skills` option.
- In hook output, use `permissionDecision`, not the old `decision: "approve"` form.
- Use `updatedToolOutput`; the MCP-only `updatedMCPToolOutput` is deprecated.

Sources: [Python repository migration notes](https://github.com/anthropics/claude-agent-sdk-python#readme), [sessions guide](https://code.claude.com/docs/en/agent-sdk/sessions), [Python public types](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/types.py), and [hooks guide](https://code.claude.com/docs/en/agent-sdk/hooks).

## 2. Codex App Server official surface

### 2.1 Transport and protocol lifecycle

Codex App Server uses bidirectional JSON-RPC 2.0-shaped messages but omits the `"jsonrpc":"2.0"` member on the wire. Requests have `method`, `params`, and `id`; responses echo `id` with `result` or `error`; notifications omit `id`. Supported local transports are newline-delimited JSON over stdio, WebSocket text frames, WebSocket-over-Unix-socket, or `off`. Source: [Codex App Server protocol](https://learn.chatgpt.com/docs/app-server#protocol).

The required connection lifecycle is:

1. open one transport connection;
2. send exactly one `initialize` request with `clientInfo` and optional capabilities;
3. send `initialized` notification;
4. call `thread/start`, `thread/resume`, or `thread/fork`;
5. call `turn/start`, then consume `thread/*`, `turn/*`, `item/*`, request, and error messages.

Requests before initialization and repeated initialization are rejected. Capabilities include exact-method notification opt-out and `experimentalApi`. Source: [Initialization and lifecycle](https://learn.chatgpt.com/docs/app-server#initialization).

### 2.2 Threads, turns, items, resume, fork, and subscriptions

The explicit domain model is `Thread -> Turn -> Item`. Starting, resuming, or forking loads a thread for work and subscribes the connection to its events; `thread/read` reads persisted state without loading or subscribing. `thread/list` and the experimental turn/item pagination methods support history UIs. Source: [API overview](https://learn.chatgpt.com/docs/app-server#api-overview).

Current continuity semantics include:

- `thread/resume` reopens an existing thread and accepts selected configuration overrides;
- `thread/fork` copies stored history into a new thread ID and emits `thread/started`;
- `lastTurnId` bounds copied history through a completed turn; a mid-turn boundary is rejected;
- `ephemeral: true` creates an in-memory fork omitted from stored listings;
- `thread.sessionId` identifies the root of the live session tree; forked threads retain their source tree's root session ID;
- `thread/unsubscribe` removes only the connection subscription; after the last subscriber and an inactivity grace period, App Server runs `SessionEnd` hooks, unloads the thread, and emits `thread/closed`.

Source: [Resume and fork](https://learn.chatgpt.com/docs/app-server#start-resume-or-fork-a-thread) and the version-pinned [`rust-v0.149.0` App Server README](https://github.com/openai/codex/blob/rust-v0.149.0/codex-rs/app-server/README.md#lifecycle-overview).

### 2.3 Inputs, tools, MCP, skills, apps, and hooks

`turn/start` accepts typed text, inline/local image, and inline/local audio inputs and streams the resulting turn/item lifecycle. `turn/steer` injects additional input into a steerable in-flight turn; `turn/interrupt` requests cancellation. Source: [Codex App Server turn APIs](https://learn.chatgpt.com/docs/app-server#start-a-turn).

Tool and extension surfaces include:

- server-managed built-in tools represented as typed items;
- experimental client-hosted `dynamicTools`, invoked via the server request `item/tool/call`;
- direct configured MCP inspection and execution through `mcpServerStatus/list`, `mcpServer/resource/read`, and `mcpServer/tool/call`;
- MCP OAuth and structured elicitation through `mcpServer/oauth/login` and server request `mcpServer/elicitation/request`;
- skill discovery/configuration, plugin/marketplace APIs, and app/connector listing, inspection, and invocation;
- `hooks/list` for discovered lifecycle hooks, including command and MCP-tool hooks; only trusted unmanaged hooks become runnable.

Sources: [App Server API overview](https://learn.chatgpt.com/docs/app-server#api-overview), [skills](https://learn.chatgpt.com/docs/app-server#skills), and [version-pinned hook documentation](https://github.com/openai/codex/blob/rust-v0.149.0/codex-rs/app-server/README.md#skills).

### 2.4 Permissions, approvals, and security

Thread/turn execution supports sandbox policy and the newer named permission-profile surface. Clients should discover profiles with `permissionProfile/list`; experimental `permissions` and legacy `sandbox` must not be sent together. `command/exec` runs under the server sandbox, but `thread/shellCommand` and experimental `process/spawn` are explicitly unsandboxed/full-access APIs. Sources: [App Server API overview](https://learn.chatgpt.com/docs/app-server#api-overview) and [command execution](https://learn.chatgpt.com/docs/app-server#command-execution).

When a tool needs authorization, App Server sends a JSON-RPC request to the client. Approval families cover command execution, file changes, MCP structured forms/tool approval, and `item/permissions/requestApproval`. Responses are scoped by `threadId`, `turnId`, and item/call ID and may include session-persistent permission changes. `approvalsReviewer` can route review to the user or `auto_review` Guardian. Source: [App Server approvals](https://learn.chatgpt.com/docs/app-server#approvals) and the [version-pinned `0.149.0` approval reference](https://github.com/openai/codex/blob/rust-v0.149.0/codex-rs/app-server/README.md#approvals).

Transport security requirements are significant:

- WebSocket is experimental and unsupported for production;
- origin-bearing HTTP/WebSocket requests are rejected;
- non-loopback listeners may be unauthenticated by default during rollout, so remote exposure requires an explicit capability token or signed bearer-token configuration plus TLS;
- credentials are presented during the WebSocket handshake, before JSON-RPC initialization;
- use plain `ws://` only for localhost or an SSH-forwarded connection.

Source: [Codex App Server protocol and WebSocket auth](https://learn.chatgpt.com/docs/app-server#protocol).

### 2.5 Streaming, backpressure, and errors

Streaming is notification-based. The client reconstructs content from typed deltas such as `item/agentMessage/delta`, reasoning deltas, command output deltas, and file-change events, with `turn/completed` carrying terminal status and usage. The server can also send requests mid-turn, so a client transport must multiplex requests, responses, and notifications rather than treat stdout as a one-way event stream. Source: [App Server events](https://learn.chatgpt.com/docs/app-server#events).

Mid-turn failures emit an `error` notification and may then end the turn with failed status. `codexErrorInfo` distinguishes context/budget/usage exhaustion, policy violations, upstream HTTP/stream failures, non-steerable active turns, bad requests, unauthorized access, sandbox failures, and internal errors. Source: [App Server errors](https://github.com/openai/codex/blob/rust-v0.149.0/codex-rs/app-server/README.md#errors).

WebSocket ingress uses bounded queues. Saturation produces JSON-RPC error `-32001`, message `Server overloaded; retry later.`, and clients are expected to use exponential backoff with jitter. Source: [App Server backpressure](https://learn.chatgpt.com/docs/app-server#protocol).

### 2.6 Schema, compatibility, and deprecations

`initialize.capabilities.experimentalApi` is a real compatibility boundary. Without it, experimental methods or fields are rejected; generated schemas omit experimental surface by default. Clients should generate both stable-only and experimental schemas from the exact binary when they intentionally use experimental methods. Source: [Experimental API opt-in](https://learn.chatgpt.com/docs/app-server#experimental-api-opt-in).

Current deprecations/instability include:

- `thread/rollback` is deprecated and will be removed;
- legacy `item/fileChange/outputDelta` remains in the protocol for compatibility but is no longer emitted;
- experimental `multiAgentMode` is deprecated/ignored in the `0.149.0` source contract; Ultra reasoning effort now controls proactive multi-agent behavior;
- WebSocket transport and the App Server command as a production embedding surface remain experimental/unsupported;
- several plugin APIs are marked under development and explicitly should not be called from production clients.

Sources: [current App Server API overview](https://learn.chatgpt.com/docs/app-server#api-overview) and [`rust-v0.149.0` App Server README](https://github.com/openai/codex/blob/rust-v0.149.0/codex-rs/app-server/README.md).

## 3. Documentation/version skew found during research

There is a material first-party discrepancy around paginated thread history:

- the current public App Server page says `historyMode: "paginated"` creation returns `-32601` and that full-history reads, turn pagination, and resume fail closed for existing paginated records;
- the `rust-v0.149.0` repository README describes experimental paginated durable history, turn/item pagination, and `thread/revert` as implemented surfaces.

Sources: [public App Server resume section](https://learn.chatgpt.com/docs/app-server#start-resume-or-fork-a-thread) and [`rust-v0.149.0` README](https://github.com/openai/codex/blob/rust-v0.149.0/codex-rs/app-server/README.md#api-overview).

This means neither `main` types nor the public prose page is sufficient as the sole compatibility target. The safe rule is:

1. pin the executable/package version;
2. generate or inspect that version's schema/types;
3. probe experimental capability support at initialization;
4. run conformance fixtures against the bundled runtime;
5. treat public documentation as semantic guidance, not proof that a given binary supports an experimental field.

## 4. Conformance checklist for the Cognia audit

The implementation audit should verify each item against its actually bundled versions.

### Claude Agent SDK adapter

- Package and displayed product naming use Claude Agent SDK.
- Adapter consumes the full iterator through completion and does not stop immediately at `ResultMessage`.
- All core and recent message families are accepted without crashing on unknown system events.
- Session ID capture, resume, fork, truncated-resume safeguards, and fork-source attribution are preserved.
- Permission evaluation does not mistake `allowedTools` for a tool-removal boundary.
- `canUseTool`, hook allow/ask/deny/defer, updated inputs, updated tool outputs, and async hook output are represented.
- MCP supports stdio, SSE, HTTP, SDK in-process servers, status/auth states, and tool search; known SDK-MCP limitations are explicit.
- Partial stream events, complete messages, subagent attribution, retry/fallback notices, interrupt/abort state, and cumulative usage/cost are handled.
- Python/TypeScript feature differences are not hidden behind a false common denominator.
- Removed V2 session APIs and deprecated hook/skill fields are absent.

### Codex App Server client

- Transport supports the exact wire framing: JSONL for stdio and one JSON-RPC-shaped message per WebSocket text frame; no `jsonrpc` member is required.
- `initialize` / `initialized` ordering, client identity, capability negotiation, and exact notification opt-out are implemented.
- Requests, responses, notifications, and server-initiated requests are concurrently correlated by ID.
- Thread start/resume/fork/read/list/unsubscribe and session-tree IDs are not conflated.
- Turn start/steer/interrupt, typed multimodal inputs, item lifecycle, and terminal usage/status are preserved.
- All approval families fail closed and retain thread/turn/item scoping; reconnect/replay behavior is tested.
- Sandbox/profile selection is distinct from explicitly unsandboxed shell/process methods.
- MCP status/resource/tool/OAuth/elicitation, dynamic tools, skills, apps/plugins, and hooks are feature-gated rather than silently ignored.
- Backpressure error `-32001`, mid-turn `error`, failed turn status, unknown future notifications, and reconnect behavior are handled.
- Stable and experimental schemas are generated from the exact binary; undocumented or deprecated methods are not assumed stable.
- Remote WebSocket is never exposed without TLS and explicit handshake authentication.

## Primary sources

### Anthropic

- [Claude Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
- [How the agent loop works](https://code.claude.com/docs/en/agent-sdk/agent-loop)
- [Work with sessions](https://code.claude.com/docs/en/agent-sdk/sessions)
- [Configure permissions](https://code.claude.com/docs/en/agent-sdk/permissions)
- [Hooks](https://code.claude.com/docs/en/agent-sdk/hooks)
- [MCP](https://code.claude.com/docs/en/agent-sdk/mcp)
- [Streaming output](https://code.claude.com/docs/en/agent-sdk/streaming-output)
- [Python SDK reference](https://code.claude.com/docs/en/agent-sdk/python)
- [TypeScript SDK repository and changelog](https://github.com/anthropics/claude-agent-sdk-typescript)
- [Python SDK repository, types, and changelog](https://github.com/anthropics/claude-agent-sdk-python)

### OpenAI

- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [`openai/codex` App Server README at `rust-v0.149.0`](https://github.com/openai/codex/blob/rust-v0.149.0/codex-rs/app-server/README.md)
- [Codex App Server v2 JSON Schemas on `main`](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/json/codex_app_server_protocol.v2.schemas.json)
- [Codex `0.149.0` release](https://github.com/openai/codex/releases/tag/rust-v0.149.0)
- [ChatGPT and Codex changelog](https://learn.chatgpt.com/docs/changelog)

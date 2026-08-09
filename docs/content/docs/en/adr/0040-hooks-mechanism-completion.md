---
title: ADR-0040 — Hooks mechanism completion (built-in agent + external agents)
description: "Completes the Claude-Code-style settings.json hook runtime (ADR Phase-1 wired only UserPromptSubmit + PreToolUse). A pure Rust classifier maps the built-in agent's SDK event stream onto the full lifecycle (PostToolUse/Failure, Stop/StopFailure, SessionStart/End, SubagentStop, Notification, PostCompact, Task*, PermissionRequest/Denied, PostToolBatch); a thin run_agent_hook Tauri command lets the TS external-agent manager (claude-code/codex/opencode) reach the SAME runtime; webhook handlers are implemented; project/local-scope hooks load behind a Rust-enforced workspace-trust gate; and the two orphaned System-A plugin hooks (onExternalAgentToolCall / onExternalAgentPermissionRequest) are wired."
---

# ADR-0040 — Hooks mechanism completion

**Status**: Accepted (2026-06-01)
**Authors**: Max Qian + Claude Opus 4.8
**Extends**: the Phase-1 hooks runtime in `src-tauri/src/hooks/` (which wired only `UserPromptSubmit` + `PreToolUse`)
**Affects**: `src-tauri/src/hooks/{mod,classify,commands,trust,webhook,command,types}.rs`, `src-tauri/src/claude/{sidecar,commands}.rs`, `src-tauri/src/lib.rs`, `lib/ai/agent/external/{agent-hooks,manager}.ts`, `lib/claude/hook-trust-sync.ts`, `lib/db/trusted-workspaces.ts`, `components/providers/hook-trust-sync-provider.tsx`, `components/settings/hooks/hooks-section.tsx`, `app/layout.tsx`, `i18n/messages/{en,zh-CN}.json`

## Context

Two parallel "hook" systems exist:

- **System A** — in-process plugin hooks (`lib/plugin/messaging/hooks-system.ts`, 74+ kinds). Mature, but `dispatchExternalAgentToolCall` / `dispatchExternalAgentPermissionRequest` were defined and never called (orphans).
- **System B** — the Claude-Code-style `settings.json` hook runtime in Rust (`src-tauri/src/hooks/`). Its own comments marked it **Phase 1**: only `UserPromptSubmit` (in `claude_send`) and `PreToolUse` (in the sidecar's `permission_request` handler) fired. The remaining 25 events round-tripped through settings but never fired; webhook handlers were stubbed; project/local scope was never loaded (`cwd: None` hardcoded); external agents (claude-code/codex/opencode) had zero hook integration.

This ADR completes System B across the built-in agent **and** the external agents, and closes the System-A orphans.

## Decision

### Injection model — one runtime, reached two ways

The Rust `external_agent` module is a pure stdio pass-through: it never parses ACP/opencode messages, so it cannot see external-agent tool/permission events — those are parsed only in TS. The built-in agent's sidecar, by contrast, forwards the full SDK event stream to Rust. Therefore:

| Agent | Injection layer | Rationale |
|---|---|---|
| Built-in (sidecar) | **Rust** — `claude::sidecar` stdout reader + `claude_send` | Rust already sees the SDK stream and already hosts PreToolUse/UserPromptSubmit. |
| External (claude-code/codex/opencode) | **TS** — `manager.ts` (`executeStreaming` + `execute`), calling the new `run_agent_hook` Tauri command into the SAME Rust runtime | Only TS has the parsed events; the command reuses the runtime instead of duplicating it. |
| System-A orphans | **TS** — same `manager.ts` seams | Pure in-process plugin dispatch. |

Rejected: registering the SDK's native `hooks` option inside the sidecar (Node) — it would bypass and duplicate the Rust settings.json runtime.

### Built-in agent event mapping (Rust)

`hooks/classify.rs` is a pure, exhaustively-tested classifier over the forwarded SDK messages:

- `system/init` → SessionStart; `system/compact_boundary` → PostCompact; `system/notification` → Notification; `system/task_started` → TaskCreated; `system/task_notification` → TaskCompleted + SubagentStop.
- `result/success` → Stop; `result/error_*` → StopFailure; `tool_use_summary` → PostToolBatch; `session_ended` → SessionEnd (+ StopFailure on error).
- `tool_use` (assistant) blocks are recorded per session; the matching `tool_result` (user) block fires PostToolUse, or PostToolUseFailure when `is_error`.
- `PermissionRequest` + `PermissionDenied` fire alongside the existing PreToolUse on the `permission_request` path.

Observational hooks can contribute `additionalContext` (surfaced as a compact log line) but cannot re-inject mid-stream; blocking stays on the permission round-trip.

### External agent mapping (TS)

`lib/ai/agent/external/agent-hooks.ts` fires, per `ExternalAgentEvent`: SessionStart (`session_start`), PostToolUse/Failure (`tool_result`), Stop + SessionEnd (`done`), StopFailure (`error`), plus the System-A `onExternalAgentToolCall` (`tool_use_start`). On `permission_request` it runs a blocking PreToolUse: in `executeStreaming` a block denies the permission and `continue`s (true suppression); in the headless `execute` path the deny is still enforced (no permission UI to suppress).

### Trust gate (Rust-enforced)

`hooks/trust.rs` holds a process-global trusted-path set seeded from the Dexie ledger via `set_trusted_workspaces`. `resolve_trusted_cwd` returns a project `cwd` only when trusted, else `None` (user scope only). Enforced in Rust so a compromised renderer cannot load project/local hooks from an untrusted dir. The frontend syncs the ledger at startup (`HookTrustSyncProvider`) and after every trust change (`trustWorkspace` / `revokeWorkspaceTrust`).

### Webhooks

`hooks/webhook.rs` implements the previously-stubbed webhook handler: HTTP POST of the JSON payload with configured headers + timeout, reusing the command handler's response-decision parser so `permissionDecision` / `additionalContext` semantics are identical.

### Events with no trigger source

`PreCompact`, `ConfigChange`, `FileChanged`, `WorktreeCreate/Remove`, `CwdChanged`, `InstructionsLoaded`, `Elicitation(Result)`, `UserPromptExpansion`, `TeammateIdle` have no real source in the agent path today. They remain round-trippable in settings but are **explicitly annotated** in the settings UI ("no trigger source yet") rather than silently stubbed.

## Consequences

- Settings.json hooks now fire across the built-in agent and all three external agents; PreToolUse can block tools on every path.
- Project/local hooks are usable but safely gated behind workspace trust, enforced in Rust.
- No Dexie schema change (the trust table already existed).
- Limitation: external-agent tools that auto-execute without a `permission_request` can only be observed (via `tool_use_start`), not blocked — a protocol boundary, documented rather than worked around.

## Addendum (2026-08-06) — versioned capabilities and execution ownership

The original injection model above is superseded for the built-in Claude Agent SDK rail. The
sidecar now owns SDK-native hook dispatch because it is the only layer that can preserve the
SDK's event-specific inputs, outputs, concurrency, and abort behavior. Rust remains the owner of
external-agent and compatibility command execution. An event occurrence has exactly one owner;
the Rust host must not pre-run `UserPromptSubmit` and then inject the same hook into the SDK.

Hook support is a versioned capability matrix, not one global event or handler list. The pinned
Claude Agent SDK surface is checked against its 31 public events. Codex and OpenCode adapters
publish only capabilities verified from their installed runtime/client. TypeScript, Rust, CLI,
Settings, and Fleet share event identities and parity gates while retaining provider-specific
matcher, timeout, concurrency, blocking, and output semantics.

Unsupported handlers and outputs are explicit diagnostics rather than silent no-ops. Legacy
`webhook` settings remain readable as Cognia's HTTP-handler compatibility form. Every outbound
HTTP/model/MCP path is subject to the shared PII gate, and persisted traces contain only
sanitized inputs, decisions, timing, and errors.

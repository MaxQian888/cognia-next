# Hooks Mechanism Completion — Design (Phase 2)

Goal: complete the Claude-Code-style `settings.json` hooks runtime (System B) so it fires
across the **built-in agent** and the **external agents** (claude-code / codex / opencode),
and fix the two **orphan System-A plugin hooks**. No omissions, no fake triggers — every event
with a real source gets wired; events with genuinely no source are enumerated, not stubbed.

---

## 0. Current state (verified)

Two parallel hook systems:

- **System A** — in-process plugin hooks (`lib/plugin/messaging/hooks-system.ts`, 74+ kinds). Mature.
  External-agent hooks fire only from the interactive React path (`hooks/agent/use-external-agent.ts`).
  `dispatchExternalAgentPermissionRequest` (`:2095`) and `dispatchExternalAgentToolCall` (`:2115`)
  are defined but **never called** → orphans.
- **System B** — Claude-Code `settings.json` hooks runtime in Rust (`src-tauri/src/hooks/`).
  Only `UserPromptSubmit` (`claude/commands.rs:189-216`) and `PreToolUse`
  (`claude/sidecar.rs:258-272` → `handle_permission_request`) are wired. 25 other events round-trip
  but never fire. Webhook handler stubbed. Project/local scope not loaded (`sidecar.rs:347` hardcodes
  `cwd: None`). External agents have **zero** settings-hook integration.

Key facts that drive the design:

- The Rust `sidecar.rs` stdout reader (`:251-285`) sees the **full SDK event stream** as
  `{type:"event", event: SDKMessage}` → the built-in agent's remaining events are observable in Rust.
- The Rust `external_agent` module is **pure stdio passthrough** — it never parses ACP/opencode
  messages. All semantic events (tool_use, permission_request) are parsed only in TS
  (`acp-client.ts` / `opencode-client.ts` → `manager.ts`). → external-agent hooks **must** inject in TS.
- `read_claude_effective_settings(cwd)` (`src-tauri/src/settings.rs:85-102`) **already** merges
  user+project+local with correct precedence. The gap is only that `sidecar.rs` passes `cwd:None`.
- Workspace trust exists (`lib/db/trusted-workspaces.ts`, `components/chat/workspace-trust-dialog.tsx`)
  but is **not enforced** at the Rust hook-loading layer.
- `manager.ts:executeStreaming` (`:1612-1630`) is the single choke point every external-agent event
  flows through (`session_start`, `tool_use_start`, `tool_result`/`tool_use_end`,
  `permission_request`, `done`, `error`).

---

## 1. Injection-layer decision (the fork the user asked me to call)

**Recommendation: hybrid, each agent at the layer that actually has the data — backed by ONE Rust runtime.**

| Agent                                 | Injection layer                                                                                                         | Why                                                                                                                                                                                                                             |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Built-in (sidecar)                    | **Rust** — in `sidecar.rs` stdout reader + `commands.rs`                                                                | Rust already sees the full SDK event stream and already hosts `PreToolUse`/`UserPromptSubmit`. Reuse the exact pattern. No IPC.                                                                                                 |
| External (claude-code/codex/opencode) | **TS** — in `manager.ts:executeStreaming`, calling a NEW thin Tauri command `run_agent_hook` into the SAME Rust runtime | Rust can't see external-agent tool/permission events (stdio passthrough). TS is the only place with the parsed event. The new command lets it reuse the Rust `settings.json` command/webhook runtime instead of duplicating it. |
| System-A orphans                      | **TS** — same `manager.ts:executeStreaming` loop                                                                        | Pure in-process plugin dispatch, no IPC.                                                                                                                                                                                        |

Rejected alternative — register the SDK's native `hooks` option inside the sidecar (Node): would run
handlers in Node and bypass the Rust `settings.json` runtime, duplicating it. Reject.

Net: **one** hooks runtime (`src-tauri/src/hooks/`), reached two ways — in-process for the built-in
agent, via `run_agent_hook` for external agents.

---

## 2. Event → trigger mapping (built-in agent, Rust)

Fire from the `sidecar.rs` stdout reader by inspecting `event.event.type` (SDK message type), plus a
few from `commands.rs`. Blocking events reuse the existing permission round-trip; the rest are
observational (may contribute `additionalContext`).

| HookEvent          | SDK/sidecar source                                                              | Block? | Notes                                                                     |
| ------------------ | ------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------- |
| UserPromptSubmit   | `commands.rs` (existing)                                                        | yes    | already wired                                                             |
| PreToolUse         | `permission_request` (existing)                                                 | yes    | already wired                                                             |
| PermissionRequest  | `permission_request`                                                            | no     | distinct CC event; fire alongside PreToolUse                              |
| PermissionDenied   | `permission_response` deny (user or hook) in `handle_permission_request`        | no     |                                                                           |
| PostToolUse        | `event:user` msg containing `tool_result` block (correlate to prior `tool_use`) | no     | tool result rides the stream as a synthetic user message                  |
| PostToolUseFailure | `tool_result` with `is_error:true`                                              | no     |                                                                           |
| PostToolBatch      | `SDKToolUseSummaryMessage`                                                      | no     | if present in stream                                                      |
| SessionStart       | `event:system` `subtype:"init"`                                                 | no     |                                                                           |
| SessionEnd         | `session_ended` / `sidecar_exited`                                              | no     |                                                                           |
| Stop               | `session_ended` with normal `result`                                            | no     | main turn finished                                                        |
| StopFailure        | `session_ended` with `error`                                                    | no     |                                                                           |
| SubagentStop       | `SDKTaskNotificationMessage` status finished / `SDKSessionStateChangedMessage`  | no     | Task tool subagents                                                       |
| TaskCreated        | `SDKTaskStartedMessage`                                                         | no     |                                                                           |
| TaskCompleted      | `SDKTaskNotificationMessage` status finished                                    | no     |                                                                           |
| Notification       | `SDKNotificationMessage`                                                        | no     |                                                                           |
| PostCompact        | `SDKCompactBoundaryMessage` (`compact_boundary`)                                | no     | emitted after compaction                                                  |
| PreCompact         | —                                                                               | —      | **no real pre-trigger in stream** → enumerate as unsupported (don't fake) |

**Events with genuinely no source in the agent path (documented, NOT stubbed):**
`ConfigChange`, `FileChanged`, `WorktreeCreate`, `WorktreeRemove`, `CwdChanged`,
`InstructionsLoaded`, `Elicitation`, `ElicitationResult`, `UserPromptExpansion`, `TeammateIdle`,
`Setup`. These stay round-trippable in settings but the runtime documents "no trigger source yet".
(Candidate future sources: ConfigChange/FileChanged → existing source-control fs watcher;
Worktree\* → git worktree subsystem. Out of scope for this change.)

---

## 3. Event → trigger mapping (external agents, TS)

In `manager.ts:executeStreaming` (`:1612-1630`), per yielded `ExternalAgentEvent`:

| ExternalAgentEvent             | System B (run_agent_hook)                              | System A                                 | Block path                                                                   |
| ------------------------------ | ------------------------------------------------------ | ---------------------------------------- | ---------------------------------------------------------------------------- |
| `session_start`                | SessionStart                                           | —                                        | —                                                                            |
| `permission_request`           | PreToolUse + PermissionRequest                         | `dispatchExternalAgentPermissionRequest` | if PreToolUse blocks → `respondToPermission(deny)` instead of prompting user |
| `tool_use_start`               | (PreToolUse already ran on permission for gated tools) | `dispatchExternalAgentToolCall`          | observational                                                                |
| `tool_result` / `tool_use_end` | PostToolUse (+ PostToolUseFailure on error)            | —                                        | observational                                                                |
| `done`                         | Stop + SessionEnd                                      | (existing ExecutionComplete)             | —                                                                            |
| `error`                        | StopFailure                                            | (existing ExternalAgentError)            | —                                                                            |

Limitation (documented, honest): external-agent tools that auto-execute **without** a
`permission_request` can't be blocked by PreToolUse — only observed via `tool_use_start`. This matches
what the protocol surfaces; not a simplification, a protocol boundary.

---

## 4. Workstreams

### WS-1 — Rust hooks runtime: generalize + new events

- `hooks/mod.rs`: add `run_post_tool_use`, `run_stop`, `run_session_start`, `run_session_end`,
  `run_subagent_stop`, `run_notification`, `run_post_compact`, `run_task_created`,
  `run_task_completed`, `run_permission_request`, `run_permission_denied`, `run_post_tool_use_failure`
  — thin wrappers over the existing `run_event` with proper `HookEventPayload`.
- Keep `HookDecision` semantics; observational events ignore `block` (only collect warnings/context).
- Tests in `hooks/mod.rs` `#[cfg(test)]` per new wrapper.

### WS-2 — Built-in agent wiring (sidecar.rs + commands.rs)

- Add a `session_id → cwd` map to `SidecarState`, populated in `claude_send` (so the reader knows cwd).
- In the stdout reader, add an event-observer: for `type:"event"` and `session_ended`, classify the
  SDK message and spawn the matching `hooks::run_*` (mirror the `permission_request` spawn pattern).
- `additionalContext` from observational hooks is logged/emitted (can't re-inject mid-stream); blocking
  remains only on the permission path. Emit a `log` event when a hook contributes context, for UX parity.
- Correlate `tool_use` → `tool_result` via a per-session pending-tool map for PostToolUse payloads.

### WS-3 — `run_agent_hook` Tauri command (bridge for external agents)

- New `#[tauri::command] async fn run_agent_hook(event, session_id, cwd, payload) -> HookDecisionDto`.
- Loads effective settings (trust-gated, see WS-5), runs the event, returns
  `{ block: Option<String>, additionalContext: Option<String>, warnings: Vec<String> }`.
- Register in `lib.rs` invoke_handler. Rust unit test on the dto mapping.

### WS-4 — External-agent TS wiring (manager.ts)

- In `executeStreaming`, after parsing each event, call the table in §3:
  - `invoke("run_agent_hook", …)` for System B (await; honor `block` only for permission path).
  - `getPluginEventHooks().dispatchExternalAgent*` for System A orphans.
- Wire the **headless** `ctx.agent.runExternalAgent` (`context.ts:658`) so plugin-dispatched runs get
  the same hooks (they flow through the same `manager.execute`/`executeStreaming`, so wiring at the
  manager covers both interactive and headless — verify and add a test).
- Guard `invoke` behind `isTauri()`; web/mobile no-op (settings hooks are desktop-only).

### WS-5 — Project/local scope + trust enforcement

- New Rust trusted-paths registry (`src-tauri/src/hooks/trust.rs` or reuse settings): a process-global
  set, seeded/updated from the Dexie trust store via a new `set_trusted_workspaces(paths)` command
  called by the frontend on startup and on trust change.
- `resolve_trusted_cwd(cwd) -> Option<String>`: returns `cwd` only if trusted, else `None`
  (→ user-scope only). Use it in: `sidecar.rs` (replace hardcoded `None`), `commands.rs`
  UserPromptSubmit, and `run_agent_hook`.
- This enforces trust **in Rust** so a compromised renderer can't load project hooks from an
  untrusted dir. Tests for trusted/untrusted resolution.

### WS-6 — Webhook handler (finish Phase-2 stub)

- Implement `hooks/webhook.rs`: HTTP POST payload JSON, headers, timeout (reuse `HARD_TIMEOUT_CAP`),
  parse JSON response with the same `permissionDecision`/`additionalContext` protocol as command
  handlers. Replace the `not implemented yet` arm in `mod.rs:run_handler`. Use the existing HTTP
  client dep (reqwest, already in tree). Tests with a mock/loopback.

### WS-7 — System-A orphan closure + types

- Call the two orphan dispatchers in §3 (WS-4). Confirm payload shapes against
  `types/plugin/plugin-hooks.ts` (`onExternalAgentPermissionRequest`/`ToolCall`, observational/void).
- Add a plugin-template example + docstring so authors discover them.

### WS-8 — Settings UI parity

- `components/settings/hooks/hooks-section.tsx`: annotate events that have "no trigger source yet"
  (subtle badge) so users aren't misled into configuring dead events. i18n keys in en + zh-CN.
- No new event removed — round-trip preserved.

### WS-9 — Docs

- New ADR `docs/content/docs/{en,zh}/adr/00XX-hooks-completion.md` (next free number) capturing the
  hybrid injection model, the event mapping, the trust enforcement, and the documented no-source events.
- Update `docs/content/docs/plugin-dev/lifecycle-hooks.mdx` if it references hook coverage.

---

## 5. Testing & gates (per CLAUDE.md)

- Rust: `#[cfg(test)]` for every new `run_*`, webhook handler, trust resolution. `cargo test` (note:
  this box may only run `cargo check` — will state which ran).
- TS: co-located tests for `manager.ts` hook firing (mock `invoke` + `getPluginEventHooks`), the
  headless `runExternalAgent` path, and `hooks-section.tsx` badges. `pnpm test` + `pnpm test:coverage`
  ≥90%.
- i18n: new keys in both locales, `pnpm lint:i18n`.
- `pnpm typecheck`, `pnpm lint`.

## 6. Risk / ordering

1. WS-1 (Rust runtime wrappers) → 2. WS-2 (built-in) → 3. WS-3+WS-4+WS-7 (external + orphans) → 4. WS-5 (trust) → 5. WS-6 (webhook) → 6. WS-8/WS-9 (UI/docs). Each WS independently testable.

- Concurrency caveat: heavy uncommitted work already in tree (per memory). Touch only hooks/agent
  files; avoid Dexie schema bumps (none needed — trust table already exists).

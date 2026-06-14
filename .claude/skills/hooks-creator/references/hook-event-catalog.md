# Hook event catalog (System B)

The 27 lifecycle events the settings.json runtime knows, where they fire, and
whether a hook on them can block. Canonical source: `src-tauri/src/hooks/types.rs`
(Rust) mirrored in `cli/src/hooks/types.ts` and `lib/claude/hooks.ts`. Mapping
from the agent stream lives in `src-tauri/src/hooks/classify.rs` and
`cli/src/hooks/classify.ts`.

**Before wiring a hook, confirm the event fires.** A hook on a dormant event is
dead code.

## Fires today — observational (can contribute `additionalContext`, cannot block)

| Event | Source |
|---|---|
| `SessionStart` | SDK `system/init` |
| `SessionEnd` | `session_ended` |
| `PostToolUse` / `PostToolUseFailure` | `tool_result` (user block); `is_error` → Failure |
| `PostToolBatch` | `tool_use_summary` |
| `Stop` / `StopFailure` | `result/success` → Stop; `result/error_*` → StopFailure |
| `SubagentStop` | `system/task_notification` |
| `SessionStart`/`Notification` | `system/notification`, rate-limit events |
| `PostCompact` | `system/compact_boundary` |
| `TaskCreated` / `TaskCompleted` | `system/task_started` / `task_notification` |
| `PermissionRequest` / `PermissionDenied` | the permission round-trip |

These also fire for the **external agents** (claude-code/codex/opencode) via the
TS bridge `lib/ai/agent/external/agent-hooks.ts`, and for the **goal judge** and
**team planning** via `lib/claude/hooks/lifecycle-firer.ts`.

## Fires today — blocking

| Event | Source | Block effect |
|---|---|---|
| `PreToolUse` | the `permission_request` path | Deny denies the tool (true suppression in streaming) |
| `UserPromptSubmit` | before a prompt is sent; goal/team firer pre-call | Deny aborts the prompt / judge / plan |

## Lit up by the ADR-0040 follow-up (this work) — now firing

| Event | Source | Notes |
|---|---|---|
| `InstructionsLoaded` | `lib/claude/build-options.ts resolveSendOptions` (renderer) | fire-and-forget observational, after the system prompt assembles |
| `ConfigChange` | `lib/claude/settings.ts` user/project/local writers | fires after a successful settings write, with `{scope}` |
| `PreCompact` | CLI `App` `compact` effect | just before the context window is trimmed |
| `CwdChanged` | CLI `App` `addDir` effect | after `/add-dir` changes the agent's readable roots |

## Still dormant (no trigger source — do NOT wire a hook here)

`WorktreeCreate`, `WorktreeRemove` (no worktree command in the CLI yet),
`FileChanged`, `Elicitation`, `ElicitationResult`, `UserPromptExpansion`,
`TeammateIdle`. These round-trip through settings but never fire; the settings
UI badges them "no trigger source yet". Add a source before relying on them.

## Payload fields by category

- **All events:** `hook_event_name`, `session_id`, `cwd`.
- **Tool events** (`PreToolUse`, `PostToolUse*`, `PermissionRequest/Denied`):
  `tool_name`, `tool_input` (and `tool_response` / `is_error` on results).
- **`UserPromptSubmit`:** `prompt`; goal/team firer also threads `phase`,
  `goalId` / `teamId`, and (goal/loop turns) `tokensUsed`.
- **Context-injecting events** (`SessionStart`, `InstructionsLoaded`): emit
  `{"hookSpecificOutput":{"hookEventName":"<event>","additionalContext":"…"}}`.

## Built-in hooks shipped today

See `lib/claude/hooks/builtin-hooks.ts` and `hooks/builtin/`:

- `auto-context-loader.mjs` — injects `.cognia/agent-context.md` (SessionStart + UserPromptSubmit; default ON).
- `cost-quota-guard.mjs` — denies a turn over the session token budget (UserPromptSubmit; default OFF).
- `pii-safety-guard.mjs` — blocks obvious PII/credentials (UserPromptSubmit + PreToolUse; default OFF).

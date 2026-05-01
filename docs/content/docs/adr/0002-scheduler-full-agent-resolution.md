---
title: ADR-0002 — Scheduler full agent + tool resolution
description: Bring scheduled tasks into parity with interactive chat — full character / agent-mode / skill / MCP / built-in tool / permission-mode resolution, plus a typed structured editor and back-compat for legacy payload field names.
---

# Scheduler full agent + tool resolution

| Status  | Accepted                                                                                                                                                         |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Date    | 2026-05-01                                                                                                                                                       |
| Touches | `lib/scheduler/`, `types/scheduler/`, `components/scheduler/`, `lib/claude/build-options.ts`, `i18n/messages/{en,zh-CN}.json`, `docs/content/docs/adr/0002-*.md` |

## Context

The scheduler in `lib/scheduler/` was already feature-complete for triggering,
persistence, retries, leader election, notifications, and OS-level promotion.
But the link between the scheduler and the Claude/agent runtime was shallow:
scheduled `chat` / `agent` / `skill` tasks called
`sendPrompt(sessionId, prompt)` directly **without** going through
`resolveSendOptions()` (`lib/claude/build-options.ts`). That meant a
scheduled run bypassed every knob the interactive chat applies:

- character system prompt / model / allowed-tools / disallowed-tools / MCP subset
- attached skills (system-prompt section + `recordSkillUsage`)
- active **agent mode** (built-in or custom — system prompt + tools union + model override)
- A2UI bridge tools + A2UI system-prompt extension
- the five **`builtinTools`** sidecar toggles (file extras / git / process / environment / shell-advanced)
- `permissionMode`, `additionalDirectories`, MCP whitelist precedence, SDK resume continuity

Two correctness bugs also blocked the helper path:

1. **Field-name mismatch.** `conversational-task-authoring.ts` wrote
   `payload.message` (chat) and `payload.agentTask` (agent); the executors
   read `payload.prompt`. Any task created through the helper failed on
   first run.
2. **Helper didn't bind characterId.** `createScheduledAgentTaskDraft` never
   threaded a `characterId` into the payload, but `executeAgentTask` requires
   one.

The TaskForm only exposed a free-form JSON textarea for the payload. There
was no character / skill / mode / tool / MCP picker — and external ACP
agents (Claude Desktop, Cursor, Codex, Gemini, …) could not be scheduled at
all even though `lib/ai/agent/external/manager.ts:executeOnExternalAgent`
was already in the repo.

## Decision

### 1. Reuse the interactive resolution pipeline

The scheduler executor now goes through the same `resolveSendOptions` that
the interactive composer uses, plus an override-layering step that mirrors
the merge contract in `hooks/chat/use-claude-chat.ts:111-140`.

Flow per chat-style turn (`runChatPrompt` in
`lib/scheduler/executors/index.ts`):

1. Look up / create the session (`kind: "team"` when `payload.teamId` is set,
   else `"direct"`).
2. `await getSettings()` to pick up `AppSettings.builtinTools` + defaults.
3. Resolve the active agent mode from `payload.agentModeId` against the
   built-in registry first, then the custom-mode store. `null` opts out.
4. Splice `payload.disabledSkillIds` onto a synthetic
   `session.disabledSkillIds` so `resolveSendOptions` honours them.
5. Call `resolveSendOptions({ session, appSettings, agentMode })`.
6. Layer payload-level overrides:
   - `model`, `permissionMode`, `maxTurns`, `effort` → assign
   - `appendSystemPrompt` → join with the existing value if any
   - `allowedTools`, `additionalDirectories` → **union** with resolved values
   - `disallowedTools` → assign
   - `mcpServerIds` → resolve to a server map (empty array means "no MCP")
   - `builtinTools` → shallow-merge over `appSettings.builtinTools`
7. For `skill` tasks: union the ad-hoc skill's `allowedTools` and splice its
   prompt section onto `systemPrompt`.
8. `await sendPrompt(sessionId, prompt, finalOptions)` — same IPC, now with
   the merged options.

The existing `onClaudeMessage` event collector + timeout race remained
unchanged.

### 2. New `external-agent` task type

Adds `executeExternalAgentTask`, registered for the new
`"external-agent"` task type, calling
`executeOnExternalAgent(prompt, { agentId, permissionMode, workingDirectory, timeout })`.
Falls back to `task.config.timeout` when `payload.timeoutMs` is absent.

### 3. Typed payload union

`types/scheduler/index.ts` now exports a discriminated payload union:

```ts
export type ScheduledTaskPayload =
  | Record<string, unknown>
  | BackupTaskPayload
  | ChatLikeTaskPayload
  | AgentTaskPayload
  | SkillTaskPayload
  | ExternalAgentTaskPayload
```

`ChatLikeTaskPayload` mirrors every knob `resolveSendOptions` accepts so
downstream UI can pre-fill structured forms without copy-pasting field
declarations. `AgentTaskPayload` adds `characterId`; `SkillTaskPayload` adds
`skillId`; `ExternalAgentTaskPayload` is its own shape with `agentId` /
`permissionMode` / `cwd` / `timeoutMs`.

### 4. Structured payload editor

`components/scheduler/payload-editors/` introduces a structured form mode
for chat / agent / skill / external-agent task types:

- `chat-payload-editor.tsx` — prompt + character / skill / mode / model /
  effort / max-turns / team / session pickers
- `external-agent-payload-editor.tsx` — agent picker (sourced from
  `getExternalAgentManager().getAllAgents()` with a free-text fallback)
- `tool-picker.tsx` — built-in tool checklist + custom-name list
- `mcp-picker.tsx` — multi-select with a "use character/team default" radio
  so unset is meaningfully distinct from empty array
- `builtin-tools-toggles.tsx` — per-toggle three-state selector
  (`use-default` / `force-on` / `force-off`)
- `permission-mode-select.tsx` — both SDK and ACP flavours
- `additional-directories-list.tsx` — add/remove rows with Tauri folder
  picker

`task-form.tsx` exposes an editor-mode toggle ("Use structured editor" ↔
"Edit as JSON") that round-trips losslessly. The 64 KB payload-size cap and
the existing JSON validation are preserved as a fallback.

### 5. Back-compat for legacy payload fields

The executor gained a one-shot reconciler (`reconcileLegacyPromptFields`)
that lazily rewrites `payload.message` → `payload.prompt` (chat) and
`payload.agentTask` → `payload.prompt` (agent), plus hoists nested
`config.{model, maxSteps}` to top-level `model` / `maxTurns`. A
`loggers.scheduler.warn` fires once per task id so stragglers are surfaced
without spam. `normalizeConversationalTaskPayload` does the same on the
helper path.

### 6. New conversational helpers

`createScheduledChatTaskDraft`, `createScheduledAgentTaskDraft`,
`createScheduledSkillTaskDraft`, and
`createScheduledExternalAgentTaskDraft` all emit the new typed payload
shape. The agent helper now optionally accepts `characterId` (intent-
classifier flows can produce a partial draft for the user to finish in the
form; the executor still requires the field at run time).

## Migration

- **Existing chat tasks** stored in IndexedDB with `payload.message` keep
  running — `reconcileLegacyPromptFields` rewrites them on the next run and
  warns once per id.
- **Existing agent tasks** without `characterId` now fail at run time with
  the explicit error `agent task requires characterId in payload`. Users
  can edit the task in the new structured form to pick a character.
- **External agent tasks** are net-new; nothing to migrate.

## Verification

1. `pnpm install`, then `pnpm tauri dev`.
2. Configure a character with a non-trivial system prompt + a couple of MCP
   servers + a skill. Save.
3. Open `/scheduler` → New Task → choose "Agent" → pick that character + an
   agent mode + tweak permission mode + toggle some built-in tools →
   trigger: `interval: 60000ms`.
4. Wait ~60s and verify in DevTools / execution-history that the outbound
   `claude_send` invoke shows merged `SendOptions`: system prompt with
   character + mode + skill sections; `allowedTools` including character +
   mode + skill + bridge sets; `mcpServers` correctly subset; `builtinTools`
   toggles applied; `permissionMode` set.
5. Repeat with task type "External agent" pointed at a configured ACP agent
   (e.g., Claude Desktop) → `executeOnExternalAgent` is invoked and the
   execution row shows the result.
6. Create a task via `createScheduledChatTaskDraft({ message: "..." })`
   (legacy field name) and confirm: it runs successfully; a `scheduler`
   warn-log fires once; the task continues to work after the migration.
7. `pnpm typecheck`, `pnpm lint`, and
   `pnpm test --testPathPatterns="lib/scheduler|components/scheduler/payload-editors|types/scheduler"`
   all green.

## Out of scope

- Per-team-member overrides selectable in TaskForm (the team-router applies
  per-member resolution at message dispatch time; v1 just picks `teamId`).
- A "Run now" button — already supported by the scheduler store via
  `runTaskNow`; surfacing it in the form is a separate UX item.
- Remote / cloud-side scheduling (CronCreate-style).
- Full A2UI per-task overrides — `session.a2uiEnabled` is already honoured
  by `resolveSendOptions`, so nothing to expose in TaskForm yet.

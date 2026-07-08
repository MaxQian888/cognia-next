# Plugin Point Consumer Index

This document maps every **canonical plugin point** declared in
`lib/plugin/contracts/plugin-points.ts` to its **host consumer** —
the Cognia subsystem that renders the UI slot, dispatches the hook, or
acts on the activation event.

Plugin authors use it to know **where** a contribution will surface.
Reviewers use it during PR review to verify that any new point has
a real consumer (no orphan contracts).

Update this file whenever:

- A canonical point is added, deprecated, or retired.
- A host file starts or stops consuming a point.
- A point's binding changes (e.g., a UI slot moves to a different shell).

Source-of-truth registry: `lib/plugin/contracts/plugin-points.ts`.

---

## UI Extension Points

> `CANONICAL_EXTENSION_POINTS` in `plugin-points.ts` is the authoritative list
> (it also includes the goal / perf / inbox / chat.input.menu / vscode.\* slots
> not re-tabulated here). The table below covers the core surfaces.

UI slots are rendered by `<PluginExtensionSlot point="..."/>`
(see `components/plugins/plugin-extension-slot.tsx`) which internally
calls `getExtensionsForPoint()` from `lib/plugin/api/extension-api.ts`.

| Point                            | Status         | Host Consumer                                                                                      | Notes                                                                                                                                                                                                |
| -------------------------------- | -------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sidebar.left.top`               | implemented    | `components/sidebar/app-sidebar.tsx` (top region)                                                  | Always-mounted.                                                                                                                                                                                      |
| `sidebar.left.bottom`            | implemented    | `components/sidebar/app-sidebar.tsx` (footer region)                                               | Always-mounted.                                                                                                                                                                                      |
| `sidebar.right.top`              | **deprecated** | none                                                                                               | Retired in 0.2.0. Use `sidebar.left.top`.                                                                                                                                                            |
| `sidebar.right.bottom`           | **deprecated** | none                                                                                               | Retired in 0.2.0. Use `sidebar.left.bottom`.                                                                                                                                                         |
| `toolbar.left`                   | implemented    | top toolbar (left aligned section)                                                                 |                                                                                                                                                                                                      |
| `toolbar.center`                 | implemented    | top toolbar (center aligned section)                                                               |                                                                                                                                                                                                      |
| `toolbar.right`                  | implemented    | top toolbar (right aligned section)                                                                |                                                                                                                                                                                                      |
| `statusbar.left`                 | implemented    | bottom status bar (left)                                                                           |                                                                                                                                                                                                      |
| `statusbar.center`               | implemented    | bottom status bar (center)                                                                         |                                                                                                                                                                                                      |
| `statusbar.right`                | implemented    | bottom status bar (right)                                                                          |                                                                                                                                                                                                      |
| `chat.header`                    | implemented    | `components/chat/header/*`                                                                         | Above messages list.                                                                                                                                                                                 |
| `chat.footer`                    | implemented    | `components/chat/*` (below messages list, above composer)                                          |                                                                                                                                                                                                      |
| `chat.input.above`               | implemented    | `components/chat/composer.tsx` (above input box)                                                   | Wired in M4.                                                                                                                                                                                         |
| `chat.input.below`               | implemented    | `components/chat/composer.tsx` (below input box)                                                   | Wired in M4.                                                                                                                                                                                         |
| `chat.input.actions`             | implemented    | `components/chat/composer/bottom-toolbar.tsx` (next to send button)                                | Wired in M4 via `plugin-toolbar-slot.tsx` (limit 3 + overflow).                                                                                                                                      |
| `chat.message.before`            | implemented    | `components/chat/message.tsx` (before message body)                                                | Wired in M4.                                                                                                                                                                                         |
| `chat.message.after`             | implemented    | `components/chat/message.tsx` (after message body)                                                 | Wired in M4.                                                                                                                                                                                         |
| `chat.message.actions`           | **deprecated** | none                                                                                               | Retired in 0.2.0. Use `chat.message.footer`.                                                                                                                                                         |
| `chat.message.footer`            | implemented    | `components/chat/message.tsx` (per-message action row)                                             | Use this for action buttons.                                                                                                                                                                         |
| `artifact.toolbar`               | implemented    | `components/ai-elements/artifact*`                                                                 |                                                                                                                                                                                                      |
| `artifact.actions`               | implemented    | `components/ai-elements/artifact*`                                                                 |                                                                                                                                                                                                      |
| `canvas.toolbar`                 | implemented    | `components/canvas/*`                                                                              |                                                                                                                                                                                                      |
| `canvas.sidebar`                 | implemented    | `components/canvas/*`                                                                              |                                                                                                                                                                                                      |
| `panel.header`                   | implemented    | generic panel shell                                                                                |                                                                                                                                                                                                      |
| `panel.footer`                   | implemented    | generic panel shell                                                                                |                                                                                                                                                                                                      |
| `settings.general`               | implemented    | `components/settings/general-section.tsx`                                                          |                                                                                                                                                                                                      |
| `settings.appearance`            | implemented    | `components/settings/appearance-section.tsx`                                                       |                                                                                                                                                                                                      |
| `settings.ai`                    | implemented    | `components/settings/ai-section.tsx`                                                               |                                                                                                                                                                                                      |
| `settings.plugins`               | implemented    | `components/settings/sections/plugins-section.tsx`                                                 | Wired in M5A. Lets plugins contribute to the plugin settings panel itself.                                                                                                                           |
| `command-palette`                | implemented    | command palette overlay                                                                            |                                                                                                                                                                                                      |
| `terminal.toolbar`               | implemented    | `components/terminal/terminal-dock.tsx` (tab-strip trailing)                                       | Context: `{ sessionId, transport }`.                                                                                                                                                                 |
| `agent.team.panel`               | implemented    | `components/agent/workspace/overview.tsx` (team overview tab)                                      | Context: `{ teamId, status }`.                                                                                                                                                                       |
| `agent.team.report`              | implemented    | `components/agent/workspace/activity-report/report-plugin-slot.tsx`                                | Custom analytics beneath the native report cards. Context: `{ teamId, reportId, status, traceSessionId, completedTasks, totalTokens }` (ids + redacted aggregates). Placeholder fallback when empty. |
| `agent.teammate.actions`         | implemented    | `components/agent/workspace/members.tsx` (per-teammate dropdown)                                   | Teammate-scoped actions inside each member's `…` menu. Context: `{ teamId, teammateId, role, status, runtime, specialization }` (ids/enums only).                                                    |
| `agent.external-session.toolbar` | implemented    | `components/agent/external-agent/session-panel.tsx` (live run header)                              | Controls in the ACP/OpenCode/Codex live-session toolbar. Context: `{ sessionId, isExecuting, hasPlan, hasCommands }`. Panel relaxes its empty-state early-return when a plugin contributes.          |
| `chat.tool-call.actions`         | implemented    | `components/chat/message-renderer.tsx` (beneath each tool call)                                    | Context: `{ toolName, toolState, toolInput, messageId, sessionId }`. `toolInput` is raw/unredacted — don't re-emit it to an untrusted sink. Per-call inspect/debug/export/rerun.                     |
| `chat.message-part.actions`      | implemented    | `components/chat/message-renderer.tsx` (beneath a plugin part)                                     | UI companion to `provider.message-renderer`. Context: `{ partType, messageId, sessionId, isStreaming }`.                                                                                             |
| `twin.panel.header`              | implemented    | `components/twin/twin-plugin-slots.tsx` → `components/twin/twin-panel.tsx` (header)                | Digital Twin workbench header toolbar actions. Context: `{ twinId, tab }`. Renders nothing when empty.                                                                                               |
| `twin.persona.panel`             | implemented    | `components/twin/twin-plugin-slots.tsx` → `components/twin/twin-persona-tab.tsx` (below sub-tabs)  | Persona insight panel. Context: `{ twinId, entityCount, playbookCount, styleCount }` (ids + aggregates only). Renders nothing when empty.                                                            |
| `twin.settings.cards`            | implemented    | `components/twin/twin-plugin-slots.tsx` → `components/twin/twin-settings-tab.tsx` (foot of column) | Extra card at the foot of the Settings column. Context: `{ twinId }`. Renders nothing when empty.                                                                                                    |
| `twin.overview.panel`            | implemented    | `components/twin/twin-plugin-slots.tsx` → `components/twin/twin-overview-card.tsx` (below charts)  | Metric tile alongside the overview charts. Context: `{ twinId, sourceCount, chunkCount }` (ids + aggregates only). Renders nothing when empty.                                                       |

### Deprecated aliases

The validator translates legacy IDs to the canonical form (warning diagnostic):

| Alias             | Canonical              | Notes                                                |
| ----------------- | ---------------------- | ---------------------------------------------------- |
| `sidebar:top`     | `sidebar.left.top`     |                                                      |
| `sidebar:bottom`  | `sidebar.left.bottom`  |                                                      |
| `toolbar:actions` | `toolbar.right`        |                                                      |
| `chat:input`      | `chat.input.actions`   |                                                      |
| `message:actions` | `chat.message.actions` | (target also deprecated — use `chat.message.footer`) |
| `settings:panel`  | `settings.plugins`     |                                                      |
| `header:right`    | `chat.header`          |                                                      |
| `footer:left`     | `chat.footer`          |                                                      |
| `context:menu`    | `chat.message.actions` | (target also deprecated)                             |

---

## Lifecycle Hooks (102)

All hooks are dispatched through `lib/plugin/messaging/hooks-system.ts`
(`getPluginLifecycleHooks().dispatchOn*()`). Each hook below lists the
**file that calls the dispatcher** — that's the integration point.

For payload schemas, see `types/plugin/plugin.ts:PluginHooks`.

### Plugin lifecycle (5)

| Hook             | Dispatched by                                     |
| ---------------- | ------------------------------------------------- |
| `onLoad`         | `lib/plugin/core/loader.ts`                       |
| `onEnable`       | `lib/plugin/core/manager.ts:enablePlugin`         |
| `onDisable`      | `lib/plugin/core/manager.ts:disablePlugin`        |
| `onUnload`       | `lib/plugin/core/loader.ts:unloadPlugin`          |
| `onConfigChange` | `lib/plugin/core/manager.ts` (config update path) |

### A2UI (4)

| Hook                   | Dispatched by                      |
| ---------------------- | ---------------------------------- |
| `onA2UISurfaceCreate`  | `lib/plugin/bridge/a2ui-bridge.ts` |
| `onA2UISurfaceDestroy` | `lib/plugin/bridge/a2ui-bridge.ts` |
| `onA2UIAction`         | `lib/plugin/bridge/a2ui-bridge.ts` |
| `onA2UIDataChange`     | `lib/plugin/bridge/a2ui-bridge.ts` |

### Agent (5)

| Hook                      | Dispatched by                                                                  |
| ------------------------- | ------------------------------------------------------------------------------ |
| `onAgentStart`            | `lib/claude/sync.ts` (or SDK pump in `hooks/use-claude-chat.ts`) — wired in M3 |
| `onAgentStep`             | same as above                                                                  |
| `onAgentToolCall`         | same as above                                                                  |
| `onAgentComplete`         | same as above                                                                  |
| `onAgentError`            | same as above                                                                  |
| `onAgentPlanCreate`       | **deprecated** (ADR 0016 P1-5, 2026-05-17) — moved to `DEPRECATED_HOOK_POINTS` |
| `onAgentPlanStepComplete` | **deprecated** (ADR 0016 P1-5, 2026-05-17) — moved to `DEPRECATED_HOOK_POINTS` |

### Messages (5)

| Hook               | Dispatched by                                                                                                                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onMessageSend`    | **registered, not dispatched** — the streaming chat path has no pre-send full-message transform seam. Use `onUserPromptSubmit` (wired, `hooks/chat/use-claude-chat.ts`) to gate/modify outgoing messages. |
| `onMessageReceive` | **registered, not dispatched** — the streaming path commits the assistant message incrementally, so a pre-display transform can't run. Use `onPostChatReceive` (wired) for post-turn observation.         |
| `onMessageRender`  | `components/chat/message.tsx`                                                                                                                                                                             |
| `onMessageDelete`  | session ops                                                                                                                                                                                               |
| `onMessageEdit`    | session ops                                                                                                                                                                                               |

### Sessions (5)

| Hook                | Dispatched by                                              |
| ------------------- | ---------------------------------------------------------- |
| `onSessionCreate`   | `lib/sessions/*`                                           |
| `onSessionSwitch`   | `lib/sessions/*`                                           |
| `onSessionDelete`   | `lib/sessions/*`                                           |
| `onSessionRename`   | `lib/sessions/*`                                           |
| `onSessionClear`    | `lib/sessions/*`                                           |
| `onSessionLinked`   | `stores/project/project-store.ts:addSessionToProject`      |
| `onSessionUnlinked` | `stores/project/project-store.ts:removeSessionFromProject` |

### Commands & chat flow (4)

| Hook                   | Dispatched by                                             |
| ---------------------- | --------------------------------------------------------- |
| `onCommand`            | `lib/chat/slash-command-registry.ts:dispatchSlashCommand` |
| `onChatRegenerate`     | retry flow                                                |
| `onModelSwitch`        | model picker                                              |
| `onChatModeSwitch`     | mode picker                                               |
| `onSystemPromptChange` | character / mode change                                   |

### Scheduled tasks (9) — already wired

| Hook                       | Dispatched by                           |
| -------------------------- | --------------------------------------- |
| `onScheduledTaskStart`     | `lib/scheduler/task-scheduler.ts:789` ✓ |
| `onScheduledTaskComplete`  | `lib/scheduler/task-scheduler.ts:858` ✓ |
| `onScheduledTaskError`     | `lib/scheduler/task-scheduler.ts:863` ✓ |
| `onScheduledTaskBeforeRun` | `lib/scheduler/task-scheduler.ts:919` ✓ |
| `onScheduledTaskCreate`    | scheduler CRUD path                     |
| `onScheduledTaskUpdate`    | scheduler CRUD path                     |
| `onScheduledTaskDelete`    | scheduler CRUD path                     |
| `onScheduledTaskPause`     | scheduler control path                  |
| `onScheduledTaskResume`    | scheduler control path                  |

### Project & knowledge (6)

| Hook                      | Dispatched by                                         |
| ------------------------- | ----------------------------------------------------- |
| `onProjectCreate`         | `stores/project/project-store.ts:createProject`       |
| `onProjectUpdate`         | `stores/project/project-store.ts:updateProject`       |
| `onProjectDelete`         | `stores/project/project-store.ts:deleteProject`       |
| `onProjectSwitch`         | `stores/project/project-store.ts:setActiveProject`    |
| `onKnowledgeFileAdd`      | `stores/project/project-store.ts:addKnowledgeFile`    |
| `onKnowledgeFileRemove`   | `stores/project/project-store.ts:removeKnowledgeFile` |
| `onProjectExportStart`    | `lib/plugin/api/export-api.ts:exportProject`          |
| `onProjectExportComplete` | `lib/plugin/api/export-api.ts:exportProject`          |

### Canvas (8)

The canvas event source is `stores/artifact/artifact-store.ts` — the
artifact store owns canvas documents in cognia-next. `onCanvasContentChange`
and `onCanvasSelection` are high-frequency; both go through
`lib/plugin/security/rate-limiter.ts:getPluginRateLimiter().check(...)`
under the synthetic owner `__host:canvas__` (cap 30/sec, refill 30/sec).

| Hook                     | Dispatched by                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| `onCanvasCreate`         | `stores/artifact/artifact-store.ts:createCanvasDocument`                                              |
| `onCanvasUpdate`         | `stores/artifact/artifact-store.ts:updateCanvasDocument`                                              |
| `onCanvasDelete`         | `stores/artifact/artifact-store.ts:deleteCanvasDocument`                                              |
| `onCanvasSwitch`         | `stores/artifact/artifact-store.ts:setActiveCanvas` + `createCanvasDocument` + `deleteCanvasDocument` |
| `onCanvasContentChange`  | `stores/artifact/artifact-store.ts:updateCanvasDocument` (rate-limited)                               |
| `onCanvasVersionSave`    | `stores/artifact/artifact-store.ts:saveCanvasVersion`                                                 |
| `onCanvasVersionRestore` | `stores/artifact/artifact-store.ts:restoreCanvasVersion`                                              |
| `onCanvasSelection`      | `stores/artifact/artifact-store.ts:updateCanvasDocument` (editorContext.selection, rate-limited)      |

### Artifact (7)

| Hook                | Dispatched by                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `onArtifactCreate`  | artifact pipeline                                                                                                               |
| `onArtifactUpdate`  | artifact pipeline                                                                                                               |
| `onArtifactDelete`  | artifact pipeline                                                                                                               |
| `onArtifactOpen`    | artifact viewer                                                                                                                 |
| `onArtifactClose`   | artifact viewer                                                                                                                 |
| `onArtifactExecute` | **deprecated** (ADR 0016 P1-5, 2026-05-17) — no artifact runner shipped; moved to `DEPRECATED_HOOK_POINTS`                      |
| `onArtifactExport`  | **deprecated** (ADR 0016 P1-5, 2026-05-17) — artifact-specific export pipeline never shipped; moved to `DEPRECATED_HOOK_POINTS` |

### Export (3)

| Hook                | Dispatched by                                                                        |
| ------------------- | ------------------------------------------------------------------------------------ |
| `onExportStart`     | `hooks/data/use-single-export.ts:run` + `lib/plugin/api/export-api.ts:exportSession` |
| `onExportComplete`  | `hooks/data/use-single-export.ts:run` + `lib/plugin/api/export-api.ts:exportSession` |
| `onExportTransform` | `hooks/data/use-single-export.ts:run` + `lib/plugin/api/export-api.ts:performExport` |

### Theme (3 — all demoted)

| Hook                    | Status      | Notes                                                                                                |
| ----------------------- | ----------- | ---------------------------------------------------------------------------------------------------- |
| `onThemeModeChange`     | **demoted** | Host event source `setTheme` lives in `stores/settings/settings-store.ts`. See ADR 0016.             |
| `onColorPresetChange`   | **demoted** | Host event source `setColorTheme` lives in `stores/settings/settings-store.ts`. See ADR 0016.        |
| `onCustomThemeActivate` | **demoted** | Host event source `setActiveCustomTheme` lives in `stores/settings/settings-store.ts`. See ADR 0016. |

### Stream / chat request (5)

| Hook            | Dispatched by                                         |
| --------------- | ----------------------------------------------------- |
| `onChatRequest` | `lib/claude/sync.ts` request build site — wired in M3 |
| `onStreamStart` | SDK pump — wired in M3                                |
| `onStreamChunk` | SDK pump — wired in M3                                |
| `onStreamEnd`   | SDK pump — wired in M3                                |
| `onChatError`   | SDK pump — wired in M3                                |
| `onTokenUsage`  | SDK pump usage event — wired in M3                    |

### Tool use (3)

| Hook                 | Dispatched by                                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onUserPromptSubmit` | composer send path — wired in M4                                                                                                                                                      |
| `onPreToolUse`       | SDK tool-use intercept — wired in M3                                                                                                                                                  |
| `onPostToolUse`      | SDK tool-result intercept — wired in M3                                                                                                                                               |
| `onPreCompact`       | compaction step (if any)                                                                                                                                                              |
| `onPostChatReceive`  | `hooks/chat/use-claude-chat.ts` — fired once the assistant turn seals (no pending approvals); carries the sealed assistant `PluginMessage`. The canonical post-turn observation seam. |

### RAG (3)

| Hook                    | Dispatched by                                                                     |
| ----------------------- | --------------------------------------------------------------------------------- |
| `onDocumentsIndexed`    | `lib/vector/store.ts:wrapVectorStoreWithPluginHooks` (proxy on `addDocuments`)    |
| `onVectorSearch`        | `lib/vector/store.ts:wrapVectorStoreWithPluginHooks` (proxy on `searchDocuments`) |
| `onRAGContextRetrieved` | `lib/twin/runtime/apply-twin-context.ts:applyTwinContext` (after retrieval)       |

### Workflow (4)

| Hook                     | Dispatched by                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------------- |
| `onWorkflowStart`        | `lib/workflow/runtime/orchestrator.ts:runWorkflow` (after validation, before first step)     |
| `onWorkflowStepComplete` | `lib/workflow/runtime/orchestrator.ts:runWorkflow` (after each step's `stepOutputs.set`)     |
| `onWorkflowComplete`     | `lib/workflow/runtime/orchestrator.ts:runWorkflow` (success path + failure paths, both fire) |
| `onWorkflowError`        | `lib/workflow/runtime/orchestrator.ts:runWorkflow` (validation, topo-sort, step failures)    |

### UI interaction (5)

| Hook                | Dispatched by                                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `onSidebarToggle`   | `stores/ui/ui-store.ts:toggleSidebar` + `setSidebarCollapsed`                                                                       |
| `onPanelOpen`       | `stores/artifact/artifact-store.ts:openPanel` (panel id = `artifact:<view>`)                                                        |
| `onPanelClose`      | `stores/artifact/artifact-store.ts:closePanel` (panel id = `artifact:<view>`)                                                       |
| `onShortcut`        | `components/desktop/zoom-shortcuts.tsx` (`zoom.in/out/reset`) + `components/desktop/command-palette.tsx` (`command-palette.toggle`) |
| `onContextMenuShow` | `components/a2ui/overlay/a2ui-context-menu.tsx` + `components/artifacts/artifact-list.tsx` (via `<ContextMenu onOpenChange>`)       |

### External agent (7)

| Hook                               | Dispatched by             |
| ---------------------------------- | ------------------------- |
| `onExternalAgentConnect`           | `lib/ai/agent/external/*` |
| `onExternalAgentDisconnect`        | same                      |
| `onExternalAgentExecutionStart`    | same                      |
| `onExternalAgentExecutionComplete` | same                      |
| `onExternalAgentPermissionRequest` | same                      |
| `onExternalAgentToolCall`          | same                      |
| `onExternalAgentError`             | same                      |

### Code execution (3)

| Hook                      | Dispatched by                                                                |
| ------------------------- | ---------------------------------------------------------------------------- |
| `onCodeExecutionStart`    | `lib/tauri/canvas.ts:runPython` (Tauri sandbox bridge — `language="python"`) |
| `onCodeExecutionComplete` | `lib/tauri/canvas.ts:runPython` (after Tauri command resolves)               |
| `onCodeExecutionError`    | `lib/tauri/canvas.ts:runPython` (catch branch)                               |

### MCP (4)

| Hook                    | Dispatched by                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `onMCPServerConnect`    | `lib/workflow/nodes/built-ins.ts` (`action.mcp.invokeTool`, after `client.connect`) |
| `onMCPServerDisconnect` | `lib/workflow/nodes/built-ins.ts` (`action.mcp.invokeTool`, finally block)          |
| `onMCPToolCall`         | `lib/workflow/nodes/built-ins.ts` (`action.mcp.invokeTool`, before `callTool`)      |
| `onMCPToolResult`       | `lib/workflow/nodes/built-ins.ts` (`action.mcp.invokeTool`, after `callTool`)       |

---

## Activation Patterns (10)

| Pattern          | Status         | Notes                                                           |
| ---------------- | -------------- | --------------------------------------------------------------- |
| `startup`        | implemented    | Plugin activates at app start.                                  |
| `onStartup`      | **deprecated** | Legacy alias — use `startup`.                                   |
| `onCommand:*`    | implemented    | Activates when a slash command is invoked.                      |
| `onTool:*`       | implemented    | Activates when an agent tool is called.                         |
| `onAgentTool:*`  | **deprecated** | Legacy alias — use `onTool:*`.                                  |
| `onChat:*`       | **deprecated** | Retired — use `onMessageSend`/`onMessageReceive` hook handlers. |
| `onAgent:start`  | **deprecated** | Retired — use `onAgentStart` hook.                              |
| `onA2UI:surface` | **deprecated** | Retired — use `onA2UISurfaceCreate` hook or `startup`.          |
| `onLanguage:*`   | **deprecated** | Retired — declare `startup` and filter inside.                  |
| `onFile:*`       | **deprecated** | Retired — declare `startup` and filter inside.                  |

Activation events are dispatched in `lib/plugin/core/manager.ts:handleActivationEvent`.

---

## Permission gating per point

Every UI point has `permission: "extension:ui"` (declared in
`extensionPointContracts`). Hook contracts have no permission gate (host
controls dispatch). Activation patterns are not permission-gated.

For host-side enforcement of plugin permissions when calling Cognia APIs
(filesystem, network, clipboard, etc.), see
`lib/plugin/security/permission-guard.ts` and the gateway wrappers in
`lib/files/file-bridge.ts` (M2) and `lib/native/opener.ts` (M2).

---

## Audit

Run `auditPluginPointContracts()` (declared in `plugin-points.ts`) to
verify each `implemented` contract has a non-empty `binding`, `docs`,
and `requiredTests`. Any missing field surfaces as `proofStatus:
"missing_proof"` in the audit output. The result is rendered in the
`audit` sub-tab of the Plugins settings page (M5A).

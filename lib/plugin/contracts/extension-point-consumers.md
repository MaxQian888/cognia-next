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

## UI Extension Points (30)

UI slots are rendered by `<PluginExtensionSlot point="..."/>`
(see `components/plugins/plugin-extension-slot.tsx`) which internally
calls `getExtensionsForPoint()` from `lib/plugin/api/extension-api.ts`.

| Point                  | Status         | Host Consumer                                                       | Notes                                                                      |
| ---------------------- | -------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `sidebar.left.top`     | implemented    | `components/sidebar/app-sidebar.tsx` (top region)                   | Always-mounted.                                                            |
| `sidebar.left.bottom`  | implemented    | `components/sidebar/app-sidebar.tsx` (footer region)                | Always-mounted.                                                            |
| `sidebar.right.top`    | **deprecated** | none                                                                | Retired in 0.2.0. Use `sidebar.left.top`.                                  |
| `sidebar.right.bottom` | **deprecated** | none                                                                | Retired in 0.2.0. Use `sidebar.left.bottom`.                               |
| `toolbar.left`         | implemented    | top toolbar (left aligned section)                                  |                                                                            |
| `toolbar.center`       | implemented    | top toolbar (center aligned section)                                |                                                                            |
| `toolbar.right`        | implemented    | top toolbar (right aligned section)                                 |                                                                            |
| `statusbar.left`       | implemented    | bottom status bar (left)                                            |                                                                            |
| `statusbar.center`     | implemented    | bottom status bar (center)                                          |                                                                            |
| `statusbar.right`      | implemented    | bottom status bar (right)                                           |                                                                            |
| `chat.header`          | implemented    | `components/chat/header/*`                                          | Above messages list.                                                       |
| `chat.footer`          | implemented    | `components/chat/*` (below messages list, above composer)           |                                                                            |
| `chat.input.above`     | implemented    | `components/chat/composer.tsx` (above input box)                    | Wired in M4.                                                               |
| `chat.input.below`     | implemented    | `components/chat/composer.tsx` (below input box)                    | Wired in M4.                                                               |
| `chat.input.actions`   | implemented    | `components/chat/composer/bottom-toolbar.tsx` (next to send button) | Wired in M4 via `plugin-toolbar-slot.tsx` (limit 3 + overflow).            |
| `chat.message.before`  | implemented    | `components/chat/message.tsx` (before message body)                 | Wired in M4.                                                               |
| `chat.message.after`   | implemented    | `components/chat/message.tsx` (after message body)                  | Wired in M4.                                                               |
| `chat.message.actions` | **deprecated** | none                                                                | Retired in 0.2.0. Use `chat.message.footer`.                               |
| `chat.message.footer`  | implemented    | `components/chat/message.tsx` (per-message action row)              | Use this for action buttons.                                               |
| `artifact.toolbar`     | implemented    | `components/ai-elements/artifact*`                                  |                                                                            |
| `artifact.actions`     | implemented    | `components/ai-elements/artifact*`                                  |                                                                            |
| `canvas.toolbar`       | implemented    | `components/canvas/*`                                               |                                                                            |
| `canvas.sidebar`       | implemented    | `components/canvas/*`                                               |                                                                            |
| `panel.header`         | implemented    | generic panel shell                                                 |                                                                            |
| `panel.footer`         | implemented    | generic panel shell                                                 |                                                                            |
| `settings.general`     | implemented    | `components/settings/general-section.tsx`                           |                                                                            |
| `settings.appearance`  | implemented    | `components/settings/appearance-section.tsx`                        |                                                                            |
| `settings.ai`          | implemented    | `components/settings/ai-section.tsx`                                |                                                                            |
| `settings.plugins`     | implemented    | `components/settings/sections/plugins-section.tsx`                  | Wired in M5A. Lets plugins contribute to the plugin settings panel itself. |
| `command-palette`      | implemented    | command palette overlay                                             |                                                                            |

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
| `onAgentPlanCreate`       | future planner hook (currently unused)                                         |
| `onAgentPlanStepComplete` | future planner hook                                                            |

### Messages (5)

| Hook               | Dispatched by                                                               |
| ------------------ | --------------------------------------------------------------------------- |
| `onMessageSend`    | `components/chat/composer.tsx` (`buildSendContent` send path) — wired in M4 |
| `onMessageReceive` | `lib/claude/sync.ts` SDK message receipt — wired in M3                      |
| `onMessageRender`  | `components/chat/message.tsx`                                               |
| `onMessageDelete`  | session ops                                                                 |
| `onMessageEdit`    | session ops                                                                 |

### Sessions (5)

| Hook                | Dispatched by        |
| ------------------- | -------------------- |
| `onSessionCreate`   | `lib/sessions/*`     |
| `onSessionSwitch`   | `lib/sessions/*`     |
| `onSessionDelete`   | `lib/sessions/*`     |
| `onSessionRename`   | `lib/sessions/*`     |
| `onSessionClear`    | `lib/sessions/*`     |
| `onSessionLinked`   | session-link feature |
| `onSessionUnlinked` | session-link feature |

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

| Hook                      | Dispatched by    |
| ------------------------- | ---------------- |
| `onProjectCreate`         | `lib/projects/*` |
| `onProjectUpdate`         | `lib/projects/*` |
| `onProjectDelete`         | `lib/projects/*` |
| `onProjectSwitch`         | `lib/projects/*` |
| `onKnowledgeFileAdd`      | knowledge ingest |
| `onKnowledgeFileRemove`   | knowledge ingest |
| `onProjectExportStart`    | export pipeline  |
| `onProjectExportComplete` | export pipeline  |

### Canvas (8)

| Hook                     | Dispatched by     |
| ------------------------ | ----------------- |
| `onCanvasCreate`         | `lib/canvas/*`    |
| `onCanvasUpdate`         | `lib/canvas/*`    |
| `onCanvasDelete`         | `lib/canvas/*`    |
| `onCanvasSwitch`         | `lib/canvas/*`    |
| `onCanvasContentChange`  | canvas editor     |
| `onCanvasVersionSave`    | canvas versioning |
| `onCanvasVersionRestore` | canvas versioning |
| `onCanvasSelection`      | canvas editor     |

### Artifact (7)

| Hook                | Dispatched by     |
| ------------------- | ----------------- |
| `onArtifactCreate`  | artifact pipeline |
| `onArtifactUpdate`  | artifact pipeline |
| `onArtifactDelete`  | artifact pipeline |
| `onArtifactOpen`    | artifact viewer   |
| `onArtifactClose`   | artifact viewer   |
| `onArtifactExecute` | artifact runner   |
| `onArtifactExport`  | export pipeline   |

### Export (3)

| Hook                | Dispatched by   |
| ------------------- | --------------- |
| `onExportStart`     | export pipeline |
| `onExportComplete`  | export pipeline |
| `onExportTransform` | export pipeline |

### Theme (3)

| Hook                    | Dispatched by  |
| ----------------------- | -------------- |
| `onThemeModeChange`     | theme switcher |
| `onColorPresetChange`   | theme switcher |
| `onCustomThemeActivate` | theme switcher |

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

| Hook                 | Dispatched by                           |
| -------------------- | --------------------------------------- |
| `onUserPromptSubmit` | composer send path — wired in M4        |
| `onPreToolUse`       | SDK tool-use intercept — wired in M3    |
| `onPostToolUse`      | SDK tool-result intercept — wired in M3 |
| `onPreCompact`       | compaction step (if any)                |
| `onPostChatReceive`  | post-receive pipeline — wired in M3     |

### RAG (3)

| Hook                    | Dispatched by  |
| ----------------------- | -------------- |
| `onDocumentsIndexed`    | indexer        |
| `onVectorSearch`        | search service |
| `onRAGContextRetrieved` | RAG runtime    |

### Workflow (4)

| Hook                     | Dispatched by    |
| ------------------------ | ---------------- |
| `onWorkflowStart`        | workflow runtime |
| `onWorkflowStepComplete` | workflow runtime |
| `onWorkflowComplete`     | workflow runtime |
| `onWorkflowError`        | workflow runtime |

### UI interaction (5)

| Hook                | Dispatched by       |
| ------------------- | ------------------- |
| `onSidebarToggle`   | sidebar shell       |
| `onPanelOpen`       | panel host          |
| `onPanelClose`      | panel host          |
| `onShortcut`        | keybindings runtime |
| `onContextMenuShow` | context menu host   |

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

| Hook                      | Dispatched by |
| ------------------------- | ------------- |
| `onCodeExecutionStart`    | code runner   |
| `onCodeExecutionComplete` | code runner   |
| `onCodeExecutionError`    | code runner   |

### MCP (4)

| Hook                    | Dispatched by |
| ----------------------- | ------------- |
| `onMCPServerConnect`    | MCP service   |
| `onMCPServerDisconnect` | MCP service   |
| `onMCPToolCall`         | MCP service   |
| `onMCPToolResult`       | MCP service   |

---

## Activation Patterns (11)

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

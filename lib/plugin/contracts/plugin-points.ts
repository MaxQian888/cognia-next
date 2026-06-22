/**
 * Canonical plugin point contract registry.
 *
 * This module is the single source of truth for:
 * - UI extension point IDs
 * - Hook IDs
 * - Activation event patterns
 *
 * Runtime validators, SDK parity checks, docs, and audit scripts should consume
 * these definitions to avoid contract drift.
 */

export type PluginPointKind = "ui-slot" | "hook" | "activation" | "runtime"
export type PluginPointStability = "stable" | "experimental" | "deprecated"
export type PluginPointStatus = "implemented" | "virtual" | "deprecated"
export type PluginPointGovernanceMode = "warn" | "block"

export type PluginPointHostKind = "jsx-mount" | "registration"

export interface PluginPointContract {
  id: string
  kind: PluginPointKind
  stability: PluginPointStability
  status: PluginPointStatus
  /**
   * For ui-slot points only: how the host surfaces the slot.
   *
   * - `jsx-mount` (default): the host renders `<PluginExtensionSlot point="…" />`
   *   somewhere; the static slot audit requires ≥1 such JSX mount when
   *   status is `implemented`.
   * - `registration`: the host is a non-JSX surface (e.g. an iframe wrapper
   *   that registers panels via a bridge function such as `attachHostFrame`).
   *   The audit verifies the `binding` file exists on disk rather than
   *   counting JSX mounts.
   *
   * Hook / runtime / activation contracts leave this undefined.
   */
  hostKind?: PluginPointHostKind
  owner: string
  binding: string
  docs: string
  requiredTests: readonly string[]
  introducedIn: string
  deprecatedIn?: string
  replacementId?: string
  retirementNote?: string
  permission?: string
  aliases?: readonly string[]
}

export interface PluginPointProofAudit {
  id: string
  kind: PluginPointKind
  status: PluginPointStatus
  binding: string
  docs: string
  requiredTests: readonly string[]
  missingFields: Array<"binding" | "docs" | "requiredTests">
  proofStatus: "verified" | "missing_proof" | "not_applicable"
}

export interface PluginPointDiagnostic {
  code:
    | "plugin.point.unknown"
    | "plugin.point.deprecated"
    | "plugin.point.alias"
    | "plugin.point.virtual"
    | "plugin.point.permission_denied"
    | "plugin.silent-failure"
    // A later plugin's contribution was rejected because an earlier plugin
    // already owns the same tool/command/component key (first-wins policy).
    | "plugin.conflict.rejected"
    // Required/optional dependency resolution outcomes surfaced at enable time
    // (see lib/plugin/core/load-order.ts).
    | "plugin.dependency.missing"
    | "plugin.dependency.disabled"
    | "plugin.dependency.version-mismatch"
    | "plugin.dependency.cycle"
    | "plugin.dependency.optional-degraded"
  severity: "warning" | "error"
  message: string
  pointKind: PluginPointKind
  pointId: string
  canonicalId?: string
  hint?: string
}

export interface PluginPointValidationOutcome {
  allowed: boolean
  canonicalId?: string
  contract?: PluginPointContract
  diagnostics: PluginPointDiagnostic[]
}

interface PluginPointValidationOptions {
  governanceMode?: PluginPointGovernanceMode
  hasPermission?: (permission: string) => boolean
}

export const CANONICAL_EXTENSION_POINTS = [
  "sidebar.left.top",
  "sidebar.left.bottom",
  "sidebar.right.top",
  "sidebar.right.bottom",
  "toolbar.left",
  "toolbar.center",
  "toolbar.right",
  "statusbar.left",
  "statusbar.center",
  "statusbar.right",
  "chat.header",
  "chat.footer",
  "chat.input.above",
  "chat.input.below",
  "chat.input.actions",
  // ADR-0026 §3 §C — composer dropdown groups. Lives next to (not
  // replacing) `chat.input.actions` so flat buttons and menu groups can
  // coexist in the composer toolbar.
  "chat.input.menu",
  "chat.message.before",
  "chat.message.after",
  "chat.message.actions",
  "chat.message.footer",
  // Per-tool-call action row — plugins mount controls beneath an individual
  // tool call (inspect / debug / export / rerun) without forking the message
  // renderer. Context bag: `toolName` / `toolState` / `toolInput` /
  // `messageId` / `sessionId`. Companion to the message-level
  // `chat.message.actions` (which targets the whole message).
  "chat.tool-call.actions",
  // Per-message-part action row — UI companion to the
  // `provider.message-renderer` runtime point: plugins that register a custom
  // part TYPE can also mount actions beneath any rendered part. Context bag:
  // `partType` / `messageId` / `sessionId` / `isStreaming`.
  "chat.message-part.actions",
  "artifact.toolbar",
  "artifact.actions",
  "canvas.toolbar",
  "canvas.sidebar",
  // Goal surfaces. `goal.toolbar` is the /goals route header; `goal.detail.actions`
  // is the action row in the goal detail sheet. Both receive a `context` bag
  // with `goalId` / `status`.
  "goal.toolbar",
  "goal.detail.actions",
  // Performance dashboard — plugins mount a tile/panel (e.g. a custom metric)
  // alongside the native Rust-sampled graphs.
  "perf.panel",
  // Integrated terminal — plugins mount controls in the terminal dock's
  // trailing toolbar (next to the shell picker / close). Each contribution
  // receives a `context` bag with `sessionId` + `transport`.
  "terminal.toolbar",
  // Agent-Team workspace — plugins mount an insight/governance panel in the
  // team overview tab (alongside the consensus/delegation views). Context bag:
  // `teamId` + `status`.
  "agent.team.panel",
  // Agent-Team execution report — plugins mount a custom analytics section
  // beneath the native KPI / taskline / token-burn cards in the activity
  // report. Companion to `agent.team.panel` (governance) but report-scoped.
  // Context bag: `teamId` / `reportId` / `status` / `traceSessionId` /
  // `completedTasks` / `totalTokens` (ids + redacted aggregates only).
  "agent.team.report",
  // Per-teammate action row — plugins mount teammate-scoped controls inside
  // each member's dropdown menu in the members panel (e.g. open transcript /
  // send directive / attach a capability). Context bag: `teamId` /
  // `teammateId` / `role` / `status` / `runtime` / `specialization`.
  "agent.teammate.actions",
  // External-agent live session toolbar — plugins mount controls in the
  // ACP/OpenCode/Codex run header (next to commands / config / fork) during a
  // live external-agent session. Context bag: `sessionId` / `isExecuting` /
  // `hasPlan` / `hasCommands`.
  "agent.external-session.toolbar",
  "panel.header",
  "panel.footer",
  "settings.general",
  "settings.appearance",
  "settings.ai",
  "settings.plugins",
  "command-palette",
  // Inbox surface (IM-completion §C). Each slot is conversation-scoped:
  // contributions receive a `context` prop with `conversationKey`,
  // `adapterId`, `platform`, `draftId` (where applicable) so plugins
  // don't have to re-derive identifiers.
  "inbox.sidebar.section",
  "inbox.conversation.actions",
  "inbox.composer.actions",
  "inbox.draft.actions",
  // VS Code extension reuse layer (see ~/.claude/plans/vscode-snug-squid.md).
  // These slots host UI contributed by VS Code extensions running in the Node
  // sidecar — distinct from cognia-native sidebar/toolbar slots so plugin-vs-
  // extension UI never silently clobbers each other.
  "vscode.sidebar.view",
  "vscode.webview.panel",
  "vscode.activity-bar",
  "vscode.terminal.output",
] as const

export type CanonicalExtensionPoint = (typeof CANONICAL_EXTENSION_POINTS)[number]

const IMPLEMENTED_EXTENSION_POINTS = new Set<CanonicalExtensionPoint>([
  "sidebar.left.top",
  "sidebar.left.bottom",
  "toolbar.left",
  "toolbar.center",
  "toolbar.right",
  "statusbar.left",
  "statusbar.center",
  "statusbar.right",
  "chat.header",
  "chat.footer",
  "chat.input.above",
  "chat.input.below",
  "chat.input.actions",
  "chat.input.menu",
  "chat.message.before",
  "chat.message.after",
  "chat.message.actions",
  "chat.message.footer",
  "chat.tool-call.actions",
  "chat.message-part.actions",
  "artifact.toolbar",
  "artifact.actions",
  "canvas.toolbar",
  "canvas.sidebar",
  "goal.toolbar",
  "goal.detail.actions",
  "perf.panel",
  "terminal.toolbar",
  "agent.team.panel",
  "agent.team.report",
  "agent.teammate.actions",
  "agent.external-session.toolbar",
  "settings.general",
  "settings.appearance",
  "settings.ai",
  "settings.plugins",
  "command-palette",
  "inbox.sidebar.section",
  "inbox.conversation.actions",
  "inbox.composer.actions",
  "inbox.draft.actions",
  // VS Code reuse layer — non-JSX mounts but fully implemented at runtime.
  // See the VIRTUAL_EXTENSION_POINTS comment below for why these aren't
  // in the audit's JSX-mount scanner's universe.
  "vscode.sidebar.view",
  "vscode.webview.panel",
  "vscode.activity-bar",
  "vscode.terminal.output",
])

// VS Code extension slots are wired through `components/extensions/
// vscode-extension-panel.tsx` (sidebar/webview/activity-bar) and
// `components/providers/initializers/terminal-bridge-initializer.tsx`
// (terminal output — surfaces extension-spawned terminals as tabs in
// `<TerminalDock>`). Both are direct registration hosts rather than a
// `<PluginExtensionSlot>` JSX mount. They are fully functional at
// runtime, so the contract reports `status: "implemented"` with their
// explicit binding files in `IMPLEMENTED_EXTENSION_POINT_BINDINGS`
// below, and the `REGISTRATION_HOST_EXTENSION_POINTS` set below tells
// the slot audit to verify the binding file exists instead of counting
// JSX mounts.
// The Set is kept empty (rather than removed) so future "register without
// JSX mount" slots can be added by id without touching the status logic.
const VIRTUAL_EXTENSION_POINTS = new Set<CanonicalExtensionPoint>()

/**
 * UI-slot points whose host registers panels through a bridge function
 * rather than mounting `<PluginExtensionSlot point="…" />`. The static
 * slot audit branches on this set: instead of expecting ≥1 JSX mount, it
 * checks that the `binding` file exists on disk.
 */
const REGISTRATION_HOST_EXTENSION_POINTS = new Set<CanonicalExtensionPoint>([
  "vscode.sidebar.view",
  "vscode.webview.panel",
  "vscode.activity-bar",
  "vscode.terminal.output",
])

const IMPLEMENTED_EXTENSION_POINT_BINDINGS: Partial<Record<CanonicalExtensionPoint, string>> = {
  "sidebar.left.top": "components/shell/guild-rail.tsx",
  "sidebar.left.bottom": "components/shell/guild-rail.tsx",
  "toolbar.left": "components/desktop/title-bar.tsx",
  "toolbar.center": "components/desktop/title-bar.tsx",
  "toolbar.right": "components/desktop/title-bar.tsx",
  "statusbar.left": "components/desktop/status-bar.tsx",
  "statusbar.center": "components/desktop/status-bar.tsx",
  "statusbar.right": "components/desktop/status-bar.tsx",
  "chat.header": "components/chat/chat-header.tsx",
  "chat.footer": "components/chat/chat-view.tsx",
  "chat.input.above": "components/chat/composer.tsx",
  "chat.input.below": "components/chat/composer.tsx",
  "chat.input.actions": "components/chat/composer/bottom-toolbar.tsx",
  "chat.input.menu": "components/chat/composer/bottom-toolbar.tsx",
  "chat.message.before": "components/chat/message-renderer.tsx",
  "chat.message.after": "components/chat/message-renderer.tsx",
  "chat.message.actions": "components/chat/message-renderer.tsx",
  "chat.message.footer": "components/chat/message-renderer.tsx",
  "chat.tool-call.actions": "components/chat/message-renderer.tsx",
  "chat.message-part.actions": "components/chat/message-renderer.tsx",
  "artifact.toolbar": "components/artifacts/artifact-panel.tsx",
  "artifact.actions": "components/artifacts/artifact-panel.tsx",
  "canvas.toolbar": "components/canvas/canvas-panel.tsx",
  "canvas.sidebar": "components/canvas/canvas-side-panels.tsx",
  "goal.toolbar": "components/goal/console/goal-console.tsx",
  "goal.detail.actions": "components/goal/goal-detail-sheet.tsx",
  "perf.panel": "components/performance/performance-dashboard.tsx",
  "terminal.toolbar": "components/terminal/terminal-dock.tsx",
  "agent.team.panel": "components/agent/workspace/overview.tsx",
  "agent.team.report": "components/agent/workspace/activity-report/report-plugin-slot.tsx",
  "agent.teammate.actions": "components/agent/workspace/members.tsx",
  "agent.external-session.toolbar": "components/agent/external-agent/session-panel.tsx",
  "settings.general": "components/settings/agent-runtime/tabs/defaults-tab.tsx",
  "settings.appearance": "components/settings/appearance/appearance-section.tsx",
  "settings.ai": "components/settings/provider/anthropic-subscription-reuse-card.tsx",
  "settings.plugins": "components/plugins/plugin-panel.tsx",
  "command-palette": "components/desktop/command-palette.tsx",
  "inbox.sidebar.section": "components/inbox/inbox-sidebar.tsx",
  "inbox.conversation.actions": "components/inbox/conversation-row.tsx",
  "inbox.composer.actions": "components/inbox/inbox-composer-actions-host.tsx",
  "inbox.draft.actions": "components/inbox/draft-banner.tsx",
  "vscode.sidebar.view": "components/extensions/vscode-extension-panel.tsx",
  "vscode.webview.panel": "components/extensions/vscode-extension-panel.tsx",
  "vscode.activity-bar": "components/extensions/vscode-extension-panel.tsx",
  "vscode.terminal.output": "components/providers/initializers/terminal-bridge-initializer.tsx",
}

const EXTENSION_POINT_ALIASES: Record<string, CanonicalExtensionPoint> = {
  "sidebar:top": "sidebar.left.top",
  "sidebar:bottom": "sidebar.left.bottom",
  "toolbar:actions": "toolbar.right",
  "chat:input": "chat.input.actions",
  // `chat.message.actions` revived in ADR-0026 §5 §A; aliases still
  // resolve to it.
  "message:actions": "chat.message.actions",
  "settings:panel": "settings.plugins",
  "header:right": "chat.header",
  "footer:left": "chat.footer",
  "context:menu": "chat.message.actions",
}

const UI_POINT_DOCS = "docs/features/plugin-development.md#ui-extension-points"
const HOOK_POINT_DOCS = "docs/features/plugin-development.md#canonical-plugin-point-contract"
const ACTIVATION_POINT_DOCS = "docs/features/plugin-development.md#activation-events"
const UI_POINT_TESTS = [
  "components/plugins/plugin-extension-slot.test.tsx",
  "lib/plugin/contracts/plugin-points.test.ts",
] as const
const HOOK_POINT_TESTS = [
  "lib/plugin/messaging/hooks-system.test.ts",
  "lib/plugin/contracts/plugin-points.test.ts",
] as const
const ACTIVATION_POINT_TESTS = [
  "lib/plugin/core/manager.test.ts",
  "lib/plugin/contracts/plugin-points.test.ts",
] as const
const RUNTIME_POINT_DOCS = "docs/content/docs/adr/0017-workflow-plugin-extension-points.md"
const RUNTIME_POINT_TESTS = [
  "lib/workflow/nodes/registry.test.ts",
  "lib/plugin/contracts/plugin-points.test.ts",
] as const

export const CANONICAL_HOOK_POINTS = [
  "onLoad",
  "onEnable",
  "onDisable",
  "onUnload",
  // Lifecycle stage hooks fired by lib/plugin/core/manager.ts: onInstall (once
  // after first post-install load), onUpdate (version changed across loads),
  // onUninstall (before file removal), onSuspend/onResume (idle deactivation).
  "onInstall",
  "onUninstall",
  "onUpdate",
  "onSuspend",
  "onResume",
  "onConfigChange",
  "onA2UISurfaceCreate",
  "onA2UISurfaceDestroy",
  "onA2UIAction",
  "onA2UIDataChange",
  "onAgentStart",
  "onAgentStep",
  "onAgentComplete",
  "onAgentError",
  "onMessageSend",
  "onMessageReceive",
  "onMessageDelete",
  "onMessageEdit",
  "onSessionCreate",
  "onSessionSwitch",
  "onSessionDelete",
  "onSessionRename",
  "onSessionClear",
  "onCommand",
  "onChatRegenerate",
  "onModelSwitch",
  "onChatModeSwitch",
  "onSystemPromptChange",
  // onAgentPlanCreate, onAgentPlanStepComplete — demoted to
  // DEPRECATED_HOOK_POINTS (ADR 0016 P1-5, 2026-05-17). Reason: no host
  // event source exists; the agent planner is unimplemented. Dispatchers
  // remain so existing plugins compile, but no host fires them.
  "onScheduledTaskStart",
  "onScheduledTaskComplete",
  "onScheduledTaskError",
  "onProjectCreate",
  "onProjectUpdate",
  "onProjectDelete",
  "onProjectSwitch",
  // Goal lifecycle (ADR-0019). Dispatched by lib/goal/runtime.ts,
  // turn-driver.ts, and completion-linkage.ts. Payloads carry only the
  // redacted objective (PII red-line).
  "onGoalCreate",
  "onGoalUpdate",
  "onGoalProgress",
  "onGoalComplete",
  "onGoalDelete",
  // Public share-link lifecycle (ADR-0037). Dispatched by lib/share/client.ts.
  // Owner-observable transitions only — no onShareLinkAccess (reads happen on
  // the worker/viewer, not the owner). URL payload is fragment-stripped.
  "onShareLinkCreate",
  "onShareLinkRevoke",
  "onKnowledgeFileAdd",
  "onKnowledgeFileRemove",
  "onSessionLinked",
  "onSessionUnlinked",
  "onCanvasCreate",
  "onCanvasUpdate",
  "onCanvasDelete",
  "onCanvasSwitch",
  "onCanvasContentChange",
  "onCanvasVersionSave",
  "onCanvasVersionRestore",
  "onCanvasSelection",
  "onArtifactCreate",
  "onArtifactUpdate",
  "onArtifactDelete",
  "onArtifactOpen",
  "onArtifactClose",
  // onArtifactExecute, onArtifactExport — demoted to DEPRECATED_HOOK_POINTS
  // (ADR 0016 P1-5, 2026-05-17). Reason: no artifact runner / export
  // pipeline calls these. `extension-point-consumers.md` line 205-206
  // referenced "artifact runner" / "export pipeline" as future consumers,
  // neither shipped. Dispatchers remain but are not fired by any host.
  "onExportStart",
  "onExportComplete",
  "onExportTransform",
  "onProjectExportStart",
  "onProjectExportComplete",
  // ADR-0026 §4 §B — transform-pipeline hook for the resolved SendOptions
  // dict. Plugins that only want to tweak systemPrompt / maxTokens /
  // allowedTools (without short-circuiting the chain) should prefer this
  // over the heavier around-style chat.middleware contract. Dispatched
  // by `lib/plugin/messaging/hooks-system.ts:dispatchBuildOptions`.
  "onBuildOptions",
  "onStreamStart",
  "onStreamChunk",
  "onStreamEnd",
  "onChatError",
  "onTokenUsage",
  "onUserPromptSubmit",
  "onPreToolUse",
  "onPostToolUse",
  "onPreCompact",
  "onPostChatReceive",
  "onDocumentsIndexed",
  "onVectorSearch",
  "onRAGContextRetrieved",
  "onWorkflowStart",
  "onWorkflowStepComplete",
  "onWorkflowComplete",
  "onWorkflowError",
  "onWorkflowNodeStart",
  "onWorkflowNodeComplete",
  "onWorkflowNodeError",
  "onWorkflowTriggerFired",
  "onSidebarToggle",
  "onPanelOpen",
  "onPanelClose",
  "onShortcut",
  "onContextMenuShow",
  "onScheduledTaskCreate",
  "onScheduledTaskUpdate",
  "onScheduledTaskDelete",
  "onScheduledTaskPause",
  "onScheduledTaskResume",
  "onScheduledTaskBeforeRun",
  "onExternalAgentConnect",
  "onExternalAgentDisconnect",
  "onExternalAgentExecutionStart",
  "onExternalAgentExecutionComplete",
  "onExternalAgentPermissionRequest",
  "onExternalAgentToolCall",
  "onExternalAgentError",
  "onCodeExecutionStart",
  "onCodeExecutionComplete",
  "onCodeExecutionError",
  "onMCPServerConnect",
  "onMCPServerDisconnect",
  "onMCPToolCall",
  "onMCPToolResult",
  "onWorkflowNodeRegister",
  "onWorkflowNodeUnregister",
  "onWorkflowTriggerRegister",
  "onWorkflowTriggerUnregister",
  // Agent-Team specific hooks. Dispatched by `lib/ai/agent/agent-team-runtime.ts`
  // and its supporting modules (budget-guard / teammate-pool / consensus
  // orchestrator) — see Phase 2 of the agent-team plugin-integration plan.
  // These complement the generic `onAgent*` family with team-context
  // payloads (teamId / runId / governance summary) that single-agent
  // sessions do not carry.
  "onTeamStart",
  "onTeamPlanReady",
  "onTeammateClaim",
  "onTeammateRelease",
  "onTeamBudgetWarn",
  "onTeamComplete",
  // Consensus / shared-memory / delegation orchestrator hook points. Fired
  // by the matching orchestrator in `lib/ai/agent/team/`.
  "onConsensusOpened",
  "onConsensusVoted",
  "onConsensusResolved",
  "onSharedMemoryWrite",
  "onSharedMemoryDelete",
  "onTeamDelegationStart",
  "onTeamDelegationComplete",
  // Connector (IM) lifecycle — observe + veto + transform over IM inbound and
  // outbound (plugin⇄IM extensibility). `onConnectorInbound` dispatched by
  // `lib/connectors/bus.ts` before route resolution; `onConnectorOutbound` by
  // `lib/connectors/outbound-runner.ts` before the adapter send. Both carry IM
  // context (adapterId / conversationKey / platform); a transform's result is
  // re-gated through the PII redaction line (fail-closed) before it is applied.
  "onConnectorInbound",
  "onConnectorOutbound",
] as const

export type CanonicalHookPoint = (typeof CANONICAL_HOOK_POINTS)[number]

/**
 * Hook points that were demoted from canonical status because the host
 * event source genuinely doesn't exist in a permissible host file.
 *
 * `validatePluginManifest` may still emit a one-shot warning when a plugin
 * declares one of these, but they are no longer dispatched. See ADR 0016
 * "Demoted hook points" for per-entry demotion reasoning.
 */
export const DEPRECATED_HOOK_POINTS = [
  "onThemeModeChange",
  "onColorPresetChange",
  "onCustomThemeActivate",
  // ADR 0016 P1-5 (2026-05-17) — no host event source; documented as
  // future hooks in extension-point-consumers.md but never wired.
  "onAgentPlanCreate",
  "onAgentPlanStepComplete",
  "onArtifactExecute",
  "onArtifactExport",
  // 2026-06-10 — demoted from CANONICAL: no host call site and no clean seam
  // (verified against the runtime-proof audit grep). Dispatcher methods +
  // PluginHooks types stay so existing plugins compile; the host never fires
  // them. onMessageRender (use ctx.messagePart), onAgentToolCall (use the
  // ai-sdk PostToolUse rewrite), onChatRequest (use onBuildOptions).
  "onMessageRender",
  "onAgentToolCall",
  "onChatRequest",
] as const

export type DeprecatedHookPoint = (typeof DEPRECATED_HOOK_POINTS)[number]

export const CANONICAL_ACTIVATION_PATTERNS = [
  "startup",
  "onStartup",
  "onCommand:*",
  "onTool:*",
  "onAgentTool:*",
  "onChat:*",
  "onAgent:start",
  "onA2UI:surface",
  "onLanguage:*",
  "onFile:*",
  // VS Code extension reuse — activation events from `package.json` of
  // a VS Code extension flow through the manifest adapter and land here.
  // `onCommand:*` and `onLanguage:*` are already covered above; new
  // patterns below mirror the official VS Code activation-event docs:
  // https://code.visualstudio.com/api/references/activation-events
  "onView:*",
  "onWebviewPanel:*",
  "onCustomEditor:*",
  "onAuthenticationRequest",
  "onTaskType:*",
  "onFileSystem:*",
  // onDebug* patterns: the manifest adapter normalises VS Code's onDebug*
  // family to a single `onDebugResolve:*` here. Runtime stays Tier 4
  // (throw NotSupportedError) because cognia has no DAP viewport.
  "onDebugResolve:*",
  "onStartupFinished",
  "onUri",
  "onTerminal",
  "onTerminalProfile:*",
  "onNotebook:*",
  "onWalkthrough:*",
  "onChatParticipant:*",
  "onLanguageModelTool:*",
  "workspaceContains:*",
] as const

export type CanonicalActivationPattern = (typeof CANONICAL_ACTIVATION_PATTERNS)[number]
export type ActivationEventDeclaration =
  | "startup"
  | "onStartup"
  | "onCommand:*"
  | `onCommand:${string}`
  | "onTool:*"
  | `onTool:${string}`
  | "onAgentTool:*"
  | `onAgentTool:${string}`
  | "onChat:*"
  | `onChat:${string}`
  | "onAgent:start"
  | "onA2UI:surface"
  | `onLanguage:${string}`
  | `onFile:${string}`
  // VS Code-flavoured activation events. Patterns ending in `:*` may
  // appear without suffix (e.g. literal `onView:*`) or with one (`onView:foo`).
  | "onView:*"
  | `onView:${string}`
  | "onWebviewPanel:*"
  | `onWebviewPanel:${string}`
  | "onCustomEditor:*"
  | `onCustomEditor:${string}`
  | "onAuthenticationRequest"
  | "onTaskType:*"
  | `onTaskType:${string}`
  | "onFileSystem:*"
  | `onFileSystem:${string}`
  | "onDebugResolve:*"
  | `onDebugResolve:${string}`
  | "onStartupFinished"
  | "onUri"
  | "onTerminal"
  | "onTerminalProfile:*"
  | `onTerminalProfile:${string}`
  | "onNotebook:*"
  | `onNotebook:${string}`
  | "onWalkthrough:*"
  | `onWalkthrough:${string}`
  | "onChatParticipant:*"
  | `onChatParticipant:${string}`
  | "onLanguageModelTool:*"
  | `onLanguageModelTool:${string}`
  | `workspaceContains:${string}`

interface UiSlotOverride {
  status: PluginPointStatus
  stability: PluginPointStability
  binding: string
  replacementId?: CanonicalExtensionPoint
  retirementNote?: string
  deprecatedIn?: string
}

const UI_SLOT_OVERRIDES: Partial<Record<CanonicalExtensionPoint, UiSlotOverride>> = {
  "sidebar.right.top": {
    status: "deprecated",
    stability: "deprecated",
    binding: "retired (no right sidebar surface mounted)",
    replacementId: "sidebar.left.top",
    deprecatedIn: "0.2.0",
    retirementNote: "No right sidebar surface is mounted; use sidebar.left.top instead.",
  },
  "sidebar.right.bottom": {
    status: "deprecated",
    stability: "deprecated",
    binding: "retired (no right sidebar surface mounted)",
    replacementId: "sidebar.left.bottom",
    deprecatedIn: "0.2.0",
    retirementNote: "No right sidebar surface is mounted; use sidebar.left.bottom instead.",
  },
  // ADR-0026 §5 §A — `chat.message.actions` was previously retired but is
  // revived in the v2 surface. The new mount is a hover action bar above
  // each message (distinct from `chat.message.footer`, which holds copy /
  // regenerate). Listed in `IMPLEMENTED_EXTENSION_POINTS` below so it
  // resolves to status=implemented, not deprecated.
  "panel.header": {
    status: "deprecated",
    stability: "deprecated",
    binding: "retired (no generic panel shell component exists)",
    deprecatedIn: "0.4.0",
    retirementNote:
      "No generic panel-shell wrapper exists in cognia-next; demoted in SP-1 (2026-05-11) after Phase A audit found no viable host.",
  },
  "panel.footer": {
    status: "deprecated",
    stability: "deprecated",
    binding: "retired (no generic panel shell component exists)",
    deprecatedIn: "0.4.0",
    retirementNote:
      "No generic panel-shell wrapper exists in cognia-next; demoted in SP-1 (2026-05-11) after Phase A audit found no viable host.",
  },
  // ADR-0026 §5 §B — `settings.ai` revived. The mount lives at the top of
  // `components/settings/api-key-section.tsx`. Listed in
  // `IMPLEMENTED_EXTENSION_POINTS` below so it resolves to status=implemented.
}

const extensionPointContracts: Record<CanonicalExtensionPoint, PluginPointContract> =
  Object.fromEntries(
    CANONICAL_EXTENSION_POINTS.map((id) => {
      const override = UI_SLOT_OVERRIDES[id]
      if (override) {
        return [
          id,
          {
            id,
            kind: "ui-slot",
            stability: override.stability,
            status: override.status,
            owner: "plugin-platform",
            binding: override.binding,
            docs: UI_POINT_DOCS,
            requiredTests: UI_POINT_TESTS,
            introducedIn: "0.1.0",
            deprecatedIn: override.deprecatedIn,
            replacementId: override.replacementId,
            retirementNote: override.retirementNote,
            permission: "extension:ui",
          } as PluginPointContract,
        ]
      }

      const status: PluginPointStatus = VIRTUAL_EXTENSION_POINTS.has(id)
        ? "virtual"
        : IMPLEMENTED_EXTENSION_POINTS.has(id)
          ? "implemented"
          : "deprecated"
      const implementedBinding = IMPLEMENTED_EXTENSION_POINT_BINDINGS[id]
      const hostKind: PluginPointHostKind = REGISTRATION_HOST_EXTENSION_POINTS.has(id)
        ? "registration"
        : "jsx-mount"
      return [
        id,
        {
          id,
          kind: "ui-slot",
          stability:
            status === "implemented"
              ? "stable"
              : status === "virtual"
                ? "experimental"
                : "deprecated",
          status,
          hostKind,
          owner: "plugin-platform",
          binding:
            status === "deprecated"
              ? "retired (no host mount)"
              : (implementedBinding ?? "components/* via PluginExtensionPoint"),
          docs: UI_POINT_DOCS,
          requiredTests: UI_POINT_TESTS,
          introducedIn: "0.1.0",
          deprecatedIn: status === "deprecated" ? "0.2.0" : undefined,
          permission: "extension:ui",
        } as PluginPointContract,
      ]
    })
  ) as Record<CanonicalExtensionPoint, PluginPointContract>

const hookPointContracts: Record<CanonicalHookPoint, PluginPointContract> = Object.fromEntries(
  CANONICAL_HOOK_POINTS.map((id) => [
    id,
    {
      id,
      kind: "hook",
      stability: "stable",
      status: "implemented",
      owner: "plugin-platform",
      binding: "lib/plugin/messaging/hooks-system.ts",
      docs: HOOK_POINT_DOCS,
      requiredTests: HOOK_POINT_TESTS,
      introducedIn: "0.1.0",
    } as PluginPointContract,
  ])
) as Record<CanonicalHookPoint, PluginPointContract>

/**
 * Runtime extension points — host-managed registries plugins can contribute
 * implementations to (e.g., workflow node executors and triggers). Distinct
 * from `ui-slot` (host renders a plugin's React node) and `hook` (host fires
 * an event a plugin handler reacts to). See ADR 0012.
 */
export const CANONICAL_RUNTIME_POINTS = [
  "workflow.node",
  "workflow.trigger",
  "workflow.task",
  // ADR-0026 extension-point v2 — host registries plugins contribute to via
  // either a manifest declarative path or an imperative `ctx.*.register*()`
  // call. Each one has a binding to the registry singleton that actually
  // owns the contributions; later phases wire the bridges + ctx APIs.
  "provider.ocr",
  "provider.workspace-backend",
  "provider.message-renderer",
  "provider.ai-llm",
  "provider.ai-embedding",
  "chat.middleware",
  "modal.mount",
  "scheduler.task",
  // Implemented registry-backed contribution points that predate this
  // contract registry or landed through feature-specific ADRs. They are
  // runtime points because plugins add executable/registry entries rather than
  // mounting JSX.
  "terminal.completion",
  "provider.routing-strategy",
  "provider.deployment-filter",
  "provider.protocol-adapter",
  "agent.external-agent-adapter",
  "agent.tool-route",
  "agent.context-provider",
  "connectors.adapter",
  "subscription.balance-adapter",
  "subscription.limits-source",
  "connectors.im-rate-source",
  "chat.compaction-strategy",
  "quick-action",
  "appearance.font",
  "appearance.wallpaper",
  "appearance.density-preset",
  "view.container",
  "view.tree",
  "view.webview",
  "agent.skill",
  "agent.mcp-server-preset",
  "agent.native-anthropic-tool",
  "agent.external-agent-preset",
  "character.pack",
  "agent.subagent",
  "agent.team-template",
  "agent.shared-memory-adapter",
  "workflow.template",
  "auth.provider",
  "agent.tool",
  "a2ui.component",
  "a2ui.template",
  "agent.mode",
  "command.slash",
  "importer.format",
  "exporter.format",
  "appearance.theme",
  "appearance.theme-pack",
  "lsp.server",
  "cli.tool",
  "tray.item",
  "uri.handler",
] as const

export type CanonicalRuntimePoint = (typeof CANONICAL_RUNTIME_POINTS)[number]

const RUNTIME_POINT_BINDINGS: Record<CanonicalRuntimePoint, string> = {
  "workflow.node": "lib/workflow/nodes/registry.ts:registerNodeExecutor",
  "workflow.trigger": "lib/workflow/triggers/registry.ts:registerPluginTrigger",
  "workflow.task":
    "lib/workflow/nodes/built-ins.ts:executePluginInvoke (action.plugin.invoke node)",
  // The bindings below point at registries that will be exposed via
  // `lib/plugin/api/<name>-api.ts` and `lib/plugin/bridge/<name>-bridge.ts`
  // in Phases 2-4. The contract declares the intent; the audit script
  // accepts these as `runtime` kind (no JSX mount required, unlike
  // `ui-slot`). See ADR-0026.
  "provider.ocr": "lib/ocr/registry.ts:registerOcrProvider",
  "provider.workspace-backend": "lib/github/workspace-backend-registry.ts:registerWorkspaceBackend",
  "provider.message-renderer":
    "lib/plugin/api/message-part-renderers.ts:registerMessagePartRenderer",
  "provider.ai-llm": "lib/plugin/api/ai-provider-registry.ts:registerLlmProvider",
  "provider.ai-embedding": "lib/plugin/api/ai-provider-registry.ts:registerEmbeddingProvider",
  "chat.middleware": "lib/claude/chat-middleware/registry.ts:registerChatMiddleware",
  "modal.mount": "stores/plugin/plugin-modal-store.ts:registerPluginModal",
  "scheduler.task": "lib/scheduler/executors/plugin-executor.ts (plugin scheduled task)",
  "terminal.completion": "lib/terminal/completion/registry.ts:registerCompletionProvider",
  "provider.routing-strategy":
    "packages/provider-routing/src/strategy-registry.ts:registerRoutingStrategy",
  "provider.deployment-filter":
    "packages/provider-routing/src/filter-registry.ts:registerDeploymentFilter",
  "provider.protocol-adapter":
    "packages/provider-core/src/providers/protocol-adapter-registry.ts:registerProtocolAdapter",
  "agent.external-agent-adapter":
    "lib/ai/agent/external/protocol-adapter.ts:registerPluginProtocolAdapter",
  "agent.tool-route": "lib/plugin/bridge/tool-routes-bridge.ts:registerToolRoutesForPlugin",
  "agent.context-provider":
    "lib/plugin/registries/context-provider-registry.ts:registerContextProvider",
  "connectors.adapter": "lib/connectors/bus.ts:registerAdapter",
  "subscription.balance-adapter":
    "lib/plugin/registries/balance-adapter-registry.ts:registerBalanceAdapter",
  "subscription.limits-source":
    "lib/plugin/registries/limits-source-registry.ts:registerLimitsSource",
  "connectors.im-rate-source":
    "lib/plugin/registries/im-rate-source-registry.ts:registerImRateSource",
  "chat.compaction-strategy":
    "lib/plugin/registries/compaction-strategy-registry.ts:registerCompactionStrategy",
  "quick-action": "lib/plugin/registries/quick-action-registry.ts:registerQuickAction",
  "appearance.font": "lib/plugin/bridge/font-bridge.ts:applyPluginFonts",
  "appearance.wallpaper": "lib/plugin/bridge/wallpaper-bridge.ts:applyPluginWallpapers",
  "appearance.density-preset":
    "lib/appearance/density-preset-registry.ts:registerDensityPresetsForPlugin",
  "view.container": "lib/plugin/registries/view-container-registry.ts:registerViewContainer",
  "view.tree": "lib/plugin/bridge/view-bridge.ts:registerViewsForPlugin",
  "view.webview": "lib/plugin/bridge/plugin-webview-bridge.ts:registerWebviewsForPlugin",
  "agent.skill": "lib/plugin/registries/skill-registry.ts:registerSkill",
  "agent.mcp-server-preset":
    "lib/plugin/registries/mcp-server-preset-registry.ts:registerMcpServerPreset",
  "agent.native-anthropic-tool":
    "lib/plugin/registries/native-anthropic-tool-registry.ts:registerNativeAnthropicTool",
  "agent.external-agent-preset": "lib/ai/agent/external/presets.ts:registerPreset",
  "character.pack": "lib/plugin/registries/character-pack-registry.ts:registerCharacterPack",
  "agent.subagent": "lib/plugin/registries/subagent-registry.ts:registerSubagent",
  "agent.team-template":
    "lib/plugin/registries/agent-team-template-registry.ts:registerAgentTeamTemplate",
  "agent.shared-memory-adapter":
    "lib/plugin/registries/shared-memory-adapter-registry.ts:registerSharedMemoryAdapter",
  "workflow.template":
    "lib/plugin/registries/workflow-template-registry.ts:registerWorkflowTemplate",
  "auth.provider": "lib/plugin/auth/auth-provider-registry.ts:registerAuthenticationProvider",
  "agent.tool": "lib/plugin/core/registry.ts:registerTool",
  "a2ui.component": "lib/plugin/bridge/a2ui-bridge.ts:registerComponent",
  "a2ui.template": "lib/plugin/bridge/a2ui-bridge.ts:registerTemplate",
  "agent.mode": "lib/plugin/core/registry.ts:registerMode",
  "command.slash": "lib/chat/slash-command-registry.ts:registerSlashCommand",
  "importer.format": "lib/plugin/api/import-api.ts:registerImporter",
  "exporter.format": "lib/plugin/api/export-api.ts:registerExporter",
  "appearance.theme": "lib/plugin/bridge/themes-bridge.ts:registerPluginThemes",
  "appearance.theme-pack": "lib/plugin/bridge/themes-bridge.ts:registerPluginThemePacks",
  "lsp.server": "lib/plugin/lsp/lsp-registry.ts:registerPluginLspServers",
  "cli.tool": "lib/plugin/core/manager.ts:registerPluginContributions cliTools",
  "tray.item": "lib/plugin/api/tray-api.ts:register",
  "uri.handler": "lib/plugin/uri/uri-handler-registry.ts:registerUriHandler",
}

/**
 * Permission a plugin must hold to register at the given runtime point.
 * Reused permission keys per locked decision #3 of ADR-0026 — no new
 * permission strings introduced. The `permission` field on each contract
 * below is sourced from this map.
 */
const RUNTIME_POINT_PERMISSIONS: Partial<Record<CanonicalRuntimePoint, string>> = {
  "workflow.node": "extension:workflow",
  "workflow.trigger": "extension:workflow",
  "workflow.task": "extension:workflow",
  "provider.ocr": "network:fetch",
  "provider.workspace-backend": "process:spawn",
  "provider.message-renderer": "extension:ui",
  "provider.ai-llm": "network:fetch",
  "provider.ai-embedding": "network:fetch",
  "chat.middleware": "agent:control",
  "modal.mount": "extension:ui",
  "scheduler.task": "extension:workflow",
  "terminal.completion": "terminal:completion",
  "provider.routing-strategy": "network:fetch",
  "provider.deployment-filter": "network:fetch",
  "provider.protocol-adapter": "network:fetch",
  "agent.external-agent-adapter": "agent:dispatch-external",
  "agent.tool-route": "agent:control",
  "agent.context-provider": "agent:control",
  "connectors.adapter": "connectors:read",
  "subscription.balance-adapter": "subscription:read",
  "subscription.limits-source": "subscription:read",
  "connectors.im-rate-source": "connectors:read",
  "chat.compaction-strategy": "agent:control",
  "quick-action": "extension:ui",
  "appearance.font": "extension:ui",
  "appearance.wallpaper": "extension:ui",
  "appearance.density-preset": "extension:ui",
  "view.container": "extension:ui",
  "view.tree": "extension:ui",
  "view.webview": "extension:ui",
  "agent.skill": "agent:control",
  "agent.mcp-server-preset": "agent:control",
  "agent.native-anthropic-tool": "agent:control",
  "agent.external-agent-preset": "agent:dispatch-external",
  "character.pack": "agent:control",
  "agent.subagent": "agent:dispatch",
  "agent.team-template": "agent:dispatch",
  "agent.shared-memory-adapter": "agent:shared-memory:read",
  "workflow.template": "extension:workflow",
  "auth.provider": "auth:provide",
  "cli.tool": "cli:execute",
}

const RUNTIME_POINT_STABILITY: Partial<Record<CanonicalRuntimePoint, PluginPointStability>> = {
  "lsp.server": "experimental",
  "cli.tool": "experimental",
}

const runtimePointContracts: Record<CanonicalRuntimePoint, PluginPointContract> =
  Object.fromEntries(
    CANONICAL_RUNTIME_POINTS.map((id) => {
      const permission = RUNTIME_POINT_PERMISSIONS[id]
      return [
        id,
        {
          id,
          kind: "runtime",
          stability: RUNTIME_POINT_STABILITY[id] ?? "stable",
          // Phase 1 of ADR-0026 declares the new runtime points before their
          // ctx.* / bridge wiring lands. They are still `implemented` from a
          // contract perspective — the binding registry exists; the
          // plugin-facing API surface ships in Phases 2-4.
          status: "implemented",
          owner: "plugin-platform",
          binding: RUNTIME_POINT_BINDINGS[id],
          docs: RUNTIME_POINT_DOCS,
          requiredTests: RUNTIME_POINT_TESTS,
          // Workflow points predate ADR-0026; v2 points enter at 0.5.0.
          introducedIn: id.startsWith("workflow.") ? "0.3.0" : "0.5.0",
          ...(permission ? { permission } : {}),
        } as PluginPointContract,
      ]
    })
  ) as Record<CanonicalRuntimePoint, PluginPointContract>

const activationPatternContracts: Record<CanonicalActivationPattern, PluginPointContract> = {
  startup: {
    id: "startup",
    kind: "activation",
    stability: "stable",
    status: "implemented",
    owner: "plugin-platform",
    binding: "lib/plugin/core/manager.ts:handleActivationEvent",
    docs: ACTIVATION_POINT_DOCS,
    requiredTests: ACTIVATION_POINT_TESTS,
    introducedIn: "0.1.0",
  },
  onStartup: {
    id: "onStartup",
    kind: "activation",
    stability: "deprecated",
    status: "deprecated",
    owner: "plugin-platform",
    binding: "legacy alias",
    docs: ACTIVATION_POINT_DOCS,
    requiredTests: ACTIVATION_POINT_TESTS,
    introducedIn: "0.1.0",
    deprecatedIn: "0.1.0",
    replacementId: "startup",
    aliases: ["startup"],
  },
  "onCommand:*": {
    id: "onCommand:*",
    kind: "activation",
    stability: "stable",
    status: "implemented",
    owner: "plugin-platform",
    binding: "lib/plugin/core/manager.ts:handleActivationEvent",
    docs: ACTIVATION_POINT_DOCS,
    requiredTests: ACTIVATION_POINT_TESTS,
    introducedIn: "0.1.0",
  },
  "onTool:*": {
    id: "onTool:*",
    kind: "activation",
    stability: "stable",
    status: "implemented",
    owner: "plugin-platform",
    binding: "lib/plugin/core/manager.ts:handleActivationEvent",
    docs: ACTIVATION_POINT_DOCS,
    requiredTests: ACTIVATION_POINT_TESTS,
    introducedIn: "0.1.0",
  },
  "onAgentTool:*": {
    id: "onAgentTool:*",
    kind: "activation",
    stability: "deprecated",
    status: "deprecated",
    owner: "plugin-platform",
    binding: "legacy alias",
    docs: ACTIVATION_POINT_DOCS,
    requiredTests: ACTIVATION_POINT_TESTS,
    introducedIn: "0.1.0",
    deprecatedIn: "0.1.0",
    replacementId: "onTool:*",
  },
  "onChat:*": {
    id: "onChat:*",
    kind: "activation",
    stability: "deprecated",
    status: "deprecated",
    owner: "plugin-platform",
    binding: "retired (not dispatched)",
    docs: ACTIVATION_POINT_DOCS,
    requiredTests: ACTIVATION_POINT_TESTS,
    introducedIn: "0.1.0",
    deprecatedIn: "0.2.0",
    replacementId: "onCommand:*",
    retirementNote:
      "Use hook handlers onMessageSend/onMessageReceive for chat lifecycle reactions, or onCommand:* for explicit activation.",
  },
  "onAgent:start": {
    id: "onAgent:start",
    kind: "activation",
    stability: "deprecated",
    status: "deprecated",
    owner: "plugin-platform",
    binding: "retired (not dispatched)",
    docs: ACTIVATION_POINT_DOCS,
    requiredTests: ACTIVATION_POINT_TESTS,
    introducedIn: "0.1.0",
    deprecatedIn: "0.2.0",
    replacementId: "onTool:*",
    retirementNote:
      "Use hook handler onAgentStart for agent lifecycle reactions, or onTool:* for tool-driven activation.",
  },
  "onA2UI:surface": {
    id: "onA2UI:surface",
    kind: "activation",
    stability: "deprecated",
    status: "deprecated",
    owner: "plugin-platform",
    binding: "retired (not dispatched)",
    docs: ACTIVATION_POINT_DOCS,
    requiredTests: ACTIVATION_POINT_TESTS,
    introducedIn: "0.1.0",
    deprecatedIn: "0.2.0",
    replacementId: "startup",
    retirementNote:
      "Use hook handler onA2UISurfaceCreate for surface lifecycle reactions, or startup activation to register surfaces eagerly.",
  },
  "onLanguage:*": {
    id: "onLanguage:*",
    kind: "activation",
    stability: "deprecated",
    status: "deprecated",
    owner: "plugin-platform",
    binding: "retired (not dispatched)",
    docs: ACTIVATION_POINT_DOCS,
    requiredTests: ACTIVATION_POINT_TESTS,
    introducedIn: "0.1.0",
    deprecatedIn: "0.2.0",
    replacementId: "startup",
    retirementNote:
      "No language-based runtime dispatch in Cognia; declare startup activation and filter inside the plugin.",
  },
  "onFile:*": {
    id: "onFile:*",
    kind: "activation",
    stability: "deprecated",
    status: "deprecated",
    owner: "plugin-platform",
    binding: "retired (not dispatched)",
    docs: ACTIVATION_POINT_DOCS,
    requiredTests: ACTIVATION_POINT_TESTS,
    introducedIn: "0.1.0",
    deprecatedIn: "0.2.0",
    replacementId: "startup",
    retirementNote:
      "No file-open runtime dispatch in Cognia; declare startup activation and filter inside the plugin.",
  },
  // VS Code activation patterns — handled by
  // sidecar/vscode-ext-host (M0) and surfaced through the cognia plugin
  // manager. Bindings reference the activation pump in the sidecar to make
  // the contract registry honest about where dispatch happens.
  "onView:*": vscodeActivationContract("onView:*"),
  "onWebviewPanel:*": vscodeActivationContract("onWebviewPanel:*"),
  "onCustomEditor:*": vscodeActivationContract("onCustomEditor:*"),
  onAuthenticationRequest: vscodeActivationContract("onAuthenticationRequest"),
  "onTaskType:*": vscodeActivationContract("onTaskType:*"),
  "onFileSystem:*": vscodeActivationContract("onFileSystem:*"),
  "onDebugResolve:*": vscodeActivationContract("onDebugResolve:*", {
    note: "Validated as a known pattern but the sidecar's vscode-shim raises NotSupportedError at runtime — Cognia has no DAP viewport.",
  }),
  onStartupFinished: vscodeActivationContract("onStartupFinished"),
  onUri: vscodeActivationContract("onUri"),
  onTerminal: vscodeActivationContract("onTerminal"),
  "onTerminalProfile:*": vscodeActivationContract("onTerminalProfile:*"),
  "onNotebook:*": vscodeActivationContract("onNotebook:*"),
  "onWalkthrough:*": vscodeActivationContract("onWalkthrough:*"),
  "onChatParticipant:*": vscodeActivationContract("onChatParticipant:*"),
  "onLanguageModelTool:*": vscodeActivationContract("onLanguageModelTool:*"),
  "workspaceContains:*": vscodeActivationContract("workspaceContains:*"),
}

function vscodeActivationContract(
  id: CanonicalActivationPattern,
  opts: { note?: string } = {}
): PluginPointContract {
  return {
    id,
    kind: "activation",
    stability: "stable",
    status: "implemented",
    owner: "plugin-platform",
    binding: "sidecar/vscode-ext-host/src/host.ts:handleActivationEvent",
    docs: ACTIVATION_POINT_DOCS,
    requiredTests: ACTIVATION_POINT_TESTS,
    introducedIn: "0.5.0",
    ...(opts.note ? { retirementNote: opts.note } : {}),
  }
}

export const PLUGIN_POINT_CONTRACTS: readonly PluginPointContract[] = [
  ...Object.values(extensionPointContracts),
  ...Object.values(hookPointContracts),
  ...Object.values(runtimePointContracts),
  ...Object.values(activationPatternContracts),
]

export function getRuntimePointContract(point: CanonicalRuntimePoint): PluginPointContract {
  return runtimePointContracts[point]
}

export function auditPluginPointContracts(): PluginPointProofAudit[] {
  return PLUGIN_POINT_CONTRACTS.map((contract) => {
    const requiresProof = contract.status === "implemented"
    const missingFields: Array<"binding" | "docs" | "requiredTests"> = []

    if (requiresProof && !contract.binding.trim()) {
      missingFields.push("binding")
    }

    if (requiresProof && !contract.docs.trim()) {
      missingFields.push("docs")
    }

    if (
      requiresProof &&
      (!contract.requiredTests.length || contract.requiredTests.some((entry) => !entry.trim()))
    ) {
      missingFields.push("requiredTests")
    }

    return {
      id: contract.id,
      kind: contract.kind,
      status: contract.status,
      binding: contract.binding,
      docs: contract.docs,
      requiredTests: contract.requiredTests,
      missingFields,
      proofStatus: !requiresProof
        ? "not_applicable"
        : missingFields.length === 0
          ? "verified"
          : "missing_proof",
    }
  })
}

const extensionPointSet = new Set<string>(CANONICAL_EXTENSION_POINTS)
const hookPointSet = new Set<string>(CANONICAL_HOOK_POINTS)

export function getExtensionPointContract(point: CanonicalExtensionPoint): PluginPointContract {
  return extensionPointContracts[point]
}

export function getHookPointContract(hookName: CanonicalHookPoint): PluginPointContract {
  return hookPointContracts[hookName]
}

export function getActivationPatternContract(
  pattern: CanonicalActivationPattern
): PluginPointContract {
  return activationPatternContracts[pattern]
}

function toSeverity(mode: PluginPointGovernanceMode): "warning" | "error" {
  return mode === "block" ? "error" : "warning"
}

export function resolveActivationPattern(event: string): CanonicalActivationPattern | undefined {
  if (
    event === "startup" ||
    event === "onStartup" ||
    event === "onAgent:start" ||
    event === "onA2UI:surface" ||
    // VS Code bare events
    event === "onAuthenticationRequest" ||
    event === "onStartupFinished" ||
    event === "onUri" ||
    event === "onTerminal"
  ) {
    return event as CanonicalActivationPattern
  }

  // Patterns of shape `<prefix>:*` resolve to themselves (literal canonical
  // form) and patterns with a concrete suffix resolve to the wildcard.
  const wildcardPrefixes: ReadonlyArray<[string, CanonicalActivationPattern]> = [
    ["onCommand:", "onCommand:*"],
    ["onTool:", "onTool:*"],
    ["onAgentTool:", "onAgentTool:*"],
    ["onChat:", "onChat:*"],
    ["onLanguage:", "onLanguage:*"],
    ["onFile:", "onFile:*"],
    // VS Code prefixes (see types/plugin/plugin-vscode.ts:VsCodeActivationEvent).
    ["onView:", "onView:*"],
    ["onWebviewPanel:", "onWebviewPanel:*"],
    ["onCustomEditor:", "onCustomEditor:*"],
    ["onTaskType:", "onTaskType:*"],
    ["onFileSystem:", "onFileSystem:*"],
    ["onDebugResolve:", "onDebugResolve:*"],
    ["onTerminalProfile:", "onTerminalProfile:*"],
    ["onNotebook:", "onNotebook:*"],
    ["onWalkthrough:", "onWalkthrough:*"],
    ["onChatParticipant:", "onChatParticipant:*"],
    ["onLanguageModelTool:", "onLanguageModelTool:*"],
    ["workspaceContains:", "workspaceContains:*"],
  ]

  for (const [prefix, wildcard] of wildcardPrefixes) {
    if (event.startsWith(prefix) && event.length > prefix.length) {
      return wildcard
    }
  }

  return undefined
}

export function validateExtensionPoint(
  point: string,
  options: PluginPointValidationOptions = {}
): PluginPointValidationOutcome {
  const mode = options.governanceMode || "warn"
  const diagnostics: PluginPointDiagnostic[] = []
  const canonical = extensionPointSet.has(point)
    ? (point as CanonicalExtensionPoint)
    : EXTENSION_POINT_ALIASES[point]

  if (!canonical) {
    diagnostics.push({
      code: "plugin.point.unknown",
      severity: toSeverity(mode),
      message: `Unknown extension point "${point}".`,
      hint: "Use a canonical extension point ID from the plugin point registry.",
      pointKind: "ui-slot",
      pointId: point,
    })
    return {
      allowed: mode !== "block",
      diagnostics,
    }
  }

  const contract = getExtensionPointContract(canonical)

  if (canonical !== point) {
    diagnostics.push({
      code: "plugin.point.alias",
      severity: "warning",
      message: `Extension point alias "${point}" is deprecated. Use "${canonical}".`,
      hint: `Replace "${point}" with "${canonical}".`,
      pointKind: "ui-slot",
      pointId: point,
      canonicalId: canonical,
    })
  }

  if (contract.status === "virtual") {
    diagnostics.push({
      code: "plugin.point.virtual",
      severity: "warning",
      message: `Extension point "${canonical}" is declared virtual and may not render on current host surfaces.`,
      pointKind: "ui-slot",
      pointId: point,
      canonicalId: canonical,
    })
  }

  if (contract.permission && options.hasPermission && !options.hasPermission(contract.permission)) {
    const severity = toSeverity(mode)
    diagnostics.push({
      code: "plugin.point.permission_denied",
      severity,
      message: `Missing required permission "${contract.permission}" for extension point "${canonical}".`,
      hint: `Request permission "${contract.permission}" before registering this extension point.`,
      pointKind: "ui-slot",
      pointId: point,
      canonicalId: canonical,
    })

    if (severity === "error") {
      return {
        allowed: false,
        canonicalId: canonical,
        contract,
        diagnostics,
      }
    }
  }

  return {
    allowed: true,
    canonicalId: canonical,
    contract,
    diagnostics,
  }
}

export function validateHookPoint(
  hookName: string,
  options: Pick<PluginPointValidationOptions, "governanceMode"> = {}
): PluginPointValidationOutcome {
  const mode = options.governanceMode || "warn"
  const diagnostics: PluginPointDiagnostic[] = []

  if (!hookPointSet.has(hookName)) {
    diagnostics.push({
      code: "plugin.point.unknown",
      severity: toSeverity(mode),
      message: `Unknown hook declaration "${hookName}".`,
      hint: "Use a canonical hook name from the plugin point registry.",
      pointKind: "hook",
      pointId: hookName,
    })

    return {
      allowed: mode !== "block",
      diagnostics,
    }
  }

  const canonical = hookName as CanonicalHookPoint

  return {
    allowed: true,
    canonicalId: canonical,
    contract: getHookPointContract(canonical),
    diagnostics,
  }
}

export function validateActivationEvent(
  event: string,
  options: Pick<PluginPointValidationOptions, "governanceMode"> = {}
): PluginPointValidationOutcome {
  const mode = options.governanceMode || "warn"
  const diagnostics: PluginPointDiagnostic[] = []
  const pattern = resolveActivationPattern(event)

  if (!pattern) {
    diagnostics.push({
      code: "plugin.point.unknown",
      severity: toSeverity(mode),
      message: `Unknown activation event "${event}".`,
      hint: "Use a canonical activation event supported by the plugin point registry.",
      pointKind: "activation",
      pointId: event,
    })

    return {
      allowed: mode !== "block",
      diagnostics,
    }
  }

  const contract = getActivationPatternContract(pattern)

  if (contract.status === "deprecated" || contract.stability === "deprecated") {
    const severity = toSeverity(mode)
    const hintParts: string[] = []
    if (contract.replacementId) {
      hintParts.push(`Use "${contract.replacementId}".`)
    }
    if (contract.retirementNote) {
      hintParts.push(contract.retirementNote)
    }
    diagnostics.push({
      code: "plugin.point.deprecated",
      severity,
      message: `Activation event "${event}" is deprecated.`,
      hint: hintParts.length > 0 ? hintParts.join(" ") : undefined,
      pointKind: "activation",
      pointId: event,
      canonicalId: contract.replacementId,
    })

    if (severity === "error") {
      return {
        allowed: false,
        canonicalId: pattern,
        contract,
        diagnostics,
      }
    }
  }

  if (contract.status === "virtual") {
    const severity = toSeverity(mode)
    diagnostics.push({
      code: "plugin.point.virtual",
      severity,
      message: `Activation event "${event}" is declared but not implemented by runtime dispatch.`,
      hint: "Use startup/onCommand/onTool activation events for runtime dispatch support.",
      pointKind: "activation",
      pointId: event,
      canonicalId: pattern,
    })

    if (severity === "error") {
      return {
        allowed: false,
        canonicalId: pattern,
        contract,
        diagnostics,
      }
    }
  }

  return {
    allowed: true,
    canonicalId: pattern,
    contract,
    diagnostics,
  }
}

export function getExtensionPointAliases(): Readonly<Record<string, CanonicalExtensionPoint>> {
  return EXTENSION_POINT_ALIASES
}

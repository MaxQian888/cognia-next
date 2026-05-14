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

export interface PluginPointContract {
  id: string
  kind: PluginPointKind
  stability: PluginPointStability
  status: PluginPointStatus
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
  "chat.message.before",
  "chat.message.after",
  "chat.message.actions",
  "chat.message.footer",
  "artifact.toolbar",
  "artifact.actions",
  "canvas.toolbar",
  "canvas.sidebar",
  "panel.header",
  "panel.footer",
  "settings.general",
  "settings.appearance",
  "settings.ai",
  "settings.plugins",
  "command-palette",
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
  "chat.message.before",
  "chat.message.after",
  "chat.message.footer",
  "artifact.toolbar",
  "artifact.actions",
  "canvas.toolbar",
  "canvas.sidebar",
  "settings.general",
  "settings.appearance",
  "settings.plugins",
  "command-palette",
  "vscode.sidebar.view",
  "vscode.webview.panel",
  "vscode.activity-bar",
  "vscode.terminal.output",
])

const IMPLEMENTED_EXTENSION_POINT_BINDINGS: Partial<Record<CanonicalExtensionPoint, string>> = {
  "sidebar.left.top": "components/desktop/guild-rail.tsx",
  "sidebar.left.bottom": "components/desktop/guild-rail.tsx",
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
  "chat.message.before": "components/chat/message-renderer.tsx",
  "chat.message.after": "components/chat/message-renderer.tsx",
  "chat.message.footer": "components/chat/message-renderer.tsx",
  "artifact.toolbar": "components/artifacts/artifact-panel.tsx",
  "artifact.actions": "components/artifacts/artifact-panel.tsx",
  "canvas.toolbar": "components/canvas/canvas-panel.tsx",
  "canvas.sidebar": "components/canvas/canvas-side-panels.tsx",
  "settings.general": "components/settings/general-section.tsx",
  "settings.appearance": "components/settings/appearance/appearance-section.tsx",
  "settings.plugins": "components/plugins/plugin-panel.tsx",
  "command-palette": "components/desktop/command-palette.tsx",
  "vscode.sidebar.view": "components/extensions/vscode-extension-panel.tsx",
  "vscode.webview.panel": "components/extensions/vscode-extension-panel.tsx",
  "vscode.activity-bar": "components/extensions/vscode-extension-panel.tsx",
  "vscode.terminal.output": "components/extensions/vscode-terminal-panel.tsx",
}

const EXTENSION_POINT_ALIASES: Record<string, CanonicalExtensionPoint> = {
  "sidebar:top": "sidebar.left.top",
  "sidebar:bottom": "sidebar.left.bottom",
  "toolbar:actions": "toolbar.right",
  "chat:input": "chat.input.actions",
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
  "components/plugin/extension/extension-point.test.tsx",
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
  "onConfigChange",
  "onA2UISurfaceCreate",
  "onA2UISurfaceDestroy",
  "onA2UIAction",
  "onA2UIDataChange",
  "onAgentStart",
  "onAgentStep",
  "onAgentToolCall",
  "onAgentComplete",
  "onAgentError",
  "onMessageSend",
  "onMessageReceive",
  "onMessageRender",
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
  "onAgentPlanCreate",
  "onAgentPlanStepComplete",
  "onScheduledTaskStart",
  "onScheduledTaskComplete",
  "onScheduledTaskError",
  "onProjectCreate",
  "onProjectUpdate",
  "onProjectDelete",
  "onProjectSwitch",
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
  "onArtifactExecute",
  "onArtifactExport",
  "onExportStart",
  "onExportComplete",
  "onExportTransform",
  "onProjectExportStart",
  "onProjectExportComplete",
  "onChatRequest",
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
  "chat.message.actions": {
    status: "deprecated",
    stability: "deprecated",
    binding: "retired (no host mount; use chat.message.footer for action buttons)",
    replacementId: "chat.message.footer",
    deprecatedIn: "0.2.0",
    retirementNote: "Use chat.message.footer to render per-message action buttons.",
  },
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
  "settings.ai": {
    status: "deprecated",
    stability: "deprecated",
    binding: "retired (AI settings split across multiple sections)",
    deprecatedIn: "0.4.0",
    retirementNote:
      "AI settings are split across api-key, agent-runtime, subscription, and ccswitch sections; no single host file exists. Demoted in SP-1 (2026-05-11).",
  },
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

      const status: PluginPointStatus = IMPLEMENTED_EXTENSION_POINTS.has(id)
        ? "implemented"
        : "deprecated"
      const implementedBinding = IMPLEMENTED_EXTENSION_POINT_BINDINGS[id]
      return [
        id,
        {
          id,
          kind: "ui-slot",
          stability: status === "implemented" ? "stable" : "deprecated",
          status,
          owner: "plugin-platform",
          binding:
            status === "implemented"
              ? (implementedBinding ?? "components/* via PluginExtensionPoint")
              : "retired (no host mount)",
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
] as const

export type CanonicalRuntimePoint = (typeof CANONICAL_RUNTIME_POINTS)[number]

const RUNTIME_POINT_BINDINGS: Record<CanonicalRuntimePoint, string> = {
  "workflow.node": "lib/workflow/nodes/registry.ts:registerNodeExecutor",
  "workflow.trigger": "lib/workflow/triggers/registry.ts:registerPluginTrigger",
  "workflow.task":
    "lib/workflow/nodes/built-ins.ts:executePluginInvoke (action.plugin.invoke node)",
}

const runtimePointContracts: Record<CanonicalRuntimePoint, PluginPointContract> =
  Object.fromEntries(
    CANONICAL_RUNTIME_POINTS.map((id) => [
      id,
      {
        id,
        kind: "runtime",
        stability: "stable",
        status: "implemented",
        owner: "plugin-platform",
        binding: RUNTIME_POINT_BINDINGS[id],
        docs: RUNTIME_POINT_DOCS,
        requiredTests: RUNTIME_POINT_TESTS,
        introducedIn: "0.3.0",
        permission: "extension:workflow",
      } as PluginPointContract,
    ])
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
  // sidecars/vscode-ext-host (M0) and surfaced through the cognia plugin
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
    binding: "sidecars/vscode-ext-host/src/host.ts:handleActivationEvent",
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

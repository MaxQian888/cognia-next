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
  "panel.header",
  "panel.footer",
  "settings.general",
  "settings.appearance",
  "settings.ai",
  "settings.plugins",
  "command-palette",
])

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
  "onThemeModeChange",
  "onColorPresetChange",
  "onCustomThemeActivate",
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
] as const

export type CanonicalHookPoint = (typeof CANONICAL_HOOK_POINTS)[number]

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
              ? "components/* via PluginExtensionPoint"
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
}

export const PLUGIN_POINT_CONTRACTS: readonly PluginPointContract[] = [
  ...Object.values(extensionPointContracts),
  ...Object.values(hookPointContracts),
  ...Object.values(activationPatternContracts),
]

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
    event === "onA2UI:surface"
  ) {
    return event
  }

  if (event.startsWith("onCommand:") && event.length > "onCommand:".length) {
    return "onCommand:*"
  }

  if (event.startsWith("onTool:") && event.length > "onTool:".length) {
    return "onTool:*"
  }

  if (event.startsWith("onAgentTool:") && event.length > "onAgentTool:".length) {
    return "onAgentTool:*"
  }

  if (event.startsWith("onChat:") && event.length > "onChat:".length) {
    return "onChat:*"
  }

  if (event.startsWith("onLanguage:") && event.length > "onLanguage:".length) {
    return "onLanguage:*"
  }

  if (event.startsWith("onFile:") && event.length > "onFile:".length) {
    return "onFile:*"
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

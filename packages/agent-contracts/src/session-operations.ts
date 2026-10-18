import type {
  AcpAvailableCommand,
  ExternalAgentMessage,
  ExternalAgentExecutionOptions,
} from "./external-agent"
import type { AgentCapabilityId } from "./capability-ids"

/** Portable constraints. Adapters translate these names into their native APIs. */
export interface AgentToolPermissionRule {
  name: string
  decision: "ask" | "deny"
}

export interface AgentQualifiedToolPermissionRule {
  tool: string
  decision: "ask" | "deny"
}

export interface AgentSubagentRuntimeOptions {
  /** Absent retains a fresh context; inheritance must always be explicit. */
  contextMode?: "isolated" | "fork"
}

export interface AgentSubagentContextPolicy {
  /** Positive token threshold; a runtime may only tighten its effective window. */
  compactAtTokens?: number
}

export interface AgentLocalExtensionRef {
  kind: "directory"
  path: string
  discoverMcp?: boolean
}

export interface AgentExtensionReloadOptions {
  add?: AgentLocalExtensionRef[]
  preservePromptCache?: boolean
}

export interface AgentExtensionReloadResult {
  disposition: "applied" | "held" | "partial"
  added: AgentLocalExtensionRef[]
  /** Native diagnostics retained for the owning runtime's inspector. */
  details?: unknown
}

export interface AgentRuntimeFeatureRequest {
  subagentRuntime?: AgentSubagentRuntimeOptions
  runtimeExtensions?: AgentLocalExtensionRef[]
  agents?: Record<string, { contextPolicy?: AgentSubagentContextPolicy }>
  toolPermissionRules?: readonly AgentQualifiedToolPermissionRule[]
}

/** Explicit requests require explicit runtime support, including legacy callers. */
export function requestedRuntimeCapabilities(
  request: AgentRuntimeFeatureRequest
): AgentCapabilityId[] {
  const capabilities: AgentCapabilityId[] = []
  if (request.subagentRuntime?.contextMode === "fork") capabilities.push("subagents.context-fork")
  if (
    Object.values(request.agents ?? {}).some(
      (agent) => agent.contextPolicy?.compactAtTokens !== undefined
    )
  )
    capabilities.push("subagents.auto-compaction")
  if (request.toolPermissionRules?.length) capabilities.push("tools.permission-policy")
  if (request.runtimeExtensions?.length) capabilities.push("extensions.dynamic")
  return capabilities
}

/** Secret-free retention identity for options that require a fresh runtime. */
export function runtimeFeaturePolicyKey(request: AgentRuntimeFeatureRequest): string | undefined {
  const agents = Object.entries(request.agents ?? {})
    .filter(([, agent]) => agent.contextPolicy?.compactAtTokens !== undefined)
    .map(([name, agent]) => [name, agent.contextPolicy!.compactAtTokens])
    .sort(([a], [b]) => String(a).localeCompare(String(b)))
  const rules = (request.toolPermissionRules ?? [])
    .map((rule) => [rule.tool, rule.decision])
    .sort(
      ([a, decisionA], [b, decisionB]) => a.localeCompare(b) || decisionA.localeCompare(decisionB)
    )
  if (
    request.subagentRuntime?.contextMode !== "fork" &&
    !agents.length &&
    !rules.length &&
    !request.runtimeExtensions?.length
  )
    return undefined
  return JSON.stringify({
    contextMode: request.subagentRuntime?.contextMode ?? "isolated",
    agents,
    rules,
    extensions: request.runtimeExtensions ?? [],
  })
}

export function runtimeFeatureValidationError(request: AgentRuntimeFeatureRequest): string | null {
  if (
    request.subagentRuntime !== undefined &&
    (!request.subagentRuntime ||
      typeof request.subagentRuntime !== "object" ||
      Array.isArray(request.subagentRuntime))
  )
    return "invalid_subagent_context_mode"
  if (
    request.agents !== undefined &&
    (!request.agents || typeof request.agents !== "object" || Array.isArray(request.agents))
  )
    return "invalid_subagent_compaction_window"
  const mode = request.subagentRuntime?.contextMode
  if (mode !== undefined && mode !== "isolated" && mode !== "fork")
    return "invalid_subagent_context_mode"
  for (const agent of Object.values(request.agents ?? {})) {
    if (
      !agent ||
      typeof agent !== "object" ||
      (agent.contextPolicy !== undefined &&
        (!agent.contextPolicy ||
          typeof agent.contextPolicy !== "object" ||
          Array.isArray(agent.contextPolicy)))
    )
      return "invalid_subagent_compaction_window"
    const tokens = agent.contextPolicy?.compactAtTokens
    if (tokens !== undefined && (!Number.isSafeInteger(tokens) || tokens <= 0))
      return "invalid_subagent_compaction_window"
  }
  if (
    request.toolPermissionRules !== undefined &&
    (!Array.isArray(request.toolPermissionRules) ||
      request.toolPermissionRules.some(
        (rule) =>
          !rule ||
          typeof rule.tool !== "string" ||
          !rule.tool.trim() ||
          (rule.decision !== "ask" && rule.decision !== "deny")
      ))
  )
    return "invalid_tool_permission_rules"
  if (
    request.runtimeExtensions !== undefined &&
    (!Array.isArray(request.runtimeExtensions) ||
      request.runtimeExtensions.some(
        (ref) =>
          !ref ||
          ref.kind !== "directory" ||
          typeof ref.path !== "string" ||
          !/^(?:\/|[a-zA-Z]:[\\/])/.test(ref.path) ||
          (ref.discoverMcp !== undefined && typeof ref.discoverMcp !== "boolean")
      ))
  )
    return "invalid_runtime_extensions"
  return null
}

export type ExternalAgentCapabilityStatus = "supported" | "unsupported" | "unknown"

export interface ExternalAgentNativeCompactionRoute {
  kind: "native"
  supportsFocus: boolean
}

export interface ExternalAgentCommandCompactionRoute {
  kind: "command"
  command: "compact" | "compress"
  supportsFocus: boolean
}

export type ExternalAgentCompactionRoute =
  ExternalAgentNativeCompactionRoute | ExternalAgentCommandCompactionRoute

export interface ExternalAgentCompactionCapability {
  status: ExternalAgentCapabilityStatus
  routes: ExternalAgentCompactionRoute[]
  reason?: string
}

export interface ExternalAgentCompactionOptions {
  focus?: string
}

export interface ExternalAgentProviderUndoCapability {
  status: ExternalAgentCapabilityStatus
  command?: "undo"
  reason?: string
}

export function isExplicitlyUnsupportedCapabilityError(error: unknown): boolean {
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : undefined
  const status = record?.status ?? record?.statusCode
  const code = record?.code
  const message =
    error instanceof Error
      ? error.message
      : typeof record?.message === "string"
        ? record.message
        : ""
  const nonCapabilityFailure =
    /\b(abort(?:ed)?|cancel(?:led|ed)?|denied|timeout|timed out|provider|model|auth(?:entication|orization)?|unauthorized|forbidden|quota|rate.?limit|overflow|context length)\b/i
  if (
    nonCapabilityFailure.test(message) ||
    (typeof code === "string" && nonCapabilityFailure.test(code.replaceAll("_", " ")))
  ) {
    return false
  }

  if (status === 405 || status === 501) return true
  if (
    code === -32601 ||
    code === "METHOD_NOT_FOUND" ||
    code === "NOT_IMPLEMENTED" ||
    code === "UNSUPPORTED" ||
    code === "CAPABILITY_UNAVAILABLE"
  )
    return true

  return /\b(method not found|not implemented|unsupported (?:method|operation|endpoint|capability)|capability[^\n]*unavailable)\b/i.test(
    message
  )
}

function normalizeCommandName(name: string): string {
  return name.trim().replace(/^\/+/, "").toLowerCase()
}

export function resolveCommandCompactionCapability(
  commands: readonly AcpAvailableCommand[]
): ExternalAgentCompactionCapability {
  const advertised = commands.find((command) => {
    const normalized = normalizeCommandName(command.name)
    return normalized === "compact" || normalized === "compress"
  })

  if (!advertised) {
    return { status: "unsupported", routes: [] }
  }

  return {
    status: "supported",
    routes: [
      {
        kind: "command",
        command: normalizeCommandName(advertised.name) as "compact" | "compress",
        supportsFocus: advertised.input != null,
      },
    ],
  }
}

export function resolveProviderUndoCapability(
  commands: readonly AcpAvailableCommand[]
): ExternalAgentProviderUndoCapability {
  const supported = commands.some((command) => normalizeCommandName(command.name) === "undo")
  return supported ? { status: "supported", command: "undo" } : { status: "unsupported" }
}

/** Runtime-neutral operations. A missing method is unsupported, never inferred from a vendor. */
export const SESSION_OPERATION_METHODS = {
  commands: "refreshSessionCommands",
  commandExecution: "executeSessionCommand",
  inputQueue: "enqueueSessionInput",
  steering: "steerTurn",
  clearQueue: "clearSessionInputQueue",
  queuePolicy: "setSessionQueuePolicy",
  runtimeControls: "setSessionRuntimeControls",
  runtimeState: "getSessionRuntimeState",
  abortRetry: "abortSessionRetry",
  entries: "getSessionEntries",
  tree: "getSessionTree",
  forkAtEntry: "forkSession",
  backgroundTurns: "subscribeSessionEvents",
  clone: "cloneSession",
  rename: "renameSession",
  archive: "archiveSession",
  unarchive: "unarchiveSession",
  exportHtml: "exportSessionHtml",
  shell: "executeSessionShell",
  abortShell: "abortSessionShell",
} as const

export type ExternalAgentSessionOperation = keyof typeof SESSION_OPERATION_METHODS
export type ExternalAgentSessionOperationCapabilities = Record<
  ExternalAgentSessionOperation,
  ExternalAgentCapabilityStatus
>

export function resolveSessionOperationCapabilities(
  adapter: object,
  advertised: Partial<ExternalAgentSessionOperationCapabilities> = {}
): ExternalAgentSessionOperationCapabilities {
  const methods = adapter as Record<string, unknown>
  return Object.fromEntries(
    Object.entries(SESSION_OPERATION_METHODS).map(([operation, method]) => [
      operation,
      typeof methods[method] !== "function"
        ? "unsupported"
        : (advertised[operation as ExternalAgentSessionOperation] ??
          (["forkAtEntry", "backgroundTurns"].includes(operation) ? "unsupported" : "supported")),
    ])
  ) as ExternalAgentSessionOperationCapabilities
}

/** Images are inline data, never arbitrary local paths or remote URLs. */
export interface ExternalAgentSessionInput {
  text: string
  images?: Array<{ data: string; mimeType: string }>
}

export type ExternalAgentSessionInputMode = "steer" | "follow_up"
export interface ExternalAgentSessionInputAcceptance {
  disposition: "queued" | "handled"
  mode: ExternalAgentSessionInputMode
}

export interface ExternalAgentSessionInputQueue {
  steering: ExternalAgentSessionInput[]
  followUp: ExternalAgentSessionInput[]
}

export interface ExternalAgentSessionQueuePolicy {
  steering?: "all" | "one-at-a-time"
  followUp?: "all" | "one-at-a-time"
}

export interface ExternalAgentSessionRuntimeControls {
  autoCompaction?: boolean
  autoRetry?: boolean
}

export interface ExternalAgentSessionRuntimeState {
  queuePolicy: ExternalAgentSessionQueuePolicy
  controls: ExternalAgentSessionRuntimeControls
  pendingInputCount?: number
  isRetrying?: boolean
}

export interface ExternalAgentSessionForkTarget {
  kind: "entry" | "turn"
  id: string
  boundary: "before" | "through"
}

export interface ExternalAgentSessionEntry {
  id: string
  parentId: string | null
  forkAt?: ExternalAgentSessionForkTarget
  type: string
  timestamp?: string
  message?: ExternalAgentMessage
  /** Provider-specific entry data retained without making the UI depend on its schema. */
  metadata?: Record<string, unknown>
}

export interface ExternalAgentSessionTreeNode {
  entry: ExternalAgentSessionEntry
  children: ExternalAgentSessionTreeNode[]
}

export interface ExternalAgentSessionTree {
  roots: ExternalAgentSessionTreeNode[]
  leafId: string | null
}

export interface ExternalAgentSessionHtmlExport {
  html?: string
  /** A runtime-created export; callers cannot choose an arbitrary destination. */
  path?: string
}

export interface ExternalAgentSessionShellOptions {
  excludeFromContext?: boolean
  /** Same permission callback used by the normal execution path. */
  onPermissionRequest: NonNullable<ExternalAgentExecutionOptions["onPermissionRequest"]>
}

export interface ExternalAgentSessionShellResult {
  output: string
  exitCode: number | null
  cancelled: boolean
  truncated: boolean
}

/** A runtime may need to retire its process to guarantee a stopped shell. */
export interface ExternalAgentSessionShellAbortResult {
  resumeRequired: true
}

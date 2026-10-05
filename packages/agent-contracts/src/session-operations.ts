import type {
  AcpAvailableCommand,
  ExternalAgentMessage,
  ExternalAgentExecutionOptions,
} from "./external-agent"

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

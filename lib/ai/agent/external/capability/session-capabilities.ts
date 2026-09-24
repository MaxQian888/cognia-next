import type { AcpAvailableCommand } from "@/types/agent/external-agent"

export type ExternalAgentCapabilityStatus = "supported" | "unsupported" | "unknown"

export interface ExternalAgentNativeCompactionRoute {
  kind: "native"
  supportsFocus: false
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

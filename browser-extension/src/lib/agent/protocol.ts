/**
 * The device-socket frames between this extension and its Host (ADR-0228 §5).
 *
 * The Rust side is `crates/cognia-companion/src/ws_browser_companion.rs`; the
 * operation vocabulary and safety profile are pinned to the published JSON
 * contract by both TypeScript and Rust tests. Every frame is one JSON message.
 */
import contract from "@cognia/companion-client/browser-agent-protocol.json"

/** Operations the Host may ask for. Anything else is refused unread. */
export const AGENT_OPERATIONS = [
  "bind",
  "release",
  "navigate",
  "snapshot",
  "act",
  "press_key",
  "scroll",
  "evaluate",
  "read_console",
  "read_network",
  "back",
  "forward",
  "reload",
  "stop",
  "get_page",
  "list_pages",
  "activate_page",
  "close_page",
  "create_page",
  "drag",
  "handle_dialog",
  "set_files",
  "downloads",
  "cancel_download",
  "delete_download",
  "wait_for_text",
  "wait_for_selector",
  "wait_for_network_idle",
  "wait_for_load",
  "screenshot",
  "set_zoom",
  "find",
  "find_clear",
  "list_cookies",
  "clear_cookies",
  "get_storage",
  "set_storage",
  "clear_storage",
  "finalize_tabs",
] as const

export type AgentOperation = (typeof AGENT_OPERATIONS)[number]

export function isAgentOperation(value: unknown): value is AgentOperation {
  return typeof value === "string" && (AGENT_OPERATIONS as readonly string[]).includes(value)
}

export const HELLO_VERSION = contract.envelopeVersion
export const AGENT_PROFILE = contract.agentProfile
export const OVERLAY_ABI = contract.overlayAbi
export const MAX_OPERATION_TIMEOUT_MS = 120_000

export function operationBudgetMs(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(MAX_OPERATION_TIMEOUT_MS, Math.max(1, Math.floor(value)))
    : 30_000
}

export type HostFrame =
  | {
      t: "welcome"
      v: number
      connectionId: string
      driveAllowed: boolean
      agentProfile: string | null
    }
  | {
      t: "op"
      id: string
      op: AgentOperation
      args: Record<string, unknown>
      deadlineMs: number
    }
  | { t: "status"; at: number }
  | { t: "drive"; allowed: boolean }
  | { t: "heartbeat" }

export interface OperationFailure {
  code: string
  message: string
}

export type ExtensionFrame =
  | { t: "hello"; v: number; extensionVersion: string; features: string[] }
  | { t: "result"; id: string; ok: true; value: unknown }
  | { t: "result"; id: string; ok: false; error: OperationFailure }
  | { t: "heartbeat" }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Parse one frame from the Host, or `null` for anything this build does not
 * understand. An unknown frame is ignored rather than fatal: a newer Host may
 * add hints this build can live without.
 */
export function parseHostFrame(text: string): HostFrame | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(value)) return null
  switch (value.t) {
    case "welcome":
      return typeof value.connectionId === "string"
        ? {
            t: "welcome",
            v: Number.isSafeInteger(value.v) ? (value.v as number) : -1,
            connectionId: value.connectionId,
            driveAllowed: value.driveAllowed === true,
            agentProfile: typeof value.agentProfile === "string" ? value.agentProfile : null,
          }
        : null
    case "op":
      if (typeof value.id !== "string" || !value.id) return null
      if (!isAgentOperation(value.op)) {
        // Answered as unknown rather than dropped: the Host is waiting on it.
        return {
          t: "op",
          id: value.id,
          op: "__unknown__" as AgentOperation,
          args: {},
          deadlineMs: 0,
        }
      }
      return {
        t: "op",
        id: value.id,
        op: value.op,
        args: isRecord(value.args) ? value.args : {},
        deadlineMs: operationBudgetMs(value.deadlineMs),
      }
    case "status":
      return { t: "status", at: typeof value.at === "number" ? value.at : 0 }
    case "drive":
      return { t: "drive", allowed: value.allowed === true }
    case "heartbeat":
      return { t: "heartbeat" }
    default:
      return null
  }
}

export function serializeFrame(frame: ExtensionFrame): string {
  return JSON.stringify(frame)
}

/** An operation refused with a code the Host forwards to the agent unchanged. */
export class AgentOperationError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = "AgentOperationError"
  }
}

export function toFailure(error: unknown): OperationFailure {
  if (error instanceof AgentOperationError) return { code: error.code, message: error.message }
  return {
    code: "browser_extension_error",
    message: error instanceof Error ? error.message : String(error),
  }
}

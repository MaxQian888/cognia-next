import type { HostCommand, SendOptions } from "../shared/wire/inbound.ts"
/** Parsed frame fields used by the host; semantic validation remains in handlers. */
export interface HostMessage extends HostCommand {
  requestId?: string
  method?: string
  params?: Record<string, unknown>
  options?: SendOptions
  sendOptions?: SendOptions
  focus?: unknown
  execId?: string
  toolUseId?: string
  reviewId?: string
  decision?: string
  updatedInput?: Record<string, unknown>
  message?: string
  interrupt?: boolean
}
export function parseHostMessage(value: unknown): HostMessage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const frame = value as Record<string, unknown>
  if (typeof frame.type !== "string") return null
  for (const key of [
    "sessionId",
    "requestId",
    "commandId",
    "method",
    "execId",
    "toolUseId",
    "reviewId",
    "decision",
    "message",
  ]) {
    if (frame[key] !== undefined && typeof frame[key] !== "string") return null
  }
  for (const key of ["params", "options", "sendOptions", "updatedInput"]) {
    if (
      frame[key] !== undefined &&
      (!frame[key] || typeof frame[key] !== "object" || Array.isArray(frame[key]))
    )
      return null
  }
  if (frame.interrupt !== undefined && typeof frame.interrupt !== "boolean") return null
  return frame as unknown as HostMessage
}

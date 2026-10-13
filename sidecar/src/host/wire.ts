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
const STRING_FIELDS = [
  "sessionId",
  "requestId",
  "commandId",
  "method",
  "execId",
  "toolUseId",
  "reviewId",
  "decision",
  "message",
] as const
const OBJECT_FIELDS = ["params", "options", "sendOptions", "updatedInput"] as const
const OPTIONAL_FIELDS: readonly string[] = [...STRING_FIELDS, ...OBJECT_FIELDS, "interrupt"]

/**
 * The Rust host serializes an absent `Option` as `null` (`"params": null` on a
 * control without params, `"message": null` on a permission answer without
 * one). That is "absent", not a malformed field: rejecting it dropped every
 * such frame unanswered, so `runtimeStatus` timed out and a bare approval
 * never landed. The null keys are removed, and the rest is validated as sent.
 */
function withoutNullOptionals(frame: Record<string, unknown>): Record<string, unknown> {
  if (!OPTIONAL_FIELDS.some((key) => frame[key] === null)) return frame
  const copy = { ...frame }
  for (const key of OPTIONAL_FIELDS) if (copy[key] === null) delete copy[key]
  return copy
}

export function parseHostMessage(value: unknown): HostMessage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const frame = withoutNullOptionals(value as Record<string, unknown>)
  if (typeof frame.type !== "string") return null
  for (const key of STRING_FIELDS) {
    if (frame[key] !== undefined && typeof frame[key] !== "string") return null
  }
  for (const key of OBJECT_FIELDS) {
    if (
      frame[key] !== undefined &&
      (!frame[key] || typeof frame[key] !== "object" || Array.isArray(frame[key]))
    )
      return null
  }
  if (frame.interrupt !== undefined && typeof frame.interrupt !== "boolean") return null
  return frame as unknown as HostMessage
}

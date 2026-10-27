import type { NormalizedInboundEvent } from "@/types/connectors/event"
import { parseConversationKey } from "@/types/connectors/event"
import { bareMatrixEventId } from "./adapters/matrix/ids"

/** A threadless mutation may address a thread, never another chat or homeserver. */
export function mutationConversationMatches(mutationKey: string, storedKey: string): boolean {
  if (mutationKey === storedKey) return true
  try {
    const mutation = parseConversationKey(mutationKey)
    const stored = parseConversationKey(storedKey)
    return (
      mutation.platform === stored.platform &&
      mutation.adapterId === stored.adapterId &&
      mutation.remoteChatId === stored.remoteChatId &&
      mutation.threadId === undefined
    )
  } catch {
    return false
  }
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export interface InboundEditRevision {
  at: number
  order?: string
}

/** Matrix homeservers deliver untrusted replacement relations for client validation. */
export function isAuthorizedInboundEdit(
  event: NormalizedInboundEvent,
  originalSenderId: unknown
): boolean {
  return (
    event.platform !== "matrix" ||
    (typeof originalSenderId === "string" &&
      originalSenderId.length > 0 &&
      event.sender?.remoteUserId === originalSenderId)
  )
}

/** Keep wire precision: millisecond timestamps alone cannot order every edit. */
export function inboundEditRevision(event: NormalizedInboundEvent): InboundEditRevision {
  const raw = object(event.raw)
  const revision: InboundEditRevision = { at: event.timestamp }
  if (event.platform === "telegram" && Number.isSafeInteger(raw.update_id)) {
    revision.order = String(raw.update_id).padStart(20, "0")
  } else if (event.platform === "matrix") {
    revision.order =
      typeof raw.event_id === "string" ? raw.event_id : bareMatrixEventId(event.messageId)
  } else if (event.platform === "slack") {
    const ts = object(raw.event).ts
    if (typeof ts === "string" && /^\d+\.\d+$/.test(ts)) {
      const [seconds, fraction] = ts.split(".")
      revision.order = `${seconds.padStart(20, "0")}.${fraction.padEnd(9, "0")}`
    }
  } else if (event.platform === "discord") {
    const edited = object(raw.d).edited_timestamp
    if (typeof edited === "string" && Number.isFinite(Date.parse(edited))) {
      revision.at = Date.parse(edited)
      const fraction = edited.match(/\.(\d+)(?:Z|\+00:00)$/)?.[1] ?? ""
      revision.order = `${String(revision.at).padStart(20, "0")}.${fraction.padEnd(9, "0")}`
    }
  }
  return revision
}

export function isNewerInboundEdit(revision: InboundEditRevision, previous: unknown): boolean {
  const old = object(previous)
  if (typeof old.at !== "number") return true
  if (revision.at !== old.at) return revision.at > old.at
  if (revision.order !== undefined && typeof old.order === "string") {
    return revision.order > old.order
  }
  // Some transports have no sequence and only second-resolution clocks.
  // Equal timestamps must still permit a distinct revision on those transports.
  return true
}

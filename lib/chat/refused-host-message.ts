import type { HostStateAttachmentRef } from "@cognia/agent-config-types/host-state"
import type { TranscriptTimelineItem } from "@cognia/agent-config-types"

/** Device-local evidence of a refused intent, never a confirmed transcript row. */
export interface RefusedHostMessage {
  code: string
  at: number
  /** Original Host message id; the retained copy has a device-local id. */
  messageId?: string
  attachments: HostStateAttachmentRef[]
}

export function refusedHostMessageId(actionId: string): string {
  return `host-state-refused:${actionId}`
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object"
}

export function refusedHostMessageOf(message: unknown): RefusedHostMessage | null {
  if (!record(message) || message.role !== "user" || !record(message.metadata)) return null
  const hostState = message.metadata.hostState
  if (!record(hostState) || hostState.optimistic !== true || !record(hostState.refusal)) return null
  const { code, at } = hostState.refusal
  if (
    typeof code !== "string" ||
    code.length === 0 ||
    typeof at !== "number" ||
    !Number.isFinite(at) ||
    at < 0
  )
    return null
  const attachments = Array.isArray(hostState.attachmentRefs)
    ? hostState.attachmentRefs.filter(
        (value): value is HostStateAttachmentRef =>
          record(value) &&
          typeof value.name === "string" &&
          typeof value.mediaType === "string" &&
          typeof value.size === "number" &&
          Number.isFinite(value.size) &&
          value.size >= 0
      )
    : []
  return {
    code,
    at,
    attachments,
    ...(typeof hostState.refusal.messageId === "string"
      ? { messageId: hostState.refusal.messageId }
      : {}),
  }
}

/** A Host enqueue placeholder is still an intent; a real transcript row wins. */
export function isHostEnqueuePlaceholder(message: unknown, actionId: unknown): boolean {
  if (!record(message) || message.role !== "user" || !record(message.metadata)) return false
  const hostState = message.metadata.hostState
  return record(hostState) && typeof actionId === "string" && hostState.actionId === actionId
}

/** The legacy list also shows one failed copy, rather than its Host placeholder. */
export function withoutRefusedHostPlaceholders<T extends { id: string; metadata?: unknown }>(
  messages: T[]
): T[] {
  const retained = messages.flatMap((message) => {
    const refusal = refusedHostMessageOf(message)
    if (
      !refusal?.messageId ||
      !record(message) ||
      !record(message.metadata) ||
      !record(message.metadata.hostState)
    )
      return []
    return [
      { message, originalId: refusal.messageId, actionId: message.metadata.hostState.actionId },
    ]
  })
  if (retained.length === 0) return messages
  return messages.filter((message) => {
    const archive = retained.find((entry) => entry.message.id === message.id)
    if (archive) {
      const original = messages.find((candidate) => candidate.id === archive.originalId)
      return !original || isHostEnqueuePlaceholder(original, archive.actionId)
    }
    return !retained.some(
      (entry) =>
        entry.originalId === message.id && isHostEnqueuePlaceholder(message, entry.actionId)
    )
  })
}

/** Legacy Host transcript readers can still return a queued placeholder. */
export function withoutRefusedHostMessages(
  items: TranscriptTimelineItem[],
  refusedIds: ReadonlySet<string>
): TranscriptTimelineItem[] {
  if (refusedIds.size === 0) return items
  return items.flatMap((item): TranscriptTimelineItem[] => {
    if (item.kind === "system") return [item]
    if (item.kind === "active-turn") {
      const messages = item.messages.filter((message) => !refusedIds.has(message.id))
      return messages.length > 0 ? [{ ...item, messages }] : []
    }
    const userMessages = item.userMessages.filter((message) => !refusedIds.has(message.id))
    if (userMessages.length === 0 && item.userMessages.length > 0) return []
    return [{ ...item, userMessages }]
  })
}

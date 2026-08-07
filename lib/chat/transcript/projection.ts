import type {
  StoredMessage,
  TranscriptBranchGroupSummary,
  TranscriptDirection,
  TranscriptErrorCode,
  TranscriptMediaReference,
  TranscriptMessage,
  TranscriptMessagePreview,
  TranscriptTimelineItem,
} from "@cognia/agent-config-types"
import {
  TRANSCRIPT_PROTOCOL_VERSION,
  TRANSCRIPT_SUMMARY_BYTE_LIMIT,
  TRANSCRIPT_SUMMARY_MEDIA_LIMIT,
} from "@cognia/agent-config-types"

interface ProjectTimelineOptions {
  sessionId: string
  revision: number
  messages: StoredMessage[]
  activeTurnKey?: string
  activeBranchByGroup?: Record<string, string>
}

interface TimelineCursorPayload {
  version: typeof TRANSCRIPT_PROTOCOL_VERSION
  sessionId: string
  revision: number
  direction: TranscriptDirection
  position: number
}

interface TurnDetailCursorPayload {
  version: typeof TRANSCRIPT_PROTOCOL_VERSION
  sessionId: string
  revision: number
  turnKey: string
  detailRevision: number
  position: number
}

type CursorValidation<T> = { ok: true; value: T } | { ok: false; code: TranscriptErrorCode }

const encoder = new TextEncoder()
const PREVIEW_TEXT_BYTE_LIMIT = 24 * 1024

function byteLength(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength
}

function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  if (encoder.encode(value).byteLength <= maxBytes) return { text: value, truncated: false }
  let low = 0
  let high = value.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (encoder.encode(value.slice(0, mid)).byteLength <= maxBytes) low = mid
    else high = mid - 1
  }
  return { text: value.slice(0, low), truncated: true }
}

function messageText(message: StoredMessage): string {
  const chunks: string[] = []
  for (const part of message.parts) {
    const candidate = part as { type?: unknown; text?: unknown }
    if (candidate.type === "text" && typeof candidate.text === "string") {
      chunks.push(candidate.text)
    }
  }
  return chunks.join("\n")
}

function collectMedia(message: StoredMessage): TranscriptMediaReference[] {
  const media: TranscriptMediaReference[] = []
  for (const part of message.parts) {
    const candidate = part as {
      type?: unknown
      url?: unknown
      mediaType?: unknown
      filename?: unknown
    }
    if (
      candidate.type === "file" &&
      typeof candidate.url === "string" &&
      candidate.url.startsWith("cognia-media:")
    ) {
      media.push({
        ref: candidate.url,
        ...(typeof candidate.mediaType === "string" ? { mediaType: candidate.mediaType } : {}),
        ...(typeof candidate.filename === "string" ? { filename: candidate.filename } : {}),
      })
    }
  }
  return media
}

function preview(message: StoredMessage): TranscriptMessagePreview {
  const textResult = truncateUtf8(messageText(message), PREVIEW_TEXT_BYTE_LIMIT)
  const allMedia = collectMedia(message)
  return {
    id: message.id,
    role: message.role,
    ...(textResult.text ? { text: textResult.text } : {}),
    ...(allMedia.length > 0 ? { media: allMedia.slice(0, TRANSCRIPT_SUMMARY_MEDIA_LIMIT) } : {}),
    createdAt: message.createdAt,
    ...(textResult.truncated || allMedia.length > TRANSCRIPT_SUMMARY_MEDIA_LIMIT
      ? { truncated: true }
      : {}),
  }
}

function fullMessage(message: StoredMessage): TranscriptMessage {
  return {
    id: message.id,
    sessionId: message.sessionId,
    ...(message.turnKey ? { turnKey: message.turnKey } : {}),
    role: message.role,
    parts: message.parts,
    ...(message.senderId ? { senderId: message.senderId } : {}),
    ...(message.senderKind ? { senderKind: message.senderKind } : {}),
    ...(message.metadata ? { metadata: message.metadata } : {}),
    createdAt: message.createdAt,
  }
}

function branchSummary(
  messages: StoredMessage[],
  activeBranchByGroup: Record<string, string> | undefined
): { groups: TranscriptBranchGroupSummary[] } | undefined {
  const groups = new Map<string, Array<{ id: string; index: number }>>()
  for (const message of messages) {
    const groupId = message.metadata?.branchGroupId
    if (typeof groupId !== "string") continue
    const branchIndex = message.metadata?.branchIndex
    const members = groups.get(groupId) ?? []
    members.push({ id: message.id, index: typeof branchIndex === "number" ? branchIndex : 0 })
    groups.set(groupId, members)
  }
  if (groups.size === 0) return undefined
  return {
    groups: [...groups.entries()].map(([groupId, members]) => {
      const fallback = members.reduce((selected, member) =>
        member.index >= selected.index ? member : selected
      )
      const explicit = activeBranchByGroup?.[groupId]
      return {
        groupId,
        selectedMessageId: members.some((member) => member.id === explicit) ? explicit! : fallback.id,
        messageIds: members.map((member) => member.id),
      }
    }),
  }
}

function fitSummary(item: TranscriptTimelineItem): TranscriptTimelineItem {
  if (item.kind !== "completed-turn" || byteLength(item) <= TRANSCRIPT_SUMMARY_BYTE_LIMIT) {
    return item
  }
  const previews = [...item.userMessages, item.finalResponse, item.visibleResult].filter(
    (value): value is TranscriptMessagePreview => value !== undefined
  )
  let remaining = previews.reduce((sum, value) => sum + (value.text?.length ?? 0), 0)
  while (byteLength(item) > TRANSCRIPT_SUMMARY_BYTE_LIMIT && remaining > 0) {
    const target = previews.reduce((longest, value) =>
      (value.text?.length ?? 0) > (longest.text?.length ?? 0) ? value : longest
    )
    const current = target.text ?? ""
    const nextLength = Math.max(0, Math.floor(current.length * 0.75))
    target.text = current.slice(0, nextLength)
    target.truncated = true
    remaining -= current.length - nextLength
  }
  return item
}

function completedTurn(
  turnKey: string,
  messages: StoredMessage[],
  revision: number,
  activeBranchByGroup: Record<string, string> | undefined
): TranscriptTimelineItem {
  const userMessages = messages.filter((message) => message.role === "user")
  const visibleResponses = messages.filter((message) => message.role === "assistant")
  const finalResponseMessage = visibleResponses.at(-1)
  const finalResponseIndex = finalResponseMessage ? messages.indexOf(finalResponseMessage) : -1
  const mediaCount = messages.reduce((sum, message) => sum + collectMedia(message).length, 0)
  const item: TranscriptTimelineItem = {
    kind: "completed-turn",
    itemKey: turnKey,
    turnKey,
    revision,
    detailRevision: revision,
    status: messages.some((message) => message.metadata?.status === "failed")
      ? "failed"
      : "completed",
    userMessages: userMessages.map(preview),
    ...(finalResponseMessage ? { finalResponse: preview(finalResponseMessage) } : {}),
    collapsed: {
      exists: messages.length > userMessages.length + (finalResponseMessage ? 1 : 0),
      messageCount: messages.length,
      trailingCount:
        finalResponseIndex >= 0 ? Math.max(0, messages.length - finalResponseIndex - 1) : 0,
      mediaCount,
    },
    ...(branchSummary(messages, activeBranchByGroup)
      ? { branchSummary: branchSummary(messages, activeBranchByGroup) }
      : {}),
    startedAt: messages[0]?.createdAt ?? 0,
    completedAt: messages.at(-1)?.createdAt,
    durationMs: Math.max(0, (messages.at(-1)?.createdAt ?? 0) - (messages[0]?.createdAt ?? 0)),
  }
  return fitSummary(item)
}

export function projectTranscriptTimeline(options: ProjectTimelineOptions): TranscriptTimelineItem[] {
  const { messages, revision, activeTurnKey, activeBranchByGroup } = options
  const items: TranscriptTimelineItem[] = []
  let current: { turnKey: string; messages: StoredMessage[] } | null = null

  const flush = () => {
    if (!current) return
    if (current.turnKey === activeTurnKey) {
      const first = current.messages[0]
      items.push({
        kind: "active-turn",
        itemKey: current.turnKey,
        turnKey: current.turnKey,
        revision,
        status: "active",
        messages: current.messages.map(fullMessage),
        startedAt: first?.createdAt ?? 0,
      })
    } else {
      items.push(completedTurn(current.turnKey, current.messages, revision, activeBranchByGroup))
    }
    current = null
  }

  for (const message of messages) {
    if (message.role === "system" && current === null && !message.turnKey) {
      items.push({
        kind: "system",
        itemKey: `system:${message.id}`,
        revision,
        status: "completed",
        message: preview(message),
        startedAt: message.createdAt,
        completedAt: message.createdAt,
        durationMs: 0,
      })
      continue
    }

    const explicitKey = message.turnKey
    const startsNewImplicitTurn = message.role === "user" && current !== null && !explicitKey
    const changesExplicitTurn = explicitKey !== undefined && current !== null && explicitKey !== current.turnKey
    if (startsNewImplicitTurn || changesExplicitTurn) flush()

    if (!current) {
      const turnKey = explicitKey ?? `turn:${message.id}`
      current = { turnKey, messages: [] }
    }
    current.messages.push(message)
  }
  flush()
  return items
}

function encodeCursor(value: TimelineCursorPayload | TurnDetailCursorPayload): string {
  const bytes = encoder.encode(JSON.stringify(value))
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "")
}

function decodeCursor(value: string): unknown {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/")
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  return JSON.parse(new TextDecoder().decode(bytes))
}

export function encodeTimelineCursor(
  value: Omit<TimelineCursorPayload, "version">
): string {
  return encodeCursor({ version: TRANSCRIPT_PROTOCOL_VERSION, ...value })
}

export function encodeTurnDetailCursor(
  value: Omit<TurnDetailCursorPayload, "version">
): string {
  return encodeCursor({ version: TRANSCRIPT_PROTOCOL_VERSION, ...value })
}

export function validateTimelineCursor(
  cursor: string,
  expected: Pick<TimelineCursorPayload, "sessionId" | "revision" | "direction">
): CursorValidation<TimelineCursorPayload> {
  try {
    const value = decodeCursor(cursor) as Partial<TimelineCursorPayload>
    if (
      value.version !== TRANSCRIPT_PROTOCOL_VERSION ||
      typeof value.sessionId !== "string" ||
      typeof value.revision !== "number" ||
      (value.direction !== "backward" && value.direction !== "forward") ||
      typeof value.position !== "number" ||
      value.position < 0
    ) {
      return { ok: false, code: "INVALID_PARAMS" }
    }
    if (value.sessionId !== expected.sessionId || value.direction !== expected.direction) {
      return { ok: false, code: "INVALID_PARAMS" }
    }
    if (value.revision !== expected.revision) return { ok: false, code: "TRANSCRIPT_STALE" }
    return { ok: true, value: value as TimelineCursorPayload }
  } catch {
    return { ok: false, code: "INVALID_PARAMS" }
  }
}

export function validateTurnDetailCursor(
  cursor: string,
  expected: Pick<
    TurnDetailCursorPayload,
    "sessionId" | "revision" | "turnKey" | "detailRevision"
  >
): CursorValidation<TurnDetailCursorPayload> {
  try {
    const value = decodeCursor(cursor) as Partial<TurnDetailCursorPayload>
    if (
      value.version !== TRANSCRIPT_PROTOCOL_VERSION ||
      typeof value.sessionId !== "string" ||
      typeof value.revision !== "number" ||
      typeof value.turnKey !== "string" ||
      typeof value.detailRevision !== "number" ||
      typeof value.position !== "number" ||
      value.position < 0
    ) {
      return { ok: false, code: "INVALID_PARAMS" }
    }
    if (value.sessionId !== expected.sessionId) return { ok: false, code: "INVALID_PARAMS" }
    if (value.turnKey !== expected.turnKey) return { ok: false, code: "TURN_NOT_FOUND" }
    if (
      value.revision !== expected.revision ||
      value.detailRevision !== expected.detailRevision
    ) {
      return { ok: false, code: "TRANSCRIPT_STALE" }
    }
    return { ok: true, value: value as TurnDetailCursorPayload }
  } catch {
    return { ok: false, code: "INVALID_PARAMS" }
  }
}

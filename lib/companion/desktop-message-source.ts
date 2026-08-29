"use client"

/**
 * Desktop-side counterpart of the Rust
 * `companion::desktop_messages_bridge` (mobile completeness Phase 2).
 *
 * On every Tauri-only boot, this module subscribes to the three Tauri
 * events the Rust HTTP handler emits when the phone calls
 * `_rpc/message_update`, `_rpc/message_delete`, or `_rpc/session_list`.
 * For each request we run the appropriate Dexie call against
 * `messageRepository.update/delete` (lib/plugin/api/session-api.ts) or
 * the `sessions` table, build a result, and ship it back via the
 * `companion_message_response` Tauri command.
 *
 * The phone never talks directly to the desktop's Dexie — it asks
 * Rust, Rust asks the desktop WebView, the WebView reads / writes
 * Dexie, and the same primitive carries the answer all the way back.
 *
 * Modeled after `lib/sync/desktop-sync-source.ts:69` — same install
 * guard, same bridge-injection pattern for tests.
 */

import { messageRepository } from "@/lib/db"
import { getDb } from "@/lib/db/schema"
import type {
  ChatSession,
  SessionTimelinePage,
  SessionTimelineRequest,
  SessionTurnMessagesPage,
  SessionTurnMessagesRequest,
  StoredMessage,
  TranscriptMessage,
} from "@cognia/agent-config-types"
import {
  TRANSCRIPT_DETAIL_PAGE_BYTE_LIMIT,
  TRANSCRIPT_DETAIL_PAGE_DEFAULT,
  TRANSCRIPT_DETAIL_PAGE_MAX,
  TRANSCRIPT_TIMELINE_PAGE_DEFAULT,
  TRANSCRIPT_TIMELINE_PAGE_MAX,
} from "@cognia/agent-config-types"
import type { UIMessage } from "@/types"
import { listen } from "@tauri-apps/api/event"
import { invoke } from "@tauri-apps/api/core"
import { isSessionExposed } from "@/lib/chat/session-exposure"
import { getMessageMedia, parseMediaRef } from "@/lib/db/message-media"
import { isMessageMediaReferencedBySession } from "@/lib/db/message-media-refs"
import { commitTranscriptIndexPage } from "@/lib/db/chat-transcript-index"
import {
  encodeTimelineCursor,
  encodeTurnDetailCursor,
  projectTranscriptTimeline,
  validateTimelineCursor,
  validateTurnDetailCursor,
} from "@/lib/chat/transcript/projection"
import { transcriptCapabilitiesV1 } from "@/lib/chat/transcript/source"
import {
  assertLocalMutationAllowed,
  assertSharedSessionRead,
} from "@/lib/collab/shared-session-access"

const UPDATE_EVENT = "companion://message-update-request"
const DELETE_EVENT = "companion://message-delete-request"
const LIST_EVENT = "companion://session-list-request"
const GET_BY_SESSION_EVENT = "companion://message-get-by-session-request"
const SEND_EVENT = "companion://message-send-request"
const TRANSCRIPT_CAPABILITIES_EVENT = "companion://transcript-capabilities-request"
const SESSION_TIMELINE_EVENT = "companion://session-timeline-request"
const SESSION_TURN_MESSAGES_EVENT = "companion://session-turn-messages-request"
const SESSION_MEDIA_EVENT = "companion://session-media-request"
const RESPONSE_COMMAND = "companion_message_response"
const MAX_SESSION_LIST_PAGE_SIZE = 200

interface UpdateRequestEvent {
  requestId: string
  kind: "update"
  sessionId: string
  messageId: string
  updates: Partial<UIMessage> & Partial<StoredMessage>
}

interface DeleteRequestEvent {
  requestId: string
  kind: "delete"
  sessionId: string
  messageId: string
}

interface SessionListRequestEvent {
  requestId: string
  kind: "session_list"
  limit: number
  offset: number
  before?: number
}

interface GetMessagesRequestEvent {
  requestId: string
  kind: "message_get_by_session"
  sessionId: string
  limit?: number
  offset?: number
}

interface SendMessageRequestEvent {
  requestId: string
  kind: "message_send"
  sessionId: string
  content: string
  role?: string
}

interface TranscriptCapabilitiesRequestEvent {
  requestId: string
  kind: "transcript_capabilities"
}

interface SessionTimelineRequestEvent extends SessionTimelineRequest {
  requestId: string
  kind: "session_timeline"
}

interface SessionTurnMessagesRequestEvent extends SessionTurnMessagesRequest {
  requestId: string
  kind: "session_turn_messages"
}

interface SessionMediaRequestEvent {
  requestId: string
  kind: "session_media"
  sessionId: string
  hash: string
  variant: "thumbnail" | "canonical" | "original"
}

/** Tiny Tauri shape so the file types-check in pure-web tests too. */
interface TauriBridge {
  listen<T>(event: string, handler: (e: { payload: T }) => void): Promise<() => void>
  invoke(
    name: string,
    args?: Record<string, unknown> | Uint8Array,
    options?: { headers: Record<string, string> }
  ): Promise<unknown>
}

let installed = false

export interface InstallOptions {
  /** Inject a Tauri bridge for tests; defaults to the dynamic real one. */
  bridge?: TauriBridge
  /** Override the singleton-guard for tests. */
  forceReinstall?: boolean
}

export async function installDesktopMessageSource(opts: InstallOptions = {}): Promise<() => void> {
  if (installed && !opts.forceReinstall) return () => {}
  installed = true

  let bridge: TauriBridge
  if (opts.bridge) {
    bridge = opts.bridge
  } else {
    try {
      bridge = {
        listen,
        invoke: (name, args, options) => invoke(name, args, options),
      }
    } catch {
      installed = false
      return () => {}
    }
  }

  const offUpdate = await bridge.listen<UpdateRequestEvent>(UPDATE_EVENT, (event) => {
    void respondUpdate(event.payload, bridge)
  })
  const offDelete = await bridge.listen<DeleteRequestEvent>(DELETE_EVENT, (event) => {
    void respondDelete(event.payload, bridge)
  })
  const offList = await bridge.listen<SessionListRequestEvent>(LIST_EVENT, (event) => {
    void respondList(event.payload, bridge)
  })
  const offGetBySession = await bridge.listen<GetMessagesRequestEvent>(
    GET_BY_SESSION_EVENT,
    (event) => {
      void respondGetMessages(event.payload, bridge)
    }
  )
  const offSend = await bridge.listen<SendMessageRequestEvent>(SEND_EVENT, (event) => {
    void respondSendMessage(event.payload, bridge)
  })
  const offTranscriptCapabilities = await bridge.listen<TranscriptCapabilitiesRequestEvent>(
    TRANSCRIPT_CAPABILITIES_EVENT,
    (event) => void respondValue(event.payload.requestId, transcriptCapabilitiesV1(), bridge)
  )
  const offSessionTimeline = await bridge.listen<SessionTimelineRequestEvent>(
    SESSION_TIMELINE_EVENT,
    (event) => void respondSessionTimeline(event.payload, bridge)
  )
  const offSessionTurnMessages = await bridge.listen<SessionTurnMessagesRequestEvent>(
    SESSION_TURN_MESSAGES_EVENT,
    (event) => void respondSessionTurnMessages(event.payload, bridge)
  )
  const offSessionMedia = await bridge.listen<SessionMediaRequestEvent>(
    SESSION_MEDIA_EVENT,
    (event) => void respondSessionMedia(event.payload, bridge)
  )

  return () => {
    installed = false
    offUpdate()
    offDelete()
    offList()
    offGetBySession()
    offSend()
    offTranscriptCapabilities()
    offSessionTimeline()
    offSessionTurnMessages()
    offSessionMedia()
  }
}

async function respondValue(
  requestId: string,
  result: unknown,
  bridge: TauriBridge
): Promise<void> {
  await bridge.invoke(RESPONSE_COMMAND, { requestId, result, error: null })
}

async function respondError(requestId: string, error: unknown, bridge: TauriBridge): Promise<void> {
  await bridge.invoke(RESPONSE_COMMAND, {
    requestId,
    result: null,
    error: error instanceof Error ? error.message : String(error),
  })
}

async function respondSessionTimeline(
  request: SessionTimelineRequestEvent,
  bridge: TauriBridge
): Promise<void> {
  try {
    await respondValue(request.requestId, await readTranscriptTimeline(request), bridge)
  } catch (error) {
    await respondError(request.requestId, error, bridge)
  }
}

async function respondSessionTurnMessages(
  request: SessionTurnMessagesRequestEvent,
  bridge: TauriBridge
): Promise<void> {
  try {
    await respondValue(request.requestId, await readTranscriptTurnMessages(request), bridge)
  } catch (error) {
    await respondError(request.requestId, error, bridge)
  }
}

async function readBlobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === "function") {
    return new Uint8Array(await blob.arrayBuffer())
  }
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.onerror = () => reject(reader.error ?? new Error("Unable to read media bytes"))
    reader.readAsArrayBuffer(blob)
  })
}

async function blobDataUrl(blob: Blob, mediaType: string): Promise<string> {
  const bytes = await readBlobBytes(blob)
  let binary = ""
  const chunkSize = 32 * 1024
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return `data:${mediaType};base64,${btoa(binary)}`
}

async function expandLegacyMediaRefs(row: StoredMessage): Promise<StoredMessage> {
  const parts = await Promise.all(
    row.parts.map(async (part) => {
      const file = part as { type?: unknown; url?: unknown }
      const hash =
        file.type === "file" && typeof file.url === "string" ? parseMediaRef(file.url) : null
      if (!hash) return part
      const media = await getMessageMedia(hash)
      if (!media) return part
      try {
        return {
          ...part,
          url: await blobDataUrl(media.blob, media.mediaType),
        } as typeof part
      } catch {
        return part
      }
    })
  )
  return { ...row, parts }
}

async function respondSessionMedia(
  request: SessionMediaRequestEvent,
  bridge: TauriBridge
): Promise<void> {
  const fail = async (code: "INVALID_PARAMS" | "MEDIA_NOT_FOUND") => {
    await bridge.invoke("companion_media_response", new Uint8Array(), {
      headers: {
        "X-Cognia-Request-Id": request.requestId,
        "X-Cognia-Error": code,
        "Content-Type": "application/octet-stream",
      },
    })
  }
  if (
    !/^[a-f0-9]{64}$/.test(request.hash) ||
    !["thumbnail", "canonical", "original"].includes(request.variant)
  ) {
    await fail("INVALID_PARAMS")
    return
  }
  const session = await getDb().sessions.get(request.sessionId)
  if (
    !session ||
    !isSessionExposed(session, "external-connector") ||
    !(await isMessageMediaReferencedBySession(request.sessionId, request.hash))
  ) {
    await fail("MEDIA_NOT_FOUND")
    return
  }
  try {
    await assertSharedSessionRead(session)
  } catch {
    await fail("MEDIA_NOT_FOUND")
    return
  }
  const media = await getMessageMedia(request.hash)
  const blob =
    request.variant === "thumbnail"
      ? (media?.thumbBlob ?? media?.blob)
      : request.variant === "original"
        ? media?.originalBlob
        : media?.blob
  if (!media || !blob) {
    await fail("MEDIA_NOT_FOUND")
    return
  }
  await bridge.invoke("companion_media_response", await readBlobBytes(blob), {
    headers: {
      "X-Cognia-Request-Id": request.requestId,
      "Content-Type": blob.type || media.mediaType,
      ETag: `"${request.hash}:${request.variant}"`,
    },
  })
}

async function respondUpdate(req: UpdateRequestEvent, bridge: TauriBridge): Promise<void> {
  try {
    const [session, message] = await Promise.all([
      getDb().sessions.get(req.sessionId),
      getDb().messages.get(req.messageId),
    ])
    if (!session || !message || message.sessionId !== req.sessionId)
      throw new Error("SESSION_NOT_FOUND")
    assertLocalMutationAllowed(session, "message.correctOwn")
    await messageRepository.update(req.messageId, req.updates as Partial<UIMessage>)
    await bridge.invoke(RESPONSE_COMMAND, {
      requestId: req.requestId,
      result: null,
      error: null,
    })
  } catch (err: unknown) {
    await bridge.invoke(RESPONSE_COMMAND, {
      requestId: req.requestId,
      result: null,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

async function respondDelete(req: DeleteRequestEvent, bridge: TauriBridge): Promise<void> {
  try {
    const [session, message] = await Promise.all([
      getDb().sessions.get(req.sessionId),
      getDb().messages.get(req.messageId),
    ])
    if (!session || !message || message.sessionId !== req.sessionId)
      throw new Error("SESSION_NOT_FOUND")
    assertLocalMutationAllowed(session, "message.redactOwn")
    await messageRepository.delete(req.messageId)
    await bridge.invoke(RESPONSE_COMMAND, {
      requestId: req.requestId,
      result: null,
      error: null,
    })
  } catch (err: unknown) {
    await bridge.invoke(RESPONSE_COMMAND, {
      requestId: req.requestId,
      result: null,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

async function respondList(req: SessionListRequestEvent, bridge: TauriBridge): Promise<void> {
  try {
    const page = await readSessionPage(req.limit, req.offset, req.before)
    await bridge.invoke(RESPONSE_COMMAND, {
      requestId: req.requestId,
      result: page,
      error: null,
    })
  } catch (err: unknown) {
    await bridge.invoke(RESPONSE_COMMAND, {
      requestId: req.requestId,
      result: null,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

async function respondGetMessages(
  req: GetMessagesRequestEvent,
  bridge: TauriBridge
): Promise<void> {
  try {
    const page = await readMessagesPage(req.sessionId, req.limit, req.offset)
    await bridge.invoke(RESPONSE_COMMAND, {
      requestId: req.requestId,
      result: page,
      error: null,
    })
  } catch (err: unknown) {
    await bridge.invoke(RESPONSE_COMMAND, {
      requestId: req.requestId,
      result: null,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

async function respondSendMessage(
  req: SendMessageRequestEvent,
  bridge: TauriBridge
): Promise<void> {
  try {
    const created = await persistIncomingMessage(req.sessionId, req.content, req.role)
    await bridge.invoke(RESPONSE_COMMAND, {
      requestId: req.requestId,
      result: created,
      error: null,
    })
  } catch (err: unknown) {
    await bridge.invoke(RESPONSE_COMMAND, {
      requestId: req.requestId,
      result: null,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export type SessionListItem = Pick<
  ChatSession,
  | "id"
  | "title"
  | "kind"
  | "projectId"
  | "characterId"
  | "teamId"
  | "lastMessagePreview"
  | "lastMessageAt"
  | "createdAt"
  | "updatedAt"
>

export interface SessionListPage {
  rows: SessionListItem[]
  /** Present on legacy/direct-store responses; omitted by the indexed bridge. */
  total?: number
  next_offset?: number
  has_more?: boolean
}

/** Exposed for tests — production callers use the listener installed above. */
export async function readSessionPage(
  limit: number,
  offset: number,
  before?: number
): Promise<SessionListPage> {
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error("limit must be a positive number")
  }
  if (!Number.isFinite(offset) || offset < 0) {
    throw new Error("offset must be a non-negative number")
  }

  const pageSize = Math.min(limit, MAX_SESSION_LIST_PAGE_SIZE)
  const db = getDb()
  // Use the updatedAt index and stop after one extra visible row. The previous
  // `toArray → filter → sort → slice` path materialized every session,
  // including large system prompts and branch seeds, for a 50-row list.
  const ordered =
    typeof before === "number"
      ? db.sessions.where("updatedAt").below(before).reverse()
      : db.sessions.orderBy("updatedAt").reverse()
  const candidates = await ordered
    .filter((session) => isSessionExposed(session, "external-connector"))
    .offset(offset)
    .limit(pageSize + 1)
    .toArray()
  const accessible: ChatSession[] = []
  for (const session of candidates) {
    try {
      await assertSharedSessionRead(session)
      accessible.push(session)
    } catch {
      // Shared sessions are undiscoverable when current membership cannot be
      // revalidated. A paired device's client.read capability is not enough.
    }
  }
  const hasMore = candidates.length > pageSize
  const rows = accessible.slice(0, pageSize).map(projectSessionListItem)
  const nextOffset = hasMore ? offset + rows.length : undefined

  return {
    rows,
    next_offset: nextOffset,
    has_more: hasMore,
  }
}

function projectSessionListItem(session: ChatSession): SessionListItem {
  return {
    id: session.id,
    title: session.title,
    ...(session.kind !== undefined ? { kind: session.kind } : {}),
    ...(session.projectId !== undefined ? { projectId: session.projectId } : {}),
    ...(session.characterId !== undefined ? { characterId: session.characterId } : {}),
    ...(session.teamId !== undefined ? { teamId: session.teamId } : {}),
    ...(session.lastMessagePreview !== undefined
      ? { lastMessagePreview: session.lastMessagePreview }
      : {}),
    ...(session.lastMessageAt !== undefined ? { lastMessageAt: session.lastMessageAt } : {}),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  }
}

export interface MessagesPage {
  rows: StoredMessage[]
  /** Present on legacy/direct-store responses; omitted by the indexed bridge. */
  total?: number
  next_offset?: number
}

/**
 * Exposed for tests — production callers use the listener installed above.
 *
 * Reads a bounded page directly through the `[sessionId+createdAt]` index.
 * Returning raw `StoredMessage` rows lets the cloud client bulk-apply them
 * without a UIMessage conversion round-trip.
 */
export async function readMessagesPage(
  sessionId: string,
  limit?: number,
  offset?: number
): Promise<MessagesPage> {
  const session = await getDb().sessions.get(sessionId)
  if (!session || !isSessionExposed(session, "external-connector")) {
    throw new Error("SESSION_NOT_FOUND")
  }
  await assertSharedSessionRead(session)
  const start = typeof offset === "number" && offset > 0 ? offset : 0
  const pageSize = Math.min(typeof limit === "number" && limit > 0 ? limit : 200, 500)
  const collection = getDb().messages.where("[sessionId+createdAt]")
  const candidates = await collection
    .between([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER])
    .offset(start)
    .limit(pageSize + 1)
    .toArray()
  const hasMore = candidates.length > pageSize
  // Compatibility path for clients predating transcript/media V1. Capable
  // clients never call this full-message API; legacy clients cannot resolve a
  // content-addressed ref, so expand only this bounded wire page.
  const rows = await Promise.all(candidates.slice(0, pageSize).map(expandLegacyMediaRefs))
  const end = start + rows.length
  return {
    rows,
    next_offset: hasMore ? end : undefined,
  }
}

const TRANSCRIPT_SCAN_CHUNK = 200
const TRANSCRIPT_MAX_SCANNED_MESSAGES = 2_000

function transcriptError(code: string): Error {
  return Object.assign(new Error(code), { code })
}

async function transcriptRevision(sessionId: string): Promise<{
  revision: number
  activeBranchByGroup?: Record<string, string>
}> {
  const session = await getDb().sessions.get(sessionId)
  if (!session || !isSessionExposed(session, "external-connector")) {
    throw transcriptError("INVALID_PARAMS")
  }
  await assertSharedSessionRead(session)
  return {
    revision: session.transcriptRevision ?? 0,
    ...(session.activeBranchByGroup ? { activeBranchByGroup: session.activeBranchByGroup } : {}),
  }
}

/**
 * Read the newest completed turns without materializing the full session.
 * The cursor position counts raw rows from the newest edge; scanning stops as
 * soon as the requested number of user turn boundaries has been collected.
 */
export async function readTranscriptTimeline(
  request: SessionTimelineRequest
): Promise<SessionTimelinePage> {
  const direction = request.direction ?? "backward"
  if (direction !== "backward") throw transcriptError("INVALID_PARAMS")
  const limit = Math.min(
    Math.max(request.limit ?? TRANSCRIPT_TIMELINE_PAGE_DEFAULT, 1),
    TRANSCRIPT_TIMELINE_PAGE_MAX
  )
  const session = await transcriptRevision(request.sessionId)
  let position = 0
  if (request.cursor) {
    const validation = validateTimelineCursor(request.cursor, {
      sessionId: request.sessionId,
      revision: session.revision,
      direction,
    })
    if (!validation.ok) throw transcriptError(validation.code)
    position = validation.value.position
  }

  const rowsDescending: StoredMessage[] = []
  const explicitTurns = new Set<string>()
  let implicitTurns = 0
  let reachedLimit = false
  const collection = () =>
    getDb()
      .messages.where("[sessionId+createdAt]")
      .between([request.sessionId, 0], [request.sessionId, Number.MAX_SAFE_INTEGER])
      .reverse()

  while (!reachedLimit && rowsDescending.length < TRANSCRIPT_MAX_SCANNED_MESSAGES) {
    const chunk = await collection()
      .offset(position + rowsDescending.length)
      .limit(TRANSCRIPT_SCAN_CHUNK)
      .toArray()
    if (chunk.length === 0) break
    for (const row of chunk) {
      rowsDescending.push(row)
      if (row.turnKey) {
        explicitTurns.add(row.turnKey)
      } else if (row.role === "user") {
        implicitTurns += 1
      }
      if (explicitTurns.size + implicitTurns >= limit) {
        reachedLimit = true
        break
      }
      if (rowsDescending.length >= TRANSCRIPT_MAX_SCANNED_MESSAGES) break
    }
    if (chunk.length < TRANSCRIPT_SCAN_CHUNK) break
  }

  const nextPosition = position + rowsDescending.length
  const hasMore = (await collection().offset(nextPosition).limit(1).count()) > 0
  const rows = rowsDescending.reverse()
  const projected = projectTranscriptTimeline({
    sessionId: request.sessionId,
    revision: session.revision,
    messages: rows,
    activeBranchByGroup: session.activeBranchByGroup,
  })
  const items = projected.slice(-limit)
  // The summary index is a resumable cache, never a prerequisite for showing
  // the bounded page that was already read successfully. Quota/private-mode
  // failures must not turn a valid transcript response into a server error.
  await commitTranscriptIndexPage({
    sessionId: request.sessionId,
    revision: session.revision,
    items,
    complete: !hasMore,
  }).catch(() => undefined)
  return {
    items,
    revision: session.revision,
    ...(hasMore
      ? {
          nextCursor: encodeTimelineCursor({
            sessionId: request.sessionId,
            revision: session.revision,
            direction,
            position: nextPosition,
          }),
        }
      : {}),
    hasMore,
  }
}

function toTranscriptMessage(message: StoredMessage): TranscriptMessage {
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

async function readImplicitTurn(sessionId: string, turnKey: string): Promise<StoredMessage[]> {
  const anchorId = turnKey.startsWith("turn:") ? turnKey.slice("turn:".length) : ""
  const anchor = anchorId ? await getDb().messages.get(anchorId) : undefined
  if (!anchor || anchor.sessionId !== sessionId) throw transcriptError("TURN_NOT_FOUND")
  const candidates = await getDb()
    .messages.where("[sessionId+createdAt]")
    .between([sessionId, anchor.createdAt], [sessionId, Number.MAX_SAFE_INTEGER])
    .toArray()
  const rows: StoredMessage[] = []
  for (const row of candidates) {
    if (rows.length > 0 && row.role === "user" && !row.turnKey) break
    if (row.turnKey && row.turnKey !== turnKey) break
    rows.push(row)
  }
  return rows
}

/** Read one completed turn with both count and serialized-byte page budgets. */
export async function readTranscriptTurnMessages(
  request: SessionTurnMessagesRequest
): Promise<SessionTurnMessagesPage> {
  const session = await transcriptRevision(request.sessionId)
  if (session.revision !== request.revision || session.revision !== request.detailRevision) {
    throw transcriptError("TRANSCRIPT_STALE")
  }
  let position = 0
  if (request.cursor) {
    const validation = validateTurnDetailCursor(request.cursor, {
      sessionId: request.sessionId,
      revision: request.revision,
      turnKey: request.turnKey,
      detailRevision: request.detailRevision,
    })
    if (!validation.ok) throw transcriptError(validation.code)
    position = validation.value.position
  }

  const allRows = request.turnKey.startsWith("turn:")
    ? await readImplicitTurn(request.sessionId, request.turnKey)
    : await getDb()
        .messages.where("[sessionId+turnKey]")
        .equals([request.sessionId, request.turnKey])
        .sortBy("createdAt")
  if (allRows.length === 0) throw transcriptError("TURN_NOT_FOUND")

  const limit = Math.min(
    Math.max(request.limit ?? TRANSCRIPT_DETAIL_PAGE_DEFAULT, 1),
    TRANSCRIPT_DETAIL_PAGE_MAX
  )
  const page: TranscriptMessage[] = []
  let approximateBytes = 2
  for (const row of allRows.slice(position, position + limit + 1)) {
    if (page.length >= limit) break
    const message = toTranscriptMessage(row)
    const messageBytes = new TextEncoder().encode(JSON.stringify(message)).byteLength + 1
    if (page.length > 0 && approximateBytes + messageBytes > TRANSCRIPT_DETAIL_PAGE_BYTE_LIMIT)
      break
    if (page.length === 0 && messageBytes > TRANSCRIPT_DETAIL_PAGE_BYTE_LIMIT) {
      throw transcriptError("INVALID_PARAMS")
    }
    page.push(message)
    approximateBytes += messageBytes
  }
  const nextPosition = position + page.length
  const hasMore = nextPosition < allRows.length
  return {
    messages: page,
    revision: session.revision,
    detailRevision: session.revision,
    total: allRows.length,
    approximateBytes,
    ...(hasMore
      ? {
          nextCursor: encodeTurnDetailCursor({
            sessionId: request.sessionId,
            revision: session.revision,
            turnKey: request.turnKey,
            detailRevision: session.revision,
            position: nextPosition,
          }),
        }
      : {}),
    hasMore,
  }
}

/**
 * Exposed for tests — production callers use the listener installed above.
 *
 * Persists a message that arrived from a remote client (mobile) into the
 * desktop's Dexie. The desktop's normal chat flow drives any AI reply: if
 * the session is currently open on the desktop, the sidecar pipeline will
 * pick up the new message and stream a reply; if the desktop has the
 * session closed, the user message sits until the session is resumed.
 *
 * Phase A2 deliberately leaves the auto-trigger-sidecar step out — that
 * needs a UX design pass for offline-session handling, streaming UI on
 * mobile, and concurrent-edit collision recovery. Captured for follow-up.
 */
export async function persistIncomingMessage(
  sessionId: string,
  content: string,
  role: string | undefined
): Promise<{ message_id: string }> {
  if (!sessionId || typeof sessionId !== "string") {
    throw new Error("sessionId must be a non-empty string")
  }
  if (typeof content !== "string" || content.length === 0) {
    throw new Error("content must be a non-empty string")
  }
  const session = await getDb().sessions.get(sessionId)
  if (!session || !isSessionExposed(session, "external-connector")) {
    throw new Error("SESSION_NOT_FOUND")
  }
  assertLocalMutationAllowed(session, "session.post")
  const normalizedRole: "user" | "assistant" = role === "assistant" ? "assistant" : "user"
  const message: UIMessage = {
    id: generateMessageId(),
    role: normalizedRole,
    content,
    createdAt: new Date(),
  }
  const created = await messageRepository.create(sessionId, message)
  return { message_id: created.id }
}

function generateMessageId(): string {
  // 16 chars of base32-ish — enough for collision-free addressing without
  // pulling nanoid into this module (Dexie consumers already use nanoid
  // elsewhere; this helper avoids adding another import path here).
  const bytes = new Uint8Array(12)
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  return Array.from(bytes)
    .map((b) => b.toString(36).padStart(2, "0"))
    .join("")
}

/** Test-only — reset the install guard. */
export function __resetInstalledForTests(): void {
  installed = false
}

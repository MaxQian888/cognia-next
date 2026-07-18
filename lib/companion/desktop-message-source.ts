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
import type { ChatSession, StoredMessage } from "@cognia/agent-config-types"
import type { UIMessage } from "@/types"
import { listen } from "@tauri-apps/api/event"
import { invoke } from "@tauri-apps/api/core"
import { filterExposedSessions } from "@/lib/chat/session-exposure"

const UPDATE_EVENT = "companion://message-update-request"
const DELETE_EVENT = "companion://message-delete-request"
const LIST_EVENT = "companion://session-list-request"
const GET_BY_SESSION_EVENT = "companion://message-get-by-session-request"
const SEND_EVENT = "companion://message-send-request"
const RESPONSE_COMMAND = "companion_message_response"

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

/** Tiny Tauri shape so the file types-check in pure-web tests too. */
interface TauriBridge {
  listen<T>(event: string, handler: (e: { payload: T }) => void): Promise<() => void>
  invoke(name: string, args: Record<string, unknown>): Promise<unknown>
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
      bridge = { listen, invoke }
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

  return () => {
    installed = false
    offUpdate()
    offDelete()
    offList()
    offGetBySession()
    offSend()
  }
}

async function respondUpdate(req: UpdateRequestEvent, bridge: TauriBridge): Promise<void> {
  try {
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

export interface SessionListPage {
  rows: ChatSession[]
  total: number
  next_offset?: number
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

  const db = getDb()
  const all = await db.sessions.toArray()

  const exposed = filterExposedSessions(all, "external-connector")
  const filtered =
    typeof before === "number" ? exposed.filter((s) => Number(s.updatedAt ?? 0) < before) : exposed
  filtered.sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0))

  const total = filtered.length
  const rows = filtered.slice(offset, offset + limit)
  const nextOffset = offset + rows.length < total ? offset + rows.length : undefined

  return {
    rows,
    total,
    next_offset: nextOffset,
  }
}

export interface MessagesPage {
  rows: UIMessage[]
  total: number
  next_offset?: number
}

/**
 * Exposed for tests — production callers use the listener installed above.
 *
 * Reads messages for a single session via `messageRepository.getBySessionId`
 * (defined in `lib/plugin/api/session-api.ts`) and applies the same
 * offset/limit pagination the mobile UI expects.
 */
export async function readMessagesPage(
  sessionId: string,
  limit?: number,
  offset?: number
): Promise<MessagesPage> {
  const all = await messageRepository.getBySessionId(sessionId)
  const total = all.length
  const start = typeof offset === "number" && offset > 0 ? offset : 0
  const end = typeof limit === "number" && limit > 0 ? Math.min(start + limit, total) : total
  const rows = all.slice(start, end)
  return {
    rows,
    total,
    next_offset: end < total ? end : undefined,
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

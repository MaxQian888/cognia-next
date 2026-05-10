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
import type { ChatSession, StoredMessage } from "@/lib/claude/types"
import type { UIMessage } from "@/types"

const UPDATE_EVENT = "companion://message-update-request"
const DELETE_EVENT = "companion://message-delete-request"
const LIST_EVENT = "companion://session-list-request"
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
      const eventMod = (await import("@tauri-apps/api/event")) as {
        listen: TauriBridge["listen"]
      }
      const coreMod = (await import("@tauri-apps/api/core")) as {
        invoke: TauriBridge["invoke"]
      }
      bridge = { listen: eventMod.listen, invoke: coreMod.invoke }
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

  return () => {
    installed = false
    offUpdate()
    offDelete()
    offList()
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

  const filtered =
    typeof before === "number" ? all.filter((s) => Number(s.updatedAt ?? 0) < before) : all
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

/** Test-only — reset the install guard. */
export function __resetInstalledForTests(): void {
  installed = false
}

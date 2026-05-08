"use client"

/**
 * Desktop-side counterpart of the Rust `companion::sync_bridge`
 * (M4.7 / #51).
 *
 * On every Tauri-only boot, this module subscribes to the
 * `companion://sync-pull-request` event the Rust HTTP handler emits when
 * the phone calls `_rpc/sync_pull`. For each request we run the
 * appropriate Dexie query, build a [`SyncDelta`], and ship it back via
 * the `companion_sync_pull_response` Tauri command.
 *
 * The phone never talks directly to Dexie — it asks Rust, Rust asks the
 * desktop WebView, the WebView reads Dexie, and the same string of
 * primitives carries the answer all the way back.
 */

import type { Skill, StoredMessage, ChatSession, Character } from "@/lib/claude/types"
import { getDb } from "@/lib/db/schema"

import type { SyncDelta, SyncableTable } from "./types"

interface SyncPullRequestEvent {
  request_id: string
  table: SyncableTable | string
  since: number
}

const REQUEST_EVENT = "companion://sync-pull-request"
const RESPONSE_COMMAND = "companion_sync_pull_response"

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

export async function installDesktopSyncSource(opts: InstallOptions = {}): Promise<() => void> {
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

  const unlisten = await bridge.listen<SyncPullRequestEvent>(REQUEST_EVENT, (event) => {
    void respondToSyncRequest(event.payload, bridge)
  })

  return () => {
    installed = false
    unlisten()
  }
}

async function respondToSyncRequest(
  request: SyncPullRequestEvent,
  bridge: TauriBridge
): Promise<void> {
  const { request_id, table, since } = request
  try {
    const delta = await readDexieDelta(table, since)
    await bridge.invoke(RESPONSE_COMMAND, { requestId: request_id, delta, error: null })
  } catch (err: unknown) {
    await bridge.invoke(RESPONSE_COMMAND, {
      requestId: request_id,
      delta: null,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/** Exposed for tests — production callers use the listener installed above. */
export async function readDexieDelta(
  table: SyncableTable | string,
  since: number
): Promise<SyncDelta<unknown>> {
  switch (table) {
    case "characters":
      return readCharactersDelta(since)
    case "skills":
      return readSkillsDelta(since)
    case "sessions":
      return readSessionsDelta(since)
    case "messages":
      return readMessagesDelta(since)
    default:
      throw new Error(`unknown sync table: ${table}`)
  }
}

async function readCharactersDelta(since: number): Promise<SyncDelta<Character>> {
  const rows = (await getDb().characters.where("updatedAt").above(since).toArray()).filter(
    (row) => !row.isBuiltIn
  )
  return finalizeDelta(rows, since)
}

async function readSkillsDelta(since: number): Promise<SyncDelta<Skill>> {
  const all = await getDb().skills.toArray()
  const rows = all.filter((row) => Number(row.updatedAt ?? 0) > since)
  return finalizeDelta(rows, since)
}

async function readSessionsDelta(since: number): Promise<SyncDelta<ChatSession>> {
  const rows = await getDb().sessions.where("updatedAt").above(since).toArray()
  return finalizeDelta(rows, since)
}

async function readMessagesDelta(since: number): Promise<SyncDelta<StoredMessage>> {
  // The `messages` table only indexes `[sessionId+createdAt]`, not
  // `createdAt` alone — so we filter + sort in memory. The size cap of
  // 200 means at most one full table scan per pull, which is fine on
  // desktop hardware.  V2 may add a `createdAt` index if benchmarks
  // suggest it.
  const all = await getDb().messages.toArray()
  const filtered = all.filter((row) => Number(row.createdAt ?? 0) > since)
  filtered.sort((a, b) => Number(a.createdAt) - Number(b.createdAt))
  // Take the last 200 (newest) but return in ascending order so the
  // phone applies them in chronological sequence.
  const head = filtered.length > 200 ? filtered.slice(filtered.length - 200) : filtered
  return finalizeDelta(head, since)
}

interface UpdatedAtRow {
  id: string
  updatedAt?: number
  createdAt?: number
}

function finalizeDelta<T extends UpdatedAtRow>(rows: T[], since: number): SyncDelta<T> {
  let highestCursor = since
  for (const row of rows) {
    const candidate = Number(row.updatedAt ?? row.createdAt ?? 0)
    if (candidate > highestCursor) highestCursor = candidate
  }
  return {
    rows,
    // V1 doesn't track tombstones in Dexie — V2 will add a per-table
    // `deletedAt` index so we can surface deletions across the wire.
    deleted_ids: [],
    next_since: highestCursor,
  }
}

/** Test-only — reset the install guard. */
export function __resetInstalledForTests(): void {
  installed = false
}

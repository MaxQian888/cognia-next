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
import { useAccountStore } from "@/stores/account/account-store"
import { listen } from "@tauri-apps/api/event"
import { invoke } from "@tauri-apps/api/core"

import { readTombstonesSince } from "./tombstones"
import type { SyncDelta, SyncableTable } from "./types"

/** Page size for paged tables (messages). One round-trip pulls at most this many rows. */
const MESSAGES_PAGE_SIZE = 500

interface SyncPullRequestEvent {
  request_id: string
  table: SyncableTable | string
  since: number
  account_id?: string
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
      bridge = { listen, invoke }
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
    assertRequestAccountMatchesActiveAccount(request)
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

function assertRequestAccountMatchesActiveAccount(request: SyncPullRequestEvent): void {
  const activeAccountId = useAccountStore.getState().unlockedAccountId
  if (!activeAccountId) {
    throw new Error("sync pull rejected: no unlocked local account")
  }
  if (!request.account_id) {
    throw new Error("sync pull rejected: missing local account id")
  }
  if (request.account_id !== activeAccountId) {
    throw new Error("sync pull rejected: account mismatch")
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
    case "workflows":
      return readWorkflowsDelta(since)
    case "twinProfile":
      return readTwinProfileDelta(since)
    case "plugins":
      return readPluginsDelta(since)
    case "adapterInstances":
      return readAdapterInstancesDelta(since)
    case "settings":
      return readSettingsDelta(since)
    case "conversationOverrides":
      return readConversationOverridesDelta(since)
    case "goals":
      return readGoalsDelta(since)
    case "memories":
      return readMemoriesDelta(since)
    default:
      throw new Error(`unknown sync table: ${table}`)
  }
}

async function readCharactersDelta(since: number): Promise<SyncDelta<Character>> {
  const rows = (await getDb().characters.where("updatedAt").above(since).toArray()).filter(
    (row) => !row.isBuiltIn
  )
  return finalizeDelta("characters", rows, since)
}

async function readSkillsDelta(since: number): Promise<SyncDelta<Skill>> {
  // skills carries an `updatedAt` index (schema `id, name, updatedAt, ...`),
  // so pull only the rows past the cursor instead of scanning the whole
  // table into memory and filtering — a large skill library otherwise
  // hydrated every row on every pull. Mirrors readSessionsDelta.
  const rows = await getDb().skills.where("updatedAt").above(since).toArray()
  return finalizeDelta("skills", rows, since)
}

async function readSessionsDelta(since: number): Promise<SyncDelta<ChatSession>> {
  const rows = await getDb().sessions.where("updatedAt").above(since).toArray()
  return finalizeDelta("sessions", rows, since)
}

async function readMessagesDelta(since: number): Promise<SyncDelta<StoredMessage>> {
  // Page chat history by creation order via the v61 `[createdAt+id]` index
  // (no more full-table scan, no global newest-200 cap). One pull returns
  // up to MESSAGES_PAGE_SIZE rows past the cursor; the mobile handler keeps
  // pulling while the cursor advances, so a long conversation's full history
  // streams across several round-trips instead of being truncated.
  const page = await getDb()
    .messages.where("[createdAt+id]")
    .above([since, ""])
    .limit(MESSAGES_PAGE_SIZE)
    .toArray()
  return finalizeDelta("messages", page, since, page.length === MESSAGES_PAGE_SIZE)
}

async function readWorkflowsDelta(since: number): Promise<SyncDelta<unknown>> {
  const rows = await getDb().workflows.where("updatedAt").above(since).toArray()
  return finalizeDelta("workflows", rows as UpdatedAtRow[], since)
}

async function readTwinProfileDelta(since: number): Promise<SyncDelta<unknown>> {
  // twinProfile rows track changes via updatedAt; older rows without an
  // updatedAt always sync once and then settle.
  const all = await getDb().twinProfile.toArray()
  const rows = all.filter((row) => Number((row as { updatedAt?: number }).updatedAt ?? 0) > since)
  return finalizeDelta("twinProfile", rows as UpdatedAtRow[], since)
}

async function readPluginsDelta(since: number): Promise<SyncDelta<unknown>> {
  const all = await getDb().plugins.toArray()
  const rows = all.filter((row) => Number((row as { updatedAt?: number }).updatedAt ?? 0) > since)
  return finalizeDelta("plugins", rows as UpdatedAtRow[], since)
}

async function readAdapterInstancesDelta(since: number): Promise<SyncDelta<unknown>> {
  const rows = await getDb().adapterInstances.where("updatedAt").above(since).toArray()
  return finalizeDelta("adapterInstances", rows as UpdatedAtRow[], since)
}

async function readConversationOverridesDelta(since: number): Promise<SyncDelta<unknown>> {
  // v49 table; carries an `updatedAt` index (schema `&id, &conversationKey,
  // sessionId, pinned, archived, updatedAt`). Mobile mirrors pinned /
  // archived / lastReadAt so the Inbox renders correct buckets offline.
  const rows = await getDb().conversationOverrides.where("updatedAt").above(since).toArray()
  return finalizeDelta("conversationOverrides", rows as unknown as UpdatedAtRow[], since)
}

async function readGoalsDelta(since: number): Promise<SyncDelta<unknown>> {
  // chatGoals carries an `updatedAt` index (schema `…, createdAt, updatedAt`),
  // so pull only the rows past the cursor instead of scanning the whole table.
  const rows = await getDb().chatGoals.where("updatedAt").above(since).toArray()
  return finalizeDelta("goals", rows as UpdatedAtRow[], since)
}

async function readMemoriesDelta(since: number): Promise<SyncDelta<unknown>> {
  // memories has an `updatedAt` field but NOT an index on it (schema indexes
  // scope/type/status/…), so we can't `.where("updatedAt").above`. Read all
  // and filter — mirrors readPluginsDelta. The personal memory store is small.
  const all = await getDb().memories.toArray()
  const rows = all.filter((row) => Number((row as { updatedAt?: number }).updatedAt ?? 0) > since)
  return finalizeDelta("memories", rows as UpdatedAtRow[], since)
}

/**
 * Settings is a singleton row keyed `"singleton"`. We don't have a
 * per-row `updatedAt` field on it, so the rule is: emit the row whenever
 * the caller has never pulled it (`since === 0`) OR if it was changed
 * since the cursor. The mobile cache then warms once and any subsequent
 * pulls return an empty delta until the cursor is reset.
 */
async function readSettingsDelta(since: number): Promise<SyncDelta<unknown>> {
  const row = await getDb().settings.get("singleton")
  if (!row) return { rows: [], deleted_ids: [], next_since: since }
  const updatedAt = Number((row as { updatedAt?: number }).updatedAt ?? 0)
  if (since === 0 || updatedAt > since) {
    return {
      rows: [row],
      deleted_ids: [],
      next_since: updatedAt > 0 ? updatedAt : Date.now(),
    }
  }
  return { rows: [], deleted_ids: [], next_since: since }
}

interface UpdatedAtRow {
  id: string
  updatedAt?: number
  createdAt?: number
}

async function finalizeDelta<T extends UpdatedAtRow>(
  table: SyncableTable,
  rows: T[],
  since: number,
  hasMore = false
): Promise<SyncDelta<T>> {
  // Fold in tombstones recorded since the cursor (v61). The phone applies
  // `deleted_ids` via `bulkDelete`, so a desktop deletion finally reaches
  // it. `deletedAt` shares the cursor space with `updatedAt` — both feed
  // `next_since` so each upsert and each tombstone crosses the wire once.
  const { ids: deletedIds, maxDeletedAt } = await readTombstonesSince(table, since)

  let highestCursor = since
  for (const row of rows) {
    const candidate = Number(row.updatedAt ?? row.createdAt ?? 0)
    if (candidate > highestCursor) highestCursor = candidate
  }
  if (maxDeletedAt > highestCursor) highestCursor = maxDeletedAt

  return {
    rows,
    deleted_ids: deletedIds,
    next_since: highestCursor,
    has_more: hasMore,
  }
}

/** Test-only — reset the install guard. */
export function __resetInstalledForTests(): void {
  installed = false
}

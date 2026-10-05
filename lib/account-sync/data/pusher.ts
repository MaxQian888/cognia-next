/**
 * Pushing this device's changes (protocol §7.3).
 *
 * The outbox holds row ids and field names only; the op carries the row's
 * values as they are now, each with its clock. So a row written fifty times
 * while a reply streamed goes up once, with its final text.
 *
 * Ops are sealed under the list's current epoch, take consecutive device
 * sequence numbers from the cursor, and are pushed at most 256 at a time and
 * within the push size limit. An outbox entry is removed only if nothing
 * changed it while its push was in flight (`rev`), and only if the server
 * stored its op: ops under sequence numbers the server already holds (a push
 * whose answer was lost, then rebuilt from newer values) are acknowledged but
 * not stored, so their entries stay and go out again under fresh numbers.
 */

import {
  MAX_OPS_PER_PUSH,
  MAX_OP_PLAINTEXT_BYTES,
  MAX_PUSH_BYTES,
  encryptOpPayload,
  maxHlc,
  opKey,
  parseHlc,
  signOp,
  type ClockedValue,
  type Op,
  type OpPayload,
} from "@cognia/sync-protocol"

import type { DeviceKeys, EpochKeyChain } from "@/lib/account-sync/crypto"
import type { PushView } from "@/lib/account-sync/sync-api"
import type { CogniaDB } from "@/lib/db/schema"

import { SETTINGS_VALUE_FIELD } from "./capture-middleware"
import { SETTINGS_ROW_ID, SYNC_SCHEMA_VERSION, TABLE_POLICIES, syncedFields } from "./tables"
import type {
  AccountSyncCursorState,
  AccountSyncOutboxRow,
  SyncFieldClocksRow,
  SyncedTableName,
} from "./types"

/** Rough JSON size of an op on the wire beyond its ciphertext. */
const OP_ENVELOPE_BYTES = 400
/** Outbox rows read per round. */
const OUTBOX_PAGE = 512

export interface PushDeps {
  db: CogniaDB
  spaceId: string
  device: DeviceKeys
  chain: EpochKeyChain
  epoch: number
  push: (ops: Op[]) => Promise<PushView>
}

export interface PushResult {
  pushed: number
  /** Rows dropped from the outbox without an op (gone, filtered, or too large). */
  dropped: number
  /** Rows whose change cannot sync as one op (a field over the op size limit). */
  tooLarge: string[]
}

interface Outgoing {
  entry: AccountSyncOutboxRow
  payload: OpPayload
}

async function readCursor(db: CogniaDB, spaceId: string): Promise<AccountSyncCursorState> {
  const stored = (await db.accountSyncState.get("cursor")) as AccountSyncCursorState | undefined
  return stored?.spaceId === spaceId
    ? stored
    : { id: "cursor", spaceId, serverSeq: 0, deviceSeq: 0 }
}

/** The op for one outbox entry, or null when there is nothing to send. */
function payloadFor(
  entry: AccountSyncOutboxRow,
  row: Record<string, unknown> | undefined,
  clocks: SyncFieldClocksRow | undefined
): OpPayload | null {
  if (entry.deleted) {
    return clocks?.tombstone
      ? { t: entry.table, id: entry.rowId, k: "delete", at: clocks.tombstone }
      : null
  }
  if (!row || !clocks) return null
  const policy = TABLE_POLICIES[entry.table]
  const f: Record<string, ClockedValue> = {}
  if (entry.table === "settings") {
    const clock = clocks.fields[SETTINGS_VALUE_FIELD]
    if (!clock) return null
    f[SETTINGS_VALUE_FIELD] = [row[entry.rowId] ?? null, clock]
  } else {
    if (!policy.syncsRow(row)) return null
    const names = entry.resend
      ? syncedFields(policy).filter((name) => clocks.fields[name])
      : entry.fields
    for (const name of names) {
      const clock = clocks.fields[name]
      if (clock) f[name] = [row[name] ?? null, clock]
    }
  }
  if (Object.keys(f).length === 0) return null
  const u = clocks.unknown && Object.keys(clocks.unknown).length > 0 ? clocks.unknown : undefined
  return { t: entry.table, id: entry.rowId, k: "upsert", f, ...(u ? { u } : {}) }
}

async function readOutgoing(
  db: CogniaDB,
  entries: AccountSyncOutboxRow[]
): Promise<(Outgoing | null)[]> {
  const keys = entries.map((entry) => [entry.table, entry.rowId] as [string, string])
  const clocks = await db.syncFieldClocks.bulkGet(keys)
  let settingsRow: Record<string, unknown> | undefined
  if (entries.some((entry) => entry.table === "settings"))
    settingsRow = (await db.settings.get(SETTINGS_ROW_ID)) as Record<string, unknown> | undefined
  const byTable = new Map<SyncedTableName, string[]>()
  for (const entry of entries)
    if (entry.table !== "settings" && !entry.deleted)
      byTable.set(entry.table, [...(byTable.get(entry.table) ?? []), entry.rowId])
  const rows = new Map<string, Record<string, unknown> | undefined>()
  for (const [table, ids] of byTable) {
    const found = (await db.table(table).bulkGet(ids)) as (Record<string, unknown> | undefined)[]
    ids.forEach((id, index) => rows.set(`${table}\u0000${id}`, found[index]))
  }
  return entries.map((entry, index) => {
    const row =
      entry.table === "settings" ? settingsRow : rows.get(`${entry.table}\u0000${entry.rowId}`)
    const payload = payloadFor(entry, row, clocks[index])
    return payload ? { entry, payload } : null
  })
}

function opClock(payload: OpPayload): { ms: number; c: number } {
  const newest =
    payload.k === "delete" ? payload.at : maxHlc(Object.values(payload.f).map(([, hlc]) => hlc))!
  const parsed = parseHlc(newest)!
  return { ms: parsed.ms, c: parsed.c }
}

async function sealAll(
  deps: PushDeps,
  outgoing: Outgoing[],
  firstSeq: number
): Promise<{ ops: Op[]; sent: Outgoing[]; tooLarge: Outgoing[] }> {
  const key = deps.chain.get(deps.epoch)
  if (!key) throw new Error(`no key for the current epoch ${deps.epoch}`)
  const subkey = await opKey(key, deps.spaceId)
  const ops: Op[] = []
  const sent: Outgoing[] = []
  const tooLarge: Outgoing[] = []
  let bytes = 0
  for (const item of outgoing) {
    if (ops.length >= MAX_OPS_PER_PUSH) break
    if (new TextEncoder().encode(JSON.stringify(item.payload)).length > MAX_OP_PLAINTEXT_BYTES) {
      tooLarge.push(item)
      continue
    }
    const header = {
      deviceId: deps.device.deviceId,
      deviceSeq: firstSeq + ops.length,
      hlc: opClock(item.payload),
      epoch: deps.epoch,
      schemaVer: SYNC_SCHEMA_VERSION,
      cls: TABLE_POLICIES[item.entry.table].cls === "settings" ? ("s" as const) : ("c" as const),
    }
    const { nonce, ct } = await encryptOpPayload(subkey, deps.spaceId, header, item.payload)
    const size = ct.length + OP_ENVELOPE_BYTES
    if (ops.length > 0 && bytes + size > MAX_PUSH_BYTES) break
    bytes += size
    ops.push(await signOp(deps.device.sign.privateKey, deps.spaceId, { ...header, nonce, ct }))
    sent.push(item)
  }
  return { ops, sent, tooLarge }
}

/** Removes outbox entries a push covered, unless they changed meanwhile. */
async function settle(db: CogniaDB, entries: readonly AccountSyncOutboxRow[]): Promise<void> {
  if (entries.length === 0) return
  await db.transaction("rw", db.accountSyncOutbox, async () => {
    const keys = entries.map((entry) => [entry.table, entry.rowId] as [string, string])
    const current = await db.accountSyncOutbox.bulkGet(keys)
    const done = keys.filter((_, index) => current[index]?.rev === entries[index]!.rev)
    await db.accountSyncOutbox.bulkDelete(done)
  })
}

/** Pushes the whole outbox. Throws the push's `SyncApiError` (seq gap, stale epoch, removal). */
export async function pushOutbox(deps: PushDeps): Promise<PushResult> {
  const result: PushResult = { pushed: 0, dropped: 0, tooLarge: [] }
  const skipped = new Set<string>()
  for (;;) {
    const entries = (await deps.db.accountSyncOutbox.orderBy("[table+rowId]").toArray())
      .filter((entry) => !skipped.has(`${entry.table}\u0000${entry.rowId}`))
      .slice(0, OUTBOX_PAGE)
    if (entries.length === 0) return result
    const read = await readOutgoing(deps.db, entries)
    const empty = entries.filter((_, index) => read[index] === null)
    await settle(deps.db, empty)
    result.dropped += empty.length
    const outgoing = read.filter((item): item is Outgoing => item !== null)
    if (outgoing.length === 0) continue
    const cursor = await readCursor(deps.db, deps.spaceId)
    const { ops, sent, tooLarge } = await sealAll(deps, outgoing, cursor.deviceSeq + 1)
    for (const item of tooLarge) {
      skipped.add(`${item.entry.table}\u0000${item.entry.rowId}`)
      result.tooLarge.push(`${item.entry.table}:${item.entry.rowId}`)
    }
    if (ops.length === 0) continue
    const answer = await deps.push(ops)
    // The server stores the tail of the batch past its last sequence number.
    const stored =
      answer.firstSeq === null || answer.lastSeq === null ? 0 : answer.lastSeq - answer.firstSeq + 1
    await deps.db.accountSyncState.put({ ...cursor, deviceSeq: answer.deviceSeq })
    await settle(
      deps.db,
      sent.slice(sent.length - stored).map((item) => item.entry)
    )
    result.pushed += stored
  }
}

/**
 * Applying pulled ops (protocol §9).
 *
 * Each batch is checked and opened first (signatures, origin, decryption are
 * WebCrypto awaits, which would let an IndexedDB transaction commit), then
 * written in one transaction the capture middleware ignores: the winning
 * fields, the clocks, the cursor and this device's clock catching up.
 *
 * - This device's own ops are skipped (already applied when written).
 * - An op from a newer sync schema, or under an epoch key this device does not
 *   hold yet, is parked in the inbox as received and replayed later.
 * - Fields this build does not know are kept with the row's clocks and sent
 *   back untouched on its next write; `local` fields are never applied.
 * - Ops of a class this device switched off are passed over.
 */

import {
  OpError,
  decryptOpPayload,
  mergeDelete,
  mergeUpsert,
  opKey,
  parseOp,
  receiveHlc,
  type ClockedValue,
  type FoldedRegistry,
  type HlcTime,
  type Op,
  type OpPayload,
  type RowClocks,
} from "@cognia/sync-protocol"

import type { EpochKeyChain } from "@/lib/account-sync/crypto"
import type { CogniaDB } from "@/lib/db/schema"

import { SETTINGS_VALUE_FIELD, classOn, markRemoteTransaction } from "./capture-middleware"
import type { OpOriginChecker } from "./op-origin"
import {
  SETTINGS_ROW_ID,
  SYNCED_SETTINGS_KEYS,
  SYNCED_TABLES,
  SYNC_SCHEMA_VERSION,
  TABLE_POLICIES,
  isSyncedTable,
} from "./tables"
import type {
  AccountSyncCaptureState,
  AccountSyncCursorState,
  AccountSyncInboxRow,
  AccountSyncOutboxRow,
  SyncFieldClocksRow,
  SyncedTableName,
} from "./types"

export class OpIntegrityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OpIntegrityError"
  }
}

export interface ApplyDeps {
  db: CogniaDB
  spaceId: string
  /** This device. */
  deviceId: string
  registry: FoldedRegistry
  chain: EpochKeyChain
  origin: OpOriginChecker
  now: () => number
}

export interface ApplyResult {
  applied: number
  parked: number
  /** Tables something was written to (callers refresh what depends on them). */
  tables: Set<SyncedTableName>
}

export interface PulledBatch {
  firstSeq: number
  lastSeq: number
  ops: unknown[]
}

type Prepared =
  | { kind: "skip"; serverSeq: number }
  | { kind: "park"; serverSeq: number; op: Op; reason: AccountSyncInboxRow["reason"] }
  | { kind: "apply"; serverSeq: number; op: Op; payload: OpPayload }

async function prepare(deps: ApplyDeps, op: Op, serverSeq: number): Promise<Prepared> {
  if (op.deviceId === deps.deviceId) return { kind: "skip", serverSeq }
  if (op.schemaVer > SYNC_SCHEMA_VERSION) return { kind: "park", serverSeq, op, reason: "schema" }
  const key = deps.chain.get(op.epoch)
  if (op.epoch > deps.registry.state.epoch || !key)
    return { kind: "park", serverSeq, op, reason: "key" }
  await deps.origin.check(op)
  let payload: OpPayload
  try {
    payload = await decryptOpPayload(await opKey(key, deps.spaceId), deps.spaceId, op)
  } catch (error) {
    if (error instanceof OpError)
      throw new OpIntegrityError(`op ${op.deviceId}/${op.deviceSeq}: ${error.message}`)
    throw error
  }
  // Same schema version, unknown table: nothing this build can do with it.
  if (!isSyncedTable(payload.t)) return { kind: "skip", serverSeq }
  return { kind: "apply", serverSeq, op, payload }
}

function rowWith(base: Record<string, unknown>, fields: Record<string, unknown>) {
  const next = { ...base }
  for (const [name, value] of Object.entries(fields)) {
    if (value === null || value === undefined) delete next[name]
    else next[name] = value
  }
  return next
}

/** Unknown fields merged per field by clock; true if anything changed. */
function mergeUnknown(
  held: SyncFieldClocksRow["unknown"],
  incoming: Record<string, ClockedValue>
): { unknown: SyncFieldClocksRow["unknown"]; changed: boolean } {
  const unknown = { ...held }
  let changed = false
  for (const [name, entry] of Object.entries(incoming)) {
    const current = unknown[name]
    if (current && entry[1] <= current[1]) continue
    unknown[name] = entry
    changed = true
  }
  return { unknown, changed }
}

async function markResend(db: CogniaDB, table: SyncedTableName, rowId: string, now: number) {
  const queued = await db.accountSyncOutbox.get([table, rowId])
  const row: AccountSyncOutboxRow = {
    table,
    rowId,
    fields: queued && !queued.deleted ? queued.fields : [],
    deleted: false,
    resend: true,
    rev: (queued?.rev ?? 0) + 1,
    since: queued?.since ?? now,
  }
  await db.accountSyncOutbox.put(row)
}

async function applyRecord(db: CogniaDB, payload: OpPayload, now: number): Promise<boolean> {
  const table = payload.t as SyncedTableName
  const policy = TABLE_POLICIES[table]
  const store = db.table(table)
  const [row, held] = (await Promise.all([
    store.get(payload.id),
    db.syncFieldClocks.get([table, payload.id]),
  ])) as [Record<string, unknown> | undefined, SyncFieldClocksRow | undefined]
  const clocks: RowClocks | undefined = held
  if (payload.k === "delete") {
    const result = mergeDelete(row !== undefined, clocks, payload.at)
    if (result.kind === "ignore") return false
    if (result.kind === "survive") {
      await db.syncFieldClocks.put({ ...held, ...result.clocks, table, rowId: payload.id })
      await markResend(db, table, payload.id, now)
      return false
    }
    if (row) await store.delete(payload.id)
    await db.syncFieldClocks.put({ table, rowId: payload.id, ...result.clocks })
    await db.accountSyncOutbox.delete([table, payload.id])
    return row !== undefined
  }
  const known: Record<string, ClockedValue> = {}
  const unknownIn: Record<string, ClockedValue> = {}
  for (const [name, entry] of [...Object.entries(payload.u ?? {}), ...Object.entries(payload.f)]) {
    const kind = policy.fields[name]
    if (kind === "sync") known[name] = entry
    else if (kind === undefined) unknownIn[name] = entry
  }
  const result = mergeUpsert(row !== undefined, clocks, known)
  const { unknown, changed } = mergeUnknown(held?.unknown, unknownIn)
  if (result.kind === "write") {
    await store.put(rowWith(result.created ? { id: payload.id } : row!, result.fields))
  }
  if (result.kind === "write" || changed) {
    const base = result.kind === "write" ? result.clocks : (clocks ?? { fields: {} })
    await db.syncFieldClocks.put({
      ...base,
      table,
      rowId: payload.id,
      ...(unknown && Object.keys(unknown).length > 0 ? { unknown } : {}),
    })
  }
  return result.kind === "write"
}

async function applySetting(db: CogniaDB, payload: OpPayload, now: number): Promise<boolean> {
  if (payload.k !== "upsert" || !SYNCED_SETTINGS_KEYS.has(payload.id)) return false
  const entry = payload.f[SETTINGS_VALUE_FIELD]
  if (!entry) return false
  const held = await db.syncFieldClocks.get(["settings", payload.id])
  const result = mergeUpsert(true, held, { [SETTINGS_VALUE_FIELD]: entry })
  if (result.kind !== "write") return false
  const current = ((await db.settings.get(SETTINGS_ROW_ID)) ?? { id: SETTINGS_ROW_ID }) as Record<
    string,
    unknown
  >
  // `updatedAt` moves so the companion data plane re-sends the row to paired phones.
  await db.settings.put(
    rowWith({ ...current, updatedAt: now }, { [payload.id]: entry[0] }) as never
  )
  await db.syncFieldClocks.put({ ...result.clocks, table: "settings", rowId: payload.id })
  return true
}

async function write(
  deps: ApplyDeps,
  prepared: readonly Prepared[],
  options: { cursorSeq?: number; fromInbox?: readonly number[] },
  result: ApplyResult
): Promise<void> {
  const { db } = deps
  const stores = [
    ...SYNCED_TABLES.map((table) => db.table(table)),
    db.syncFieldClocks,
    db.accountSyncOutbox,
    db.accountSyncState,
    db.accountSyncInbox,
  ]
  await db.transaction("rw", stores, async (tx) => {
    markRemoteTransaction(tx.idbtrans)
    const capture = (await db.accountSyncState.get("capture")) as
      AccountSyncCaptureState | undefined
    let clock: HlcTime | null = capture?.hlc ?? null
    const now = deps.now()
    for (const item of prepared) {
      if (item.kind === "park") {
        await db.accountSyncInbox.put({
          serverSeq: item.serverSeq,
          op: item.op,
          reason: item.reason,
          receivedAt: now,
        })
        result.parked++
        continue
      }
      if (item.kind === "skip") continue
      // A class switched off on this device is neither sent nor taken; turning
      // it back on seeds it and pulls the account again (`engine.setClasses`).
      if (capture && !classOn(capture, TABLE_POLICIES[item.payload.t as SyncedTableName])) continue
      const wrote =
        item.payload.t === "settings"
          ? await applySetting(db, item.payload, now)
          : await applyRecord(db, item.payload, now)
      if (wrote) result.tables.add(item.payload.t as SyncedTableName)
      result.applied++
      clock = receiveHlc(clock, item.op.hlc, now)
    }
    if (options.fromInbox?.length) await db.accountSyncInbox.bulkDelete([...options.fromInbox])
    if (capture && clock) await db.accountSyncState.put({ ...capture, hlc: clock })
    if (options.cursorSeq !== undefined) {
      const cursor = (await db.accountSyncState.get("cursor")) as AccountSyncCursorState | undefined
      await db.accountSyncState.put({
        id: "cursor",
        spaceId: deps.spaceId,
        deviceSeq: cursor?.spaceId === deps.spaceId ? cursor.deviceSeq : 0,
        serverSeq: options.cursorSeq,
      })
    }
  })
}

/** Applies pulled batches in order and moves the cursor past each. */
export async function applyBatches(
  deps: ApplyDeps,
  batches: readonly PulledBatch[]
): Promise<ApplyResult> {
  const result: ApplyResult = { applied: 0, parked: 0, tables: new Set() }
  for (const batch of batches) {
    const prepared: Prepared[] = []
    for (let index = 0; index < batch.ops.length; index++) {
      let op: Op
      try {
        op = parseOp(batch.ops[index])
      } catch (error) {
        if (error instanceof OpError)
          throw new OpIntegrityError(`malformed op at ${batch.firstSeq + index}`)
        throw error
      }
      prepared.push(await prepare(deps, op, batch.firstSeq + index))
    }
    await write(deps, prepared, { cursorSeq: batch.lastSeq }, result)
  }
  return result
}

/** Applies every parked op this device can apply now (a newer key chain, a newer build). */
export async function replayInbox(deps: ApplyDeps): Promise<ApplyResult> {
  const result: ApplyResult = { applied: 0, parked: 0, tables: new Set() }
  const parked = await deps.db.accountSyncInbox.orderBy("serverSeq").toArray()
  const ready: Prepared[] = []
  const done: number[] = []
  for (const row of parked) {
    const prepared = await prepare(deps, row.op, row.serverSeq)
    if (prepared.kind === "park") continue
    ready.push(prepared)
    done.push(row.serverSeq)
  }
  if (done.length > 0) await write(deps, ready, { fromInbox: done }, result)
  return result
}

/** Parked ops, by reason (the sync section says why changes are waiting). */
export async function parkedCounts(db: CogniaDB): Promise<{ schema: number; key: number }> {
  const [schema, key] = await Promise.all([
    db.accountSyncInbox.where("reason").equals("schema").count(),
    db.accountSyncInbox.where("reason").equals("key").count(),
  ])
  return { schema, key }
}

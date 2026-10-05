/**
 * Change capture for account sync (ADR-0215 §6, protocol §9): a DBCore
 * middleware that records, in the same IndexedDB transaction as the write
 * itself, which synced fields of which rows changed and with what clock.
 *
 * - **Level 3**, above content encryption (level 2): it sees plaintext rows,
 *   and its own side tables are written through the layers below, so the
 *   clocks table is encrypted at rest like any other content table.
 * - **Armed by a row, not by memory.** `accountSyncState.capture` names the
 *   space and device and is read inside the write's own transaction. Writes
 *   made before the sync engine starts are captured, and two tabs serialize on
 *   the same row, so they never issue the same clock.
 * - **What changed.** `update()`/`modify()` say so (`changeSpec`); a
 *   whole-row `put` is diffed against the previous row (messages are not, see
 *   `tables.ts`). The outbox keeps only names: the pusher sends the row's
 *   current values, which coalesces a stream of writes into one op.
 * - **Remote writes are not captured.** The applier registers its
 *   transaction with {@link markRemoteTransaction}; anything else is local.
 */

import Dexie, {
  type DBCore,
  type DBCoreMutateRequest,
  type DBCoreMutateResponse,
  type DBCoreTable,
  type DBCoreTransaction,
  type Middleware,
} from "dexie"

import { encodeHlc, sendHlc } from "@cognia/sync-protocol"

import { sameValue } from "./stable-json"
import { TABLE_POLICIES, isSyncedTable, syncedFields, type TablePolicy } from "./tables"
import type {
  AccountSyncCaptureState,
  AccountSyncOutboxRow,
  SyncFieldClocksRow,
  SyncedTableName,
} from "./types"

export const CAPTURE_MIDDLEWARE_LEVEL = 3
export const SIDE_TABLES = ["accountSyncOutbox", "syncFieldClocks", "accountSyncState"] as const
/** The field name of a settings key's virtual row. */
export const SETTINGS_VALUE_FIELD = "value"

const remoteTransactions = new WeakSet<object>()

/**
 * Dexie's own layers below this one (hooks, the live-query cache) read the
 * current transaction from Dexie's zone (`PSD`), which an `await` inside this
 * middleware does not carry. Every call down is made inside the zone the
 * request arrived in. `Dexie.Promise.PSD` / `usePSD` are Dexie's runtime API
 * for exactly this, missing only from its type declarations.
 */
interface DexieZones {
  readonly PSD: unknown
  usePSD<T>(psd: unknown, fn: () => T): T
}
const zones = Dexie.Promise as unknown as DexieZones

type InZone = <T>(fn: () => T) => T

/**
 * What this transaction's captures have already written, in memory. Several
 * writes can be in flight in one transaction; each awaits its reads, then
 * merges against this synchronously and issues its puts in that order, so the
 * last put of a row always carries every capture before it. (Chaining the
 * writes one after another instead deadlocks against Dexie's own write locks,
 * and IndexedDB then commits the idle transaction under them.)
 */
interface TransactionCapture {
  state?: AccountSyncCaptureState
  outbox: Map<string, AccountSyncOutboxRow>
  clocks: Map<string, SyncFieldClocksRow>
}

function rowKey(table: string, rowId: string): string {
  return `${table}\u0000${rowId}`
}

/**
 * Marks a transaction as applying remote ops: its writes are not captured.
 * Pass the Dexie transaction's `idbtrans` (what DBCore sees as `trans`).
 */
export function markRemoteTransaction(trans: object): void {
  remoteTransactions.add(trans)
}

interface RowChange {
  rowId: string
  /** Changed synced fields; ignored when `deleted`. */
  fields: string[]
  deleted: boolean
}

function topLevelField(keyPath: string): string {
  const dot = keyPath.indexOf(".")
  return dot === -1 ? keyPath : keyPath.slice(0, dot)
}

function changedBySpec(spec: Record<string, unknown>, synced: ReadonlySet<string>): string[] {
  return [...new Set(Object.keys(spec).map(topLevelField))].filter((name) => synced.has(name))
}

function changedByDiff(
  previous: Record<string, unknown> | undefined,
  next: Record<string, unknown>,
  fields: readonly string[]
): string[] {
  if (!previous) return fields.filter((name) => next[name] !== undefined && next[name] !== null)
  return fields.filter((name) => !sameValue(previous[name], next[name]))
}

/** Whether `policy`'s class syncs on this device (both directions). */
export function classOn(state: AccountSyncCaptureState, policy: TablePolicy): boolean {
  return policy.cls === "settings" ? state.classes.settings : state.classes.content
}

async function keysInRange(
  table: DBCoreTable,
  request: DBCoreMutateRequest,
  zone: InZone
): Promise<unknown[]> {
  if (request.type !== "deleteRange") return []
  const result = await zone(() =>
    table.query({
      trans: request.trans,
      values: false,
      query: { index: table.schema.primaryKey, range: request.range },
    })
  )
  return result.result as unknown[]
}

/** Which rows (or settings keys) a write changes, and which of their synced fields. */
async function changesOf(
  table: DBCoreTable,
  policy: TablePolicy,
  request: DBCoreMutateRequest,
  zone: InZone
): Promise<RowChange[]> {
  const fields = syncedFields(policy)
  const synced = new Set(fields)
  if (request.type === "delete" || request.type === "deleteRange") {
    // A wiped settings row is a local reset, never a remote delete of every key.
    if (policy.table === "settings") return []
    const keys = request.type === "delete" ? request.keys : await keysInRange(table, request, zone)
    return keys.map((key) => ({ rowId: String(key), fields: [], deleted: true }))
  }
  const values = request.values as Record<string, unknown>[]
  const keys =
    request.keys ?? values.map((value) => table.schema.primaryKey.extractKey?.(value) ?? value.id)
  const needPrevious =
    policy.diff && !(request.type === "put" && (request.updates || request.changeSpec))
  const previous = needPrevious
    ? ((await zone(() => table.getMany({ trans: request.trans, keys }))) as (
        Record<string, unknown> | undefined
      )[])
    : []
  const changes: RowChange[] = []
  values.forEach((value, index) => {
    if (!policy.syncsRow(value)) return
    const spec =
      request.type === "put"
        ? (request.updates?.changeSpecs[index] ?? request.changeSpec)
        : undefined
    const changed = spec
      ? changedBySpec(spec, synced)
      : policy.diff
        ? changedByDiff(previous[index], value, fields)
        : fields.filter((name) => value[name] !== undefined)
    if (policy.table === "settings") {
      for (const key of changed)
        changes.push({ rowId: key, fields: [SETTINGS_VALUE_FIELD], deleted: false })
    } else if (changed.length > 0) {
      changes.push({ rowId: String(keys[index]), fields: changed, deleted: false })
    }
  })
  return changes
}

async function record(
  down: DBCore,
  trans: DBCoreTransaction,
  table: SyncedTableName,
  changes: readonly RowChange[],
  captured: TransactionCapture,
  zone: InZone
): Promise<void> {
  const outbox = down.table("accountSyncOutbox")
  const clocks = down.table("syncFieldClocks")
  const keys = changes.map((change) => [table, change.rowId])
  const [queued, clocked] = (await Promise.all([
    zone(() => outbox.getMany({ trans, keys })),
    zone(() => clocks.getMany({ trans, keys })),
  ])) as [(AccountSyncOutboxRow | undefined)[], (SyncFieldClocksRow | undefined)[]]
  // From here to the puts nothing awaits: this capture's merge is atomic
  // against every other capture in the transaction.
  const state = captured.state!
  const hlc = sendHlc(state.hlc, Date.now(), state.deviceId)
  captured.state = { ...state, hlc: { ms: hlc.ms, c: hlc.c } }
  const at = encodeHlc(hlc)
  const now = Date.now()
  const outboxRows: AccountSyncOutboxRow[] = []
  const clockRows: SyncFieldClocksRow[] = []
  changes.forEach((change, index) => {
    const key = rowKey(table, change.rowId)
    const before = captured.outbox.get(key) ?? queued[index]
    const held = captured.clocks.get(key) ?? clocked[index]
    let queuedRow: AccountSyncOutboxRow
    let clockRow: SyncFieldClocksRow
    if (change.deleted) {
      queuedRow = {
        table,
        rowId: change.rowId,
        fields: [],
        deleted: true,
        rev: (before?.rev ?? 0) + 1,
        since: before?.since ?? now,
      }
      clockRow = { table, rowId: change.rowId, fields: {}, tombstone: at }
    } else {
      const fields = new Set(before && !before.deleted ? before.fields : [])
      for (const name of change.fields) fields.add(name)
      queuedRow = {
        table,
        rowId: change.rowId,
        fields: [...fields].sort(),
        deleted: false,
        ...(before?.resend ? { resend: true } : {}),
        rev: (before?.rev ?? 0) + 1,
        since: before?.since ?? now,
      }
      const fieldClocks = { ...held?.fields }
      for (const name of change.fields) fieldClocks[name] = at
      clockRow = { ...held, table, rowId: change.rowId, fields: fieldClocks }
    }
    captured.outbox.set(key, queuedRow)
    captured.clocks.set(key, clockRow)
    outboxRows.push(queuedRow)
    clockRows.push(clockRow)
  })
  const writes = [
    zone(() => outbox.mutate({ type: "put", trans, values: outboxRows })),
    zone(() => clocks.mutate({ type: "put", trans, values: clockRows })),
    zone(() =>
      down.table("accountSyncState").mutate({ type: "put", trans, values: [captured.state] })
    ),
  ]
  await Promise.all(writes)
}

export function createAccountSyncCaptureMiddleware(): Middleware<DBCore> {
  return {
    stack: "dbcore",
    name: "AccountSyncCapture",
    level: CAPTURE_MIDDLEWARE_LEVEL,
    create(down) {
      // Dexie also builds a stack for an older schema while it upgrades.
      const names = new Set(down.schema.tables.map((table) => table.name))
      if (!SIDE_TABLES.every((name) => names.has(name))) return down
      const captures = new WeakMap<DBCoreTransaction, TransactionCapture>()
      return {
        ...down,
        transaction(stores, mode, options) {
          if (mode !== "readwrite" || !stores.some(isSyncedTable)) {
            return down.transaction(stores, mode, options)
          }
          const widened = [...stores]
          for (const side of SIDE_TABLES) if (!widened.includes(side)) widened.push(side)
          return down.transaction(widened, mode, options)
        },
        table(name) {
          const table = down.table(name)
          if (!isSyncedTable(name)) return table
          const policy = TABLE_POLICIES[name]
          return {
            ...table,
            mutate(request): Promise<DBCoreMutateResponse> {
              if (remoteTransactions.has(request.trans)) return table.mutate(request)
              const psd = zones.PSD
              const zone: InZone = (fn) => zones.usePSD(psd, fn)
              let captured = captures.get(request.trans)
              if (!captured) {
                captured = { outbox: new Map(), clocks: new Map() }
                captures.set(request.trans, captured)
              }
              const own = captured
              return (async () => {
                if (!own.state) {
                  const stored = (await zone(() =>
                    down.table("accountSyncState").get({ trans: request.trans, key: "capture" })
                  )) as AccountSyncCaptureState | undefined
                  // Another capture in this transaction may have read (and advanced) it meanwhile.
                  if (stored && !own.state) own.state = stored
                }
                if (own.state && classOn(own.state, policy)) {
                  const changes = await changesOf(table, policy, request, zone)
                  if (changes.length > 0)
                    await record(down, request.trans, name, changes, own, zone)
                }
                return zone(() => table.mutate(request))
              })()
            },
          }
        },
      }
    },
  }
}

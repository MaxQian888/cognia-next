import Dexie, {
  type DBCore,
  type DBCoreCursor,
  type DBCoreMutateRequest,
  type DBCoreTable,
  type Middleware,
} from "dexie"

import {
  getActiveAccountContentCipher,
  type EncryptedContentEnvelope,
} from "@/lib/accounts/content-cipher"
import { policyForTable } from "@/lib/data-governance/table-catalog"

export const CONTENT_ENCRYPTION_SCHEMA_VERSION = 1
export const ENCRYPTED_CONTENT_FIELD = "__cogniaEncryptedContent"

type StoredEncryptedRow = Record<string, unknown> & {
  [ENCRYPTED_CONTENT_FIELD]: EncryptedContentEnvelope
}

export function createEncryptedContentMiddleware(databaseName: string): Middleware<DBCore> {
  return {
    stack: "dbcore",
    name: "AccountEncryptedContentMiddleware",
    level: 2,
    create: (down) => ({
      ...down,
      table: (tableName) => {
        const table = down.table(tableName)
        if (policyForTable(tableName)?.contentProtection !== "encrypted-content") return table
        return encryptedTable(databaseName, table)
      },
    }),
  }
}

/**
 * Hold the surrounding IndexedDB transaction open across a WebCrypto await.
 *
 * `Dexie.waitFor` is the only mechanism for that, and it cannot be called
 * unconditionally. It establishes the hold by issuing a dummy
 * `idbtrans.objectStore(storeNames[0]).get(-Infinity)`, re-armed on every
 * event-loop turn until the promise settles — and `objectStore()` on a
 * transaction that has already committed throws, synchronously, out of
 * whichever method asked for the hold:
 *
 *     InvalidStateError: Failed to execute 'objectStore' on 'IDBTransaction':
 *     The transaction has finished.
 *
 * That is reachable from ordinary reads, because this layer cannot assume the
 * call below it touched IndexedDB at all. Dexie's own cache middleware sits
 * UNDER this one (level 0 against level 2) and answers a repeated query from an
 * entry that may still be in flight from another zone. Awaiting that entry
 * resolves in a later task, no request was ever issued on this transaction to
 * keep it alive, and it has committed by the time control comes back here —
 * while Dexie's own `active` flag, cleared by the transaction's `complete`
 * EVENT, can still say otherwise. So the failure cannot be predicted; it can
 * only be caught.
 *
 * Falling back to the bare promise is not "failing open". The rows have already
 * been read out of IndexedDB and decrypting them is pure computation that needs
 * no transaction, so the read is correct either way. What the hold buys is the
 * CALLER's next operation in the same transaction — and a transaction that has
 * already finished cannot offer that whatever this layer does. The caller then
 * gets Dexie's own `TransactionInactiveError` / `PrematureCommitError`, which
 * name the real problem, instead of an `InvalidStateError` pointing at a line
 * of decryption code that did nothing wrong.
 *
 * The CURSOR path is the one exception, and it uses {@link tryHoldTransaction}
 * directly for it. See the note at its call site: iteration has to keep issuing
 * requests on the transaction, so for it the bare promise is not a degraded
 * success but a hang.
 */
type TransactionHold<T> = { ok: true; work: Promise<T> } | { ok: false; error: unknown }

function tryHoldTransaction<T>(work: Promise<T>): TransactionHold<T> {
  try {
    return { ok: true, work: Dexie.waitFor(work) }
  } catch (error) {
    return { ok: false, error }
  }
}

function holdTransaction<T>(work: Promise<T>): Promise<T> {
  const hold = tryHoldTransaction(work)
  return hold.ok ? hold.work : work
}

function encryptedTable(databaseName: string, table: DBCoreTable): DBCoreTable {
  const indexedRoots = indexedPropertyRoots(table)
  const cipher = () => {
    const active = getActiveAccountContentCipher(databaseName)
    if (!active) throw new Error(`Account content cipher is locked for ${databaseName}.`)
    return active
  }

  const decryptRow = async (row: unknown, explicitKey?: unknown): Promise<unknown> => {
    if (!isRecord(row)) return row
    const envelope = row[ENCRYPTED_CONTENT_FIELD]
    if (!isEncryptedEnvelope(envelope)) return row
    const primaryKey = explicitKey ?? table.schema.primaryKey.extractKey?.(row)
    const payload = await cipher().decrypt<Record<string, unknown>>(
      table.name,
      primaryKey,
      "payload",
      CONTENT_ENCRYPTION_SCHEMA_VERSION,
      envelope
    )
    const metadata = { ...row }
    delete metadata[ENCRYPTED_CONTENT_FIELD]
    return { ...metadata, ...payload }
  }

  const encryptRow = async (row: unknown, explicitKey?: unknown): Promise<unknown> => {
    if (!isRecord(row)) return row
    const primaryKey = explicitKey ?? table.schema.primaryKey.extractKey?.(row)
    if (primaryKey === undefined || primaryKey === null) {
      throw new Error(`Encrypted table ${table.name} requires a primary key before persistence.`)
    }
    const metadata: Record<string, unknown> = {}
    const payload: Record<string, unknown> = {}
    for (const [field, value] of Object.entries(row)) {
      if (field === ENCRYPTED_CONTENT_FIELD) continue
      if (indexedRoots.has(field) || isQueryableMetadataField(field)) metadata[field] = value
      else payload[field] = value
    }
    metadata[ENCRYPTED_CONTENT_FIELD] = await cipher().encrypt(
      table.name,
      primaryKey,
      "payload",
      CONTENT_ENCRYPTION_SCHEMA_VERSION,
      payload
    )
    return metadata as StoredEncryptedRow
  }

  return {
    ...table,
    async mutate(request: DBCoreMutateRequest) {
      cipher()
      if (request.type !== "add" && request.type !== "put") return table.mutate(request)
      const forwarded = { ...request }
      // `criteria`, `upsert` and `isAdditionalChunk` are deliberately kept: they
      // describe the write, they do not carry row data. `changeSpec` / `updates`
      // do, and only `values` passes through `encryptRow`, so a layer that
      // honoured the patch instead would write the plaintext fields it names
      // next to the ciphertext envelope. Dexie attaches one to every
      // `update()` / `modify()` / `upsert()` / `bulkUpdate()` write.
      if (forwarded.type === "put") {
        delete forwarded.changeSpec
        delete forwarded.updates
      }
      // An empty `values` array is a legitimate no-op write: a `bulkPut([])` from
      // a drain that claimed nothing, or a `modify()` whose range matched no rows
      // (Dexie still issues the latter, carrying only its criteria).
      if (request.values.length > 0) {
        forwarded.values = await holdTransaction(
          Promise.all(
            request.values.map((value, index) => encryptRow(value, request.keys?.[index]))
          )
        )
      }
      return table.mutate(forwarded)
    },
    // Every decryption below awaits WebCrypto, a native promise Dexie does not
    // own. Inside a transaction (a `modify()`/`update()` read-modify-write, or
    // any read the caller wrapped in `db.transaction()`) awaiting it directly
    // lets the IndexedDB transaction go inactive and the following write fails
    // with InvalidStateError. `holdTransaction` keeps it open — see its own
    // note for why it is not simply `Dexie.waitFor`.
    //
    // The hold is not free: it arms a 60s timer and, inside a transaction,
    // spins a keep-alive `get` against the store on every event-loop turn until
    // the promise settles. So it is applied only when a row actually carries an
    // envelope. A miss, or a row written before encryption, decrypts to itself
    // and is returned without ever suspending.
    async get(request) {
      cipher()
      const row = await table.get(request)
      if (!carriesEnvelope(row)) return row
      return holdTransaction(decryptRow(row, request.key))
    },
    async getMany(request) {
      cipher()
      const rows = await table.getMany(request)
      if (!rows.some(carriesEnvelope)) return rows
      return holdTransaction(
        Promise.all(rows.map((row, index) => decryptRow(row, request.keys[index])))
      )
    },
    async query(request) {
      cipher()
      const response = await table.query(request)
      if (request.values === false) return response
      if (!response.result.some(carriesEnvelope)) return response
      return {
        ...response,
        result: await holdTransaction(Promise.all(response.result.map((row) => decryptRow(row)))),
      }
    },
    async openCursor(request) {
      cipher()
      const cursor = await table.openCursor(request)
      return cursor ? wrapCursor(cursor, decryptRow) : null
    },
    count(request) {
      cipher()
      return table.count(request)
    },
  }
}

/**
 * Whether a stored row has content to decrypt.
 *
 * The gate in front of `Dexie.waitFor` on the read paths. Deliberately the same
 * predicate `decryptRow` uses to decide it has nothing to do, so "skipped the
 * wait" and "returned the row unchanged" can never disagree.
 */
function carriesEnvelope(row: unknown): boolean {
  return isRecord(row) && isEncryptedEnvelope(row[ENCRYPTED_CONTENT_FIELD])
}

function wrapCursor(
  cursor: DBCoreCursor,
  decryptRow: (row: unknown, explicitKey?: unknown) => Promise<unknown>
): DBCoreCursor {
  let currentValue: unknown
  const wrapper: DBCoreCursor = Object.create(cursor, {
    value: { get: () => currentValue },
    key: { get: () => cursor.key },
    primaryKey: { get: () => cursor.primaryKey },
    done: { get: () => cursor.done },
    trans: { get: () => cursor.trans },
    continue: { value: (key?: unknown) => cursor.continue(key) },
    continuePrimaryKey: {
      value: (key: unknown, primaryKey: unknown) => cursor.continuePrimaryKey(key, primaryKey),
    },
    advance: { value: (count: number) => cursor.advance(count) },
    stop: { value: (value?: unknown) => cursor.stop(value) },
    fail: { value: (error: Error) => cursor.fail(error) },
    start: {
      value: (callback: () => void) =>
        cursor.start(() => {
          // The one place the hold is not optional. `callback()` runs
          // `cursor.continue()` a microtask later, so without a keep-alive
          // request the transaction commits underneath the iteration and
          // `continue()` throws `TransactionInactiveError` from inside this
          // handler, where nothing settles the `each()` promise: the caller
          // hangs to its timeout instead of failing. Falling back to the bare
          // promise is right for the row-at-a-time reads above, whose rows are
          // already in hand, and wrong here.
          const decrypting = decryptRow(cursor.value, cursor.primaryKey)
          const hold = tryHoldTransaction(decrypting)
          if (!hold.ok) {
            // `decrypting` was already running when the hold threw, and this
            // branch is the only exit that never awaits it. Adopting its
            // rejection keeps a bad envelope or a locked cipher from surfacing
            // as an unhandled rejection with no owner. The cursor still fails
            // by the name of the real problem, which is the finished
            // transaction rather than whatever the row turned out to contain.
            void decrypting.catch(() => undefined)
            cursor.fail(hold.error instanceof Error ? hold.error : new Error(String(hold.error)))
            return
          }
          void hold.work.then(
            (value) => {
              currentValue = value
              callback()
            },
            (error: unknown) =>
              cursor.fail(error instanceof Error ? error : new Error(String(error)))
          )
        }),
    },
    next: {
      value: () => {
        let seen = 1
        return wrapper
          .start(() => (seen-- ? wrapper.continue() : wrapper.stop()))
          .then(() => wrapper)
      },
    },
  }) as DBCoreCursor
  return wrapper
}

function indexedPropertyRoots(table: DBCoreTable): Set<string> {
  const roots = new Set<string>()
  for (const index of [table.schema.primaryKey, ...table.schema.indexes]) {
    const paths = typeof index.keyPath === "string" ? [index.keyPath] : index.keyPath
    if (!paths) continue
    for (const path of paths) roots.add(path.split(".", 1)[0]!)
  }
  return roots
}

function isQueryableMetadataField(field: string): boolean {
  return (
    field === "id" ||
    field === "scope" ||
    field === "status" ||
    field.endsWith("Id") ||
    field.endsWith("At") ||
    field.endsWith("Count") ||
    field === "version"
  )
}

function isEncryptedEnvelope(value: unknown): value is EncryptedContentEnvelope {
  if (!isRecord(value)) return false
  return (
    value.version === 1 &&
    value.algorithm === "AES-256-GCM" &&
    typeof value.accountId === "string" &&
    typeof value.iv === "string" &&
    typeof value.ciphertext === "string"
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

import Dexie, {
  type DBCore,
  type DBCoreTransaction,
  type DBCoreTable,
  type Middleware,
  type Transaction,
} from "dexie"
import type { ChatSession } from "@cognia/agent-config-types"
import { ENCRYPTED_CONTENT_FIELD } from "./encrypted-content-middleware"
import { sameValue } from "@/lib/account-sync/data/stable-json"

/** Only data used to render, filter, order or route a conversation list. */
export const SESSION_LIST_FIELDS = [
  "id",
  "title",
  "createdAt",
  "updatedAt",
  "projectId",
  "kind",
  "visibility",
  "characterId",
  "teamId",
  "pinned",
  "manualOrder",
  "manualOrderSection",
  "folderId",
  "archivedAt",
  "lastMessagePreview",
  "lastMessageAt",
  "parentSessionId",
  "platformBinding",
  "handoffLock",
  "model",
  "providerOverride",
  "externalAgentModels",
  "externalAgentSession",
  "collaboration",
  "codexHandoff",
  "workingDir",
] as const satisfies readonly (keyof ChatSession)[]

export type SessionListRow = Pick<ChatSession, (typeof SESSION_LIST_FIELDS)[number]> & {
  /** Missing and empty project ids have the same existing list visibility. */
  workspaceKey: string
}

export const SESSION_LIST_READY_ID = "session-list-v241"
export const SESSION_LIST_WITNESS_PREFIX = "session-list-source:"
interface SessionListWitness {
  id: string
  sessionListId: string
  sessionListIv: string
}
function witness(id: string, iv: string): SessionListWitness {
  return { id: SESSION_LIST_WITNESS_PREFIX + id, sessionListId: id, sessionListIv: iv }
}
const fields = new Set<string>(SESSION_LIST_FIELDS)

export function projectSessionListRow(session: ChatSession): SessionListRow {
  const row: Record<string, unknown> = { workspaceKey: session.projectId || "" }
  for (const key of SESSION_LIST_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(session, key)) row[key] = session[key]
  }
  return row as SessionListRow
}

interface DexieZones {
  readonly PSD: unknown
  usePSD<T>(psd: unknown, fn: () => T): T
  newPSD<T>(fn: () => T, properties: Record<string, unknown>): T
}
const zones = Dexie.Promise as unknown as DexieZones
const rawSessionTables = new WeakMap<DBCoreTransaction, DBCoreTable>()
const backfillWitnessPages = new WeakMap<DBCoreTransaction, { witnesses?: SessionListWitness[] }>()

/** Record ciphertext identity below encryption; older writers cannot forge freshness. */
export function createSessionListWitnessMiddleware(): Middleware<DBCore> {
  return {
    stack: "dbcore",
    name: "SessionListCiphertextWitness",
    level: 1.5,
    create(down) {
      if (!down.schema.tables.some((table) => table.name === "storageLayout")) return down
      return {
        ...down,
        transaction(stores, mode, options) {
          const transaction = down.transaction(
            mode === "readwrite" && stores.includes("sessions") && !stores.includes("storageLayout")
              ? [...stores, "storageLayout"]
              : stores,
            mode,
            options
          )
          if (stores.includes("sessions")) rawSessionTables.set(transaction, down.table("sessions"))
          return transaction
        },
        table(name) {
          const table = down.table(name)
          if (name !== "sessions") return table
          const markers = down.table("storageLayout")
          return {
            ...table,
            query(request) {
              // Upgrade transactions bypass the normal transaction factory.
              rawSessionTables.set(request.trans, table)
              const page = backfillWitnessPages.get(request.trans)
              if (!page || !request.values) return table.query(request)
              return table.query(request).then((result) => {
                // Backfill bounds this query to 500 rows. Retain only IV
                // metadata while the same source rows pass through decryption.
                page.witnesses = result.result.flatMap((raw) => {
                  const row = raw as Record<string, unknown>
                  const iv = (row[ENCRYPTED_CONTENT_FIELD] as { iv?: string } | undefined)?.iv
                  return typeof iv === "string" ? [witness(row.id as string, iv)] : []
                })
                return result
              })
            },
            mutate(request) {
              const psd = zones.PSD
              const zone = <T>(fn: () => T): T => zones.usePSD(psd, fn)
              const keys =
                request.type === "deleteRange"
                  ? table
                      .query({
                        trans: request.trans,
                        values: false,
                        query: { index: table.schema.primaryKey, range: request.range },
                      })
                      .then((result) => result.result as string[])
                  : Dexie.Promise.resolve(
                      request.type === "delete" ? (request.keys as string[]) : []
                    )
              return Dexie.Promise.resolve(keys).then(async (deletedKeys) => {
                const trusted = new Set<string>()
                if (request.type === "add" || request.type === "put") {
                  const ids = request.values.map((value) => (value as { id: string }).id)
                  const previous = await zone(() =>
                    table.getMany({ trans: request.trans, keys: ids })
                  )
                  const witnesses = await zone(() =>
                    markers.getMany({
                      trans: request.trans,
                      keys: ids.map((id) => SESSION_LIST_WITNESS_PREFIX + id),
                    })
                  )
                  ids.forEach((id, index) => {
                    const old = previous[index] as Record<string, unknown> | undefined
                    const iv = (old?.[ENCRYPTED_CONTENT_FIELD] as { iv?: string } | undefined)?.iv
                    if (
                      !old ||
                      (typeof iv === "string" &&
                        iv === (witnesses[index] as SessionListWitness | undefined)?.sessionListIv)
                    )
                      trusted.add(id)
                  })
                }
                return Dexie.Promise.resolve(zone(() => table.mutate(request))).then(
                  async (result) => {
                    try {
                      if (request.type === "add" || request.type === "put") {
                        const rows = new Map<string, SessionListWitness>()
                        const missing = new Set<string>()
                        request.values.forEach((value, index) => {
                          if (result.failures[index]) return
                          const row = value as Record<string, unknown>
                          const id = row.id as string
                          const iv = (row[ENCRYPTED_CONTENT_FIELD] as { iv?: string } | undefined)
                            ?.iv
                          if (typeof iv === "string" && trusted.has(id)) {
                            rows.set(id, witness(id, iv))
                            missing.delete(id)
                          } else {
                            rows.delete(id)
                            missing.add(id)
                          }
                        })
                        if (rows.size) {
                          const written = await zone(() =>
                            markers.mutate({
                              type: "put",
                              trans: request.trans,
                              values: [...rows.values()],
                            })
                          )
                          if (written.numFailures) throw Object.values(written.failures)[0]
                        }
                        if (missing.size) {
                          const removed = await zone(() =>
                            markers.mutate({
                              type: "delete",
                              trans: request.trans,
                              keys: [...missing].map((id) => SESSION_LIST_WITNESS_PREFIX + id),
                            })
                          )
                          if (removed.numFailures) throw Object.values(removed.failures)[0]
                        }
                      } else {
                        const removed = await zone(() =>
                          markers.mutate({
                            type: "delete",
                            trans: request.trans,
                            keys: deletedKeys
                              .filter((_, index) => !result.failures[index])
                              .map((id) => SESSION_LIST_WITNESS_PREFIX + id),
                          })
                        )
                        if (removed.numFailures) throw Object.values(removed.failures)[0]
                      }
                      return result
                    } catch (error) {
                      request.trans.abort()
                      throw error
                    }
                  }
                )
              })
            },
          }
        },
      }
    },
  }
}

/** Maintain the encrypted projection for every writer, including sync/import. */
export function createSessionListMiddleware(): Middleware<DBCore> {
  return {
    stack: "dbcore",
    name: "SessionListProjection",
    level: 4,
    create(down) {
      if (!down.schema.tables.some((table) => table.name === "sessionList")) return down
      // Only side-table work is queued, AFTER the source mutation completes.
      // Queuing source mutations would deadlock against Dexie's write locks.
      const pending = new WeakMap<DBCoreTransaction, Promise<unknown>>()
      return {
        ...down,
        transaction(stores, mode, options) {
          return down.transaction(
            mode === "readwrite" && stores.includes("sessions") && !stores.includes("sessionList")
              ? [...stores, "sessionList"]
              : stores,
            mode,
            options
          )
        },
        table(name) {
          const table = down.table(name)
          if (name !== "sessions") return table
          const projection = down.table("sessionList")
          return {
            ...table,
            mutate(request) {
              const psd = zones.PSD
              const zone = <T>(fn: () => T): T => zones.usePSD(psd, fn)
              // Source-only patches cannot change a row already represented
              // by the projection. Before initialization, backfill owns it.
              const specs =
                request.type === "put"
                  ? (request.updates?.changeSpecs ??
                    (request.changeSpec ? [request.changeSpec] : undefined))
                  : undefined
              if (
                request.type === "put" &&
                specs &&
                !request.upsert &&
                specs.every((spec) =>
                  Object.keys(spec).every((key) => !fields.has(key.split(".")[0]))
                )
              )
                return table.mutate(request)
              // The encryption/capture layers return native promises. Adopt
              // their result into Dexie's zone before scheduling side work.
              return Dexie.Promise.resolve(table.mutate(request)).then((result) => {
                const previous = pending.get(request.trans) ?? Dexie.Promise.resolve()
                const work = previous
                  .then(async () => {
                    if (request.type === "delete" || request.type === "deleteRange") {
                      const deletion =
                        request.type === "delete"
                          ? {
                              ...request,
                              keys: request.keys.filter((_, index) => !result.failures[index]),
                            }
                          : request
                      const removed = await zone(() => projection.mutate(deletion))
                      if (removed.numFailures) throw Object.values(removed.failures)[0]
                      return
                    }
                    const byId = new Map<string, SessionListRow>()
                    request.values.forEach((value, index) => {
                      if (result.failures[index]) return
                      const row = projectSessionListRow(value as ChatSession)
                      byId.set(row.id, row)
                    })
                    const rows = [...byId.values()]
                    if (rows.length === 0) return
                    const saved = await zone(() =>
                      projection.getMany({ trans: request.trans, keys: rows.map((row) => row.id) })
                    )
                    const changed = rows.filter((row, index) => !sameValue(saved[index], row))
                    if (changed.length === 0) return
                    const written = await zone(() =>
                      projection.mutate({ type: "put", trans: request.trans, values: changed })
                    )
                    if (written.numFailures) throw Object.values(written.failures)[0]
                  })
                  .catch((error: unknown) => {
                    request.trans.abort()
                    throw error
                  })
                pending.set(request.trans, work)
                return work.then(() => result)
              })
            },
          }
        },
      }
    },
  }
}

/** Atomic and restartable, including when plugin schema adoption skips an upgrade. */
export async function backfillSessionList(tx: Transaction): Promise<void> {
  const sessions = tx.table<ChatSession, string>("sessions")
  if ((await tx.table("storageLayout").get(SESSION_LIST_READY_ID))?.version === 2) return
  const markers = tx.table("storageLayout")
  await markers.where("id").startsWith(SESSION_LIST_WITNESS_PREFIX).delete()
  const projection = tx.table<SessionListRow, string>("sessionList")
  await projection.clear()
  let after: string | undefined
  let observedRawPage = false
  for (;;) {
    const collected: { witnesses?: SessionListWitness[] } = {}
    backfillWitnessPages.set(tx.idbtrans, collected)
    let page: ChatSession[]
    try {
      page = await (
        after === undefined ? sessions.toCollection() : sessions.where("id").above(after)
      )
        .limit(500)
        .toArray()
    } finally {
      backfillWitnessPages.delete(tx.idbtrans)
    }
    observedRawPage ||= collected.witnesses !== undefined
    if (page.length === 0) break
    await Dexie.Promise.all([
      projection.bulkPut(page.map(projectSessionListRow)),
      collected.witnesses?.length ? markers.bulkPut(collected.witnesses) : undefined,
    ])
    after = page[page.length - 1].id
  }
  // Without the raw middleware a custom caller may build the projection, but
  // cannot establish freshness. The verified reader will use source rows.
  const version = observedRawPage ? 2 : 1
  await markers.put({ id: SESSION_LIST_READY_ID, version })
}

export async function ensureSessionListReady(db: Dexie): Promise<void> {
  if ((await db.table("storageLayout").get(SESSION_LIST_READY_ID))?.version === 2) return
  await db.transaction("rw", ["sessions", "sessionList", "storageLayout"], backfillSessionList)
}

/**
 * Source index keys establish membership, order and ciphertext identity; witnesses let
 * unchanged rows use the small projection even beside an older running build.
 * Dirty rows are overlaid inside the same readonly snapshot, without repair
 * writes from a liveQuery. Plaintext legacy rows have no IV and use the source.
 */
export async function readVerifiedSessionListRows(
  db: Dexie,
  projectId?: string
): Promise<SessionListRow[] | undefined> {
  if (!db.tables.some((table) => table.name === "sessionList")) return undefined
  // Initialization is boot work, not part of liveQuery's readonly observer.
  // Adopt its promise back into the caller's zone so subsequent reads remain
  // observable. Keep the captured database across initialization.
  await Dexie.Promise.resolve(
    zones.newPSD(() => ensureSessionListReady(db), { subscr: null, trans: null, querier: null })
  )
  return db.transaction("r", ["sessions", "sessionList", "storageLayout"], async () => {
    const sessions = db.table<ChatSession, string>("sessions")
    const transaction = Dexie.currentTransaction!.idbtrans
    const rawTable = rawSessionTables.get(transaction)
    if (!rawTable) return undefined
    let rawRows: Record<string, unknown>[]
    let prefetched: { witnesses: SessionListWitness[]; projection: SessionListRow[] } | undefined
    const ivIndex = rawTable.schema.getIndexByKeyPath(`${ENCRYPTED_CONTENT_FIELD}.iv`)
    if (projectId === undefined && ivIndex) {
      // This primary-key observation is required even though its count is not
      // used: old writers do not know the new IV index, but still publish
      // primary-row mutations, including edits with unchanged timestamps.
      // IndexedDB itself maintains the IV index for those writers.
      const readIvs = async () => {
        const ivs = new Map<string, string>()
        const cursor = await rawTable.openCursor({
          trans: transaction,
          values: false,
          reverse: false,
          unique: false,
          query: { index: ivIndex, range: { type: 3, lower: undefined, upper: undefined } },
        })
        if (cursor)
          await cursor.start(() => {
            ivs.set(cursor.primaryKey as string, cursor.key as string)
            cursor.continue()
          })
        return ivs
      }
      // Only one encrypted read is outstanding. The other reads operate on
      // keys or metadata in this same readonly snapshot.
      const [, orderedIds, ivs, witnesses, projection] = await Dexie.Promise.all([
        sessions.count(),
        sessions.orderBy("updatedAt").reverse().primaryKeys(),
        readIvs(),
        db
          .table<SessionListWitness, string>("storageLayout")
          .where("id")
          .startsWith(SESSION_LIST_WITNESS_PREFIX)
          .toArray(),
        db.table<SessionListRow, string>("sessionList").toArray(),
      ])
      prefetched = { witnesses, projection }
      rawRows = orderedIds.map((id) => ({ id, [ENCRYPTED_CONTENT_FIELD]: { iv: ivs.get(id) } }))
    } else {
      // A value query below encryption uses native getAll and still observes
      // primary-row changes, including same-time edits from older builds.
      const index = rawTable.schema.getIndexByKeyPath(
        projectId === undefined ? "updatedAt" : ["projectId", "updatedAt"]
      )!
      const result = await rawTable.query({
        trans: transaction,
        values: true,
        query: {
          index,
          range:
            projectId === undefined
              ? { type: 3, lower: undefined, upper: undefined }
              : { type: 2, lower: [projectId, Dexie.minKey], upper: [projectId, Dexie.maxKey] },
        },
      })
      rawRows = result.result.slice().reverse() as Record<string, unknown>[]
      if (projectId !== undefined) {
        const all = await sessions.toCollection().primaryKeys()
        const withProject = new Set(await sessions.where("projectId").above("").primaryKeys())
        rawRows.push(
          ...(await rawTable.getMany({
            trans: transaction,
            keys: all.filter((id) => !withProject.has(id)),
          }))
        )
      }
    }
    const ids = rawRows.map((row) => row.id as string)
    const markers = db.table<SessionListWitness, string>("storageLayout")
    // A workspace reads only its witnesses; the global list uses one native
    // getAll rather than issuing a request for every row.
    const witnessRows = prefetched
      ? prefetched.witnesses
      : projectId === undefined
        ? await markers.where("id").startsWith(SESSION_LIST_WITNESS_PREFIX).toArray()
        : await markers.bulkGet(ids.map((id) => SESSION_LIST_WITNESS_PREFIX + id))
    const witnesses = new Map(
      witnessRows.flatMap((row) => (row ? [[row.sessionListId, row.sessionListIv] as const] : []))
    )
    const dirtySource = new Set(
      rawRows
        .filter((row) => {
          const iv = (row[ENCRYPTED_CONTENT_FIELD] as { iv?: string } | undefined)?.iv
          return typeof iv !== "string" || iv !== witnesses.get(row.id as string)
        })
        .map((row) => row.id as string)
    )
    const projection = db.table<SessionListRow, string>("sessionList")
    // Keep a single encrypted read: concurrent projection queries can stall
    // the shared native transaction keep-alive hold.
    const projectedRows = prefetched
      ? prefetched.projection
      : projectId === undefined
        ? await projection.toArray()
        : await projection.bulkGet(ids)
    const projectedById = new Map(
      projectedRows.flatMap((row) => (row ? [[row.id, row] as const] : []))
    )
    const projected = ids.map((id) => projectedById.get(id))
    const dirtyIds = ids.filter((id, index) => !projected[index] || dirtySource.has(id))
    const dirtyRows = await sessions.bulkGet(dirtyIds)
    const dirty = new Map(dirtyIds.map((id, index) => [id, dirtyRows[index]]))
    const rows = ids.map((id, index) =>
      dirty.has(id) ? projectSessionListRow(dirty.get(id)!) : projected[index]!
    )
    return projectId === undefined ? rows : rows.sort((a, b) => b.updatedAt - a.updatedAt)
  })
}

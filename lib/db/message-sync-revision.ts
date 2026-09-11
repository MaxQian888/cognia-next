import Dexie, {
  type DBCore,
  type DBCoreTransaction,
  type Middleware,
  type Transaction,
} from "dexie"

export interface MessageSyncClock {
  id: "singleton"
  revision: number
}

/**
 * Stamp every message write, including imports and streaming updates. The
 * durable clock shares the message transaction, so rollbacks, concurrent tabs,
 * equal wall-clock timestamps and deleting the newest row cannot lose changes.
 * Runs below content encryption: syncRevision is indexed, non-content metadata.
 */
export function createMessageSyncRevisionMiddleware(): Middleware<DBCore> {
  return {
    stack: "dbcore",
    name: "MessageSyncRevision",
    level: 1,
    create(down) {
      // Dexie also builds a stack for the old schema while opening an upgrade.
      if (!down.schema.tables.some((table) => table.name === "messageSyncClock")) return down
      const writes = new WeakMap<DBCoreTransaction, Promise<unknown>>()
      return {
        ...down,
        transaction(stores, mode, options) {
          return down.transaction(
            mode === "readwrite" &&
              stores.includes("messages") &&
              !stores.includes("messageSyncClock")
              ? [...stores, "messageSyncClock"]
              : stores,
            mode,
            options
          )
        },
        table(name) {
          const table = down.table(name)
          if (name === "workflowRuns")
            return {
              ...table,
              mutate(request) {
                if (request.type !== "put" && request.type !== "add") return table.mutate(request)
                const forwarded = {
                  ...request,
                  values: request.values.map((row) => ({
                    ...row,
                    syncActivityAt: Math.max(row.startedAt ?? 0, row.completedAt ?? 0),
                  })),
                }
                if (forwarded.type === "put") {
                  delete forwarded.changeSpec
                  delete forwarded.updates
                }
                return table.mutate(forwarded)
              },
            }
          if (name !== "messages") return table
          const clock = down.table("messageSyncClock")
          return {
            ...table,
            mutate(request) {
              if ((request.type !== "put" && request.type !== "add") || request.values.length === 0)
                return table.mutate(request)
              // Two bulk writes may be started concurrently inside ONE IDB
              // transaction. Serialize only this transaction's clock claims.
              const previous = writes.get(request.trans) ?? Dexie.Promise.resolve()
              const work = previous.then(async () => {
                const saved = (await clock.get({ trans: request.trans, key: "singleton" })) as
                  MessageSyncClock | undefined
                let revision = saved?.revision ?? 0
                const values = request.values.map((row) => ({ ...row, syncRevision: ++revision }))
                const forwarded = { ...request, values }
                if (forwarded.type === "put") {
                  delete forwarded.changeSpec
                  delete forwarded.updates
                }
                const result = await table.mutate(forwarded)
                const persisted = await clock.mutate({
                  type: "put",
                  trans: request.trans,
                  values: [{ id: "singleton", revision }],
                })
                if (persisted.numFailures > 0) {
                  request.trans.abort()
                  throw persisted.failures[0]
                }
                return result
              })
              writes.set(request.trans, work)
              return work
            },
          }
        },
      }
    },
  }
}

/** v226: add only metadata to raw rows; encrypted content stays byte-identical. */
export function backfillMessageSyncRevision(transaction: Transaction): Promise<void> {
  return new Dexie.Promise<void>((resolve, reject) => {
    let revision = 0
    const tables = ["messages", "workflowRuns"].filter((name) =>
      transaction.idbtrans.objectStoreNames.contains(name)
    )
    const visit = (index: number) => {
      if (index === tables.length) {
        const clock = transaction.idbtrans
          .objectStore("messageSyncClock")
          .put({ id: "singleton", revision })
        clock.onerror = () => reject(clock.error)
        clock.onsuccess = () => resolve()
        return
      }
      const name = tables[index]
      const request = transaction.idbtrans.objectStore(name).openCursor()
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor) {
          visit(index + 1)
          return
        }
        const row = cursor.value
        // Old mirrors can contain foreign or duplicate revisions. Allocate
        // every row from the durable LOCAL clock; replay only moves forward.
        const metadata =
          name === "messages"
            ? { syncRevision: ++revision }
            : { syncActivityAt: Math.max(row.startedAt ?? 0, row.completedAt ?? 0) }
        const update = cursor.update({ ...row, ...metadata })
        update.onerror = () => reject(update.error)
        update.onsuccess = () => cursor.continue()
      }
    }
    const clock = transaction.idbtrans.objectStore("messageSyncClock").get("singleton")
    clock.onerror = () => reject(clock.error)
    clock.onsuccess = () => {
      revision = clock.result?.revision ?? 0
      visit(0)
    }
  })
}

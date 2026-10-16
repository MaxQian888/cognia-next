/**
 * Write-triggered flush for the snapshot-backed CLI database: a Dexie dbcore
 * middleware that reports every settled table mutation, so the store can
 * schedule a debounced flush of exactly that table. Shared by `cognia serve`
 * (`serve/durability.ts`) and the TUI's default database (`./bootstrap.ts`).
 */

/** The Dexie surface the middleware needs (kept loose for tests). */
export interface DexieLike {
  use(middleware: { stack: "dbcore"; name: string; create(down: DbCoreLike): DbCoreLike }): unknown
}

interface DbCoreLike {
  table(name: string): DbCoreTableLike
  [key: string]: unknown
}

interface DbCoreTableLike {
  mutate(req: unknown): Promise<unknown>
  [key: string]: unknown
}

/**
 * Install the write-triggered flush middleware. Every table mutation
 * (add/put/delete/deleteRange) schedules `onWrite` after it settles.
 *
 * `ignoreTables` names tables whose mutations must NOT schedule a flush —
 * pass the same set the snapshot excludes, or an append-heavy excluded table
 * would drive full re-dumps that contain none of its rows.
 */
export function installWriteFlush(
  db: DexieLike,
  onWrite: (tableName: string) => void,
  opts: { ignoreTables?: readonly string[] } = {}
): void {
  const ignored = new Set(opts.ignoreTables ?? [])
  db.use({
    stack: "dbcore",
    name: "headless-write-flush",
    create(down) {
      return {
        ...down,
        table(name: string) {
          const table = down.table(name)
          if (ignored.has(name)) return table
          return {
            ...table,
            mutate(req: unknown) {
              const result = table.mutate(req)
              void Promise.resolve(result)
                .then(() => onWrite(name))
                .catch(() => {
                  // A failed mutation persisted nothing; skip the flush.
                })
              return result
            },
          }
        },
      }
    },
  })
}

/**
 * Test-only: an in-memory stand-in for `ctx.dexie` covering the table calls
 * `createPipelineDb` makes. Rows are keyed by `id`, like the manifest schemas.
 */
import type { PluginDexieAPI } from "@cognia/plugin-sdk"

/** A stored row. Seeds are typed rows (`TopicRow`, …); reads come back loosely typed. */
type Row = Record<string, unknown> & { id: string }

const asRow = (value: object) => value as Row

export interface FakeDexie {
  dexie: PluginDexieAPI
  rows: (table: string) => Map<string, Row>
  /** Make every call on `table` reject with `error`. */
  failTable: (table: string, error: Error) => void
}

export function createFakeDexie<Seed extends Record<string, ReadonlyArray<{ id: string }>>>(
  seed: Seed = {} as Seed
): FakeDexie {
  const store = new Map<string, Map<string, Row>>()
  const failures = new Map<string, Error>()
  const rows = (table: string) => {
    let bucket = store.get(table)
    if (!bucket) {
      bucket = new Map((seed[table] ?? []).map((row) => [row.id, asRow(row)]))
      store.set(table, bucket)
    }
    return bucket
  }
  const guard = async <T>(table: string, run: () => T): Promise<T> => {
    const failure = failures.get(table)
    if (failure) throw failure
    return run()
  }
  const table = (name: string) => ({
    toArray: () => guard(name, () => [...rows(name).values()]),
    get: (id: string) => guard(name, () => rows(name).get(id)),
    put: (row: { id: string }) => guard(name, () => void rows(name).set(row.id, asRow(row))),
    bulkPut: (list: Array<{ id: string }>) =>
      guard(name, () => list.forEach((row) => rows(name).set(row.id, asRow(row)))),
    update: (id: string, patch: Record<string, unknown>) =>
      guard(name, () => {
        const current = rows(name).get(id)
        if (!current) return 0
        rows(name).set(id, { ...current, ...patch, id })
        return 1
      }),
    delete: (id: string) => guard(name, () => void rows(name).delete(id)),
  })
  return {
    // The DAO only calls the members above; the rest of Dexie's Table surface
    // is out of scope for a unit fake.
    dexie: { table, rawDb: () => undefined } as unknown as PluginDexieAPI,
    rows,
    failTable: (name, error) => void failures.set(name, error),
  }
}

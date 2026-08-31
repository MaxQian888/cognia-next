/** @jest-environment jsdom */
// Regression baseline for the single-version schema in `schema.ts`.
//
// `CURRENT_SCHEMA` replaced a 200-block append-only version chain. That chain
// was its own tripwire: a bad delta showed up as a diff against history. With
// one cumulative declaration there is no history to diff against, so the
// invariants that used to be structural are pinned here instead:
//
//   - the store set Dexie actually creates matches the governance catalog,
//   - `null` ("drop this table") entries survive as keys but not as tables,
//   - exactly one Dexie version is declared, which is the whole point. Dexie
//     re-parses every version declared so far on each `stores()` call, and the
//     old chain cost ~4.7s of pure index parsing per fresh connection,
//   - `CURRENT_SCHEMA_VERSION` is what the opened database reports.

import "fake-indexeddb/auto"
import { CORE_TABLE_NAMES } from "@/lib/data-governance/table-catalog"
import {
  CogniaDB,
  CURRENT_SCHEMA,
  CURRENT_SCHEMA_VERSION,
  __resetDbForTesting,
  getDb,
} from "./schema"

afterEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
})

function tableNames(db: CogniaDB): string[] {
  return db.tables.map((table) => table.name).sort()
}

it("declares exactly one Dexie version", () => {
  const db = new CogniaDB("schema-shape-single-version")
  // The performance property. If this ever reports more than one, something
  // reintroduced a version chain and every fresh connection pays to parse it.
  expect((db as unknown as { _versions: unknown[] })._versions).toHaveLength(1)
  expect(db.verno).toBe(CURRENT_SCHEMA_VERSION)
  db.close()
})

it("creates exactly the stores the governance catalog knows about", () => {
  const db = new CogniaDB("schema-shape-catalog-parity")
  // `lib/data-governance/table-catalog.ts` assigns every table a backup,
  // sync, retention and account-scope policy. A store missing from it is an
  // ungoverned table. A catalog entry with no store is a stale policy. The
  // static gate (`pnpm audit:data-governance`) compares the two by text.
  // This compares what Dexie actually opened.
  expect(tableNames(db)).toEqual([...CORE_TABLE_NAMES].sort())
  db.close()
})

it("keeps dropped tables as null keys and out of the database", () => {
  // v113 dropped `pluginScheduledJobs` and a later version dropped
  // `syncCursors`, both with `{ table: null }`. Deleting the key instead
  // would read as "never declared", which is right for a fresh database and
  // silently wrong for one that still carries the store.
  const dropped = Object.entries(CURRENT_SCHEMA)
    .filter(([, spec]) => spec === null)
    .map(([name]) => name)
  expect(dropped).toEqual(["pluginScheduledJobs", "syncCursors"])

  const db = new CogniaDB("schema-shape-dropped")
  for (const name of dropped) expect(tableNames(db)).not.toContain(name)
  db.close()
})

it("gives every live store a non-empty spec and a primary key", () => {
  const db = new CogniaDB("schema-shape-primkeys")
  const live = Object.entries(CURRENT_SCHEMA).filter(([, spec]) => spec !== null)
  expect(live.length).toBe(CORE_TABLE_NAMES.length)
  for (const [name, spec] of live) {
    expect(spec!.trim()).not.toBe("")
    // `++`, `&` or plain, any of them resolves to a src. An empty one means
    // the spec's leading segment was lost in a merge.
    expect(db.table(name).schema.primKey.src).not.toBe("")
  }
  db.close()
})

it("preserves the compound indexes hot paths depend on", () => {
  // Spot-check the compound indexes whose absence degrades a query to a full
  // scan rather than failing loudly, so a bad merge would not surface as an
  // error anywhere else.
  const db = new CogniaDB("schema-shape-compound")
  const indexesOf = (name: string) => db.table(name).schema.indexes.map((index) => index.name)

  expect(indexesOf("messages")).toEqual(expect.arrayContaining(["[sessionId+createdAt]"]))
  expect(indexesOf("sessions")).toEqual(expect.arrayContaining(["[projectId+updatedAt]"]))
  expect(indexesOf("mobileOutboundQueue")).toEqual(
    expect.arrayContaining(["[status+nextAttemptAt]"])
  )
  db.close()
})

it("opens a fresh database and accepts writes", async () => {
  const db = getDb()
  await db.sessions.put({
    id: "schema-shape-smoke",
    title: "t",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as never)
  expect((await db.sessions.get("schema-shape-smoke"))?.id).toBe("schema-shape-smoke")
})

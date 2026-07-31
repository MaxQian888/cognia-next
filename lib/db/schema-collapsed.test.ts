/** @jest-environment jsdom */
// Parity check for the Jest collapsed-schema fast path in schema.ts: a
// CogniaDB declared from the merged (collapsed) spec must expose exactly the
// same tables, primary keys, and indexes as one built from the full 100+
// version chain. If a new version(N).stores() delta ever merges incorrectly
// (or dexie's internal `_versions`/`storesSource` shape changes), this suite
// is the tripwire.

import "fake-indexeddb/auto"
import { CogniaDB, __resetDbForTesting, getDb } from "./schema"

type SchemaShape = Record<string, { primKey: string; indexes: string[] }>

function shapeOf(db: CogniaDB): SchemaShape {
  const shape: SchemaShape = {}
  for (const table of db.tables) {
    shape[table.name] = {
      primKey: table.schema.primKey.src,
      indexes: table.schema.indexes.map((i) => i.src).sort(),
    }
  }
  return shape
}

const flagHolder = globalThis as { __COGNIA_DB_FULL_SCHEMA__?: boolean }
const cacheHolder = process as unknown as { __cogniaCollapsedSchema?: unknown }

afterEach(async () => {
  delete flagHolder.__COGNIA_DB_FULL_SCHEMA__
  await getDb().delete()
  __resetDbForTesting()
})

it("collapsed schema matches the full version chain exactly", () => {
  // Full chain: force the opt-out flag so the constructor declares every
  // historical version. This also (re)populates the process-level cache no
  // matter which suite ran first in this worker — capture happens only when
  // collapse mode is on, so build the reference first, then the collapsed one.
  flagHolder.__COGNIA_DB_FULL_SCHEMA__ = true
  const full = new CogniaDB("schema-collapse-parity-full")
  const fullShape = shapeOf(full)
  const fullVerno = full.verno

  // Collapsed: flag off. If this is the first construction in the worker the
  // constructor runs the full chain once and caches; construct twice so the
  // second instance is guaranteed to take the collapsed fast path.
  delete flagHolder.__COGNIA_DB_FULL_SCHEMA__
  const warmup = new CogniaDB("schema-collapse-parity-warmup")
  expect(cacheHolder.__cogniaCollapsedSchema).toBeDefined()
  const collapsed = new CogniaDB("schema-collapse-parity-collapsed")

  expect(collapsed.verno).toBe(fullVerno)
  expect(shapeOf(collapsed)).toEqual(fullShape)

  full.close()
  warmup.close()
  collapsed.close()
})

it("opt-out flag forces the full chain even when the cache is warm", () => {
  // Warm the cache.
  const warmup = new CogniaDB("schema-collapse-optout-warmup")
  expect(cacheHolder.__cogniaCollapsedSchema).toBeDefined()

  flagHolder.__COGNIA_DB_FULL_SCHEMA__ = true
  const full = new CogniaDB("schema-collapse-optout-full")
  // The full chain declares many versions; the collapsed path declares one.
  // Dexie's internal version list is the observable difference.
  const versionCount = (full as unknown as { _versions: unknown[] })._versions.length
  expect(versionCount).toBeGreaterThan(100)

  const collapsedCount = (warmup as unknown as { _versions: unknown[] })._versions.length
  expect(collapsedCount).toBeLessThanOrEqual(2)

  warmup.close()
  full.close()
})

it("a fresh collapsed database opens and accepts writes", async () => {
  const db = getDb()
  await db.sessions.put({
    id: "collapse-smoke",
    title: "t",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as never)
  const row = await db.sessions.get("collapse-smoke")
  expect(row?.id).toBe("collapse-smoke")
})

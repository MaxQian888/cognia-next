/** @jest-environment jsdom */
/**
 * dexie-bridge tests
 *
 * Tests for applyPluginTables and removePluginTables, including:
 *  - Single-plugin table registration
 *  - Multi-plugin namespace isolation (two plugins, same logical name)
 *  - Idempotent re-apply when tables haven't changed
 *  - removePluginTables with retain vs purge modes
 *  - MAX_TABLES_PER_PLUGIN enforcement
 */

import "fake-indexeddb/auto"
import Dexie from "dexie"
import { applyPluginTables, removePluginTables, restorePluginTables } from "./bridge"
import { getPluginDexieMeta } from "./meta"

// We bypass CogniaDB entirely and spin up a lightweight test Dexie instance
// that includes the pluginDexieMeta table but nothing else.
function makeTestDb(): Dexie {
  const db = new Dexie(`test-bridge-${Math.random().toString(36).slice(2)}`)
  db.version(1).stores({ pluginDexieMeta: "&pluginId, appliedAt" })
  return db
}

// Seed a pluginDexieMeta row directly, simulating a row persisted by a prior
// session whose namespaced store is NOT present in the current live schema
// (the fresh-process / drift scenario the restore + defense paths exist for).
async function seedMeta(
  db: Dexie,
  row: { pluginId: string; tableNames: string[]; dexieVersion: number; appliedAt: number }
): Promise<void> {
  await (db as Dexie & { pluginDexieMeta: Dexie.Table }).pluginDexieMeta.put(row)
}

// Override getDb() inside dexie-bridge so it uses our test instance.
// We achieve this by monkey-patching the dexie-meta module which is the
// only place getDb() is called from the bridge.
jest.mock("./meta", () => {
  const actual = jest.requireActual("./meta")
  // We need a shared reference so we can swap it per test.
  let _db: Dexie | null = null
  return {
    ...actual,
    __setTestDb: (db: Dexie) => {
      _db = db
    },
    getPluginDexieMeta: async (pluginId: string) => {
      if (!_db) return undefined
      return (_db as Dexie & { pluginDexieMeta: Dexie.Table }).pluginDexieMeta.get(pluginId)
    },
    getAllPluginDexiaMeta: async () => {
      if (!_db) return []
      return (_db as Dexie & { pluginDexieMeta: Dexie.Table }).pluginDexieMeta.toArray()
    },
    putPluginDexiaMeta: async (row: unknown) => {
      if (!_db) return
      await (_db as Dexie & { pluginDexieMeta: Dexie.Table }).pluginDexieMeta.put(row)
    },
    deletePluginDexiaMeta: async (pluginId: string) => {
      if (!_db) return
      await (_db as Dexie & { pluginDexieMeta: Dexie.Table }).pluginDexieMeta.delete(pluginId)
    },
  }
})

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { __setTestDb } = require("./meta")

describe("applyPluginTables", () => {
  let db: Dexie

  beforeEach(() => {
    db = makeTestDb()
    __setTestDb(db)
  })

  afterEach(async () => {
    await db.delete()
    delete (navigator as unknown as { locks?: unknown }).locks
  })

  it("registers plugin tables with the namespace prefix", async () => {
    await applyPluginTables(db, "github-delivery", {
      tables: [{ name: "repos", schema: "++id, fullName" }],
    })

    expect(db.tables.map((t) => t.name)).toContain("github-delivery:repos")
  })

  it("serializes schema upgrades across tabs with a database-scoped Web Lock", async () => {
    const request = jest.fn(async (_name: string, callback: () => Promise<void>) => callback())
    Object.defineProperty(navigator, "locks", {
      value: { request },
      configurable: true,
    })

    await applyPluginTables(db, "github-delivery", {
      tables: [{ name: "repos", schema: "++id, fullName" }],
    })

    expect(request).toHaveBeenCalledWith(`cognia-plugin-schema:${db.name}`, expect.any(Function))
  })

  it("re-resolves the active database after acquiring the cross-tab lock", async () => {
    const request = jest.fn(async (_name: string, callback: () => Promise<void>) => callback())
    Object.defineProperty(navigator, "locks", {
      value: { request },
      configurable: true,
    })
    const getActiveDb = jest.fn(() => db)

    await applyPluginTables(getActiveDb, "github-delivery", {
      tables: [{ name: "repos", schema: "++id, fullName" }],
    })

    expect(getActiveDb).toHaveBeenCalledTimes(2)
    expect(db.tables.map((t) => t.name)).toContain("github-delivery:repos")
  })

  it("stores meta row in pluginDexieMeta", async () => {
    await applyPluginTables(db, "github-delivery", {
      tables: [{ name: "repos", schema: "++id, fullName" }],
    })

    const meta = await getPluginDexieMeta("github-delivery")
    expect(meta).toBeDefined()
    expect(meta!.pluginId).toBe("github-delivery")
    expect(meta!.tableNames).toContain("github-delivery:repos")
  })

  it("two plugins declaring the same logical name do not collide", async () => {
    await applyPluginTables(db, "plugin-a", {
      tables: [{ name: "items", schema: "++id" }],
    })
    await applyPluginTables(db, "plugin-b", {
      tables: [{ name: "items", schema: "++id, name" }],
    })

    const tableNames = db.tables.map((t) => t.name)
    expect(tableNames).toContain("plugin-a:items")
    expect(tableNames).toContain("plugin-b:items")
  })

  it("is idempotent when called again with the same table set", async () => {
    await applyPluginTables(db, "github-delivery", {
      tables: [{ name: "repos", schema: "++id" }],
    })
    const versionAfterFirst = db.verno

    await applyPluginTables(db, "github-delivery", {
      tables: [{ name: "repos", schema: "++id" }],
    })
    const versionAfterSecond = db.verno

    // No bump on a no-op re-apply.
    expect(versionAfterSecond).toBe(versionAfterFirst)
  })

  it("serializes concurrent applies for different plugins (no schema clobber)", async () => {
    const versionBefore = db.verno
    // Fire both at once — the shared schema mutex must serialize the
    // close→bump→open cycle so neither plugin's tables are lost.
    await Promise.all([
      applyPluginTables(db, "plugin-a", { tables: [{ name: "items", schema: "++id" }] }),
      applyPluginTables(db, "plugin-b", { tables: [{ name: "items", schema: "++id, name" }] }),
    ])

    const tableNames = db.tables.map((t) => t.name)
    expect(tableNames).toContain("plugin-a:items")
    expect(tableNames).toContain("plugin-b:items")
    // Two distinct schema bumps applied serially → verno advanced by exactly 2.
    expect(db.verno).toBe(versionBefore + 2)
  })

  it("does not expose a closed database between the schema declaration and reopen", async () => {
    await db.open()
    const close = db.close.bind(db)
    let settleRacedRead: (result: { error?: unknown; value?: unknown }) => void = () => undefined
    const racedRead = new Promise<{ error?: unknown; value?: unknown }>((resolve) => {
      settleRacedRead = resolve
    })
    const closeSpy = jest.spyOn(db, "close").mockImplementation((options) => {
      close(options)
      // Model a sibling live query that was already queued when the plugin
      // schema bridge closed the shared database. There must be no microtask
      // checkpoint before version(...).stores(...).open() has been scheduled.
      queueMicrotask(() => {
        void db
          .table("pluginDexieMeta")
          .get("missing")
          .then(
            (value) => settleRacedRead({ value }),
            (error) => settleRacedRead({ error })
          )
      })
    })

    try {
      await applyPluginTables(db, "github-delivery", {
        tables: [{ name: "repos", schema: "++id, fullName" }],
      })
      await expect(racedRead).resolves.toEqual({ value: undefined })
    } finally {
      closeSpy.mockRestore()
    }
  })

  it("re-bumps when meta claims tables but the live store is missing (drift)", async () => {
    // Fresh process: the meta row survived from a prior session, but the
    // namespaced store is absent from the live schema. The early-return must
    // detect the gap and fall through to re-create the store rather than
    // trusting the stale meta.
    await seedMeta(db, {
      pluginId: "github-delivery",
      tableNames: ["github-delivery:repos"],
      dexieVersion: 99,
      appliedAt: 1,
    })
    expect(db.tables.map((t) => t.name)).not.toContain("github-delivery:repos")

    await applyPluginTables(db, "github-delivery", {
      tables: [{ name: "repos", schema: "&fullName" }],
    })

    expect(db.tables.map((t) => t.name)).toContain("github-delivery:repos")
  })

  it("still early-returns (no bump) when meta and the live store agree", async () => {
    await applyPluginTables(db, "github-delivery", {
      tables: [{ name: "repos", schema: "&fullName" }],
    })
    const vernoAfterFirst = db.verno

    await applyPluginTables(db, "github-delivery", {
      tables: [{ name: "repos", schema: "&fullName" }],
    })

    // Store present + meta matches → safe early-return, no schema bump.
    expect(db.verno).toBe(vernoAfterFirst)
  })

  it("bumps above the true native version after cross-session drift (no SchemaDiff auto-bump)", async () => {
    // Regression: `db.verno + 1` used the code-declared ceiling, not the
    // persisted native IndexedDB version, so on a fresh process it landed on a
    // version the physical DB had already passed. Dexie then logged
    // "Schema was extended without increasing the number passed to db.version()"
    // and force-bumped the native version behind our back — colliding with any
    // other open connection.
    const name = `test-drift-${Math.random().toString(36).slice(2)}`

    // --- Prior session: static ceiling v1, then two plugin bumps push the
    // physical native version to 3 (native == verno * 10 == 30). ---
    {
      const prior = new Dexie(name)
      prior.version(1).stores({ pluginDexieMeta: "&pluginId, appliedAt" })
      __setTestDb(prior)
      await applyPluginTables(prior, "plugin-a", { tables: [{ name: "t", schema: "&id" }] })
      await applyPluginTables(prior, "plugin-b", { tables: [{ name: "t", schema: "&id" }] })
      expect(prior.backendDB().version).toBe(30)
      prior.close()
    }

    // --- Fresh process: a NEW instance re-declares only the static ceiling v1,
    // so db.verno starts at 1 — well below the persisted native v3. ---
    const fresh = new Dexie(name)
    fresh.version(1).stores({ pluginDexieMeta: "&pluginId, appliedAt" })
    __setTestDb(fresh)

    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    try {
      await applyPluginTables(fresh, "plugin-c", { tables: [{ name: "t", schema: "&id" }] })
    } finally {
      warn.mockRestore()
    }

    // Store created via a clean EXPLICIT upgrade at native + 1 (v4), so verno
    // advanced to 4 (with the buggy code it would have declared v2).
    expect(fresh.tables.map((t) => t.name)).toContain("plugin-c:t")
    expect(fresh.verno).toBe(4)
    const schemaDiffWarned = warn.mock.calls.some((call) =>
      call.some((arg) => typeof arg === "string" && arg.includes("SchemaDiff"))
    )
    expect(schemaDiffWarned).toBe(false)

    await fresh.delete()
  })

  it("throws when more than MAX_TABLES_PER_PLUGIN tables are declared", async () => {
    const tables = Array.from({ length: 21 }, (_, i) => ({
      name: `table${i}`,
      schema: "++id",
    }))
    await expect(applyPluginTables(db, "big-plugin", { tables })).rejects.toThrow(
      /exceeding the maximum/
    )
  })
})

describe("removePluginTables", () => {
  let db: Dexie

  beforeEach(() => {
    db = makeTestDb()
    __setTestDb(db)
  })

  afterEach(async () => {
    await db.delete()
  })

  it("removes the meta row in retain mode (keeps the store)", async () => {
    await applyPluginTables(db, "github-delivery", {
      tables: [{ name: "repos", schema: "++id" }],
    })

    await removePluginTables(db, "github-delivery", "keep")

    const meta = await getPluginDexieMeta("github-delivery")
    expect(meta).toBeUndefined()
    // The store is still in the schema (data preserved).
    expect(db.tables.map((t) => t.name)).toContain("github-delivery:repos")
  })

  it("is a no-op for a plugin with no registered tables", async () => {
    await expect(removePluginTables(db, "unknown-plugin", "keep")).resolves.toBeUndefined()
  })

  it("purge mode drops stores and removes meta", async () => {
    await applyPluginTables(db, "github-delivery", {
      tables: [{ name: "repos", schema: "++id, fullName" }],
    })
    expect(db.tables.map((t) => t.name)).toContain("github-delivery:repos")

    await removePluginTables(db, "github-delivery", "purge")

    const meta = await getPluginDexieMeta("github-delivery")
    expect(meta).toBeUndefined()
    expect(db.tables.map((t) => t.name)).not.toContain("github-delivery:repos")
  })
})

describe("restorePluginTables", () => {
  let db: Dexie

  beforeEach(() => {
    db = makeTestDb()
    __setTestDb(db)
  })

  afterEach(async () => {
    await db.delete()
  })

  it("re-declares persisted tables missing from the live schema", async () => {
    // Prior session recorded the meta; this fresh process has no namespaced
    // store yet — exactly the github-delivery startup-activation failure.
    await seedMeta(db, {
      pluginId: "github-delivery",
      tableNames: ["github-delivery:repos"],
      dexieVersion: 99,
      appliedAt: 1,
    })
    expect(db.tables.map((t) => t.name)).not.toContain("github-delivery:repos")

    const restored = await restorePluginTables(
      db,
      new Map([["github-delivery", { tables: [{ name: "repos", schema: "&fullName" }] }]])
    )

    expect(restored).toEqual(["github-delivery:repos"])
    expect(db.tables.map((t) => t.name)).toContain("github-delivery:repos")
  })

  it("no-ops when there are no persisted metas", async () => {
    const restored = await restorePluginTables(
      db,
      new Map([["github-delivery", { tables: [{ name: "repos", schema: "&fullName" }] }]])
    )
    expect(restored).toEqual([])
  })

  it("registers manifest-only tables in one boot-time bump when requested", async () => {
    const restored = await restorePluginTables(
      db,
      new Map([
        ["plugin-a", { tables: [{ name: "x", schema: "++id" }] }],
        ["plugin-b", { tables: [{ name: "y", schema: "&id" }] }],
      ]),
      { registerMissing: true }
    )

    expect(restored.sort()).toEqual(["plugin-a:x", "plugin-b:y"])
    expect(await getPluginDexieMeta("plugin-a")).toMatchObject({
      tableNames: ["plugin-a:x"],
    })
    expect(await getPluginDexieMeta("plugin-b")).toMatchObject({
      tableNames: ["plugin-b:y"],
    })
  })

  it("updates stale metadata during the same consolidated boot-time bump", async () => {
    await seedMeta(db, {
      pluginId: "plugin-a",
      tableNames: ["plugin-a:old"],
      dexieVersion: 2,
      appliedAt: 1,
    })

    await restorePluginTables(
      db,
      new Map([
        [
          "plugin-a",
          {
            tables: [
              { name: "old", schema: "&id" },
              { name: "new", schema: "&id" },
            ],
          },
        ],
      ]),
      { registerMissing: true }
    )

    expect(await getPluginDexieMeta("plugin-a")).toMatchObject({
      tableNames: ["plugin-a:old", "plugin-a:new"],
    })
  })

  it("skips tables already present in the live schema (no bump)", async () => {
    await applyPluginTables(db, "github-delivery", {
      tables: [{ name: "repos", schema: "&fullName" }],
    })
    const vernoBefore = db.verno

    const restored = await restorePluginTables(
      db,
      new Map([["github-delivery", { tables: [{ name: "repos", schema: "&fullName" }] }]])
    )

    expect(restored).toEqual([])
    expect(db.verno).toBe(vernoBefore)
  })

  it("adopts an already-physical store without a native-version bump (drift fix)", async () => {
    // Reproduces the WKWebView v163 drift: a store physically created by a prior
    // session, then re-opened by a fresh Dexie instance that declares only the
    // core schema. Restore must ADOPT it in place, not re-upgrade every boot.
    const dbName = `drift-${Math.random().toString(36).slice(2)}`

    // Session 1: actually create the physical namespaced store.
    const first = new Dexie(dbName)
    first.version(1).stores({ pluginDexieMeta: "&pluginId, appliedAt" })
    __setTestDb(first)
    await applyPluginTables(first, "github-delivery", {
      tables: [{ name: "repos", schema: "&fullName" }],
    })
    const nativeAfterApply = first.backendDB().version
    await first.close()

    // Session 2: fresh instance over the SAME physical DB, core schema only —
    // the store exists physically but is absent from `db.tables`.
    const second = new Dexie(dbName)
    second.version(1).stores({ pluginDexieMeta: "&pluginId, appliedAt" })
    __setTestDb(second)
    await second.open()
    expect(second.tables.map((t) => t.name)).not.toContain("github-delivery:repos")

    const manifest = new Map([
      ["github-delivery", { tables: [{ name: "repos", schema: "&fullName" }] }],
    ])
    const restored = await restorePluginTables(second, manifest)

    expect(restored).toEqual(["github-delivery:repos"])
    expect(second.tables.map((t) => t.name)).toContain("github-delivery:repos")
    // Adopted at the current native version — NOT re-upgraded. No +1/boot drift.
    expect(second.backendDB().version).toBe(nativeAfterApply)

    // A subsequent restore is a pure no-op — stable across every future boot.
    const again = await restorePluginTables(second, manifest)
    expect(again).toEqual([])
    expect(second.backendDB().version).toBe(nativeAfterApply)

    await second.delete()
  })

  it("skips a lingering meta whose plugin is gone (no manifest)", async () => {
    await seedMeta(db, {
      pluginId: "uninstalled",
      tableNames: ["uninstalled:t"],
      dexieVersion: 99,
      appliedAt: 1,
    })

    // Empty manifest map — the plugin was removed but its meta row lingers.
    const restored = await restorePluginTables(db, new Map())

    expect(restored).toEqual([])
    expect(db.tables.map((t) => t.name)).not.toContain("uninstalled:t")
  })

  it("re-declares multiple plugins' tables in a single consolidated bump", async () => {
    await seedMeta(db, {
      pluginId: "plugin-a",
      tableNames: ["plugin-a:x"],
      dexieVersion: 99,
      appliedAt: 1,
    })
    await seedMeta(db, {
      pluginId: "plugin-b",
      tableNames: ["plugin-b:y"],
      dexieVersion: 99,
      appliedAt: 1,
    })
    const vernoBefore = db.verno

    const restored = await restorePluginTables(
      db,
      new Map([
        ["plugin-a", { tables: [{ name: "x", schema: "++id" }] }],
        ["plugin-b", { tables: [{ name: "y", schema: "++id" }] }],
      ])
    )

    expect(restored.sort()).toEqual(["plugin-a:x", "plugin-b:y"])
    const names = db.tables.map((t) => t.name)
    expect(names).toContain("plugin-a:x")
    expect(names).toContain("plugin-b:y")
    // Both plugins re-declared in ONE close→bump→open pass, not one per plugin.
    expect(db.verno).toBe(vernoBefore + 1)
  })
})

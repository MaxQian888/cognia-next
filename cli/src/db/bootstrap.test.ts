/**
 * @jest-environment node
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import Dexie from "dexie"

import { __resetCliDbForTesting, ensureCliDb, installFakeIndexedDb } from "./bootstrap"
import type { DbLike } from "./snapshot"

class FakeTable {
  rows: unknown[]
  constructor(
    public name: string,
    rows: unknown[] = []
  ) {
    this.rows = [...rows]
  }
  async toArray() {
    return this.rows
  }
  async clear() {
    this.rows = []
  }
  async bulkPut(rows: unknown[]) {
    this.rows.push(...rows)
  }
}

function fakeDb(): { db: DbLike; goals: FakeTable } {
  const goals = new FakeTable("goals", [{ id: "seed" }])
  return { db: { verno: 82, tables: [goals] }, goals }
}

interface Harness {
  installs: number
  writes: { path: string; data: string }[]
  scheduled: (() => void | Promise<void>)[]
  cancels: number
}

function makeOpts(over: Partial<Parameters<typeof ensureCliDb>[0]> = {}) {
  const h: Harness = { installs: 0, writes: [], scheduled: [], cancels: 0 }
  const { db, goals } = fakeDb()
  const opts = {
    home: "/home",
    installGlobals: async () => {
      h.installs++
    },
    getDatabase: () => db,
    whenReady: async () => {},
    readSnapshot: () => null as string | null,
    writeSnapshot: (path: string, data: string) => {
      h.writes.push({ path, data })
    },
    schedule: (fn: () => void | Promise<void>) => {
      h.scheduled.push(fn)
      return () => {
        h.cancels++
      }
    },
    ...over,
  }
  return { opts, h, db, goals }
}

beforeEach(() => __resetCliDbForTesting())

describe("ensureCliDb", () => {
  it("installs globals once and is idempotent across calls", async () => {
    const { opts, h } = makeOpts()
    const a = await ensureCliDb(opts)
    const b = await ensureCliDb(opts)
    expect(a).toBe(b)
    expect(h.installs).toBe(1)
  })

  it("restores a snapshot from disk into the db", async () => {
    const { opts, goals } = makeOpts({
      readSnapshot: () => JSON.stringify({ version: 82, tables: { goals: [{ id: "g1" }] } }),
    })
    await ensureCliDb(opts)
    expect(goals.rows).toEqual([{ id: "g1" }])
  })

  it("leaves seeded rows in place when there is no snapshot file", async () => {
    const { opts, goals } = makeOpts({ readSnapshot: () => null })
    await ensureCliDb(opts)
    expect(goals.rows).toEqual([{ id: "seed" }])
  })

  it("preserves and surfaces a truncated snapshot instead of allowing a flush", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-cli-db-corrupt-"))
    const file = path.join(home, "db.json")
    const truncated = '{"version":82,"tabl'
    fs.writeFileSync(file, truncated, "utf8")
    const { opts, h } = makeOpts({
      home,
      readSnapshot: () => truncated,
      writeSnapshot: undefined,
    })

    try {
      await expect(ensureCliDb(opts)).rejects.toThrow("snapshot is corrupt")
      expect(fs.existsSync(file)).toBe(false)
      expect(fs.readFileSync(`${file}.corrupt-1`, "utf8")).toBe(truncated)
      expect(h.writes).toHaveLength(0)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it("preserves and surfaces a snapshot schema mismatch without restoring rows", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-cli-db-version-"))
    const file = path.join(home, "db.json")
    const oldSnapshot = JSON.stringify({ version: 81, tables: { goals: [{ id: "old" }] } })
    fs.writeFileSync(file, oldSnapshot, "utf8")
    const { opts, goals } = makeOpts({
      home,
      readSnapshot: () => oldSnapshot,
      writeSnapshot: undefined,
    })

    try {
      await expect(ensureCliDb(opts)).rejects.toThrow(
        "snapshot schema version 81 does not match database schema version 82"
      )
      expect(goals.rows).toEqual([{ id: "seed" }])
      expect(fs.existsSync(file)).toBe(false)
      expect(fs.readFileSync(`${file}.incompatible-1`, "utf8")).toBe(oldSnapshot)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it("debounces flushes: re-scheduling cancels the prior timer", async () => {
    const { opts, h } = makeOpts()
    const handle = await ensureCliDb(opts)
    handle.scheduleFlush()
    handle.scheduleFlush()
    expect(h.cancels).toBe(1)
    expect(h.writes).toHaveLength(0)
    await h.scheduled[h.scheduled.length - 1]()
    expect(h.writes).toHaveLength(1)
  })

  it("flush() serialises every table to the snapshot path", async () => {
    const { opts, h, goals } = makeOpts()
    goals.rows = [{ id: "g1" }, { id: "g2" }]
    const handle = await ensureCliDb(opts)
    await handle.flush()
    expect(h.writes[0].path).toBe(path.join("/home", "db.json"))
    expect(JSON.parse(h.writes[0].data).tables.goals).toEqual([{ id: "g1" }, { id: "g2" }])
  })

  it("atomically replaces the snapshot and keeps one backup generation", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-cli-db-atomic-"))
    const file = path.join(home, "db.json")
    const { opts, goals } = makeOpts({ home, writeSnapshot: undefined })

    try {
      const handle = await ensureCliDb(opts)
      goals.rows = [{ id: "first" }]
      await handle.flush()
      const first = fs.readFileSync(file, "utf8")

      goals.rows = [{ id: "second" }]
      await handle.flush()

      expect(JSON.parse(fs.readFileSync(file, "utf8")).tables.goals).toEqual([{ id: "second" }])
      expect(fs.readFileSync(`${file}.bak`, "utf8")).toBe(first)
      expect(fs.existsSync(`${file}.tmp`)).toBe(false)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it("dispose() final-flushes, is safe to double-call, and clears the cache", async () => {
    const { opts, h } = makeOpts()
    const handle = await ensureCliDb(opts)
    await handle.dispose()
    await handle.dispose()
    expect(h.writes).toHaveLength(1)
    // Cache cleared → a fresh ensureCliDb re-installs globals.
    const { opts: opts2, h: h2 } = makeOpts()
    await ensureCliDb(opts2)
    expect(h2.installs).toBe(1)
  })
})

describe("installFakeIndexedDb", () => {
  it("installs fake-indexeddb + a window shim onto a bare global", async () => {
    const g: Record<string, unknown> = {}
    await installFakeIndexedDb(g)
    expect(g.window).toBe(g)
    expect(g.indexedDB).toBeDefined()
  })

  it("does not clobber an existing window or indexedDB", async () => {
    const existing = { real: true }
    const idb = { real: true }
    const g: Record<string, unknown> = { window: existing, indexedDB: idb }
    await installFakeIndexedDb(g)
    expect(g.window).toBe(existing)
    expect(g.indexedDB).toBe(idb)
  })

  it("rebinds Dexie.dependencies when Dexie captured an undefined global", async () => {
    // Reproduce Dexie's stale import-time snapshot: in Node the `dexie` module
    // evaluates before fake-indexeddb is installed, so its dependencies are
    // empty. Setting only the global would NOT fix the open path — the function
    // must re-point Dexie.dependencies itself.
    const savedIdb = Dexie.dependencies.indexedDB
    const savedRange = Dexie.dependencies.IDBKeyRange
    try {
      Dexie.dependencies.indexedDB = undefined as unknown as IDBFactory
      Dexie.dependencies.IDBKeyRange = undefined as unknown as typeof IDBKeyRange
      const g: Record<string, unknown> = {}
      await installFakeIndexedDb(g)
      expect(Dexie.dependencies.indexedDB).toBe(g.indexedDB)
      expect(Dexie.dependencies.IDBKeyRange).toBe(g.IDBKeyRange)
    } finally {
      Dexie.dependencies.indexedDB = savedIdb
      Dexie.dependencies.IDBKeyRange = savedRange
    }
  })
})

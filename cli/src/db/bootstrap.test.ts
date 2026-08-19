/**
 * @jest-environment node
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import Dexie from "dexie"

import {
  __resetCliDbForTesting,
  ensureCliDb,
  installFakeIndexedDb,
  writeSnapshotAtomically,
} from "./bootstrap"
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

  // Back-compat: snapshots written before the multi-database envelope have no
  // `snapshotFormat` key and must still restore into the primary database, or
  // every existing `~/.cognia/serve/db-*.json` would be quarantined on upgrade.
  it("restores a legacy single-database snapshot from disk into the db", async () => {
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

  it("never overwrites an earlier preserved snapshot, it takes the next generation", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-cli-db-gen-"))
    const file = path.join(home, "db.json")
    const truncated = '{"version":82,"tabl'
    fs.writeFileSync(file, truncated, "utf8")
    fs.writeFileSync(`${file}.corrupt-1`, "an earlier casualty", "utf8")
    const { opts } = makeOpts({ home, readSnapshot: () => truncated, writeSnapshot: undefined })

    try {
      await expect(ensureCliDb(opts)).rejects.toThrow("snapshot is corrupt")
      // The first casualty survives untouched; this one lands beside it.
      expect(fs.readFileSync(`${file}.corrupt-1`, "utf8")).toBe("an earlier casualty")
      expect(fs.readFileSync(`${file}.corrupt-2`, "utf8")).toBe(truncated)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  // Read-only volume / permissions problem on a server: the snapshot cannot even
  // be moved aside. The boot must still refuse to run (never silently overwrite)
  // and must say that the file stayed put.
  it("still refuses to boot when a bad snapshot cannot be moved aside", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-cli-db-readonly-"))
    const file = path.join(home, "db.json")
    const truncated = '{"version":82,"tabl'
    fs.writeFileSync(file, truncated, "utf8")
    const { opts } = makeOpts({ home, readSnapshot: () => truncated, writeSnapshot: undefined })

    fs.chmodSync(home, 0o500) // readable + traversable, not writable → rename fails
    try {
      await expect(ensureCliDb(opts)).rejects.toThrow("could not be moved aside")
      expect(fs.readFileSync(file, "utf8")).toBe(truncated)
    } finally {
      fs.chmodSync(home, 0o700)
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  // A restore failure that is NOT a schema mismatch (a dead table, a Dexie
  // transaction abort) must surface as-is instead of being relabelled "corrupt
  // snapshot" — otherwise a healthy file gets quarantined for an unrelated fault.
  it("propagates a non-version restore failure without quarantining the file", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-cli-db-restore-err-"))
    const file = path.join(home, "db.json")
    const snapshot = JSON.stringify({ version: 82, tables: { goals: [{ id: "g" }] } })
    fs.writeFileSync(file, snapshot, "utf8")
    const exploding = {
      name: "goals",
      toArray: async () => [],
      clear: async () => {
        throw new Error("table is gone")
      },
      bulkPut: async () => {},
    }

    try {
      await expect(
        ensureCliDb({
          home,
          getDatabases: () => [
            { name: "CogniaDB", db: { verno: 82, tables: [exploding], name: "CogniaDB" } },
          ],
          installGlobals: async () => {},
          whenReady: async () => {},
          readSnapshot: () => snapshot,
          writeSnapshot: undefined,
          schedule: () => () => {},
        })
      ).rejects.toThrow("table is gone")
      // Not treated as a bad snapshot → the file stays exactly where it was.
      expect(fs.readFileSync(file, "utf8")).toBe(snapshot)
      expect(fs.existsSync(`${file}.corrupt-1`)).toBe(false)
      expect(fs.existsSync(`${file}.incompatible-1`)).toBe(false)
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
    const written = JSON.parse(h.writes[0].data)
    expect(written.snapshotFormat).toBe(2)
    expect(written.dbs.CogniaDB.tables.goals).toEqual([{ id: "g1" }, { id: "g2" }])
  })

  it("persists production snapshots per table and rewrites only dirty tables", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-cli-db-tables-"))
    const goals = new FakeTable("goals", [{ id: "g1" }])
    const sessions = new FakeTable("sessions", [{ id: "s1" }])
    const db: DbLike = { verno: 82, tables: [goals, sessions], name: "CogniaDB" }

    try {
      const handle = await ensureCliDb({
        home,
        getDatabase: () => db,
        installGlobals: async () => {},
        whenReady: async () => {},
        schedule: () => () => {},
      })
      await handle.flush()

      const tableDir = path.join(home, "db.json.tables")
      const manifest = JSON.parse(fs.readFileSync(path.join(tableDir, "manifest.json"), "utf8"))
      expect(manifest.snapshotFormat).toBe(3)
      expect(manifest.dbs.CogniaDB).toEqual({
        version: 82,
        tables: ["goals", "sessions"],
      })
      const files = fs
        .readdirSync(tableDir)
        .filter((name) => name !== "manifest.json" && !name.endsWith(".bak"))
        .sort()
      expect(files).toHaveLength(2)
      const sessionsFile = files.find((name) => name.includes("sessions"))!
      const goalsFile = files.find((name) => name.includes("goals"))!
      const sessionsBefore = fs.readFileSync(path.join(tableDir, sessionsFile), "utf8")

      goals.rows = [{ id: "g2" }]
      sessions.rows = [{ id: "s2" }]
      handle.scheduleTableFlush("CogniaDB", "goals")
      await handle.flush()

      expect(JSON.parse(fs.readFileSync(path.join(tableDir, goalsFile), "utf8"))).toEqual([
        { id: "g2" },
      ])
      expect(fs.readFileSync(path.join(tableDir, sessionsFile), "utf8")).toBe(sessionsBefore)
    } finally {
      __resetCliDbForTesting()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it("does not list a dynamic table until its snapshot file has been written", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-cli-db-manifest-race-"))
    const lateTable = new FakeTable("plugin:rows")
    let addedLateTable = false
    const goals = new FakeTable("goals", [{ id: "g1" }])
    const originalToArray = goals.toArray.bind(goals)
    const db: DbLike = { verno: 83, tables: [goals], name: "CogniaDB" }
    goals.toArray = async () => {
      if (!addedLateTable) {
        db.tables.push(lateTable)
        addedLateTable = true
      }
      return originalToArray()
    }

    try {
      const handle = await ensureCliDb({
        home,
        getDatabase: () => db,
        installGlobals: async () => {},
        whenReady: async () => {},
        schedule: () => () => {},
      })
      const tableDir = path.join(home, "db.json.tables")
      const manifestFile = path.join(tableDir, "manifest.json")
      const lateTableFile = path.join(tableDir, "CogniaDB--plugin%3Arows.json")

      await handle.flush()

      expect(JSON.parse(fs.readFileSync(manifestFile, "utf8")).dbs.CogniaDB.tables).toEqual([
        "goals",
      ])
      expect(fs.existsSync(lateTableFile)).toBe(false)

      handle.scheduleTableFlush("CogniaDB", "plugin:rows")
      await handle.flush()

      expect(JSON.parse(fs.readFileSync(manifestFile, "utf8")).dbs.CogniaDB.tables).toEqual([
        "goals",
        "plugin:rows",
      ])
      expect(fs.readFileSync(lateTableFile, "utf8")).toBe("[]")
    } finally {
      __resetCliDbForTesting()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it("prepares a dynamic schema before validating a production table snapshot", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-cli-db-dynamic-schema-"))
    const tableDir = path.join(home, "db.json.tables")
    fs.mkdirSync(tableDir, { recursive: true })
    const goals = new FakeTable("goals", [{ id: "seed" }])
    const db: DbLike = { verno: 82, tables: [goals], name: "CogniaDB" }
    fs.writeFileSync(
      path.join(tableDir, "manifest.json"),
      JSON.stringify({
        snapshotFormat: 3,
        dbs: { CogniaDB: { version: 83, tables: ["goals"] } },
      })
    )
    fs.writeFileSync(
      path.join(tableDir, "CogniaDB--goals.json"),
      JSON.stringify([{ id: "restored" }])
    )
    const prepareDynamicSchema = jest.fn(async () => {
      db.verno = 83
    })

    try {
      await ensureCliDb({
        home,
        getDatabase: () => db,
        installGlobals: async () => {},
        whenReady: async () => {},
        prepareDynamicSchema,
      })

      expect(prepareDynamicSchema).toHaveBeenCalledWith([expect.objectContaining({ db })], {
        CogniaDB: 83,
      })
      expect(goals.rows).toEqual([{ id: "restored" }])
    } finally {
      __resetCliDbForTesting()
      fs.rmSync(home, { recursive: true, force: true })
    }
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

      expect(JSON.parse(fs.readFileSync(file, "utf8")).dbs.CogniaDB.tables.goals).toEqual([
        { id: "second" },
      ])
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

  // No database seam at all — the production default. Drives the real
  // `CogniaDB` + `CogniaSchedulerDB` under fake-indexeddb so a missing scheduler
  // source (the bug this whole change fixes) fails here rather than in the field.
  it("defaults to both real databases, with the scheduler exclusions applied", async () => {
    __resetCliDbForTesting()
    const writes: { path: string; data: string }[] = []
    const handle = await ensureCliDb({
      home: "/home",
      readSnapshot: () => null,
      writeSnapshot: (p, data) => {
        writes.push({ path: p, data })
      },
      schedule: () => () => {},
    })
    try {
      await handle.flush()
      const written = JSON.parse(writes[0].data)
      expect(written.snapshotFormat).toBe(2)
      expect(Object.keys(written.dbs)).toContain("CogniaSchedulerDB")
      // The primary key is the live CogniaDB name (per-account, not hardcoded).
      expect(Object.keys(written.dbs)).toHaveLength(2)
      expect(written.dbs.CogniaSchedulerDB.tables).toHaveProperty("tasks")
      expect(written.dbs.CogniaSchedulerDB.tables).not.toHaveProperty("executions")
    } finally {
      await handle.dispose()
      __resetCliDbForTesting()
    }
  })
})

describe("ensureCliDb — multiple databases", () => {
  /** Primary `CogniaDB` + a second database standing in for CogniaSchedulerDB. */
  function makeMultiOpts(over: Partial<Parameters<typeof ensureCliDb>[0]> = {}) {
    const h: Harness = { installs: 0, writes: [], scheduled: [], cancels: 0 }
    const goals = new FakeTable("goals", [{ id: "seed" }])
    const tasks = new FakeTable("tasks", [])
    const executions = new FakeTable("executions", [{ id: "old-run" }])
    const primary: DbLike = { verno: 82, tables: [goals], name: "CogniaDB" }
    const scheduler: DbLike = { verno: 2, tables: [tasks, executions], name: "CogniaSchedulerDB" }
    const opts = {
      home: "/home",
      installGlobals: async () => {
        h.installs++
      },
      getDatabases: () => [
        { name: "CogniaDB", db: primary },
        { name: "CogniaSchedulerDB", db: scheduler, excludeTables: ["executions"] },
      ],
      whenReady: async () => {},
      readSnapshot: () => null as string | null,
      writeSnapshot: (p: string, data: string) => {
        h.writes.push({ path: p, data })
      },
      schedule: (fn: () => void | Promise<void>) => {
        h.scheduled.push(fn)
        return () => {
          h.cancels++
        }
      },
      ...over,
    }
    return { opts, h, goals, tasks, executions }
  }

  it("snapshots every database under its own key", async () => {
    const { opts, h, goals, tasks } = makeMultiOpts()
    goals.rows = [{ id: "g1" }]
    tasks.rows = [{ id: "t1" }]
    const handle = await ensureCliDb(opts)
    await handle.flush()
    const written = JSON.parse(h.writes[0].data)
    expect(written.snapshotFormat).toBe(2)
    expect(written.dbs.CogniaDB).toEqual({ version: 82, tables: { goals: [{ id: "g1" }] } })
    expect(written.dbs.CogniaSchedulerDB.version).toBe(2)
    expect(written.dbs.CogniaSchedulerDB.tables.tasks).toEqual([{ id: "t1" }])
  })

  // The `executions` exemption (SCHEDULER_SNAPSHOT_EXCLUDED_TABLES) pinned on the
  // snapshot axis: scheduled tasks MUST survive a restart, execution history
  // must NOT be dumped on every write. Both halves are asserted together so
  // neither can regress silently.
  it("persists tasks but keeps excluded tables out of the snapshot", async () => {
    const { opts, h, tasks, executions } = makeMultiOpts()
    tasks.rows = [{ id: "t1" }]
    executions.rows = [{ id: "run-1" }]
    const handle = await ensureCliDb(opts)
    await handle.flush()
    const scheduler = JSON.parse(h.writes[0].data).dbs.CogniaSchedulerDB
    expect(scheduler.tables.tasks).toEqual([{ id: "t1" }])
    expect(scheduler.tables).not.toHaveProperty("executions")
  })

  it("restores each database from its own key", async () => {
    const { opts, goals, tasks } = makeMultiOpts({
      readSnapshot: () =>
        JSON.stringify({
          snapshotFormat: 2,
          dbs: {
            CogniaDB: { version: 82, tables: { goals: [{ id: "g1" }] } },
            CogniaSchedulerDB: { version: 2, tables: { tasks: [{ id: "t1" }] } },
          },
        }),
    })
    await ensureCliDb(opts)
    expect(goals.rows).toEqual([{ id: "g1" }])
    expect(tasks.rows).toEqual([{ id: "t1" }])
  })

  // The upgrade path: a legacy file has no scheduler entry, so that database is
  // SKIPPED rather than cleared, and keeps whatever it was seeded with.
  it("skips a database the envelope omits instead of clearing it", async () => {
    const { opts, goals, executions } = makeMultiOpts({
      readSnapshot: () => JSON.stringify({ version: 82, tables: { goals: [{ id: "g1" }] } }),
    })
    await ensureCliDb(opts)
    expect(goals.rows).toEqual([{ id: "g1" }])
    expect(executions.rows).toEqual([{ id: "old-run" }])
  })

  it("names the mismatching database when a per-db schema version differs", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-cli-db-multiver-"))
    const stale = JSON.stringify({
      snapshotFormat: 2,
      dbs: {
        CogniaDB: { version: 82, tables: { goals: [] } },
        CogniaSchedulerDB: { version: 1, tables: { tasks: [{ id: "t1" }] } },
      },
    })
    fs.writeFileSync(path.join(home, "db.json"), stale, "utf8")
    const { opts, tasks } = makeMultiOpts({
      home,
      readSnapshot: () => stale,
      writeSnapshot: undefined,
    })
    try {
      await expect(ensureCliDb(opts)).rejects.toThrow("for database CogniaSchedulerDB")
      expect(tasks.rows).toEqual([])
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it("rejects an unsupported envelope format instead of guessing", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-cli-db-badfmt-"))
    const future = JSON.stringify({ snapshotFormat: 99, dbs: {} })
    fs.writeFileSync(path.join(home, "db.json"), future, "utf8")
    const { opts } = makeMultiOpts({ home, readSnapshot: () => future, writeSnapshot: undefined })
    try {
      await expect(ensureCliDb(opts)).rejects.toThrow("unsupported snapshot format 99")
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})

// Windows cannot `rename` onto an existing path, so `replaceFile` unlinks the
// destination first and `syncParentDirectory` is skipped. That branch never runs
// on the CI platforms, so it is driven here with a stubbed `process.platform` —
// otherwise the Windows atomic-replace path ships untested.
describe("writeSnapshotAtomically on win32", () => {
  const realPlatform = process.platform

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: realPlatform, configurable: true })
  })

  it("unlinks the destination before renaming and keeps one backup generation", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-cli-db-win32-"))
    const file = path.join(home, "db.json")
    Object.defineProperty(process, "platform", { value: "win32", configurable: true })
    try {
      writeSnapshotAtomically(file, "first")
      expect(fs.readFileSync(file, "utf8")).toBe("first")
      expect(fs.existsSync(`${file}.bak`)).toBe(false)

      writeSnapshotAtomically(file, "second")
      expect(fs.readFileSync(file, "utf8")).toBe("second")
      expect(fs.readFileSync(`${file}.bak`, "utf8")).toBe("first")
      expect(fs.existsSync(`${file}.tmp`)).toBe(false)
      expect(fs.existsSync(`${file}.bak.tmp`)).toBe(false)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
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

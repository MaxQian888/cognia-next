/**
 * @jest-environment node
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import Dexie from "dexie"
import { getRecentErrorLogs } from "@/packages/logging/src/recent-errors"

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

  it.each([
    ["legacy", "corrupt"],
    ["legacy", "incompatible"],
    ["table manifest", "corrupt"],
    ["table manifest", "incompatible"],
  ])(
    "keeps refusing a quarantined %s (%s) on restart until the canonical snapshot is repaired",
    async (kind, reason) => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-cli-db-recovery-"))
      const tableDirectory = path.join(home, "db.json.tables")
      const file =
        kind === "legacy" ? path.join(home, "db.json") : path.join(tableDirectory, "manifest.json")
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const original =
        reason === "corrupt"
          ? "{truncated"
          : JSON.stringify(
              kind === "legacy"
                ? { version: 83, tables: { goals: [{ id: "original" }] } }
                : { snapshotFormat: 3, dbs: { CogniaDB: { version: 83, tables: ["goals"] } } }
            )
      fs.writeFileSync(file, original, "utf8")
      const goals = new FakeTable("goals", [{ id: "seed" }])
      const opts = {
        home,
        getDatabase: () => ({ verno: 82, name: "CogniaDB", tables: [goals] }),
        installGlobals: jest.fn(async () => {}),
        whenReady: async () => {},
        schedule: () => () => {},
      }
      try {
        await expect(ensureCliDb(opts)).rejects.toThrow(reason)
        await expect(ensureCliDb(opts)).rejects.toThrow(/requires recovery/)
        // The quarantine self-heal check needs the live schema version, so a
        // refusing retry still installs globals before it throws.
        expect(opts.installGlobals).toHaveBeenCalledTimes(2)
        expect(fs.readFileSync(`${file}.${reason}-1`, "utf8")).toBe(original)
        expect(fs.existsSync(`${file}.${reason}-2`)).toBe(false)
        expect(fs.existsSync(file)).toBe(false)
        if (kind === "legacy") {
          fs.writeFileSync(
            file,
            JSON.stringify({ version: 82, tables: { goals: [{ id: "recovered" }] } })
          )
        } else {
          fs.writeFileSync(
            path.join(tableDirectory, "CogniaDB--goals.json"),
            JSON.stringify([{ id: "recovered" }])
          )
          fs.writeFileSync(
            file,
            JSON.stringify({
              snapshotFormat: 3,
              dbs: { CogniaDB: { version: 82, tables: ["goals"] } },
            })
          )
        }
        const handle = await ensureCliDb(opts)
        expect(goals.rows).toEqual([{ id: "recovered" }])
        await handle.dispose()
      } finally {
        __resetCliDbForTesting()
        fs.rmSync(home, { recursive: true, force: true })
      }
    }
  )

  it.each([
    ["missing table", undefined],
    ["truncated table", "{truncated"],
    ["non-array table", "{}"],
  ])(
    "keeps refusing a %s across restarts without overwriting its data",
    async (_label, contents) => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-cli-db-table-recovery-"))
      const directory = path.join(home, "db.json.tables")
      const manifestFile = path.join(directory, "manifest.json")
      const tableFile = path.join(directory, "CogniaDB--goals.json")
      fs.mkdirSync(directory)
      const manifest = JSON.stringify({
        snapshotFormat: 3,
        dbs: { CogniaDB: { version: 82, tables: ["goals"] } },
      })
      fs.writeFileSync(manifestFile, manifest)
      if (contents !== undefined) fs.writeFileSync(tableFile, contents)
      const goals = new FakeTable("goals", [{ id: "seed" }])
      const opts = {
        home,
        getDatabase: () => ({ verno: 82, name: "CogniaDB", tables: [goals] }),
        installGlobals: async () => {},
        whenReady: async () => {},
        schedule: () => () => {},
      }
      try {
        await expect(ensureCliDb(opts)).rejects.toThrow(/corrupt/)
        await expect(ensureCliDb(opts)).rejects.toThrow(/requires recovery/)
        expect(fs.readFileSync(`${manifestFile}.corrupt-1`, "utf8")).toBe(manifest)
        expect(goals.rows).toEqual([{ id: "seed" }])
        if (contents !== undefined) expect(fs.readFileSync(tableFile, "utf8")).toBe(contents)
        else expect(fs.existsSync(tableFile)).toBe(false)
        fs.writeFileSync(tableFile, "[]")
        fs.writeFileSync(manifestFile, manifest)
        const handle = await ensureCliDb(opts)
        expect(goals.rows).toEqual([])
        await handle.dispose()
      } finally {
        __resetCliDbForTesting()
        fs.rmSync(home, { recursive: true, force: true })
      }
    }
  )

  it.each([
    null,
    [],
    { snapshotFormat: 2, dbs: {} },
    { snapshotFormat: 3, dbs: null },
    { snapshotFormat: 3, dbs: { CogniaDB: [] } },
    { snapshotFormat: 3, dbs: { CogniaDB: { version: "82", tables: [] } } },
    { snapshotFormat: 3, dbs: { CogniaDB: { version: 82, tables: null } } },
    { snapshotFormat: 3, dbs: { CogniaDB: { version: 82, tables: [1] } } },
  ])("preserves invalid manifest structure %# and refuses restart", async (manifest) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-cli-db-manifest-recovery-"))
    const directory = path.join(home, "db.json.tables")
    fs.mkdirSync(directory)
    const file = path.join(directory, "manifest.json")
    const text = JSON.stringify(manifest)
    fs.writeFileSync(file, text)
    const opts = {
      home,
      getDatabase: () => ({ verno: 82, name: "CogniaDB", tables: [] }),
      installGlobals: async () => {},
      whenReady: async () => {},
    }
    try {
      await expect(ensureCliDb(opts)).rejects.toThrow(/corrupt/)
      await expect(ensureCliDb(opts)).rejects.toThrow(/requires recovery/)
      expect(fs.readFileSync(`${file}.corrupt-1`, "utf8")).toBe(text)
    } finally {
      __resetCliDbForTesting()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it("does not treat an unrelated backup filename as a quarantined snapshot", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-cli-db-backup-name-"))
    fs.writeFileSync(path.join(home, "db.json.corrupt-not-a-generation"), "unrelated")
    try {
      const handle = await ensureCliDb({
        home,
        getDatabase: () => ({ verno: 82, name: "CogniaDB", tables: [] }),
        installGlobals: async () => {},
        whenReady: async () => {},
      })
      await handle.dispose()
    } finally {
      __resetCliDbForTesting()
      fs.rmSync(home, { recursive: true, force: true })
    }
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

  it("preserves and surfaces a newer-build snapshot without restoring rows", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-cli-db-version-"))
    const file = path.join(home, "db.json")
    const oldSnapshot = JSON.stringify({ version: 83, tables: { goals: [{ id: "old" }] } })
    fs.writeFileSync(file, oldSnapshot, "utf8")
    const { opts, goals } = makeOpts({
      home,
      readSnapshot: () => oldSnapshot,
      writeSnapshot: undefined,
    })

    try {
      await expect(ensureCliDb(opts)).rejects.toThrow(
        "snapshot schema version 83 is newer than database schema version 82"
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

  it("reports scheduled ENOSPC without rejecting and retries every dirty table", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-cli-db-full-"))
    const goals = new FakeTable("goals", [{ id: "pending-goal" }])
    const sessions = new FakeTable("sessions", [{ id: "pending-session" }])
    const scheduled: (() => void | Promise<void>)[] = []
    const full = Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" })
    let mkdir: jest.SpyInstance | undefined
    try {
      const handle = await ensureCliDb({
        home,
        getDatabase: () => ({ name: "CogniaDB", verno: 82, tables: [goals, sessions] }),
        installGlobals: async () => {},
        whenReady: async () => {},
        schedule: (fn) => {
          scheduled.push(fn)
          return () => {}
        },
      })
      mkdir = jest.spyOn(fs.promises, "mkdir").mockRejectedValueOnce(full)
      handle.scheduleFlush()
      await expect(Promise.resolve(scheduled[0]())).resolves.toBeUndefined()
      expect(getRecentErrorLogs()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            module: "cli.db",
            message: expect.stringContaining("flush failed"),
          }),
        ])
      )
      expect(scheduled).toHaveLength(1) // No uncontrolled retry timer on a full disk.
      mkdir.mockRestore()
      sessions.rows = [{ id: "latest-session" }]
      handle.scheduleTableFlush("CogniaDB", "sessions")
      await handle.flush()
      const tableDir = path.join(home, "db.json.tables")
      expect(
        JSON.parse(fs.readFileSync(path.join(tableDir, "CogniaDB--goals.json"), "utf8"))
      ).toEqual([{ id: "pending-goal" }])
      expect(
        JSON.parse(fs.readFileSync(path.join(tableDir, "CogniaDB--sessions.json"), "utf8"))
      ).toEqual([{ id: "latest-session" }])
      await handle.dispose()
    } finally {
      mkdir?.mockRestore()
      __resetCliDbForTesting()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it("keeps explicit flush and dispose ENOSPC rejection retryable without losing the cached handle", async () => {
    let full = true
    const saved: string[] = []
    const error = Object.assign(new Error("ENOSPC: disk full"), { code: "ENOSPC" })
    const { opts, goals } = makeOpts({
      writeSnapshot: (_file, data) => {
        if (full) throw error
        saved.push(data)
      },
    })
    const handle = await ensureCliDb(opts)
    goals.rows = [{ id: "unsaved" }]
    await expect(handle.flush()).rejects.toBe(error)
    await expect(handle.dispose()).rejects.toBe(error)
    expect(await ensureCliDb(opts)).toBe(handle)
    full = false
    await handle.dispose()
    expect(saved).toHaveLength(1)
    expect(JSON.parse(saved[0]).dbs.CogniaDB.tables.goals).toEqual([{ id: "unsaved" }])
    await handle.dispose()
    expect(saved).toHaveLength(1)
    expect(await ensureCliDb(opts)).not.toBe(handle)
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

  it("restores attachment bytes and derived thumbnails after a production table-store restart", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-cli-media-restart-"))
    const bytes = Uint8Array.from({ length: 140_000 }, (_, index) => index % 251)
    const media = new FakeTable("messageMedia", [
      {
        hash: "source",
        blob: new Blob([bytes], { type: "application/pdf" }),
        thumb: new Blob(["preview"], { type: "image/png" }),
      },
    ])
    const options = {
      home,
      getDatabase: () => ({ name: "CogniaDB", verno: 82, tables: [media] }),
      installGlobals: async () => {},
      whenReady: async () => {},
      schedule: () => () => {},
    }
    try {
      const first = await ensureCliDb(options)
      await first.dispose()
      const tableDirectory = path.join(home, "db.json.tables")
      const serialized = fs.readFileSync(
        path.join(tableDirectory, "CogniaDB--messageMedia.json"),
        "utf8"
      )
      expect(serialized.length).toBeLessThan(1000)
      expect(serialized).not.toContain("chunks")
      expect(fs.readdirSync(path.join(tableDirectory, "binary"))).toHaveLength(2)
      media.rows = []
      const readFileSync = fs.readFileSync
      const read = jest.spyOn(fs, "readFileSync").mockImplementation(((
        file: fs.PathOrFileDescriptor,
        ...args: unknown[]
      ) => {
        if (String(file).includes(`${path.sep}binary${path.sep}`))
          throw new Error("originals must not be materialized during restore")
        return Reflect.apply(readFileSync, fs, [file, ...args])
      }) as typeof fs.readFileSync)
      let restarted: Awaited<ReturnType<typeof ensureCliDb>>
      try {
        restarted = await ensureCliDb(options)
      } finally {
        read.mockRestore()
      }
      const restored = media.rows[0] as { blob: Blob; thumb: Blob }
      expect(restored.blob).toBeInstanceOf(Blob)
      expect(restored.blob.type).toBe("application/pdf")
      expect(new Uint8Array(await restored.blob.arrayBuffer())).toEqual(bytes)
      expect(await restored.thumb.text()).toBe("preview")
      const binaryFiles = fs.readdirSync(path.join(tableDirectory, "binary"))
      const before = binaryFiles.map(
        (name) => fs.statSync(path.join(tableDirectory, "binary", name)).ino
      )
      restarted.scheduleTableFlush("CogniaDB", "messageMedia")
      await restarted.flush()
      expect(
        binaryFiles.map((name) => fs.statSync(path.join(tableDirectory, "binary", name)).ino)
      ).toEqual(before)
      // A duplicate flush must not replace the backing inode and invalidate
      // the Blob already held by the restored database or a source preview.
      expect(new Uint8Array(await restored.blob.arrayBuffer())).toEqual(bytes)
      await restarted.dispose()
    } finally {
      __resetCliDbForTesting()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it("rejects same-length corrupted sidecars before clearing a stored table", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-cli-media-corrupt-"))
    const media = new FakeTable("messageMedia", [{ blob: new Blob(["source"]) }])
    const options = {
      home,
      getDatabase: () => ({ name: "CogniaDB", verno: 82, tables: [media] }),
      installGlobals: async () => {},
      whenReady: async () => {},
      schedule: () => () => {},
    }
    try {
      const first = await ensureCliDb(options)
      await first.dispose()
      const binary = path.join(home, "db.json.tables", "binary")
      fs.writeFileSync(path.join(binary, fs.readdirSync(binary)[0]!), "broken")
      media.rows = [{ id: "keep" }]
      await expect(ensureCliDb(options)).rejects.toThrow("corrupt")
      expect(media.rows).toEqual([{ id: "keep" }])
    } finally {
      __resetCliDbForTesting()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it("round-trips lazy sources through real Dexie reads, updates, cloning, and another snapshot", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-cli-lazy-dexie-"))
    await installFakeIndexedDb()
    const name = `LazyMedia-${path.basename(home)}`
    const open = () => {
      const db = new Dexie(name)
      db.version(1).stores({ messageMedia: "hash" })
      return db
    }
    let database = open()
    const options = {
      home,
      getDatabase: () => database,
      installGlobals: async () => {},
      whenReady: async () => {
        await database.open()
      },
      schedule: () => () => {},
    }
    try {
      await database.open()
      await database
        .table("messageMedia")
        .put({ hash: "source", blob: new Blob(["source bytes"], { type: "text/plain" }) })
      const first = await ensureCliDb(options)
      await first.dispose()
      await database.table("messageMedia").clear()
      database.close()
      database = open()
      const restarted = await ensureCliDb(options)
      const table = database.table("messageMedia")
      const row = await table.get("source")
      expect(await row.blob.text()).toBe("source bytes")
      expect(await structuredClone(row).blob.text()).toBe("source bytes")
      expect(await (await table.toArray())[0].blob.text()).toBe("source bytes")
      await table.update("source", { lastUsedAt: 2 })
      await table.put({ ...(await table.get("source")), lastUsedAt: 3 })
      restarted.scheduleTableFlush(name, "messageMedia")
      await restarted.flush()
      expect(await row.blob.text()).toBe("source bytes")
      expect(await (await table.get("source")).blob.text()).toBe("source bytes")
      await restarted.dispose()
      const tableJson = fs.readFileSync(
        path.join(home, "db.json.tables", `${encodeURIComponent(name)}--messageMedia.json`),
        "utf8"
      )
      expect(JSON.parse(tableJson)[0].blob.$cogniaSnapshotValue.fileRef).toMatch(/^[a-f0-9]{64}$/)
      const binary = path.join(home, "db.json.tables", "binary")
      fs.writeFileSync(path.join(binary, fs.readdirSync(binary)[0]!), "changed data")
      await expect(row.blob.text()).rejects.toThrow()
    } finally {
      __resetCliDbForTesting()
      await database.delete()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it("retains binary recovery generations and collects them only after every durable reference is gone", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-cli-media-gc-"))
    const media = new FakeTable("messageMedia", [{ hash: "source", blob: new Blob(["original"]) }])
    const options = {
      home,
      getDatabase: () => ({ name: "CogniaDB", verno: 82, tables: [media] }),
      installGlobals: async () => {},
      whenReady: async () => {},
      schedule: () => () => {},
    }
    try {
      const handle = await ensureCliDb(options)
      await handle.flush()
      const binary = path.join(home, "db.json.tables", "binary")
      expect(fs.readdirSync(binary)).toHaveLength(1)
      media.rows = []
      handle.scheduleTableFlush("CogniaDB", "messageMedia")
      await handle.flush()
      expect(fs.readdirSync(binary)).toHaveLength(1)
      handle.scheduleTableFlush("CogniaDB", "messageMedia")
      await handle.flush()
      expect(fs.readdirSync(binary)).toHaveLength(0)
      await handle.dispose()
    } finally {
      __resetCliDbForTesting()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it.each([process.platform, "win32"])(
    "yields during durable table writes and serializes queued flushes on %s",
    async (platform) => {
      const realPlatform = process.platform
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-cli-db-async-"))
      const goals = new FakeTable("goals", [{ id: "initial" }])
      const handle = await ensureCliDb({
        home,
        getDatabase: () => ({ name: "CogniaDB", verno: 82, tables: [goals] }),
        installGlobals: async () => {},
        whenReady: async () => {},
        schedule: () => () => {},
      })
      await handle.flush()
      const file = path.join(home, "db.json.tables", "CogniaDB--goals.json")
      const initial = fs.readFileSync(file, "utf8")
      const firstRows = [
        { id: "first", text: "会话 🔐" },
        undefined,
        new Date(0),
        {
          toJSON(key: string) {
            return { key }
          },
        },
      ]
      goals.rows = firstRows
      handle.scheduleTableFlush("CogniaDB", "goals")

      let release!: () => void
      let signal!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const entered = new Promise<"syncing">((resolve) => {
        signal = () => resolve("syncing")
      })
      const open = fs.promises.open.bind(fs.promises)
      const openSpy = jest.spyOn(fs.promises, "open").mockImplementationOnce(async (...args) => {
        const descriptor = await open(...args)
        const sync = descriptor.sync.bind(descriptor)
        jest.spyOn(descriptor, "sync").mockImplementationOnce(async () => {
          signal()
          await gate
          await sync()
        })
        return descriptor
      })
      Object.defineProperty(process, "platform", { value: platform, configurable: true })
      const first = handle.flush()
      try {
        expect(await Promise.race([entered, first.then(() => "completed")])).toBe("syncing")
        expect(fs.readFileSync(file, "utf8")).toBe(initial)
        goals.rows = [{ id: "second" }]
        handle.scheduleTableFlush("CogniaDB", "goals")
        const second = handle.flush()
        release()
        await Promise.all([first, second])
        expect(fs.readFileSync(`${file}.bak`, "utf8")).toBe(JSON.stringify(firstRows))
        expect(fs.readFileSync(file, "utf8")).toBe(JSON.stringify(goals.rows))
        expect(fs.existsSync(`${file}.tmp`)).toBe(false)
        expect(fs.existsSync(`${file}.bak.tmp`)).toBe(false)
      } finally {
        release()
        openSpy.mockRestore()
        await first.catch(() => {})
        Object.defineProperty(process, "platform", { value: realPlatform, configurable: true })
        __resetCliDbForTesting()
        fs.rmSync(home, { recursive: true, force: true })
      }
    }
  )

  it("closes a failed sync handle and retries without replacing the canonical table", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-cli-db-sync-failure-"))
    const goals = new FakeTable("goals", [{ id: "original" }])
    const handle = await ensureCliDb({
      home,
      getDatabase: () => ({ name: "CogniaDB", verno: 82, tables: [goals] }),
      installGlobals: async () => {},
      whenReady: async () => {},
      schedule: () => () => {},
    })
    await handle.flush()
    const file = path.join(home, "db.json.tables", "CogniaDB--goals.json")
    goals.rows = [{ id: "pending" }]
    handle.scheduleTableFlush("CogniaDB", "goals")
    const open = fs.promises.open.bind(fs.promises)
    let closeSpy: jest.SpyInstance | undefined
    const error = new Error("fsync failed")
    const openSpy = jest.spyOn(fs.promises, "open").mockImplementationOnce(async (...args) => {
      const descriptor = await open(...args)
      closeSpy = jest.spyOn(descriptor, "close")
      jest.spyOn(descriptor, "sync").mockRejectedValueOnce(error)
      return descriptor
    })
    try {
      await expect(handle.flush()).rejects.toBe(error)
      expect(closeSpy).toHaveBeenCalledTimes(1)
      expect(fs.readFileSync(file, "utf8")).toBe(JSON.stringify([{ id: "original" }]))
      expect(fs.existsSync(`${file}.bak`)).toBe(false)
      openSpy.mockRestore()
      await handle.flush()
      expect(fs.readFileSync(file, "utf8")).toBe(JSON.stringify(goals.rows))
      expect(fs.readFileSync(`${file}.bak`, "utf8")).toBe(JSON.stringify([{ id: "original" }]))
      if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600)
      await handle.dispose()
    } finally {
      openSpy.mockRestore()
      __resetCliDbForTesting()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it("retries every dirty table after a later table replacement fails", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-cli-db-partial-"))
    const goals = new FakeTable("goals", [{ id: "g0" }])
    const sessions = new FakeTable("sessions", [{ id: "s0" }])
    const handle = await ensureCliDb({
      home,
      getDatabase: () => ({ name: "CogniaDB", verno: 82, tables: [goals, sessions] }),
      installGlobals: async () => {},
      whenReady: async () => {},
      schedule: () => () => {},
    })
    await handle.flush()
    const tableDir = path.join(home, "db.json.tables")
    const goalsFile = path.join(tableDir, "CogniaDB--goals.json")
    const sessionsFile = path.join(tableDir, "CogniaDB--sessions.json")
    goals.rows = [{ id: "g1" }]
    sessions.rows = [{ id: "s1" }]
    handle.scheduleFlush()
    const rename = fs.promises.rename.bind(fs.promises)
    const renameSpy = jest
      .spyOn(fs.promises, "rename")
      .mockImplementation(async (source, target) => {
        if (target === sessionsFile) throw new Error("replace failed")
        await rename(source, target)
      })
    try {
      await expect(handle.flush()).rejects.toThrow("replace failed")
      expect(JSON.parse(fs.readFileSync(goalsFile, "utf8"))).toEqual([{ id: "g1" }])
      expect(JSON.parse(fs.readFileSync(sessionsFile, "utf8"))).toEqual([{ id: "s0" }])
      renameSpy.mockRestore()
      goals.rows = [{ id: "g2" }]
      await handle.flush()
      expect(JSON.parse(fs.readFileSync(goalsFile, "utf8"))).toEqual([{ id: "g2" }])
      expect(JSON.parse(fs.readFileSync(sessionsFile, "utf8"))).toEqual([{ id: "s1" }])
      await handle.dispose()
    } finally {
      renameSpy.mockRestore()
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

  // No database seam at all: the production default. Drives the real `CogniaDB`
  // under fake-indexeddb. The schedule used to live in a second database and
  // needed its own source, and forgetting it rebooted a brain with an empty
  // schedule. Since schema v219 it is `scheduledTasks` inside the account
  // database, so the guard that matters now is that the SCHEDULE is snapshotted
  // and the RUN HISTORY is not.
  it("defaults to the real account database, with the scheduler exclusions applied", async () => {
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
      // One database now. The key is the live CogniaDB name, which is
      // per-account rather than hardcoded.
      expect(Object.keys(written.dbs)).toHaveLength(1)
      const [primary] = Object.values(written.dbs) as [{ tables: Record<string, unknown> }]
      expect(primary.tables).toHaveProperty("scheduledTasks")
      expect(primary.tables).not.toHaveProperty("scheduledTaskRuns")
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
        CogniaSchedulerDB: { version: 3, tables: { tasks: [{ id: "t1" }] } },
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

jest.mock("@/lib/plugin/core/browser-builtin-registry", () => ({
  getBrowserBuiltinRegistry: () => [
    { manifest: { id: "plugin-a", dexie: { tables: [{ name: "x", schema: "++id" }] } } },
    { manifest: { id: "plugin-b", dexie: { tables: [{ name: "y", schema: "&id" }] } } },
  ],
}))

jest.mock("@/lib/plugin/dexie/bridge", () => ({
  restorePluginTables: jest.fn(async () => [] as string[]),
}))

describe("built-in plugin schema preparation", () => {
  /**
   * The headless brain writes its snapshot at the version runtime registration
   * reached: base + one bump PER table-owning plugin. The consolidated restore
   * declares every one of those tables in a single bump, so without a floor it
   * opens below its own snapshot and `restoreTableStore` rejects it. That
   * rejection moves the manifest aside and the supervisor reboots the brain on
   * an empty database, which is silent, total data loss on every restart.
   */
  it("asks the restore to land on the version the snapshot was written at", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-cli-db-plugin-schema-"))
    const goals = new FakeTable("goals", [])
    const db: DbLike = { verno: 225, tables: [goals], name: "CogniaDB" }
    const tableDir = path.join(home, "db.json.tables")
    fs.mkdirSync(tableDir, { recursive: true })
    fs.writeFileSync(
      path.join(tableDir, "manifest.json"),
      JSON.stringify({
        snapshotFormat: 3,
        dbs: { CogniaDB: { version: 227, tables: ["goals"] } },
      })
    )
    fs.writeFileSync(path.join(tableDir, "CogniaDB--goals.json"), JSON.stringify([{ id: "kept" }]))

    const { restorePluginTables } = jest.requireMock("@/lib/plugin/dexie/bridge") as {
      restorePluginTables: jest.Mock
    }
    restorePluginTables.mockClear()
    // Stand in for the real bump: the restore raises the live version to the
    // floor it was given, which is what makes the snapshot restorable.
    restorePluginTables.mockImplementation(async (_source, _manifests, options) => {
      db.verno = options.minimumVersion
      return ["plugin-a:x", "plugin-b:y"]
    })

    try {
      await ensureCliDb({
        home,
        getDatabase: () => db,
        installGlobals: async () => {},
        whenReady: async () => {},
        schedule: () => () => {},
      })

      expect(restorePluginTables).toHaveBeenCalledTimes(1)
      expect(restorePluginTables.mock.calls[0][2]).toMatchObject({
        registerMissing: true,
        minimumVersion: 227,
      })
      // Restored rather than moved aside: the manifest is still where it was.
      expect(fs.existsSync(path.join(tableDir, "manifest.json"))).toBe(true)
      expect(goals.rows).toEqual([{ id: "kept" }])
    } finally {
      __resetCliDbForTesting()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})

it("points recovery at the most recently preserved snapshot without changing files", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-recovery-latest-"))
  const dir = path.join(home, "db.json.tables")
  fs.mkdirSync(dir)
  const old = path.join(dir, "manifest.json.incompatible-1")
  const latest = path.join(dir, "manifest.json.incompatible-70")
  fs.writeFileSync(old, "old")
  fs.writeFileSync(latest, "new")
  fs.utimesSync(old, 1, 1)
  fs.utimesSync(latest, 2, 2)
  try {
    const { opts } = makeOpts({ home, readSnapshot: undefined, writeSnapshot: undefined })
    await expect(ensureCliDb(opts)).rejects.toMatchObject({ preservedPath: latest })
    expect(fs.readFileSync(old, "utf8")).toBe("old")
    expect(fs.readFileSync(latest, "utf8")).toBe("new")
    expect(fs.existsSync(path.join(dir, "manifest.json"))).toBe(false)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

describe("schema moves, self-heal, and the store lock", () => {
  function realOpts(home: string, db: DbLike, over: Record<string, unknown> = {}) {
    return {
      home,
      getDatabase: () => db,
      installGlobals: jest.fn(async () => {}),
      whenReady: async () => {},
      schedule: () => () => {},
      ...over,
    }
  }

  function tableStoreDir(home: string) {
    return path.join(home, "db.json.tables")
  }

  function writeManifest(dir: string, manifest: unknown, name = "manifest.json") {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, name), JSON.stringify(manifest))
    return path.join(dir, name)
  }

  const v3 = (version: number, tables = ["goals"], writer?: unknown) => ({
    snapshotFormat: 3,
    dbs: { CogniaDB: { version, tables } },
    ...(writer !== undefined ? { writer } : {}),
  })

  it("restores an older manifest as a forward move and converges the store on flush", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-cli-db-forward-"))
    const dir = tableStoreDir(home)
    writeManifest(dir, v3(81))
    fs.writeFileSync(path.join(dir, "CogniaDB--goals.json"), JSON.stringify([{ id: "old" }]))
    const goals = new FakeTable("goals", [{ id: "seed" }])
    const db: DbLike = { verno: 82, name: "CogniaDB", tables: [goals] }
    try {
      const handle = await ensureCliDb(realOpts(home, db))
      expect(goals.rows).toEqual([{ id: "old" }])
      expect(fs.existsSync(`${dir}/manifest.json.incompatible-1`)).toBe(false)
      // The forward move marks every included table dirty, so the next flush
      // rewrites the manifest at the live schema version, with writer metadata.
      await handle.flush()
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"))
      expect(manifest.dbs.CogniaDB.version).toBe(82)
      expect(manifest.writer).toMatchObject({ pid: process.pid, host: os.hostname() })
      expect(typeof manifest.writer.cliVersion).toBe("string")
      expect(typeof manifest.writer.writtenAt).toBe("number")
      await handle.dispose()
    } finally {
      __resetCliDbForTesting()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it("quarantines a newer-build manifest and names its writer", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-cli-db-newer-"))
    const dir = tableStoreDir(home)
    const text = JSON.stringify(
      v3(83, ["goals"], {
        pid: 4242,
        host: "other-host",
        cliVersion: "9.9.9",
        writtenAt: 1_700_000_000_000,
      })
    )
    writeManifest(dir, JSON.parse(text))
    fs.writeFileSync(path.join(dir, "CogniaDB--goals.json"), "[]")
    const goals = new FakeTable("goals", [{ id: "seed" }])
    try {
      await expect(
        ensureCliDb(realOpts(home, { verno: 82, name: "CogniaDB", tables: [goals] }))
      ).rejects.toThrow(
        /snapshot schema version 83 is newer than database schema version 82.*written by cognia 9\.9\.9 pid 4242 on other-host at 2023-11-14T22:13:20\.000Z/
      )
      expect(goals.rows).toEqual([{ id: "seed" }])
      expect(fs.readFileSync(`${dir}/manifest.json.incompatible-1`, "utf8")).toBe(text)
    } finally {
      __resetCliDbForTesting()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it("adopts the newest preserved manifest generation when the canonical one is gone", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-cli-db-adopt-"))
    const dir = tableStoreDir(home)
    const preserved = writeManifest(dir, v3(81), "manifest.json.incompatible-1")
    fs.writeFileSync(path.join(dir, "CogniaDB--goals.json"), JSON.stringify([{ id: "healed" }]))
    const goals = new FakeTable("goals", [{ id: "seed" }])
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const handle = await ensureCliDb(
        realOpts(home, { verno: 82, name: "CogniaDB", tables: [goals] })
      )
      expect(goals.rows).toEqual([{ id: "healed" }])
      const manifestFile = path.join(dir, "manifest.json")
      expect(JSON.parse(fs.readFileSync(manifestFile, "utf8")).dbs.CogniaDB.version).toBe(81)
      expect(fs.existsSync(preserved)).toBe(false)
      expect(warn.mock.calls.flat().join(" ")).toContain(
        `Recovered database snapshot manifest from ${preserved} (schema 81 → 82)`
      )
      await handle.flush()
      expect(JSON.parse(fs.readFileSync(manifestFile, "utf8")).dbs.CogniaDB.version).toBe(82)
      await handle.dispose()
    } finally {
      warn.mockRestore()
      __resetCliDbForTesting()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it("refuses to adopt a generation written by a newer build", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-cli-db-adopt-newer-"))
    const dir = tableStoreDir(home)
    const preserved = writeManifest(dir, v3(83), "manifest.json.incompatible-1")
    fs.writeFileSync(path.join(dir, "CogniaDB--goals.json"), "[]")
    try {
      await expect(
        ensureCliDb(
          realOpts(home, {
            verno: 82,
            name: "CogniaDB",
            tables: [new FakeTable("goals")],
          })
        )
      ).rejects.toThrow(/requires recovery.*newer build \(schema 83 > 82/)
      expect(fs.existsSync(preserved)).toBe(true)
      expect(fs.existsSync(path.join(dir, "manifest.json"))).toBe(false)
    } finally {
      __resetCliDbForTesting()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it("refuses to adopt a generation whose listed table file is missing", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-cli-db-adopt-missing-"))
    const dir = tableStoreDir(home)
    const preserved = writeManifest(dir, v3(82), "manifest.json.corrupt-3")
    try {
      await expect(
        ensureCliDb(
          realOpts(home, {
            verno: 82,
            name: "CogniaDB",
            tables: [new FakeTable("goals")],
          })
        )
      ).rejects.toThrow(/requires recovery.*missing a readable table file for CogniaDB\.goals/)
      expect(fs.existsSync(preserved)).toBe(true)
      expect(fs.existsSync(path.join(dir, "manifest.json"))).toBe(false)
    } finally {
      __resetCliDbForTesting()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it("adopts by recency, not by generation number", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-cli-db-adopt-order-"))
    const dir = tableStoreDir(home)
    const invalid = writeManifest(dir, v3(81), "manifest.json.incompatible-2")
    const valid = writeManifest(dir, v3(81), "manifest.json.incompatible-10")
    fs.writeFileSync(invalid, "{ not a manifest")
    fs.writeFileSync(path.join(dir, "CogniaDB--goals.json"), "[]")
    // -10 is lexically higher but older; -2 (garbage) is the most recent.
    fs.utimesSync(valid, 1, 1)
    fs.utimesSync(invalid, 2, 2)
    const goals = new FakeTable("goals", [{ id: "seed" }])
    const db: DbLike = { verno: 82, name: "CogniaDB", tables: [goals] }
    try {
      await expect(ensureCliDb(realOpts(home, db))).rejects.toThrow(
        /requires recovery.*not a valid table manifest/
      )
      // Repair ordering: make the valid generation the newest → adoption.
      fs.utimesSync(valid, 3, 3)
      const handle = await ensureCliDb(realOpts(home, db))
      expect(fs.existsSync(path.join(dir, "manifest.json"))).toBe(true)
      expect(fs.existsSync(valid)).toBe(false)
      expect(fs.existsSync(invalid)).toBe(true) // older generations are left alone
      await handle.dispose()
    } finally {
      __resetCliDbForTesting()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it("restores a legacy single-file snapshot from an older version", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-cli-db-legacy-forward-"))
    const file = path.join(home, "db.json")
    fs.writeFileSync(file, JSON.stringify({ version: 81, tables: { goals: [{ id: "old" }] } }))
    const goals = new FakeTable("goals", [{ id: "seed" }])
    try {
      const handle = await ensureCliDb(
        realOpts(home, { verno: 82, name: "CogniaDB", tables: [goals] })
      )
      expect(goals.rows).toEqual([{ id: "old" }])
      expect(fs.existsSync(`${file}.incompatible-1`)).toBe(false)
      await handle.dispose()
    } finally {
      __resetCliDbForTesting()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  function writeHeldLock(home: string, over: Record<string, unknown> = {}) {
    const file = path.join(home, "db.json")
    fs.writeFileSync(
      `${file}.lock`,
      JSON.stringify({
        lockVersion: 1,
        pid: process.pid,
        host: os.hostname(),
        startedAt: new Date().toISOString(),
        token: "held-elsewhere",
        heartbeatAt: Date.now(),
        cliVersion: "9.9.9",
        ...over,
      })
    )
    return `${file}.lock`
  }

  it("follows read-only when another live process holds the store lock", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-cli-db-follower-"))
    const dir = tableStoreDir(home)
    writeManifest(dir, v3(82))
    fs.writeFileSync(path.join(dir, "CogniaDB--goals.json"), JSON.stringify([{ id: "kept" }]))
    const lockFile = writeHeldLock(home)
    const goals = new FakeTable("goals", [{ id: "seed" }])
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const handle = await ensureCliDb(
        realOpts(home, { verno: 82, name: "CogniaDB", tables: [goals] })
      )
      expect(handle.mode).toBe("read-only")
      expect(handle.heldBy).toMatchObject({ pid: process.pid, token: "held-elsewhere" })
      // Reads still restore.
      expect(goals.rows).toEqual([{ id: "kept" }])

      goals.rows = [{ id: "mutated" }]
      handle.scheduleFlush()
      handle.scheduleTableFlush("CogniaDB", "goals")
      await handle.flush()
      await handle.flush()
      // Warned exactly once across every no-op flush path.
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls.flat().join(" ")).toContain(`pid ${process.pid}`)
      expect(warn.mock.calls.flat().join(" ")).toContain("read-only")
      // Nothing was written and the holder's lock was left alone.
      expect(fs.existsSync(lockFile)).toBe(true)
      expect(
        JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")).writer
      ).toBeUndefined()
      await handle.dispose()
      expect(fs.existsSync(lockFile)).toBe(true)
    } finally {
      warn.mockRestore()
      __resetCliDbForTesting()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it("never quarantines a newer manifest in read-only mode", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-cli-db-follower-newer-"))
    const dir = tableStoreDir(home)
    writeManifest(dir, v3(83))
    fs.writeFileSync(path.join(dir, "CogniaDB--goals.json"), "[]")
    writeHeldLock(home)
    try {
      await expect(
        ensureCliDb(
          realOpts(home, {
            verno: 82,
            name: "CogniaDB",
            tables: [new FakeTable("goals")],
          })
        )
      ).rejects.toMatchObject({
        name: "CliDbSnapshotError",
        preservedPath: null,
      })
      expect(fs.existsSync(path.join(dir, "manifest.json"))).toBe(true)
      expect(fs.existsSync(`${dir}/manifest.json.incompatible-1`)).toBe(false)
    } finally {
      __resetCliDbForTesting()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it("reclaims a stale store lock and becomes the writer", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-cli-db-reclaim-"))
    const lockFile = writeHeldLock(home, {
      pid: 2_147_483_646, // dead on this host
      heartbeatAt: Date.now(),
    })
    const goals = new FakeTable("goals", [{ id: "seed" }])
    try {
      const handle = await ensureCliDb(
        realOpts(home, { verno: 82, name: "CogniaDB", tables: [goals] })
      )
      expect(handle.mode).toBe("writer")
      expect(handle.heldBy).toBeNull()
      expect(fs.existsSync(lockFile)).toBe(true)
      await handle.dispose()
      expect(fs.existsSync(lockFile)).toBe(false)
    } finally {
      __resetCliDbForTesting()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it("dispose releases its own lock but never a token-mismatched one", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-cli-db-release-"))
    const file = path.join(home, "db.json")
    const lockFile = `${file}.lock`
    const goals = new FakeTable("goals", [{ id: "seed" }])
    const db: DbLike = { verno: 82, name: "CogniaDB", tables: [goals] }
    try {
      const handle = await ensureCliDb(realOpts(home, db))
      expect(handle.mode).toBe("writer")
      // Simulate a takeover: another process replaced the lock record.
      fs.writeFileSync(
        lockFile,
        JSON.stringify({
          lockVersion: 1,
          pid: 999,
          host: "other",
          startedAt: new Date().toISOString(),
          token: "not-ours",
          heartbeatAt: Date.now(),
          cliVersion: "9.9.9",
        })
      )
      await handle.dispose()
      expect(JSON.parse(fs.readFileSync(lockFile, "utf8")).token).toBe("not-ours")

      fs.rmSync(lockFile)
      __resetCliDbForTesting()
      const again = await ensureCliDb(realOpts(home, db))
      expect(fs.existsSync(lockFile)).toBe(true)
      await again.dispose()
      expect(fs.existsSync(lockFile)).toBe(false)
    } finally {
      __resetCliDbForTesting()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it("drops to read-only for the rest of its life when the lock is lost mid-run", async () => {
    jest.useFakeTimers()
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-cli-db-locklost-"))
    const file = path.join(home, "db.json")
    const lockFile = `${file}.lock`
    const goals = new FakeTable("goals", [{ id: "seed" }])
    try {
      const handle = await ensureCliDb(
        realOpts(home, { verno: 82, name: "CogniaDB", tables: [goals] })
      )
      expect(handle.mode).toBe("writer")
      fs.rmSync(lockFile)
      jest.advanceTimersByTime(5_000)
      expect(handle.mode).toBe("read-only")
      expect(getRecentErrorLogs()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            module: "cli.db",
            message: expect.stringContaining("Lost the database store lock"),
          }),
        ])
      )
      goals.rows = [{ id: "mutated" }]
      handle.scheduleFlush()
      await handle.flush()
      expect(fs.existsSync(path.join(home, "db.json.tables", "CogniaDB--goals.json"))).toBe(false)
      await handle.dispose()
    } finally {
      jest.useRealTimers()
      __resetCliDbForTesting()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})

it("makes concurrent callers await restoration and receive its failure", async () => {
  let rejectReady!: (error: Error) => void
  const ready = new Promise<void>((_, reject) => {
    rejectReady = reject
  })
  const { opts } = makeOpts({ whenReady: () => ready })
  const first = ensureCliDb(opts)
  const second = ensureCliDb(opts)
  let resolved = false
  void second.then(
    () => {
      resolved = true
    },
    () => {}
  )
  await Promise.resolve()
  await Promise.resolve()
  expect(resolved).toBe(false)
  const failure = new Error("restore failed")
  rejectReady(failure)
  await expect(first).rejects.toBe(failure)
  await expect(second).rejects.toBe(failure)
})

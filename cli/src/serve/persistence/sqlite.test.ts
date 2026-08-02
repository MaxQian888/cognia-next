import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { assertIntegrity, asSqliteBackend, openSqliteBackend, sqliteFile } from "./sqlite"
import type { DurabilityCommit, DurabilityState } from "./types"

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cognia-sqlite-"))
}

function state(sequence = 0): DurabilityState {
  return {
    sequence,
    dbs: {
      CogniaDB: {
        schema: { version: 141, tables: ["sessions", "messages"] },
        rows: {
          sessions: { "s:a": { id: "a", title: "one" } },
          messages: { "n:+00000000000000000001": { id: 1, body: "hi" } },
        },
      },
    },
  }
}

function commit(sequence: number, key: string, value: unknown): DurabilityCommit {
  return {
    sequence,
    committedAt: sequence,
    mutations: [{ database: "CogniaDB", table: "sessions", key, value }],
  }
}

describe("openSqliteBackend", () => {
  let root: string
  beforeEach(() => {
    root = tempRoot()
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it("starts empty", async () => {
    const backend = openSqliteBackend({ root })
    expect(await backend.load()).toEqual({ sequence: 0, dbs: {} })
    expect(backend.id).toBe("sqlite-v5")
    await backend.close()
  })

  it("round-trips a full state through replaceAll", async () => {
    const backend = openSqliteBackend({ root })
    asSqliteBackend(backend)!.replaceAll(state(4))
    const loaded = await backend.load()
    await backend.close()
    expect(loaded.sequence).toBe(4)
    expect(loaded.dbs.CogniaDB.rows.sessions).toEqual({ "s:a": { id: "a", title: "one" } })
    expect(loaded.dbs.CogniaDB.schema.version).toBe(141)
  })

  it("persists across a reopen", async () => {
    const first = openSqliteBackend({ root })
    await first.compact(state(2))
    await first.close()

    const second = openSqliteBackend({ root })
    const loaded = await second.load()
    await second.close()
    expect(loaded.sequence).toBe(2)
    expect(Object.keys(loaded.dbs.CogniaDB.rows.messages)).toHaveLength(1)
  })

  it("applies writes and deletions from commits", async () => {
    const backend = openSqliteBackend({ root })
    await backend.compact(state(0))
    backend.commitSync(commit(1, "s:b", { id: "b" }))
    backend.commitSync(commit(2, "s:a", null))
    const loaded = await backend.load()
    await backend.close()
    expect(loaded.sequence).toBe(2)
    expect(loaded.dbs.CogniaDB.rows.sessions).toEqual({ "s:b": { id: "b" } })
  })

  it("treats an already-applied sequence as a no-op (dual-write redelivery)", async () => {
    const backend = openSqliteBackend({ root })
    await backend.compact(state(0))
    backend.commitSync(commit(1, "s:b", { id: "b" }))
    backend.commitSync(commit(1, "s:b", { id: "SHOULD-NOT-APPLY" }))
    const loaded = await backend.load()
    await backend.close()
    expect(loaded.dbs.CogniaDB.rows.sessions["s:b"]).toEqual({ id: "b" })
    expect(loaded.sequence).toBe(1)
  })

  it("rejects a sequence gap", async () => {
    const backend = openSqliteBackend({ root })
    await backend.compact(state(0))
    expect(() => backend.commitSync(commit(3, "s:c", 1))).toThrow(
      expect.objectContaining({ code: "journal-sequence-gap" })
    )
    await backend.close()
  })

  it("refuses commits after close", async () => {
    const backend = openSqliteBackend({ root })
    await backend.compact(state(0))
    await backend.close()
    expect(() => backend.commitSync(commit(1, "s:b", 1))).toThrow(/closed/)
  })

  it("creates the database file with restrictive permissions", async () => {
    const backend = openSqliteBackend({ root })
    await backend.close()
    if (process.platform === "win32") return
    expect(fs.statSync(sqliteFile(root)).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(sqliteFile(root))).mode & 0o777).toBe(0o700)
  })

  it("rolls the transaction back when a mutation fails mid-commit", async () => {
    const backend = openSqliteBackend({ root })
    await backend.compact(state(0))
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() =>
      backend.commitSync({
        sequence: 1,
        committedAt: 0,
        mutations: [
          { database: "CogniaDB", table: "sessions", key: "s:ok", value: { id: "ok" } },
          { database: "CogniaDB", table: "sessions", key: "s:bad", value: circular },
        ],
      })
    ).toThrow()
    const loaded = await backend.load()
    await backend.close()
    expect(loaded.sequence).toBe(0)
    expect(loaded.dbs.CogniaDB.rows.sessions["s:ok"]).toBeUndefined()
  })

  it("rolls back a failed replaceAll and leaves the previous content intact", async () => {
    const backend = openSqliteBackend({ root })
    await backend.compact(state(1))
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const broken = state(2)
    broken.dbs.CogniaDB.rows.sessions = { "s:bad": circular }
    expect(() => asSqliteBackend(backend)!.replaceAll(broken)).toThrow()
    const loaded = await backend.load()
    await backend.close()
    expect(loaded.sequence).toBe(1)
    expect(loaded.dbs.CogniaDB.rows.sessions).toEqual(state(1).dbs.CogniaDB.rows.sessions)
  })

  it("exposes an async commit wrapper for tooling", async () => {
    const backend = openSqliteBackend({ root })
    await backend.compact(state(0))
    await backend.commit(commit(1, "s:z", { id: "z" }))
    expect(backend.lastSequence()).toBe(1)
    await backend.close()
  })

  it("truncates the WAL on compact and stays readable", async () => {
    const backend = openSqliteBackend({ root })
    await backend.compact(state(3))
    const loaded = await backend.load()
    await backend.close()
    expect(loaded.sequence).toBe(3)
  })

  it("closes idempotently", async () => {
    const backend = openSqliteBackend({ root })
    await backend.close()
    await expect(backend.close()).resolves.toBeUndefined()
  })
})

/** A `node:sqlite` stand-in that answers the backend's fixed statement set. */
function fakeDb(opts: {
  schemas?: Array<Record<string, unknown>>
  rows?: Array<Record<string, unknown>>
}): import("./sqlite").SqliteDatabaseLike {
  return {
    exec: () => {},
    close: () => {},
    prepare(sql: string) {
      return {
        run: () => {},
        get: () => undefined,
        all: () => {
          if (sql.includes("integrity_check")) return [{ integrity_check: "ok" }]
          if (sql.includes("FROM durability_schema")) return opts.schemas ?? []
          if (sql.includes("FROM durability_rows")) return opts.rows ?? []
          return []
        },
      }
    },
  }
}

describe("sqlite corruption", () => {
  const root = "/unused-because-open-is-injected"

  it("faults when a stored row value is not readable JSON", async () => {
    const backend = openSqliteBackend({
      root,
      open: () =>
        fakeDb({
          schemas: [{ database: "CogniaDB", version: 141, tables: '["sessions"]' }],
          rows: [{ database: "CogniaDB", table_name: "sessions", row_key: "s:a", value: "{oops" }],
        }),
    })
    await expect(backend.load()).rejects.toThrow(
      expect.objectContaining({ code: "sqlite-integrity-failure" })
    )
  })

  it("faults when a schema row holds an unreadable table list", async () => {
    const backend = openSqliteBackend({
      root,
      open: () => fakeDb({ schemas: [{ database: "CogniaDB", version: 141, tables: "{oops" }] }),
    })
    await expect(backend.load()).rejects.toThrow(/unreadable table list/)
  })

  it("ignores rows addressed at a database with no schema row", async () => {
    const backend = openSqliteBackend({
      root,
      open: () =>
        fakeDb({
          schemas: [],
          rows: [{ database: "Gone", table_name: "sessions", row_key: "s:a", value: "1" }],
        }),
    })
    await expect(backend.load()).resolves.toEqual({ sequence: 0, dbs: {} })
  })
})

describe("assertIntegrity", () => {
  it("passes on an ok verdict", () => {
    const db = {
      exec: () => {},
      prepare: () => ({
        run: () => {},
        get: () => undefined,
        all: () => [{ integrity_check: "ok" }],
      }),
      close: () => {},
    }
    expect(() => assertIntegrity(db)).not.toThrow()
  })

  it("faults on any other verdict", () => {
    const db = {
      exec: () => {},
      prepare: () => ({
        run: () => {},
        get: () => undefined,
        all: () => [{ integrity_check: "row 3 missing from index" }],
      }),
      close: () => {},
    }
    expect(() => assertIntegrity(db)).toThrow(
      expect.objectContaining({ code: "sqlite-integrity-failure" })
    )
  })

  it("faults when the pragma returns nothing", () => {
    const db = {
      exec: () => {},
      prepare: () => ({ run: () => {}, get: () => undefined, all: () => [] }),
      close: () => {},
    }
    expect(() => assertIntegrity(db)).toThrow(/no result/)
  })
})

describe("asSqliteBackend", () => {
  it("narrows only the sqlite backend", async () => {
    const root = tempRoot()
    try {
      const backend = openSqliteBackend({ root })
      expect(asSqliteBackend(backend)).not.toBeNull()
      await backend.close()
      expect(asSqliteBackend({ ...backend, id: "journal-v4" })).toBeNull()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

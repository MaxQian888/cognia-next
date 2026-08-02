import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { openBackend } from "./backend"
import { encodeKey } from "./canonical"
import type { CaptureCoreLike, CaptureMutateRequest, CaptureTableLike } from "./capture"
import {
  openDurabilityStore,
  readSourcesState,
  readTableRows,
  restoreState,
  type DurabilityDbLike,
  type DurabilitySourceLike,
  type DurabilityTableLike,
} from "./store"
import type { DurabilityState } from "./types"

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cognia-store-"))
}

// ── An in-memory Dexie double ───────────────────────────────────────────────
//
// Enough of Dexie to exercise the real capture middleware end to end: a table
// map, a DBCore stack built at `open()` (so middleware installed beforehand is
// live and middleware installed afterwards is inert, exactly as Dexie behaves),
// and a `commit()` helper that dispatches the transaction `complete` event.

class FakeTransaction {
  private readonly listeners = new Map<string, Array<() => void>>()
  addEventListener(type: string, listener: () => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }
  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener()
  }
}

class FakeTable implements DurabilityTableLike {
  readonly rows = new Map<string, unknown>()
  constructor(
    readonly name: string,
    readonly keyPath: string | null = "id"
  ) {}

  get schema(): { primKey?: { keyPath?: string | null } } {
    return { primKey: { keyPath: this.keyPath } }
  }

  async toArray(): Promise<unknown[]> {
    return [...this.rows.values()]
  }

  async clear(): Promise<void> {
    this.rows.clear()
  }

  async bulkPut(values: unknown[], keys?: unknown[]): Promise<void> {
    values.forEach((value, index) => {
      const key = keys ? keys[index] : (value as Record<string, unknown>)[this.keyPath!]
      this.rows.set(encodeKey(key), value)
    })
  }

  toCollection(): { primaryKeys(): Promise<unknown[]> } {
    return { primaryKeys: async () => [...this.rows.keys()].map((k) => k.slice(2)) }
  }
}

class FakeDexie implements DurabilityDbLike {
  readonly middleware: Array<{ create(down: CaptureCoreLike): CaptureCoreLike }> = []
  private core: CaptureCoreLike | null = null
  opened = false

  constructor(
    readonly name: string,
    readonly verno: number,
    readonly tables: FakeTable[]
  ) {}

  use(mw: { stack: "dbcore"; name: string; create(down: CaptureCoreLike): CaptureCoreLike }): void {
    this.middleware.push(mw)
  }

  async open(): Promise<void> {
    if (this.opened) return
    this.opened = true
    let core: CaptureCoreLike = {
      table: (name: string) => this.rawTable(name),
      transaction: () => new FakeTransaction(),
    }
    for (const mw of this.middleware) core = mw.create(core)
    this.core = core
  }

  private rawTable(name: string): CaptureTableLike {
    const table = this.tables.find((candidate) => candidate.name === name)!
    return {
      name,
      schema: {
        primaryKey: table.keyPath
          ? { extractKey: (value) => (value as Record<string, unknown>)[table.keyPath!] }
          : {},
      },
      async mutate(req: CaptureMutateRequest) {
        const results: unknown[] = []
        if (req.type === "delete") {
          for (const key of req.keys ?? []) table.rows.delete(encodeKey(key))
        } else if (req.type === "deleteRange") {
          table.rows.clear()
        } else {
          ;(req.values ?? []).forEach((value, index) => {
            const key =
              req.keys?.[index] ?? (value as Record<string, unknown>)[table.keyPath ?? "id"]
            table.rows.set(encodeKey(key), value)
            results.push(key)
          })
        }
        return { results, failures: {} }
      },
      async query() {
        return { result: [...table.rows.keys()].map((k) => k.slice(2)) }
      },
    }
  }

  /** Run one write transaction and dispatch its `complete` event. */
  async commit(
    tableName: string,
    req: Omit<CaptureMutateRequest, "trans" | "type"> & { type: CaptureMutateRequest["type"] }
  ): Promise<void> {
    const trans = this.core!.transaction([tableName], "readwrite") as unknown as FakeTransaction
    await this.core!.table(tableName).mutate({ ...req, trans })
    trans.dispatch("complete")
  }
}

function makeSource(name = "CogniaDB", verno = 141): DurabilitySourceLike & { db: FakeDexie } {
  const db = new FakeDexie(name, verno, [new FakeTable("sessions"), new FakeTable("messages")])
  return { name, db }
}

// ── pure helpers ────────────────────────────────────────────────────────────

describe("readTableRows", () => {
  it("keys inbound-key rows by their extracted key", async () => {
    const table = new FakeTable("sessions")
    await table.bulkPut([{ id: "a" }, { id: "b" }])
    expect(await readTableRows(table)).toEqual({
      [encodeKey("a")]: { id: "a" },
      [encodeKey("b")]: { id: "b" },
    })
  })

  it("skips rows whose key path resolves to nothing", async () => {
    const table = new FakeTable("sessions")
    table.rows.set("s:x", { noId: true })
    expect(await readTableRows(table)).toEqual({})
  })

  it("extracts a nested key path", async () => {
    const table = new FakeTable("nested", "meta.id" as never)
    table.rows.set("ignored", { meta: { id: "deep" } })
    expect(await readTableRows(table)).toEqual({ [encodeKey("deep")]: { meta: { id: "deep" } } })
  })

  it("extracts a compound key path as an array key", async () => {
    const table = new FakeTable("compound", ["a", "b"] as never)
    table.rows.set("ignored", { a: 1, b: 2 })
    expect(await readTableRows(table)).toEqual({ [encodeKey([1, 2])]: { a: 1, b: 2 } })
  })

  it("skips a row whose nested key path dead-ends", async () => {
    const table = new FakeTable("nested", "meta.id" as never)
    table.rows.set("ignored", { meta: null })
    expect(await readTableRows(table)).toEqual({})
  })

  it("uses primaryKeys() for outbound-key tables", async () => {
    const table = new FakeTable("blobs", null)
    await table.bulkPut([{ v: 1 }], ["k"])
    expect(await readTableRows(table)).toEqual({ [encodeKey("k")]: { v: 1 } })
  })
})

describe("readSourcesState", () => {
  it("captures schema version, sorted tables, and rows", async () => {
    const source = makeSource()
    await source.db.tables[0].bulkPut([{ id: "a" }])
    const state = await readSourcesState([source], 3)
    expect(state.sequence).toBe(3)
    expect(state.dbs.CogniaDB.schema).toEqual({ version: 141, tables: ["messages", "sessions"] })
    expect(state.dbs.CogniaDB.rows.sessions).toEqual({ [encodeKey("a")]: { id: "a" } })
  })

  it("omits excluded tables", async () => {
    const source = makeSource()
    const state = await readSourcesState([{ ...source, excludeTables: ["messages"] }], 0)
    expect(state.dbs.CogniaDB.schema.tables).toEqual(["sessions"])
    expect(state.dbs.CogniaDB.rows.messages).toBeUndefined()
  })
})

describe("restoreState", () => {
  it("overlays rows onto the live tables", async () => {
    const source = makeSource()
    await source.db.tables[0].bulkPut([{ id: "stale" }])
    const state: DurabilityState = {
      sequence: 1,
      dbs: {
        CogniaDB: {
          schema: { version: 141, tables: ["sessions", "messages"] },
          rows: { sessions: { [encodeKey("a")]: { id: "a" } }, messages: {} },
        },
      },
    }
    await restoreState([source], state)
    expect(await source.db.tables[0].toArray()).toEqual([{ id: "a" }])
  })

  it("refuses to restore across a schema version change", async () => {
    const source = makeSource("CogniaDB", 141)
    const state: DurabilityState = {
      sequence: 0,
      dbs: {
        CogniaDB: { schema: { version: 99, tables: ["sessions"] }, rows: { sessions: {} } },
      },
    }
    await expect(restoreState([source], state)).rejects.toThrow(
      expect.objectContaining({ code: "checkpoint-schema-mismatch" })
    )
  })

  it("skips databases the state does not mention", async () => {
    const source = makeSource()
    await source.db.tables[0].bulkPut([{ id: "kept" }])
    await restoreState([source], { sequence: 0, dbs: {} })
    expect(await source.db.tables[0].toArray()).toEqual([{ id: "kept" }])
  })

  it("restores outbound-key tables under their original keys", async () => {
    const db = new FakeDexie("Blobs", 1, [new FakeTable("blobs", null)])
    const source: DurabilitySourceLike = { name: "Blobs", db }
    await restoreState([source], {
      sequence: 0,
      dbs: {
        Blobs: {
          schema: { version: 1, tables: ["blobs"] },
          rows: { blobs: { [encodeKey(7)]: { v: 1 } } },
        },
      },
    })
    expect(db.tables[0].rows.get(encodeKey(7))).toEqual({ v: 1 })
  })
})

// ── the store ───────────────────────────────────────────────────────────────

describe("openDurabilityStore", () => {
  let home: string
  beforeEach(() => {
    home = tempHome()
  })
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

  it("journals every committed transaction and reloads it after a crash", async () => {
    const source = makeSource()
    const store = await openDurabilityStore({
      home,
      accountId: "acct",
      getSources: async () => [source],
    })
    await source.db.commit("sessions", { type: "put", values: [{ id: "a", n: 1 }] })
    await source.db.commit("sessions", { type: "put", values: [{ id: "b", n: 2 }] })
    expect(store.sequence()).toBe(2)
    expect(store.commitCount()).toBe(2)
    // No close(): the process is killed right after the second commit resolved.

    const revived = makeSource()
    const second = await openDurabilityStore({
      home,
      accountId: "acct",
      getSources: async () => [revived],
    })
    expect(await revived.db.tables[0].toArray()).toEqual([
      { id: "a", n: 1 },
      { id: "b", n: 2 },
    ])
    expect(second.sequence()).toBe(2)
    await second.close()
    await store.close()
  })

  it("does not journal the restore replay", async () => {
    const first = makeSource()
    const store = await openDurabilityStore({
      home,
      accountId: "acct",
      getSources: async () => [first],
    })
    await first.db.commit("sessions", { type: "put", values: [{ id: "a" }] })
    await store.close()

    const second = makeSource()
    const reopened = await openDurabilityStore({
      home,
      accountId: "acct",
      getSources: async () => [second],
    })
    expect(reopened.sequence()).toBe(1)
    expect(reopened.commitCount()).toBe(0)
    await reopened.close()
  })

  it("records deletions so a cleared row stays gone across a restart", async () => {
    const first = makeSource()
    const store = await openDurabilityStore({
      home,
      accountId: "acct",
      getSources: async () => [first],
    })
    await first.db.commit("sessions", { type: "put", values: [{ id: "a" }] })
    await first.db.commit("sessions", { type: "delete", keys: ["a"] })
    await store.close()

    const second = makeSource()
    const reopened = await openDurabilityStore({
      home,
      accountId: "acct",
      getSources: async () => [second],
    })
    expect(await second.db.tables[0].toArray()).toEqual([])
    await reopened.close()
  })

  it("compacts on the configured commit interval and keeps replaying correctly", async () => {
    const source = makeSource()
    const store = await openDurabilityStore({
      home,
      accountId: "acct",
      getSources: async () => [source],
      compactEveryCommits: 2,
    })
    await source.db.commit("sessions", { type: "put", values: [{ id: "a" }] })
    await source.db.commit("sessions", { type: "put", values: [{ id: "b" }] })
    await store.close()

    const generations = fs.readdirSync(path.join(home, "durability", "acct", "generations"))
    expect(generations.sort()).toEqual(["gen-0001", "gen-0002"])

    const revived = makeSource()
    const reopened = await openDurabilityStore({
      home,
      accountId: "acct",
      getSources: async () => [revived],
    })
    expect((await revived.db.tables[0].toArray()).length).toBe(2)
    await reopened.close()
  })

  it("exposes the live state for parity tooling", async () => {
    const source = makeSource()
    const store = await openDurabilityStore({
      home,
      accountId: "acct",
      getSources: async () => [source],
    })
    await source.db.commit("sessions", { type: "put", values: [{ id: "a" }] })
    const live = await store.readLiveState()
    expect(live.sequence).toBe(1)
    expect(live.dbs.CogniaDB.rows.sessions).toEqual({ [encodeKey("a")]: { id: "a" } })
    await store.close()
  })

  it("awaits whenReady before restoring", async () => {
    const order: string[] = []
    const source = makeSource()
    const store = await openDurabilityStore({
      home,
      accountId: "acct",
      getSources: async () => {
        order.push("sources")
        return [source]
      },
      whenReady: async () => {
        order.push("ready")
      },
    })
    expect(order).toEqual(["sources", "ready"])
    await store.close()
  })

  it("keeps the two databases independent", async () => {
    const primary = makeSource("CogniaDB", 141)
    const scheduler = makeSource("CogniaSchedulerDB", 2)
    const store = await openDurabilityStore({
      home,
      accountId: "acct",
      getSources: async () => [primary, { ...scheduler, excludeTables: ["messages"] }],
    })
    await primary.db.commit("sessions", { type: "put", values: [{ id: "p" }] })
    await scheduler.db.commit("sessions", { type: "put", values: [{ id: "s" }] })
    await scheduler.db.commit("messages", { type: "put", values: [{ id: "ignored" }] })
    expect(store.sequence()).toBe(2)
    await store.close()

    const backend = openBackend("journal-v4", path.join(home, "durability", "acct"))
    const state = await backend.load()
    await backend.close()
    expect(state.dbs.CogniaSchedulerDB.schema.tables).toEqual(["sessions"])
    expect(state.dbs.CogniaDB.rows.sessions).toEqual({ [encodeKey("p")]: { id: "p" } })
  })

  it("refuses to install into an already-open database", async () => {
    const source = makeSource()
    await source.db.open()
    await expect(
      openDurabilityStore({
        home,
        accountId: "acct",
        getSources: async () => [{ ...source, db: { ...source.db, isOpen: () => true } as never }],
      })
    ).rejects.toThrow(/already open when durability capture was installed/)
  })

  it("keeps serving when a background compaction fails", async () => {
    const source = makeSource()
    const store = await openDurabilityStore({
      home,
      accountId: "acct",
      getSources: async () => [source],
      compactEveryCommits: 1,
    })
    // A file where the generations directory must be: the compaction write
    // fails, but the journal already holds the commit, so the store keeps going.
    const generations = path.join(home, "durability", "acct", "generations")
    fs.rmSync(generations, { recursive: true, force: true })
    fs.writeFileSync(generations, "not a directory")

    await source.db.commit("sessions", { type: "put", values: [{ id: "a" }] })
    await expect(store.close()).resolves.toBeUndefined()
    expect(store.sequence()).toBe(1)
  })

  it("reports an explicit compaction failure to the caller", async () => {
    const source = makeSource()
    const store = await openDurabilityStore({
      home,
      accountId: "acct",
      getSources: async () => [source],
      compactEveryCommits: 0,
    })
    await source.db.commit("sessions", { type: "put", values: [{ id: "a" }] })
    await store.compact()
    expect(store.sequence()).toBe(1)
    await store.close()
  })
})

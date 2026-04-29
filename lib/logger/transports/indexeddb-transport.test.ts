/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { IDBFactory } from "fake-indexeddb"
import { IndexedDBTransport } from "./indexeddb-transport"
import type { StructuredLogEntry } from "../types"

function makeEntry(
  id: string,
  level: StructuredLogEntry["level"],
  overrides: Partial<StructuredLogEntry> = {}
): StructuredLogEntry {
  return {
    id,
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    level,
    message: `entry ${id}`,
    module: "test",
    runtime: "browser",
    origin: "frontend",
    ...overrides,
  }
}

async function flushAndAwait(transport: IndexedDBTransport): Promise<void> {
  // Force any pending init to complete so the upcoming flush can see this.db.
  await transport.getLogs()
  await transport.flush()
}

beforeEach(() => {
  // Each test gets a fresh in-memory IDB factory so connections from the
  // previous test can't block this one and rows don't bleed across cases.
  // The transport's `init()` reads `window.indexedDB`, so we set both
  // window AND globalThis to the new factory.
  const factory = new IDBFactory()
  ;(globalThis as { indexedDB: IDBFactory }).indexedDB = factory
  ;(window as unknown as { indexedDB: IDBFactory }).indexedDB = factory
})

async function awaitInit(transport: IndexedDBTransport): Promise<void> {
  // Give the constructor's eager `init()` a chance to settle before the
  // tests start logging. The transport doesn't expose initPromise, but the
  // first `getLogs()` call awaits it internally — we piggyback on that.
  await transport.getLogs()
}

describe("IndexedDBTransport persistence", () => {
  it("buffers logs and flushes them to IndexedDB", async () => {
    const transport = new IndexedDBTransport({ bufferSize: 10, flushInterval: 60_000 })
    transport.log(makeEntry("a", "info"))
    transport.log(makeEntry("b", "warn"))
    await flushAndAwait(transport)
    const logs = await transport.getLogs()
    expect(logs.map((e) => e.id).sort()).toEqual(["a", "b"])
    await transport.close()
  })

  it("auto-flushes once the buffer hits its size threshold", async () => {
    const transport = new IndexedDBTransport({ bufferSize: 2, flushInterval: 60_000 })
    // Wait for init to settle before the first log(), otherwise the
    // synchronous auto-flush inside log() races against the open request.
    await awaitInit(transport)
    transport.log(makeEntry("a", "info"))
    transport.log(makeEntry("b", "info")) // hits bufferSize → triggers flush()
    // Let the IDB transaction created by the auto-flush settle.
    await new Promise((r) => setTimeout(r, 20))
    const logs = await transport.getLogs()
    expect(logs.length).toBe(2)
    await transport.close()
  })
})

describe("IndexedDBTransport.getLogs filtering", () => {
  it("filters by level (>= filter level)", async () => {
    const transport = new IndexedDBTransport({ bufferSize: 50, flushInterval: 60_000 })
    transport.log(makeEntry("d", "debug"))
    transport.log(makeEntry("i", "info"))
    transport.log(makeEntry("w", "warn"))
    transport.log(makeEntry("e", "error"))
    await flushAndAwait(transport)
    const warnPlus = await transport.getLogs({ level: "warn" })
    expect(warnPlus.map((l) => l.id).sort()).toEqual(["e", "w"])
    await transport.close()
  })

  it("filters by module + traceId", async () => {
    const transport = new IndexedDBTransport({ bufferSize: 50, flushInterval: 60_000 })
    transport.log(makeEntry("a", "info", { module: "auth", traceId: "t1" }))
    transport.log(makeEntry("b", "info", { module: "auth", traceId: "t2" }))
    transport.log(makeEntry("c", "info", { module: "ui", traceId: "t1" }))
    await flushAndAwait(transport)
    const auth = await transport.getLogs({ module: "auth" })
    expect(auth.map((l) => l.id).sort()).toEqual(["a", "b"])
    const t1 = await transport.getLogs({ traceId: "t1" })
    expect(t1.map((l) => l.id).sort()).toEqual(["a", "c"])
    await transport.close()
  })

  it("filters by message search (case-insensitive)", async () => {
    const transport = new IndexedDBTransport({ bufferSize: 50, flushInterval: 60_000 })
    transport.log(makeEntry("a", "info", { message: "Connection established" }))
    transport.log(makeEntry("b", "info", { message: "Lost connection" }))
    transport.log(makeEntry("c", "info", { message: "Heartbeat ok" }))
    await flushAndAwait(transport)
    const result = await transport.getLogs({ search: "connection" })
    expect(result.map((l) => l.id).sort()).toEqual(["a", "b"])
    await transport.close()
  })

  it("filters by since / until window via the timestamp index", async () => {
    const transport = new IndexedDBTransport({ bufferSize: 50, flushInterval: 60_000 })
    const old = "2024-01-01T00:00:00.000Z"
    const mid = "2025-06-01T00:00:00.000Z"
    const recent = "2026-04-29T00:00:00.000Z"
    transport.log(makeEntry("old", "info", { timestamp: old }))
    transport.log(makeEntry("mid", "info", { timestamp: mid }))
    transport.log(makeEntry("new", "info", { timestamp: recent }))
    await flushAndAwait(transport)

    const since2025 = await transport.getLogs({ since: new Date("2025-01-01T00:00:00Z") })
    expect(since2025.map((l) => l.id).sort()).toEqual(["mid", "new"])

    const window = await transport.getLogs({
      since: new Date("2025-01-01T00:00:00Z"),
      until: new Date("2026-01-01T00:00:00Z"),
    })
    expect(window.map((l) => l.id)).toEqual(["mid"])
    await transport.close()
  })

  it("filters by tags (any-match semantics)", async () => {
    const transport = new IndexedDBTransport({ bufferSize: 50, flushInterval: 60_000 })
    transport.log(makeEntry("a", "info", { tags: ["native", "tauri"] }))
    transport.log(makeEntry("b", "info", { tags: ["frontend"] }))
    transport.log(makeEntry("c", "info"))
    await flushAndAwait(transport)
    const native = await transport.getLogs({ tags: ["native"] })
    expect(native.map((l) => l.id)).toEqual(["a"])
    await transport.close()
  })

  it("respects the limit argument while reading newest-first", async () => {
    const transport = new IndexedDBTransport({ bufferSize: 50, flushInterval: 60_000 })
    for (let i = 0; i < 5; i++) {
      transport.log(
        makeEntry(`e${i}`, "info", {
          timestamp: new Date(2026, 0, i + 1).toISOString(),
        })
      )
    }
    await flushAndAwait(transport)
    const top2 = await transport.getLogs({ limit: 2 })
    expect(top2.map((l) => l.id)).toEqual(["e4", "e3"])
    await transport.close()
  })
})

describe("IndexedDBTransport.getStats", () => {
  it("aggregates totals, level + module breakdown, and oldest/newest timestamps", async () => {
    const transport = new IndexedDBTransport({ bufferSize: 50, flushInterval: 60_000 })
    transport.log(makeEntry("a", "info", { module: "auth", timestamp: "2026-01-01T00:00:00Z" }))
    transport.log(makeEntry("b", "warn", { module: "auth", timestamp: "2026-02-01T00:00:00Z" }))
    transport.log(makeEntry("c", "error", { module: "ui", timestamp: "2026-03-01T00:00:00Z" }))
    await flushAndAwait(transport)
    const stats = await transport.getStats()
    expect(stats.total).toBe(3)
    expect(stats.byLevel).toMatchObject({ info: 1, warn: 1, error: 1 })
    expect(stats.byModule).toEqual({ auth: 2, ui: 1 })
    expect(stats.oldestEntry?.toISOString()).toBe("2026-01-01T00:00:00.000Z")
    expect(stats.newestEntry?.toISOString()).toBe("2026-03-01T00:00:00.000Z")
    await transport.close()
  })
})

describe("IndexedDBTransport.clear / deleteEntries / export", () => {
  it("clear() removes all rows", async () => {
    const transport = new IndexedDBTransport({ bufferSize: 50, flushInterval: 60_000 })
    transport.log(makeEntry("a", "info"))
    transport.log(makeEntry("b", "info"))
    await flushAndAwait(transport)
    expect((await transport.getLogs()).length).toBe(2)
    await transport.clear()
    expect((await transport.getLogs()).length).toBe(0)
    await transport.close()
  })

  it("deleteEntries() removes only the listed ids", async () => {
    const transport = new IndexedDBTransport({ bufferSize: 50, flushInterval: 60_000 })
    transport.log(makeEntry("a", "info"))
    transport.log(makeEntry("b", "info"))
    transport.log(makeEntry("c", "info"))
    await flushAndAwait(transport)
    await transport.deleteEntries(["a", "c"])
    expect((await transport.getLogs()).map((l) => l.id)).toEqual(["b"])
    await transport.close()
  })

  it("export() returns valid JSON of the filtered rows", async () => {
    const transport = new IndexedDBTransport({ bufferSize: 50, flushInterval: 60_000 })
    transport.log(makeEntry("a", "warn"))
    transport.log(makeEntry("b", "info"))
    await flushAndAwait(transport)
    const json = await transport.export({ level: "warn" })
    const parsed = JSON.parse(json) as StructuredLogEntry[]
    expect(parsed.map((l) => l.id)).toEqual(["a"])
    await transport.close()
  })
})

describe("IndexedDBTransport.updateOptions", () => {
  it("merges updates without re-creating the DB", async () => {
    const transport = new IndexedDBTransport({ bufferSize: 50, flushInterval: 60_000 })
    transport.updateOptions({ maxEntries: 5, retentionDays: 1 })
    transport.log(makeEntry("a", "info"))
    await flushAndAwait(transport)
    const logs = await transport.getLogs()
    expect(logs.length).toBe(1)
    await transport.close()
  })
})

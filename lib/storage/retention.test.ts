import {
  pruneRetainedTables,
  startStorageRetentionSweeper,
  RETENTION_TARGETS,
  RETENTION_SWEEP_INTERVAL_MS,
  type RetentionTarget,
} from "./retention"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { saveSettings, getSettings } from "@/lib/db/settings"

// Wrap getSettings so one test can force the read to reject; every other call
// falls through to the real implementation (which reads the saved row).
jest.mock("@/lib/db/settings", () => {
  const actual = jest.requireActual("@/lib/db/settings")
  return { __esModule: true, ...actual, getSettings: jest.fn(actual.getSettings) }
})

const MS_PER_DAY = 86_400_000

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await getDb().agentTraces.clear()
})

function span(id: string, startTime: number) {
  return {
    id,
    spanId: id,
    sessionId: "s1",
    traceId: "t1",
    providerName: "test",
    startTime,
    operationName: "noop",
    surface: "chat",
  } as unknown as import("@/types/agent-trace/span").AgentTraceSpan
}

afterAll(dbFixture.dispose)

describe("pruneRetainedTables", () => {
  it("short-circuits without touching targets for days <= 0", async () => {
    const prune = jest.fn(async () => 5)
    expect(await pruneRetainedTables(0, [{ id: "x", prune }])).toEqual([])
    expect(await pruneRetainedTables(-3, [{ id: "x", prune }])).toEqual([])
    expect(prune).not.toHaveBeenCalled()
  })

  it("short-circuits for non-finite days", async () => {
    const prune = jest.fn(async () => 1)
    expect(await pruneRetainedTables(Number.NaN, [{ id: "x", prune }])).toEqual([])
    expect(prune).not.toHaveBeenCalled()
  })

  it("still deletes independently expired rows when trace retention is keep-forever", async () => {
    const windowPrune = jest.fn(async () => 1)
    const expiryPrune = jest.fn(async () => 2)

    await expect(
      pruneRetainedTables(0, [
        { id: "window", policy: "configured-window", prune: windowPrune },
        { id: "expiry", policy: "row-expiry", prune: expiryPrune },
      ])
    ).resolves.toEqual([{ id: "expiry", removed: 2 }])
    expect(windowPrune).not.toHaveBeenCalled()
    expect(expiryPrune).toHaveBeenCalledTimes(1)
  })

  it("passes a cutoff of now - days and aggregates removed counts", async () => {
    let seenCutoff = 0
    const targets: RetentionTarget[] = [
      {
        id: "a",
        prune: async (cutoff) => {
          seenCutoff = cutoff
          return 2
        },
      },
      { id: "b", prune: async () => 3 },
    ]
    const before = Date.now()
    const out = await pruneRetainedTables(7, targets)
    const after = Date.now()
    expect(out).toEqual([
      { id: "a", removed: 2 },
      { id: "b", removed: 3 },
    ])
    expect(seenCutoff).toBeGreaterThanOrEqual(before - 7 * MS_PER_DAY)
    expect(seenCutoff).toBeLessThanOrEqual(after - 7 * MS_PER_DAY)
  })

  it("isolates a failing target — logs and reports removed 0, others continue", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    const targets: RetentionTarget[] = [
      { id: "bad", prune: async () => Promise.reject(new Error("boom")) },
      { id: "good", prune: async () => 4 },
    ]
    const out = await pruneRetainedTables(1, targets)
    expect(out).toEqual([
      { id: "bad", removed: 0 },
      { id: "good", removed: 4 },
    ])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it("prunes real agentTraces spans older than the window via the default targets", async () => {
    const now = Date.now()
    await getDb().agentTraces.bulkPut([
      span("old", now - 40 * MS_PER_DAY),
      span("fresh", now - 1 * MS_PER_DAY),
    ])
    const out = await pruneRetainedTables(30)
    expect(out).toEqual([
      { id: "agentTraces", removed: 1 },
      { id: "evalArtifacts", removed: 0 },
    ])
    expect((await getDb().agentTraces.toArray()).map((r) => r.id)).toEqual(["fresh"])
  })

  it("exposes agentTraces as a default target", () => {
    expect(RETENTION_TARGETS.map((t) => t.id)).toContain("agentTraces")
    expect(RETENTION_TARGETS.map((t) => t.id)).toContain("evalArtifacts")
  })
})

describe("startStorageRetentionSweeper", () => {
  it("runs an initial sweep honoring the live retention days", async () => {
    // Real timers: driving Dexie through fake timers deadlocks (IndexedDB
    // schedules its own macrotasks). We assert the initial sweep instead.
    await saveSettings({ storageRetention: { traceRetentionDays: 30 } })
    const now = Date.now()
    await getDb().agentTraces.bulkPut([
      span("old", now - 90 * MS_PER_DAY),
      span("keep", now - 2 * MS_PER_DAY),
    ])
    const stop = await startStorageRetentionSweeper()
    expect((await getDb().agentTraces.toArray()).map((r) => r.id)).toEqual(["keep"])
    stop()
  })

  it("keeps everything when retention is set to 0 (keep forever)", async () => {
    await saveSettings({ storageRetention: { traceRetentionDays: 0 } })
    const now = Date.now()
    await getDb().agentTraces.bulkPut([span("ancient", now - 999 * MS_PER_DAY)])
    const stop = await startStorageRetentionSweeper()
    expect(await getDb().agentTraces.get("ancient")).toBeDefined()
    stop()
  })

  it("falls back to the default window when settings can't be read", async () => {
    ;(getSettings as jest.Mock).mockRejectedValueOnce(new Error("settings unavailable"))
    const now = Date.now()
    await getDb().agentTraces.bulkPut([
      span("old", now - 90 * MS_PER_DAY),
      span("keep", now - 1 * MS_PER_DAY),
    ])
    // No settings → readRetentionDays catches and uses the 30-day default.
    const stop = await startStorageRetentionSweeper()
    expect((await getDb().agentTraces.toArray()).map((r) => r.id)).toEqual(["keep"])
    stop()
  })

  it("schedules a daily interval and the unsubscribe clears it", async () => {
    const setSpy = jest.spyOn(global, "setInterval")
    const clearSpy = jest.spyOn(global, "clearInterval")
    try {
      const stop = await startStorageRetentionSweeper()
      expect(setSpy).toHaveBeenCalledWith(expect.any(Function), RETENTION_SWEEP_INTERVAL_MS)
      stop()
      expect(clearSpy).toHaveBeenCalled()
    } finally {
      setSpy.mockRestore()
      clearSpy.mockRestore()
    }
  })
})

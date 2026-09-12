import { rowStatus, summarizeSyncSnapshot } from "./sync-status-summary"

const T0 = 1_700_000_000_000

describe("rowStatus", () => {
  it("ranks an error above a stale success", () => {
    expect(rowStatus({ lastSyncAt: T0, lastError: "boom" })).toBe("error")
    expect(rowStatus({ lastSyncAt: T0, lastError: null })).toBe("synced")
    expect(rowStatus({ lastSyncAt: null, lastError: null })).toBe("never")
  })
})

describe("summarizeSyncSnapshot", () => {
  it("orders errors, then never-synced, then synced newest first", () => {
    const summary = summarizeSyncSnapshot({
      settings: { lastSyncAt: T0 + 1000, lastError: null },
      characters: { lastSyncAt: T0, lastError: null },
      sessions: { lastSyncAt: null, lastError: null },
      messages: { lastSyncAt: T0 - 5, lastError: "reset by peer" },
      plans: { lastSyncAt: T0 + 5000, lastError: null },
    })
    expect(summary.rows.map((r) => r.table)).toEqual([
      "messages",
      "sessions",
      "plans",
      "settings",
      "characters",
    ])
    expect(summary.failing.map((r) => r.table)).toEqual(["messages"])
    expect(summary.rest.map((r) => r.table)).toEqual([
      "sessions",
      "plans",
      "settings",
      "characters",
    ])
  })

  it("counts states and reports the newest sync across every table", () => {
    const summary = summarizeSyncSnapshot({
      a: { lastSyncAt: T0, lastError: null },
      b: { lastSyncAt: null, lastError: null },
      c: { lastSyncAt: T0 + 99, lastError: "x" },
    })
    expect(summary.total).toBe(3)
    expect(summary.syncedCount).toBe(1)
    expect(summary.neverCount).toBe(1)
    expect(summary.failingCount).toBe(1)
    // A failed table's previous success still counts as "last synced".
    expect(summary.lastSyncAt).toBe(T0 + 99)
  })

  it("derives the overall verdict", () => {
    expect(summarizeSyncSnapshot({}).overall).toBe("empty")
    expect(
      summarizeSyncSnapshot({
        a: { lastSyncAt: T0, lastError: null },
        b: { lastSyncAt: T0, lastError: null },
      }).overall
    ).toBe("healthy")
    expect(
      summarizeSyncSnapshot({
        a: { lastSyncAt: T0, lastError: null },
        b: { lastSyncAt: null, lastError: "nope" },
      }).overall
    ).toBe("failing")
    expect(
      summarizeSyncSnapshot({
        a: { lastSyncAt: T0, lastError: null },
        b: { lastSyncAt: null, lastError: null },
      }).overall
    ).toBe("partial")
    expect(
      summarizeSyncSnapshot({
        a: { lastSyncAt: null, lastError: null },
      }).overall
    ).toBe("never")
  })

  it("keeps handler order for rows with identical keys", () => {
    const summary = summarizeSyncSnapshot({
      first: { lastSyncAt: null, lastError: null },
      second: { lastSyncAt: null, lastError: null },
    })
    expect(summary.rows.map((r) => r.table)).toEqual(["first", "second"])
  })
})

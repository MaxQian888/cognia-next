import { coalesceSince, decideCoalesce, buildBumpPatch, DEFAULT_COALESCE_WINDOW_MS } from "./dedup"
import type { NotificationRecord } from "@/types/notifications"

function rec(over: Partial<NotificationRecord> = {}): NotificationRecord {
  return {
    id: "e",
    source: "connector",
    level: "info",
    title: "old",
    createdAt: 1000,
    updatedAt: 1000,
    readState: "read",
    count: 1,
    directed: false,
    deliveredVia: ["center"],
    ...over,
  }
}

describe("coalesceSince", () => {
  it("subtracts the default window", () => {
    expect(coalesceSince(100_000)).toBe(100_000 - DEFAULT_COALESCE_WINDOW_MS)
  })
  it("honours a custom window", () => {
    expect(coalesceSince(100, 30)).toBe(70)
  })
})

describe("decideCoalesce", () => {
  it("inserts when there is no existing record", () => {
    expect(decideCoalesce(undefined, { now: 0 })).toBe("insert")
  })

  it("REGULAR: bumps within the createdAt window", () => {
    const e = rec({ createdAt: 1000 })
    expect(decideCoalesce(e, { now: 1000 + 10_000, windowMs: 45_000 })).toBe("bump")
  })

  it("REGULAR: inserts once the first event lapses the window", () => {
    const e = rec({ createdAt: 1000 })
    expect(decideCoalesce(e, { now: 1000 + 50_000, windowMs: 45_000 })).toBe("insert")
  })

  it("BACKOFF: always bumps a found record regardless of createdAt", () => {
    const e = rec({ createdAt: 1000 })
    expect(decideCoalesce(e, { now: 1000 + 999_999, backoff: true })).toBe("bump")
  })
})

describe("buildBumpPatch", () => {
  it("increments count, refreshes content, and re-surfaces as unseen", () => {
    const e = rec({ count: 2, readState: "read", snoozedUntil: 9999 })
    const patch = buildBumpPatch(e, { title: "new", body: "b", level: "info" }, 5000)
    expect(patch.count).toBe(3)
    expect(patch.title).toBe("new")
    expect(patch.body).toBe("b")
    expect(patch.updatedAt).toBe(5000)
    expect(patch.readState).toBe("unseen")
    expect(patch.snoozedUntil).toBeUndefined()
  })

  it("escalates level but never downgrades", () => {
    const e = rec({ level: "error" })
    expect(buildBumpPatch(e, { title: "t", level: "info" }, 1).level).toBe("error")
    const e2 = rec({ level: "info" })
    expect(buildBumpPatch(e2, { title: "t", level: "error" }, 1).level).toBe("error")
  })

  it("escalates directed (sticky once true)", () => {
    const e = rec({ directed: true })
    expect(buildBumpPatch(e, { title: "t", level: "info", directed: false }, 1).directed).toBe(true)
    const e2 = rec({ directed: false })
    expect(buildBumpPatch(e2, { title: "t", level: "info", directed: true }, 1).directed).toBe(true)
  })

  it("falls back to the existing href/icon/meta when the new event omits them", () => {
    const e = rec({ href: "/old", icon: "bell", meta: { a: 1 } })
    const patch = buildBumpPatch(e, { title: "t", level: "info" }, 1)
    expect(patch.href).toBe("/old")
    expect(patch.icon).toBe("bell")
    expect(patch.meta).toEqual({ a: 1 })
  })
})

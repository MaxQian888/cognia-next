import { bucketByRecency, startOfLocalDay } from "./recency-buckets"
import type { NotificationRecord } from "@/types/notifications"

function rec(id: string, createdAt: number): NotificationRecord {
  return {
    id,
    source: "system",
    level: "info",
    title: id,
    createdAt,
    updatedAt: createdAt,
    readState: "unseen",
    count: 1,
    directed: false,
    deliveredVia: ["center"],
  }
}

const NOON = new Date(2026, 5, 23, 12, 0, 0).getTime() // 2026-06-23 12:00 local
const DAY = 24 * 60 * 60 * 1000

describe("startOfLocalDay", () => {
  it("zeroes the time component", () => {
    const start = startOfLocalDay(NOON)
    const d = new Date(start)
    expect(d.getHours()).toBe(0)
    expect(d.getMinutes()).toBe(0)
    expect(d.getSeconds()).toBe(0)
    expect(d.getMilliseconds()).toBe(0)
  })
})

describe("bucketByRecency", () => {
  it("splits records into today / yesterday / earlier", () => {
    const startToday = startOfLocalDay(NOON)
    const records = [
      rec("t1", startToday + 60_000),
      rec("t2", startToday),
      rec("y1", startToday - 60_000),
      rec("e1", startToday - DAY - 60_000),
    ]
    const groups = bucketByRecency(records, NOON)
    expect(groups.map((g) => g.key)).toEqual(["today", "yesterday", "earlier"])
    expect(groups[0].items.map((r) => r.id)).toEqual(["t1", "t2"])
    expect(groups[1].items.map((r) => r.id)).toEqual(["y1"])
    expect(groups[2].items.map((r) => r.id)).toEqual(["e1"])
  })

  it("drops empty buckets", () => {
    const startToday = startOfLocalDay(NOON)
    const groups = bucketByRecency([rec("e1", startToday - 5 * DAY)], NOON)
    expect(groups).toHaveLength(1)
    expect(groups[0].key).toBe("earlier")
  })

  it("returns nothing for an empty list", () => {
    expect(bucketByRecency([], NOON)).toEqual([])
  })

  it("preserves input order within a bucket", () => {
    const startToday = startOfLocalDay(NOON)
    const groups = bucketByRecency(
      [rec("a", startToday + 3000), rec("b", startToday + 2000), rec("c", startToday + 1000)],
      NOON
    )
    expect(groups[0].items.map((r) => r.id)).toEqual(["a", "b", "c"])
  })

  it("treats the exact start-of-today boundary as today", () => {
    const startToday = startOfLocalDay(NOON)
    const groups = bucketByRecency([rec("boundary", startToday)], NOON)
    expect(groups[0].key).toBe("today")
  })
})

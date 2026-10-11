import type { SessionUsageRow } from "@/lib/db/session-usage"
import { collectActivityStats } from "@/lib/usage/activity-stats"
import { localDay } from "@/lib/usage/session-analytics"
import type { GlanceActivityRange } from "@/types/glance/layout"

import { activityRangeStart, buildActivitySlice, GLANCE_ACTIVITY_DAYS } from "./build-activity"

const NOW = new Date(2026, 2, 8, 12, 0, 0).getTime()

let seq = 0
function row(at: number, tokens: number, extra: Partial<SessionUsageRow> = {}): SessionUsageRow {
  seq += 1
  return {
    messageId: `m${seq}`,
    sessionId: "s1",
    at,
    inputTokens: tokens,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    durationMs: 0,
    ...extra,
  }
}

/** Local noon, `back` calendar days before the fixed "today". */
const noon = (back: number) => new Date(2026, 2, 8 - back, 12).getTime()

function build(
  rows: SessionUsageRow[],
  patch: Partial<Parameters<typeof buildActivitySlice>[0]> = {}
) {
  return buildActivitySlice({
    rows,
    range: "1m",
    scope: "cognia",
    sessionFilter: null,
    now: NOW,
    ...patch,
  })
}

describe("GLANCE_ACTIVITY_DAYS", () => {
  it("covers 5, 13 and 53 weeks", () => {
    expect(GLANCE_ACTIVITY_DAYS).toEqual({ "1m": 35, "3m": 91, "1y": 371 })
  })
})

describe("activityRangeStart", () => {
  it.each([
    ["1m", new Date(2026, 1, 2)],
    ["3m", new Date(2025, 11, 8)],
    ["1y", new Date(2026, 2, 8 - 370)],
  ] as Array<[GlanceActivityRange, Date]>)(
    "is local midnight N-1 days back for %s",
    (range, expected) => {
      const start = activityRangeStart(range, NOW)
      expect(start).toBe(expected.getTime())
      const d = new Date(start)
      expect([d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()]).toEqual([
        0, 0, 0, 0,
      ])
    }
  )

  it("does not depend on the time of day", () => {
    expect(activityRangeStart("1m", new Date(2026, 2, 8, 0, 0, 1).getTime())).toBe(
      activityRangeStart("1m", new Date(2026, 2, 8, 23, 59, 59).getTime())
    )
  })
})

describe("buildActivitySlice days", () => {
  it.each(["1m", "3m", "1y"] as GlanceActivityRange[])(
    "%s has the right length and ends today",
    (range) => {
      const slice = build([], { range })
      expect(slice.range).toBe(range)
      expect(slice.days).toHaveLength(GLANCE_ACTIVITY_DAYS[range])
      expect(slice.days[slice.days.length - 1].day).toBe(localDay(NOW))
      expect(slice.days[0].day).toBe(localDay(activityRangeStart(range, NOW)))
      expect(new Set(slice.days.map((d) => d.day)).size).toBe(slice.days.length)
    }
  )

  it("zero-fills an empty ledger with level 0 and zeroed stats", () => {
    const slice = build([])
    expect(slice.updatedAt).toBe(NOW)
    expect(slice.days.every((d) => d.tokens === 0 && d.level === 0)).toBe(true)
    expect(slice).toMatchObject({
      activeDays: 0,
      currentStreak: 0,
      longestStreak: 0,
      peakHour: null,
    })
  })

  it("sums fresh input and output tokens per day, ignoring cache tokens", () => {
    const slice = build([
      row(noon(2), 100, { outputTokens: 50, cacheReadTokens: 9_000, cacheCreationTokens: 9_000 }),
      row(noon(2) + 1000, 25),
    ])
    const day = slice.days.find((d) => d.day === localDay(noon(2)))!
    expect(day.tokens).toBe(175)
  })

  it("places rows on their local day", () => {
    const lateEvening = new Date(2026, 2, 6, 23, 59).getTime()
    const justAfterMidnight = new Date(2026, 2, 7, 0, 1).getTime()
    const slice = build([row(lateEvening, 10), row(justAfterMidnight, 20)])
    expect(slice.days.find((d) => d.day === "2026-03-06")!.tokens).toBe(10)
    expect(slice.days.find((d) => d.day === "2026-03-07")!.tokens).toBe(20)
  })
})

describe("levels", () => {
  it("assigns level 0 to inactive days and 1-4 to active ones", () => {
    const slice = build([row(noon(0), 10), row(noon(1), 20), row(noon(3), 30)])
    for (const d of slice.days) {
      if (d.tokens === 0) expect(d.level).toBe(0)
      else expect([1, 2, 3, 4]).toContain(d.level)
    }
  })

  it("uses quartiles of the active days, so one huge day does not flatten the rest", () => {
    const tokens = [10, 20, 30, 40, 50, 60, 70, 1_000_000_000]
    const slice = build(tokens.map((t, i) => row(noon(i), t)))
    const levels = new Map(slice.days.map((d) => [d.tokens, d.level]))
    expect(tokens.map((t) => levels.get(t))).toEqual([1, 1, 2, 2, 3, 3, 4, 4])
  })

  it("puts each of four active days on its own level", () => {
    const tokens = [5, 15, 25, 35]
    const slice = build(tokens.map((t, i) => row(noon(i), t)))
    const levels = new Map(slice.days.map((d) => [d.tokens, d.level]))
    expect(tokens.map((t) => levels.get(t))).toEqual([1, 2, 3, 4])
  })

  it("never lowers a level for more tokens", () => {
    const slice = build(Array.from({ length: 12 }, (_, i) => row(noon(i), (i + 1) * 7)))
    const active = slice.days.filter((d) => d.tokens > 0).sort((a, b) => a.tokens - b.tokens)
    for (let i = 1; i < active.length; i += 1) {
      expect(active[i].level).toBeGreaterThanOrEqual(active[i - 1].level)
    }
    expect(active[0].level).toBe(1)
    expect(active[active.length - 1].level).toBe(4)
  })

  it("gives equal tokens equal levels", () => {
    const slice = build([row(noon(0), 50), row(noon(1), 50), row(noon(2), 50)])
    expect(new Set(slice.days.filter((d) => d.tokens > 0).map((d) => d.level)).size).toBe(1)
  })

  it("marks a single active day as level 1", () => {
    const slice = build([row(noon(0), 999)])
    expect(slice.days.filter((d) => d.level > 0)).toEqual([
      { day: "2026-03-08", tokens: 999, level: 1 },
    ])
  })

  it("treats a day whose rows carry no fresh tokens as inactive", () => {
    const slice = build([row(noon(1), 0, { cacheReadTokens: 500 })])
    expect(slice.days.every((d) => d.level === 0)).toBe(true)
  })
})

describe("range and clock filtering", () => {
  it("includes a row at the very start of the range and excludes one just before it", () => {
    const start = activityRangeStart("1m", NOW)
    const slice = build([
      row(start, 11, { sessionId: "in" }),
      row(start - 1, 22, { sessionId: "out" }),
    ])
    expect(slice.days[0].tokens).toBe(11)
    expect(slice.activeDays).toBe(1)
  })

  it("excludes rows older than the range", () => {
    const slice = build([row(noon(40), 500)], { range: "1m" })
    expect(slice.days.every((d) => d.tokens === 0)).toBe(true)
    expect(build([row(noon(40), 500)], { range: "3m" }).days.some((d) => d.tokens === 500)).toBe(
      true
    )
  })

  it("admits rows up to five minutes ahead of now and excludes later ones", () => {
    const within = row(NOW + 299_000, 7)
    const beyond = row(NOW + 300_001, 9_999)
    const slice = build([within, beyond])
    const today = slice.days[slice.days.length - 1]
    expect(today.tokens).toBe(7)
  })
})

describe("session filter", () => {
  const rows = [
    row(noon(0), 10, { sessionId: "keep" }),
    row(noon(1), 20, { sessionId: "drop" }),
    row(noon(2), 30, { sessionId: "keep" }),
  ]

  it("restricts to the given sessions", () => {
    const slice = build(rows, { sessionFilter: new Set(["keep"]) })
    expect(slice.days.reduce((n, d) => n + d.tokens, 0)).toBe(40)
    expect(slice.activeDays).toBe(2)
  })

  it("counts everything when the filter is null", () => {
    expect(build(rows, { sessionFilter: null }).activeDays).toBe(3)
  })

  it("shows nothing for an empty session set (a workspace with no sessions)", () => {
    const slice = build(rows, { sessionFilter: new Set() })
    expect(slice.days.every((d) => d.tokens === 0)).toBe(true)
    expect(slice.activeDays).toBe(0)
  })
})

describe("scope filter", () => {
  const rows = [
    row(noon(0), 10),
    row(noon(1), 20, { imported: true }),
    row(noon(2), 40, { sourceId: "codex", imported: true }),
    row(noon(3), 80, { sourceId: "claude-code" }),
  ]
  const total = (scope: "cognia" | "all-tools") =>
    build(rows, { scope }).days.reduce((n, d) => n + d.tokens, 0)

  it("excludes imported and external-source rows in cognia scope", () => {
    expect(total("cognia")).toBe(10)
    expect(build(rows, { scope: "cognia" }).activeDays).toBe(1)
  })

  it("includes them in all-tools scope", () => {
    expect(total("all-tools")).toBe(150)
    expect(build(rows, { scope: "all-tools" }).activeDays).toBe(4)
  })
})

describe("stats", () => {
  it("matches collectActivityStats over the same filtered rows", () => {
    const rows = [
      row(noon(0), 10),
      row(noon(1), 10),
      row(noon(2), 10),
      row(noon(5), 10),
      row(noon(6), 10),
      row(noon(7), 10),
      row(noon(8), 10),
    ]
    const slice = build(rows)
    const stats = collectActivityStats(rows, { now: NOW })
    expect(slice.activeDays).toBe(stats.activeDays)
    expect(slice.currentStreak).toBe(stats.currentStreak)
    expect(slice.longestStreak).toBe(stats.longestStreak)
    expect(slice.peakHour).toBe(stats.peakHour)
    expect(slice).toMatchObject({ activeDays: 7, currentStreak: 3, longestStreak: 4, peakHour: 12 })
  })

  it("keeps a streak alive through yesterday when today has no turns yet", () => {
    const slice = build([row(noon(1), 10), row(noon(2), 10)])
    expect(slice.currentStreak).toBe(2)
  })

  it("computes stats only over rows that survive the filters", () => {
    const slice = build(
      [
        row(noon(0), 10),
        row(noon(1), 10, { imported: true }),
        row(noon(2), 10, { imported: true }),
      ],
      { scope: "cognia" }
    )
    expect(slice).toMatchObject({ activeDays: 1, currentStreak: 1, longestStreak: 1 })
  })

  it("reports the busiest local hour", () => {
    const at = (h: number) => new Date(2026, 2, 7, h, 15).getTime()
    const slice = build([
      row(at(9), 1),
      row(at(14), 1),
      row(at(14) + 60_000, 1),
      row(at(14) + 120_000, 1),
    ])
    expect(slice.peakHour).toBe(14)
  })
})

import { AGENDA_MAX_PER_TASK, buildAgenda, groupDayByItem } from "./agenda"
import type { UnifiedScheduledItem } from "@/types/scheduler/unified"

const HOUR = 60 * 60 * 1000

function item(name: string, intervalMs: number, nextRunAt: number): UnifiedScheduledItem {
  return {
    unifiedId: `app:${name}`,
    kind: "app",
    sourceId: name,
    name,
    status: "active",
    triggerSummary: { type: "interval", intervalMs },
    nextRunAt,
    origin: { deepLinkHref: "/scheduler" },
    capabilities: { runNow: true, pause: true, edit: true, delete: true },
  }
}

describe("buildAgenda", () => {
  const now = new Date(2026, 8, 13, 9, 0).getTime()

  it("groups projected occurrences by day, soonest first", () => {
    const agenda = buildAgenda([item("hourly", 6 * HOUR, now + HOUR)], { now, days: 2 })
    expect(agenda.next?.taskName).toBe("hourly")
    expect(agenda.days.length).toBeGreaterThanOrEqual(1)
    expect(agenda.days[0].key).toBe("2026-09-13")
    const times = agenda.occurrences.map((o) => o.date.getTime())
    expect(times).toEqual([...times].sort((a, b) => a - b))
    expect(agenda.countsByDay.get("2026-09-13")).toBe(agenda.days[0].occurrences.length)
  })

  it("is empty with nothing scheduled", () => {
    const agenda = buildAgenda([], { now })
    expect(agenda.days).toEqual([])
    expect(agenda.next).toBeUndefined()
  })

  it("projects a five-minute task across the whole window, not just its first hundred fires", () => {
    const agenda = buildAgenda([item("fast", 5 * 60 * 1000, now + 60 * 1000)], { now, days: 14 })
    expect(agenda.occurrences.length).toBeGreaterThan(100)
    expect(agenda.occurrences.length).toBeLessThanOrEqual(AGENDA_MAX_PER_TASK)
    expect(agenda.countsByDay.get("2026-09-20")).toBe(288)
  })

  it("bounds a cron walk to the window instead of enumerating years ahead", () => {
    const yearly: UnifiedScheduledItem = {
      ...item("yearly", HOUR, now + HOUR),
      triggerSummary: { type: "cron", cron: "0 0 1 1 *" },
      nextRunAt: undefined,
    }
    const started = Date.now()
    const agenda = buildAgenda([yearly], { now, days: 14 })
    expect(Date.now() - started).toBeLessThan(500)
    expect(agenda.occurrences).toEqual([])
  })
})

describe("groupDayByItem", () => {
  const now = new Date(2026, 8, 13, 9, 0).getTime()

  it("collapses a day to one entry per item with first, last and count", () => {
    const agenda = buildAgenda(
      [item("fast", 30 * 60 * 1000, now + 60 * 1000), item("daily", 24 * HOUR, now + 2 * HOUR)],
      { now, days: 1 }
    )
    const entries = groupDayByItem(agenda.days[0])
    expect(entries.map((e) => e.first.taskName)).toEqual(["fast", "daily"])
    const fast = entries[0]
    expect(fast.count).toBeGreaterThan(1)
    expect(fast.last.date.getTime()).toBeGreaterThan(fast.first.date.getTime())
    expect(entries[1]).toMatchObject({ count: 1 })
    expect(entries[1].last).toBe(entries[1].first)
  })
})

import { buildAgenda } from "./agenda"
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
})

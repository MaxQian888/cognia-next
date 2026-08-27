import {
  computeUnifiedOccurrences,
  countOccurrencesByDay,
  dayKey,
  groupOccurrencesByDay,
  groupOccurrencesByTask,
  type Occurrence,
} from "./upcoming-occurrences"

describe("dayKey", () => {
  it("formats a local YYYY-MM-DD key", () => {
    expect(dayKey(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05")
    expect(dayKey(new Date(2026, 11, 1, 0, 0))).toBe("2026-12-01")
  })
})

describe("groupOccurrencesByDay", () => {
  it("buckets a sorted list into per-day groups at local midnight", () => {
    const occs: Occurrence[] = [
      occ("2026-01-05T09:00:00"),
      occ("2026-01-05T18:00:00"),
      occ("2026-01-06T00:00:00"),
    ]
    const days = groupOccurrencesByDay(occs)
    expect(days).toHaveLength(2)
    expect(days[0].occurrences).toHaveLength(2)
    expect(days[0].date.getHours()).toBe(0)
    expect(days[1].key).toBe("2026-01-06")
  })

  it("returns an empty array for no occurrences", () => {
    expect(groupOccurrencesByDay([])).toEqual([])
  })
})

describe("countOccurrencesByDay", () => {
  it("counts occurrences per day key", () => {
    const counts = countOccurrencesByDay([
      occ("2026-01-05T09:00:00"),
      occ("2026-01-05T18:00:00"),
      occ("2026-01-07T10:00:00"),
    ])
    expect(counts.get("2026-01-05")).toBe(2)
    expect(counts.get("2026-01-07")).toBe(1)
    expect(counts.get("2026-01-06")).toBeUndefined()
  })
})

describe("groupOccurrencesByTask", () => {
  it("collapses a task's repeated runs into one group, ordered by first run", () => {
    const groups = groupOccurrencesByTask([
      occ("2026-01-05T09:00:00", "a", "Alpha"),
      occ("2026-01-05T09:05:00", "b", "Beta"),
      occ("2026-01-05T09:10:00", "a", "Alpha"),
    ])
    expect(groups.map((g) => g.taskId)).toEqual(["a", "b"])
    expect(groups[0].times.map((d) => d.getMinutes())).toEqual([0, 10])
    expect(groups[1].times).toHaveLength(1)
  })

  it("carries the task metadata onto the group", () => {
    const [group] = groupOccurrencesByTask([occ("2026-01-05T09:00:00", "a", "Alpha")])
    expect(group).toMatchObject({
      taskId: "a",
      taskName: "Alpha",
      taskType: "chat",
      triggerType: "cron",
      status: "active",
      kind: "app",
    })
  })

  it("drops an exact duplicate instant for the same task", () => {
    const groups = groupOccurrencesByTask([
      occ("2026-01-05T09:00:00", "a", "Alpha"),
      occ("2026-01-05T09:00:00", "a", "Alpha"),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].times).toHaveLength(1)
  })

  it("keeps the same instant when it belongs to different tasks", () => {
    const groups = groupOccurrencesByTask([
      occ("2026-01-05T09:00:00", "a", "Alpha"),
      occ("2026-01-05T09:00:00", "b", "Beta"),
    ])
    expect(groups).toHaveLength(2)
  })

  it("returns an empty list for no occurrences", () => {
    expect(groupOccurrencesByTask([])).toEqual([])
  })
})

function occ(iso: string, taskId = "x", taskName = "X"): Occurrence {
  return {
    taskId,
    taskName,
    taskType: "chat",
    triggerType: "cron",
    status: "active",
    kind: "app",
    date: new Date(iso),
  }
}

// ---------------------------------------------------------------------------
// Cross-source projection (computeUnifiedOccurrences)
// ---------------------------------------------------------------------------

describe("computeUnifiedOccurrences", () => {
  const from = new Date("2026-03-02T00:00:00Z")

  function unified(
    overrides: Partial<import("@/types/scheduler/unified").UnifiedScheduledItem> & {
      sourceId: string
    }
  ): import("@/types/scheduler/unified").UnifiedScheduledItem {
    const kind = overrides.kind ?? "app"
    return {
      unifiedId: `${kind}:${overrides.sourceId}`,
      kind,
      name: "Item",
      status: "active",
      triggerSummary: { type: "interval", intervalMs: 60 * 60 * 1000 },
      origin: { deepLinkHref: "/scheduler" },
      capabilities: { runNow: true, pause: true, edit: true, delete: true },
      ...overrides,
    } as import("@/types/scheduler/unified").UnifiedScheduledItem
  }

  it("projects every source, not just app items", () => {
    const occ = computeUnifiedOccurrences(
      [
        unified({ sourceId: "a", kind: "app", name: "App task" }),
        unified({
          sourceId: "b",
          kind: "workflow",
          name: "Workflow trigger",
          triggerSummary: { type: "cron", cron: "0 * * * *" },
        }),
        unified({
          sourceId: "c",
          kind: "backup",
          name: "Backup",
          triggerSummary: { type: "interval", intervalMs: 2 * 60 * 60 * 1000 },
        }),
      ],
      { from, days: 1 }
    )
    expect(new Set(occ.map((o) => o.kind))).toEqual(new Set(["app", "workflow", "backup"]))
  })

  it("tags each occurrence with its source kind and routes by unifiedId", () => {
    const occ = computeUnifiedOccurrences(
      [unified({ sourceId: "x", kind: "connector", name: "Outbound queue" })],
      { from, days: 1 }
    )
    expect(occ[0].kind).toBe("connector")
    expect(occ[0].taskId).toBe("connector:x")
  })

  it("skips items that are not active", () => {
    const occ = computeUnifiedOccurrences(
      [
        unified({ sourceId: "p", status: "paused" }),
        unified({ sourceId: "d", status: "disabled" }),
      ],
      { from, days: 2 }
    )
    expect(occ).toEqual([])
  })

  it("anchors interval expansion on the source-reported next run", () => {
    const nextRunAt = from.getTime() + 15 * 60 * 1000
    const occ = computeUnifiedOccurrences(
      [
        unified({
          sourceId: "a",
          nextRunAt,
          triggerSummary: { type: "interval", intervalMs: 60 * 60 * 1000 },
        }),
      ],
      { from, days: 1 }
    )
    expect(occ[0].date.getTime()).toBe(nextRunAt)
  })

  it("falls back to the known next run for a trigger it cannot expand", () => {
    const nextRunAt = from.getTime() + 3 * 60 * 60 * 1000
    const occ = computeUnifiedOccurrences(
      [
        unified({
          sourceId: "sys",
          kind: "system",
          nextRunAt,
          triggerSummary: { type: "event", eventType: "os" },
        }),
      ],
      { from, days: 1 }
    )
    expect(occ).toHaveLength(1)
    expect(occ[0].date.getTime()).toBe(nextRunAt)
    expect(occ[0].kind).toBe("system")
  })

  it("drops an unexpandable item whose next run is outside the window", () => {
    const occ = computeUnifiedOccurrences(
      [
        unified({
          sourceId: "sys",
          kind: "system",
          nextRunAt: from.getTime() + 30 * 24 * 60 * 60 * 1000,
          triggerSummary: { type: "event" },
        }),
      ],
      { from, days: 1 }
    )
    expect(occ).toEqual([])
  })

  it("returns occurrences sorted ascending by date", () => {
    const occ = computeUnifiedOccurrences(
      [
        unified({
          sourceId: "late",
          nextRunAt: from.getTime() + 5 * 60 * 60 * 1000,
          triggerSummary: { type: "once", runAtMs: from.getTime() + 5 * 60 * 60 * 1000 },
        }),
        unified({
          sourceId: "early",
          triggerSummary: { type: "once", runAtMs: from.getTime() + 60 * 60 * 1000 },
        }),
      ],
      { from, days: 1 }
    )
    expect(occ.map((o) => o.taskId)).toEqual(["app:early", "app:late"])
  })
})

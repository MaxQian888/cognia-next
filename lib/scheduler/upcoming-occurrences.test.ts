import {
  computeUnifiedOccurrences,
  computeUpcomingOccurrences,
  countOccurrencesByDay,
  dayKey,
  groupOccurrencesByDay,
  groupOccurrencesByTask,
  type Occurrence,
} from "./upcoming-occurrences"
import type { ScheduledTask, TaskTrigger } from "@/types/scheduler"

function makeTask(overrides: Partial<ScheduledTask> & { trigger: TaskTrigger }): ScheduledTask {
  return {
    id: overrides.id ?? "t1",
    name: overrides.name ?? "Task",
    type: overrides.type ?? "chat",
    status: overrides.status ?? "active",
    config: {
      timeout: 1000,
      maxRetries: 0,
      retryDelay: 0,
      runMissedOnStartup: false,
      allowConcurrent: false,
    },
    notification: { onStart: false, onComplete: false, onError: false },
    runCount: 0,
    successCount: 0,
    failureCount: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  }
}

// A fixed "now" that is a Monday 00:00 local for deterministic windows.
const FROM = new Date(2026, 0, 5, 0, 0, 0, 0) // 2026-01-05 00:00 local

describe("computeUpcomingOccurrences", () => {
  it("expands a daily cron across the window", () => {
    const task = makeTask({
      id: "daily",
      name: "Daily",
      trigger: { type: "cron", cronExpression: "0 9 * * *" }, // 09:00 every day
    })
    const occ = computeUpcomingOccurrences([task], { from: FROM, days: 3 })
    // 3-day window from midnight → fires on day 0,1,2 at 09:00 → 3 runs.
    expect(occ).toHaveLength(3)
    expect(occ.every((o) => o.date.getHours() === 9)).toBe(true)
    expect(occ[0].taskId).toBe("daily")
    expect(occ[0].triggerType).toBe("cron")
  })

  it("expands an interval trigger from now when no future anchor", () => {
    const task = makeTask({
      id: "iv",
      name: "Interval",
      trigger: { type: "interval", intervalMs: 6 * 60 * 60 * 1000 }, // every 6h
    })
    const occ = computeUpcomingOccurrences([task], { from: FROM, days: 1 })
    // First fire at from+6h, then +12h, +18h, +24h(excluded) → 3 in [from, from+1d).
    expect(occ).toHaveLength(3)
    expect(occ[0].date.getTime()).toBe(FROM.getTime() + 6 * 60 * 60 * 1000)
  })

  it("anchors an interval on the task's future nextRunAt", () => {
    const next = new Date(FROM.getTime() + 60 * 60 * 1000) // +1h
    const task = makeTask({
      id: "iv2",
      trigger: { type: "interval", intervalMs: 6 * 60 * 60 * 1000 },
      nextRunAt: next,
    })
    const occ = computeUpcomingOccurrences([task], { from: FROM, days: 1 })
    expect(occ[0].date.getTime()).toBe(next.getTime())
  })

  it("includes a once trigger only when inside the window", () => {
    const inside = makeTask({
      id: "once-in",
      trigger: { type: "once", runAt: new Date(FROM.getTime() + 2 * DAY) },
    })
    const outside = makeTask({
      id: "once-out",
      trigger: { type: "once", runAt: new Date(FROM.getTime() + 9 * DAY) },
    })
    const occ = computeUpcomingOccurrences([inside, outside], { from: FROM, days: 3 })
    expect(occ.map((o) => o.taskId)).toEqual(["once-in"])
  })

  it("skips paused / disabled / event tasks", () => {
    const paused = makeTask({
      id: "p",
      status: "paused",
      trigger: { type: "cron", cronExpression: "0 9 * * *" },
    })
    const event = makeTask({ id: "e", trigger: { type: "event", eventType: "x" } })
    const occ = computeUpcomingOccurrences([paused, event], { from: FROM, days: 5 })
    expect(occ).toHaveLength(0)
  })

  it("respects maxPerTask for frequent crons", () => {
    const everyMinute = makeTask({
      id: "fast",
      trigger: { type: "cron", cronExpression: "* * * * *" },
    })
    const occ = computeUpcomingOccurrences([everyMinute], { from: FROM, days: 30, maxPerTask: 10 })
    expect(occ).toHaveLength(10)
  })

  it("sorts merged occurrences ascending with stable tie-break", () => {
    const a = makeTask({
      id: "a",
      name: "Bravo",
      trigger: { type: "once", runAt: new Date(FROM.getTime() + DAY) },
    })
    const b = makeTask({
      id: "b",
      name: "Alpha",
      trigger: { type: "once", runAt: new Date(FROM.getTime() + DAY) },
    })
    const occ = computeUpcomingOccurrences([a, b], { from: FROM, days: 3 })
    // Same instant → tie-break by name: Alpha before Bravo.
    expect(occ.map((o) => o.taskName)).toEqual(["Alpha", "Bravo"])
  })

  it("ignores malformed triggers (cron without expression, zero interval)", () => {
    const noExpr = makeTask({ id: "n1", trigger: { type: "cron" } })
    const zeroIv = makeTask({ id: "n2", trigger: { type: "interval", intervalMs: 0 } })
    expect(computeUpcomingOccurrences([noExpr, zeroIv], { from: FROM, days: 5 })).toHaveLength(0)
  })
})

const DAY = 24 * 60 * 60 * 1000

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

describe("computeUpcomingOccurrences kind tagging", () => {
  it("labels app-store rows by whether they belong to the plugin scheduler", () => {
    const from = new Date("2026-01-05T00:00:00")
    const [appOcc] = computeUpcomingOccurrences(
      [makeTask({ id: "a", type: "chat", trigger: { type: "cron", cronExpression: "0 * * * *" } })],
      { from, days: 1 }
    )
    const [pluginOcc] = computeUpcomingOccurrences(
      [
        makeTask({
          id: "p",
          type: "plugin",
          trigger: { type: "cron", cronExpression: "0 * * * *" },
        }),
      ],
      { from, days: 1 }
    )
    expect(appOcc.kind).toBe("app")
    expect(pluginOcc.kind).toBe("plugin")
  })
})

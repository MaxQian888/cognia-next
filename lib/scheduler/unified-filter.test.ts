import {
  countUnifiedByKind,
  deriveUnifiedFacets,
  countUnifiedByStatus,
  deriveUnifiedStatistics,
  filterUnifiedItems,
  isUnifiedStatusFilter,
  LOOP_TAG,
  selectUpcomingItems,
} from "./unified-filter"
import type { ScheduledItemKind, UnifiedScheduledItem } from "@/types/scheduler/unified"

function item(overrides: Partial<UnifiedScheduledItem> & { sourceId: string }) {
  const kind: ScheduledItemKind = overrides.kind ?? "app"
  return {
    unifiedId: `${kind}:${overrides.sourceId}`,
    kind,
    name: "Task",
    status: "active",
    triggerSummary: { type: "interval", intervalMs: 60_000 },
    origin: { deepLinkHref: "/scheduler" },
    capabilities: { runNow: true, pause: true, edit: true, delete: true },
    ...overrides,
  } as UnifiedScheduledItem
}

describe("filterUnifiedItems", () => {
  const items = [
    item({ sourceId: "a", name: "Provider diagnostics refresh", kind: "app" }),
    item({ sourceId: "b", name: "demo-heartbeat", kind: "plugin", status: "paused" }),
    item({ sourceId: "c", name: "Automatic backup", kind: "backup", status: "paused" }),
    item({ sourceId: "d", name: "Outbound queue", kind: "connector", status: "disabled" }),
    item({ sourceId: "e", name: "Loop watcher", kind: "app", tags: [LOOP_TAG] }),
  ]

  it("returns a copy the caller owns when nothing narrows", () => {
    // Not the input reference: `deriveUnifiedFacets` hands this straight out as
    // `visibleItems`, and a consumer sorting what it was given must not be able
    // to reorder the source list every other scheduler surface reads.
    for (const result of [
      filterUnifiedItems(items),
      filterUnifiedItems(items, { search: "  ", status: "all", kinds: new Set() }),
    ]) {
      expect(result).toEqual(items)
      expect(result).not.toBe(items)
      result.reverse()
      expect(items.map((i) => i.sourceId)).toEqual(["a", "b", "c", "d", "e"])
    }
  })

  it("matches search against name, description, and cron expression", () => {
    expect(filterUnifiedItems(items, { search: "heartbeat" }).map((i) => i.sourceId)).toEqual(["b"])

    const withDescription = [
      item({ sourceId: "x", name: "Nightly", description: "rebuilds the wiki index" }),
      item({ sourceId: "y", name: "Nightly", triggerSummary: { type: "cron", cron: "0 3 * * *" } }),
    ]
    expect(filterUnifiedItems(withDescription, { search: "wiki" }).map((i) => i.sourceId)).toEqual([
      "x",
    ])
    expect(filterUnifiedItems(withDescription, { search: "0 3" }).map((i) => i.sourceId)).toEqual([
      "y",
    ])
  })

  it("is case-insensitive and trims the query", () => {
    expect(filterUnifiedItems(items, { search: "  PROVIDER " }).map((i) => i.sourceId)).toEqual([
      "a",
    ])
  })

  it("filters by status bucket", () => {
    expect(filterUnifiedItems(items, { status: "active" }).map((i) => i.sourceId)).toEqual([
      "a",
      "e",
    ])
    expect(filterUnifiedItems(items, { status: "paused" }).map((i) => i.sourceId)).toEqual([
      "b",
      "c",
    ])
  })

  it("filters /loop tasks by their tag on an axis of their own", () => {
    expect(filterUnifiedItems(items, { loopOnly: true }).map((i) => i.sourceId)).toEqual(["e"])
  })

  it("composes loopOnly with the status bucket", () => {
    const loops = [
      item({ sourceId: "l1", name: "Loop A", tags: ["loop"] }),
      item({ sourceId: "l2", name: "Loop B", tags: ["loop"], status: "paused" }),
    ]
    expect(
      filterUnifiedItems(loops, { loopOnly: true, status: "paused" }).map((i) => i.sourceId)
    ).toEqual(["l2"])
  })

  it("filters by kind and combines every criterion conjunctively", () => {
    expect(
      filterUnifiedItems(items, { kinds: new Set<ScheduledItemKind>(["app", "plugin"]) }).map(
        (i) => i.sourceId
      )
    ).toEqual(["a", "b", "e"])

    expect(
      filterUnifiedItems(items, {
        kinds: new Set<ScheduledItemKind>(["app"]),
        status: "active",
        search: "loop",
      }).map((i) => i.sourceId)
    ).toEqual(["e"])
  })

  it("does not mutate the input", () => {
    const copy = [...items]
    filterUnifiedItems(items, { status: "active" })
    expect(items).toEqual(copy)
  })
})

describe("countUnifiedByStatus", () => {
  it("counts every bucket in one pass, with loop overlapping active/paused", () => {
    const counts = countUnifiedByStatus([
      item({ sourceId: "a" }),
      item({ sourceId: "b", status: "paused" }),
      item({ sourceId: "c", tags: [LOOP_TAG] }),
      item({ sourceId: "d", status: "disabled" }),
    ])
    expect(counts).toEqual({ all: 4, active: 2, paused: 1, loop: 1 })
  })

  it("returns zeroes for an empty list", () => {
    expect(countUnifiedByStatus([])).toEqual({ all: 0, active: 0, paused: 0, loop: 0 })
  })
})

describe("countUnifiedByKind", () => {
  it("reports totals and active totals for every kind", () => {
    const { countsByKind, activeCountsByKind } = countUnifiedByKind([
      item({ sourceId: "a", kind: "app" }),
      item({ sourceId: "b", kind: "app", status: "paused" }),
      item({ sourceId: "c", kind: "backup" }),
    ])
    expect(countsByKind).toEqual({
      app: 2,
      workflow: 0,
      backup: 1,
      plugin: 0,
      system: 0,
      connector: 0,
    })
    expect(activeCountsByKind).toEqual({
      app: 1,
      workflow: 0,
      backup: 1,
      plugin: 0,
      system: 0,
      connector: 0,
    })
  })
})

describe("deriveUnifiedStatistics", () => {
  it("counts items across every source, not just app tasks", () => {
    const stats = deriveUnifiedStatistics([
      item({ sourceId: "a", kind: "app" }),
      item({ sourceId: "b", kind: "plugin", status: "paused" }),
      item({ sourceId: "c", kind: "backup", status: "paused" }),
      item({ sourceId: "d", kind: "connector", status: "disabled" }),
    ])
    expect(stats.totalItems).toBe(4)
    expect(stats.activeItems).toBe(1)
    expect(stats.pausedItems).toBe(2)
    expect(stats.otherItems).toBe(1)
  })

  it("returns a null success rate when nothing has ever run", () => {
    const stats = deriveUnifiedStatistics([item({ sourceId: "a" })])
    expect(stats.successRate).toBeNull()
    expect(stats.totalRuns).toBe(0)
    expect(stats.reportingItems).toBe(0)
  })

  it("aggregates run counters from the sources that report them", () => {
    const stats = deriveUnifiedStatistics([
      item({ sourceId: "a", successCount: 8, failureCount: 2 }),
      item({ sourceId: "b", kind: "connector", successCount: 10, failureCount: 0 }),
      // workflow / backup rows report no counters at all
      item({ sourceId: "c", kind: "workflow" }),
    ])
    expect(stats.successfulRuns).toBe(18)
    expect(stats.failedRuns).toBe(2)
    expect(stats.totalRuns).toBe(20)
    expect(stats.successRate).toBe(90)
    expect(stats.reportingItems).toBe(2)
  })

  it("counts an item that reports only failures", () => {
    const stats = deriveUnifiedStatistics([item({ sourceId: "a", failureCount: 3 })])
    expect(stats.successRate).toBe(0)
    expect(stats.reportingItems).toBe(1)
  })

  it("is zeroed for an empty list", () => {
    const stats = deriveUnifiedStatistics([])
    expect(stats.totalItems).toBe(0)
    expect(stats.successRate).toBeNull()
    expect(stats.countsByKind.app).toBe(0)
  })
})

describe("isUnifiedStatusFilter", () => {
  it("accepts known buckets and rejects anything else", () => {
    expect(isUnifiedStatusFilter("active")).toBe(true)
    expect(isUnifiedStatusFilter("paused")).toBe(true)
    // `loop` is a separate axis (loopOnly), not a status bucket.
    expect(isUnifiedStatusFilter("loop")).toBe(false)
    expect(isUnifiedStatusFilter("archived")).toBe(false)
  })
})

describe("deriveUnifiedFacets", () => {
  const items = [
    item({ sourceId: "a", name: "Alpha", kind: "app" }),
    item({ sourceId: "b", name: "Beta", kind: "workflow", status: "paused" }),
    item({ sourceId: "c", name: "Gamma", kind: "backup" }),
    item({ sourceId: "d", name: "Delta loop", kind: "app", tags: [LOOP_TAG], status: "paused" }),
  ]

  it("returns the rows that survive every criterion", () => {
    const facets = deriveUnifiedFacets(items, { status: "active" })
    expect(facets.visibleItems.map((i) => i.sourceId)).toEqual(["a", "c"])
  })

  it("counts kinds against everything except the kind selection itself", () => {
    // Pinning "app" must not zero the other kinds, or the menu becomes a
    // one-way door.
    const facets = deriveUnifiedFacets(items, { kinds: new Set<ScheduledItemKind>(["app"]) })
    expect(facets.countsByKind.app).toBe(2)
    expect(facets.countsByKind.workflow).toBe(1)
    expect(facets.countsByKind.backup).toBe(1)
  })

  it("counts statuses against the kind-filtered list", () => {
    const facets = deriveUnifiedFacets(items, { kinds: new Set<ScheduledItemKind>(["app"]) })
    expect(facets.statusCounts).toEqual({ all: 2, active: 1, paused: 1, loop: 1 })
  })

  it("counts loop items against everything except the loop toggle", () => {
    const facets = deriveUnifiedFacets(items, { loopOnly: true })
    expect(facets.loopCount).toBe(1)
    expect(facets.visibleItems.map((i) => i.sourceId)).toEqual(["d"])
  })

  it("narrows every facet by the search query", () => {
    const facets = deriveUnifiedFacets(items, { search: "loop" })
    expect(facets.visibleItems.map((i) => i.sourceId)).toEqual(["d"])
    expect(facets.statusCounts.all).toBe(1)
    expect(facets.countsByKind.app).toBe(1)
    expect(facets.countsByKind.workflow).toBe(0)
  })
})

describe("selectUpcomingItems", () => {
  const now = 1_000_000

  it("keeps only active items with a future next run, soonest first", () => {
    const picked = selectUpcomingItems(
      [
        item({ sourceId: "later", nextRunAt: now + 5_000 }),
        item({ sourceId: "soon", kind: "workflow", nextRunAt: now + 1_000 }),
        item({ sourceId: "paused", status: "paused", nextRunAt: now + 100 }),
        item({ sourceId: "stale", nextRunAt: now - 5_000 }),
        item({ sourceId: "unscheduled" }),
      ],
      { now }
    )
    expect(picked.map((i) => i.sourceId)).toEqual(["soon", "later"])
  })

  it("draws from every source, not just app tasks", () => {
    const picked = selectUpcomingItems(
      [
        item({ sourceId: "b", kind: "backup", nextRunAt: now + 10 }),
        item({ sourceId: "c", kind: "connector", nextRunAt: now + 20 }),
      ],
      { now }
    )
    expect(picked.map((i) => i.kind)).toEqual(["backup", "connector"])
  })

  it("applies the limit", () => {
    const picked = selectUpcomingItems(
      [
        item({ sourceId: "1", nextRunAt: now + 1 }),
        item({ sourceId: "2", nextRunAt: now + 2 }),
        item({ sourceId: "3", nextRunAt: now + 3 }),
      ],
      { now, limit: 2 }
    )
    expect(picked).toHaveLength(2)
  })

  it("does not mutate the input order", () => {
    const input = [
      item({ sourceId: "b", nextRunAt: now + 20 }),
      item({ sourceId: "a", nextRunAt: now + 10 }),
    ]
    selectUpcomingItems(input, { now })
    expect(input.map((i) => i.sourceId)).toEqual(["b", "a"])
  })

  it("still drops elapsed runs when the caller omits `now`", () => {
    // The default used to be `0`, which made the future-run predicate vacuous:
    // every epoch timestamp is >= 0, so a caller that forgot `now` got a list
    // led by runs that had already fired, labelled as what happens next.
    const wall = Date.now()
    const picked = selectUpcomingItems([
      item({ sourceId: "elapsed", nextRunAt: wall - 60_000 }),
      item({ sourceId: "pending", nextRunAt: wall + 60_000 }),
    ])
    expect(picked.map((i) => i.sourceId)).toEqual(["pending"])
  })
})

describe("workspace filtering", () => {
  it("keeps items from the workspace being viewed", () => {
    const items = [
      item({ sourceId: "a", projectId: "w1" }),
      item({ sourceId: "b", projectId: "w2" }),
    ]
    expect(filterUnifiedItems(items, { projectId: "w1" }).map((i) => i.unifiedId)).toEqual([
      "app:a",
    ])
  })

  it("keeps machine-wide and unattributed items in every workspace", () => {
    // A backup or a row that predates the column is unattributed, not foreign;
    // hiding it would make it invisible in every workspace at once.
    const items = [
      item({ sourceId: "x", kind: "backup" }),
      item({ sourceId: "b", projectId: "w2" }),
    ]
    expect(filterUnifiedItems(items, { projectId: "w1" }).map((i) => i.unifiedId)).toEqual([
      "backup:x",
    ])
  })

  it("disables the predicate when no workspace is given", () => {
    const items = [
      item({ sourceId: "a", projectId: "w1" }),
      item({ sourceId: "b", projectId: "w2" }),
    ]
    expect(filterUnifiedItems(items, {})).toHaveLength(2)
  })

  it("still returns a fresh array on the workspace-only path", () => {
    // The no-op fast path must not hand back the caller's array, or a
    // downstream `.sort()` reorders the memoized source list in place.
    const items = [item({ sourceId: "a", projectId: "w1" })]
    expect(filterUnifiedItems(items, { projectId: "w1" })).not.toBe(items)
  })
})

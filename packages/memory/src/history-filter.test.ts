import type { Memory } from "./types/memory"
import {
  clearMemoryFacets,
  collectMemoryFacets,
  computeMemoryStats,
  countActiveMemoryFilters,
  countMemoryQuickViews,
  filterAndSortMemories,
  findMemoryQuickView,
  MEMORY_QUICK_VIEWS,
  resolveMemoryKindFacet,
} from "./history-filter"

let seq = 0
function mem(over: Partial<Memory> = {}): Memory {
  seq += 1
  const now = 1_700_000_000_000
  return {
    id: over.id ?? `m${seq}`,
    scope: "global",
    type: "semantic",
    text: `memory ${seq}`,
    tags: [],
    importance: 5,
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now,
    accessCount: 0,
    version: 1,
    status: "active",
    pinned: false,
    provenance: "user",
    ...over,
  }
}

describe("filterAndSortMemories", () => {
  it("shows only active by default, includes invalidated when status=all", () => {
    const rows = [mem({ id: "a" }), mem({ id: "b", status: "invalidated" })]
    expect(filterAndSortMemories(rows).map((m) => m.id)).toEqual(["a"])
    expect(
      filterAndSortMemories(rows, { status: "all" })
        .map((m) => m.id)
        .sort()
    ).toEqual(["a", "b"])
  })

  it("filters by query over text and tags", () => {
    const rows = [
      mem({ id: "a", text: "prefers pnpm" }),
      mem({ id: "b", text: "lives in Shanghai", tags: ["location"] }),
    ]
    expect(filterAndSortMemories(rows, { query: "pnpm" }).map((m) => m.id)).toEqual(["a"])
    expect(filterAndSortMemories(rows, { query: "LOCATION" }).map((m) => m.id)).toEqual(["b"])
  })

  it("filters by type", () => {
    const rows = [
      mem({ id: "s", type: "semantic" }),
      mem({ id: "e", type: "episodic" }),
      mem({ id: "p", type: "procedural" }),
    ]
    expect(
      filterAndSortMemories(rows, { types: ["episodic", "procedural"] })
        .map((m) => m.id)
        .sort()
    ).toEqual(["e", "p"])
  })

  it("filters by scope", () => {
    const rows = [
      mem({ id: "g", scope: "global" }),
      mem({ id: "c", scope: "character", characterId: "charA" }),
    ]
    expect(filterAndSortMemories(rows, { scopes: ["character"] }).map((m) => m.id)).toEqual(["c"])
    // Empty scopes array is treated as "no filter".
    expect(
      filterAndSortMemories(rows, { scopes: [] })
        .map((m) => m.id)
        .sort()
    ).toEqual(["c", "g"])
  })

  it("filters by provenance", () => {
    const rows = [
      mem({ id: "u", provenance: "user" }),
      mem({ id: "x", provenance: "explicit" }),
      mem({ id: "i", provenance: "inbound" }),
    ]
    expect(
      filterAndSortMemories(rows, { provenances: ["explicit", "inbound"] })
        .map((m) => m.id)
        .sort()
    ).toEqual(["i", "x"])
  })

  it("filters by tags (AND semantics, case-insensitive)", () => {
    const rows = [
      mem({ id: "a", tags: ["Work", "urgent"] }),
      mem({ id: "b", tags: ["work"] }),
      mem({ id: "c", tags: ["home"] }),
    ]
    // Requires every listed tag.
    expect(
      filterAndSortMemories(rows, { tags: ["work"] })
        .map((m) => m.id)
        .sort()
    ).toEqual(["a", "b"])
    expect(filterAndSortMemories(rows, { tags: ["work", "URGENT"] }).map((m) => m.id)).toEqual([
      "a",
    ])
  })

  it("matches the query against the stable key", () => {
    const rows = [mem({ id: "a", text: "x", key: "always-uses-pnpm" })]
    expect(filterAndSortMemories(rows, { query: "pnpm" }).map((m) => m.id)).toEqual(["a"])
  })

  it("pins float to the top regardless of sort", () => {
    const rows = [
      mem({ id: "hi", importance: 10, updatedAt: 1 }),
      mem({ id: "pin", importance: 1, pinned: true, updatedAt: 2 }),
    ]
    expect(filterAndSortMemories(rows, { sort: "importance" })[0].id).toBe("pin")
  })

  it("sorts by importance / accessed / recent / created", () => {
    const rows = [
      mem({ id: "a", importance: 3, lastAccessedAt: 100, updatedAt: 100, createdAt: 300 }),
      mem({ id: "b", importance: 8, lastAccessedAt: 50, updatedAt: 200, createdAt: 100 }),
    ]
    expect(filterAndSortMemories(rows, { sort: "importance" })[0].id).toBe("b")
    expect(filterAndSortMemories(rows, { sort: "accessed" })[0].id).toBe("a")
    expect(filterAndSortMemories(rows, { sort: "recent" })[0].id).toBe("b")
    expect(filterAndSortMemories(rows, { sort: "created" })[0].id).toBe("a")
  })
})

describe("computeMemoryStats", () => {
  it("counts totals and active-by-type", () => {
    const rows = [
      mem({ type: "semantic" }),
      mem({ type: "semantic" }),
      mem({ type: "episodic" }),
      mem({ type: "procedural", status: "invalidated" }),
    ]
    const stats = computeMemoryStats(rows)
    expect(stats.total).toBe(4)
    expect(stats.active).toBe(3)
    expect(stats.byType).toEqual({ semantic: 2, episodic: 1, procedural: 0 })
  })

  it("counts pinned among active rows only", () => {
    const rows = [
      mem({ pinned: true }),
      mem({ pinned: true }),
      mem({ pinned: true, status: "invalidated" }), // pinned but not active → excluded
      mem({ pinned: false }),
    ]
    expect(computeMemoryStats(rows).pinned).toBe(2)
  })

  it("counts active conflicts only", () => {
    const rows = [
      mem({ reviewStatus: "conflict" }),
      mem({ reviewStatus: "conflict", status: "invalidated" }), // resolved → excluded
      mem({ reviewStatus: "verified" }),
      mem(),
    ]
    expect(computeMemoryStats(rows).conflicts).toBe(1)
  })
})

describe("filterAndSortMemories — reviewStatus preset", () => {
  it("restricts to the requested review state", () => {
    const rows = [
      mem({ id: "c1", reviewStatus: "conflict" }),
      mem({ id: "v1", reviewStatus: "verified" }),
      mem({ id: "u1" }),
    ]
    expect(filterAndSortMemories(rows, { reviewStatus: "conflict" }).map((m) => m.id)).toEqual([
      "c1",
    ])
    expect(
      filterAndSortMemories(rows, {})
        .map((m) => m.id)
        .sort()
    ).toEqual(["c1", "u1", "v1"])
  })
})

describe("status / pin / review gates", () => {
  it("status=invalidated returns only the archive", () => {
    const rows = [mem({ id: "a" }), mem({ id: "b", status: "invalidated" })]
    expect(filterAndSortMemories(rows, { status: "invalidated" }).map((m) => m.id)).toEqual(["b"])
  })

  it("pinnedOnly keeps just the pinned rows", () => {
    const rows = [mem({ id: "a", pinned: true }), mem({ id: "b" })]
    expect(filterAndSortMemories(rows, { pinnedOnly: true }).map((m) => m.id)).toEqual(["a"])
  })

  it("treats an unset reviewStatus as unreviewed", () => {
    const rows = [mem({ id: "a" }), mem({ id: "b", reviewStatus: "verified" })]
    expect(filterAndSortMemories(rows, { reviewStatus: "unreviewed" }).map((m) => m.id)).toEqual([
      "a",
    ])
  })

  it("accepts an array of review states as an OR", () => {
    const rows = [
      mem({ id: "a", reviewStatus: "unreviewed" }),
      mem({ id: "b", reviewStatus: "pending_instruction" }),
      mem({ id: "c", reviewStatus: "verified" }),
    ]
    const ids = filterAndSortMemories(rows, {
      reviewStatus: ["unreviewed", "pending_instruction"],
    }).map((m) => m.id)
    expect(ids.sort()).toEqual(["a", "b"])
  })
})

describe("quick views", () => {
  it("every view id resolves, and an unknown id degrades to `all`", () => {
    for (const view of MEMORY_QUICK_VIEWS) {
      expect(findMemoryQuickView(view.id).id).toBe(view.id)
    }
    // @ts-expect-error deliberately passing an id that is no longer defined
    expect(findMemoryQuickView("retired-view").id).toBe("all")
  })

  it("counts each view, folding pending_instruction into needsReview", () => {
    const counts = countMemoryQuickViews([
      mem({ pinned: true }),
      mem({ reviewStatus: "pending_instruction" }),
      mem({ reviewStatus: "conflict" }),
      mem({ reviewStatus: "verified" }),
      mem({ status: "invalidated" }),
    ])
    expect(counts).toEqual({ all: 4, pinned: 1, needsReview: 2, conflicts: 1, archived: 1 })
  })

  it("each view's filter actually selects the rows its count promised", () => {
    const rows = [
      mem({ id: "pin", pinned: true }),
      mem({ id: "pend", reviewStatus: "pending_instruction" }),
      mem({ id: "conf", reviewStatus: "conflict" }),
      mem({ id: "arch", status: "invalidated" }),
    ]
    const counts = countMemoryQuickViews(rows)
    for (const view of MEMORY_QUICK_VIEWS) {
      expect(filterAndSortMemories(rows, view.filter)).toHaveLength(counts[view.id])
    }
  })
})

describe("facets", () => {
  it("derives only the options present, ordered by count", () => {
    const facets = collectMemoryFacets([
      mem({ type: "semantic", scope: "global", provenance: "user", tags: ["a"] }),
      mem({ type: "semantic", scope: "workspace", provenance: "user", tags: ["a", "b"] }),
    ])
    expect(facets.types).toEqual([{ value: "semantic", count: 2 }])
    expect(facets.provenances).toEqual([{ value: "user", count: 2 }])
    expect(facets.scopes.map((s) => s.value).sort()).toEqual(["global", "workspace"])
    expect(facets.tags).toEqual([
      { value: "a", count: 2 },
      { value: "b", count: 1 },
    ])
  })

  it("counts a repeated tag on one row once", () => {
    const facets = collectMemoryFacets([mem({ tags: ["dup", "dup"] })])
    expect(facets.tags).toEqual([{ value: "dup", count: 1 }])
  })

  it("counts active facet axes but not the query, sort, or view", () => {
    expect(countActiveMemoryFilters({ query: "x", sort: "created", status: "all" })).toBe(0)
    expect(countActiveMemoryFilters({ types: ["semantic"], tags: ["a", "b"] })).toBe(3)
  })

  it("clearMemoryFacets keeps the query and sort axes", () => {
    expect(
      clearMemoryFacets({ query: "x", sort: "created", types: ["semantic"], tags: ["a"] })
    ).toEqual({ query: "x", sort: "created" })
  })
})

describe("the project/personal partition axis", () => {
  const personal = mem({ id: "p1", text: "the user prefers pnpm" })
  const claim = mem({ id: "c1", projectMemoryKind: "constraint", text: "the repo pins rust" })
  const decision = mem({ id: "c2", projectMemoryKind: "decision" })

  it("reads an absent projectMemoryKind as personal — the same contract the retriever uses", () => {
    expect(resolveMemoryKindFacet(personal)).toBe("personal")
    expect(resolveMemoryKindFacet(claim)).toBe("constraint")
  })

  it("returns both corpora when the axis is unset, which is what every old caller passes", () => {
    expect(
      filterAndSortMemories([personal, claim])
        .map((m) => m.id)
        .sort()
    ).toEqual(["c1", "p1"])
    expect(
      filterAndSortMemories([personal, claim], { projectMemoryKinds: [] })
        .map((m) => m.id)
        .sort()
    ).toEqual(["c1", "p1"])
  })

  it("narrows to one claim kind", () => {
    expect(
      filterAndSortMemories([personal, claim, decision], {
        projectMemoryKinds: ["constraint"],
      }).map((m) => m.id)
    ).toEqual(["c1"])
  })

  it("narrows to personal rows only", () => {
    expect(
      filterAndSortMemories([personal, claim, decision], {
        projectMemoryKinds: ["personal"],
      }).map((m) => m.id)
    ).toEqual(["p1"])
  })

  it("counts every kind present, personal included", () => {
    const facets = collectMemoryFacets([personal, claim, decision])
    expect(facets.projectMemoryKinds).toEqual([
      { value: "constraint", count: 1 },
      { value: "decision", count: 1 },
      { value: "personal", count: 1 },
    ])
  })
})

describe("workspace, branch and freshness axes", () => {
  const rows = [
    mem({ id: "a", projectId: "p1", branch: "main", staleness: "fresh" }),
    mem({ id: "b", projectId: "p1", branch: "feat", staleness: "stale" }),
    mem({ id: "c" }),
  ]

  it("filters by workspace, treating an unscoped row as the empty id", () => {
    expect(
      filterAndSortMemories(rows, { projectIds: ["p1"] })
        .map((m) => m.id)
        .sort()
    ).toEqual(["a", "b"])
    expect(filterAndSortMemories(rows, { projectIds: [""] }).map((m) => m.id)).toEqual(["c"])
  })

  it("filters by branch", () => {
    expect(filterAndSortMemories(rows, { branches: ["main"] }).map((m) => m.id)).toEqual(["a"])
  })

  it("reads an unset staleness as unknown, so pre-sweep rows stay reachable", () => {
    expect(filterAndSortMemories(rows, { freshness: ["unknown"] }).map((m) => m.id)).toEqual(["c"])
    expect(
      filterAndSortMemories(rows, { freshness: ["fresh", "stale"] })
        .map((m) => m.id)
        .sort()
    ).toEqual(["a", "b"])
  })

  it("offers no branch option for rows that carry none", () => {
    // Counting `""` for every personal memory would make "no branch" the
    // biggest option on every install and bury the real branches.
    const facets = collectMemoryFacets(rows)
    expect(facets.branches.map((o) => o.value).sort()).toEqual(["feat", "main"])
    expect(facets.projectIds.map((o) => o.value).sort()).toEqual(["", "p1"])
    expect(facets.freshness.map((o) => o.value).sort()).toEqual(["fresh", "stale", "unknown"])
  })
})

describe("the four new axes participate in the shared filter bookkeeping", () => {
  const filter = {
    query: "q",
    sort: "recent" as const,
    types: ["semantic" as const],
    projectMemoryKinds: ["constraint" as const, "personal" as const],
    projectIds: ["p1"],
    branches: ["main"],
    freshness: ["stale" as const],
  }

  it("counts every narrowed axis on the Filter badge", () => {
    expect(countActiveMemoryFilters(filter)).toBe(6)
  })

  it("clears all of them while keeping query and sort", () => {
    expect(clearMemoryFacets(filter)).toEqual({ query: "q", sort: "recent" })
  })
})

import type { Memory } from "@/types/memory/memory"
import { computeMemoryStats, filterAndSortMemories } from "./history-filter"

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
})

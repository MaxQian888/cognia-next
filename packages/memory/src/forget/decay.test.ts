import type { Memory, MemoryScope } from "../types/memory"
import { evictOverflow, expireStale, rankByKeepWorthiness, type DecayDeps } from "./decay"

let seq = 0
const NOW = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000

function mem(over: Partial<Memory> = {}): Memory {
  seq += 1
  return {
    id: over.id ?? `m${seq}`,
    scope: "global",
    type: "semantic",
    text: `mem ${seq}`,
    tags: [],
    importance: 5,
    createdAt: NOW,
    updatedAt: NOW,
    lastAccessedAt: NOW,
    accessCount: 0,
    version: 1,
    status: "active",
    pinned: false,
    provenance: "user",
    ...over,
  }
}

function deps(active: Memory[]): DecayDeps & { invalidated: string[] } {
  const invalidated: string[] = []
  return {
    invalidated,
    listActive: async (_scope: MemoryScope) => active,
    invalidate: async (id: string) => {
      invalidated.push(id)
    },
  }
}

it("forwards the complete exact namespace to maintenance reads", async () => {
  const listActive = jest.fn(async () => [])
  const d: DecayDeps = { listActive, invalidate: async () => undefined }
  const namespace = {
    scope: "agent" as const,
    projectId: "p1",
    agentId: "a1",
    branch: "main",
    pathPattern: "src",
    maxActivePerScope: 10,
  }
  await evictOverflow(namespace, d)
  expect(listActive).toHaveBeenCalledWith("agent", {
    projectId: "p1",
    agentId: "a1",
    branch: "main",
    pathPattern: "src",
  })
})

describe("evictOverflow", () => {
  it("does nothing when under the cap", async () => {
    const d = deps([mem(), mem()])
    const res = await evictOverflow({ scope: "global", maxActivePerScope: 5 }, d)
    expect(res.evicted).toEqual([])
    expect(d.invalidated).toEqual([])
  })

  it("evicts the lowest-scored non-pinned memories down to the cap", async () => {
    const high = mem({ id: "high", importance: 10, lastAccessedAt: NOW })
    const low = mem({ id: "low", importance: 1, lastAccessedAt: NOW - 100 * DAY })
    const mid = mem({ id: "mid", importance: 5, lastAccessedAt: NOW - 10 * DAY })
    const d = deps([high, low, mid])
    const res = await evictOverflow({ scope: "global", maxActivePerScope: 2 }, d)
    expect(res.evicted).toEqual(["low"]) // 1 overflow → lowest scored
  })

  it("never evicts pinned memories", async () => {
    const pinned = mem({ id: "p", pinned: true, importance: 1, lastAccessedAt: NOW - 100 * DAY })
    const a = mem({ id: "a", importance: 5 })
    const b = mem({ id: "b", importance: 6 })
    const d = deps([pinned, a, b])
    const res = await evictOverflow({ scope: "global", maxActivePerScope: 1 }, d)
    // overflow = 2, but only 2 non-pinned exist → both evicted, pinned kept
    expect(res.evicted.sort()).toEqual(["a", "b"])
    expect(res.evicted).not.toContain("p")
  })

  it("returns [] when every memory is pinned", async () => {
    const d = deps([mem({ pinned: true }), mem({ pinned: true })])
    const res = await evictOverflow({ scope: "global", maxActivePerScope: 1 }, d)
    expect(res.evicted).toEqual([])
  })
})

describe("evictOverflow keep-worthiness", () => {
  const old = NOW - 100 * DAY

  it("keeps an often-recalled memory over a never-recalled one of equal importance and age", async () => {
    const recalled = mem({
      id: "recalled",
      type: "episodic",
      createdAt: old,
      accessCount: 20,
      lastAccessedAt: NOW - DAY,
    })
    const ignored = mem({ id: "ignored", type: "episodic", createdAt: old, lastAccessedAt: old })
    // Order must not matter: try both.
    for (const active of [
      [recalled, ignored],
      [ignored, recalled],
    ]) {
      const d = deps(active)
      const res = await evictOverflow({ scope: "global", maxActivePerScope: 1, now: NOW }, d)
      expect(res.evicted).toEqual(["ignored"])
    }
  })

  it("sigma = 0 removes the recall advantage", async () => {
    const recalled = mem({
      id: "recalled",
      type: "episodic",
      createdAt: old,
      accessCount: 20,
      lastAccessedAt: NOW - DAY,
    })
    const ignored = mem({ id: "ignored", type: "episodic", createdAt: old, lastAccessedAt: old })
    const ranked = rankByKeepWorthiness([ignored, recalled], {
      now: NOW,
      retention: { sigma: 0 },
    })
    expect(ranked[0].score).toBe(ranked[1].score)
    expect(ranked[0].retention).toBe(ranked[1].retention)
    // Ties keep input order, so the recalled row (listed last) is now the one evicted.
    const d = deps([ignored, recalled])
    const res = await evictOverflow(
      { scope: "global", maxActivePerScope: 1, now: NOW, retention: { sigma: 0 } },
      d
    )
    expect(res.evicted).toEqual(["recalled"])
  })

  it("an important but idle fact outlives a trivial fresh one", async () => {
    const defining = mem({ id: "defining", importance: 10, createdAt: NOW - 60 * DAY })
    const trivial = mem({ id: "trivial", importance: 1, createdAt: NOW - 40 * DAY })
    const filler = mem({ id: "filler", importance: 5, createdAt: NOW - 40 * DAY })
    const ancient = mem({ id: "ancient", importance: 5, createdAt: NOW - 200 * DAY })
    const d = deps([defining, trivial, filler, ancient])
    const res = await evictOverflow({ scope: "global", maxActivePerScope: 2, now: NOW }, d)
    expect(res.evicted).toEqual(["ancient", "trivial"])
  })

  it("counts age from revisedAt, so a rewrite is a fresh start", async () => {
    const rewritten = mem({ id: "rewritten", createdAt: NOW - 300 * DAY, revisedAt: NOW })
    const aged = mem({ id: "aged", createdAt: NOW - 100 * DAY })
    const d = deps([rewritten, aged])
    const res = await evictOverflow({ scope: "global", maxActivePerScope: 1, now: NOW }, d)
    expect(res.evicted).toEqual(["aged"])
  })
})

describe("rankByKeepWorthiness", () => {
  it("returns [] for no memories", () => {
    expect(rankByKeepWorthiness([])).toEqual([])
  })

  it("sums min-max normalized retention and importance, highest first", () => {
    const fresh = mem({ id: "fresh", importance: 1, createdAt: NOW })
    const important = mem({ id: "important", importance: 10, createdAt: NOW - 1000 * DAY })
    const both = mem({ id: "both", importance: 10, createdAt: NOW })
    const ranked = rankByKeepWorthiness([fresh, important, both], { now: NOW })
    expect(ranked.map((r) => r.memory.id)).toEqual(["both", expect.any(String), expect.any(String)])
    const byId = new Map(ranked.map((r) => [r.memory.id, r]))
    expect(byId.get("both")!.score).toBeCloseTo(2)
    expect(byId.get("fresh")!.score).toBeCloseTo(1)
    expect(byId.get("important")!.score).toBeCloseTo(1)
    expect(byId.get("fresh")!.retention).toBeCloseTo(1)
    expect(byId.get("important")!.retention).toBeCloseTo(Math.exp(-0.02 * 1000))
  })

  it("treats all-equal factors as neutral", () => {
    const ranked = rankByKeepWorthiness([mem({ id: "x" }), mem({ id: "y" })], { now: NOW })
    expect(ranked.map((r) => r.score)).toEqual([2, 2])
    expect(ranked.map((r) => r.memory.id)).toEqual(["x", "y"])
  })

  it("clamps importance to [1, 10]", () => {
    const over = mem({ id: "over", importance: 50 })
    const top = mem({ id: "top", importance: 10 })
    const under = mem({ id: "under", importance: -5 })
    const bottom = mem({ id: "bottom", importance: 1 })
    const ranked = rankByKeepWorthiness([over, top, under, bottom], { now: NOW })
    const byId = new Map(ranked.map((r) => [r.memory.id, r.score]))
    expect(byId.get("over")).toBe(byId.get("top"))
    expect(byId.get("under")).toBe(byId.get("bottom"))
  })
})

describe("expireStale", () => {
  it("invalidates non-pinned memories older than the idle window", async () => {
    const fresh = mem({ id: "fresh", lastAccessedAt: NOW - 1 * DAY })
    const stale = mem({ id: "stale", lastAccessedAt: NOW - 100 * DAY })
    const stalePinned = mem({ id: "sp", lastAccessedAt: NOW - 100 * DAY, pinned: true })
    const d = deps([fresh, stale, stalePinned])
    const res = await expireStale({ scope: "global", maxIdleDays: 30, now: NOW }, d)
    expect(res.expired).toEqual(["stale"])
  })

  it("is a no-op when maxIdleDays <= 0", async () => {
    const d = deps([mem({ lastAccessedAt: 0 })])
    const res = await expireStale({ scope: "global", maxIdleDays: 0, now: NOW }, d)
    expect(res.expired).toEqual([])
    expect(d.invalidated).toEqual([])
  })
})

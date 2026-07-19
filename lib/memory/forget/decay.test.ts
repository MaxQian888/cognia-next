import type { Memory, MemoryScope } from "@/types/memory/memory"
import { evictOverflow, expireStale, type DecayDeps } from "./decay"

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

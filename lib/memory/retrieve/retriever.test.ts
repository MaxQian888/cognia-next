import type { Memory } from "@/types/memory/memory"
import { retrieveMemories, type MemoryRetrieverDeps } from "./retriever"

let seq = 0
function mem(text: string, over: Partial<Memory> = {}): Memory {
  seq += 1
  const now = 1_700_000_000_000
  return {
    id: over.id ?? `m${seq}`,
    scope: "global",
    type: "semantic",
    text,
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

const base = {
  topK: 5,
  relevanceFloor: 0, // disable floor unless a test sets it
}

describe("retrieveMemories", () => {
  it("returns [] for blank query", async () => {
    const deps: MemoryRetrieverDeps = { loadCandidates: async () => [mem("pnpm")] }
    expect(await retrieveMemories({ queryText: "   ", ...base }, deps)).toEqual([])
  })

  it("returns [] when there are no candidates", async () => {
    const deps: MemoryRetrieverDeps = { loadCandidates: async () => [] }
    expect(await retrieveMemories({ queryText: "pnpm", ...base }, deps)).toEqual([])
  })

  it("BM25-only: finds keyword matches when no embed/vector deps", async () => {
    const deps: MemoryRetrieverDeps = {
      loadCandidates: async () => [
        mem("The user prefers pnpm over npm", { id: "hit" }),
        mem("The user lives in Shanghai", { id: "miss" }),
      ],
    }
    const out = await retrieveMemories({ queryText: "pnpm", ...base }, deps)
    expect(out.map((r) => r.memory.id)).toContain("hit")
  })

  it("filters by type when `types` is set", async () => {
    const deps: MemoryRetrieverDeps = {
      loadCandidates: async () => [
        mem("pnpm fact", { id: "sem", type: "semantic" }),
        mem("pnpm episode", { id: "epi", type: "episodic" }),
        mem("pnpm rule", { id: "proc", type: "procedural" }),
      ],
    }
    const out = await retrieveMemories(
      { queryText: "pnpm", ...base, types: ["semantic", "episodic"] },
      deps
    )
    const ids = out.map((r) => r.memory.id)
    expect(ids).not.toContain("proc")
  })

  it("hybrid: fuses vector hits (mapped by vectorDocId) with keyword hits", async () => {
    const candidates = [
      mem("alpha topic", { id: "a", vectorDocId: "va" }),
      mem("beta topic", { id: "b", vectorDocId: "vb" }),
    ]
    const deps: MemoryRetrieverDeps = {
      loadCandidates: async () => candidates,
      embed: async () => [0.1, 0.2],
      // vector ranks "vb" first; keyword would rank "alpha" for the word "alpha"
      vectorSearch: async () => [
        { id: "vb", score: 0.9 },
        { id: "va", score: 0.4 },
        { id: "vUNKNOWN", score: 0.99 }, // not in candidates → dropped
      ],
    }
    const out = await retrieveMemories({ queryText: "alpha", ...base }, deps)
    const ids = out.map((r) => r.memory.id)
    expect(ids).toContain("a")
    expect(ids).toContain("b")
    expect(ids).not.toContain("vUNKNOWN")
  })

  it("degrades to BM25-only when vectorSearch throws", async () => {
    const deps: MemoryRetrieverDeps = {
      loadCandidates: async () => [mem("pnpm fact", { id: "hit" })],
      embed: async () => [0.1],
      vectorSearch: async () => {
        throw new Error("vector backend down")
      },
    }
    const out = await retrieveMemories({ queryText: "pnpm", ...base }, deps)
    expect(out.map((r) => r.memory.id)).toContain("hit")
  })

  it("applies the relevance floor (drops weak matches)", async () => {
    const deps: MemoryRetrieverDeps = {
      loadCandidates: async () => [
        mem("pnpm pnpm pnpm strong match", { id: "strong" }),
        mem("totally unrelated content", { id: "weak" }),
      ],
    }
    // Floor at 0.99 → only the top normalized match (score 1) survives.
    const out = await retrieveMemories({ queryText: "pnpm", topK: 5, relevanceFloor: 0.99 }, deps)
    expect(out.length).toBe(1)
    expect(out[0].memory.id).toBe("strong")
  })

  it("returns [] when the floor removes everything", async () => {
    const deps: MemoryRetrieverDeps = {
      loadCandidates: async () => [mem("a", { id: "x" }), mem("b", { id: "y" })],
    }
    const out = await retrieveMemories(
      { queryText: "zzzzz-no-match", topK: 5, relevanceFloor: 0.5 },
      deps
    )
    expect(out).toEqual([])
  })

  it("slices to topK", async () => {
    const deps: MemoryRetrieverDeps = {
      loadCandidates: async () =>
        Array.from({ length: 10 }, (_, i) => mem(`pnpm match number ${i}`, { id: `m${i}` })),
    }
    const out = await retrieveMemories(
      { queryText: "pnpm match", topK: 3, relevanceFloor: 0 },
      deps
    )
    expect(out.length).toBe(3)
  })

  it("touches the hit memory ids", async () => {
    const touched: string[][] = []
    const deps: MemoryRetrieverDeps = {
      loadCandidates: async () => [mem("pnpm fact", { id: "hit" })],
      touch: async (ids) => {
        touched.push(ids)
      },
    }
    await retrieveMemories({ queryText: "pnpm", ...base }, deps)
    expect(touched[0]).toEqual(["hit"])
  })

  it("swallows touch failures", async () => {
    const deps: MemoryRetrieverDeps = {
      loadCandidates: async () => [mem("pnpm fact", { id: "hit" })],
      touch: async () => {
        throw new Error("touch failed")
      },
    }
    const out = await retrieveMemories({ queryText: "pnpm", ...base }, deps)
    expect(out.map((r) => r.memory.id)).toContain("hit")
  })
})

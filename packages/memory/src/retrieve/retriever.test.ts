import type { Memory } from "../types/memory"
import { retrieveMemories, __resetMemoryBm25Cache, type MemoryRetrieverDeps } from "./retriever"

// The BM25 index is cached by corpus signature at module scope; reset between
// cases so a shared cache key (e.g. `global::`) can't return another test's
// corpus.
beforeEach(() => {
  __resetMemoryBm25Cache()
})

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

  it("still retrieves keyword matches with query expansion enabled", async () => {
    const deps: MemoryRetrieverDeps = {
      loadCandidates: async () => [
        mem("The user prefers pnpm over npm", { id: "hit" }),
        mem("The user lives in Shanghai", { id: "miss" }),
      ],
    }
    const out = await retrieveMemories(
      { queryText: "pnpm", enableQueryExpansion: true, ...base },
      deps
    )
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

  it("does not inject a memory that overlaps the query only on stopwords", async () => {
    // Regression: BM25 returns any doc sharing a token and min-max normalization
    // promotes the lone hit to relevance 1.0, so a memory matching only
    // "is"/"the" used to be force-injected every turn.
    const deps: MemoryRetrieverDeps = {
      loadCandidates: async () => [mem("The user is happy with the onboarding", { id: "noise" })],
    }
    const out = await retrieveMemories(
      { queryText: "is the deploy done", topK: 5, relevanceFloor: 0 },
      deps
    )
    expect(out).toEqual([])
  })

  it("still injects when a meaningful term is shared (stopword gate is not over-broad)", async () => {
    const deps: MemoryRetrieverDeps = {
      loadCandidates: async () => [mem("The user prefers the deploy on Fridays", { id: "real" })],
    }
    const out = await retrieveMemories(
      { queryText: "is the deploy done", topK: 5, relevanceFloor: 0 },
      deps
    )
    expect(out.map((r) => r.memory.id)).toEqual(["real"])
  })

  it("keeps a vector-only semantic hit even with no lexical overlap", async () => {
    // The stopword gate filters the BM25 leg only; a pure semantic (vector) hit
    // with no shared term must still surface.
    const deps: MemoryRetrieverDeps = {
      loadCandidates: async () => [
        mem("The customer churned last quarter", { id: "sem", vectorDocId: "vsem" }),
      ],
      embed: async () => [0.1, 0.2],
      vectorSearch: async () => [{ id: "vsem", score: 0.88 }],
    }
    const out = await retrieveMemories(
      { queryText: "retention numbers", topK: 5, relevanceFloor: 0 },
      deps
    )
    expect(out.map((r) => r.memory.id)).toEqual(["sem"])
  })

  it("reuses the BM25 index for an unchanged corpus (rebuilds when it changes)", async () => {
    const corpus = [mem("The user prefers pnpm", { id: "a", updatedAt: 100 })]
    const loadCandidates = jest.fn(async () => corpus)
    const deps: MemoryRetrieverDeps = { loadCandidates }
    // Two retrievals over the same corpus (same characterId + types + signature).
    await retrieveMemories({ queryText: "pnpm", ...base, characterId: "c1" }, deps)
    await retrieveMemories({ queryText: "pnpm", ...base, characterId: "c1" }, deps)
    // Candidates are loaded each turn, but the index is cached — both still work.
    const out = await retrieveMemories({ queryText: "pnpm", ...base, characterId: "c1" }, deps)
    expect(out.map((r) => r.memory.id)).toContain("a")
    // A corpus change (new updatedAt) invalidates the cache and still resolves.
    const corpus2 = [mem("The user prefers yarn now", { id: "a", updatedAt: 200 })]
    const deps2: MemoryRetrieverDeps = { loadCandidates: async () => corpus2 }
    const out2 = await retrieveMemories({ queryText: "yarn", ...base, characterId: "c1" }, deps2)
    expect(out2.map((r) => r.memory.id)).toContain("a")
  })

  it("forwards the full reader and isolates BM25 caches by namespace", async () => {
    const loadCandidates = jest.fn(async (reader?: { projectId?: string }) =>
      reader?.projectId === "p1"
        ? [mem("pnpm workspace", { id: "same", updatedAt: 100 })]
        : [mem("yarn workspace", { id: "same", updatedAt: 100 })]
    )
    const deps: MemoryRetrieverDeps = { loadCandidates: loadCandidates as never }
    const readerOne = {
      projectId: "p1",
      agentId: "a1",
      branch: "main",
      path: "src/memory",
    }
    const readerTwo = { ...readerOne, projectId: "p2" }
    expect(
      (await retrieveMemories({ queryText: "pnpm", reader: readerOne, ...base }, deps))[0]?.memory
        .text
    ).toBe("pnpm workspace")
    expect(
      (await retrieveMemories({ queryText: "yarn", reader: readerTwo, ...base }, deps))[0]?.memory
        .text
    ).toBe("yarn workspace")
    expect(loadCandidates).toHaveBeenNthCalledWith(1, readerOne)
    expect(loadCandidates).toHaveBeenNthCalledWith(2, readerTwo)
  })

  it("reuses precomputedQueryEmbedding and skips deps.embed", async () => {
    const embed = jest.fn(async () => [0.1, 0.2])
    const vectorSearch = jest.fn(async () => [{ id: "vsem", score: 0.88 }])
    const deps: MemoryRetrieverDeps = {
      loadCandidates: async () => [
        mem("The customer churned last quarter", { id: "sem", vectorDocId: "vsem" }),
      ],
      embed,
      vectorSearch,
    }
    const out = await retrieveMemories(
      {
        queryText: "retention numbers",
        topK: 5,
        relevanceFloor: 0,
        precomputedQueryEmbedding: [0.9, 0.8],
      },
      deps
    )
    expect(out.map((r) => r.memory.id)).toEqual(["sem"])
    expect(embed).not.toHaveBeenCalled()
    // The vector leg ran with the caller-supplied vector.
    expect(vectorSearch).toHaveBeenCalledWith([0.9, 0.8], expect.any(Number))
  })

  it("runs the vector leg from a precomputed embedding even without deps.embed", async () => {
    const vectorSearch = jest.fn(async () => [{ id: "vsem", score: 0.88 }])
    const deps: MemoryRetrieverDeps = {
      loadCandidates: async () => [
        mem("The customer churned last quarter", { id: "sem", vectorDocId: "vsem" }),
      ],
      vectorSearch,
    }
    const out = await retrieveMemories(
      {
        queryText: "retention numbers",
        topK: 5,
        relevanceFloor: 0,
        precomputedQueryEmbedding: [0.9, 0.8],
      },
      deps
    )
    expect(out.map((r) => r.memory.id)).toEqual(["sem"])
    expect(vectorSearch).toHaveBeenCalledWith([0.9, 0.8], expect.any(Number))
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

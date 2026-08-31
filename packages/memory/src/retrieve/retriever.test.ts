import type { Memory } from "../types/memory"
import {
  retrieveMemories,
  retrieveMemoriesWithOutcome,
  __resetMemoryBm25Cache,
  isMemoryEligibleForRetrieval,
  type MemoryRetrieverDeps,
} from "./retriever"

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
  it("hard-excludes expired, conflicted, quarantined, and pending procedural rows", () => {
    const now = 1_700_000_000_000
    expect(isMemoryEligibleForRetrieval(mem("ok"), now)).toBe(true)
    expect(isMemoryEligibleForRetrieval(mem("expired", { expiresAt: now }), now)).toBe(false)
    expect(isMemoryEligibleForRetrieval(mem("conflict", { reviewStatus: "conflict" }), now)).toBe(
      false
    )
    expect(
      isMemoryEligibleForRetrieval(mem("quarantine", { trustState: "quarantined" }), now)
    ).toBe(false)
    expect(
      isMemoryEligibleForRetrieval(
        mem("instruction", { type: "procedural", reviewStatus: "pending_instruction" }),
        now
      )
    ).toBe(false)
    expect(
      isMemoryEligibleForRetrieval(
        mem("instruction", { type: "procedural", reviewStatus: "verified" }),
        now
      )
    ).toBe(true)
  })
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

describe("claimFilter — corpus partition", () => {
  const personal = mem("The user prefers pnpm workspaces", { id: "personal-1" })
  const claim = mem("The repo uses pnpm workspaces", {
    id: "claim-1",
    projectId: "p1",
    projectMemoryKind: "state",
  })
  const deps = (rows: Memory[]): MemoryRetrieverDeps => ({
    loadCandidates: async () => rows,
  })

  it("returns only personal rows under personal-only", async () => {
    const hits = await retrieveMemories(
      { ...base, queryText: "pnpm workspaces", claimFilter: "personal-only" },
      deps([personal, claim])
    )
    expect(hits.map((h) => h.memory.id)).toEqual(["personal-1"])
  })

  it("returns only project rows under project-only", async () => {
    const hits = await retrieveMemories(
      {
        ...base,
        queryText: "pnpm workspaces",
        reader: { projectId: "p1" },
        claimFilter: "project-only",
      },
      deps([personal, claim])
    )
    expect(hits.map((h) => h.memory.id)).toEqual(["claim-1"])
  })

  it("treats a row with no projectMemoryKind as personal", async () => {
    // The migration contract: every row written before mining existed has no
    // kind and must keep behaving exactly as it does today.
    const legacy = mem("Legacy row with a projectId but no kind", {
      id: "legacy-1",
      projectId: "p1",
    })
    const hits = await retrieveMemories(
      { ...base, queryText: "legacy row", claimFilter: "personal-only" },
      deps([legacy])
    )
    expect(hits.map((h) => h.memory.id)).toEqual(["legacy-1"])
  })

  it("searches both corpora when no filter is given", async () => {
    const hits = await retrieveMemories(
      { ...base, queryText: "pnpm workspaces" },
      deps([personal, claim])
    )
    expect(hits.map((h) => h.memory.id).sort()).toEqual(["claim-1", "personal-1"])
  })

  it("short-circuits project-only with no project, without loading candidates", async () => {
    const loadCandidates = jest.fn(async () => [claim])
    const hits = await retrieveMemories(
      { ...base, queryText: "pnpm", claimFilter: "project-only" },
      { loadCandidates }
    )
    expect(hits).toEqual([])
    expect(loadCandidates).not.toHaveBeenCalled()
  })

  it("scores each corpus independently rather than letting one drown the other", async () => {
    // The reason this is a pre-index partition and not a post-filter:
    // `normalizeScores` is min-max over the FUSED set, so a lone modest personal
    // hit ranked alongside many strong claims normalizes toward 0 and falls under
    // the floor. Partitioned, it keeps a full-strength score of its own.
    const claims = Array.from({ length: 8 }, (_, i) =>
      mem("pnpm workspaces pnpm workspaces pnpm", {
        id: `claim-${i}`,
        projectId: "p1",
        projectMemoryKind: "state",
      })
    )
    const modest = mem("the user mentioned pnpm once", { id: "personal-modest" })
    const hits = await retrieveMemories(
      {
        ...base,
        queryText: "pnpm workspaces",
        relevanceFloor: 0.35,
        claimFilter: "personal-only",
      },
      deps([...claims, modest])
    )
    expect(hits.map((h) => h.memory.id)).toEqual(["personal-modest"])
  })

  it("keys the BM25 cache by partition so the corpora never share an index", async () => {
    // A shared cache key would hand the second call the first call's index, and
    // the wrong corpus would answer.
    const rows = [personal, claim]
    const personalHits = await retrieveMemories(
      {
        ...base,
        queryText: "pnpm workspaces",
        reader: { projectId: "p1" },
        claimFilter: "personal-only",
      },
      deps(rows)
    )
    const projectHits = await retrieveMemories(
      {
        ...base,
        queryText: "pnpm workspaces",
        reader: { projectId: "p1" },
        claimFilter: "project-only",
      },
      deps(rows)
    )
    expect(personalHits.map((h) => h.memory.id)).toEqual(["personal-1"])
    expect(projectHits.map((h) => h.memory.id)).toEqual(["claim-1"])
  })
})

describe("retrieval telemetry", () => {
  const telemetryDeps = (
    record: MemoryRetrieverDeps["telemetry"] extends infer T ? NonNullable<T>["record"] : never
  ): MemoryRetrieverDeps => ({
    loadCandidates: async () => [mem("The user prefers pnpm over npm", { id: "hit" })],
    telemetry: {
      profileFingerprint: "fp-1",
      generationId: "gen-1",
      createTraceId: () => "trace-1",
      record,
    },
  })

  it("does not wait for the trace write before returning hits", async () => {
    // `record` is wired to an IndexedDB write in production. Awaiting it put a
    // control-plane round trip on the chat send path.
    let settleRecord: (() => void) | null = null
    const recorded = new Promise<void>((resolve) => {
      settleRecord = resolve
    })
    const record = jest.fn(() => recorded)

    const outcome = await retrieveMemoriesWithOutcome(
      { ...base, queryText: "pnpm" },
      telemetryDeps(record)
    )

    // Resolved while the write is still outstanding.
    expect(record).toHaveBeenCalledTimes(1)
    expect(outcome.hits.map((hit) => hit.memory.id)).toEqual(["hit"])
    settleRecord?.()
    await recorded
  })

  it("swallows a rejected trace write instead of failing the recall", async () => {
    const record = jest.fn(() => Promise.reject(new Error("dexie is busy")))
    const outcome = await retrieveMemoriesWithOutcome(
      { ...base, queryText: "pnpm" },
      telemetryDeps(record)
    )
    expect(outcome.hits.map((hit) => hit.memory.id)).toEqual(["hit"])
    // Give the swallowed rejection a turn to surface as an unhandled one.
    await Promise.resolve()
  })

  it("skips the query digest when no telemetry is configured", async () => {
    const outcome = await retrieveMemoriesWithOutcome(
      { ...base, queryText: "pnpm" },
      {
        loadCandidates: async () => [mem("The user prefers pnpm over npm", { id: "hit" })],
      }
    )
    expect(outcome.trace.queryHash).toBe("")
    expect(outcome.hits.map((hit) => hit.memory.id)).toEqual(["hit"])
  })

  it("hashes the query rather than carrying it when telemetry is configured", async () => {
    const outcome = await retrieveMemoriesWithOutcome(
      { ...base, queryText: "pnpm" },
      telemetryDeps(jest.fn())
    )
    expect(outcome.trace.queryHash).toMatch(/^[0-9a-f]{64}$/)
    expect(outcome.trace.queryHash).not.toContain("pnpm")
  })
})

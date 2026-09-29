import type { Memory } from "../types/memory"
import {
  retrieveMemories,
  retrieveMemoriesWithOutcome,
  __resetMemoryBm25Cache,
  isMemoryEligibleForRetrieval,
  type MemoryRetrieverDeps,
} from "./retriever"
import type { MemoryReranker } from "./llm-rerank"

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
    // The vector leg ran with the caller-supplied vector, scoped to the
    // authorized candidate's vector doc id — never a global search.
    expect(vectorSearch).toHaveBeenCalledWith([0.9, 0.8], expect.any(Number), {
      vectorDocIds: ["vsem"],
      signal: expect.any(AbortSignal),
    })
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
    expect(vectorSearch).toHaveBeenCalledWith([0.9, 0.8], expect.any(Number), {
      vectorDocIds: ["vsem"],
      signal: expect.any(AbortSignal),
    })
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
    record: NonNullable<MemoryRetrieverDeps["telemetry"]>["record"]
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
    let settleRecord!: () => void
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
    settleRecord()
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

describe("recall cache and vector validation regressions", () => {
  it("rebuilds when corpus membership changes without changing count or newest timestamp", async () => {
    let corpus = [
      mem("pnpm workspace", { id: "old", updatedAt: 100 }),
      mem("yarn", { id: "newest", updatedAt: 200 }),
    ]
    const deps = { loadCandidates: async () => corpus }
    await retrieveMemories({ ...base, queryText: "pnpm" }, deps)
    corpus = [mem("pnpm replacement", { id: "replacement", updatedAt: 100 }), corpus[1]]
    const outcome = await retrieveMemoriesWithOutcome({ ...base, queryText: "pnpm" }, deps)
    expect(outcome.hits.map((hit) => hit.memory.id)).toEqual(["replacement"])
    expect(outcome.trace.cacheHit).toBe(false)
  })

  it("rebuilds when a non-newest row changes its text, even at the same timestamp", async () => {
    const corpus = [
      mem("pnpm", { id: "edited", updatedAt: 100 }),
      mem("yarn", { id: "newest", updatedAt: 200 }),
    ]
    const deps = { loadCandidates: async () => corpus }
    await retrieveMemories({ ...base, queryText: "pnpm" }, deps)
    corpus[0].text = "cargo"
    const outcome = await retrieveMemoriesWithOutcome({ ...base, queryText: "cargo" }, deps)
    expect(outcome.hits.map((hit) => hit.memory.id)).toEqual(["edited"])
    expect(outcome.trace.cacheHit).toBe(false)
  })

  it.each([[[NaN]], [[Infinity]], [[]]])(
    "rejects an invalid query embedding %j before vector search",
    async (embedding) => {
      const vectorSearch = jest.fn(async () => [])
      const outcome = await retrieveMemoriesWithOutcome(
        { ...base, queryText: "pnpm", precomputedQueryEmbedding: embedding },
        { loadCandidates: async () => [mem("pnpm")], vectorSearch }
      )
      expect(vectorSearch).not.toHaveBeenCalled()
      expect(outcome.hits).toHaveLength(1)
      expect(outcome.reasons).toContainEqual({
        code: "vector_dimension_mismatch",
        stage: "vector",
        retryable: false,
      })
    }
  )
})

it("does not block recall on an outstanding access metadata write", async () => {
  let finish!: () => void
  const pending = new Promise<void>((resolve) => {
    finish = resolve
  })
  const result = await retrieveMemories(
    { ...base, queryText: "pnpm" },
    {
      loadCandidates: async () => [mem("pnpm")],
      touch: () => pending,
    }
  )
  expect(result).toHaveLength(1)
  finish()
  await pending
})

describe("bounded vector recall", () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it("returns BM25 at the deadline, aborts embedding, and never starts a late vector search", async () => {
    let finish!: (embedding: number[]) => void
    const embed = jest.fn(
      (_text: string, _options?: { signal?: AbortSignal }) =>
        new Promise<number[]>((resolve) => {
          finish = resolve
        })
    )
    const vectorSearch = jest.fn(async () => [])
    const deps: MemoryRetrieverDeps = {
      loadCandidates: async () => [mem("pnpm")],
      embed,
      vectorSearch,
    }
    const resultPromise = retrieveMemoriesWithOutcome(
      { ...base, queryText: "pnpm", vectorTimeoutMs: 50 },
      deps
    )
    await jest.advanceTimersByTimeAsync(50)
    const result = await resultPromise
    expect(result.hits).toHaveLength(1)
    expect(result.reasons).toContainEqual({
      code: "retrieval_timeout",
      stage: "vector",
      retryable: true,
    })
    expect(embed.mock.calls[0][1]?.signal?.aborted).toBe(true)
    const repeated = await retrieveMemoriesWithOutcome({ ...base, queryText: "pnpm" }, deps)
    expect(repeated.hits).toHaveLength(1)
    expect(embed).toHaveBeenCalledTimes(1)
    finish([0.1])
    await jest.advanceTimersByTimeAsync(0)
    expect(vectorSearch).not.toHaveBeenCalled()
    expect(result.reasons).toHaveLength(1)
  })

  it("deduplicates concurrent identical scopes but never shares another reader's corpus", async () => {
    let finish!: (embedding: number[]) => void
    const embed = jest.fn(
      () =>
        new Promise<number[]>((resolve) => {
          finish = resolve
        })
    )
    const deps: MemoryRetrieverDeps = {
      loadCandidates: async () => [mem("pnpm", { vectorDocId: "v" })],
      embed,
      vectorSearch: async () => [],
    }
    const first = retrieveMemoriesWithOutcome({ ...base, queryText: "pnpm" }, deps)
    const second = retrieveMemoriesWithOutcome({ ...base, queryText: "pnpm" }, deps)
    await jest.advanceTimersByTimeAsync(0)
    expect(embed).toHaveBeenCalledTimes(1)
    finish([0.1])
    await Promise.all([first, second])
  })

  it("aborts a pending vector search on caller cancellation without waiting for the deadline", async () => {
    let finish!: (hits: { id: string; score: number }[]) => void
    const vectorSearch = jest.fn(
      (_embedding, _topK, _plan) =>
        new Promise<{ id: string; score: number }[]>((resolve) => {
          finish = resolve
        })
    )
    const controller = new AbortController()
    const resultPromise = retrieveMemoriesWithOutcome(
      { ...base, queryText: "pnpm", precomputedQueryEmbedding: [0.1], signal: controller.signal },
      {
        loadCandidates: async () => [mem("pnpm", { vectorDocId: "v" })],
        vectorSearch,
      }
    )
    await jest.advanceTimersByTimeAsync(0)
    controller.abort()
    const result = await resultPromise
    expect(result.hits).toHaveLength(1)
    expect(vectorSearch.mock.calls[0][2].signal.aborted).toBe(true)
    expect(result.reasons[0].code).toBe("retrieval_timeout")
    finish([{ id: "v", score: 1 }])
    await jest.advanceTimersByTimeAsync(0)
  })

  it("caps stalled operations across newly constructed dependencies and releases slots when they settle", async () => {
    const finishers: Array<(embedding: number[]) => void> = []
    const embed = jest.fn(
      () =>
        new Promise<number[]>((resolve) => {
          finishers.push(resolve)
        })
    )
    const pending = Array.from({ length: 10 }, (_, i) =>
      retrieveMemoriesWithOutcome(
        { ...base, queryText: `pnpm ${i}`, vectorTimeoutMs: 10 },
        {
          loadCandidates: async () => [mem("pnpm")],
          embed,
          vectorSearch: async () => [],
        }
      )
    )
    await jest.advanceTimersByTimeAsync(10)
    const results = await Promise.all(pending)
    expect(embed).toHaveBeenCalledTimes(8)
    expect(
      results.every(
        (result) => result.hits.length === 1 && result.reasons[0].code === "retrieval_timeout"
      )
    ).toBe(true)
    finishers.forEach((finish) => finish([0.1]))
    await jest.advanceTimersByTimeAsync(0)
    const vectorSearch = jest.fn(async () => [])
    await retrieveMemoriesWithOutcome(
      { ...base, queryText: "pnpm", precomputedQueryEmbedding: [0.1] },
      {
        loadCandidates: async () => [mem("pnpm")],
        vectorSearch,
      }
    )
    expect(vectorSearch).toHaveBeenCalledTimes(1)
  })

  it("does not start vector work when already cancelled or explicitly given a zero budget", async () => {
    const embed = jest.fn(async () => [0.1])
    const controller = new AbortController()
    controller.abort()
    const deps: MemoryRetrieverDeps = {
      loadCandidates: async () => [mem("pnpm")],
      embed,
      vectorSearch: async () => [],
    }
    const cancelled = await retrieveMemoriesWithOutcome(
      { ...base, queryText: "pnpm", signal: controller.signal },
      deps
    )
    const zero = await retrieveMemoriesWithOutcome(
      { ...base, queryText: "pnpm", vectorTimeoutMs: 0 },
      deps
    )
    expect(cancelled.hits).toHaveLength(1)
    expect(zero.hits).toHaveLength(1)
    expect(embed).not.toHaveBeenCalled()
  })
})

it("keeps concurrent lexical-only reads independent of remote-work capacity", async () => {
  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      retrieveMemoriesWithOutcome(
        { ...base, queryText: "pnpm" },
        { loadCandidates: async () => [mem("pnpm")] }
      )
    )
  )
  expect(
    results.every(
      (result) => result.reasons.length === 1 && result.reasons[0].code === "vector_not_configured"
    )
  ).toBe(true)
})

describe("historical (asOf) recall", () => {
  const T0 = 1_700_000_000_000
  const HOUR = 60 * 60 * 1000

  // Live memory L was reworded at T0 + 10h; the snapshot keeps its first wording.
  const live = () =>
    mem("we build the cache with pnpm", {
      id: "L",
      createdAt: T0,
      revisedAt: T0 + 10 * HOUR,
      vectorDocId: "vL",
    })
  const snapshot = () =>
    mem("we build the cache with npm", {
      id: "S",
      createdAt: T0,
      revisedAt: T0,
      status: "invalidated",
      invalidatedAt: T0 + 10 * HOUR,
      supersededById: "L",
      revisionOf: "L",
    })

  it("returns the earlier wording from a snapshot row", async () => {
    const loadCandidates = jest.fn(async () => [live()])
    const deps: MemoryRetrieverDeps = {
      loadCandidates,
      loadHistoricalCandidates: async () => [live(), snapshot()],
    }
    const past = await retrieveMemories(
      { ...base, queryText: "cache", asOf: T0 + 5 * HOUR, now: T0 + 20 * HOUR },
      deps
    )
    expect(past.map((r) => r.memory.id)).toEqual(["S"])
    expect(past[0].memory.text).toBe("we build the cache with npm")
    expect(loadCandidates).not.toHaveBeenCalled()

    const later = await retrieveMemories(
      { ...base, queryText: "cache", asOf: T0 + 15 * HOUR, now: T0 + 20 * HOUR },
      deps
    )
    expect(later.map((r) => r.memory.id)).toEqual(["L"])
  })

  it("excludes memories created after asOf and memories invalidated before it", async () => {
    const deps: MemoryRetrieverDeps = {
      loadCandidates: async () => [],
      loadHistoricalCandidates: async () => [
        mem("cache note that existed", { id: "kept", createdAt: T0 }),
        mem("cache note from the future", { id: "future", createdAt: T0 + 8 * HOUR }),
        mem("cache note forgotten early", {
          id: "forgotten",
          createdAt: T0,
          status: "invalidated",
          invalidatedAt: T0 + 2 * HOUR,
        }),
        mem("cache note forgotten later", {
          id: "forgotten-later",
          createdAt: T0,
          status: "invalidated",
          invalidatedAt: T0 + 9 * HOUR,
        }),
        mem("cache note in conflict", { id: "conflict", createdAt: T0, reviewStatus: "conflict" }),
      ],
    }
    const out = await retrieveMemories(
      { ...base, queryText: "cache", asOf: T0 + 5 * HOUR, now: T0 + 20 * HOUR },
      deps
    )
    expect(out.map((r) => r.memory.id).sort()).toEqual(["forgotten-later", "kept"])
  })

  it("never runs the vector leg and never touches access counters", async () => {
    const embed = jest.fn(async () => [0.1, 0.2])
    const vectorSearch = jest.fn(async () => [{ id: "vL", score: 1 }])
    const touch = jest.fn(async () => undefined)
    const rerank = jest.fn(async () => null)
    const deps: MemoryRetrieverDeps = {
      loadCandidates: async () => [live()],
      loadHistoricalCandidates: async () => [live(), snapshot()],
      embed,
      vectorSearch,
      touch,
      rerank,
    }
    const out = await retrieveMemories(
      { ...base, queryText: "cache", asOf: T0 + 15 * HOUR, rerank: true },
      deps
    )
    expect(out).toHaveLength(1)
    expect(embed).not.toHaveBeenCalled()
    expect(vectorSearch).not.toHaveBeenCalled()
    expect(touch).not.toHaveBeenCalled()
    expect(rerank).not.toHaveBeenCalled()
  })

  it("returns [] when the host cannot load history, without answering from the present", async () => {
    const loadCandidates = jest.fn(async () => [live()])
    const out = await retrieveMemories(
      { ...base, queryText: "cache", asOf: T0 + 15 * HOUR },
      { loadCandidates }
    )
    expect(out).toEqual([])
    expect(loadCandidates).not.toHaveBeenCalled()
  })

  it("ignores a non-finite asOf and recalls the present", async () => {
    const loadHistoricalCandidates = jest.fn(async () => [snapshot()])
    const out = await retrieveMemories(
      { ...base, queryText: "cache", asOf: Number.NaN },
      { loadCandidates: async () => [live()], loadHistoricalCandidates }
    )
    expect(out.map((r) => r.memory.id)).toEqual(["L"])
    expect(loadHistoricalCandidates).not.toHaveBeenCalled()
  })

  it("keeps one row per memory identity, preferring the most recently effective text", async () => {
    // A corrupted chain: two snapshots of L both claim to be live at asOf.
    const older = mem("cache text one", {
      id: "S1",
      createdAt: T0,
      revisedAt: T0,
      status: "invalidated",
      invalidatedAt: T0 + 20 * HOUR,
      revisionOf: "L",
    })
    const newer = mem("cache text two", {
      id: "S2",
      createdAt: T0,
      revisedAt: T0 + 2 * HOUR,
      status: "invalidated",
      invalidatedAt: T0 + 20 * HOUR,
      revisionOf: "L",
    })
    const out = await retrieveMemories(
      { ...base, queryText: "cache", asOf: T0 + 5 * HOUR },
      { loadCandidates: async () => [], loadHistoricalCandidates: async () => [older, newer] }
    )
    expect(out.map((r) => r.memory.id)).toEqual(["S2"])
  })
})

describe("ranking extensions", () => {
  const NOW = 1_700_000_000_000
  // Equal-length texts → equal BM25 relevance for "cache". Importance decides
  // the local order: sem (6) > epi (5) > low (1).
  const corpus = () => [
    mem("we cache with redis", { id: "sem", type: "semantic", importance: 6 }),
    mem("we cache with memcached", { id: "epi", type: "episodic", importance: 5 }),
    mem("we cache with disk", { id: "low", type: "semantic", importance: 1 }),
  ]
  const ids = (hits: { memory: Memory }[]) => hits.map((h) => h.memory.id)

  describe("sessionRecallRouting", () => {
    it("ranks by the local score without routing", async () => {
      const out = await retrieveMemories(
        { ...base, queryText: "last time cache", now: NOW },
        { loadCandidates: async () => corpus() }
      )
      expect(ids(out)).toEqual(["sem", "epi", "low"])
    })

    it("boosts episodic hits when the query asks about a past conversation", async () => {
      const out = await retrieveMemories(
        { ...base, queryText: "last time cache", now: NOW, sessionRecallRouting: true },
        { loadCandidates: async () => corpus() }
      )
      expect(ids(out)).toEqual(["epi", "sem", "low"])
      const epi = out.find((h) => h.memory.id === "epi")!
      const sem = out.find((h) => h.memory.id === "sem")!
      expect(epi.score).toBeGreaterThan(sem.score)
    })

    it("does not boost when the query has no session-recall intent", async () => {
      const out = await retrieveMemories(
        { ...base, queryText: "cache", now: NOW, sessionRecallRouting: true },
        { loadCandidates: async () => corpus() }
      )
      expect(ids(out)).toEqual(["sem", "epi", "low"])
    })
  })

  describe("beliefRankingWeight", () => {
    const withBelief = () =>
      corpus().map((m) =>
        m.id === "epi" ? { ...m, beliefInputs: { evidenceCount: 20, distinctSessions: 20 } } : m
      )

    it("leaves ranking unchanged at 0 / absent", async () => {
      for (const beliefRankingWeight of [undefined, 0, -1, Number.NaN]) {
        const out = await retrieveMemories(
          { ...base, queryText: "cache", now: NOW, beliefRankingWeight },
          { loadCandidates: async () => withBelief() }
        )
        expect(ids(out)).toEqual(["sem", "epi", "low"])
      }
    })

    it("promotes a well-corroborated memory when weighted", async () => {
      const out = await retrieveMemories(
        { ...base, queryText: "cache", now: NOW, beliefRankingWeight: 1 },
        { loadCandidates: async () => withBelief() }
      )
      expect(ids(out)).toEqual(["epi", "sem", "low"])
    })

    it("divides belief by live contradictions", async () => {
      const contradicted = () =>
        withBelief().map((m) =>
          m.id === "epi" ? { ...m, conflictWithIds: ["x", "y", "z", "w", "v", "u", "t"] } : m
        )
      const out = await retrieveMemories(
        { ...base, queryText: "cache", now: NOW, beliefRankingWeight: 1 },
        { loadCandidates: async () => contradicted() }
      )
      // 0.95 / 8 ≈ 0.12 < the 0.2 importance gap.
      expect(ids(out)).toEqual(["sem", "epi", "low"])
    })
  })

  describe("rerank", () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        mem(`we cache item ${i}`, {
          id: `r${String(i).padStart(2, "0")}`,
          importance: 10 - (i % 10),
        })
      )

    it("calls deps.rerank with a window of max(topK, min(3·topK, 30))", async () => {
      const rerank = jest.fn<ReturnType<MemoryReranker>, Parameters<MemoryReranker>>(
        async () => null
      )
      await retrieveMemories(
        { queryText: "cache", topK: 2, relevanceFloor: 0, now: NOW, rerank: true },
        { loadCandidates: async () => many(10), rerank }
      )
      expect(rerank).toHaveBeenCalledTimes(1)
      expect(rerank.mock.calls[0][1]).toHaveLength(6)

      rerank.mockClear()
      await retrieveMemories(
        { queryText: "cache", topK: 20, relevanceFloor: 0, now: NOW, rerank: true },
        { loadCandidates: async () => many(40), rerank }
      )
      expect(rerank.mock.calls[0][1]).toHaveLength(30)

      rerank.mockClear()
      await retrieveMemories(
        { queryText: "cache", topK: 35, relevanceFloor: 0, now: NOW, rerank: true },
        { loadCandidates: async () => many(40), rerank }
      )
      expect(rerank.mock.calls[0][1]).toHaveLength(35)
    })

    it("passes query, candidate texts, the caller signal and the configured timeout", async () => {
      const rerank = jest.fn(async () => null)
      const controller = new AbortController()
      await retrieveMemories(
        { ...base, queryText: "cache", now: NOW, rerank: true, signal: controller.signal },
        { loadCandidates: async () => corpus(), rerank, rerankTimeoutMs: 1234 }
      )
      const [query, candidates, options] = rerank.mock.calls[0] as unknown as [
        string,
        { id: string; text: string }[],
        { signal?: AbortSignal; timeoutMs?: number },
      ]
      expect(query).toBe("cache")
      expect(candidates).toEqual([
        { id: "sem", text: "we cache with redis" },
        { id: "epi", text: "we cache with memcached" },
        { id: "low", text: "we cache with disk" },
      ])
      expect(options).toEqual({ signal: controller.signal, timeoutMs: 1234 })
    })

    it("reorders the window by the model's relevance, then trims to topK", async () => {
      const rerank = jest.fn(
        async () =>
          new Map([
            ["sem", 0.1],
            ["epi", 0.2],
            ["low", 0.9],
          ])
      )
      const out = await retrieveMemories(
        { queryText: "cache", topK: 2, relevanceFloor: 0, now: NOW, rerank: true },
        { loadCandidates: async () => corpus(), rerank }
      )
      expect(ids(out)).toEqual(["low", "epi"])
    })

    it("keeps positions outside the window after the reranked prefix", async () => {
      // topK 1 → window max(1, min(3, 30)) = 3; ranks 4+ keep their local order.
      const rerank = jest.fn(
        async (_q: string, c: readonly { id: string }[]) =>
          new Map(c.map((entry, i) => [entry.id, i / 10]))
      )
      const outcome = await retrieveMemoriesWithOutcome(
        { queryText: "cache", topK: 1, relevanceFloor: 0, now: NOW, rerank: true },
        { loadCandidates: async () => many(6), rerank }
      )
      const window = rerank.mock.calls[0][1].map((c) => c.id)
      expect(window).toHaveLength(3)
      // The model scored the window's last entry highest.
      expect(ids(outcome.hits)).toEqual([window[2]])
    })

    it("keeps the local order when the reranker answers null or throws", async () => {
      for (const rerank of [
        jest.fn(async () => null),
        jest.fn(async () => {
          throw new Error("boom")
        }),
      ]) {
        const out = await retrieveMemories(
          { ...base, queryText: "cache", now: NOW, rerank: true },
          { loadCandidates: async () => corpus(), rerank }
        )
        expect(rerank).toHaveBeenCalled()
        expect(ids(out)).toEqual(["sem", "epi", "low"])
      }
    })

    it("does not call the reranker when rerank is off or fewer than 2 hits", async () => {
      const rerank = jest.fn(async () => null)
      await retrieveMemories(
        { ...base, queryText: "cache", now: NOW },
        { loadCandidates: async () => corpus(), rerank }
      )
      await retrieveMemories(
        { ...base, queryText: "cache", now: NOW, rerank: false },
        { loadCandidates: async () => corpus(), rerank }
      )
      await retrieveMemories(
        { ...base, queryText: "redis", now: NOW, rerank: true },
        { loadCandidates: async () => corpus(), rerank }
      )
      expect(rerank).not.toHaveBeenCalled()
    })
  })

  describe("deps.defaults", () => {
    it("applies defaults when the request leaves fields undefined", async () => {
      const rerank = jest.fn(async () => null)
      const out = await retrieveMemories(
        { ...base, queryText: "last time cache", now: NOW },
        {
          loadCandidates: async () => corpus(),
          rerank,
          defaults: { sessionRecallRouting: true, rerank: true },
        }
      )
      expect(ids(out)).toEqual(["epi", "sem", "low"])
      expect(rerank).toHaveBeenCalledTimes(1)
    })

    it("applies a default belief weight", async () => {
      const out = await retrieveMemories(
        { ...base, queryText: "cache", now: NOW },
        {
          loadCandidates: async () =>
            corpus().map((m) =>
              m.id === "epi"
                ? { ...m, beliefInputs: { evidenceCount: 20, distinctSessions: 20 } }
                : m
            ),
          defaults: { beliefRankingWeight: 1 },
        }
      )
      expect(ids(out)).toEqual(["epi", "sem", "low"])
    })

    it("lets explicit request fields override the defaults", async () => {
      const rerank = jest.fn(async () => null)
      const out = await retrieveMemories(
        {
          ...base,
          queryText: "last time cache",
          now: NOW,
          sessionRecallRouting: false,
          rerank: false,
        },
        {
          loadCandidates: async () => corpus(),
          rerank,
          defaults: { sessionRecallRouting: true, rerank: true },
        }
      )
      expect(ids(out)).toEqual(["sem", "epi", "low"])
      expect(rerank).not.toHaveBeenCalled()
    })
  })
})

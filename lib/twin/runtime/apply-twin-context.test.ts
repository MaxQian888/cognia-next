/**
 * Integration coverage for `applyTwinContext`. Uses fake-indexeddb +
 * in-memory IVectorStore + jest.spyOn for `generateEmbedding` so the
 * test exercises the full Dexie + retrieval path without touching the
 * network.
 */

import "fake-indexeddb/auto"

// Mock the embedding module before any imports that reach into it.
// `applyTwinContext` calls `generateEmbedding` for the user message; the
// helper below lets each test pin the resolved value or trigger a reject.
let mockEmbeddingResult: { embedding: number[] } | Error | string = { embedding: [0.1, 0.2, 0.3] }
jest.mock("@/lib/ai/embedding/embedding", () => ({
  generateEmbedding: jest.fn(async () => {
    if (mockEmbeddingResult instanceof Error) throw mockEmbeddingResult
    if (typeof mockEmbeddingResult === "string") throw mockEmbeddingResult
    return { ...mockEmbeddingResult, usage: undefined }
  }),
  generateEmbeddings: jest.fn(async () => ({ embeddings: [], usage: undefined })),
}))

// Wrap getTwinProfile / keywordSearch as jest.fns that call through to the real
// implementation by default. Module exports are non-configurable getters under
// the ts-jest transform, so spyOn can't redefine them — a mock factory is the
// only way to override these per-test (T2.3 degradation tests).
jest.mock("@/lib/db/twin-profile", () => {
  const actual = jest.requireActual("@/lib/db/twin-profile")
  return { ...actual, getTwinProfile: jest.fn(actual.getTwinProfile) }
})
jest.mock("./bm25-index", () => {
  const actual = jest.requireActual("./bm25-index")
  return { ...actual, keywordSearch: jest.fn(actual.keywordSearch) }
})

import { applyTwinContext, __flushStyleBackfills } from "./apply-twin-context"
import type { ApplyTwinContextDeps } from "./apply-twin-context"
import { getPluginEventHooks } from "@/lib/plugin"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { createTwinSource } from "@/lib/db/twin-sources"
import { bulkCreateTwinChunks } from "@/lib/db/twin-chunks"
import { ensureTwinProfile, appendStyleSamples, getTwinProfile } from "@/lib/db/twin-profile"
import { __resetTwinBm25Cache, keywordSearch } from "./bm25-index"
import type { Character } from "@/lib/claude/types"
import type { IVectorStore, VectorSearchResult, SearchOptions } from "@/lib/vector/store"

beforeEach(async () => {
  // Settle any fire-and-forget style backfill from the previous case against
  // the old DB before we tear it down, so it can't write into the next test.
  await __flushStyleBackfills()
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  const db = getDb()
  await Promise.all([db.twinSources.clear(), db.twinChunks.clear(), db.twinProfile.clear()])
  __resetTwinBm25Cache()
})

function makeCharacter(overrides: Partial<Character> = {}): Character {
  return {
    id: "char_1",
    name: "Twin Alice",
    avatarColor: "#000",
    systemPrompt: "BASE_SYSTEM_PROMPT",
    twinId: "twin_alice",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

interface FakeStoreOptions {
  onSearch?: (
    collection: string,
    embedding: number[],
    options?: SearchOptions
  ) => VectorSearchResult[]
  shouldThrow?: boolean
}

function makeFakeStore(opts: FakeStoreOptions = {}): IVectorStore {
  return {
    provider: "qdrant",
    addDocuments: jest.fn(async () => undefined),
    updateDocuments: jest.fn(async () => undefined),
    deleteDocuments: jest.fn(async () => undefined),
    searchDocuments: jest.fn(async () => []),
    searchByEmbedding: jest.fn(async (collection, embedding, options) => {
      if (opts.shouldThrow) throw new Error("vector-store offline")
      return opts.onSearch ? opts.onSearch(collection, embedding, options) : []
    }),
    getDocuments: jest.fn(async () => []),
    createCollection: jest.fn(async () => undefined),
    deleteCollection: jest.fn(async () => undefined),
    listCollections: jest.fn(async () => []),
    getCollectionInfo: jest.fn(async () => ({ name: "x", documentCount: 0 })),
  }
}

const FAKE_EMBEDDING = [0.1, 0.2, 0.3]

const baseDeps: ApplyTwinContextDeps = {
  store: makeFakeStore(),
  embedding: {
    provider: "openai",
    model: "text-embedding-3-small",
    apiKey: "sk-test",
  },
}

beforeEach(() => {
  mockEmbeddingResult = { embedding: FAKE_EMBEDDING }
})

function mockEmbedding(returnValue: number[] = FAKE_EMBEDDING) {
  mockEmbeddingResult = { embedding: returnValue }
}

function mockEmbeddingFailure(error: Error | string) {
  mockEmbeddingResult = error
}

describe("applyTwinContext", () => {
  it("returns null applied result when character has no twinId", async () => {
    mockEmbedding()
    const result = await applyTwinContext({
      character: makeCharacter({ twinId: undefined }),
      userMessage: "hi",
      deps: baseDeps,
    })
    expect(result.applied).toBeNull()
    expect(result.degraded).toBe(false)
  })

  it("renders an identity-only prompt when the profile is empty", async () => {
    mockEmbedding()
    const result = await applyTwinContext({
      character: makeCharacter(),
      userMessage: "hi",
      deps: { ...baseDeps, store: makeFakeStore() },
    })
    expect(result.applied).not.toBeNull()
    expect(result.applied?.systemPrompt).toContain("BASE_SYSTEM_PROMPT")
    expect(result.applied?.systemPrompt).toContain("You are Twin Alice.")
    expect(result.applied?.metadata.retrievedChunkIds).toEqual([])
  })

  it("injects retrieved chunks + their source titles into the prompt", async () => {
    mockEmbedding()

    const source = await createTwinSource({
      twinId: "twin_alice",
      kind: "document",
      format: "markdown",
      source: "/notes.md",
      title: "Onboarding notes",
      bytes: 100,
      fingerprint: "f1",
      redacted: false,
    })
    const [chunk] = await bulkCreateTwinChunks([
      {
        twinId: "twin_alice",
        sourceId: source.id,
        content: "Welcome to the team",
        contentRedacted: "Welcome to the team",
        charStart: 0,
        charEnd: 19,
        vectorBackend: "qdrant",
        vectorCollection: "cognia_twin_twin_alice",
        vectorDocId: "vec_1",
        strategy: "paragraph",
        tokenCount: 5,
        metadata: {},
      },
    ])

    const store = makeFakeStore({
      onSearch: () => [{ id: chunk.vectorDocId, content: "Welcome to the team", score: 0.91 }],
    })

    const result = await applyTwinContext({
      character: makeCharacter(),
      userMessage: "what should I do on day one?",
      deps: { ...baseDeps, store },
    })

    expect(result.applied?.systemPrompt).toContain("## Relevant historical material")
    expect(result.applied?.systemPrompt).toContain("Onboarding notes (score 0.91)")
    expect(result.applied?.metadata.retrievedChunkIds).toEqual([chunk.id])
    expect(result.degraded).toBe(false)
  })

  it("surfaces a BM25-only match via hybrid fusion that pure vector search missed", async () => {
    mockEmbedding()
    const source = await createTwinSource({
      twinId: "twin_alice",
      kind: "document",
      format: "markdown",
      source: "/finance.md",
      title: "Finance runbook",
      bytes: 100,
      fingerprint: "f-hybrid",
      redacted: false,
    })
    await bulkCreateTwinChunks([
      {
        twinId: "twin_alice",
        sourceId: source.id,
        content: "team onboarding overview and welcome",
        contentRedacted: "team onboarding overview and welcome",
        charStart: 0,
        charEnd: 36,
        vectorBackend: "qdrant",
        vectorCollection: "cognia_twin_twin_alice",
        vectorDocId: "vec_sem",
        strategy: "paragraph",
        tokenCount: 6,
        metadata: {},
      },
      {
        twinId: "twin_alice",
        sourceId: source.id,
        content: "annual payroll reconciliation procedure",
        contentRedacted: "annual payroll reconciliation procedure",
        charStart: 0,
        charEnd: 39,
        vectorBackend: "qdrant",
        vectorCollection: "cognia_twin_twin_alice",
        vectorDocId: "vec_kw",
        strategy: "paragraph",
        tokenCount: 5,
        metadata: {},
      },
    ])
    // Vector search returns ONLY the semantic chunk — it misses the keyword one.
    const store = makeFakeStore({
      onSearch: () => [
        { id: "vec_sem", content: "team onboarding overview and welcome", score: 0.9 },
      ],
    })
    const character = makeCharacter({
      twinSettings: { enableRag: true, enableHybrid: true, hybridKeywordWeight: 0.5 },
    })
    const result = await applyTwinContext({
      character,
      userMessage: "what is the payroll reconciliation procedure?",
      deps: { ...baseDeps, store },
    })
    const ids = result.applied?.metadata.retrievedChunkIds ?? []
    const contents = result.retrievedChunks.map((rc) => rc.chunk.content)
    // BM25 lane pulls in the keyword chunk that the vector lane never returned.
    expect(contents).toContain("annual payroll reconciliation procedure")
    expect(ids.length).toBeGreaterThanOrEqual(2)
    expect(result.degraded).toBe(false)
  })

  it("degrades cleanly when embedding fails", async () => {
    mockEmbeddingFailure(new Error("openai is down"))
    const result = await applyTwinContext({
      character: makeCharacter(),
      userMessage: "anything",
      deps: baseDeps,
    })
    expect(result.degraded).toBe(true)
    expect(result.degradedReason).toContain("embed-failed")
    // Still produces a usable prompt — just without RAG / few-shot.
    expect(result.applied?.systemPrompt).toContain("You are Twin Alice.")
  })

  it("degrades when the vector store call throws", async () => {
    mockEmbedding()
    const store = makeFakeStore({ shouldThrow: true })
    const result = await applyTwinContext({
      character: makeCharacter(),
      userMessage: "anything",
      deps: { ...baseDeps, store },
    })
    expect(result.degraded).toBe(true)
    expect(result.degradedReason).toContain("retrieve-failed")
  })

  it("includes style few-shot samples when enableStyleFewShot is true", async () => {
    mockEmbedding()
    await ensureTwinProfile("twin_alice")
    await appendStyleSamples("twin_alice", [
      {
        id: "ss_1",
        contextLabel: "rejection",
        original: "Sorry, not now.",
        summary: "polite rejection",
        sourceChunkId: "c1",
        tone: ["concise"],
        addedAt: 1,
        addedBy: "distill",
      },
    ])
    const result = await applyTwinContext({
      character: makeCharacter(),
      userMessage: "draft a polite no",
      deps: baseDeps,
    })
    expect(result.applied?.systemPrompt).toContain("## Style examples")
    expect(result.applied?.metadata.styleSampleIds).toEqual(["ss_1"])
  })

  it("lazily backfills missing style-sample embeddings in the background", async () => {
    mockEmbedding([0.5, 0.5, 0.5])
    await ensureTwinProfile("twin_alice")
    await appendStyleSamples("twin_alice", [
      {
        id: "ss_nofill",
        contextLabel: "rejection",
        original: "Sorry, not now.",
        summary: "polite rejection",
        sourceChunkId: "c1",
        tone: ["concise"],
        addedAt: 1,
        addedBy: "distill",
      },
    ])
    // Pre-condition: the sample has no embedding yet.
    const before = await getTwinProfile("twin_alice")
    expect(before?.styleSamples[0].embedding).toBeUndefined()

    await applyTwinContext({
      character: makeCharacter(),
      userMessage: "draft a polite no",
      deps: baseDeps,
    })
    // The backfill is fire-and-forget — wait for it to settle.
    await __flushStyleBackfills()

    const after = await getTwinProfile("twin_alice")
    expect(after?.styleSamples[0].embedding).toEqual([0.5, 0.5, 0.5])
  })

  it("respects character.twinSettings.enableRag = false", async () => {
    mockEmbedding()
    const character = makeCharacter({
      twinSettings: { enableRag: false, enableStyleFewShot: true, ragTopK: 6, styleSamplesK: 3 },
    })
    const store = makeFakeStore({
      onSearch: () => [{ id: "vec_1", content: "x", score: 0.9 }],
    })
    const result = await applyTwinContext({
      character,
      userMessage: "anything",
      deps: { ...baseDeps, store },
    })
    expect(store.searchByEmbedding).not.toHaveBeenCalled()
    expect(result.applied?.metadata.retrievedChunkIds).toEqual([])
  })

  it("degrades with 'embed-failed: unknown' when embed rejects with a non-Error value", async () => {
    // Mock embedding to reject with a string instead of Error instance
    mockEmbeddingResult = "non-error rejection"
    const result = await applyTwinContext({
      character: makeCharacter(),
      userMessage: "anything",
      deps: baseDeps,
    })
    expect(result.degraded).toBe(true)
    expect(result.degradedReason).toBe("embed-failed: unknown")
    expect(result.applied?.systemPrompt).toContain("You are Twin Alice.")
  })

  it("degrades with 'retrieve-failed: unknown' when vector store rejects with a non-Error value", async () => {
    mockEmbedding()
    const store: IVectorStore = {
      provider: "qdrant",
      addDocuments: jest.fn(async () => undefined),
      updateDocuments: jest.fn(async () => undefined),
      deleteDocuments: jest.fn(async () => undefined),
      searchDocuments: jest.fn(async () => []),
      searchByEmbedding: jest.fn(async () => {
        // Reject with non-Error value
        throw "vector-store-error-string"
      }),
      getDocuments: jest.fn(async () => []),
      createCollection: jest.fn(async () => undefined),
      deleteCollection: jest.fn(async () => undefined),
      listCollections: jest.fn(async () => []),
      getCollectionInfo: jest.fn(async () => ({ name: "x", documentCount: 0 })),
    }
    const result = await applyTwinContext({
      character: makeCharacter(),
      userMessage: "anything",
      deps: { ...baseDeps, store },
    })
    expect(result.degraded).toBe(true)
    expect(result.degradedReason).toBe("retrieve-failed: unknown")
    expect(result.applied?.systemPrompt).toContain("You are Twin Alice.")
  })

  it("degrades (does not throw) when getTwinProfile fails to load (T2.3)", async () => {
    mockEmbedding()
    ;(getTwinProfile as jest.Mock).mockRejectedValueOnce(new Error("db locked"))
    const result = await applyTwinContext({
      character: makeCharacter(),
      userMessage: "hello",
      deps: baseDeps,
    })
    // Never throws — degrades and still renders the base prompt.
    expect(result.degraded).toBe(true)
    expect(result.degradedReason).toContain("profile-load-failed")
    expect(result.applied?.systemPrompt).toContain("BASE_SYSTEM_PROMPT")
  })

  it("degrades with 'store-no-search' when the store can't search by embedding (T2.3)", async () => {
    mockEmbedding()
    const store = { ...makeFakeStore(), searchByEmbedding: undefined } as unknown as IVectorStore
    const result = await applyTwinContext({
      character: makeCharacter(),
      userMessage: "anything",
      deps: { ...baseDeps, store },
    })
    expect(result.degraded).toBe(true)
    expect(result.degradedReason).toBe("store-no-search")
    expect(result.applied?.systemPrompt).toContain("You are Twin Alice.")
  })

  it("falls back to vector-only (keeping hits) when the BM25 lane throws (T2.3)", async () => {
    mockEmbedding()
    const source = await createTwinSource({
      twinId: "twin_alice",
      kind: "document",
      format: "markdown",
      source: "/v.md",
      title: "Vector doc",
      bytes: 10,
      fingerprint: "f-bm25-throw",
      redacted: false,
    })
    const [chunk] = await bulkCreateTwinChunks([
      {
        twinId: "twin_alice",
        sourceId: source.id,
        content: "vector hit content",
        contentRedacted: "vector hit content",
        charStart: 0,
        charEnd: 18,
        vectorBackend: "qdrant",
        vectorCollection: "cognia_twin_twin_alice",
        vectorDocId: "vec_keep",
        strategy: "paragraph",
        tokenCount: 4,
        metadata: {},
      },
    ])
    const store = makeFakeStore({
      onSearch: () => [{ id: chunk.vectorDocId, content: "vector hit content", score: 0.88 }],
    })
    ;(keywordSearch as jest.Mock).mockRejectedValueOnce(new Error("bm25 index corrupt"))
    const result = await applyTwinContext({
      character: makeCharacter({ twinSettings: { enableHybrid: true } as never }),
      userMessage: "find the vector hit",
      deps: { ...baseDeps, store },
    })
    // Vector hit is preserved (NOT discarded), and the degradation is labelled
    // as the hybrid lane, not a blanket retrieve-failed.
    expect(result.applied?.metadata.retrievedChunkIds).toEqual([chunk.id])
    expect(result.degraded).toBe(true)
    expect(result.degradedReason).toContain("hybrid-bm25-failed")
  })

  it("falls back to twinId for twinName when character.name is empty", async () => {
    mockEmbedding()
    const character = makeCharacter({ name: "" })
    const result = await applyTwinContext({
      character,
      userMessage: "hello",
      deps: baseDeps,
    })
    expect(result.applied?.systemPrompt).toContain("You are twin_alice.")
  })

  it("falls back to twinId for twinName when character.name is undefined", async () => {
    mockEmbedding()
    const character = makeCharacter({ name: undefined })
    const result = await applyTwinContext({
      character,
      userMessage: "hello",
      deps: baseDeps,
    })
    expect(result.applied?.systemPrompt).toContain("You are twin_alice.")
  })

  it("skips internal embed when precomputedQueryEmbedding is provided", async () => {
    const generateEmbeddingMock = jest.requireMock("@/lib/ai/embedding/embedding")
      .generateEmbedding as jest.Mock
    generateEmbeddingMock.mockClear()
    const character = makeCharacter({ twinId: "twin_alice" })
    const result = await applyTwinContext({
      character,
      userMessage: "what did Alice say last month?",
      precomputedQueryEmbedding: [0.1, 0.2, 0.3],
      deps: {
        store: makeFakeStore(),
        embedding: { provider: "openai", model: "text-embedding-3-small", apiKey: "k" },
      },
    })
    expect(generateEmbeddingMock).not.toHaveBeenCalled()
    expect(result.degraded).toBe(false)
  })

  it("dispatches onRAGContextRetrieved with the retrieved chunks", async () => {
    mockEmbedding()
    const source = await createTwinSource({
      twinId: "twin_alice",
      kind: "document",
      format: "markdown",
      source: "/notes.md",
      title: "Onboarding notes",
      bytes: 100,
      fingerprint: "f-rag",
      redacted: false,
    })
    const [chunk] = await bulkCreateTwinChunks([
      {
        twinId: "twin_alice",
        sourceId: source.id,
        content: "the rag-dispatch payload",
        contentRedacted: "the rag-dispatch payload",
        charStart: 0,
        charEnd: 24,
        vectorBackend: "qdrant",
        vectorCollection: "cognia_twin_twin_alice",
        vectorDocId: "vec_rag",
        strategy: "paragraph",
        tokenCount: 4,
        metadata: {},
      },
    ])
    const store = makeFakeStore({
      onSearch: () => [{ id: chunk.vectorDocId, content: "the rag-dispatch payload", score: 0.7 }],
    })
    const dispatchSpy = jest
      .spyOn(getPluginEventHooks(), "dispatchRAGContextRetrieved")
      .mockImplementation(() => {})

    await applyTwinContext({
      character: makeCharacter(),
      userMessage: "rag plz",
      sessionId: "session-rag",
      deps: { ...baseDeps, store },
    })
    expect(dispatchSpy).toHaveBeenCalledWith("session-rag", [
      { id: "vec_rag", content: "the rag-dispatch payload", score: 0.7 },
    ])
  })

  it("falls back to twin:<twinId> when sessionId is omitted on the RAG dispatch", async () => {
    mockEmbedding()
    const source = await createTwinSource({
      twinId: "twin_alice",
      kind: "document",
      format: "markdown",
      source: "/notes.md",
      title: "Onboarding notes",
      bytes: 100,
      fingerprint: "f-rag-2",
      redacted: false,
    })
    const [chunk] = await bulkCreateTwinChunks([
      {
        twinId: "twin_alice",
        sourceId: source.id,
        content: "another payload",
        contentRedacted: "another payload",
        charStart: 0,
        charEnd: 14,
        vectorBackend: "qdrant",
        vectorCollection: "cognia_twin_twin_alice",
        vectorDocId: "vec_rag2",
        strategy: "paragraph",
        tokenCount: 2,
        metadata: {},
      },
    ])
    const store = makeFakeStore({
      onSearch: () => [{ id: chunk.vectorDocId, content: "another payload", score: 0.42 }],
    })
    const dispatchSpy = jest
      .spyOn(getPluginEventHooks(), "dispatchRAGContextRetrieved")
      .mockImplementation(() => {})

    await applyTwinContext({
      character: makeCharacter(),
      userMessage: "no session",
      deps: { ...baseDeps, store },
    })
    expect(dispatchSpy).toHaveBeenCalledWith("twin:twin_alice", expect.any(Array))
  })
})

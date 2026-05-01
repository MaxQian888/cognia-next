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
let mockEmbeddingResult: { embedding: number[] } | Error = { embedding: [0.1, 0.2, 0.3] }
jest.mock("@/lib/ai/embedding/embedding", () => ({
  generateEmbedding: jest.fn(async () => {
    if (mockEmbeddingResult instanceof Error) throw mockEmbeddingResult
    return { ...mockEmbeddingResult, usage: undefined }
  }),
  generateEmbeddings: jest.fn(async () => ({ embeddings: [], usage: undefined })),
}))

import { applyTwinContext } from "./apply-twin-context"
import type { ApplyTwinContextDeps } from "./apply-twin-context"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { createTwinSource } from "@/lib/db/twin-sources"
import { bulkCreateTwinChunks } from "@/lib/db/twin-chunks"
import { ensureTwinProfile, appendStyleSamples } from "@/lib/db/twin-profile"
import type { Character } from "@/lib/claude/types"
import type { IVectorStore, VectorSearchResult, SearchOptions } from "@/lib/vector/store"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  const db = getDb()
  await Promise.all([db.twinSources.clear(), db.twinChunks.clear(), db.twinProfile.clear()])
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

function mockEmbeddingFailure(error: Error) {
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
})

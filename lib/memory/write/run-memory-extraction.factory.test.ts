/**
 * Coverage for `buildAutoExtractionDeps` — the real-wiring factory. All heavy
 * dependencies (LLM client, vector backend, Dexie, retriever, extractor,
 * consolidator) are mocked so we can assert the closures wire correctly without
 * a live backend.
 */

import { DEFAULT_MEMORY_CONFIG, type MemoryConfig } from "@/types/memory/memory"
import type { ConsolidateDeps } from "@/lib/memory/consolidate/consolidator"

const mockBuildClient = jest.fn()
const mockTryBuildMemoryDeps = jest.fn()
const mockTryBuildMemoryVectorSink = jest.fn()
const mockRetrieveMemories = jest.fn()
const mockCreateMemory = jest.fn()
const mockUpdateMemory = jest.fn()
const mockInvalidateMemory = jest.fn()
const mockExtractMemories = jest.fn()
const mockConsolidate = jest.fn()

jest.mock("@/lib/ai/generation/utility-client", () => ({
  buildUtilityLlmClient: (...a: unknown[]) => mockBuildClient(...a),
}))
jest.mock("@/lib/memory/runtime/build-deps", () => ({
  tryBuildMemoryDeps: (...a: unknown[]) => mockTryBuildMemoryDeps(...a),
  tryBuildMemoryVectorSink: (...a: unknown[]) => mockTryBuildMemoryVectorSink(...a),
}))
jest.mock("@/lib/memory/retrieve/retriever", () => ({
  retrieveMemories: (...a: unknown[]) => mockRetrieveMemories(...a),
}))
jest.mock("@/lib/db/memories", () => ({
  createMemory: (...a: unknown[]) => mockCreateMemory(...a),
  updateMemory: (...a: unknown[]) => mockUpdateMemory(...a),
  invalidateMemory: (...a: unknown[]) => mockInvalidateMemory(...a),
}))
jest.mock("@/lib/memory/extract/extractor", () => ({
  extractMemories: (...a: unknown[]) => mockExtractMemories(...a),
}))
jest.mock("@/lib/memory/consolidate/consolidator", () => ({
  consolidate: (...a: unknown[]) => mockConsolidate(...a),
}))

import { buildAutoExtractionDeps } from "./run-memory-extraction"

function cfg(over: Partial<MemoryConfig> = {}): MemoryConfig {
  return { ...DEFAULT_MEMORY_CONFIG, ...over }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockBuildClient.mockReturnValue({ complete: jest.fn() })
  mockTryBuildMemoryDeps.mockResolvedValue({ loadCandidates: jest.fn(), loadProcedural: jest.fn() })
  mockTryBuildMemoryVectorSink.mockResolvedValue(undefined)
  mockRetrieveMemories.mockResolvedValue([{ memory: { id: "sim1" } }])
  mockCreateMemory.mockResolvedValue({ id: "new1", text: "fact" })
})

const params = { session: null, appSettings: null }

describe("buildAutoExtractionDeps", () => {
  it("returns null when no utility client can be built", async () => {
    mockBuildClient.mockReturnValue(null)
    expect(await buildAutoExtractionDeps(params, cfg())).toBeNull()
  })

  it("wires extract to the extractor with the client", async () => {
    mockExtractMemories.mockResolvedValue([{ type: "semantic", text: "x", importance: 5 }])
    const deps = await buildAutoExtractionDeps(params, cfg())
    await deps!.extract({
      newPair: { userText: "u", assistantText: "a" },
      allowTypes: ["semantic"],
    })
    expect(mockExtractMemories).toHaveBeenCalled()
  })

  it("wires consolidate and its ConsolidateDeps closures", async () => {
    let captured: ConsolidateDeps | undefined
    mockConsolidate.mockImplementation(async (_input, deps: ConsolidateDeps) => {
      captured = deps
      return { applied: [] }
    })
    const deps = await buildAutoExtractionDeps(params, cfg())
    await deps!.consolidate({ candidates: [], scope: "global", provenance: "user" })
    expect(captured).toBeDefined()

    // findSimilar → retriever
    const similar = await captured!.findSimilar(
      { type: "semantic", text: "q", importance: 5 },
      "global",
      "char_1"
    )
    expect(mockRetrieveMemories).toHaveBeenCalled()
    expect(similar).toEqual([{ id: "sim1" }])

    // persist → createMemory (no vector sink configured)
    const row = await captured!.persist({
      scope: "global",
      type: "semantic",
      text: "fact",
      importance: 6,
      provenance: "user",
    })
    expect(mockCreateMemory).toHaveBeenCalled()
    expect(row.id).toBe("new1")
    expect(mockUpdateMemory).not.toHaveBeenCalled() // no vectorDocId write without a sink

    // update / invalidate passthrough
    await captured!.update("id1", "newtext")
    expect(mockUpdateMemory).toHaveBeenCalledWith("id1", { text: "newtext", bumpVersion: true })
    await captured!.invalidate("id1", "sup1")
    expect(mockInvalidateMemory).toHaveBeenCalledWith("id1", "sup1")
  })

  it("persist upserts the vector + stamps vectorDocId when a sink exists", async () => {
    const upsert = jest.fn(async () => undefined)
    mockTryBuildMemoryVectorSink.mockResolvedValue({ upsert })
    let captured: ConsolidateDeps | undefined
    mockConsolidate.mockImplementation(async (_i, deps: ConsolidateDeps) => {
      captured = deps
      return { applied: [] }
    })
    const deps = await buildAutoExtractionDeps(params, cfg())
    await deps!.consolidate({ candidates: [], scope: "global", provenance: "user" })

    await captured!.persist({
      scope: "global",
      type: "semantic",
      text: "fact",
      importance: 6,
      provenance: "user",
    })
    expect(upsert).toHaveBeenCalledWith("new1", "fact")
    expect(mockUpdateMemory).toHaveBeenCalledWith("new1", { vectorDocId: "new1" })
  })

  it("findSimilar returns [] when no memory deps are available", async () => {
    mockTryBuildMemoryDeps.mockResolvedValue(undefined)
    let captured: ConsolidateDeps | undefined
    mockConsolidate.mockImplementation(async (_i, deps: ConsolidateDeps) => {
      captured = deps
      return { applied: [] }
    })
    const deps = await buildAutoExtractionDeps(params, cfg())
    await deps!.consolidate({ candidates: [], scope: "global", provenance: "user" })
    const similar = await captured!.findSimilar(
      { type: "semantic", text: "q", importance: 5 },
      "global"
    )
    expect(similar).toEqual([])
    expect(mockRetrieveMemories).not.toHaveBeenCalled()
  })

  it("persist survives a vector upsert failure (memory still returned)", async () => {
    const upsert = jest.fn(async () => {
      throw new Error("vector down")
    })
    mockTryBuildMemoryVectorSink.mockResolvedValue({ upsert })
    let captured: ConsolidateDeps | undefined
    mockConsolidate.mockImplementation(async (_i, deps: ConsolidateDeps) => {
      captured = deps
      return { applied: [] }
    })
    const deps = await buildAutoExtractionDeps(params, cfg())
    await deps!.consolidate({ candidates: [], scope: "global", provenance: "user" })
    const row = await captured!.persist({
      scope: "global",
      type: "semantic",
      text: "fact",
      importance: 6,
      provenance: "user",
    })
    expect(row.id).toBe("new1")
  })
})

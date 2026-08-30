/**
 * Coverage for `buildProjectMiningDeps` — the real-wiring factory. Everything
 * heavy (LLM ladder, vector backend, Dexie, retriever, extractor, consolidator)
 * is mocked, so the assertions are about how the closures are wired.
 */

import { DEFAULT_MEMORY_CONFIG, type MemoryConfig } from "@/types/memory/memory"

const mockBuildAgentBacked = jest.fn()
const mockTryBuildMemoryDeps = jest.fn()
const mockTryBuildMemoryVectorSink = jest.fn()
const mockRetrieveMemories = jest.fn()
const mockCreateMemory = jest.fn()
const mockUpdateMemory = jest.fn()
const mockInvalidateMemory = jest.fn()
const mockGetMemory = jest.fn()
const mockExtractProjectClaims = jest.fn()
const mockConsolidate = jest.fn()

jest.mock("@/lib/ai/generation/agent-backed-client", () => ({
  buildAgentBackedLlmClient: (...a: unknown[]) => mockBuildAgentBacked(...a),
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
  getMemory: (...a: unknown[]) => mockGetMemory(...a),
}))
jest.mock("@cognia/memory/extract/project-extractor", () => ({
  ...jest.requireActual("@cognia/memory/extract/project-extractor"),
  extractProjectClaims: (...a: unknown[]) => mockExtractProjectClaims(...a),
}))
jest.mock("@/lib/memory/consolidate/consolidator", () => ({
  consolidate: (...a: unknown[]) => mockConsolidate(...a),
  sameMemoryNamespace: () => true,
}))

import { buildProjectMiningDeps } from "./run-project-mining"

function cfg(over: Partial<MemoryConfig> = {}): MemoryConfig {
  return { ...DEFAULT_MEMORY_CONFIG, ...over }
}

const params = { session: null, appSettings: null }

beforeEach(() => {
  jest.clearAllMocks()
  mockBuildAgentBacked.mockResolvedValue({ complete: jest.fn() })
  mockTryBuildMemoryDeps.mockResolvedValue({ loadCandidates: jest.fn(), loadProcedural: jest.fn() })
  mockTryBuildMemoryVectorSink.mockResolvedValue(undefined)
  mockRetrieveMemories.mockResolvedValue([{ memory: { id: "sim1", text: "existing" } }])
  mockCreateMemory.mockResolvedValue({ id: "new1", text: "fact" })
})

describe("buildProjectMiningDeps", () => {
  it("asks for the configured Agent's utility model, not a bare renderer client", async () => {
    await buildProjectMiningDeps(params, cfg())
    expect(mockBuildAgentBacked).toHaveBeenCalledWith(
      expect.objectContaining({ role: "utility", featureId: "memory-project-mining" })
    )
  })

  it("returns null only when no transport can carry a turn at all", async () => {
    mockBuildAgentBacked.mockResolvedValue(null)
    expect(await buildProjectMiningDeps(params, cfg())).toBeNull()
  })

  it("searches only the project corpus for similar claims", async () => {
    // Without this the consolidation judge can be shown a PERSONAL memory and
    // answer UPDATE, rewriting something the user said about themselves with a
    // fact about their repo — and the row keeps its personal identity.
    const deps = await buildProjectMiningDeps(params, cfg())
    // The wired ConsolidateDeps are only observable through a consolidate call.
    await deps!.consolidate({ candidates: [], scope: "workspace", provenance: "user" })
    const [, consolidateDeps] = mockConsolidate.mock.calls[0]! as [
      unknown,
      { findSimilar: (candidate: unknown, namespace: unknown) => Promise<unknown[]> },
    ]
    await consolidateDeps.findSimilar({ text: "x", type: "semantic" }, { scope: "workspace" })
    expect(mockRetrieveMemories).toHaveBeenCalledWith(
      expect.objectContaining({ claimFilter: "project-only" }),
      expect.anything()
    )
  })

  it("stamps the extractor identity only when the client reports one", async () => {
    mockBuildAgentBacked.mockResolvedValue({
      complete: jest.fn(),
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
    })
    const withIdentity = await buildProjectMiningDeps(params, cfg())
    expect(withIdentity!.extractorIdentity).toEqual({
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
    })

    // The headless fallback resolves its provider inside the host and reports
    // neither, so the stamp is omitted rather than filled with "unknown".
    mockBuildAgentBacked.mockResolvedValue({ complete: jest.fn() })
    const withoutIdentity = await buildProjectMiningDeps(params, cfg())
    expect(withoutIdentity!.extractorIdentity).toBeUndefined()
  })
})

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
const mockListMemories = jest.fn()
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
  listMemories: (...a: unknown[]) => mockListMemories(...a),
}))
jest.mock("@cognia/memory/extract/project-extractor", () => ({
  ...jest.requireActual("@cognia/memory/extract/project-extractor"),
  extractProjectClaims: (...a: unknown[]) => mockExtractProjectClaims(...a),
}))
jest.mock("@/lib/memory/consolidate/consolidator", () => ({
  ...jest.requireActual("@/lib/memory/consolidate/consolidator"),
  consolidate: (...a: unknown[]) => mockConsolidate(...a),
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
  mockListMemories.mockResolvedValue([])
  mockConsolidate.mockResolvedValue({ applied: [] })
})

describe("buildProjectMiningDeps", () => {
  it("reuses only an exact attachment draft and repairs its evidence on retry", async () => {
    const candidate = {
      type: "semantic" as const,
      text: "source fact",
      importance: 5,
      projectClaim: {
        projectMemoryKind: "state" as const,
        evidenceHash: "hash",
        evidence: [{ kind: "file" as const, sourceId: "attachment" }],
      },
    }
    mockListMemories.mockResolvedValue([
      {
        id: "draft",
        text: "source fact",
        trustState: "quarantined",
        projectMemoryKind: "state",
        evidenceHash: "hash",
      },
    ])
    const deps = await buildProjectMiningDeps(params, cfg())
    expect(
      await deps!.consolidate({
        scope: "workspace",
        projectId: "p1",
        provenance: "user",
        candidates: [candidate],
      })
    ).toEqual({ applied: [{ op: "UPDATE", targetId: "draft", candidate }] })
    expect(mockCreateMemory).not.toHaveBeenCalled()
    expect(mockListMemories).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p1", exactNamespace: true })
    )
  })
  it("keeps attachment facts as quarantined drafts without searching trusted memories to replace", async () => {
    const deps = await buildProjectMiningDeps(params, cfg())
    await deps!.consolidate({
      scope: "workspace",
      projectId: "p1",
      provenance: "user",
      candidates: [
        {
          type: "semantic",
          text: "source fact",
          importance: 5,
          projectClaim: {
            projectMemoryKind: "state",
            evidence: [{ kind: "file", sourceId: "attachment" }],
          },
        },
      ],
    })
    const wired = mockConsolidate.mock.calls[0]![1]
    expect(await wired.findSimilar({}, {})).toEqual([])
    expect(mockRetrieveMemories).not.toHaveBeenCalled()
    await wired.persist({ text: "source fact" })
    expect(mockCreateMemory).toHaveBeenCalledWith(
      expect.objectContaining({ trustState: "quarantined", reviewStatus: "unreviewed" })
    )
  })
  it("preserves provider failures for the durable worker retry policy", async () => {
    const deps = await buildProjectMiningDeps(params, cfg())
    const failure = new Error("provider unavailable")
    mockExtractProjectClaims.mockRejectedValueOnce(failure)
    await expect(deps!.extract({ messages: [] })).rejects.toBe(failure)
    expect(deps!.propagateErrors).toBe(true)
    expect(mockExtractProjectClaims).toHaveBeenCalledWith({ messages: [] }, expect.anything(), {
      propagateErrors: true,
    })
  })

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

  it("uses the subtree as the reader path and consolidates only the exact namespace", async () => {
    const namespace = { scope: "workspace", projectId: "p1", pathPattern: "src/memory" }
    const exact = { id: "exact", text: "existing", ...namespace }
    const broader = { id: "broader", text: "existing", scope: "workspace", projectId: "p1" }
    mockRetrieveMemories.mockImplementation(async ({ reader }) => {
      // The real reader excludes path-scoped memories when no path is supplied.
      return reader.path === "src/memory" ? [{ memory: exact }, { memory: broader }] : []
    })
    const deps = await buildProjectMiningDeps(params, cfg())
    await deps!.consolidate({ candidates: [], scope: "workspace", provenance: "user" })
    const wired = mockConsolidate.mock.calls[0]![1]
    expect(await wired.findSimilar({ text: "existing", type: "semantic" }, namespace)).toEqual([
      exact,
    ])
  })

  it("refreshes supported claim metadata on update without clearing absent fields", async () => {
    const deps = await buildProjectMiningDeps(params, cfg())
    await deps!.consolidate({ candidates: [], scope: "workspace", provenance: "user" })
    const wired = mockConsolidate.mock.calls[0]![1]
    await wired.update("existing", "corrected fact", {
      type: "semantic",
      text: "corrected fact",
      importance: 8,
      projectClaim: {
        projectMemoryKind: "constraint",
        observedAt: 2000,
        observedAtMessageId: "m2",
        confidence: 0.95,
        evidenceHash: "new-hash",
        sourceRevision: "2",
        scopeRationale: "Only the memory subtree",
        extractor: { provider: "local", model: "utility", promptVersion: "project-v4" },
        evidence: [{ kind: "message", sourceId: "m2" }],
      },
    })
    expect(mockUpdateMemory).toHaveBeenLastCalledWith("existing", {
      text: "corrected fact",
      bumpVersion: true,
      projectMemoryKind: "constraint",
      observedAt: 2000,
      confidence: 0.95,
      evidenceHash: "new-hash",
      sourceRevision: "2",
      scopeRationale: "Only the memory subtree",
      extractor: { provider: "local", model: "utility", promptVersion: "project-v4" },
    })
    await wired.update("existing", "revised again", {
      type: "semantic",
      text: "revised again",
      importance: 8,
      projectClaim: {
        projectMemoryKind: "state",
        confidence: 0.8,
        observedAtMessageId: "m3",
        evidence: [],
      },
    })
    expect(mockUpdateMemory).toHaveBeenLastCalledWith("existing", {
      text: "revised again",
      bumpVersion: true,
      projectMemoryKind: "state",
      confidence: 0.8,
    })
  })

  it("retains persisted memories when vector indexing fails and deduplicates conflict links", async () => {
    const sink = { upsert: jest.fn().mockRejectedValue(new Error("index unavailable")) }
    mockTryBuildMemoryVectorSink.mockResolvedValue(sink)
    const deps = await buildProjectMiningDeps(params, cfg())
    await deps!.consolidate({ candidates: [], scope: "workspace", provenance: "user" })
    const wired = mockConsolidate.mock.calls[0]![1]
    await expect(wired.persist({ text: "fact" })).resolves.toMatchObject({ id: "new1" })
    await expect(wired.update("new1", "revised fact")).resolves.toBeUndefined()
    expect(mockUpdateMemory).toHaveBeenCalledWith("new1", {
      text: "revised fact",
      bumpVersion: true,
    })
    await wired.invalidate("new1", "new2")
    expect(mockInvalidateMemory).toHaveBeenCalledWith("new1", "new2")
    mockGetMemory.mockResolvedValue({ id: "new1", conflictWithIds: ["other"] })
    await wired.markConflict("new1", "other")
    expect(mockUpdateMemory).toHaveBeenCalledWith("new1", {
      reviewStatus: "conflict",
      conflictWithIds: ["other"],
    })
    mockGetMemory.mockResolvedValue(undefined)
    await wired.markConflict("missing", "other")
    expect(mockUpdateMemory).not.toHaveBeenCalledWith("missing", expect.anything())
  })

  it("records a successful vector receipt and prevents unsafe replacement text", async () => {
    const sink = { upsert: jest.fn().mockResolvedValue(undefined) }
    mockTryBuildMemoryVectorSink.mockResolvedValue(sink)
    const deps = await buildProjectMiningDeps(params, cfg())
    await deps!.consolidate({ candidates: [], scope: "workspace", provenance: "user" })
    const wired = mockConsolidate.mock.calls[0]![1]
    await wired.persist({ text: "fact" })
    expect(mockUpdateMemory).toHaveBeenCalledWith("new1", { vectorDocId: "new1" })
    await wired.update("new1", "updated fact")
    expect(sink.upsert).toHaveBeenCalledWith("new1", "updated fact")
    mockUpdateMemory.mockClear()
    await wired.update("new1", "Email owner@example.com")
    expect(mockUpdateMemory).not.toHaveBeenCalled()
  })

  it("works without retrieval or vector dependencies", async () => {
    mockTryBuildMemoryDeps.mockResolvedValue(undefined)
    const deps = await buildProjectMiningDeps(params, cfg())
    await deps!.consolidate({ candidates: [], scope: "workspace", provenance: "user" })
    const wired = mockConsolidate.mock.calls[0]![1]
    expect(await wired.findSimilar({ text: "fact" }, { scope: "workspace" })).toEqual([])
    await wired.persist({ text: "fact" })
    await wired.update("new1", "updated fact")
    mockGetMemory.mockResolvedValue({ id: "new1" })
    await wired.markConflict("new1", "other")
    expect(mockUpdateMemory).toHaveBeenCalledWith("new1", {
      reviewStatus: "conflict",
      conflictWithIds: ["other"],
    })
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

import { searchMemoriesExternal } from "./search-memory"

const mockGetSettings = jest.fn()
jest.mock("@/lib/db/settings", () => ({
  getSettings: () => mockGetSettings(),
}))

const mockTryBuildMemoryDeps = jest.fn()
jest.mock("@/lib/memory/runtime/build-deps", () => ({
  tryBuildMemoryDeps: (...args: unknown[]) => mockTryBuildMemoryDeps(...(args as [])),
}))

const mockRetrieveMemories = jest.fn()
jest.mock("@/lib/memory/retrieve/retriever", () => ({
  retrieveMemories: (...args: unknown[]) => mockRetrieveMemories(...(args as [])),
}))

const mockResolvePolicy = jest.fn()
jest.mock("@/lib/memory/agent-policy", () => ({
  resolvePersistedAgentMemoryPolicy: (...args: unknown[]) => mockResolvePolicy(...args),
}))

const HIT = { memory: { id: "m1", text: "fact" }, relevance: 0.9, score: 0.8 }

beforeEach(() => {
  jest.clearAllMocks()
  mockGetSettings.mockResolvedValue({ memory: { enabled: true } })
  mockTryBuildMemoryDeps.mockResolvedValue({ loadCandidates: jest.fn(), touch: jest.fn() })
  mockRetrieveMemories.mockResolvedValue([HIT])
  mockResolvePolicy.mockResolvedValue({
    canRecall: true,
    readableScopes: ["global", "workspace", "character", "agent"],
  })
})

describe("searchMemoriesExternal", () => {
  it("throws on an empty query", async () => {
    await expect(searchMemoriesExternal({ query: "   " })).rejects.toThrow(/non-empty 'query'/)
  })

  it("returns policy results for disabled / temporary / missing backend", async () => {
    mockGetSettings.mockResolvedValue({ memory: { enabled: false } })
    expect(await searchMemoriesExternal({ query: "q" })).toEqual({
      ok: false,
      reason: "disabled",
    })
    mockGetSettings.mockResolvedValue({ memory: { enabled: true, temporary: true } })
    expect(await searchMemoriesExternal({ query: "q" })).toEqual({
      ok: false,
      reason: "temporary",
    })
    mockGetSettings.mockResolvedValue({ memory: { enabled: true } })
    mockTryBuildMemoryDeps.mockResolvedValue(undefined)
    expect(await searchMemoriesExternal({ query: "q" })).toEqual({
      ok: false,
      reason: "backend_unavailable",
    })
    expect(mockRetrieveMemories).not.toHaveBeenCalled()
  })

  it("enforces the acting Agent recall permission", async () => {
    mockResolvePolicy.mockResolvedValue({ canRecall: false, readableScopes: [] })
    await expect(
      searchMemoriesExternal({ query: "q", policyCharacterId: "agent-1" })
    ).resolves.toEqual({ ok: false, reason: "policy_denied" })
    expect(mockTryBuildMemoryDeps).not.toHaveBeenCalled()
  })

  it("filters candidate scopes before retrieval", async () => {
    const loadCandidates = jest.fn(async () => [
      { id: "g", scope: "global" },
      { id: "c", scope: "character" },
    ])
    mockTryBuildMemoryDeps.mockResolvedValue({
      loadCandidates,
      loadProcedural: jest.fn(async () => []),
    })
    mockResolvePolicy.mockResolvedValue({ canRecall: true, readableScopes: ["character"] })
    await searchMemoriesExternal({ query: "q", policyCharacterId: "agent-1" })
    const scopedDeps = mockRetrieveMemories.mock.calls[0][1]
    await expect(scopedDeps.loadCandidates()).resolves.toEqual([{ id: "c", scope: "character" }])
  })

  it("threads the user's config into the retriever", async () => {
    mockGetSettings.mockResolvedValue({
      memory: {
        enabled: true,
        retrievalTopK: 5,
        relevanceFloor: 0.42,
        decayHalfLifeDays: 12,
        enableQueryExpansion: true,
      },
    })
    const result = await searchMemoriesExternal({ query: "package manager" })
    expect(result).toEqual({ ok: true, hits: [HIT] })
    expect(mockRetrieveMemories).toHaveBeenCalledWith(
      expect.objectContaining({
        queryText: "package manager",
        topK: 5,
        relevanceFloor: 0.42,
        recencyHalfLifeDays: 12,
        enableQueryExpansion: true,
      }),
      expect.anything()
    )
  })

  it("respects explicit topK / types / reader namespace", async () => {
    await searchMemoriesExternal({
      query: "q",
      topK: 2,
      types: ["episodic"],
      characterId: "char1",
      projectId: "project1",
      agentId: "agent1",
      branch: "main",
      path: "lib/memory",
    })
    expect(mockRetrieveMemories).toHaveBeenCalledWith(
      expect.objectContaining({
        topK: 2,
        types: ["episodic"],
        reader: {
          characterId: "char1",
          projectId: "project1",
          agentId: "agent1",
          branch: "main",
          path: "lib/memory",
        },
      }),
      expect.anything()
    )
  })

  it("strips the touch dep when touch is false", async () => {
    await searchMemoriesExternal({ query: "q", touch: false })
    const deps = mockRetrieveMemories.mock.calls[0][1]
    expect(deps.touch).toBeUndefined()

    await searchMemoriesExternal({ query: "q" })
    const depsDefault = mockRetrieveMemories.mock.calls[1][1]
    expect(depsDefault.touch).toBeDefined()
  })
})

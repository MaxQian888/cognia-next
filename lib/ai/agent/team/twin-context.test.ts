import {
  resolveTeamTwinRuntime,
  gatherTeamTwins,
  applyTeammateTwinContext,
  searchTwinKnowledge,
} from "./twin-context"
import type { TwinRuntimeDepsForBuild } from "@/lib/claude/build-options"

// ── Module mocks (all dynamically imported inside twin-context.ts) ─────────
const tryBuildTwinDepsMock = jest.fn()
jest.mock("@/lib/twin/runtime/build-deps", () => ({
  tryBuildTwinDeps: (...a: unknown[]) => tryBuildTwinDepsMock(...a),
}))

const listTwinsMock = jest.fn()
jest.mock("@/lib/db/twins", () => ({
  listTwins: (...a: unknown[]) => listTwinsMock(...a),
}))

const getTwinProfileMock = jest.fn()
jest.mock("@/lib/db/twin-profile", () => ({
  getTwinProfile: (...a: unknown[]) => getTwinProfileMock(...a),
}))

const applyTwinContextMock = jest.fn()
jest.mock("@/lib/twin/runtime/apply-twin-context", () => ({
  applyTwinContext: (...a: unknown[]) => applyTwinContextMock(...a),
}))

const recordTwinInjectMock = jest.fn()
jest.mock("@/lib/twin/runtime/inject-log", () => ({
  recordTwinInject: (...a: unknown[]) => recordTwinInjectMock(...a),
}))

const getTwinChunksByVectorDocIdsMock = jest.fn()
jest.mock("@/lib/db/twin-chunks", () => ({
  getTwinChunksByVectorDocIds: (...a: unknown[]) => getTwinChunksByVectorDocIdsMock(...a),
}))

const DEFAULT_TWIN_SETTINGS_FIXTURE = {
  enableRag: false,
  ragTopK: 6,
  enableStyleFewShot: true,
  styleSamplesK: 3,
  enableHybrid: false,
  hybridKeywordWeight: 0.5,
  enableQueryExpansion: false,
  enableCorrectiveFilter: false,
  correctiveMinKeep: 1,
  enableCitations: true,
  citationStyle: "simple",
}
jest.mock("@/types/twin", () => ({
  DEFAULT_TWIN_SETTINGS: DEFAULT_TWIN_SETTINGS_FIXTURE,
}))

const twinDepsFixture: TwinRuntimeDepsForBuild = {
  store: { searchByEmbedding: jest.fn() },
  embedding: { provider: "openai", model: "text-embedding-3-small", apiKey: "key" },
}

beforeEach(() => {
  jest.clearAllMocks()
  tryBuildTwinDepsMock.mockResolvedValue(undefined)
  listTwinsMock.mockResolvedValue([])
  getTwinProfileMock.mockResolvedValue(undefined)
  applyTwinContextMock.mockResolvedValue({
    applied: null,
    degraded: false,
    retrievedChunks: [],
    selectedStyleSamples: [],
  })
  getTwinChunksByVectorDocIdsMock.mockResolvedValue([])
})

describe("resolveTeamTwinRuntime", () => {
  it("builds twinDeps and skips the twin list when only buildDeps is requested", async () => {
    tryBuildTwinDepsMock.mockResolvedValue(twinDepsFixture)

    const result = await resolveTeamTwinRuntime({ buildDeps: true, listAvailable: false })

    expect(result.twinDeps).toBe(twinDepsFixture)
    expect(result.availableTwins).toEqual([])
    expect(tryBuildTwinDepsMock).toHaveBeenCalledTimes(1)
    expect(listTwinsMock).not.toHaveBeenCalled()
  })

  it("lists twins and skips building deps when only listAvailable is requested", async () => {
    listTwinsMock.mockResolvedValue([
      { id: "t1", name: "Twin One", description: "d1", createdAt: 0, updatedAt: 0 },
    ])
    getTwinProfileMock.mockRejectedValue(new Error("no profile"))

    const result = await resolveTeamTwinRuntime({ buildDeps: false, listAvailable: true })

    expect(result.availableTwins).toEqual([{ id: "t1", name: "Twin One", expertise: "d1" }])
    expect("twinDeps" in result).toBe(false)
    expect(tryBuildTwinDepsMock).not.toHaveBeenCalled()
  })

  it("omits twinDeps when tryBuildTwinDeps throws", async () => {
    tryBuildTwinDepsMock.mockRejectedValue(new Error("build failed"))

    const result = await resolveTeamTwinRuntime({ buildDeps: true, listAvailable: false })

    expect("twinDeps" in result).toBe(false)
    expect(result.availableTwins).toEqual([])
  })

  it("omits twinDeps when tryBuildTwinDeps resolves undefined", async () => {
    tryBuildTwinDepsMock.mockResolvedValue(undefined)

    const result = await resolveTeamTwinRuntime({ buildDeps: true, listAvailable: false })

    expect("twinDeps" in result).toBe(false)
  })

  it("does nothing when neither flag is set", async () => {
    const result = await resolveTeamTwinRuntime({ buildDeps: false, listAvailable: false })

    expect(result).toEqual({ availableTwins: [] })
    expect(tryBuildTwinDepsMock).not.toHaveBeenCalled()
    expect(listTwinsMock).not.toHaveBeenCalled()
  })
})

describe("gatherTeamTwins", () => {
  it("lists non-archived twins and summarizes expertise from the profile", async () => {
    listTwinsMock.mockResolvedValue([{ id: "t1", name: "Twin One", createdAt: 0, updatedAt: 0 }])
    getTwinProfileMock.mockResolvedValue({
      id: "t1",
      twinId: "t1",
      voiceSummary: "Speaks concisely about backend architecture.",
      entities: [
        { name: "Alice", aliases: [], role: "person", firstSeenChunkId: "c1" },
        { name: "Project Phoenix", aliases: [], role: "project", firstSeenChunkId: "c2" },
        { name: "Payments System", aliases: [], role: "system", firstSeenChunkId: "c3" },
        { name: "Idempotency", aliases: [], role: "concept", firstSeenChunkId: "c4" },
      ],
      playbooks: [],
      decisions: [],
      styleSamples: [],
      updatedAt: 0,
    })

    const result = await gatherTeamTwins()

    expect(listTwinsMock).toHaveBeenCalledWith({ includeArchived: false })
    expect(result).toEqual([
      {
        id: "t1",
        name: "Twin One",
        expertise:
          "Speaks concisely about backend architecture. [Project Phoenix, Payments System, Idempotency]",
      },
    ])
  })

  it("truncates a long voice summary and caps entities to 6", async () => {
    listTwinsMock.mockResolvedValue([{ id: "t1", name: "Twin One", createdAt: 0, updatedAt: 0 }])
    const longVoice = "x".repeat(300)
    getTwinProfileMock.mockResolvedValue({
      id: "t1",
      twinId: "t1",
      voiceSummary: longVoice,
      entities: Array.from({ length: 8 }, (_, i) => ({
        name: `Concept${i}`,
        aliases: [],
        role: "concept" as const,
        firstSeenChunkId: `c${i}`,
      })),
      playbooks: [],
      decisions: [],
      styleSamples: [],
      updatedAt: 0,
    })

    const result = await gatherTeamTwins()

    const [{ expertise }] = result
    const bracketStart = expertise.indexOf("[")
    const voicePart = expertise.slice(0, bracketStart).trim()
    expect(voicePart.endsWith("…")).toBe(true)
    expect(voicePart.length).toBe(240)
    const names = expertise.slice(bracketStart + 1, -1).split(", ")
    expect(names).toEqual(["Concept0", "Concept1", "Concept2", "Concept3", "Concept4", "Concept5"])
  })

  it("falls back to the twin description when getTwinProfile throws", async () => {
    listTwinsMock.mockResolvedValue([
      {
        id: "t1",
        name: "Twin One",
        description: "  A helpful twin.  ",
        createdAt: 0,
        updatedAt: 0,
      },
    ])
    getTwinProfileMock.mockRejectedValue(new Error("profile db locked"))

    const result = await gatherTeamTwins()

    expect(result).toEqual([{ id: "t1", name: "Twin One", expertise: "A helpful twin." }])
  })

  it("falls back to an empty expertise string when the profile fails and there is no description", async () => {
    listTwinsMock.mockResolvedValue([{ id: "t1", name: "Twin One", createdAt: 0, updatedAt: 0 }])
    getTwinProfileMock.mockRejectedValue(new Error("profile db locked"))

    const result = await gatherTeamTwins()

    expect(result).toEqual([{ id: "t1", name: "Twin One", expertise: "" }])
  })

  it("returns an empty array when listTwins throws", async () => {
    listTwinsMock.mockRejectedValue(new Error("dexie unreachable"))

    const result = await gatherTeamTwins()

    expect(result).toEqual([])
    expect(getTwinProfileMock).not.toHaveBeenCalled()
  })
})

describe("applyTeammateTwinContext", () => {
  const baseInput = {
    actorName: "Security Reviewer",
    baseSystemPrompt: "You are a security reviewer.",
    twinId: "twin-1",
    twinDeps: twinDepsFixture,
    source: "team",
  }

  it("does not apply and skips all imports when the userPrompt is blank", async () => {
    const result = await applyTeammateTwinContext({ ...baseInput, userPrompt: "   " })

    expect(result).toEqual({ systemPrompt: baseInput.baseSystemPrompt, applied: false })
    expect(applyTwinContextMock).not.toHaveBeenCalled()
    expect(recordTwinInjectMock).not.toHaveBeenCalled()
  })

  it("builds the synthetic character passed to applyTwinContext", async () => {
    await applyTeammateTwinContext({
      ...baseInput,
      userPrompt: "do the task",
      twinSettings: { enableRag: true, ragTopK: 4 } as never,
      precomputedQueryEmbedding: [0.1, 0.2],
    })

    expect(applyTwinContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessage: "do the task",
        precomputedQueryEmbedding: [0.1, 0.2],
        deps: twinDepsFixture,
        character: expect.objectContaining({
          id: "__teammate_twin__:twin-1",
          name: "Security Reviewer",
          systemPrompt: "You are a security reviewer.",
          twinId: "twin-1",
          twinSettings: { enableRag: true, ragTopK: 4 },
        }),
      })
    )
  })

  it("omits twinSettings and precomputedQueryEmbedding on the character/input when not provided", async () => {
    await applyTeammateTwinContext({ ...baseInput, userPrompt: "do the task" })

    const call = applyTwinContextMock.mock.calls[0][0]
    expect(call).not.toHaveProperty("precomputedQueryEmbedding")
    expect(call.character).not.toHaveProperty("twinSettings")
  })

  it("returns the base prompt + degradedReason and logs a failed inject when applied is null", async () => {
    applyTwinContextMock.mockResolvedValue({
      applied: null,
      degraded: true,
      degradedReason: "embed-failed: timeout",
      retrievedChunks: [],
      selectedStyleSamples: [],
    })

    const result = await applyTeammateTwinContext({ ...baseInput, userPrompt: "do the task" })

    expect(result).toEqual({
      systemPrompt: baseInput.baseSystemPrompt,
      applied: false,
      degradedReason: "embed-failed: timeout",
    })
    expect(recordTwinInjectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        twinId: "twin-1",
        source: "team",
        applied: false,
        degraded: true,
        degradedReason: "embed-failed: timeout",
        chunkCount: 0,
        styleSampleCount: 0,
        tokensApprox: 0,
      })
    )
  })

  it("omits degradedReason on the result when applied is null with no reason", async () => {
    applyTwinContextMock.mockResolvedValue({
      applied: null,
      degraded: false,
      retrievedChunks: [],
      selectedStyleSamples: [],
    })

    const result = await applyTeammateTwinContext({ ...baseInput, userPrompt: "do the task" })

    expect(result).toEqual({ systemPrompt: baseInput.baseSystemPrompt, applied: false })
    expect(result).not.toHaveProperty("degradedReason")
  })

  it("returns the injected systemPrompt and logs a successful inject when applied", async () => {
    applyTwinContextMock.mockResolvedValue({
      applied: {
        systemPrompt: "injected system prompt",
        metadata: { retrievedChunkIds: ["c1", "c2"], styleSampleIds: ["s1"] },
      },
      degraded: false,
      retrievedChunks: [],
      selectedStyleSamples: [],
    })

    const result = await applyTeammateTwinContext({ ...baseInput, userPrompt: "do the task" })

    expect(result).toEqual({ systemPrompt: "injected system prompt", applied: true })
    expect(recordTwinInjectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        twinId: "twin-1",
        source: "team",
        applied: true,
        degraded: false,
        degradedReason: null,
        chunkCount: 2,
        styleSampleCount: 1,
        tokensApprox: Math.ceil("injected system prompt".length / 4),
      })
    )
  })

  it("degrades to the base prompt with the error message when applyTwinContext throws", async () => {
    applyTwinContextMock.mockRejectedValue(new Error("vector store unreachable"))

    const result = await applyTeammateTwinContext({ ...baseInput, userPrompt: "do the task" })

    expect(result).toEqual({
      systemPrompt: baseInput.baseSystemPrompt,
      applied: false,
      degradedReason: "vector store unreachable",
    })
    expect(recordTwinInjectMock).not.toHaveBeenCalled()
  })

  it("stringifies a non-Error throw as the degradedReason", async () => {
    applyTwinContextMock.mockRejectedValue("raw failure")

    const result = await applyTeammateTwinContext({ ...baseInput, userPrompt: "do the task" })

    expect(result.degradedReason).toBe("raw failure")
    expect(result.applied).toBe(false)
  })
})

describe("searchTwinKnowledge", () => {
  const baseInput = { twinId: "twin-1", twinDeps: twinDepsFixture }

  it("short-circuits on a blank query without touching any dependency", async () => {
    const result = await searchTwinKnowledge({ ...baseInput, query: "   " })

    expect(result).toEqual({ hits: [], degraded: false })
    expect(applyTwinContextMock).not.toHaveBeenCalled()
    expect(getTwinChunksByVectorDocIdsMock).not.toHaveBeenCalled()
  })

  it.each([
    [0, 1],
    [100, 12],
    [undefined, 5],
    [8, 8],
  ])("clamps topK=%s to %i on the character's twinSettings", async (input, expected) => {
    await searchTwinKnowledge({ ...baseInput, query: "find X", topK: input })

    const call = applyTwinContextMock.mock.calls[0][0]
    expect(call.character.twinSettings.ragTopK).toBe(expected)
  })

  it("forces RAG-only settings regardless of the mocked defaults", async () => {
    await searchTwinKnowledge({ ...baseInput, query: "find X" })

    const character = applyTwinContextMock.mock.calls[0][0].character
    expect(character.twinSettings).toEqual(
      expect.objectContaining({
        enableRag: true,
        enableStyleFewShot: false,
        enableCitations: false,
      })
    )
  })

  it("returns no hits (but forwards degraded state) when retrievedChunks is empty", async () => {
    applyTwinContextMock.mockResolvedValue({
      applied: null,
      degraded: true,
      degradedReason: "store-no-search",
      retrievedChunks: [],
      selectedStyleSamples: [],
    })

    const result = await searchTwinKnowledge({ ...baseInput, query: "find X" })

    expect(result).toEqual({ hits: [], degraded: true, degradedReason: "store-no-search" })
    expect(getTwinChunksByVectorDocIdsMock).not.toHaveBeenCalled()
  })

  it("returns the REDACTED chunk text, never the raw retrieved content", async () => {
    applyTwinContextMock.mockResolvedValue({
      applied: null,
      degraded: false,
      retrievedChunks: [
        {
          chunk: { vectorDocId: "vd1", content: "RAW SECRET CONTENT", sourceId: "src1" },
          score: 0.9,
          sourceTitle: "Doc One",
        },
      ],
      selectedStyleSamples: [],
    })
    getTwinChunksByVectorDocIdsMock.mockResolvedValue([
      { vectorDocId: "vd1", contentRedacted: "REDACTED SAFE TEXT" },
    ])

    const result = await searchTwinKnowledge({ ...baseInput, query: "find X" })

    expect(getTwinChunksByVectorDocIdsMock).toHaveBeenCalledWith(["vd1"])
    expect(result.hits).toEqual([
      { text: "REDACTED SAFE TEXT", sourceTitle: "Doc One", score: 0.9 },
    ])
    expect(result.hits[0].text).not.toBe("RAW SECRET CONTENT")
  })

  it("omits sourceTitle when the retrieved chunk has none", async () => {
    applyTwinContextMock.mockResolvedValue({
      applied: null,
      degraded: false,
      retrievedChunks: [
        { chunk: { vectorDocId: "vd1", content: "raw", sourceId: "src1" }, score: 0.5 },
      ],
      selectedStyleSamples: [],
    })
    getTwinChunksByVectorDocIdsMock.mockResolvedValue([
      { vectorDocId: "vd1", contentRedacted: "redacted" },
    ])

    const result = await searchTwinKnowledge({ ...baseInput, query: "find X" })

    expect(result.hits).toEqual([{ text: "redacted", score: 0.5 }])
    expect(result.hits[0]).not.toHaveProperty("sourceTitle")
  })

  it("drops hits whose redacted text is missing or blank", async () => {
    applyTwinContextMock.mockResolvedValue({
      applied: null,
      degraded: false,
      retrievedChunks: [
        { chunk: { vectorDocId: "vd-missing", content: "raw1", sourceId: "src1" }, score: 0.9 },
        { chunk: { vectorDocId: "vd-blank", content: "raw2", sourceId: "src2" }, score: 0.8 },
        { chunk: { vectorDocId: "vd-ok", content: "raw3", sourceId: "src3" }, score: 0.7 },
      ],
      selectedStyleSamples: [],
    })
    getTwinChunksByVectorDocIdsMock.mockResolvedValue([
      { vectorDocId: "vd-blank", contentRedacted: "   " },
      { vectorDocId: "vd-ok", contentRedacted: "kept text" },
    ])

    const result = await searchTwinKnowledge({ ...baseInput, query: "find X" })

    expect(result.hits).toEqual([{ text: "kept text", score: 0.7 }])
  })

  it("forwards a degradedReason alongside hits when the retrieval degraded", async () => {
    applyTwinContextMock.mockResolvedValue({
      applied: null,
      degraded: true,
      degradedReason: "hybrid-bm25-failed: timeout",
      retrievedChunks: [
        { chunk: { vectorDocId: "vd1", content: "raw", sourceId: "src1" }, score: 0.5 },
      ],
      selectedStyleSamples: [],
    })
    getTwinChunksByVectorDocIdsMock.mockResolvedValue([
      { vectorDocId: "vd1", contentRedacted: "redacted" },
    ])

    const result = await searchTwinKnowledge({ ...baseInput, query: "find X" })

    expect(result.degraded).toBe(true)
    expect(result.degradedReason).toBe("hybrid-bm25-failed: timeout")
  })

  it("degrades to an empty result with the error message when applyTwinContext throws", async () => {
    applyTwinContextMock.mockRejectedValue(new Error("dimension-mismatch: boom"))

    const result = await searchTwinKnowledge({ ...baseInput, query: "find X" })

    expect(result).toEqual({
      hits: [],
      degraded: true,
      degradedReason: "dimension-mismatch: boom",
    })
  })
})

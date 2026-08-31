import { resolveContextContributions, readSharedMemory, queryTwinMemory } from "./context-providers"
import {
  registerContextProvider,
  __resetContextProvidersForTesting,
} from "@/lib/plugin/registries/context-provider-registry"

const getStateMock = jest.fn()
const selectMock = jest.fn()

jest.mock("@/stores/agent/agent-team-store", () => ({
  __esModule: true,
  useAgentTeamStore: { getState: () => getStateMock() },
}))
jest.mock("@/stores/agent/agent-team-store/selectors", () => ({
  __esModule: true,
  OPERATOR_READER_ID: "operator",
  selectSharedMemoryEntriesForReader: (teamId: string, readerId: string) => (state: unknown) =>
    selectMock(teamId, readerId, state),
}))

const getCharacterMock = jest.fn()
const tryBuildTwinDepsMock = jest.fn()
const applyTwinContextMock = jest.fn()
jest.mock("@/lib/db/characters", () => ({
  __esModule: true,
  getCharacter: (id: string) => getCharacterMock(id),
}))
jest.mock("@/lib/twin/runtime/build-deps", () => ({
  __esModule: true,
  tryBuildTwinDeps: () => tryBuildTwinDepsMock(),
}))
jest.mock("@/lib/twin/runtime/apply-twin-context", () => ({
  __esModule: true,
  applyTwinContext: (input: unknown) => applyTwinContextMock(input),
}))

beforeEach(() => {
  jest.clearAllMocks()
  __resetContextProvidersForTesting()
})

describe("resolveContextContributions", () => {
  it("returns empty string with no providers", async () => {
    expect(await resolveContextContributions({ prompt: "hi" })).toBe("")
  })

  it("joins non-empty provider outputs", async () => {
    registerContextProvider("a", { id: "a", provide: () => "alpha" })
    registerContextProvider("b", { id: "b", provide: () => "  " })
    registerContextProvider("c", { id: "c", provide: async () => "gamma" })
    expect(await resolveContextContributions({ prompt: "hi" })).toBe("alpha\n\ngamma")
  })

  it("skips a throwing provider", async () => {
    registerContextProvider("ok", { id: "ok", provide: () => "kept" })
    registerContextProvider("bad", {
      id: "bad",
      provide: () => {
        throw new Error("boom")
      },
    })
    expect(await resolveContextContributions({ prompt: "hi" })).toBe("kept")
  })

  it("preserves registration order even when providers resolve out of order", async () => {
    // Provider "a" resolves only after "c" has already settled — output must
    // still be ordered by registration, not by resolution order.
    let resolveA: ((v: string) => void) | undefined
    const aPromise = new Promise<string>((r) => {
      resolveA = r
    })
    registerContextProvider("a", { id: "a", provide: () => aPromise })
    registerContextProvider("c", { id: "c", provide: async () => "gamma" })
    const resultPromise = resolveContextContributions({ prompt: "hi" })
    resolveA!("alpha")
    expect(await resultPromise).toBe("alpha\n\ngamma")
  })

  it("runs providers concurrently rather than serially", async () => {
    // A serial loop would never see two providers active at once (max 1);
    // Promise.all kicks both off before either yields (max 2).
    let active = 0
    let maxActive = 0
    const make = (id: string) => async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await Promise.resolve()
      active--
      return id
    }
    registerContextProvider("p1", { id: "p1", provide: make("p1") })
    registerContextProvider("p2", { id: "p2", provide: make("p2") })
    expect(await resolveContextContributions({ prompt: "hi" })).toBe("p1\n\np2")
    expect(maxActive).toBeGreaterThan(1)
  })

  it("isolates a rejecting and a synchronously-throwing provider under parallelism", async () => {
    registerContextProvider("good1", { id: "good1", provide: () => "one" })
    registerContextProvider("asyncBad", {
      id: "asyncBad",
      provide: async () => {
        throw new Error("async boom")
      },
    })
    registerContextProvider("syncBad", {
      id: "syncBad",
      provide: () => {
        throw new Error("sync boom")
      },
    })
    registerContextProvider("good2", { id: "good2", provide: async () => "two" })
    expect(await resolveContextContributions({ prompt: "hi" })).toBe("one\n\ntwo")
  })
})

describe("readSharedMemory", () => {
  it("maps ACL-readable entries and filters by tag", async () => {
    getStateMock.mockReturnValue({})
    selectMock.mockReturnValue([
      { key: "k1", value: 1, writtenBy: "tm", version: 2, tags: ["a"] },
      { key: "k2", value: 2, writtenBy: "tm", version: 1, tags: ["b"] },
    ])
    const all = await readSharedMemory("team-1")
    expect(selectMock).toHaveBeenCalledWith("team-1", "operator", {})
    expect(all).toHaveLength(2)
    const filtered = await readSharedMemory("team-1", { tags: ["a"] })
    expect(filtered).toEqual([{ key: "k1", value: 1, writtenBy: "tm", version: 2, tags: ["a"] }])
  })
})

describe("queryTwinMemory", () => {
  it("returns [] for a blank query", async () => {
    expect(await queryTwinMemory("c1", "  ")).toEqual([])
  })

  it("returns [] when the character has no twin", async () => {
    getCharacterMock.mockResolvedValue({ id: "c1" })
    expect(await queryTwinMemory("c1", "q")).toEqual([])
  })

  it("returns [] when twin deps are unavailable", async () => {
    getCharacterMock.mockResolvedValue({ id: "c1", twinId: "t1" })
    tryBuildTwinDepsMock.mockResolvedValue(null)
    expect(await queryTwinMemory("c1", "q")).toEqual([])
  })

  it("maps retrieved chunks and honors topK override", async () => {
    getCharacterMock.mockResolvedValue({ id: "c1", twinId: "t1", twinSettings: { ragTopK: 6 } })
    tryBuildTwinDepsMock.mockResolvedValue({ store: {}, embedding: {} })
    applyTwinContextMock.mockResolvedValue({
      retrievedChunks: [
        {
          chunk: { contentRedacted: "fact", vectorDocId: "v", sourceId: "s" },
          score: 0.9,
          sourceTitle: "Doc",
        },
      ],
    })
    const out = await queryTwinMemory("c1", "q", { topK: 3 })
    expect(applyTwinContextMock.mock.calls[0][0].character.twinSettings.ragTopK).toBe(3)
    expect(out).toEqual([{ content: "fact", score: 0.9, sourceTitle: "Doc" }])
  })

  it("degrades to [] when retrieval throws", async () => {
    getCharacterMock.mockResolvedValue({ id: "c1", twinId: "t1" })
    tryBuildTwinDepsMock.mockResolvedValue({ store: {}, embedding: {} })
    applyTwinContextMock.mockRejectedValue(new Error("vector store down"))
    expect(await queryTwinMemory("c1", "q")).toEqual([])
  })
})

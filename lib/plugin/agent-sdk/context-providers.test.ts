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
          chunk: { content: "fact", vectorDocId: "v", sourceId: "s" },
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

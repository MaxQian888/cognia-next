import {
  memorySearch,
  memoryList,
  memoryStore,
  memoryUpdate,
  memoryForget,
  MAX_MEMORY_TEXT_CHARS,
} from "./memory"

const mockGetSettings = jest.fn()
jest.mock("@/lib/db/settings", () => ({
  getSettings: () => mockGetSettings(),
}))

const mockSearchExternal = jest.fn()
jest.mock("@/lib/memory/api/search-memory", () => ({
  searchMemoriesExternal: (...args: unknown[]) => mockSearchExternal(...(args as [])),
}))

const mockStoreExternal = jest.fn()
jest.mock("@/lib/memory/api/store-memory", () => ({
  storeExternalMemory: (...args: unknown[]) => mockStoreExternal(...(args as [])),
}))

const mockUpdateExternal = jest.fn()
const mockForgetExternal = jest.fn()
jest.mock("@/lib/memory/api/mutate-memory", () => ({
  updateExternalMemory: (...args: unknown[]) => mockUpdateExternal(...(args as [])),
  forgetExternalMemory: (...args: unknown[]) => mockForgetExternal(...(args as [])),
}))

const mockListMemories = jest.fn()
jest.mock("@/lib/db/memories", () => ({
  listMemories: (...args: unknown[]) => mockListMemories(...(args as [])),
}))

const ROW = {
  id: "m1",
  scope: "global",
  type: "semantic",
  text: "User prefers pnpm",
  tags: ["tooling"],
  importance: 7,
  vectorDocId: "m1",
  createdAt: 1,
  updatedAt: 2,
  lastAccessedAt: 2,
  accessCount: 3,
  version: 1,
  status: "active",
  pinned: false,
  provenance: "external",
  sourceChannel: "mcp",
}

beforeEach(() => {
  jest.clearAllMocks()
  mockGetSettings.mockResolvedValue({ memory: { enabled: true } })
  mockSearchExternal.mockResolvedValue({
    ok: true,
    hits: [{ memory: ROW, relevance: 0.9, score: 0.8 }],
  })
  mockStoreExternal.mockResolvedValue({
    ok: true,
    stored: true,
    consolidated: false,
    applied: ["ADD"],
  })
  mockUpdateExternal.mockResolvedValue({ ok: true })
  mockForgetExternal.mockResolvedValue({ ok: true })
  mockListMemories.mockResolvedValue([ROW])
})

describe("memorySearch", () => {
  it("validates the query and forwards options", async () => {
    await expect(memorySearch({ query: "  " })).rejects.toThrow(/must not be empty/)
    await memorySearch({
      query: "pnpm",
      k: 3,
      types: ["semantic"],
      characterId: "c1",
      projectId: "p1",
      branch: "main",
    })
    expect(mockSearchExternal).toHaveBeenCalledWith({
      query: "pnpm",
      topK: 3,
      types: ["semantic"],
      characterId: "c1",
      projectId: "p1",
      agentId: undefined,
      branch: "main",
      path: undefined,
    })
  })

  it("strips internal plumbing fields from returned rows", async () => {
    const result = await memorySearch({ query: "pnpm" })
    expect(result.ok).toBe(true)
    if (result.ok) {
      const row = result.hits[0].memory as unknown as Record<string, unknown>
      expect(row.id).toBe("m1")
      expect(row.vectorDocId).toBeUndefined()
      expect(row.accessCount).toBeUndefined()
      expect(row.sourceChannel).toBeUndefined()
    }
  })

  it("passes through policy blocks", async () => {
    mockSearchExternal.mockResolvedValue({ ok: false, reason: "disabled" })
    expect(await memorySearch({ query: "q" })).toEqual({ ok: false, reason: "disabled" })
  })
})

describe("memoryList", () => {
  it("lists active rows with a clamped limit", async () => {
    const result = await memoryList({ limit: 999 })
    expect(result.ok).toBe(true)
    expect(mockListMemories).toHaveBeenCalledWith(expect.objectContaining({ status: "active" }))
  })

  it("returns policy blocks for disabled / temporary", async () => {
    mockGetSettings.mockResolvedValue({ memory: { enabled: false } })
    expect(await memoryList({})).toEqual({ ok: false, reason: "disabled" })
    mockGetSettings.mockResolvedValue({ memory: { enabled: true, temporary: true } })
    expect(await memoryList({})).toEqual({ ok: false, reason: "temporary" })
    expect(mockListMemories).not.toHaveBeenCalled()
  })
})

describe("memoryStore", () => {
  it("validates length and stamps the mcp channel", async () => {
    await expect(memoryStore({ text: "x".repeat(MAX_MEMORY_TEXT_CHARS + 1) })).rejects.toThrow(
      /exceeds/
    )
    await memoryStore({ text: "User prefers pnpm", type: "episodic", importance: 9 })
    expect(mockStoreExternal).toHaveBeenCalledWith(
      expect.objectContaining({ text: "User prefers pnpm", type: "episodic", importance: 9 }),
      { channel: "mcp" }
    )
  })
})

describe("memoryUpdate / memoryForget", () => {
  it("validate ids and delegate", async () => {
    await expect(memoryUpdate({ id: " " })).rejects.toThrow(/must not be empty/)
    await memoryUpdate({ id: "m1", text: "new", importance: 4 })
    expect(mockUpdateExternal).toHaveBeenCalledWith("m1", {
      text: "new",
      importance: 4,
      tags: undefined,
      key: undefined,
      pinned: undefined,
    })
    await expect(memoryForget({ id: "" })).rejects.toThrow(/must not be empty/)
    expect(await memoryForget({ id: "m1" })).toEqual({ ok: true })
    expect(mockForgetExternal).toHaveBeenCalledWith("m1")
  })
})

import { createMemoryAPI } from "./memory-api"
import { PluginPiiError } from "./plugin-pii-gate"
import { getPermissionGuard, resetPermissionGuard } from "@/lib/plugin/security"
import { PermissionError } from "@/lib/plugin/security/permission-guard"

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
const mockGetMemory = jest.fn()
const mockCountActive = jest.fn()
jest.mock("@/lib/db/memories", () => ({
  listMemories: (...args: unknown[]) => mockListMemories(...(args as [])),
  getMemory: (...args: unknown[]) => mockGetMemory(...(args as [])),
  countActive: (...args: unknown[]) => mockCountActive(...(args as [])),
}))

const PLUGIN = "memory-plugin"
const PII_TEXT = "reach me at bob@example.com"
const HIT = { memory: { id: "m1" }, relevance: 0.9, score: 0.8 }

describe("createMemoryAPI", () => {
  let guard: ReturnType<typeof getPermissionGuard>

  beforeEach(() => {
    jest.clearAllMocks()
    resetPermissionGuard()
    guard = getPermissionGuard()
    mockGetSettings.mockResolvedValue({ memory: { enabled: true } })
    mockSearchExternal.mockResolvedValue({ ok: true, hits: [HIT] })
    mockStoreExternal.mockResolvedValue({ ok: true, stored: true, consolidated: true, applied: ["ADD"] })
    mockUpdateExternal.mockResolvedValue({ ok: true })
    mockForgetExternal.mockResolvedValue({ ok: true })
    mockListMemories.mockResolvedValue([{ id: "m1" }, { id: "m2" }])
    mockGetMemory.mockResolvedValue({ id: "m1" })
    mockCountActive.mockResolvedValue(3)
  })

  describe("permission gating (fail-closed)", () => {
    it("throws without memory:read on reads", () => {
      guard.registerPlugin(PLUGIN, [])
      const api = createMemoryAPI(PLUGIN)
      expect(() => api.search("q")).toThrow(PermissionError)
      expect(() => api.list()).toThrow(PermissionError)
      expect(() => api.get("m1")).toThrow(PermissionError)
      expect(() => api.count()).toThrow(PermissionError)
    })

    it("throws without memory:write on mutations", () => {
      guard.registerPlugin(PLUGIN, ["memory:read"])
      const api = createMemoryAPI(PLUGIN)
      expect(() => api.store({ text: "x" })).toThrow(PermissionError)
      expect(() => api.update("m1", { text: "x" })).toThrow(PermissionError)
      expect(() => api.forget("m1")).toThrow(PermissionError)
      expect(mockStoreExternal).not.toHaveBeenCalled()
    })
  })

  describe("reads", () => {
    beforeEach(() => guard.registerPlugin(PLUGIN, ["memory:read"]))

    it("search returns hits, degrading to [] on policy blocks", async () => {
      const api = createMemoryAPI(PLUGIN)
      expect(await api.search("q", { topK: 3 })).toEqual([HIT])
      expect(mockSearchExternal).toHaveBeenCalledWith({ query: "q", topK: 3 })
      mockSearchExternal.mockResolvedValue({ ok: false, reason: "disabled" })
      expect(await api.search("q")).toEqual([])
    })

    it("list defaults to active rows with a limit and respects the config gate", async () => {
      const api = createMemoryAPI(PLUGIN)
      expect(await api.list({ limit: 1 })).toEqual([{ id: "m1" }])
      expect(mockListMemories).toHaveBeenCalledWith(
        expect.objectContaining({ status: "active" })
      )
      mockGetSettings.mockResolvedValue({ memory: { enabled: false } })
      expect(await api.list()).toEqual([])
    })

    it("get / count degrade when memory is off or temporary", async () => {
      const api = createMemoryAPI(PLUGIN)
      expect(await api.get("m1")).toEqual({ id: "m1" })
      expect(await api.count("global")).toBe(3)
      mockGetSettings.mockResolvedValue({ memory: { enabled: true, temporary: true } })
      expect(await api.get("m1")).toBeUndefined()
      expect(await api.count()).toBe(0)
    })
  })

  describe("mutations", () => {
    beforeEach(() => guard.registerPlugin(PLUGIN, ["memory:write"]))

    it("store stamps plugin attribution and delegates", async () => {
      const api = createMemoryAPI(PLUGIN)
      const result = await api.store({ text: "User prefers dark mode", type: "episodic" })
      expect(result).toEqual({ ok: true, stored: true, consolidated: true, applied: ["ADD"] })
      expect(mockStoreExternal).toHaveBeenCalledWith(
        { text: "User prefers dark mode", type: "episodic" },
        { channel: "plugin", pluginId: PLUGIN }
      )
    })

    it("store / update raise a typed PluginPiiError on PII text", async () => {
      const api = createMemoryAPI(PLUGIN)
      await expect(api.store({ text: PII_TEXT })).rejects.toThrow(PluginPiiError)
      await expect(api.update("m1", { text: PII_TEXT })).rejects.toThrow(PluginPiiError)
      expect(mockStoreExternal).not.toHaveBeenCalled()
      expect(mockUpdateExternal).not.toHaveBeenCalled()
    })

    it("update / forget delegate to the shared mutators", async () => {
      const api = createMemoryAPI(PLUGIN)
      expect(await api.update("m1", { importance: 9 })).toEqual({ ok: true })
      expect(mockUpdateExternal).toHaveBeenCalledWith("m1", { importance: 9 })
      expect(await api.forget("m1")).toEqual({ ok: true })
      expect(mockForgetExternal).toHaveBeenCalledWith("m1")
    })
  })
})

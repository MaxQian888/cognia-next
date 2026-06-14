import {
  createConfigAPI,
  emitPluginConfigChange,
  __resetConfigListenersForTesting,
} from "./config-api"

jest.mock("@/stores/plugin-runtime", () => ({
  usePluginStore: { getState: jest.fn() },
}))
jest.mock("@/lib/db/plugins", () => ({ setPluginConfig: jest.fn(async () => undefined) }))

import { usePluginStore } from "@/stores/plugin-runtime"
import { setPluginConfig } from "@/lib/db/plugins"

const mockGetState = usePluginStore.getState as unknown as jest.Mock
const mockSetPluginConfig = setPluginConfig as jest.MockedFunction<typeof setPluginConfig>

function storeWith(config: Record<string, unknown>, schema?: unknown) {
  const setPluginConfigSpy = jest.fn((id: string, c: Record<string, unknown>) => {
    state.plugins.p.config = c
  })
  const state = {
    plugins: {
      p: {
        manifest: {
          id: "p",
          name: "P",
          version: "1.0.0",
          type: "frontend",
          capabilities: [],
          configSchema: schema,
        },
        status: "enabled",
        config,
      },
    },
    setPluginConfig: setPluginConfigSpy,
  }
  return state
}

describe("createConfigAPI", () => {
  beforeEach(() => {
    mockGetState.mockReset()
    mockSetPluginConfig.mockReset()
    mockSetPluginConfig.mockResolvedValue(undefined)
    __resetConfigListenersForTesting()
  })

  const manager = { notifyPluginConfigChanged: jest.fn(async () => undefined) }

  it("get reads persisted values and seeds schema defaults", () => {
    mockGetState.mockReturnValue(
      storeWith(
        { a: "set" },
        { type: "object", properties: { a: { type: "string" }, b: { type: "number", default: 7 } } }
      )
    )
    const api = createConfigAPI("p", manager)
    expect(api.get("a")).toBe("set")
    expect(api.get("b")).toBe(7) // from schema default
    expect(api.get("missing")).toBeUndefined()
  })

  it("getOrDefault returns the fallback only when undefined", () => {
    mockGetState.mockReturnValue(storeWith({ a: 0 }))
    const api = createConfigAPI("p", manager)
    expect(api.getOrDefault("a", 99)).toBe(0)
    expect(api.getOrDefault("z", 99)).toBe(99)
  })

  it("update validates the changed key, persists, and notifies", async () => {
    const state = storeWith(
      {},
      { type: "object", properties: { retries: { type: "integer", minimum: 0 } } }
    )
    mockGetState.mockReturnValue(state)
    manager.notifyPluginConfigChanged.mockClear()
    const api = createConfigAPI("p", manager)
    await api.update("retries", 3)
    expect(mockSetPluginConfig).toHaveBeenCalledWith("p", { retries: 3 })
    expect(state.setPluginConfig).toHaveBeenCalledWith("p", { retries: 3 })
    expect(manager.notifyPluginConfigChanged).toHaveBeenCalledWith("p", { retries: 3 })
  })

  it("update rejects a value that fails the schema for that key", async () => {
    mockGetState.mockReturnValue(
      storeWith({}, { type: "object", properties: { retries: { type: "integer" } } })
    )
    const api = createConfigAPI("p", manager)
    await expect(api.update("retries", "not-an-int")).rejects.toThrow(/retries/)
    expect(mockSetPluginConfig).not.toHaveBeenCalled()
  })

  it("onChange fires for changes emitted for this plugin and the disposer stops it", () => {
    mockGetState.mockReturnValue(storeWith({}))
    const api = createConfigAPI("p", manager)
    const seen: Record<string, unknown>[] = []
    const dispose = api.onChange((c) => seen.push(c))
    emitPluginConfigChange("p", { a: 1 })
    emitPluginConfigChange("other", { b: 2 }) // different plugin — ignored
    dispose()
    emitPluginConfigChange("p", { a: 3 })
    expect(seen).toEqual([{ a: 1 }])
  })
})

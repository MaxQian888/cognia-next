import {
  registerContextProvider,
  unregisterContextProviderById,
  unregisterContextProvidersByPlugin,
  getContextProvider,
  listContextProviderIds,
  __resetContextProvidersForTesting,
} from "./context-provider-registry"
import type { PluginContextProvider } from "@/types/plugin/plugin-context-provider"

const p = (id: string): PluginContextProvider => ({ id, provide: () => "ctx" })

beforeEach(() => __resetContextProvidersForTesting())

describe("context-provider-registry", () => {
  it("registers and resolves a provider by id", () => {
    registerContextProvider("a", p("a"), { pluginId: "p1" })
    expect(getContextProvider("a")?.id).toBe("a")
    expect(listContextProviderIds()).toEqual(["a"])
  })

  it("unregisters a single provider", () => {
    registerContextProvider("a", p("a"))
    expect(unregisterContextProviderById("a")).toBe(true)
    expect(getContextProvider("a")).toBeUndefined()
  })

  it("bulk-drops every provider for a plugin", () => {
    registerContextProvider("a", p("a"), { pluginId: "p1" })
    registerContextProvider("b", p("b"), { pluginId: "p2" })
    expect(unregisterContextProvidersByPlugin("p1")).toBe(1)
    expect(listContextProviderIds()).toEqual(["b"])
  })
})

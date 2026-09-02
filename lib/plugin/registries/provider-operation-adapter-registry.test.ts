import { providerOperationHandlerRegistry } from "@/lib/ai/operations/registry"
import type { PluginProviderOperationAdapterDef } from "@/types/plugin/plugin-provider-operation-adapter"

import {
  __resetProviderOperationAdaptersForTesting,
  getProviderOperationAdapter,
  getProviderOperationAdapterEntry,
  listProviderOperationAdapterEntries,
  listProviderOperationAdapterIds,
  providerOperationAdapterVia,
  registerProviderOperationAdapter,
  unregisterProviderOperationAdapterById,
  unregisterProviderOperationAdaptersByPlugin,
} from "./provider-operation-adapter-registry"

function makeAdapter(
  id: string,
  overrides: Partial<PluginProviderOperationAdapterDef> = {}
): PluginProviderOperationAdapterDef {
  return {
    id,
    name: `Adapter ${id}`,
    operationId: "images.generate",
    providerMatch: { kind: "provider", providerId: "acme-cloud" },
    handler: async () => ({ images: [] }),
    ...overrides,
  }
}

function boundVias(operationId: "images.generate" | "balance.read" = "images.generate") {
  return providerOperationHandlerRegistry
    .listFor(operationId)
    .filter((r) => r.support === "plugin")
    .map((r) => r.via)
}

describe("provider-operation-adapter-registry", () => {
  beforeEach(() => {
    __resetProviderOperationAdaptersForTesting()
  })

  it("derives the via from the plugin id without doubling a namespaced id", () => {
    expect(providerOperationAdapterVia("img", "acme")).toBe("acme:img")
    expect(providerOperationAdapterVia("acme:img", "acme")).toBe("acme:img")
    expect(providerOperationAdapterVia("img")).toBe("img")
  })

  it("registers the definition and binds a plugin handler the executor can resolve", () => {
    const a = makeAdapter("acme:img")
    expect(registerProviderOperationAdapter("acme:img", a, { pluginId: "acme" })).toBeUndefined()
    expect(getProviderOperationAdapter("acme:img")).toBe(a)
    expect(getProviderOperationAdapterEntry("acme:img")).toEqual({ entry: a, pluginId: "acme" })
    expect(listProviderOperationAdapterIds()).toEqual(["acme:img"])
    expect(listProviderOperationAdapterEntries()).toEqual([
      { id: "acme:img", entry: a, pluginId: "acme" },
    ])

    const resolved = providerOperationHandlerRegistry.resolve(
      "images.generate",
      "acme-cloud",
      "openai"
    )
    expect(resolved).toMatchObject({ support: "plugin", via: "acme:img" })
    expect(resolved?.handler).toBe(a.handler)
  })

  it("keeps the incumbent and binds no second handler when another plugin claims the id", () => {
    const first = makeAdapter("shared:op")
    registerProviderOperationAdapter("shared:op", first, { pluginId: "one" })
    const second = makeAdapter("shared:op")
    const incumbent = registerProviderOperationAdapter("shared:op", second, { pluginId: "two" })
    expect(incumbent?.entry).toBe(first)
    expect(getProviderOperationAdapter("shared:op")).toBe(first)
    expect(boundVias()).toEqual(["one:shared:op"])
  })

  it("drops the handler with the definition, by id and by plugin", () => {
    registerProviderOperationAdapter("acme:img", makeAdapter("acme:img"), { pluginId: "acme" })
    registerProviderOperationAdapter(
      "acme:bal",
      makeAdapter("acme:bal", { operationId: "balance.read", providerMatch: { kind: "any" } }),
      { pluginId: "acme" }
    )
    registerProviderOperationAdapter("other:img", makeAdapter("other:img"), { pluginId: "other" })
    expect(boundVias()).toEqual(["acme:img", "other:img"])

    expect(unregisterProviderOperationAdapterById("acme:img")).toBe(true)
    expect(boundVias()).toEqual(["other:img"])
    expect(boundVias("balance.read")).toEqual(["acme:bal"])

    expect(unregisterProviderOperationAdaptersByPlugin("acme")).toBe(1)
    expect(boundVias("balance.read")).toEqual([])
    expect(listProviderOperationAdapterIds()).toEqual(["other:img"])

    __resetProviderOperationAdaptersForTesting()
    expect(boundVias()).toEqual([])
    expect(listProviderOperationAdapterIds()).toEqual([])
  })
})

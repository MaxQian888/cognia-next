import {
  registerContextProvidersForPlugin,
  unregisterContextProvidersForPlugin,
} from "./context-providers-bridge"
import {
  getContextProvider,
  listContextProviderEntries,
  __resetContextProvidersForTesting,
} from "@/lib/plugin/registries/context-provider-registry"
import type { PluginManifest } from "@/types/plugin"
import {
  bindPythonRuntimeGeneration,
  __resetPythonRuntimeGenerationsForTesting,
} from "@/lib/plugin/python/runtime-generation"

const MANIFEST = {
  id: "ctx-plugin",
  name: "Ctx Plugin",
  version: "0.1.0",
  description: "d",
  type: "frontend",
  capabilities: [],
  contextProviders: [
    { id: "clock", label: "Clock", entry: "src/ctx.js", export: "createProvider" },
  ],
} as unknown as PluginManifest

afterEach(() => {
  __resetContextProvidersForTesting()
  __resetPythonRuntimeGenerationsForTesting()
})

describe("context-providers-bridge python backend", () => {
  it("registers a python-backed provider without importing any JS", async () => {
    bindPythonRuntimeGeneration("ctx-plugin", "generation-1")
    const importer = jest.fn()
    const manifest = {
      ...(MANIFEST as unknown as Record<string, unknown>),
      type: "python",
      pythonMain: "main.py",
      contextProviders: [{ id: "py-clock", label: "Py clock" }],
    } as unknown as PluginManifest

    const result = await registerContextProvidersForPlugin(manifest, "/plugins/ctx", { importer })

    expect(result).toEqual({ registered: 1, errors: [] })
    expect(importer).not.toHaveBeenCalled()
    expect(getContextProvider("ctx-plugin:py-clock")).toBeDefined()
  })

  it("reports a JS-backed provider that omits entry/export", async () => {
    const manifest = {
      ...(MANIFEST as unknown as Record<string, unknown>),
      contextProviders: [{ id: "broken", label: "Broken" }],
    } as unknown as PluginManifest

    const result = await registerContextProvidersForPlugin(manifest, "/plugins/ctx", {
      importer: jest.fn(),
    })

    expect(result.registered).toBe(0)
    expect(result.errors[0]!.message).toMatch(/must declare both "entry" and "export"/)
  })
})

describe("context-providers-bridge", () => {
  it("imports the factory and registers the provider under the namespaced id", async () => {
    const factory = jest.fn(async (ctx: { providerId: string }) => ({
      id: ctx.providerId,
      provide: () => "It is now.",
    }))
    const importer = jest.fn(async () => ({ createProvider: factory }))

    const result = await registerContextProvidersForPlugin(MANIFEST, "/plugins/ctx-plugin", {
      importer,
    })

    expect(result).toEqual({ registered: 1, errors: [] })
    expect(importer).toHaveBeenCalledWith("/plugins/ctx-plugin/src/ctx.js")
    expect(factory).toHaveBeenCalledWith({
      providerId: "ctx-plugin:clock",
      pluginId: "ctx-plugin",
    })

    const provider = getContextProvider("ctx-plugin:clock")
    expect(provider?.name).toBe("Clock")
    expect(await provider?.provide({ prompt: "x" })).toBe("It is now.")
  })

  it("no-ops on an empty contextProviders list", async () => {
    const importer = jest.fn()
    const result = await registerContextProvidersForPlugin(
      { ...MANIFEST, contextProviders: [] } as unknown as PluginManifest,
      "/plugins/ctx-plugin",
      { importer }
    )
    expect(result).toEqual({ registered: 0, errors: [] })
    expect(importer).not.toHaveBeenCalled()
  })

  it("collects an error when the export is not a factory function", async () => {
    const importer = jest.fn(async () => ({ createProvider: 42 }))
    const result = await registerContextProvidersForPlugin(MANIFEST, "/plugins/ctx-plugin", {
      importer,
    })
    expect(result.registered).toBe(0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].providerId).toBe("clock")
    expect(getContextProvider("ctx-plugin:clock")).toBeUndefined()
  })

  it("collects an error when the factory returns a non-provider", async () => {
    const importer = jest.fn(async () => ({ createProvider: async () => ({ id: "x" }) }))
    const result = await registerContextProvidersForPlugin(MANIFEST, "/plugins/ctx-plugin", {
      importer,
    })
    expect(result.registered).toBe(0)
    expect(result.errors).toHaveLength(1)
  })

  it("clears prior registrations on re-enable", async () => {
    const factory = jest.fn(async (ctx: { providerId: string }) => ({
      id: ctx.providerId,
      provide: () => "v1",
    }))
    const importer = jest.fn(async () => ({ createProvider: factory }))
    await registerContextProvidersForPlugin(MANIFEST, "/plugins/ctx-plugin", { importer })
    await registerContextProvidersForPlugin(MANIFEST, "/plugins/ctx-plugin", { importer })
    // Still exactly one entry for this plugin — re-enable cleared the prior one.
    const mine = listContextProviderEntries().filter((e) => e.pluginId === "ctx-plugin")
    expect(mine).toHaveLength(1)
  })

  it("unregisters all of a plugin's providers", async () => {
    const factory = jest.fn(async (ctx: { providerId: string }) => ({
      id: ctx.providerId,
      provide: () => "v",
    }))
    const importer = jest.fn(async () => ({ createProvider: factory }))
    await registerContextProvidersForPlugin(MANIFEST, "/plugins/ctx-plugin", { importer })
    unregisterContextProvidersForPlugin("ctx-plugin")
    expect(getContextProvider("ctx-plugin:clock")).toBeUndefined()
  })
})

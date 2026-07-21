import {
  registerProtocolAdaptersForPlugin,
  unregisterProtocolAdaptersForPlugin,
} from "./protocol-adapters-bridge"
import {
  __resetProtocolAdaptersForTesting,
  getCodeAdapterExecutor,
  getProtocolAdapter,
} from "@cognia/provider-core/providers/protocol-adapter-registry"
import type { PluginManifest } from "@/types/plugin"

const SPEC = {
  kind: "openai-compatible-variant" as const,
  urlTemplate: "{baseURL}/v1/chat/completions",
  responsePaths: { textDelta: "choices[0].delta.content" },
}

const MANIFEST = {
  id: "wire-plugin",
  name: "Wire Plugin",
  version: "0.1.0",
  description: "d",
  type: "frontend",
  capabilities: [],
  protocolAdapters: [{ id: "acme", label: "Acme Wire", spec: SPEC }],
} as unknown as PluginManifest

afterEach(() => {
  __resetProtocolAdaptersForTesting()
})

describe("protocol-adapters-bridge python backend", () => {
  const pythonManifest = (defs: unknown[]): PluginManifest =>
    ({
      ...(MANIFEST as unknown as Record<string, unknown>),
      type: "python",
      pythonMain: "main.py",
      protocolAdapters: defs,
    }) as unknown as PluginManifest

  it("registers a python-backed code adapter without importing any JS", async () => {
    const importer = jest.fn()
    const result = await registerProtocolAdaptersForPlugin(
      pythonManifest([{ id: "py-wire", label: "Py wire", spec: { kind: "code" } }]),
      "/plugins/wire",
      { importer }
    )

    expect(result).toEqual({ registered: 1, errors: [] })
    expect(importer).not.toHaveBeenCalled()
    // The seam's streaming method satisfies `CodeProtocolAdapterFactory`.
    const executor = getCodeAdapterExecutor("wire-plugin:py-wire")
    expect(typeof executor).toBe("function")
    const built = await executor!({} as never)
    expect(typeof built.stream).toBe("function")
    expect(getProtocolAdapter("wire-plugin:py-wire")).toBeDefined()
    unregisterProtocolAdaptersForPlugin("wire-plugin")
  })

  it("still requires entry/export for a JS-backed code adapter", async () => {
    const result = await registerProtocolAdaptersForPlugin(
      {
        ...(MANIFEST as unknown as Record<string, unknown>),
        protocolAdapters: [{ id: "js-wire", label: "Js wire", spec: { kind: "code" } }],
      } as unknown as PluginManifest,
      "/plugins/wire",
      { importer: jest.fn() }
    )

    expect(result.registered).toBe(0)
    expect(result.errors[0]!.message).toBe("code adapter requires entry + export")
  })
})

describe("protocol-adapters-bridge", () => {
  it("registers the declarative def under the namespaced id (no import)", async () => {
    const result = await registerProtocolAdaptersForPlugin(MANIFEST, "/plugins/wire-plugin")
    expect(result).toEqual({ registered: 1, errors: [] })
    const def = getProtocolAdapter("wire-plugin:acme")
    expect(def?.label).toBe("Acme Wire")
    expect(def?.spec).toEqual(SPEC)
  })

  it("collects validation errors without blocking other adapters", async () => {
    const manifest = {
      ...MANIFEST,
      protocolAdapters: [
        { id: "broken", label: "Broken", spec: { kind: "openai-compatible-variant" } },
        { id: "no-paths", label: "NoPaths", spec: { ...SPEC, responsePaths: {} } },
        { id: "wrong-kind", label: "Wrong", spec: { ...SPEC, kind: "other" } },
        { id: "good", label: "Good", spec: SPEC },
      ],
    } as unknown as PluginManifest
    const result = await registerProtocolAdaptersForPlugin(manifest, "/p")
    expect(result.registered).toBe(1)
    expect(result.errors).toHaveLength(3)
    expect(result.errors.map((e) => e.adapterId).sort()).toEqual([
      "broken",
      "no-paths",
      "wrong-kind",
    ])
    expect(getProtocolAdapter("wire-plugin:good")).toBeDefined()
    expect(getProtocolAdapter("wire-plugin:broken")).toBeUndefined()
  })

  it("unregister drops every adapter of the plugin; re-enable replaces", async () => {
    await registerProtocolAdaptersForPlugin(MANIFEST, "/p")
    expect(getProtocolAdapter("wire-plugin:acme")).toBeDefined()
    unregisterProtocolAdaptersForPlugin("wire-plugin")
    expect(getProtocolAdapter("wire-plugin:acme")).toBeUndefined()

    await registerProtocolAdaptersForPlugin(MANIFEST, "/p")
    await registerProtocolAdaptersForPlugin(MANIFEST, "/p")
    expect(getProtocolAdapter("wire-plugin:acme")).toBeDefined()
  })

  it("manifests without protocolAdapters are a fast no-op", async () => {
    const result = await registerProtocolAdaptersForPlugin(
      { ...MANIFEST, protocolAdapters: undefined } as PluginManifest,
      "/p"
    )
    expect(result).toEqual({ registered: 0, errors: [] })
  })

  describe("code adapters (P2-E)", () => {
    const codeManifest = {
      ...MANIFEST,
      protocolAdapters: [
        {
          id: "wire",
          label: "Code Wire",
          spec: { kind: "code" },
          entry: "src/wire.js",
          export: "createAdapter",
        },
      ],
    } as unknown as PluginManifest

    it("imports the factory and registers a code executor", async () => {
      const factory = () => ({ stream: async function* () {} })
      const importer = jest.fn(async () => ({ createAdapter: factory }))
      const result = await registerProtocolAdaptersForPlugin(codeManifest, "/plugins/wire-plugin", {
        importer,
      })
      expect(result).toEqual({ registered: 1, errors: [] })
      expect(importer).toHaveBeenCalledWith("/plugins/wire-plugin/src/wire.js")
      expect(getCodeAdapterExecutor("wire-plugin:wire")).toBe(factory)
      // The def is registered too (so build-options forwards {kind:"code"}).
      expect(getProtocolAdapter("wire-plugin:wire")?.spec).toEqual({ kind: "code" })
    })

    it("requires entry + export for a code adapter", async () => {
      const manifest = {
        ...MANIFEST,
        protocolAdapters: [{ id: "bad", label: "Bad", spec: { kind: "code" } }],
      } as unknown as PluginManifest
      const result = await registerProtocolAdaptersForPlugin(manifest, "/p", {
        importer: jest.fn(),
      })
      expect(result.registered).toBe(0)
      expect(result.errors[0].message).toContain("entry + export")
    })

    it("errors when the entry does not export the named factory", async () => {
      const importer = jest.fn(async () => ({}))
      const result = await registerProtocolAdaptersForPlugin(codeManifest, "/p", { importer })
      expect(result.registered).toBe(0)
      expect(result.errors[0].message).toContain("does not export a factory")
      expect(getCodeAdapterExecutor("wire-plugin:wire")).toBeUndefined()
    })

    it("unregister drops the code executor too", async () => {
      const importer = jest.fn(async () => ({
        createAdapter: () => ({ stream: async function* () {} }),
      }))
      await registerProtocolAdaptersForPlugin(codeManifest, "/p", { importer })
      expect(getCodeAdapterExecutor("wire-plugin:wire")).toBeDefined()
      unregisterProtocolAdaptersForPlugin("wire-plugin")
      expect(getCodeAdapterExecutor("wire-plugin:wire")).toBeUndefined()
    })
  })
})

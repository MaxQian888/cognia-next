import {
  registerProtocolAdaptersForPlugin,
  unregisterProtocolAdaptersForPlugin,
} from "./protocol-adapters-bridge"
import {
  __resetProtocolAdaptersForTesting,
  getProtocolAdapter,
} from "@/lib/ai/providers/protocol-adapter-registry"
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
})

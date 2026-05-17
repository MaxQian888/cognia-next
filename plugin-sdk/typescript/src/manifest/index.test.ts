import * as manifest from "./index"
import type {
  PluginManifest,
  PluginDefinition,
  PluginCapability,
  PluginManifestDexieBlock,
} from "./index"

describe("plugin-sdk: manifest", () => {
  it("exposes definePlugin as a runtime helper", () => {
    expect(typeof manifest.definePlugin).toBe("function")
  })

  it("definePlugin is an identity pass-through that preserves manifest shape", () => {
    const def: PluginDefinition = {
      manifest: {
        id: "com.example.test",
        name: "Test",
        version: "0.0.1",
        description: "test",
        type: "frontend",
        capabilities: ["tools"],
        main: "src/index.ts",
      } as PluginManifest,
      async activate() {
        // no-op
      },
    }
    const result = manifest.definePlugin(def)
    expect(result).toBe(def)
    expect(result.manifest.id).toBe("com.example.test")
  })

  it("re-exports the manifest schema types used at authoring time", () => {
    const capability: PluginCapability = "native-anthropic-tool"
    expect(capability).toBe("native-anthropic-tool")
    const dexie: PluginManifestDexieBlock = {
      tables: [{ name: "items", schema: "++id, name" }],
    }
    expect(dexie.tables[0]?.name).toBe("items")
  })
})

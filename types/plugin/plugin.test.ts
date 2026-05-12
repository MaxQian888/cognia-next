import type { PluginManifest, PluginManifestDexieBlock } from "./plugin"

describe("PluginManifest.dexie", () => {
  it("accepts a valid dexie block", () => {
    const manifest: PluginManifest = {
      id: "test-plugin",
      name: "Test",
      version: "1.0.0",
      description: "",
      type: "frontend",
      capabilities: [],
      main: "index.js",
      dexie: {
        tables: [
          { name: "items", schema: "++id, name" },
          { name: "events", schema: "deliveryId, [target+at]" },
        ],
      },
    }
    expect(manifest.dexie?.tables.length).toBe(2)
    expect(manifest.dexie?.tables[0]?.name).toBe("items")
  })

  it("accepts a dexie block with optional migrations", () => {
    const block: PluginManifestDexieBlock = {
      tables: [{ name: "items", schema: "++id" }],
      migrations: [{ toVersion: 2, upgrade: "migrateV1ToV2" }],
    }
    expect(block.migrations?.[0]?.toVersion).toBe(2)
  })

  it("allows omitting the dexie block entirely", () => {
    const manifest: PluginManifest = {
      id: "no-dexie",
      name: "No Dexie",
      version: "1.0.0",
      description: "",
      type: "frontend",
      capabilities: [],
      main: "index.js",
    }
    expect(manifest.dexie).toBeUndefined()
  })
})

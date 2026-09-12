import type { PluginManifest } from "@/types/plugin/plugin"

import { definePlugin, definePluginManifest, type PluginManifestJson } from "./define-plugin"

describe("definePlugin", () => {
  it("returns the same definition", () => {
    const definition = {
      manifest: {
        id: "example",
        name: "Example",
        version: "1.0.0",
        type: "frontend",
        main: "index.ts",
      },
    } as never

    expect(definePlugin(definition)).toBe(definition)
  })
})

describe("definePluginManifest", () => {
  // What `import manifest from "./plugin.json"` looks like to the type checker:
  // enum fields widened to `string`.
  const json = {
    id: "example",
    name: "Example",
    version: "1.0.0",
    type: "frontend",
    capabilities: ["tools", "character-pack"],
    permissions: ["clipboard:read"],
    activationEvents: ["startup"],
    runtimeCompatibility: { browser: { availability: "supported", entrypoint: "src/index.ts" } },
  }

  it("returns the same object so runtime identity is preserved", () => {
    const manifest = definePluginManifest(json)
    expect(manifest).toBe(json)
  })

  it("accepts a JSON manifest without a cast and types the result as PluginManifest", () => {
    const manifest: PluginManifest = definePluginManifest(json)
    expect(manifest.capabilities).toEqual(["tools", "character-pack"])
    expect(manifest.runtimeCompatibility?.browser?.availability).toBe("supported")
  })

  it("accepts TypeScript-authored contribution arrays merged over the JSON", () => {
    const pack = { id: "pack", name: "Pack", version: "1.0.0", characters: [] }
    const manifest = definePluginManifest({ ...json, characterPacks: [pack] })
    expect(manifest.characterPacks).toEqual([pack])
    expect(manifest.id).toBe("example")
  })

  it("rejects a manifest missing an identity field at the type level", () => {
    // @ts-expect-error — `version` is required on the JSON side too.
    const missingVersion: PluginManifestJson = { id: "x", name: "X", type: "frontend" }
    expect(missingVersion.id).toBe("x")
  })

  it("rejects a misspelled contribution field on an object literal", () => {
    expect(() =>
      definePluginManifest({
        ...json,
        // @ts-expect-error — `characterPack` (singular) is not a PluginManifest field.
        characterPack: [],
      })
    ).not.toThrow()
  })
})

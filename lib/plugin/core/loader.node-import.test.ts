import { PluginLoader } from "./loader"
import type { Plugin } from "@/types/plugin"

function frontendPlugin(id: string): Plugin {
  return {
    manifest: {
      id,
      name: id,
      version: "1.0.0",
      description: "",
      type: "frontend",
      main: "main.js",
      capabilities: [],
    },
    path: `/abs/plugins/${id}`,
    status: "installed",
  } as unknown as Plugin
}

describe("PluginLoader frontendImporter seam", () => {
  it("loads a non-builtin frontend plugin via the injected importer", async () => {
    const seen: Array<{ abs: string; id: string }> = []
    const definition = {
      manifest: frontendPlugin("p").manifest,
      activate: async () => ({}),
    }
    const loader = new PluginLoader({
      frontendImporter: async (abs, id) => {
        seen.push({ abs, id })
        return { default: definition }
      },
    })
    const def = await loader.load(frontendPlugin("p"))
    expect(def).toBe(definition)
    expect(seen[0]).toEqual({ abs: "/abs/plugins/p/main.js", id: "p" })
  })

  it("passes the plugin id to the importer so it can cache-bust per plugin", async () => {
    const ids: string[] = []
    const definition = { manifest: frontendPlugin("a").manifest, activate: async () => ({}) }
    const loader = new PluginLoader({
      frontendImporter: async (_abs, id) => {
        ids.push(id)
        return { default: definition }
      },
    })
    await loader.load(frontendPlugin("a"))
    await loader.unload("a")
    await loader.load(frontendPlugin("a"))
    expect(ids).toEqual(["a", "a"])
  })
})

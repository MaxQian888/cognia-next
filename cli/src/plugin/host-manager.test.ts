import type { PluginManifest } from "@/types/plugin"
import { makeHostManager } from "./host-manager"

function manifest(id: string, tools?: unknown[]): PluginManifest {
  return {
    id,
    name: `${id}-name`,
    version: "1.0.0",
    description: "",
    type: "frontend",
    ...(tools ? { tools } : {}),
  } as unknown as PluginManifest
}

describe("makeHostManager", () => {
  it("delegates lifecycle calls to the injected manager", async () => {
    const calls: string[] = []
    const hm = makeHostManager({
      manager: {
        registerDiskPlugin: async (m, dir) => void calls.push(`register:${m.id}@${dir}`),
        loadPlugin: async (id) => void calls.push(`load:${id}`),
        enablePlugin: async (id) => void calls.push(`enable:${id}`),
        disablePlugin: async (id) => void calls.push(`disable:${id}`),
        unloadPlugin: async (id) => void calls.push(`unload:${id}`),
      },
      getPlugins: () => ({}),
    })
    await hm.registerDiskPlugin(manifest("x"), "/d/x")
    await hm.loadPlugin("x")
    await hm.enablePlugin("x")
    await hm.disablePlugin("x")
    await hm.unloadPlugin("x")
    expect(calls).toEqual(["register:x@/d/x", "load:x", "enable:x", "disable:x", "unload:x"])
  })

  it("projects the store plugin map into list rows (tool count from manifest)", () => {
    const hm = makeHostManager({
      manager: {} as never,
      getPlugins: () => ({
        a: {
          manifest: manifest("a", [{ name: "t1" }, { name: "t2" }]),
          path: "/d/a",
          status: "enabled",
        },
        b: { manifest: manifest("b"), path: "builtin://b", status: "disabled" },
      }),
    })
    const rows = hm.list()
    expect(rows.find((r) => r.id === "a")).toMatchObject({
      name: "a-name",
      version: "1.0.0",
      type: "frontend",
      path: "/d/a",
      status: "enabled",
    })
    expect(rows.find((r) => r.id === "a")?.tools).toHaveLength(2)
    expect(rows.find((r) => r.id === "b")?.tools).toEqual([])
  })
})

import { registerViewsForPlugin, unregisterViewsForPlugin } from "./view-bridge"
import { getViewSnapshot, __resetViewsForTesting } from "@/lib/plugin/registries/tree-view-registry"
import type { PluginManifest } from "@/types/plugin/plugin"
import type { TreeDataProvider } from "@/types/plugin/plugin-view"

function manifest(views: PluginManifest["views"]): PluginManifest {
  return {
    id: "p",
    name: "P",
    version: "1.0.0",
    capabilities: ["tree-view"],
    views,
  } as PluginManifest
}

const provider: TreeDataProvider = { getChildren: () => [{ id: "a", label: "A" }] }
const ReactView = () => null

describe("view-bridge", () => {
  afterEach(() => __resetViewsForTesting())

  it("resolves a tree provider export (object) and registers it", async () => {
    const importer = jest.fn(async () => ({ filesProvider: provider }))
    const result = await registerViewsForPlugin(
      manifest([
        {
          id: "files",
          containerId: "explorer",
          type: "tree",
          entry: "v.js",
          export: "filesProvider",
        },
      ]),
      "/root",
      { importer }
    )
    expect(result.registered).toBe(1)
    expect(importer).toHaveBeenCalledWith("/root/v.js")
    const [v] = getViewSnapshot()
    expect(v).toMatchObject({ kind: "tree", containerId: "p:explorer", viewId: "files" })
  })

  it("resolves a tree provider FACTORY export and invokes it", async () => {
    const factory = jest.fn(() => provider)
    const importer = jest.fn(async () => ({ makeProvider: factory }))
    await registerViewsForPlugin(
      manifest([
        { id: "t", containerId: "c", type: "tree", entry: "v.js", export: "makeProvider" },
      ]),
      "/root",
      { importer }
    )
    expect(factory).toHaveBeenCalled()
    expect(getViewSnapshot()).toHaveLength(1)
  })

  it("resolves a react component export", async () => {
    const importer = jest.fn(async () => ({ Panel: ReactView }))
    await registerViewsForPlugin(
      manifest([{ id: "p1", containerId: "c", type: "react", entry: "v.js", export: "Panel" }]),
      "/root",
      { importer }
    )
    const [v] = getViewSnapshot()
    expect(v.kind).toBe("react")
  })

  it("records an error for a missing export and keeps going", async () => {
    const importer = jest.fn(async () => ({ Panel: ReactView }))
    const result = await registerViewsForPlugin(
      manifest([
        { id: "bad", containerId: "c", type: "tree", entry: "v.js", export: "nope" },
        { id: "ok", containerId: "c", type: "react", entry: "v.js", export: "Panel" },
      ]),
      "/root",
      { importer }
    )
    expect(result.registered).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].viewId).toBe("bad")
  })

  it("rejects a tree export that is not a provider", async () => {
    const importer = jest.fn(async () => ({ notAProvider: { foo: 1 } }))
    const result = await registerViewsForPlugin(
      manifest([
        { id: "x", containerId: "c", type: "tree", entry: "v.js", export: "notAProvider" },
      ]),
      "/root",
      { importer }
    )
    expect(result.registered).toBe(0)
    expect(result.errors[0].message).toMatch(/TreeDataProvider/)
  })

  it("clears prior views on re-register (no double-register)", async () => {
    const importer = jest.fn(async () => ({ p: provider }))
    const m = manifest([{ id: "v", containerId: "c", type: "tree", entry: "v.js", export: "p" }])
    await registerViewsForPlugin(m, "/root", { importer })
    await registerViewsForPlugin(m, "/root", { importer })
    expect(getViewSnapshot()).toHaveLength(1)
  })

  it("no-ops for a manifest without views", async () => {
    const result = await registerViewsForPlugin(manifest(undefined), "/root", {})
    expect(result).toEqual({ registered: 0, errors: [] })
  })

  it("unregisterViewsForPlugin drops the plugin's views", async () => {
    const importer = jest.fn(async () => ({ p: provider }))
    await registerViewsForPlugin(
      manifest([{ id: "v", containerId: "c", type: "tree", entry: "v.js", export: "p" }]),
      "/root",
      { importer }
    )
    unregisterViewsForPlugin("p")
    expect(getViewSnapshot()).toHaveLength(0)
  })
})

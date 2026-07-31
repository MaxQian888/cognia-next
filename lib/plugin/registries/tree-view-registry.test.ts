import {
  registerView,
  unregisterViewsByPlugin,
  getViewSnapshot,
  listViewsForContainer,
  subscribeViews,
  __resetViewsForTesting,
} from "./tree-view-registry"
import type { ResolvedPluginView, TreeDataProvider } from "@/types/plugin/plugin-view"

const provider: TreeDataProvider = { getChildren: () => [] }

function treeView(
  over?: Partial<Extract<ResolvedPluginView, { kind: "tree" }>>
): ResolvedPluginView {
  return {
    kind: "tree",
    pluginId: "p",
    viewId: "files",
    containerId: "p:explorer",
    provider,
    ...over,
  }
}

describe("tree-view-registry", () => {
  afterEach(() => __resetViewsForTesting())

  it("registers a view and lists it by container", () => {
    registerView(treeView())
    expect(listViewsForContainer("p:explorer").map((v) => v.viewId)).toEqual(["files"])
    expect(listViewsForContainer("other")).toEqual([])
  })

  it("exposes an identity-stable snapshot that changes only on mutation", () => {
    registerView(treeView())
    const a = getViewSnapshot()
    expect(getViewSnapshot()).toBe(a)
    registerView(treeView({ viewId: "search" }))
    expect(getViewSnapshot()).not.toBe(a)
  })

  it("returns a disposer removing just that view", () => {
    const dispose = registerView(treeView())
    registerView(treeView({ viewId: "search" }))
    dispose()
    expect(getViewSnapshot().map((v) => v.viewId)).toEqual(["search"])
  })

  it("bulk-removes every view for a plugin", () => {
    registerView(treeView())
    registerView(treeView({ viewId: "search" }))
    registerView(treeView({ pluginId: "q", viewId: "z", containerId: "q:c" }))
    expect(unregisterViewsByPlugin("p")).toBe(2)
    expect(getViewSnapshot().map((v) => v.pluginId)).toEqual(["q"])
  })

  it("notifies subscribers and stops after unsubscribe", async () => {
    let calls = 0
    const unsub = subscribeViews(() => calls++)
    registerView(treeView())
    await Promise.resolve()
    unregisterViewsByPlugin("p")
    await Promise.resolve()
    expect(calls).toBe(2)
    unsub()
    registerView(treeView({ viewId: "x" }))
    await Promise.resolve()
    expect(calls).toBe(2)
  })
})

import {
  registerViewContainer,
  unregisterViewContainersByPlugin,
  getViewContainer,
  getViewContainerSnapshot,
  subscribeViewContainers,
  __resetViewContainersForTesting,
} from "./view-container-registry"
import type { PluginViewContainerDef } from "@/types/plugin/plugin-view-container"

function def(overrides?: Partial<PluginViewContainerDef>): PluginViewContainerDef {
  return { id: "explorer", title: "Explorer", ...overrides }
}

describe("view-container-registry", () => {
  afterEach(() => __resetViewContainersForTesting())

  it("registers a container under its namespaced id", () => {
    registerViewContainer(def(), { pluginId: "p" })
    expect(getViewContainer("p:explorer")).toMatchObject({
      fullId: "p:explorer",
      pluginId: "p",
      def: { title: "Explorer" },
    })
  })

  it("exposes an identity-stable snapshot that changes only on mutation", () => {
    registerViewContainer(def(), { pluginId: "p" })
    const a = getViewContainerSnapshot()
    const b = getViewContainerSnapshot()
    expect(a).toBe(b)
    registerViewContainer(def({ id: "search", title: "Search" }), { pluginId: "p" })
    expect(getViewContainerSnapshot()).not.toBe(a)
    expect(getViewContainerSnapshot().map((e) => e.fullId)).toEqual(["p:explorer", "p:search"])
  })

  it("returns a disposer that removes just that container", () => {
    const dispose = registerViewContainer(def(), { pluginId: "p" })
    registerViewContainer(def({ id: "search", title: "Search" }), { pluginId: "p" })
    dispose()
    expect(getViewContainer("p:explorer")).toBeUndefined()
    expect(getViewContainer("p:search")).toBeDefined()
  })

  it("bulk-removes every container for a plugin", () => {
    registerViewContainer(def(), { pluginId: "p" })
    registerViewContainer(def({ id: "search", title: "Search" }), { pluginId: "p" })
    registerViewContainer(def({ id: "other", title: "Other" }), { pluginId: "q" })
    expect(unregisterViewContainersByPlugin("p")).toBe(2)
    expect(getViewContainerSnapshot().map((e) => e.fullId)).toEqual(["q:other"])
  })

  it("notifies subscribers on register/unregister and stops after unsubscribe", async () => {
    let calls = 0
    const unsub = subscribeViewContainers(() => calls++)
    registerViewContainer(def(), { pluginId: "p" })
    await Promise.resolve()
    unregisterViewContainersByPlugin("p")
    await Promise.resolve()
    expect(calls).toBe(2)
    unsub()
    registerViewContainer(def({ id: "x", title: "X" }), { pluginId: "p" })
    await Promise.resolve()
    expect(calls).toBe(2)
  })
})

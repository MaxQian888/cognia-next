import {
  registerTrayItem,
  unregisterTrayItem,
  unregisterTrayItemsByPlugin,
  listTrayItems,
  listTrayItemsByPlugin,
  getTrayItem,
  subscribeTrayItems,
  __resetTrayRegistryForTesting,
} from "./registry"

afterEach(() => __resetTrayRegistryForTesting())

describe("plugin tray registry", () => {
  it("register / get round-trips", () => {
    registerTrayItem({ id: "p:a", pluginId: "p", label: "A" })
    expect(getTrayItem("p:a")?.label).toBe("A")
  })

  it("rejects items missing id or pluginId", () => {
    expect(() => registerTrayItem({ id: "", pluginId: "p", label: "A" })).toThrow(/id is required/)
    expect(() => registerTrayItem({ id: "p:a", pluginId: "", label: "A" })).toThrow(
      /pluginId is required/
    )
  })

  it("unregisterTrayItem drops one entry idempotently", () => {
    registerTrayItem({ id: "p:a", pluginId: "p", label: "A" })
    expect(unregisterTrayItem("p:a")).toBe(true)
    expect(unregisterTrayItem("p:a")).toBe(false)
    expect(getTrayItem("p:a")).toBeUndefined()
  })

  it("unregisterTrayItemsByPlugin only drops matching plugin's items", () => {
    registerTrayItem({ id: "p:a", pluginId: "p", label: "A" })
    registerTrayItem({ id: "p:b", pluginId: "p", label: "B" })
    registerTrayItem({ id: "q:c", pluginId: "q", label: "C" })
    expect(unregisterTrayItemsByPlugin("p")).toBe(2)
    expect(listTrayItems().map((i) => i.id)).toEqual(["q:c"])
  })

  it("listTrayItemsByPlugin filters", () => {
    registerTrayItem({ id: "p:a", pluginId: "p", label: "A" })
    registerTrayItem({ id: "q:b", pluginId: "q", label: "B" })
    expect(listTrayItemsByPlugin("p").map((i) => i.id)).toEqual(["p:a"])
  })

  it("subscribeTrayItems fires on register/unregister", async () => {
    const observed: string[][] = []
    const off = subscribeTrayItems((snap) => {
      observed.push(snap.map((i) => i.id))
    })
    registerTrayItem({ id: "p:a", pluginId: "p", label: "A" })
    // Wait one microtask for the queueMicrotask flush.
    await Promise.resolve()
    await Promise.resolve()
    unregisterTrayItem("p:a")
    await Promise.resolve()
    await Promise.resolve()
    off()
    expect(observed[0]).toContain("p:a")
    expect(observed[observed.length - 1]).not.toContain("p:a")
  })
})

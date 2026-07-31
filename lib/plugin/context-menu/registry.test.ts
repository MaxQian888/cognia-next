/**
 * Tests for the renderer-side plugin context-menu registry: zone
 * filtering, per-plugin bulk removal, snapshot stability, subscription.
 */

import type { ContextMenuItem } from "@/types/plugin"

import {
  __resetContextMenuRegistryForTesting,
  getContextMenuSnapshot,
  listContextMenuItemsForZone,
  registerContextMenuItem,
  subscribeContextMenuItems,
  unregisterContextMenuItem,
  unregisterContextMenuItemsByPlugin,
} from "./registry"
import {
  setContextKey,
  __resetContextKeysForTesting,
} from "@/lib/plugin/context-keys/context-key-store"

function makeItem(overrides?: Partial<ContextMenuItem>): ContextMenuItem {
  return {
    id: "demo",
    label: "Demo",
    onClick: () => {},
    ...overrides,
  }
}

afterEach(() => {
  __resetContextMenuRegistryForTesting()
})

describe("zone filtering", () => {
  it("returns items targeting the requested zone", () => {
    registerContextMenuItem({
      id: "p:msg",
      pluginId: "p",
      item: makeItem({ id: "p:msg", when: "chat:message" }),
    })
    registerContextMenuItem({
      id: "p:canvas",
      pluginId: "p",
      item: makeItem({ id: "p:canvas", when: ["canvas", "editor"] }),
    })

    expect(listContextMenuItemsForZone("chat:message").map((e) => e.id)).toEqual(["p:msg"])
    expect(listContextMenuItemsForZone("canvas").map((e) => e.id)).toEqual(["p:canvas"])
    expect(listContextMenuItemsForZone("editor").map((e) => e.id)).toEqual(["p:canvas"])
  })

  it("treats an undefined when as every zone", () => {
    registerContextMenuItem({ id: "p:any", pluginId: "p", item: makeItem({ id: "p:any" }) })

    expect(listContextMenuItemsForZone("chat:message")).toHaveLength(1)
    expect(listContextMenuItemsForZone("canvas")).toHaveLength(1)
  })
})

describe("whenExpr state filtering", () => {
  afterEach(() => __resetContextKeysForTesting())

  it("hides an item while its whenExpr is unmet and shows it when met", () => {
    registerContextMenuItem({
      id: "p:gated",
      pluginId: "p",
      item: makeItem({ id: "p:gated", whenExpr: "chat.active" }),
    })

    expect(listContextMenuItemsForZone("chat:message")).toHaveLength(0)
    setContextKey("chat.active", true)
    expect(listContextMenuItemsForZone("chat:message").map((e) => e.id)).toEqual(["p:gated"])
  })

  it("does not gate items without a whenExpr", () => {
    registerContextMenuItem({ id: "p:plain", pluginId: "p", item: makeItem({ id: "p:plain" }) })
    expect(listContextMenuItemsForZone("chat:message")).toHaveLength(1)
  })
})

describe("lifecycle", () => {
  it("requires id and pluginId", () => {
    expect(() => registerContextMenuItem({ id: "", pluginId: "p", item: makeItem() })).toThrow(
      /id is required/
    )
    expect(() => registerContextMenuItem({ id: "x", pluginId: "", item: makeItem() })).toThrow(
      /pluginId is required/
    )
  })

  it("unregisters a single item", () => {
    registerContextMenuItem({ id: "p:x", pluginId: "p", item: makeItem({ id: "p:x" }) })

    expect(unregisterContextMenuItem("p:x")).toBe(true)
    expect(unregisterContextMenuItem("p:x")).toBe(false)
    expect(getContextMenuSnapshot()).toHaveLength(0)
  })

  it("bulk-removes a plugin's items and leaves others intact", () => {
    registerContextMenuItem({ id: "a:1", pluginId: "a", item: makeItem({ id: "a:1" }) })
    registerContextMenuItem({ id: "a:2", pluginId: "a", item: makeItem({ id: "a:2" }) })
    registerContextMenuItem({ id: "b:1", pluginId: "b", item: makeItem({ id: "b:1" }) })

    expect(unregisterContextMenuItemsByPlugin("a")).toBe(2)
    expect(getContextMenuSnapshot().map((e) => e.id)).toEqual(["b:1"])
  })

  it("keeps the snapshot identity stable between mutations", () => {
    registerContextMenuItem({ id: "p:x", pluginId: "p", item: makeItem({ id: "p:x" }) })
    const first = getContextMenuSnapshot()
    expect(getContextMenuSnapshot()).toBe(first)

    registerContextMenuItem({ id: "p:y", pluginId: "p", item: makeItem({ id: "p:y" }) })
    expect(getContextMenuSnapshot()).not.toBe(first)
  })

  it("notifies subscribers on mutation", async () => {
    const listener = jest.fn()
    subscribeContextMenuItems(listener)

    registerContextMenuItem({ id: "p:x", pluginId: "p", item: makeItem({ id: "p:x" }) })
    await new Promise((r) => setTimeout(r, 0))

    expect(listener).toHaveBeenCalled()
  })
})

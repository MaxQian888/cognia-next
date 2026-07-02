import {
  __resetPetItemsForTesting,
  buildPluginItemId,
  getPluginItemDisplay,
  getProjectedPluginItem,
  listPetItemEntries,
  listProjectedPluginItems,
  projectPluginItem,
  registerPetItem,
  unregisterPetItemsByPlugin,
} from "./pet-item-registry"
import type { PluginPetItemDef } from "@/types/plugin/plugin-pet"

function def(partial: Partial<PluginPetItemDef> = {}): PluginPetItemDef {
  return {
    id: "star-cookie",
    labels: { en: "Star Cookie", "zh-CN": "星星饼干" },
    icon: "Cookie",
    category: "food",
    price: 6,
    consumable: true,
    interactionKind: "fed",
    needsEffect: { energy: 18, mood: 4 },
    ...partial,
  }
}

afterEach(() => {
  __resetPetItemsForTesting()
})

describe("pet-item-registry", () => {
  it("registers, lists, and unregisters by plugin", () => {
    registerPetItem("star-cookie", def(), { pluginId: "p1" })
    registerPetItem("bouncy", def({ id: "bouncy", category: "toy" }), { pluginId: "p2" })
    expect(listPetItemEntries()).toHaveLength(2)
    expect(unregisterPetItemsByPlugin("p2")).toBe(1)
    expect(listPetItemEntries()).toHaveLength(1)
  })

  it("projects into the host catalog shape with a namespaced id", () => {
    const projected = projectPluginItem(def(), "p1")
    expect(projected).toMatchObject({
      id: "plugin:p1:star-cookie",
      category: "food",
      price: 6,
      consumable: true,
      interactionKind: "fed",
      needsEffect: { energy: 18, mood: 4 },
    })
    expect(buildPluginItemId("p1", "star-cookie")).toBe(projected.id)
  })

  it("clamps garbage prices to at least 1 coin", () => {
    expect(projectPluginItem(def({ price: 0.4 }), "p1").price).toBe(1)
    expect(projectPluginItem(def({ price: -3 }), "p1").price).toBe(1)
  })

  it("resolves projected items + display metadata by runtime id", () => {
    registerPetItem("star-cookie", def(), { pluginId: "p1" })
    expect(listProjectedPluginItems()).toHaveLength(1)
    expect(getProjectedPluginItem("plugin:p1:star-cookie")?.price).toBe(6)
    expect(getProjectedPluginItem("plugin:p1:nope")).toBeUndefined()
    expect(getProjectedPluginItem("berry")).toBeUndefined()
    expect(getPluginItemDisplay("plugin:p1:star-cookie")?.def.labels.en).toBe("Star Cookie")
  })
})

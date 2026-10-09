/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"
import { PET_ITEMS } from "@/lib/pet/economy/item-catalog"
import {
  __resetPetItemsForTesting,
  registerPetItem,
} from "@/lib/plugin/registries/pet-item-registry"
import { usePetItemCatalog } from "./use-pet-item-catalog"

afterEach(() => __resetPetItemsForTesting())

describe("usePetItemCatalog", () => {
  it("returns the same catalog across re-renders", () => {
    const { result, rerender } = renderHook(() => usePetItemCatalog())
    const first = result.current
    expect(first.slice(0, PET_ITEMS.length)).toEqual(PET_ITEMS)
    rerender()
    expect(result.current).toBe(first)
  })

  it("picks up a plugin item that registers while mounted", () => {
    const { result } = renderHook(() => usePetItemCatalog())
    act(() => {
      registerPetItem(
        "star-cookie",
        {
          id: "star-cookie",
          labels: { en: "Star Cookie" },
          category: "food",
          price: 6,
          consumable: true,
          interactionKind: "fed",
        },
        { pluginId: "p1" }
      )
    })
    expect(result.current.map((item) => item.id)).toContain("plugin:p1:star-cookie")
  })
})

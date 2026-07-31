import { render, screen, fireEvent } from "@testing-library/react"

// Reactive reads — controllable snapshots instead of a live Dexie. The
// component registers two queries; route them by their source (the profile
// query closes over `getPetProfile`, the inventory one over `listPetInventory`).
let profileValue: unknown
let inventoryValue: unknown[]
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (fn: () => unknown) =>
    String(fn).includes("getPetProfile") ? profileValue : inventoryValue,
}))

const purchaseItem = jest.fn().mockResolvedValue({ ok: true })
const consumeItem = jest.fn().mockResolvedValue({ ok: true })
jest.mock("@/lib/pet/economy/shop", () => ({
  ...jest.requireActual("@/lib/pet/economy/shop"),
  purchaseItem: (id: string, qty?: number) => purchaseItem(id, qty),
  consumeItem: (id: string) => consumeItem(id),
}))

import { ShopTab } from "./shop-tab"
import {
  registerPetItem,
  __resetPetItemsForTesting,
} from "@/lib/plugin/registries/pet-item-registry"

beforeEach(() => {
  purchaseItem.mockClear()
  consumeItem.mockClear()
  profileValue = { coins: 30, streak: { days: 5, lastDay: "2026-07-02" } }
  inventoryValue = []
})

afterEach(() => {
  __resetPetItemsForTesting()
})

describe("ShopTab", () => {
  it("renders the balance and the streak chip", () => {
    render(<ShopTab />)
    expect(screen.getByTestId("pet-shop-balance").textContent).toContain("30")
    expect(screen.getByTestId("pet-shop-streak").textContent).toContain("5")
  })

  it("hides the streak chip at zero days and treats a missing profile as broke", () => {
    profileValue = undefined
    render(<ShopTab />)
    expect(screen.queryByTestId("pet-shop-streak")).toBeNull()
    expect(screen.getByTestId("pet-shop-balance").textContent).toContain("0")
  })

  it("lists catalog items grouped with buy buttons; buying calls purchaseItem", () => {
    render(<ShopTab />)
    const buyBerry = document.querySelector('[data-action="buy-berry"]') as HTMLButtonElement
    expect(buyBerry).not.toBeNull()
    expect(buyBerry).not.toBeDisabled()
    fireEvent.click(buyBerry)
    expect(purchaseItem).toHaveBeenCalledWith("berry", undefined)
  })

  it("disables buy when the balance can't afford the item", () => {
    profileValue = { coins: 4 }
    render(<ShopTab />)
    expect(document.querySelector('[data-action="buy-berry"]')).toBeDisabled() // price 5
    expect(document.querySelector('[data-action="buy-star-charm"]')).toBeDisabled() // price 40
  })

  it("shows the owned badge and a Use button that calls consumeItem", () => {
    inventoryValue = [{ id: "berry", qty: 2, acquiredAt: 1, updatedAt: 1 }]
    render(<ShopTab />)
    const item = document.querySelector('[data-shop-item="berry"]') as HTMLElement
    expect(item.textContent).toContain("×2")
    fireEvent.click(document.querySelector('[data-action="use-berry"]') as Element)
    expect(consumeItem).toHaveBeenCalledWith("berry")
  })

  it("renders plugin-contributed items with their plain locale labels", () => {
    registerPetItem(
      "star-cookie",
      {
        id: "star-cookie",
        labels: { en: "Star Cookie" },
        descriptions: { en: "A crunchy star-shaped snack." },
        category: "food",
        price: 10,
        consumable: true,
        interactionKind: "fed",
      },
      { pluginId: "p1" }
    )
    render(<ShopTab />)
    const item = document.querySelector(
      '[data-shop-item="plugin:p1:star-cookie"]'
    ) as HTMLElement | null
    expect(item).not.toBeNull()
    expect(item!.textContent).toContain("Star Cookie")
    expect(item!.textContent).toContain("A crunchy star-shaped snack.")
    fireEvent.click(document.querySelector('[data-action="buy-plugin:p1:star-cookie"]') as Element)
    expect(purchaseItem).toHaveBeenCalledWith("plugin:p1:star-cookie", undefined)
  })

  it("labels decor use as apply", () => {
    inventoryValue = [{ id: "star-charm", qty: 1, acquiredAt: 1, updatedAt: 1 }]
    render(<ShopTab />)
    const useBtn = document.querySelector('[data-action="use-star-charm"]') as HTMLElement
    expect(useBtn.textContent).not.toBe("")
    const berryUse = document.querySelector('[data-action="use-berry"]')
    expect(berryUse).toBeNull()
  })
})

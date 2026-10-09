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

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

import { act } from "@testing-library/react"
import { toast } from "sonner"
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

  it("shows a placeholder while the wallet and inventory load", () => {
    profileValue = undefined
    render(<ShopTab />)
    expect(screen.getByTestId("pet-shop-loading")).toBeInTheDocument()
    expect(screen.queryByTestId("pet-shop-balance")).toBeNull()
  })

  it("hides the streak chip at zero days and treats a missing profile as broke", () => {
    profileValue = null
    render(<ShopTab />)
    expect(screen.queryByTestId("pet-shop-streak")).toBeNull()
    expect(screen.getByTestId("pet-shop-balance").textContent).toContain("0")
  })

  it("lists catalog items grouped with buy buttons; buying calls purchaseItem", async () => {
    render(<ShopTab />)
    const buyBerry = document.querySelector('[data-action="buy-berry"]') as HTMLButtonElement
    expect(buyBerry).not.toBeNull()
    expect(buyBerry).not.toBeDisabled()
    await act(async () => {
      fireEvent.click(buyBerry)
    })
    expect(purchaseItem).toHaveBeenCalledWith("berry", undefined)
  })

  it("disables buy when the balance can't afford the item", () => {
    profileValue = { coins: 4 }
    render(<ShopTab />)
    expect(document.querySelector('[data-action="buy-berry"]')).toBeDisabled() // price 5
    expect(document.querySelector('[data-action="buy-star-charm"]')).toBeDisabled() // price 40
  })

  it("shows the owned badge and a Use button that calls consumeItem", async () => {
    inventoryValue = [{ id: "berry", qty: 2, acquiredAt: 1, updatedAt: 1 }]
    render(<ShopTab />)
    const item = document.querySelector('[data-shop-item="berry"]') as HTMLElement
    expect(item.textContent).toContain("×2")
    await act(async () => {
      fireEvent.click(document.querySelector('[data-action="use-berry"]') as Element)
    })
    expect(consumeItem).toHaveBeenCalledWith("berry")
  })

  it("renders plugin-contributed items with their plain locale labels", async () => {
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
    await act(async () => {
      fireEvent.click(
        document.querySelector('[data-action="buy-plugin:p1:star-cookie"]') as Element
      )
    })
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

  it("toasts a refused purchase with its reason", async () => {
    purchaseItem.mockResolvedValueOnce({ ok: false, error: "insufficient-coins" })
    render(<ShopTab />)
    await act(async () => {
      fireEvent.click(document.querySelector('[data-action="buy-berry"]') as Element)
    })
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/coins/i))
  })

  it("toasts a cooling-down use instead of losing the click", async () => {
    consumeItem.mockResolvedValueOnce({ ok: false, error: "cooling-down", retryAfterMs: 900 })
    inventoryValue = [{ id: "berry", qty: 1, acquiredAt: 1, updatedAt: 1 }]
    render(<ShopTab />)
    await act(async () => {
      fireEvent.click(document.querySelector('[data-action="use-berry"]') as Element)
    })
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("1"))
  })
})

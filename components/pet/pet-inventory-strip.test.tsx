import { render, screen, fireEvent } from "@testing-library/react"

// Reactive inventory read — a controllable snapshot instead of a live Dexie.
let inventoryValue: unknown
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => inventoryValue,
}))

const consumeItem = jest.fn().mockResolvedValue({ ok: true })
jest.mock("@/lib/pet/economy/shop", () => ({
  ...jest.requireActual("@/lib/pet/economy/shop"),
  consumeItem: (id: string) => consumeItem(id),
}))

import { PetInventoryStrip } from "./pet-inventory-strip"

beforeEach(() => {
  consumeItem.mockClear()
  inventoryValue = []
})

describe("PetInventoryStrip", () => {
  it("renders nothing while the inventory is empty or still loading", () => {
    const { rerender } = render(<PetInventoryStrip />)
    expect(screen.queryByTestId("pet-inventory-strip")).toBeNull()
    inventoryValue = undefined
    rerender(<PetInventoryStrip />)
    expect(screen.queryByTestId("pet-inventory-strip")).toBeNull()
  })

  it("shows one quick-use button per owned consumable with its qty", () => {
    inventoryValue = [
      { id: "berry", qty: 3 },
      { id: "yarn-ball", qty: 1 },
    ]
    render(<PetInventoryStrip />)
    expect(screen.getByTestId("pet-inventory-strip")).toBeInTheDocument()
    const berry = document.querySelector('[data-action="use-berry"]') as HTMLButtonElement
    expect(berry).not.toBeNull()
    expect(berry.textContent).toContain("3")
    expect(document.querySelector('[data-action="use-yarn-ball"]')).not.toBeNull()
  })

  it("excludes non-consumable decor from the strip", () => {
    inventoryValue = [{ id: "star-charm", qty: 1 }]
    render(<PetInventoryStrip />)
    expect(screen.queryByTestId("pet-inventory-strip")).toBeNull()
  })

  it("uses an item on click", () => {
    inventoryValue = [{ id: "berry", qty: 2 }]
    render(<PetInventoryStrip />)
    fireEvent.click(document.querySelector('[data-action="use-berry"]') as Element)
    expect(consumeItem).toHaveBeenCalledWith("berry")
  })
})

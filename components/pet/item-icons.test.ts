import { SparklesIcon } from "lucide-react"
import { PET_ITEM_ICONS, petItemIcon } from "./item-icons"
import { PET_ITEMS } from "@/lib/pet/economy/item-catalog"

describe("item-icons", () => {
  it("maps every catalog icon name to a component", () => {
    for (const item of PET_ITEMS) {
      expect(PET_ITEM_ICONS[item.icon]).toBeDefined()
    }
  })

  it("falls back to sparkles for unknown names", () => {
    expect(petItemIcon("NotAnIcon")).toBe(SparklesIcon)
    expect(petItemIcon("Cherry")).not.toBe(SparklesIcon)
  })
})

import { defineTrayItem } from "./define-tray-item"

describe("defineTrayItem", () => {
  it("returns the tray item definition unchanged (pure pass-through)", () => {
    const onClick = jest.fn()
    const def = defineTrayItem({
      id: "quick-note",
      label: "Quick Note",
      icon: "StickyNote",
      onClick,
    })
    expect(def).toMatchObject({ id: "quick-note", label: "Quick Note", icon: "StickyNote" })
    expect(def.onClick).toBe(onClick)
  })
})

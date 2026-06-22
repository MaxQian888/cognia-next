import { defineQuickAction } from "./define-quick-action"

describe("defineQuickAction", () => {
  it("returns the quick-action definition unchanged (pure pass-through)", () => {
    const def = defineQuickAction({
      id: "open-thing",
      title: "Open Thing",
      description: "Opens the thing",
      command: "thing.open",
      surfaces: ["palette", "tray"],
    })
    expect(def).toMatchObject({ id: "open-thing", title: "Open Thing", command: "thing.open" })
    expect(def.surfaces).toEqual(["palette", "tray"])
  })
})

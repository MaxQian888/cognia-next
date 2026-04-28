import { cn } from "./utils"

describe("cn", () => {
  it("merges tailwind classes and resolves conflicts", () => {
    expect(cn("px-2", "px-4", "text-sm", "font-medium")).toBe("px-4 text-sm font-medium")
  })

  it("handles conditional values", () => {
    expect(
      cn("base", {
        active: true,
        disabled: false,
      })
    ).toBe("base active")
  })
})

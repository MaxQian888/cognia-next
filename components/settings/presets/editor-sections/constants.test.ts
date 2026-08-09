import { SDK_EFFORT_LEVELS } from "@/lib/ai/thinking-level"
import { COLOR_PALETTE, EFFORT_LEVELS } from "./constants"

describe("preset editor constants", () => {
  it("reuses the canonical SDK effort tiers without off or ultracode", () => {
    expect(EFFORT_LEVELS).toBe(SDK_EFFORT_LEVELS)
    expect(EFFORT_LEVELS).toEqual(["low", "medium", "high", "xhigh", "max"])
  })

  it("provides a stable palette of unique oklch colors", () => {
    expect(COLOR_PALETTE).toHaveLength(12)
    expect(new Set(COLOR_PALETTE).size).toBe(COLOR_PALETTE.length)
    expect(COLOR_PALETTE.every((color) => color.startsWith("oklch("))).toBe(true)
  })
})

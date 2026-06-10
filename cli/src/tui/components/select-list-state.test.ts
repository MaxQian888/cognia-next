/**
 * @jest-environment node
 */
import { clampIndex, moveIndex } from "./select-list-state"

describe("moveIndex", () => {
  it("wraps forward and backward", () => {
    expect(moveIndex(0, 1, 3)).toBe(1)
    expect(moveIndex(2, 1, 3)).toBe(0)
    expect(moveIndex(0, -1, 3)).toBe(2)
  })
  it("returns 0 for an empty list", () => {
    expect(moveIndex(0, 1, 0)).toBe(0)
  })
})

describe("clampIndex", () => {
  it("clamps to the list bounds", () => {
    expect(clampIndex(5, 3)).toBe(2)
    expect(clampIndex(-2, 3)).toBe(0)
    expect(clampIndex(1, 3)).toBe(1)
  })
  it("returns 0 for an empty list", () => {
    expect(clampIndex(2, 0)).toBe(0)
  })
})

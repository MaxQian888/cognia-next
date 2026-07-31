import { isFullyOccluded, rectContains, type OcclusionRect } from "./occlusion"

const pet: OcclusionRect = { x: 100, y: 100, width: 50, height: 50 }

describe("rectContains", () => {
  it("is true when outer fully contains inner", () => {
    expect(rectContains({ x: 0, y: 0, width: 500, height: 500 }, pet)).toBe(true)
  })

  it("is false when inner pokes out", () => {
    expect(rectContains({ x: 120, y: 0, width: 500, height: 500 }, pet)).toBe(false)
  })

  it("is true for an exact match", () => {
    expect(rectContains(pet, pet)).toBe(true)
  })
})

describe("isFullyOccluded", () => {
  it("is false with no surfaces", () => {
    expect(isFullyOccluded(pet, [])).toBe(false)
  })

  it("is true when one surface covers the pet", () => {
    expect(
      isFullyOccluded(pet, [
        { x: 0, y: 0, width: 40, height: 40 }, // partial
        { x: 90, y: 90, width: 100, height: 100 }, // covers
      ])
    ).toBe(true)
  })

  it("is false when only partial overlaps exist", () => {
    expect(isFullyOccluded(pet, [{ x: 120, y: 120, width: 100, height: 100 }])).toBe(false)
  })
})

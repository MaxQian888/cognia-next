import { flavorForCareQuality } from "./evolution-flavor"

describe("flavorForCareQuality", () => {
  it.each([
    [0, "plain"],
    [39, "plain"],
    [40, "normal"],
    [50, "normal"],
    [75, "normal"],
    [76, "radiant"],
    [100, "radiant"],
  ])("careQuality %i → %s", (quality, flavor) => {
    expect(flavorForCareQuality(quality)).toBe(flavor)
  })

  it("treats non-finite input as normal", () => {
    expect(flavorForCareQuality(Number.NaN)).toBe("normal")
    expect(flavorForCareQuality(Infinity)).toBe("normal")
  })
})

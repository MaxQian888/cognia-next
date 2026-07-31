import { defineDensityPreset } from "./define-density-preset"

describe("defineDensityPreset", () => {
  it("returns the density preset definition unchanged", () => {
    const def = {
      name: "compact-plus",
      vars: {
        "--density-spacing": "0.75rem",
        "--density-input-height": "2rem",
      },
    }

    expect(defineDensityPreset(def)).toBe(def)
  })
})

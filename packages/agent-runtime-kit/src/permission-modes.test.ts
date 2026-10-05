import { MODE_RANK } from "./permission-modes"

describe("MODE_RANK", () => {
  it("orders modes from most to least restrictive", () => {
    const ordered = Object.entries(MODE_RANK)
      .sort(([, a], [, b]) => a - b)
      .map(([mode]) => mode)
    expect(ordered).toEqual(["plan", "dontAsk", "default", "acceptEdits", "bypassPermissions"])
  })

  it("ranks dontAsk below default: it denies everything not pre-approved", () => {
    expect(MODE_RANK.dontAsk).toBeLessThan(MODE_RANK.default)
  })
})

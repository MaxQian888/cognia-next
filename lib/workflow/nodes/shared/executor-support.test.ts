import * as support from "./executor-support"

describe("built-in executor support", () => {
  it("exposes shared executor helpers", () => {
    expect(Object.keys(support).length).toBeGreaterThan(0)
  })
})

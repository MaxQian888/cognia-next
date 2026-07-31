import { nextNavEpoch } from "./nav-epoch"

describe("nextNavEpoch", () => {
  it("returns a strictly increasing value on each call", () => {
    const a = nextNavEpoch()
    const b = nextNavEpoch()
    const c = nextNavEpoch()
    expect(b).toBeGreaterThan(a)
    expect(c).toBeGreaterThan(b)
  })
})

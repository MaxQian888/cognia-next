import {
  __resetActivitySignalForTesting,
  getLastActivityAtMs,
  markActivity,
} from "./activity-signal"

afterEach(() => {
  __resetActivitySignalForTesting()
})

describe("activity-signal", () => {
  it("starts unknown", () => {
    expect(getLastActivityAtMs()).toBeNull()
  })

  it("keeps the newest timestamp (out-of-order marks don't regress)", () => {
    markActivity(1000)
    markActivity(500)
    expect(getLastActivityAtMs()).toBe(1000)
    markActivity(2000)
    expect(getLastActivityAtMs()).toBe(2000)
  })
})

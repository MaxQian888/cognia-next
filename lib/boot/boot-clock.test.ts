import { formatBootDuration, liveBootSeconds } from "./boot-clock"

describe("formatBootDuration", () => {
  it("prints seconds to one decimal", () => {
    expect(formatBootDuration(450)).toBe("0.5")
    expect(formatBootDuration(4000)).toBe("4.0")
  })

  it("never prints a zero duration", () => {
    expect(formatBootDuration(0)).toBe("0.1")
  })
})

describe("liveBootSeconds", () => {
  it("is null without an anchor", () => {
    expect(liveBootSeconds(5000, null)).toBeNull()
  })

  it("is null under a second, so a counter never opens on zero", () => {
    expect(liveBootSeconds(1999, 1000)).toBeNull()
    expect(liveBootSeconds(500, 1000)).toBeNull()
  })

  it("counts whole seconds", () => {
    expect(liveBootSeconds(2000, 1000)).toBe(1)
    expect(liveBootSeconds(4900, 1000)).toBe(3)
  })
})

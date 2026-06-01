import { greetingSlot } from "./greeting"

/** Build a Date at a specific local hour (minute/second irrelevant to the slot). */
function at(hour: number, minute = 0): Date {
  const d = new Date(2026, 4, 31, hour, minute, 0, 0)
  return d
}

describe("greetingSlot", () => {
  it("returns night for the small hours (00:00–04:59)", () => {
    expect(greetingSlot(at(0))).toBe("night")
    expect(greetingSlot(at(4, 59))).toBe("night")
  })

  it("returns morning for 05:00–11:59", () => {
    expect(greetingSlot(at(5))).toBe("morning")
    expect(greetingSlot(at(11, 59))).toBe("morning")
  })

  it("returns afternoon for 12:00–17:59", () => {
    expect(greetingSlot(at(12))).toBe("afternoon")
    expect(greetingSlot(at(17, 59))).toBe("afternoon")
  })

  it("returns evening for 18:00–21:59", () => {
    expect(greetingSlot(at(18))).toBe("evening")
    expect(greetingSlot(at(21, 59))).toBe("evening")
  })

  it("returns night for the late hours (22:00–23:59)", () => {
    expect(greetingSlot(at(22))).toBe("night")
    expect(greetingSlot(at(23, 59))).toBe("night")
  })

  it("defaults to the current time when no date is passed", () => {
    // Smoke test: a valid slot is returned for "now" without throwing.
    expect(["morning", "afternoon", "evening", "night"]).toContain(greetingSlot())
  })
})

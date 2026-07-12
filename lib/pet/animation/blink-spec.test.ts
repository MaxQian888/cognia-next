import { resolveBlink } from "./blink-spec"

describe("resolveBlink", () => {
  it("returns a loop for blinkable eye shapes", () => {
    for (const eyes of ["dot", "wide"] as const) {
      const spec = resolveBlink(eyes, false, 42)
      expect(spec).not.toBeNull()
      expect(spec!.intervalSec).toBeGreaterThanOrEqual(3)
      expect(spec!.intervalSec).toBeLessThanOrEqual(7)
      expect(spec!.scaleY).toHaveLength(spec!.times.length)
      // Dips nearly closed then reopens.
      expect(Math.min(...spec!.scaleY)).toBeLessThan(0.2)
      expect(spec!.scaleY[spec!.scaleY.length - 1]).toBe(1)
      // Times are sorted within [0, 1].
      const sorted = [...spec!.times].sort((a, b) => a - b)
      expect(spec!.times).toEqual(sorted)
      expect(spec!.times[0]).toBe(0)
      expect(spec!.times[spec!.times.length - 1]).toBe(1)
    }
  })

  it("suppresses blinking for closed/expressive eye shapes", () => {
    for (const eyes of ["sleepy", "wink", "star", "spiral"] as const) {
      expect(resolveBlink(eyes, false, 42)).toBeNull()
    }
  })

  it("suppresses blinking on still frames", () => {
    expect(resolveBlink("dot", true, 42)).toBeNull()
  })

  it("derives the interval deterministically from the seed", () => {
    const a = resolveBlink("dot", false, 123)!
    const b = resolveBlink("dot", false, 123)!
    const c = resolveBlink("dot", false, 999)!
    expect(a.intervalSec).toBe(b.intervalSec)
    expect(a.intervalSec).not.toBe(c.intervalSec)
    // Negative / fractional seeds are tolerated.
    expect(resolveBlink("dot", false, -5.7)).not.toBeNull()
  })
})

import { percentile, percentilesOf } from "./percentiles"

describe("percentiles", () => {
  describe("percentile", () => {
    it("returns 0 for an empty array", () => {
      expect(percentile([], 0.5)).toBe(0)
    })

    it("returns the single value for a one-element array", () => {
      expect(percentile([42], 0.95)).toBe(42)
    })

    it("computes the median with interpolation", () => {
      expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5)
    })

    it("returns the min at p=0 and max at p=1", () => {
      const a = [10, 20, 30, 40, 50]
      expect(percentile(a, 0)).toBe(10)
      expect(percentile(a, 1)).toBe(50)
    })

    it("interpolates p95 between ranks", () => {
      const a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
      // rank = 0.95 * 9 = 8.55 → between index 8 (9) and 9 (10)
      expect(percentile(a, 0.95)).toBeCloseTo(9.55, 5)
    })

    it("clamps out-of-range p", () => {
      const a = [1, 2, 3]
      expect(percentile(a, -1)).toBe(1)
      expect(percentile(a, 2)).toBe(3)
    })

    it("handles an all-equal array", () => {
      expect(percentile([5, 5, 5, 5], 0.5)).toBe(5)
    })
  })

  describe("percentilesOf", () => {
    it("returns zeros for empty input", () => {
      expect(percentilesOf([], [0.5, 0.95, 0.99])).toEqual([0, 0, 0])
    })

    it("sorts once and returns one value per requested percentile", () => {
      const out = percentilesOf([5, 1, 4, 2, 3], [0, 0.5, 1])
      expect(out).toEqual([1, 3, 5])
    })

    it("does not mutate the input", () => {
      const input = [3, 1, 2]
      percentilesOf(input, [0.5])
      expect(input).toEqual([3, 1, 2])
    })
  })
})

import { markedGauge, sparkline, stackedBar } from "./charts"

describe("sparkline", () => {
  it("returns an empty string for no values", () => {
    expect(sparkline([])).toBe("")
  })

  it("filters out non-finite values and returns empty when nothing remains", () => {
    expect(sparkline([NaN, Infinity, -Infinity])).toBe("")
  })

  it("renders a single value as a single tick", () => {
    const out = sparkline([42])
    expect(out).toHaveLength(1)
    // A flat (span 0) series renders a mid-height tick, never the floor.
    expect(out).toBe("▄")
  })

  it("renders a flat series as repeated mid ticks (not a floor)", () => {
    expect(sparkline([5, 5, 5])).toBe("▄▄▄")
  })

  it("scales an increasing series from the lowest to the highest tick", () => {
    const out = sparkline([0, 100])
    expect(out[0]).toBe("▁")
    expect(out[out.length - 1]).toBe("█")
  })

  it("produces a monotonic shape for a monotonic series", () => {
    const ticks = "▁▂▃▄▅▆▇█"
    const out = sparkline([1, 2, 3, 4, 5, 6, 7, 8])
    for (let i = 1; i < out.length; i++) {
      expect(ticks.indexOf(out[i])).toBeGreaterThanOrEqual(ticks.indexOf(out[i - 1]))
    }
  })

  it("samples the last `width` values when the series is longer", () => {
    const out = sparkline([1, 2, 3, 4, 5], 3)
    expect(out).toHaveLength(3)
    // Only [3,4,5] survive → scaled low→high.
    expect(out[0]).toBe("▁")
    expect(out[2]).toBe("█")
  })

  it("keeps the whole series when shorter than width", () => {
    expect(sparkline([1, 2], 10)).toHaveLength(2)
  })

  it("ignores a non-positive width", () => {
    expect(sparkline([1, 2, 3], 0)).toHaveLength(3)
  })
})

describe("stackedBar", () => {
  it("returns no runs for a non-positive width", () => {
    expect(stackedBar([{ value: 1 }], 0)).toEqual([])
    expect(stackedBar([{ value: 1 }], -4)).toEqual([])
  })

  it("renders an empty gray track when every segment is zero", () => {
    const runs = stackedBar([{ value: 0 }, { value: 0 }], 6)
    expect(runs).toEqual([{ text: "▱▱▱▱▱▱", color: "gray" }])
  })

  it("renders an empty gray track for no segments", () => {
    expect(stackedBar([], 4)).toEqual([{ text: "▱▱▱▱", color: "gray" }])
  })

  it("apportions width proportionally and always sums to the full width", () => {
    const runs = stackedBar(
      [
        { value: 1, color: "green" },
        { value: 1, color: "blue" },
      ],
      10
    )
    const total = runs.reduce((n, r) => n + r.text.length, 0)
    expect(total).toBe(10)
    expect(runs).toHaveLength(2)
    expect(runs[0].color).toBe("green")
  })

  it("uses largest-remainder so the runs sum exactly even with uneven shares", () => {
    const runs = stackedBar([{ value: 1 }, { value: 1 }, { value: 1 }], 10)
    expect(runs.reduce((n, r) => n + r.text.length, 0)).toBe(10)
  })

  it("drops zero-valued segments", () => {
    const runs = stackedBar(
      [
        { value: 5, color: "green" },
        { value: 0, color: "red" },
      ],
      4
    )
    expect(runs).toHaveLength(1)
    expect(runs[0]).toEqual({ text: "████", color: "green" })
  })

  it("omits the color key when a segment has none", () => {
    const runs = stackedBar([{ value: 1 }], 3)
    expect(runs[0]).toEqual({ text: "███" })
    expect("color" in runs[0]).toBe(false)
  })

  it("honors a custom fill glyph", () => {
    const runs = stackedBar([{ value: 1, char: "▓" }], 3)
    expect(runs[0].text).toBe("▓▓▓")
  })

  it("drops a positive segment too small to claim a cell", () => {
    // 1/101 of 3 cells rounds to 0 — the dominant segment takes the whole bar.
    const runs = stackedBar([{ value: 100 }, { value: 1 }], 3)
    expect(runs).toHaveLength(1)
    expect(runs[0].text).toBe("███")
  })
})

describe("markedGauge", () => {
  it("places the marker at the threshold cell with no fill", () => {
    expect(markedGauge(0, 80, 10)).toBe("[▱▱▱▱▱▱▱▱┊▱] 0%")
  })

  it("fills up to the current pct and keeps the marker visible", () => {
    expect(markedGauge(50, 80, 10)).toBe("[█████▱▱▱┊▱] 50%")
  })

  it("shows the marker even when usage is past the threshold", () => {
    expect(markedGauge(95, 80, 10)).toBe("[████████┊█] 95%")
  })

  it("clamps both percentages to 0–100", () => {
    expect(markedGauge(-20, 200, 5)).toBe("[▱▱▱▱┊] 0%")
    expect(markedGauge(150, -5, 5)).toBe("[┊████] 100%")
  })
})

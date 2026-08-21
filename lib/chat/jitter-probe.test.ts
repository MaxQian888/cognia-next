/** @jest-environment jsdom */

import {
  STABILITY_EPSILON_PX,
  analyzeStability,
  createStabilityProbe,
  formatStabilityReport,
} from "./jitter-probe"

describe("analyzeStability", () => {
  it("reports a stationary sentinel as stable", () => {
    // What a correctly pinned transcript looks like from the foot: the tail
    // holds its viewport position while content is appended above it.
    const report = analyzeStability([300, 300, 300, 300])
    expect(report.reversals).toBe(0)
    expect(report.netPx).toBe(0)
  })

  it("reports monotonic travel as stable however far it goes", () => {
    // Scrolling up through a long reply is a big net displacement and no
    // jitter at all. A px-budget gate would flag this; a direction gate does
    // not, which is exactly why the metric is direction.
    const positions = Array.from({ length: 200 }, (_, index) => 800 - index * 22)
    const report = analyzeStability(positions)
    expect(report.reversals).toBe(0)
    expect(report.netPx).toBeLessThan(-4000)
  })

  it("catches the paint-then-correct signature", () => {
    // The bug: the browser paints the growth (sentinel pushed DOWN by 22px),
    // and only the next frame pulls the scroll back (sentinel snaps UP).
    const report = analyzeStability([300, 322, 300, 322, 300])
    expect(report.reversals).toBe(3)
    expect(report.maxReversalPx).toBeCloseTo(22)
    expect(report.detail.map((entry) => entry.frame)).toEqual([2, 3, 4])
  })

  it("counts one reversal per direction change, not per frame", () => {
    // Down for three frames, then up for three: one flip, not three.
    const report = analyzeStability([300, 310, 320, 330, 320, 310, 300])
    expect(report.reversals).toBe(1)
    expect(report.detail[0]!.frame).toBe(4)
  })

  it("ignores sub-pixel noise rather than reading it as direction", () => {
    // Fractional layout rounding must not manufacture reversals, and must not
    // give a stationary sentinel a direction it never had.
    const report = analyzeStability([300, 300.3, 299.8, 300.2, 300])
    expect(report.reversals).toBe(0)
  })

  it("does not let noise split a genuine drift into reversals", () => {
    const positions: number[] = []
    for (let index = 0; index < 60; index++) {
      positions.push(500 - index * 4 + (index % 2 === 0 ? 0.2 : -0.2))
    }
    expect(analyzeStability(positions).reversals).toBe(0)
  })

  it("respects a caller-supplied epsilon", () => {
    const positions = [300, 305, 300]
    expect(analyzeStability(positions).reversals).toBe(1)
    expect(analyzeStability(positions, 10).reversals).toBe(0)
  })

  it("handles degenerate inputs", () => {
    expect(analyzeStability([])).toMatchObject({ samples: 0, reversals: 0, netPx: 0 })
    expect(analyzeStability([42])).toMatchObject({ samples: 1, reversals: 0, netPx: 0 })
  })

  it("defaults the epsilon to half a pixel", () => {
    expect(STABILITY_EPSILON_PX).toBe(0.5)
  })
})

describe("formatStabilityReport", () => {
  it("says stable and reports the travel when nothing reversed", () => {
    expect(formatStabilityReport(analyzeStability([300, 260, 220]))).toBe(
      "stable — 3 frames, -80.0px net travel"
    )
  })

  it("points at the offending frames when something did", () => {
    const line = formatStabilityReport(analyzeStability([300, 322, 300]))
    expect(line).toContain("1 reversal(s)")
    expect(line).toContain("22.0px")
    expect(line).toContain("frame 2")
  })
})

describe("createStabilityProbe", () => {
  let queue: FrameRequestCallback[]

  beforeEach(() => {
    queue = []
    jest.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      queue.push(callback)
      return queue.length
    })
    jest.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {})
  })

  afterEach(() => jest.restoreAllMocks())

  const drain = (frames: number) => {
    for (let index = 0; index < frames; index++) {
      const next = queue.shift()
      if (!next) break
      next(0)
    }
  }

  it("samples once per frame and analyses what it collected", () => {
    // Down 22, then up 22 and up 22 more: one direction change.
    const readings = [300, 322, 300, 278]
    let cursor = 0
    const probe = createStabilityProbe({ read: () => readings[cursor++] ?? 278 })
    drain(4)
    const report = probe.stop()
    expect(report.samples).toBe(4)
    expect(report.reversals).toBe(1)
    expect(report.detail[0]!.frame).toBe(2)
  })

  it("stops itself at maxFrames so a forgotten probe cannot run forever", () => {
    const probe = createStabilityProbe({ read: () => 0, maxFrames: 3 })
    drain(10)
    expect(probe.stop().samples).toBe(3)
    expect(queue).toHaveLength(0)
  })

  it("stops sampling once stopped", () => {
    const read = jest.fn(() => 0)
    const probe = createStabilityProbe({ read })
    drain(2)
    probe.stop()
    const before = read.mock.calls.length
    drain(5)
    expect(read.mock.calls.length).toBe(before)
  })
})

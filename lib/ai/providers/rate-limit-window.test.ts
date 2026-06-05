// Coverage for the pure 60s sliding-window rate counter.

import { currentRate, recordRate, RATE_WINDOW_MS, type RateEvent } from "./rate-limit-window"

const T0 = 1_000_000

describe("recordRate", () => {
  it("appends an event and returns a new array", () => {
    const before: RateEvent[] = []
    const after = recordRate(before, 100, T0)
    expect(after).toHaveLength(1)
    expect(after).not.toBe(before)
    expect(after[0]).toEqual({ ts: T0, tokens: 100 })
  })

  it("prunes events older than the window", () => {
    let events = recordRate([], 10, T0)
    events = recordRate(events, 20, T0 + RATE_WINDOW_MS + 1)
    expect(events).toHaveLength(1)
    expect(events[0].tokens).toBe(20)
  })

  it("clamps unknown/invalid token counts to 0", () => {
    const events = recordRate(recordRate([], Number.NaN, T0), -5, T0 + 1)
    expect(events.map((e) => e.tokens)).toEqual([0, 0])
  })
})

describe("currentRate", () => {
  it("counts requests and sums tokens inside the trailing window", () => {
    let events = recordRate([], 100, T0)
    events = recordRate(events, 200, T0 + 1000)
    events = recordRate(events, 300, T0 + 2000)
    expect(currentRate(events, T0 + 2000)).toEqual({ rpm: 3, tpm: 600 })
  })

  it("excludes events that have aged out without mutating the array", () => {
    let events = recordRate([], 100, T0)
    events = recordRate(events, 200, T0 + 30_000)
    // 61s after the first event: only the second one counts.
    expect(currentRate(events, T0 + RATE_WINDOW_MS + 1)).toEqual({ rpm: 1, tpm: 200 })
    expect(events).toHaveLength(2)
  })

  it("returns zeros for an empty window", () => {
    expect(currentRate([], T0)).toEqual({ rpm: 0, tpm: 0 })
  })
})

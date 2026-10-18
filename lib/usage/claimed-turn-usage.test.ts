import {
  MAX_CLAIMED_TURNS,
  __resetClaimedTurnUsageForTesting,
  claimTurnUsage,
  isTurnUsageClaimed,
  trackCaptureUsage,
} from "./claimed-turn-usage"

beforeEach(() => __resetClaimedTurnUsageForTesting())

describe("claimTurnUsage", () => {
  it("claims exactly one session's turn", () => {
    claimTurnUsage("s1", "t1")
    expect(isTurnUsageClaimed("s1", "t1")).toBe(true)
    // A later interactive turn in the same session is still the chat runtime's.
    expect(isTurnUsageClaimed("s1", "t2")).toBe(false)
    expect(isTurnUsageClaimed("s2", "t1")).toBe(false)
  })

  it("never treats a turn-less event as claimed", () => {
    claimTurnUsage("s1", "t1")
    expect(isTurnUsageClaimed("s1", undefined)).toBe(false)
  })

  it("ignores an empty claim", () => {
    claimTurnUsage("", "t1")
    claimTurnUsage("s1", "")
    expect(isTurnUsageClaimed("", "t1")).toBe(false)
    expect(isTurnUsageClaimed("s1", "")).toBe(false)
  })

  it("keeps the newest claims when the bound is exceeded", () => {
    for (let i = 0; i <= MAX_CLAIMED_TURNS; i++) claimTurnUsage("s", `t${i}`)
    expect(isTurnUsageClaimed("s", "t0")).toBe(false)
    expect(isTurnUsageClaimed("s", "t1")).toBe(true)
    expect(isTurnUsageClaimed("s", `t${MAX_CLAIMED_TURNS}`)).toBe(true)
  })

  it("refreshes a re-claimed turn so it is not evicted first", () => {
    claimTurnUsage("s", "keep")
    for (let i = 0; i < MAX_CLAIMED_TURNS - 1; i++) claimTurnUsage("s", `t${i}`)
    claimTurnUsage("s", "keep")
    claimTurnUsage("s", "overflow")
    expect(isTurnUsageClaimed("s", "keep")).toBe(true)
    expect(isTurnUsageClaimed("s", "t0")).toBe(false)
  })
})

describe("trackCaptureUsage", () => {
  it("prefers the resolved result usage", () => {
    const tracker = trackCaptureUsage()
    tracker.observe({ type: "usage", usage: { inputTokens: 1 } })
    expect(tracker.resolve({ inputTokens: 9 })).toEqual({ inputTokens: 9 })
  })

  it("falls back to the last authoritative streamed usage", () => {
    const tracker = trackCaptureUsage()
    tracker.observe({ type: "usage", usage: { inputTokens: 1 } })
    tracker.observe({ type: "usage", usage: { inputTokens: 5, outputTokens: 2 } })
    expect(tracker.resolve(undefined)).toEqual({ inputTokens: 5, outputTokens: 2 })
  })

  it("ignores partial snapshots and other events", () => {
    const tracker = trackCaptureUsage()
    tracker.observe({ type: "usage", usage: { inputTokens: 3 }, partial: true })
    tracker.observe({ type: "text-delta", delta: "hi" })
    expect(tracker.resolve(undefined)).toBeUndefined()
  })
})

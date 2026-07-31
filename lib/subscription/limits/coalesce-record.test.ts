import { applyCoalescedResult, isRateLimitError, type CoalesceResultState } from "./coalesce-record"

import type { LimitsMeter, ProviderLimits } from "@/types/subscription"

const meter: LimitsMeter = { id: "session", kind: "window", usedPct: 40, status: "ok" }

function ok(overrides: Partial<ProviderLimits> = {}): ProviderLimits {
  return { provider: "anthropic", fetchedAt: 1, meters: [meter], ...overrides }
}

function errored(error: string): ProviderLimits {
  return { provider: "anthropic", fetchedAt: 2, meters: [], error }
}

function freshState(): CoalesceResultState {
  return { blockedUntil: 0, lastResult: null, lastSuccessfulResult: null }
}

describe("isRateLimitError", () => {
  it("matches a 429 token wherever it stands as its own word", () => {
    expect(isRateLimitError("429 Too Many Requests")).toBe(true)
    expect(isRateLimitError("HTTP 429")).toBe(true) // trailing 429
    expect(isRateLimitError("429")).toBe(true) // bare
    expect(isRateLimitError("限额查询失败: 429")).toBe(true)
    expect(isRateLimitError("429: slow down")).toBe(true)
  })

  it("does not match a 429 lookalike", () => {
    expect(isRateLimitError("4290 gateway error")).toBe(false)
    expect(isRateLimitError("not429")).toBe(false)
    expect(isRateLimitError("500 Internal Server Error")).toBe(false)
  })
})

describe("applyCoalescedResult", () => {
  it("remembers the last successful snapshot and returns it unchanged", () => {
    const state = freshState()
    const result = ok()
    expect(applyCoalescedResult(state, result, () => 100, 1000)).toBe(result)
    expect(state.lastSuccessfulResult).toBe(result)
    expect(state.lastResult).toBe(result)
    expect(state.blockedUntil).toBe(0)
  })

  it("carries the last good meters forward on a later error", () => {
    const state = freshState()
    applyCoalescedResult(state, ok(), () => 100, 1000)
    const display = applyCoalescedResult(state, errored("boom"), () => 200, 1000)
    expect(display?.meters).toEqual([meter])
    expect(display?.error).toBe("boom")
    // The successful snapshot is retained, not overwritten by the error.
    expect(state.lastSuccessfulResult?.meters).toEqual([meter])
  })

  it("arms the 429 backoff from the injected clock", () => {
    const state = freshState()
    applyCoalescedResult(state, errored("429 Too Many Requests"), () => 500, 15_000)
    expect(state.blockedUntil).toBe(15_500)
  })

  it("does not back off on a non-429 error", () => {
    const state = freshState()
    applyCoalescedResult(state, errored("500 Internal Server Error"), () => 500, 15_000)
    expect(state.blockedUntil).toBe(0)
  })

  it("passes a null result through without mutating state", () => {
    const state = freshState()
    expect(applyCoalescedResult(state, null, () => 100, 1000)).toBeNull()
    expect(state.lastResult).toBeNull()
    expect(state.lastSuccessfulResult).toBeNull()
    expect(state.blockedUntil).toBe(0)
  })
})

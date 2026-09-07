import { BACKOFF_POLICIES } from "@/lib/subscription/retry/backoff"
import { SubscriptionBreaker } from "@/lib/subscription/retry/breaker"

import {
  applyCoalescedResult,
  limitsBreakerKey,
  recordCoalescedThrow,
  type CoalesceResultState,
  type RecordCoalescedOptions,
} from "./coalesce-record"

import type { ProviderLimits } from "@/types/subscription"

const NOW = 1_000_000
const meter = { id: "session", kind: "window" as const, usedPct: 12, status: "ok" as const }

const ok = (): ProviderLimits => ({
  provider: "anthropic",
  accountId: "acc-1",
  fetchedAt: NOW,
  meters: [meter],
})
const errored = (error: string): ProviderLimits => ({
  provider: "anthropic",
  accountId: "acc-1",
  fetchedAt: NOW,
  meters: [],
  error,
})

function freshState(): CoalesceResultState {
  return { lastResult: null, lastSuccessfulResult: null }
}

let breaker: SubscriptionBreaker
let options: RecordCoalescedOptions
const key = limitsBreakerKey("anthropic", "acc-1")

beforeEach(() => {
  breaker = new SubscriptionBreaker()
  options = {
    provider: "anthropic",
    accountId: "acc-1",
    now: () => NOW,
    breaker,
    random: () => 0,
  }
})

describe("applyCoalescedResult", () => {
  it("passes a successful result through and remembers it", () => {
    const state = freshState()
    const result = ok()
    expect(applyCoalescedResult(state, result, options)).toBe(result)
    expect(state.lastSuccessfulResult).toBe(result)
    expect(state.lastResult).toBe(result)
  })

  it("carries the last good meters forward on a later error", () => {
    const state = freshState()
    applyCoalescedResult(state, ok(), options)
    const display = applyCoalescedResult(state, errored("500: boom"), options)
    expect(display).toMatchObject({ error: "500: boom", meters: [meter] })
  })

  it("leaves meters empty when there is no earlier success to carry", () => {
    const display = applyCoalescedResult(freshState(), errored("500: boom"), options)
    expect(display).toMatchObject({ error: "500: boom", meters: [] })
  })

  it("arms a classified block from the injected clock", () => {
    applyCoalescedResult(freshState(), errored("429: 5 requests per minute"), options)
    expect(breaker.peek(key).blockedUntil).toBe(NOW + BACKOFF_POLICIES.throttled.baseMs)
  })

  it("arms a block for a non-429 failure, which used to arm nothing", () => {
    applyCoalescedResult(freshState(), errored("500 Internal Server Error"), options)
    expect(breaker.shouldAttempt(key, NOW).allowed).toBe(false)
  })

  it("gives an account quota a much longer block than a throttle", () => {
    const quotaBreaker = new SubscriptionBreaker()
    applyCoalescedResult(freshState(), errored("429: usage_limit_reached"), {
      ...options,
      breaker: quotaBreaker,
    })
    applyCoalescedResult(freshState(), errored("429: 5 requests per minute"), options)
    expect(quotaBreaker.peek(key).blockedUntil).toBeGreaterThan(breaker.peek(key).blockedUntil)
  })

  it("clears the block when a reading succeeds", () => {
    const state = freshState()
    applyCoalescedResult(state, errored("429: 5 requests per minute"), options)
    expect(breaker.shouldAttempt(key, NOW).allowed).toBe(false)
    applyCoalescedResult(state, ok(), options)
    expect(breaker.shouldAttempt(key, NOW).allowed).toBe(true)
  })

  it("treats a null result as neither success nor failure", () => {
    const state = freshState()
    expect(applyCoalescedResult(state, null, options)).toBeNull()
    expect(breaker.shouldAttempt(key, NOW).allowed).toBe(true)
    expect(state.lastResult).toBeNull()
  })
})

describe("recordCoalescedThrow", () => {
  it("classifies and blocks on a rejected query", () => {
    const failure = recordCoalescedThrow(new Error("429: usage_limit_reached"), options)
    expect(failure.reason).toBe("account-quota")
    expect(breaker.shouldAttempt(key, NOW).allowed).toBe(false)
  })

  it("handles a bare string rejection from the Tauri transport", () => {
    expect(recordCoalescedThrow("503: Service Unavailable", options).reason).toBe("capacity")
  })
})

describe("limitsBreakerKey", () => {
  it("is the usage-scope key, so one block gates every quota surface", () => {
    expect(limitsBreakerKey("anthropic", "acc-1")).toBe(limitsBreakerKey("anthropic", "acc-1"))
    expect(limitsBreakerKey("anthropic", "acc-1")).not.toBe(limitsBreakerKey("codex", "acc-1"))
  })
})

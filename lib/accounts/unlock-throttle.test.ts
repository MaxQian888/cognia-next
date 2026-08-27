/** @jest-environment jsdom */
import {
  BASE_COOLDOWN_MS,
  clearUnlockFailures,
  FREE_ATTEMPTS,
  MAX_COOLDOWN_MS,
  nextThrottleState,
  readUnlockThrottle,
  recordFailedUnlock,
  RESET_AFTER_MS,
  throttleStatusOf,
  type UnlockThrottleState,
} from "./unlock-throttle"

const EMPTY: UnlockThrottleState = { failures: 0, lastFailureAt: 0, cooldownUntil: 0 }
const T0 = 1_700_000_000_000

beforeEach(() => {
  window.localStorage.clear()
})

describe("nextThrottleState", () => {
  it("counts failures without a cooldown until the free attempts run out", () => {
    let state = EMPTY
    for (let attempt = 1; attempt < FREE_ATTEMPTS; attempt += 1) {
      state = nextThrottleState(state, T0)
      expect(state.failures).toBe(attempt)
      expect(state.cooldownUntil).toBe(0)
    }
  })

  it("starts the base cooldown on the attempt that exhausts the allowance", () => {
    let state = EMPTY
    for (let attempt = 0; attempt < FREE_ATTEMPTS; attempt += 1) {
      state = nextThrottleState(state, T0)
    }
    expect(state.failures).toBe(FREE_ATTEMPTS)
    expect(state.cooldownUntil).toBe(T0 + BASE_COOLDOWN_MS)
  })

  it("doubles the cooldown on each further failure", () => {
    let state = EMPTY
    for (let attempt = 0; attempt < FREE_ATTEMPTS + 2; attempt += 1) {
      state = nextThrottleState(state, T0)
    }
    expect(state.cooldownUntil).toBe(T0 + BASE_COOLDOWN_MS * 4)
  })

  it("caps the cooldown", () => {
    let state = EMPTY
    for (let attempt = 0; attempt < FREE_ATTEMPTS + 20; attempt += 1) {
      state = nextThrottleState(state, T0)
    }
    expect(state.cooldownUntil).toBe(T0 + MAX_COOLDOWN_MS)
  })

  it("forgives the count after a long quiet period", () => {
    const stale: UnlockThrottleState = {
      failures: 9,
      lastFailureAt: T0,
      cooldownUntil: T0 + MAX_COOLDOWN_MS,
    }
    const next = nextThrottleState(stale, T0 + RESET_AFTER_MS + 1)
    expect(next.failures).toBe(1)
    expect(next.cooldownUntil).toBe(0)
  })
})

describe("throttleStatusOf", () => {
  it("reports the remaining allowance", () => {
    const status = throttleStatusOf({ failures: 2, lastFailureAt: T0, cooldownUntil: 0 }, T0)
    expect(status.remainingAttempts).toBe(FREE_ATTEMPTS - 2)
    expect(status.blocked).toBe(false)
  })

  it("reports a live cooldown", () => {
    const status = throttleStatusOf(
      { failures: 5, lastFailureAt: T0, cooldownUntil: T0 + 30_000 },
      T0 + 10_000
    )
    expect(status.blocked).toBe(true)
    expect(status.cooldownMsRemaining).toBe(20_000)
  })

  it("clears a cooldown that has already elapsed but keeps the escalation", () => {
    const status = throttleStatusOf(
      { failures: 5, lastFailureAt: T0, cooldownUntil: T0 + 30_000 },
      T0 + 31_000
    )
    expect(status.blocked).toBe(false)
    expect(status.cooldownUntil).toBe(0)
    expect(status.failures).toBe(5)
  })

  it("treats a state older than the quiet period as clean", () => {
    const status = throttleStatusOf(
      { failures: 9, lastFailureAt: T0, cooldownUntil: T0 + MAX_COOLDOWN_MS },
      T0 + RESET_AFTER_MS + 1
    )
    expect(status.failures).toBe(0)
    expect(status.blocked).toBe(false)
    expect(status.remainingAttempts).toBe(FREE_ATTEMPTS)
  })
})

describe("storage-backed throttle", () => {
  it("persists failures across reads and scopes them per account", () => {
    recordFailedUnlock("acct_alpha", T0)
    recordFailedUnlock("acct_alpha", T0)
    expect(readUnlockThrottle("acct_alpha", T0).failures).toBe(2)
    expect(readUnlockThrottle("acct_beta", T0).failures).toBe(0)
  })

  it("clears on a successful unlock", () => {
    recordFailedUnlock("acct_alpha", T0)
    clearUnlockFailures("acct_alpha")
    expect(readUnlockThrottle("acct_alpha", T0).failures).toBe(0)
  })

  it("blocks after the allowance and reports the wait", () => {
    let status = readUnlockThrottle("acct_alpha", T0)
    for (let attempt = 0; attempt < FREE_ATTEMPTS; attempt += 1) {
      status = recordFailedUnlock("acct_alpha", T0)
    }
    expect(status.blocked).toBe(true)
    expect(status.cooldownMsRemaining).toBe(BASE_COOLDOWN_MS)
    expect(status.remainingAttempts).toBe(0)
  })

  it("survives a corrupted entry", () => {
    window.localStorage.setItem("cognia-account-unlock-throttle:acct_alpha", "{not json")
    expect(readUnlockThrottle("acct_alpha", T0).failures).toBe(0)
    expect(recordFailedUnlock("acct_alpha", T0).failures).toBe(1)
  })

  it("survives an entry with the wrong shape", () => {
    window.localStorage.setItem(
      "cognia-account-unlock-throttle:acct_alpha",
      JSON.stringify({ failures: "many" })
    )
    expect(readUnlockThrottle("acct_alpha", T0).failures).toBe(0)
  })
})

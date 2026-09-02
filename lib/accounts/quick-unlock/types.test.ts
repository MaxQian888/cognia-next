import {
  attemptsRemaining,
  isEnrollmentUsable,
  MAX_QUICK_UNLOCK_ATTEMPTS,
  withFailedAttempt,
  withLockoutCleared,
  withSuccessfulAttempt,
  type QuickUnlockEnrollment,
} from "./types"

function enrollment(patch: Partial<QuickUnlockEnrollment> = {}): QuickUnlockEnrollment {
  return {
    method: "pin",
    verifier: { algorithm: "argon2id-v1" },
    createdAt: 0,
    failedAttempts: 0,
    ...patch,
  }
}

describe("isEnrollmentUsable", () => {
  it("is usable while attempts remain", () => {
    expect(isEnrollmentUsable(enrollment())).toBe(true)
    expect(isEnrollmentUsable(enrollment({ failedAttempts: 1 }))).toBe(true)
  })

  it("is unusable once locked out", () => {
    expect(isEnrollmentUsable(enrollment({ lockedOutAt: 1 }))).toBe(false)
  })

  it("is unusable at the cap even without the timestamp", () => {
    // Belt and braces: a record written by an older build, or hand-edited,
    // must not become an unlimited guessing oracle.
    expect(isEnrollmentUsable(enrollment({ failedAttempts: MAX_QUICK_UNLOCK_ATTEMPTS }))).toBe(
      false
    )
  })
})

describe("attemptsRemaining", () => {
  it("counts down from the cap", () => {
    expect(attemptsRemaining(enrollment())).toBe(MAX_QUICK_UNLOCK_ATTEMPTS)
    expect(attemptsRemaining(enrollment({ failedAttempts: 2 }))).toBe(MAX_QUICK_UNLOCK_ATTEMPTS - 2)
  })

  it("never goes negative", () => {
    expect(attemptsRemaining(enrollment({ failedAttempts: 99 }))).toBe(0)
  })

  it("reports zero once locked out", () => {
    expect(attemptsRemaining(enrollment({ failedAttempts: 0, lockedOutAt: 5 }))).toBe(0)
  })
})

describe("withFailedAttempt", () => {
  it("increments without locking out early", () => {
    const next = withFailedAttempt(enrollment(), 100)
    expect(next.failedAttempts).toBe(1)
    expect(next.lockedOutAt).toBeUndefined()
  })

  it("locks out exactly at the cap", () => {
    let current = enrollment()
    for (let i = 0; i < MAX_QUICK_UNLOCK_ATTEMPTS - 1; i += 1) {
      current = withFailedAttempt(current, 100 + i)
      expect(current.lockedOutAt).toBeUndefined()
    }
    current = withFailedAttempt(current, 200)
    expect(current.failedAttempts).toBe(MAX_QUICK_UNLOCK_ATTEMPTS)
    expect(current.lockedOutAt).toBe(200)
    expect(isEnrollmentUsable(current)).toBe(false)
  })

  it("keeps the FIRST lockout timestamp on a later attempt", () => {
    const locked = enrollment({ failedAttempts: MAX_QUICK_UNLOCK_ATTEMPTS, lockedOutAt: 500 })
    expect(withFailedAttempt(locked, 900).lockedOutAt).toBe(500)
  })

  it("does not mutate the input", () => {
    const original = enrollment()
    withFailedAttempt(original, 100)
    expect(original.failedAttempts).toBe(0)
  })
})

describe("withSuccessfulAttempt", () => {
  it("clears the failure count and stamps the use", () => {
    const next = withSuccessfulAttempt(enrollment({ failedAttempts: 3 }), 700)
    expect(next.failedAttempts).toBe(0)
    expect(next.lastUsedAt).toBe(700)
    expect(next.lockedOutAt).toBeUndefined()
  })
})

describe("withLockoutCleared", () => {
  it("re-enables a locked-out method", () => {
    const locked = enrollment({ failedAttempts: MAX_QUICK_UNLOCK_ATTEMPTS, lockedOutAt: 500 })
    const cleared = withLockoutCleared(locked)
    expect(isEnrollmentUsable(cleared)).toBe(true)
    expect(cleared.failedAttempts).toBe(0)
  })

  it("keeps the enrollment rather than discarding it", () => {
    // The record survives lockout so the lock screen can say the PIN was
    // disabled, instead of silently losing a method the user configured.
    const locked = enrollment({ method: "pattern", lockedOutAt: 1, verifier: { a: 1 } })
    expect(withLockoutCleared(locked).method).toBe("pattern")
    expect(withLockoutCleared(locked).verifier).toEqual({ a: 1 })
  })
})

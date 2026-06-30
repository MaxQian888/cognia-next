import {
  RateLimitResumeController,
  createRealResumeDeps,
  type ResumeDelivery,
} from "@/lib/ai/agent/team/rate-limit-resume"

/** Manual scheduler: collects timers so the test fires them deterministically. */
function makeScheduler() {
  const queue: Array<{ fn: () => void; at: number; cancelled: boolean }> = []
  let clock = 0
  return {
    deps: {
      now: () => clock,
      setTimer: (fn: () => void, ms: number) => {
        const t = { fn, at: clock + ms, cancelled: false }
        queue.push(t)
        return t
      },
      clearTimer: (h: { cancelled: boolean }) => {
        h.cancelled = true
      },
    },
    advanceTo(ms: number) {
      clock = ms
      for (const t of queue) {
        if (!t.cancelled && t.at <= clock) {
          t.cancelled = true
          t.fn()
        }
      }
    },
    setClock(ms: number) {
      clock = ms
    },
    pending: () => queue.filter((t) => !t.cancelled).length,
  }
}

describe("RateLimitResumeController", () => {
  it("delivers a resume once the cooldown elapses", () => {
    const sched = makeScheduler()
    const delivered: ResumeDelivery[] = []
    const c = new RateLimitResumeController({ ...sched.deps, deliver: (d) => delivered.push(d) })
    c.onRateLimit({ memberId: "m1", fingerprint: "fp", retryAfterMs: 30_000 })
    expect(delivered).toHaveLength(0)
    sched.advanceTo(30_000)
    expect(delivered).toEqual([{ memberId: "m1", fingerprint: "fp", generation: 1 }])
    expect(c.deliveredCount("m1")).toBe(1)
  })

  it("suppresses a duplicate resume for the same agenda fingerprint", () => {
    const sched = makeScheduler()
    const delivered: ResumeDelivery[] = []
    const c = new RateLimitResumeController({ ...sched.deps, deliver: (d) => delivered.push(d) })
    c.onRateLimit({ memberId: "m1", fingerprint: "fp", retryAfterMs: 10_000 })
    sched.advanceTo(10_000)
    // Same fingerprint again → scheduled but suppressed at fire time.
    c.onRateLimit({ memberId: "m1", fingerprint: "fp", retryAfterMs: 10_000 })
    sched.advanceTo(60_000)
    expect(delivered).toHaveLength(1)
  })

  it("suppresses a second resume while the first's backoff cooldown is active", () => {
    const sched = makeScheduler()
    const delivered: ResumeDelivery[] = []
    const c = new RateLimitResumeController({ ...sched.deps, deliver: (d) => delivered.push(d) })
    c.onRateLimit({ memberId: "m1", fingerprint: "a", retryAfterMs: 1_000 })
    sched.advanceTo(1_000) // delivers #1; sets a ~10min backoff cooldown
    // A different agenda hits a limit moments later — still inside the cooldown.
    c.onRateLimit({ memberId: "m1", fingerprint: "b", retryAfterMs: 1_000 })
    sched.advanceTo(2_000)
    expect(delivered).toHaveLength(1)
  })

  it("allows a second resume once the backoff cooldown has elapsed", () => {
    const sched = makeScheduler()
    const delivered: ResumeDelivery[] = []
    const c = new RateLimitResumeController({ ...sched.deps, deliver: (d) => delivered.push(d) })
    c.onRateLimit({ memberId: "m1", fingerprint: "a", retryAfterMs: 1_000 })
    sched.advanceTo(1_000)
    // 11 minutes later (> the 10-min gen-1 backoff), a fresh agenda resumes.
    c.onRateLimit({ memberId: "m1", fingerprint: "b", retryAfterMs: 1_000 })
    sched.advanceTo(11 * 60_000)
    expect(delivered).toHaveLength(2)
  })

  it("skips a resume when the member is NOT busy gate (resume bypasses busy)", () => {
    const sched = makeScheduler()
    const delivered: ResumeDelivery[] = []
    const c = new RateLimitResumeController({
      ...sched.deps,
      deliver: (d) => delivered.push(d),
      busyWindowMs: 60_000,
    })
    // Even with very recent activity, a rate_limit_resume is allowed.
    c.onRateLimit({
      memberId: "m1",
      fingerprint: "fp",
      retryAfterMs: 5_000,
      lastToolActivityAt: 4_000,
    })
    sched.advanceTo(5_000)
    expect(delivered).toHaveLength(1)
  })

  it("dispose() cancels pending timers so nothing fires after the run ends", () => {
    const sched = makeScheduler()
    const delivered: ResumeDelivery[] = []
    const c = new RateLimitResumeController({ ...sched.deps, deliver: (d) => delivered.push(d) })
    c.onRateLimit({ memberId: "m1", fingerprint: "fp", retryAfterMs: 30_000 })
    c.dispose()
    sched.advanceTo(30_000)
    expect(delivered).toHaveLength(0)
    expect(sched.pending()).toBe(0)
  })

  it("is a no-op after dispose", () => {
    const sched = makeScheduler()
    const delivered: ResumeDelivery[] = []
    const c = new RateLimitResumeController({ ...sched.deps, deliver: (d) => delivered.push(d) })
    c.dispose()
    c.onRateLimit({ memberId: "m1", fingerprint: "fp", retryAfterMs: 1_000 })
    sched.advanceTo(1_000)
    expect(delivered).toHaveLength(0)
  })

  it("caps an absurd Retry-After at one hour", () => {
    const sched = makeScheduler()
    const delivered: ResumeDelivery[] = []
    const c = new RateLimitResumeController({ ...sched.deps, deliver: (d) => delivered.push(d) })
    c.onRateLimit({ memberId: "m1", fingerprint: "fp", retryAfterMs: 999_999_999 })
    sched.advanceTo(60 * 60_000)
    expect(delivered).toHaveLength(1)
  })
})

describe("createRealResumeDeps", () => {
  it("wires real timers and fires after the delay", () => {
    jest.useFakeTimers()
    try {
      const delivered: ResumeDelivery[] = []
      const deps = createRealResumeDeps((d) => delivered.push(d), { maxPerHour: 5 })
      const c = new RateLimitResumeController(deps)
      c.onRateLimit({ memberId: "m1", fingerprint: "fp", retryAfterMs: 1_000 })
      jest.advanceTimersByTime(1_000)
      expect(delivered).toHaveLength(1)
    } finally {
      jest.useRealTimers()
    }
  })

  it("clearTimer prevents a real timer from firing", () => {
    jest.useFakeTimers()
    try {
      const delivered: ResumeDelivery[] = []
      const deps = createRealResumeDeps((d) => delivered.push(d))
      const c = new RateLimitResumeController(deps)
      c.onRateLimit({ memberId: "m1", fingerprint: "fp", retryAfterMs: 1_000 })
      c.dispose()
      jest.advanceTimersByTime(1_000)
      expect(delivered).toHaveLength(0)
    } finally {
      jest.useRealTimers()
    }
  })
})

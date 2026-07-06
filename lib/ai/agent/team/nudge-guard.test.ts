import {
  agendaFingerprint,
  canNudge,
  computeNextRetryAt,
  parseRateLimitCooldown,
  stableJitterMs,
  type NudgeRecord,
} from "@/lib/ai/agent/team/nudge-guard"

describe("computeNextRetryAt", () => {
  it("doubles the backoff per generation and caps at 60 minutes", () => {
    const now = 0
    const seed = "x"
    const noJitter = (gen: number) => computeNextRetryAt(gen, now, seed) - stableJitterMs(seed, gen)
    expect(noJitter(1)).toBe(10 * 60_000)
    expect(noJitter(2)).toBe(20 * 60_000)
    expect(noJitter(3)).toBe(40 * 60_000)
    expect(noJitter(4)).toBe(60 * 60_000) // 80 capped to 60
    expect(noJitter(9)).toBe(60 * 60_000)
  })

  it("adds a stable, bounded jitter", () => {
    const a = computeNextRetryAt(1, 0, "seed")
    const b = computeNextRetryAt(1, 0, "seed")
    expect(a).toBe(b) // deterministic
    expect(a - 10 * 60_000).toBeGreaterThanOrEqual(0)
    expect(a - 10 * 60_000).toBeLessThanOrEqual(5_000)
  })
})

describe("agendaFingerprint", () => {
  it("is order-independent and changes with status", () => {
    const a = agendaFingerprint([
      { id: "t1", status: "in_progress" },
      { id: "t2", status: "pending" },
    ])
    const b = agendaFingerprint([
      { id: "t2", status: "pending" },
      { id: "t1", status: "in_progress" },
    ])
    expect(a).toBe(b)
    const c = agendaFingerprint([
      { id: "t1", status: "completed" },
      { id: "t2", status: "pending" },
    ])
    expect(c).not.toBe(a)
  })
})

describe("canNudge", () => {
  const base = {
    memberId: "m1",
    type: "rate_limit_resume" as const,
    fingerprint: "fp1",
    now: 1_000_000,
  }

  it("allows a fresh nudge", () => {
    expect(canNudge({ ...base, history: [] }).allow).toBe(true)
  })

  it("defers while a cooldown is outstanding", () => {
    const history: NudgeRecord[] = [
      {
        memberId: "m1",
        type: "rate_limit_resume",
        fingerprint: "old",
        generation: 1,
        sentAt: base.now - 1000,
        nextRetryAt: base.now + 5000,
      },
    ]
    const d = canNudge({ ...base, history })
    expect(d).toMatchObject({ allow: false, reason: "cooldown", nextRetryAt: base.now + 5000 })
  })

  it("suppresses a duplicate fingerprint", () => {
    const history: NudgeRecord[] = [
      {
        memberId: "m1",
        type: "agenda_sync",
        fingerprint: "fp1",
        generation: 1,
        sentAt: base.now - 10_000,
        nextRetryAt: base.now - 1,
      },
    ]
    expect(canNudge({ ...base, history }).reason).toBe("duplicate")
  })

  it("skips when the member is busy (for non-resume nudges)", () => {
    const d = canNudge({
      ...base,
      type: "agenda_sync",
      history: [],
      lastToolActivityAt: base.now - 5_000,
      busyWindowMs: 60_000,
    })
    expect(d).toMatchObject({ allow: false, reason: "busy" })
  })

  it("lets a rate_limit_resume bypass the busy signal", () => {
    const d = canNudge({
      ...base,
      history: [],
      lastToolActivityAt: base.now - 5_000,
      busyWindowMs: 60_000,
    })
    expect(d.allow).toBe(true)
  })

  it("enforces the hourly cap", () => {
    const history: NudgeRecord[] = [
      {
        memberId: "m1",
        type: "rate_limit_resume",
        fingerprint: "a",
        generation: 1,
        sentAt: base.now - 1000,
        nextRetryAt: base.now - 1,
      },
      {
        memberId: "m1",
        type: "rate_limit_resume",
        fingerprint: "b",
        generation: 1,
        sentAt: base.now - 2000,
        nextRetryAt: base.now - 1,
      },
    ]
    const d = canNudge({ ...base, fingerprint: "c", history, maxPerHour: 2 })
    expect(d).toMatchObject({ allow: false, reason: "rate_limited" })
  })

  it("ignores another member's history", () => {
    const history: NudgeRecord[] = [
      {
        memberId: "other",
        type: "rate_limit_resume",
        fingerprint: "fp1",
        generation: 1,
        sentAt: base.now,
        nextRetryAt: base.now + 99_999,
      },
    ]
    expect(canNudge({ ...base, history }).allow).toBe(true)
  })
})

describe("parseRateLimitCooldown", () => {
  it("returns the cooldown for a rate-limit error with a retry hint", () => {
    expect(parseRateLimitCooldown("429 rate limit exceeded, retry after 30s")).toEqual({
      retryAfterMs: 30_000,
    })
  })

  it("prefers structured meta Retry-After", () => {
    expect(parseRateLimitCooldown("rate limit", { httpStatus: 429, retryAfterMs: 12_000 })).toEqual(
      {
        retryAfterMs: 12_000,
      }
    )
  })

  it("returns null for non-rate-limit errors", () => {
    expect(parseRateLimitCooldown("connection refused")).toBeNull()
  })

  it("returns null when no cooldown can be derived", () => {
    expect(parseRateLimitCooldown("429 too many requests")).toBeNull()
  })
})

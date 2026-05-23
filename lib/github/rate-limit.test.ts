import { fetchRateLimit, formatReset, percentRemaining } from "./rate-limit"

function fakeOctokit(data: unknown) {
  return { request: jest.fn(async () => ({ data })) } as unknown as import("@octokit/core").Octokit
}

describe("fetchRateLimit", () => {
  it("maps the /rate_limit response and includes capturedAt", async () => {
    const octokit = fakeOctokit({
      resources: {
        core: { limit: 5000, used: 1234, remaining: 3766, reset: 1_700_000_000 },
        search: { limit: 30, used: 5, remaining: 25, reset: 1_700_000_010 },
        graphql: { limit: 5000, used: 0, remaining: 5000, reset: 1_700_000_020 },
      },
    })
    const now = () => 1_700_000_000_000
    const snap = await fetchRateLimit(octokit, "octocat/hello", now)
    expect(snap.capturedAt).toBe(1_700_000_000_000)
    expect(snap.repoFullName).toBe("octocat/hello")
    expect(snap.core.remaining).toBe(3766)
    expect(snap.search.remaining).toBe(25)
    expect(snap.graphql.remaining).toBe(5000)
  })

  it("defaults missing buckets to ZERO", async () => {
    const octokit = fakeOctokit({ resources: {} })
    const snap = await fetchRateLimit(octokit, "o/r")
    expect(snap.core).toEqual({ limit: 0, used: 0, remaining: 0, reset: 0 })
    expect(snap.search.limit).toBe(0)
    expect(snap.graphql.limit).toBe(0)
  })

  it("handles a totally missing resources block", async () => {
    const octokit = fakeOctokit({})
    const snap = await fetchRateLimit(octokit, "o/r")
    expect(snap.core.limit).toBe(0)
  })
})

describe("percentRemaining", () => {
  it("returns a 0..100 integer", () => {
    expect(percentRemaining({ limit: 100, used: 25, remaining: 75, reset: 0 })).toBe(75)
    expect(percentRemaining({ limit: 200, used: 1, remaining: 199, reset: 0 })).toBe(100)
    expect(percentRemaining({ limit: 0, used: 0, remaining: 0, reset: 0 })).toBe(0)
  })

  it("clamps overflows", () => {
    // Bug-safe: should never exceed 100 even with weird inputs.
    expect(percentRemaining({ limit: 100, used: 0, remaining: 5000, reset: 0 })).toBe(100)
  })
})

describe("formatReset", () => {
  const nowMs = 1_700_000_000_000
  const nowSec = 1_700_000_000

  it("returns '—' when reset is 0", () => {
    expect(formatReset({ limit: 0, used: 0, remaining: 0, reset: 0 }, nowMs)).toBe("—")
  })

  it("returns 'now' for past resets", () => {
    expect(formatReset({ limit: 1, used: 0, remaining: 1, reset: nowSec - 5 }, nowMs)).toBe("now")
  })

  it("formats sub-minute as seconds", () => {
    expect(formatReset({ limit: 1, used: 0, remaining: 1, reset: nowSec + 30 }, nowMs)).toBe(
      "in 30s"
    )
  })

  it("formats sub-hour as minutes", () => {
    expect(formatReset({ limit: 1, used: 0, remaining: 1, reset: nowSec + 600 }, nowMs)).toBe(
      "in 10m"
    )
  })

  it("formats > 1h as hours", () => {
    expect(formatReset({ limit: 1, used: 0, remaining: 1, reset: nowSec + 7200 }, nowMs)).toBe(
      "in 2h"
    )
  })
})

// Real header dump from anthropics/claude-code#12829, verbatim from a 200
// response on `POST /v1/messages` while a Pro account had ~74% used in the
// 7-day window and ~2% in the 5-hour window.

import { hasUsageHeaders, parseUsageHeaders } from "./parser"

const REAL_HEADERS: Record<string, string> = {
  "anthropic-ratelimit-unified-status": "allowed",
  "anthropic-ratelimit-unified-5h-status": "allowed",
  "anthropic-ratelimit-unified-5h-reset": "1764554400",
  "anthropic-ratelimit-unified-5h-utilization": "0.0184",
  "anthropic-ratelimit-unified-7d-status": "allowed",
  "anthropic-ratelimit-unified-7d-reset": "1764615600",
  "anthropic-ratelimit-unified-7d-utilization": "0.7370",
  "anthropic-ratelimit-unified-representative-claim": "five_hour",
  "anthropic-ratelimit-unified-fallback-percentage": "0.2",
  "anthropic-ratelimit-unified-reset": "1764554400",
  "anthropic-ratelimit-unified-overage-disabled-reason": "org_level_disabled",
  "content-type": "application/json",
  "x-trace-id": "abc123",
}

describe("parseUsageHeaders", () => {
  it("converts the real header dump from issue #12829", () => {
    const snap = parseUsageHeaders(REAL_HEADERS, "passive", 1700000000)
    expect(snap.fetchedAt).toBe(1700000000)
    expect(snap.source).toBe("passive")
    expect(snap.status).toBe("allowed")
    expect(snap.representativeClaim).toBe("five_hour")
    expect(snap.fiveHour).toEqual({
      utilization: 0.0184,
      resetAt: 1764554400 * 1000,
      status: "allowed",
    })
    expect(snap.sevenDay).toEqual({
      utilization: 0.737,
      resetAt: 1764615600 * 1000,
      status: "allowed",
    })
    expect(snap.fallbackPercentage).toBe(0.2)
    expect(snap.overageDisabledReason).toBe("org_level_disabled")
  })

  it("includes only anthropic-ratelimit-* headers in the raw dump", () => {
    const snap = parseUsageHeaders(REAL_HEADERS)
    expect(snap.rawHeaders).toHaveProperty("anthropic-ratelimit-unified-status")
    expect(snap.rawHeaders).toHaveProperty("anthropic-ratelimit-unified-5h-utilization")
    expect(snap.rawHeaders).not.toHaveProperty("content-type")
    expect(snap.rawHeaders).not.toHaveProperty("x-trace-id")
  })

  it("works with a real Headers instance and is case-insensitive", () => {
    const h = new Headers()
    h.set("Anthropic-RateLimit-Unified-Status", "allowed")
    h.set("anthropic-ratelimit-unified-5h-utilization", "0.5")
    h.set("anthropic-ratelimit-unified-5h-reset", "1700000000")
    const snap = parseUsageHeaders(h)
    expect(snap.status).toBe("allowed")
    expect(snap.fiveHour?.utilization).toBe(0.5)
    expect(snap.fiveHour?.resetAt).toBe(1700000000 * 1000)
  })

  it("returns null windows when utilization or reset is missing", () => {
    const snap = parseUsageHeaders({
      "anthropic-ratelimit-unified-status": "allowed",
      "anthropic-ratelimit-unified-7d-utilization": "0.1",
      "anthropic-ratelimit-unified-7d-reset": "1700000000",
    })
    expect(snap.fiveHour).toBeNull()
    expect(snap.sevenDay).not.toBeNull()
  })

  it("classifies status correctly", () => {
    expect(parseUsageHeaders({ "anthropic-ratelimit-unified-status": "rate_limited" }).status).toBe(
      "rate_limited"
    )
    expect(
      parseUsageHeaders({ "anthropic-ratelimit-unified-status": "allowed_warning" }).status
    ).toBe("allowed_warning")
    expect(parseUsageHeaders({ "anthropic-ratelimit-unified-status": "garbage" }).status).toBe(
      "unknown"
    )
    expect(parseUsageHeaders({}).status).toBe("unknown")
  })

  it("treats unrecognised representative-claim values as null", () => {
    const snap = parseUsageHeaders({
      "anthropic-ratelimit-unified-status": "allowed",
      "anthropic-ratelimit-unified-representative-claim": "ten_minute",
    })
    expect(snap.representativeClaim).toBeNull()
  })

  it("rejects non-numeric utilization without throwing", () => {
    const snap = parseUsageHeaders({
      "anthropic-ratelimit-unified-status": "allowed",
      "anthropic-ratelimit-unified-5h-utilization": "not-a-number",
      "anthropic-ratelimit-unified-5h-reset": "1700000000",
    })
    expect(snap.fiveHour).toBeNull()
  })

  it("defaults source to passive and fetchedAt to now", () => {
    const before = Date.now()
    const snap = parseUsageHeaders(REAL_HEADERS)
    const after = Date.now()
    expect(snap.source).toBe("passive")
    expect(snap.fetchedAt).toBeGreaterThanOrEqual(before)
    expect(snap.fetchedAt).toBeLessThanOrEqual(after)
  })
})

describe("hasUsageHeaders", () => {
  it("returns true when the unified-status header is present", () => {
    expect(hasUsageHeaders(REAL_HEADERS)).toBe(true)
  })

  it("returns false when the unified-status header is missing", () => {
    expect(hasUsageHeaders({ "content-type": "application/json" })).toBe(false)
  })

  it("works with a Headers instance", () => {
    const h = new Headers()
    expect(hasUsageHeaders(h)).toBe(false)
    h.set("anthropic-ratelimit-unified-status", "allowed")
    expect(hasUsageHeaders(h)).toBe(true)
  })
})

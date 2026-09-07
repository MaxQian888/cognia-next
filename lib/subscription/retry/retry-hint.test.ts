import {
  MAX_RETRY_HINT_MS,
  extractRetryHintMs,
  retryHintFromBody,
  retryHintFromHeaders,
} from "./retry-hint"

const NOW = Date.parse("2026-09-01T00:00:00.000Z")

describe("retryHintFromHeaders", () => {
  it("prefers an explicit millisecond delta", () => {
    expect(retryHintFromHeaders([{ name: "retry-after-ms", value: "1500" }], NOW)).toBe(1500)
  })

  it("reads Retry-After as delta seconds", () => {
    expect(retryHintFromHeaders({ "Retry-After": "120" }, NOW)).toBe(120_000)
  })

  it("reads Retry-After as an HTTP date", () => {
    const headers = { "retry-after": new Date(NOW + 90_000).toUTCString() }
    expect(retryHintFromHeaders(headers, NOW)).toBe(90_000)
  })

  it("is case-insensitive across every header bag shape", () => {
    const expected = 30_000
    expect(retryHintFromHeaders([{ name: "Retry-After", value: "30" }], NOW)).toBe(expected)
    expect(retryHintFromHeaders({ "RETRY-AFTER": "30" }, NOW)).toBe(expected)
    expect(retryHintFromHeaders(new Headers({ "retry-after": "30" }), NOW)).toBe(expected)
  })

  it("differences x-ratelimit-reset against the clock", () => {
    const resetSeconds = String(Math.floor((NOW + 45_000) / 1000))
    expect(retryHintFromHeaders({ "x-ratelimit-reset": resetSeconds }, NOW)).toBe(45_000)
  })

  it("treats a small x-ratelimit-reset-ms as a delta, a large one as epoch ms", () => {
    expect(retryHintFromHeaders({ "x-ratelimit-reset-ms": "2500" }, NOW)).toBe(2500)
    expect(retryHintFromHeaders({ "x-ratelimit-reset-ms": String(NOW + 60_000) }, NOW)).toBe(60_000)
  })

  it("reads x-ratelimit-reset-after as seconds", () => {
    expect(retryHintFromHeaders({ "x-ratelimit-reset-after": "12" }, NOW)).toBe(12_000)
  })

  it("reads the Anthropic unified reset stamp", () => {
    const headers = { "anthropic-ratelimit-unified-reset": new Date(NOW + 3_600_000).toISOString() }
    expect(retryHintFromHeaders(headers, NOW)).toBe(3_600_000)
  })

  it("keeps an explicit zero as retry-now rather than losing it", () => {
    expect(retryHintFromHeaders({ "retry-after": "0" }, NOW)).toBe(0)
    expect(retryHintFromHeaders({ "retry-after-ms": "0" }, NOW)).toBe(0)
  })

  it("returns undefined when nothing timing-shaped is present", () => {
    expect(retryHintFromHeaders({ "content-type": "application/json" }, NOW)).toBeUndefined()
    expect(retryHintFromHeaders(undefined, NOW)).toBeUndefined()
  })

  it("clamps a hostile value to the 24h ceiling", () => {
    expect(retryHintFromHeaders({ "retry-after": "999999999" }, NOW)).toBe(MAX_RETRY_HINT_MS)
  })
})

describe("retryHintFromBody", () => {
  it("parses the compound quota reset window", () => {
    const ms = retryHintFromBody("Your quota will reset after 1h2m3s", NOW)
    expect(ms).toBe(((1 * 60 + 2) * 60 + 3) * 1000)
  })

  it("parses a seconds-only quota reset window", () => {
    expect(retryHintFromBody("quota will reset after 39s", NOW)).toBe(39_000)
  })

  it("parses an absolute reset stamp without an offset as UTC", () => {
    const body = "Your limit will reset at 2026-09-01 00:30:00"
    expect(retryHintFromBody(body, NOW)).toBe(30 * 60_000)
  })

  it("parses the Simplified Chinese reset stamp", () => {
    const body = "429 已达到 5 小时的使用上限。您的限额将在 2026-09-01 02:00:00 重置。"
    expect(retryHintFromBody(body, NOW)).toBe(2 * 60 * 60_000)
  })

  it("parses the relative reset phrase with each unit", () => {
    expect(retryHintFromBody("Your limit will reset in 13 minutes", NOW)).toBe(13 * 60_000)
    expect(retryHintFromBody("will reset in 2h", NOW)).toBe(2 * 60 * 60_000)
  })

  it("parses please-retry, retryDelay and try-again phrasings", () => {
    expect(retryHintFromBody("Please retry in 250ms", NOW)).toBe(250)
    expect(retryHintFromBody('{"retryDelay": "34.07s"}', NOW)).toBe(34_070)
    expect(retryHintFromBody("try again in ~158 min.", NOW)).toBe(158 * 60_000)
  })

  it("reads a retry-after-ms folded into the body text", () => {
    expect(retryHintFromBody("retry-after-ms=7200000", NOW)).toBe(7_200_000)
  })

  it("honors the LONGEST window when a body names several", () => {
    // A per-minute throttle inside a spent account window. Waiting only the
    // 30s walks straight back into the 2h block.
    const body = "Rate limited, please retry in 30s. Your limit will reset in 2 hours."
    expect(retryHintFromBody(body, NOW)).toBe(2 * 60 * 60_000)
  })

  it("ignores numbers that are not anchored to a retry phrase", () => {
    expect(retryHintFromBody("request id 429000 failed for model 12345", NOW)).toBeUndefined()
  })

  it("reports an elapsed absolute stamp as retry-now, not as no-hint", () => {
    expect(retryHintFromBody("Your limit will reset at 2026-08-31 23:00:00", NOW)).toBe(0)
  })

  it("returns undefined for an empty or absent body", () => {
    expect(retryHintFromBody(undefined, NOW)).toBeUndefined()
    expect(retryHintFromBody("", NOW)).toBeUndefined()
  })
})

describe("extractRetryHintMs", () => {
  it("takes the longer of the header and body signals", () => {
    const ms = extractRetryHintMs({
      headers: { "retry-after": "30" },
      body: "Your limit will reset in 2 hours",
      now: NOW,
    })
    expect(ms).toBe(2 * 60 * 60_000)
  })

  it("falls back to whichever side has a signal", () => {
    expect(extractRetryHintMs({ headers: { "retry-after": "30" }, now: NOW })).toBe(30_000)
    expect(extractRetryHintMs({ body: "Please retry in 5s", now: NOW })).toBe(5_000)
  })

  it("returns undefined when neither side says anything", () => {
    expect(extractRetryHintMs({ headers: {}, body: "boom", now: NOW })).toBeUndefined()
  })
})

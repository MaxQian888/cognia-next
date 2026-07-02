import {
  parseRateLimitHeaders,
  parseResetAt,
  rateLimitColor,
  rateLimitResetText,
  rateLimitRightLabel,
  rateLimitSeverity,
  rateLimitWarning,
  tightestRemainingPct,
} from "./rate-limits"

const NOW = 1_700_000_000_000

describe("parseRateLimitHeaders", () => {
  it("folds the four anthropic-ratelimit windows into meters", () => {
    const snap = parseRateLimitHeaders(
      {
        "anthropic-ratelimit-requests-limit": "100",
        "anthropic-ratelimit-requests-remaining": "75",
        "anthropic-ratelimit-requests-reset": "2023-11-14T22:13:20Z",
        "anthropic-ratelimit-tokens-limit": "1000",
        "anthropic-ratelimit-tokens-remaining": "100",
        "anthropic-ratelimit-tokens-reset": "2023-11-14T22:13:20Z",
        "anthropic-ratelimit-input-tokens-limit": "800",
        "anthropic-ratelimit-input-tokens-remaining": "800",
        "anthropic-ratelimit-output-tokens-limit": "200",
        "anthropic-ratelimit-output-tokens-remaining": "0",
      },
      NOW
    )
    expect(snap).not.toBeNull()
    expect(snap!.capturedAt).toBe(NOW)
    expect(snap!.meters.map((m) => m.kind)).toEqual([
      "requests",
      "tokens",
      "input-tokens",
      "output-tokens",
    ])
    expect(snap!.meters[0].usedPct).toBe(25) // 25/100 used
    expect(snap!.meters[1].usedPct).toBe(90) // 900/1000 used
    expect(snap!.meters[2].usedPct).toBe(0) // none used
    expect(snap!.meters[3].usedPct).toBe(100) // fully exhausted
    expect(snap!.meters[0].resetAt).toBe(Date.parse("2023-11-14T22:13:20Z"))
  })

  it("skips windows missing a limit or remaining figure", () => {
    const snap = parseRateLimitHeaders(
      {
        "anthropic-ratelimit-requests-limit": "100",
        // no remaining → dropped
        "anthropic-ratelimit-tokens-remaining": "50",
        // no limit → dropped
        "anthropic-ratelimit-input-tokens-limit": "10",
        "anthropic-ratelimit-input-tokens-remaining": "4",
      },
      NOW
    )
    expect(snap!.meters.map((m) => m.kind)).toEqual(["input-tokens"])
  })

  it("returns null when no quota window parses", () => {
    expect(parseRateLimitHeaders({}, NOW)).toBeNull()
    expect(parseRateLimitHeaders({ "x-other": "1" }, NOW)).toBeNull()
  })

  it("ignores non-numeric limit/remaining values", () => {
    expect(
      parseRateLimitHeaders(
        {
          "anthropic-ratelimit-requests-limit": "n/a",
          "anthropic-ratelimit-requests-remaining": "5",
        },
        NOW
      )
    ).toBeNull()
  })
})

describe("parseResetAt", () => {
  it("parses an RFC-3339 timestamp", () => {
    expect(parseResetAt("2023-11-14T22:13:20Z", NOW)).toBe(Date.parse("2023-11-14T22:13:20Z"))
  })
  it("treats a bare number as seconds-from-now", () => {
    expect(parseResetAt("30", NOW)).toBe(NOW + 30_000)
  })
  it("returns null for missing or garbage values", () => {
    expect(parseResetAt(undefined, NOW)).toBeNull()
    expect(parseResetAt("not-a-date", NOW)).toBeNull()
  })
})

describe("rateLimitSeverity", () => {
  it("maps consumed share to severity bands", () => {
    expect(rateLimitSeverity(0)).toBe("ok")
    expect(rateLimitSeverity(74)).toBe("ok")
    expect(rateLimitSeverity(75)).toBe("warn")
    expect(rateLimitSeverity(90)).toBe("crit")
    expect(rateLimitSeverity(100)).toBe("exceeded")
  })
})

describe("rateLimitColor", () => {
  it("maps to a theme palette token", () => {
    expect(rateLimitColor(10)).toBe("success")
    expect(rateLimitColor(80)).toBe("warning")
    expect(rateLimitColor(100)).toBe("danger")
  })
})

describe("rateLimitResetText", () => {
  it("formats hours+minutes and minutes-only", () => {
    expect(rateLimitResetText(NOW + (2 * 60 + 5) * 60_000, NOW)).toBe("Resets in 2h 5m")
    expect(rateLimitResetText(NOW + 5 * 60_000, NOW)).toBe("Resets in 5m")
  })
  it("collapses an elapsed reset to 'Resets shortly'", () => {
    expect(rateLimitResetText(NOW - 1000, NOW)).toBe("Resets shortly")
  })
  it("returns null when there is no reset", () => {
    expect(rateLimitResetText(null, NOW)).toBeNull()
  })
})

describe("rateLimitRightLabel", () => {
  it("renders the remaining figure with thousands separators + unit", () => {
    expect(
      rateLimitRightLabel({
        kind: "tokens",
        label: "Tokens",
        unit: "tok",
        limit: 1_000_000,
        remaining: 12_345,
        usedPct: 99,
        resetAt: null,
      })
    ).toBe("12,345 tok left")
  })
})

describe("tightestRemainingPct", () => {
  it("returns the lowest remaining headroom across windows", () => {
    const snap = parseRateLimitHeaders(
      {
        "anthropic-ratelimit-requests-limit": "100",
        "anthropic-ratelimit-requests-remaining": "80", // 80% left
        "anthropic-ratelimit-tokens-limit": "1000",
        "anthropic-ratelimit-tokens-remaining": "120", // 12% left ← tightest
      },
      NOW
    )
    expect(tightestRemainingPct(snap!)).toBe(12)
  })
})

describe("rateLimitWarning", () => {
  const snap = (limit: number, remaining: number) =>
    parseRateLimitHeaders(
      {
        "anthropic-ratelimit-requests-limit": String(limit),
        "anthropic-ratelimit-requests-remaining": String(remaining),
      },
      NOW
    )!

  it("returns null below the crit threshold", () => {
    expect(rateLimitWarning(snap(100, 50))).toBeNull() // 50% used
    expect(rateLimitWarning(snap(100, 12))).toBeNull() // 88% used (< 90)
  })

  it("warns at the crit threshold (>=90%)", () => {
    const w = rateLimitWarning(snap(100, 8)) // 92% used
    expect(w).toMatchObject({ severity: "warn", level: "crit" })
    expect(w!.message).toMatch(/Approaching rate limit/)
  })

  it("errors when exhausted (>=100%)", () => {
    const w = rateLimitWarning(snap(100, 0)) // 100% used
    expect(w).toMatchObject({ severity: "error", level: "exceeded" })
    expect(w!.message).toMatch(/Rate limit reached/)
  })

  it("picks the worst meter across windows", () => {
    const both = parseRateLimitHeaders(
      {
        "anthropic-ratelimit-requests-limit": "100",
        "anthropic-ratelimit-requests-remaining": "80", // 20% used
        "anthropic-ratelimit-tokens-limit": "1000",
        "anthropic-ratelimit-tokens-remaining": "0", // 100% used ← worst
      },
      NOW
    )!
    expect(rateLimitWarning(both)).toMatchObject({ level: "exceeded" })
  })
})

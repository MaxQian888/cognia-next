import { CLAUDE_CLI_USER_AGENT } from "./constants"

import {
  OAUTH_USAGE_BETA,
  OAUTH_USAGE_ENDPOINT,
  fetchOAuthUsage,
  parseOAuthUsage,
} from "./usage-endpoint"

const fullBody = JSON.stringify({
  five_hour: { utilization: 33, resets_at: "2026-01-01T05:00:00.000Z" },
  seven_day: { utilization: 12, resets_at: "2026-01-08T00:00:00.000Z" },
  seven_day_opus: { utilization: 60, resets_at: "2026-01-08T00:00:00.000Z" },
  seven_day_sonnet: { utilization: 4, resets_at: "2026-01-08T00:00:00.000Z" },
})

describe("parseOAuthUsage", () => {
  it("maps the four windows to ordered meters with ISO resets", () => {
    const meters = parseOAuthUsage(fullBody)
    expect(meters.map((m) => m.id)).toEqual(["session", "weekly", "weekly_opus", "weekly_sonnet"])
    expect(meters[0]).toMatchObject({
      kind: "window",
      usedPct: 33,
      resetAt: Date.parse("2026-01-01T05:00:00.000Z"),
    })
    expect(meters[2].usedPct).toBe(60)
  })

  it("skips absent windows and tolerates a numeric unix reset", () => {
    const meters = parseOAuthUsage(
      JSON.stringify({ five_hour: { utilization: 10, resets_at: 1700 } })
    )
    expect(meters.map((m) => m.id)).toEqual(["session"])
    expect(meters[0].resetAt).toBe(1_700_000)
  })

  it("returns [] for non-JSON, non-object, and windows missing utilization", () => {
    expect(parseOAuthUsage("nope")).toEqual([])
    expect(parseOAuthUsage(JSON.stringify(null))).toEqual([])
    expect(parseOAuthUsage(JSON.stringify({ five_hour: { resets_at: "x" } }))).toEqual([])
  })

  it("appends an overage balance meter when extra_usage is enabled", () => {
    const meters = parseOAuthUsage(
      JSON.stringify({
        five_hour: { utilization: 10, resets_at: "2026-01-01T05:00:00.000Z" },
        extra_usage: {
          is_enabled: true,
          monthly_limit: 100,
          used_credits: 40,
          currency: "USD",
        },
      })
    )
    expect(meters.map((m) => m.id)).toEqual(["session", "overage"])
    expect(meters[1]).toMatchObject({
      kind: "balance",
      labelKey: "subscription.limits.meter.overage",
      total: 100,
      used: 40,
      remaining: 60,
      currency: "USD",
      usedPct: 40,
    })
  })

  it("omits overage when disabled, absent, or carrying no amounts", () => {
    expect(parseOAuthUsage(JSON.stringify({ extra_usage: { is_enabled: false } }))).toEqual([])
    expect(parseOAuthUsage(JSON.stringify({ extra_usage: { is_enabled: true } }))).toEqual([])
    expect(
      parseOAuthUsage(JSON.stringify({ five_hour: { utilization: 5 } })).map((m) => m.id)
    ).toEqual(["session"])
  })
})

describe("fetchOAuthUsage", () => {
  it("requests the endpoint with the beta header and parses the body", async () => {
    let seenUrl = ""
    let seenHeaders: Record<string, string> | undefined
    const meters = await fetchOAuthUsage("sk-ant", {
      authedGet: async (url, headers) => {
        seenUrl = url
        seenHeaders = headers
        return fullBody
      },
    })
    expect(seenUrl).toBe(OAUTH_USAGE_ENDPOINT)
    expect(seenHeaders).toMatchObject({
      Authorization: "Bearer sk-ant",
      "anthropic-beta": OAUTH_USAGE_BETA,
      // Without a claude-cli User-Agent the endpoint drops the caller into an
      // aggressively rate-limited 429 bucket, forcing the paid probe fallback.
      "User-Agent": CLAUDE_CLI_USER_AGENT,
    })
    expect(meters).toHaveLength(4)
  })

  it("returns [] when the GET throws", async () => {
    const meters = await fetchOAuthUsage("sk-ant", {
      authedGet: async () => {
        throw new Error("403")
      },
    })
    expect(meters).toEqual([])
  })
})

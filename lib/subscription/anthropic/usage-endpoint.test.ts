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

  // cc-switch captures tiers outside its KNOWN_TIERS list; a fixed map would
  // silently render nothing the day Anthropic ships a new window.
  it("captures unknown tiers after the known ones, labelled by raw key", () => {
    const meters = parseOAuthUsage(
      JSON.stringify({
        five_hour: { utilization: 10 },
        seven_day_haiku: { utilization: 55, resets_at: "2026-01-08T00:00:00.000Z" },
      })
    )
    expect(meters.map((m) => m.id)).toEqual(["session", "seven_day_haiku"])
    const unknown = meters[1]
    expect(unknown).toMatchObject({ kind: "window", usedPct: 55, label: "seven_day_haiku" })
    // No i18n key exists for a tier we've never seen — the renderer falls back
    // to `label`, so leaving labelKey unset keeps lint:i18n honest.
    expect(unknown.labelKey).toBeUndefined()
  })

  it("does not mistake extra_usage for an unknown tier", () => {
    const meters = parseOAuthUsage(
      JSON.stringify({ extra_usage: { is_enabled: true, monthly_limit: 10, used_credits: 1 } })
    )
    expect(meters.map((m) => m.id)).toEqual(["overage"])
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
    const result = await fetchOAuthUsage("sk-ant", {
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
      "User-Agent": CLAUDE_CLI_USER_AGENT,
    })
    expect(result).toMatchObject({ ok: true })
    expect(result.ok && result.meters).toHaveLength(4)
  })

  // The whole point of the failure taxonomy: an expired bearer, a throttle and
  // a transport error must NOT look alike. Collapsing them into `[]` is what
  // froze the quota panel with an empty log.
  it.each([
    ["401 Unauthorized: {}", "auth", 401],
    ["403 Forbidden: {}", "auth", 403],
    ["429 Too Many Requests: slow down", "rate_limited", 429],
    ["500 Internal Server Error: boom", "http", 500],
  ])("classifies %s as %s", async (thrown, kind, status) => {
    const result = await fetchOAuthUsage("sk-ant", {
      authedGet: async () => {
        throw new Error(thrown)
      },
    })
    expect(result).toMatchObject({ ok: false, kind, status })
    expect(result.ok === false && result.message).toContain(thrown)
  })

  it("classifies a statusless transport failure as network", async () => {
    const result = await fetchOAuthUsage("sk-ant", {
      authedGet: async () => {
        throw new Error("request failed: dns error")
      },
    })
    expect(result).toMatchObject({ ok: false, kind: "network" })
  })

  // Tauri rejects with the bare `Err(String)` payload, not an Error instance.
  it("recovers the status from a non-Error rejection", async () => {
    const result = await fetchOAuthUsage("sk-ant", {
      authedGet: async () => {
        throw "429 Too Many Requests: bucket drained"
      },
    })
    expect(result).toMatchObject({ ok: false, kind: "rate_limited", status: 429 })
  })

  it("reports an unparseable 200 body as a parse failure, not as no-windows", async () => {
    const result = await fetchOAuthUsage("sk-ant", {
      authedGet: async () => "<html>nope</html>",
    })
    expect(result).toMatchObject({ ok: false, kind: "parse" })
  })

  it("succeeds with zero meters when the body is a well-formed empty object", async () => {
    const result = await fetchOAuthUsage("sk-ant", { authedGet: async () => "{}" })
    expect(result).toEqual({ ok: true, meters: [] })
  })
})

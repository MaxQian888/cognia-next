import { codexLimitsSource, parseCodexWindows, parseWhamUsage, resolveUsageBase } from "./codex"

import type { LimitsSourceContext } from "@/types/subscription"

function ctx(over: Partial<LimitsSourceContext> = {}): LimitsSourceContext {
  return {
    provider: "codex",
    accountId: "acc-1",
    accountLabel: "ChatGPT Plus",
    token: "sk-chatgpt",
    authedGet: async () =>
      JSON.stringify({
        rate_limits: {
          primary: { used_percent: 21, resets_in_seconds: 3600 },
          secondary: { used_percent: 5, resets_at: 2_000_000 },
        },
      }),
    now: 1_000_000,
    ...over,
  }
}

describe("parseCodexWindows", () => {
  it("parses primary → session, secondary → weekly with reset math", () => {
    const meters = parseCodexWindows(
      JSON.stringify({
        primary: { used_percent: 40, resets_in_seconds: 60 },
        secondary: { usage_percent: 8, resets_at: 1700 },
      }),
      10_000
    )
    expect(meters.map((m) => m.id)).toEqual(["session", "weekly"])
    expect(meters[0]).toMatchObject({ usedPct: 40, resetAt: 70_000 })
    // resets_at in seconds (1700 < 1e12) → ms
    expect(meters[1].resetAt).toBe(1_700_000)
  })

  it("returns [] for non-JSON and unexpected shapes", () => {
    expect(parseCodexWindows("not json", 0)).toEqual([])
    expect(parseCodexWindows(JSON.stringify({ foo: 1 }), 0)).toEqual([])
    expect(parseCodexWindows(JSON.stringify(null), 0)).toEqual([])
  })

  it("treats large resets_at as already-ms", () => {
    const meters = parseCodexWindows(
      JSON.stringify({ primary: { used_percent: 1, resets_at: 5_000_000_000_000 } }),
      0
    )
    expect(meters[0].resetAt).toBe(5_000_000_000_000)
  })
})

describe("parseWhamUsage", () => {
  it("parses rate_limit.primary_window/secondary_window → session/weekly", () => {
    const meters = parseWhamUsage(
      JSON.stringify({
        rate_limit: {
          primary_window: { used_percent: 33, limit_window_seconds: 18000, reset_at: 1700 },
          secondary_window: { used_percent: 12, limit_window_seconds: 604800, reset_at: 9000 },
        },
      }),
      0
    )
    expect(meters.map((m) => m.id)).toEqual(["session", "weekly"])
    expect(meters[0]).toMatchObject({ usedPct: 33, resetAt: 1_700_000 })
    expect(meters[1]).toMatchObject({ usedPct: 12, resetAt: 9_000_000 })
  })

  it("skips a window missing used_percent and returns [] for wrong shapes", () => {
    const meters = parseWhamUsage(
      JSON.stringify({ rate_limit: { primary_window: { reset_at: 1 } } }),
      0
    )
    expect(meters).toEqual([])
    expect(parseWhamUsage("not json", 0)).toEqual([])
    expect(parseWhamUsage(JSON.stringify({ rate_limit: null }), 0)).toEqual([])
    expect(parseWhamUsage(JSON.stringify({ foo: 1 }), 0)).toEqual([])
  })

  it("treats large reset_at as already-ms", () => {
    const meters = parseWhamUsage(
      JSON.stringify({ rate_limit: { primary_window: { used_percent: 1, reset_at: 5e12 } } }),
      0
    )
    expect(meters[0].resetAt).toBe(5e12)
  })

  it("parses the real `resets_at` field (Codex RateLimitWindow) in unix seconds", () => {
    const meters = parseWhamUsage(
      JSON.stringify({
        rate_limit: {
          primary_window: { used_percent: 28, window_minutes: 300, resets_at: 1700 },
          secondary_window: { used_percent: 55, window_minutes: 10080, resets_at: 9000 },
        },
      }),
      0
    )
    expect(meters[0]).toMatchObject({ id: "session", usedPct: 28, resetAt: 1_700_000 })
    expect(meters[1]).toMatchObject({ id: "weekly", usedPct: 55, resetAt: 9_000_000 })
  })

  it("prefers `resets_at` over a legacy `reset_at` on the same window", () => {
    const meters = parseWhamUsage(
      JSON.stringify({
        rate_limit: { primary_window: { used_percent: 1, resets_at: 1700, reset_at: 42 } },
      }),
      0
    )
    expect(meters[0].resetAt).toBe(1_700_000)
  })

  it("derives reset from `window_minutes` when no absolute timestamp is present", () => {
    const now = 1_000_000
    const meters = parseWhamUsage(
      JSON.stringify({
        rate_limit: { primary_window: { used_percent: 10, window_minutes: 300 } },
      }),
      now
    )
    // now + 300 minutes
    expect(meters[0].resetAt).toBe(now + 300 * 60_000)
  })
})

describe("codexLimitsSource — wham endpoint", () => {
  it("fetches and maps the real wham/usage shape", async () => {
    const snap = await codexLimitsSource.fetch(
      ctx({
        authedGet: async (url) => {
          expect(url).toContain("/wham/usage")
          return JSON.stringify({
            rate_limit: {
              primary_window: { used_percent: 50, reset_at: 1234 },
              secondary_window: { used_percent: 7, reset_at: 5678 },
            },
          })
        },
      })
    )
    expect(snap?.meters.map((m) => m.id)).toEqual(["session", "weekly"])
    expect(snap?.meters[0]).toMatchObject({ usedPct: 50, resetAt: 1_234_000 })
  })
})

describe("codexLimitsSource", () => {
  // Regression: `matches` used to reject on `providerKey`, but that is the
  // preset's templateId — Codex presets come from the openai-compatible /
  // openrouter catalog families, so a real ChatGPT account whose preset came
  // from the catalog never matched and rendered no windows at all.
  it("matches any codex account regardless of preset templateId", () => {
    expect(codexLimitsSource.matches({ provider: "codex" })).toBe(true)
    expect(codexLimitsSource.matches({ provider: "codex", providerKey: "openai" })).toBe(true)
    expect(codexLimitsSource.matches({ provider: "codex", providerKey: "openrouter" })).toBe(true)
    expect(codexLimitsSource.matches({ provider: "anthropic" })).toBe(false)
  })

  it("fetches and maps the chatgpt windows", async () => {
    const snap = await codexLimitsSource.fetch(ctx())
    expect(snap?.provider).toBe("codex")
    expect(snap?.meters.map((m) => m.id)).toEqual(["session", "weekly"])
    expect(snap?.meters[0]).toMatchObject({ usedPct: 21, resetAt: 1_000_000 + 3_600_000 })
  })

  it("returns null with no token", async () => {
    expect(await codexLimitsSource.fetch(ctx({ token: null }))).toBeNull()
  })

  it("returns null when the response has no recognizable windows", async () => {
    expect(await codexLimitsSource.fetch(ctx({ authedGet: async () => "{}" }))).toBeNull()
  })

  // The bug that hid every other bug: a bare `catch { return null }` made a
  // 401/404/429 look identical to "no data" — blank panel, empty log.
  it("surfaces an endpoint error instead of swallowing it", async () => {
    const snap = await codexLimitsSource.fetch(
      ctx({
        authedGet: async () => {
          throw new Error("403: forbidden")
        },
      })
    )
    expect(snap).toMatchObject({ provider: "codex", meters: [], error: "403: forbidden" })
  })

  it("sends the ChatGPT identity headers the backend requires", async () => {
    let seen: Record<string, string> | undefined
    await codexLimitsSource.fetch(
      ctx({
        credential: {
          provider: "codex",
          authMode: "chatgpt",
          accountId: "acct-42",
        } as LimitsSourceContext["credential"],
        authedGet: async (_url, headers) => {
          seen = headers
          return "{}"
        },
      })
    )
    expect(seen).toMatchObject({
      Authorization: "Bearer sk-chatgpt",
      "ChatGPT-Account-Id": "acct-42",
      "OpenAI-Beta": "responses=experimental",
      originator: "codex_cli_rs",
      "OAI-Product-Sku": "codex",
    })
  })

  // An api_key login has no usage endpoint upstream ("chatgpt authentication
  // required to read rate limits"). Decline so the credit-balance source can
  // still answer for the account.
  it("declines an api_key credential", async () => {
    const authedGet = jest.fn()
    const snap = await codexLimitsSource.fetch(
      ctx({
        credential: {
          provider: "codex",
          authMode: "api_key",
        } as LimitsSourceContext["credential"],
        authedGet,
      })
    )
    expect(snap).toBeNull()
    expect(authedGet).not.toHaveBeenCalled()
  })

  it("retries once with a refreshed bearer on a 401", async () => {
    const tokens: string[] = []
    const snap = await codexLimitsSource.fetch(
      ctx({
        refreshToken: async () => "sk-fresh",
        authedGet: async (_url, headers) => {
          const bearer = (headers?.Authorization ?? "").replace("Bearer ", "")
          tokens.push(bearer)
          if (bearer !== "sk-fresh") throw new Error("401: expired")
          return JSON.stringify({ rate_limit: { primary_window: { used_percent: 12 } } })
        },
      })
    )
    expect(tokens).toEqual(["sk-chatgpt", "sk-fresh"])
    expect(snap?.meters[0]).toMatchObject({ id: "session", usedPct: 12 })
  })
})

describe("resolveUsageBase", () => {
  // The `/wham/usage` path hangs off the backend-api ROOT, not off the
  // Responses base a chat preset carries. Appending to the preset base gave
  // `…/codex/wham/usage` → 404 → swallowed → blank panel.
  it("defaults to the chatgpt backend root when no preset base is set", () => {
    expect(resolveUsageBase(undefined)).toBe("https://chatgpt.com/backend-api")
    expect(resolveUsageBase("  ")).toBe("https://chatgpt.com/backend-api")
  })

  it("strips the /codex responses prefix off a chatgpt preset base", () => {
    expect(resolveUsageBase("https://chatgpt.com/backend-api/codex")).toBe(
      "https://chatgpt.com/backend-api"
    )
    expect(resolveUsageBase("https://chatgpt.com/backend-api/")).toBe(
      "https://chatgpt.com/backend-api"
    )
    expect(resolveUsageBase("https://chatgpt.com")).toBe("https://chatgpt.com/backend-api")
  })

  // Retargeting a relay's request at chatgpt.com would ship the relay's bearer
  // to OpenAI. Decline instead.
  it("declines a non-chatgpt base rather than retargeting the bearer", () => {
    expect(resolveUsageBase("https://api.openai.com/v1")).toBeNull()
    expect(resolveUsageBase("https://relay.example.com/v1")).toBeNull()
  })
})

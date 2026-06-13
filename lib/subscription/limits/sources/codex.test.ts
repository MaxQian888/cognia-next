import { codexLimitsSource, parseCodexWindows, parseWhamUsage } from "./codex"

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
  it("matches only a chatgpt-looking codex account", () => {
    expect(codexLimitsSource.matches({ provider: "codex" })).toBe(true)
    expect(codexLimitsSource.matches({ provider: "codex", providerKey: "openai" })).toBe(true)
    expect(codexLimitsSource.matches({ provider: "codex", providerKey: "deepseek" })).toBe(false)
    expect(
      codexLimitsSource.matches({ provider: "codex", baseUrl: "https://api.deepseek.com/v1" })
    ).toBe(false)
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

  it("returns null when the endpoint errors", async () => {
    const snap = await codexLimitsSource.fetch(
      ctx({
        authedGet: async () => {
          throw new Error("403")
        },
      })
    )
    expect(snap).toBeNull()
  })

  it("returns null when the response has no recognizable windows", async () => {
    expect(await codexLimitsSource.fetch(ctx({ authedGet: async () => "{}" }))).toBeNull()
  })
})

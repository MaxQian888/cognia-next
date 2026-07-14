import { descriptorToSource, resolveReset, runDescriptor, substitute } from "./engine"

import type { LimitsSourceContext, SourceDescriptor } from "@/types/subscription"

function ctx(over: Partial<LimitsSourceContext> = {}): LimitsSourceContext {
  return {
    provider: "codex",
    accountId: "acc-1",
    accountLabel: "My Plan",
    token: "sk-test",
    baseUrl: "https://api.example.com/v1",
    providerKey: "example",
    authedGet: async () => "{}",
    now: 1_000_000,
    ...over,
  }
}

const balanceDescriptor: SourceDescriptor = {
  id: "example",
  match: { providerKey: "example", baseUrlIncludes: "example.com" },
  request: { path: "/account/{{accountId}}/balance", headers: { "X-Key": "{{token}}" } },
  extract: { kind: "balance", remainingPath: "data.balance", unit: "CNY", currency: "CNY" },
}

const windowDescriptor: SourceDescriptor = {
  id: "windowed",
  match: { providerKey: "windowed" },
  request: { path: "/usage" },
  extract: {
    kind: "window",
    windows: [
      {
        id: "session",
        labelKey: "subscription.limits.meter.session",
        usedPctPath: "rate_limit.primary.used_percent",
        resetAtPath: "rate_limit.primary.reset_at",
        resetUnit: "unix",
      },
      {
        id: "weekly",
        labelKey: "subscription.limits.meter.weekly",
        usedPctPath: "rate_limit.secondary.used_percent",
        resetAtPath: "rate_limit.secondary.reset_in",
        resetUnit: "relativeSeconds",
      },
    ],
  },
}

describe("substitute", () => {
  it("replaces all three placeholders (with optional whitespace)", () => {
    expect(
      substitute("{{baseUrl}}/u/{{ accountId }}?t={{token}}", {
        token: "T",
        baseUrl: "B",
        accountId: "A",
      })
    ).toBe("B/u/A?t=T")
  })

  it("leaves unknown placeholders untouched", () => {
    expect(substitute("{{unknown}}", { token: "T", baseUrl: "B", accountId: "A" })).toBe(
      "{{unknown}}"
    )
  })
})

describe("resolveReset", () => {
  const root = {
    unixSec: 1700, // < 1e12 → seconds
    unixMs: 5_000_000_000_000,
    rel: 60,
    iso: "2026-01-01T00:00:00.000Z",
    bad: "not-a-date",
  }
  it("unix seconds → ms, unix ms passthrough", () => {
    expect(resolveReset(root, "unixSec", "unix", 0)).toBe(1_700_000)
    expect(resolveReset(root, "unixMs", "unix", 0)).toBe(5_000_000_000_000)
  })
  it("ms passthrough and relativeSeconds add to now", () => {
    expect(resolveReset(root, "unixMs", "ms", 0)).toBe(5_000_000_000_000)
    expect(resolveReset(root, "rel", "relativeSeconds", 1000)).toBe(1000 + 60_000)
  })
  it("iso parses, and returns null for bad iso / non-string / missing path", () => {
    expect(resolveReset(root, "iso", "iso", 0)).toBe(Date.parse("2026-01-01T00:00:00.000Z"))
    expect(resolveReset(root, "bad", "iso", 0)).toBeNull()
    expect(resolveReset(root, "rel", "iso", 0)).toBeNull()
    expect(resolveReset(root, undefined, "unix", 0)).toBeNull()
    expect(resolveReset(root, "missing", "unix", 0)).toBeNull()
  })
  it("defaults to unix heuristic when unit omitted", () => {
    expect(resolveReset(root, "unixSec", undefined, 0)).toBe(1_700_000)
  })
})

describe("runDescriptor — balance", () => {
  it("builds a credit meter with scaling and substituted request", async () => {
    let seenUrl = ""
    let seenHeaders: Record<string, string> | undefined
    const scaledDescriptor: SourceDescriptor = {
      ...balanceDescriptor,
      extract: {
        kind: "balance",
        remainingPath: "data.balance",
        unit: "CNY",
        currency: "CNY",
        scale: 0.0001,
      },
    }
    const snap = await runDescriptor(
      scaledDescriptor,
      ctx({
        authedGet: async (url, headers) => {
          seenUrl = url
          seenHeaders = headers
          return JSON.stringify({ data: { balance: 120_000 } })
        },
      })
    )
    expect(seenUrl).toBe("https://api.example.com/v1/account/acc-1/balance")
    expect(seenHeaders).toMatchObject({ "X-Key": "sk-test", Authorization: "Bearer sk-test" })
    expect(snap?.provider).toBe("example")
    expect(snap?.meters).toHaveLength(1)
    expect(snap?.meters[0]).toMatchObject({ kind: "balance", remaining: 12, unit: "CNY" })
  })

  it("returns null when no amount field resolves (wrong shape → fall through)", async () => {
    const snap = await runDescriptor(
      balanceDescriptor,
      ctx({ authedGet: async () => JSON.stringify({ nope: 1 }) })
    )
    expect(snap).toBeNull()
  })
})

describe("runDescriptor — window", () => {
  it("maps multiple windows, skipping ones whose percent is absent", async () => {
    const snap = await runDescriptor(
      windowDescriptor,
      ctx({
        authedGet: async () =>
          JSON.stringify({
            rate_limit: {
              primary: { used_percent: 40, reset_at: 2000 },
              secondary: { reset_in: 120 }, // no used_percent → skipped
            },
          }),
      })
    )
    expect(snap?.meters.map((m) => m.id)).toEqual(["session"])
    expect(snap?.meters[0]).toMatchObject({ usedPct: 40, resetAt: 2_000_000 })
  })
})

describe("runDescriptor — window scale & invert", () => {
  it("scales a 0–1 fraction up and inverts a remaining-percent", async () => {
    const d: SourceDescriptor = {
      id: "scaled",
      match: { providerKey: "scaled" },
      request: { path: "/u" },
      extract: {
        kind: "window",
        windows: [
          {
            id: "session",
            labelKey: "subscription.limits.meter.session",
            usedPctPath: "frac",
            usedPctScale: 100,
          },
          {
            id: "weekly",
            labelKey: "subscription.limits.meter.weekly",
            usedPctPath: "remainingPct",
            invert: true,
          },
        ],
      },
    }
    const snap = await runDescriptor(
      d,
      ctx({ authedGet: async () => JSON.stringify({ frac: 0.4, remainingPct: 30 }) })
    )
    expect(snap?.meters[0].usedPct).toBe(40) // 0.4 * 100
    expect(snap?.meters[1].usedPct).toBe(70) // 100 - 30
  })
})

describe("runDescriptor — window count derivation", () => {
  it("derives utilization from used/total counts", async () => {
    const d: SourceDescriptor = {
      id: "count",
      match: { providerKey: "count" },
      request: { path: "/u" },
      extract: {
        kind: "window",
        windows: [
          {
            id: "session",
            labelKey: "subscription.limits.meter.session",
            usedPath: "usage",
            totalPath: "limit",
            resetAtPath: "reset",
            resetUnit: "unix",
          },
        ],
      },
    }
    const snap = await runDescriptor(
      d,
      ctx({ authedGet: async () => JSON.stringify({ usage: 150, limit: 600, reset: 2000 }) })
    )
    // 150/600 = 25%
    expect(snap?.meters[0]).toMatchObject({ usedPct: 25, resetAt: 2_000_000 })
  })

  it("derives utilization from remaining/total when usedPath is absent", async () => {
    const d: SourceDescriptor = {
      id: "rem",
      match: { providerKey: "rem" },
      request: { path: "/u" },
      extract: {
        kind: "window",
        windows: [
          {
            id: "session",
            labelKey: "subscription.limits.meter.session",
            remainingPath: "remaining",
            totalPath: "limit",
          },
        ],
      },
    }
    const snap = await runDescriptor(
      d,
      ctx({ authedGet: async () => JSON.stringify({ remaining: 250, limit: 1000 }) })
    )
    // 1 - 250/1000 = 75%
    expect(snap?.meters[0].usedPct).toBe(75)
  })

  it("preserves an overage (>100% → exceeded) without capping", async () => {
    const d: SourceDescriptor = {
      id: "over",
      match: { providerKey: "over" },
      request: { path: "/u" },
      extract: {
        kind: "window",
        windows: [{ id: "s", labelKey: "x", usedPath: "u", totalPath: "t" }],
      },
    }
    const snap = await runDescriptor(
      d,
      ctx({ authedGet: async () => JSON.stringify({ u: 150, t: 100 }) })
    )
    expect(snap?.meters[0].usedPct).toBe(150)
    expect(snap?.meters[0].status).toBe("exceeded")
  })

  it("skips a window whose total is missing/zero → falls through to null", async () => {
    const d: SourceDescriptor = {
      id: "zero",
      match: { providerKey: "zero" },
      request: { path: "/u" },
      extract: {
        kind: "window",
        windows: [{ id: "s", labelKey: "x", usedPath: "u", totalPath: "t" }],
      },
    }
    const snap = await runDescriptor(d, ctx({ authedGet: async () => JSON.stringify({ u: 5 }) }))
    expect(snap).toBeNull()
  })
})

describe("runDescriptor — window array select", () => {
  const discriminated: SourceDescriptor = {
    id: "sel",
    match: { providerKey: "sel" },
    request: { path: "/q" },
    extract: {
      kind: "window",
      windows: [
        {
          id: "session",
          labelKey: "subscription.limits.meter.session",
          usedPctPath: "percentage",
          resetAtPath: "nextResetTime",
          resetUnit: "unix",
          select: { arrayPath: "data.limits", by: "TOKENS_LIMIT", equals: "five_hour" },
        },
        {
          id: "weekly",
          labelKey: "subscription.limits.meter.weekly",
          usedPctPath: "percentage",
          resetAtPath: "nextResetTime",
          resetUnit: "unix",
          select: { arrayPath: "data.limits", by: "TOKENS_LIMIT", equals: "weekly" },
        },
      ],
    },
  }

  it("picks the tier element per window by discriminator (order-independent)", async () => {
    const snap = await runDescriptor(
      discriminated,
      ctx({
        authedGet: async () =>
          JSON.stringify({
            data: {
              // Deliberately weekly-first to prove we don't rely on array order.
              limits: [
                { TOKENS_LIMIT: "weekly", percentage: 40, nextResetTime: 9000 },
                { TOKENS_LIMIT: "five_hour", percentage: 75.4, nextResetTime: 3000 },
              ],
            },
          }),
      })
    )
    expect(snap?.meters.map((m) => m.id)).toEqual(["session", "weekly"])
    expect(snap?.meters[0]).toMatchObject({ usedPct: 75, resetAt: 3_000_000 })
    expect(snap?.meters[1]).toMatchObject({ usedPct: 40, resetAt: 9_000_000 })
  })

  it("skips only the window whose tier element is absent", async () => {
    const snap = await runDescriptor(
      discriminated,
      ctx({
        authedGet: async () =>
          JSON.stringify({
            data: { limits: [{ TOKENS_LIMIT: "weekly", percentage: 10, nextResetTime: 9 }] },
          }),
      })
    )
    expect(snap?.meters.map((m) => m.id)).toEqual(["weekly"])
  })

  it("falls through to null when the select path is not an array", async () => {
    const snap = await runDescriptor(
      discriminated,
      ctx({ authedGet: async () => JSON.stringify({ data: { limits: "nope" } }) })
    )
    expect(snap).toBeNull()
  })

  it("combines select with count derivation (select + used/total)", async () => {
    const d: SourceDescriptor = {
      id: "selcount",
      match: { providerKey: "selcount" },
      request: { path: "/q" },
      extract: {
        kind: "window",
        windows: [
          {
            id: "s",
            labelKey: "subscription.limits.meter.session",
            usedPath: "used",
            totalPath: "cap",
            resetAtPath: "end",
            resetUnit: "unix",
            select: { arrayPath: "tiers", by: "name", equals: "a" },
          },
        ],
      },
    }
    const snap = await runDescriptor(
      d,
      ctx({
        authedGet: async () =>
          JSON.stringify({
            tiers: [
              { name: "b", used: 0, cap: 10, end: 1 },
              { name: "a", used: 30, cap: 200, end: 5000 },
            ],
          }),
      })
    )
    // 30/200 = 15%, reset 5000s unix → 5_000_000
    expect(snap?.meters[0]).toMatchObject({ usedPct: 15, resetAt: 5_000_000 })
  })
})

describe("runDescriptor — auth override", () => {
  it("uses a descriptor-supplied Authorization (raw key, no Bearer) and extra headers", async () => {
    let seen: Record<string, string> | undefined
    const d: SourceDescriptor = {
      id: "raw",
      match: { providerKey: "raw" },
      request: {
        path: "/q",
        headers: { Authorization: "{{token}}", "New-Api-User": "4242" },
      },
      extract: { kind: "balance", remainingPath: "balance" },
    }
    await runDescriptor(
      d,
      ctx({
        token: "rawkey",
        authedGet: async (_url, headers) => {
          seen = headers
          return JSON.stringify({ balance: 1 })
        },
      })
    )
    expect(seen?.Authorization).toBe("rawkey")
    expect(seen?.["New-Api-User"]).toBe("4242")
  })
})

describe("runDescriptor — edge cases", () => {
  it("returns null with no token or no baseUrl", async () => {
    expect(await runDescriptor(balanceDescriptor, ctx({ token: null }))).toBeNull()
    expect(await runDescriptor(balanceDescriptor, ctx({ baseUrl: undefined }))).toBeNull()
  })

  it("surfaces a thrown GET as an error snapshot", async () => {
    const snap = await runDescriptor(
      balanceDescriptor,
      ctx({
        authedGet: async () => {
          throw new Error("HTTP 401")
        },
      })
    )
    expect(snap).toMatchObject({ provider: "example", error: "HTTP 401", meters: [] })
  })

  it("returns null for an unparseable body", async () => {
    expect(
      await runDescriptor(balanceDescriptor, ctx({ authedGet: async () => "<html>nope" }))
    ).toBeNull()
  })
})

describe("descriptorToSource", () => {
  it("matches by exact providerKey or baseUrl substring", () => {
    const src = descriptorToSource(balanceDescriptor)
    expect(src.key).toBe("example")
    expect(src.matches({ providerKey: "example" })).toBe(true)
    expect(src.matches({ baseUrl: "https://api.example.com/v1" })).toBe(true)
    expect(src.matches({ providerKey: "other" })).toBe(false)
    expect(src.matches({ baseUrl: "https://api.other.com" })).toBe(false)
    expect(src.matches({})).toBe(false)
  })

  it("fetch delegates to runDescriptor", async () => {
    const src = descriptorToSource(balanceDescriptor)
    const snap = await src.fetch(
      ctx({ authedGet: async () => JSON.stringify({ data: { balance: 9 } }) })
    )
    expect(snap?.meters[0]).toMatchObject({ remaining: 9 })
  })

  it("matches when providerKey or baseUrlIncludes is an array", () => {
    const arrayDescriptor: SourceDescriptor = {
      id: "multi",
      match: { providerKey: ["a", "b"], baseUrlIncludes: ["z.ai", "bigmodel.cn"] },
      request: { path: "/x" },
      extract: { kind: "balance", remainingPath: "bal" },
    }
    const src = descriptorToSource(arrayDescriptor)
    expect(src.matches({ providerKey: "b" })).toBe(true)
    expect(src.matches({ providerKey: "c" })).toBe(false)
    expect(src.matches({ baseUrl: "https://open.bigmodel.cn/api/anthropic" })).toBe(true)
    expect(src.matches({ baseUrl: "https://api.z.ai/api/anthropic" })).toBe(true)
    expect(src.matches({ baseUrl: "https://example.com" })).toBe(false)
  })
})

describe("runDescriptor — useBaseUrlOrigin", () => {
  const originDescriptor: SourceDescriptor = {
    id: "origin",
    match: { providerKey: "origin" },
    request: { useBaseUrlOrigin: true, path: "/api/monitor/quota" },
    extract: { kind: "balance", remainingPath: "bal", unit: "USD", currency: "USD" },
  }

  it("anchors the path at the host origin, ignoring a relay path segment", async () => {
    let seenUrl = ""
    await runDescriptor(
      originDescriptor,
      ctx({
        baseUrl: "https://open.bigmodel.cn/api/anthropic",
        authedGet: async (url) => {
          seenUrl = url
          return JSON.stringify({ bal: 1 })
        },
      })
    )
    expect(seenUrl).toBe("https://open.bigmodel.cn/api/monitor/quota")
  })

  it("still resolves for a bare-host baseUrl (origin === host)", async () => {
    let seenUrl = ""
    await runDescriptor(
      originDescriptor,
      ctx({
        baseUrl: "https://api.z.ai",
        authedGet: async (url) => {
          seenUrl = url
          return JSON.stringify({ bal: 1 })
        },
      })
    )
    expect(seenUrl).toBe("https://api.z.ai/api/monitor/quota")
  })

  it("falls back to the trimmed base when the URL can't be parsed", async () => {
    let seenUrl = ""
    await runDescriptor(
      originDescriptor,
      ctx({
        baseUrl: "not-a-valid-url",
        authedGet: async (url) => {
          seenUrl = url
          return JSON.stringify({ bal: 1 })
        },
      })
    )
    expect(seenUrl).toBe("not-a-valid-url/api/monitor/quota")
  })
})

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
})

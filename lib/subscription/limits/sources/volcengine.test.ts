import { createVolcengineLimitsSource } from "./volcengine"

import type { VolcengineUsageResult } from "@/lib/subscription/core/transport"
import type { LimitsSourceContext } from "@/types/subscription"

function ctx(over: Partial<LimitsSourceContext> = {}): LimitsSourceContext {
  return {
    provider: "anthropic",
    accountId: "acc-1",
    accountLabel: "火山",
    token: "sk-relay",
    baseUrl: "https://ark.cn-beijing.volces.com/api/coding",
    providerKey: "volcengine-agentplan",
    presetHeaders: {
      "X-Cognia-Volc-Access-Key-Id": "AKID",
      "x-cognia-volc-secret-access-key": "SECRET",
    },
    authedGet: async () => "",
    now: 1_000_000,
    ...over,
  }
}

function okResult(over: Partial<VolcengineUsageResult> = {}): VolcengineUsageResult {
  return {
    ok: true,
    plan: "Agent Plan Pro",
    auth_error: false,
    tiers: [
      { name: "session", utilization: 40, resets_at: "2026-01-01T05:00:00.000Z" },
      { name: "weekly", utilization: 12, resets_at: "2026-01-08T00:00:00.000Z" },
      { name: "monthly", utilization: 3, resets_at: null },
    ],
    ...over,
  }
}

describe("volcengineLimitsSource", () => {
  it("matches the agentplan providerKey and volces.com hosts only", () => {
    const s = createVolcengineLimitsSource()
    expect(s.matches({ providerKey: "volcengine-agentplan" })).toBe(true)
    expect(s.matches({ baseUrl: "https://ark.cn-beijing.volces.com/api/coding" })).toBe(true)
    expect(s.matches({ provider: "anthropic", baseUrl: "https://api.anthropic.com" })).toBe(false)
    expect(s.matches({ providerKey: "glm-anthropic" })).toBe(false)
  })

  it("returns null when AK/SK are not configured (quota simply unavailable)", async () => {
    const query = jest.fn()
    const s = createVolcengineLimitsSource({ query })
    const snap = await s.fetch(ctx({ presetHeaders: {} }))
    expect(snap).toBeNull()
    expect(query).not.toHaveBeenCalled()
  })

  it("reads AK/SK case-insensitively and maps tiers to window meters", async () => {
    let seenAk = ""
    let seenSk = ""
    const s = createVolcengineLimitsSource({
      query: async (ak, sk) => {
        seenAk = ak
        seenSk = sk
        return okResult()
      },
    })
    const snap = await s.fetch(ctx())
    expect(seenAk).toBe("AKID")
    expect(seenSk).toBe("SECRET")
    expect(snap?.provider).toBe("volcengine")
    expect(snap?.meters.map((m) => m.id)).toEqual(["session", "weekly", "monthly"])
    expect(snap?.meters[0]).toMatchObject({ usedPct: 40, kind: "window" })
    expect(snap?.meters[0].resetAt).toBe(Date.parse("2026-01-01T05:00:00.000Z"))
    expect(snap?.meters[2].resetAt).toBeNull()
  })

  it("surfaces an auth failure inline", async () => {
    const s = createVolcengineLimitsSource({
      query: async () => ({ ok: false, auth_error: true, tiers: [], error: "bad AK/SK" }),
    })
    const snap = await s.fetch(ctx())
    expect(snap?.error).toContain("bad AK/SK")
    expect(snap?.meters).toHaveLength(0)
  })

  it("returns null on a non-auth soft error (no subscription)", async () => {
    const s = createVolcengineLimitsSource({
      query: async () => ({ ok: false, auth_error: false, tiers: [], error: "no subscription" }),
    })
    expect(await s.fetch(ctx())).toBeNull()
  })

  it("returns an error snapshot when the query throws (transient)", async () => {
    const s = createVolcengineLimitsSource({
      query: async () => {
        throw new Error("network")
      },
    })
    const snap = await s.fetch(ctx())
    expect(snap?.error).toContain("network")
  })

  it("returns null when ok but no tiers", async () => {
    const s = createVolcengineLimitsSource({
      query: async () => okResult({ tiers: [] }),
    })
    expect(await s.fetch(ctx())).toBeNull()
  })

  it("returns null when the baseUrl is missing", async () => {
    const query = jest.fn()
    const s = createVolcengineLimitsSource({ query })
    expect(await s.fetch(ctx({ baseUrl: undefined }))).toBeNull()
    expect(query).not.toHaveBeenCalled()
  })

  it("treats an empty AK value as unconfigured (and a SK-only preset)", async () => {
    const query = jest.fn()
    const s = createVolcengineLimitsSource({ query })
    // AK present but blank → not usable.
    expect(
      await s.fetch(
        ctx({ presetHeaders: { "x-cognia-volc-ak": "   ", "x-cognia-volc-sk": "SECRET" } })
      )
    ).toBeNull()
    // SK missing entirely.
    expect(await s.fetch(ctx({ presetHeaders: { "x-cognia-volc-ak": "AKID" } }))).toBeNull()
    expect(query).not.toHaveBeenCalled()
  })

  it("falls back to the session label for an unrecognized tier name", async () => {
    const s = createVolcengineLimitsSource({
      query: async () => okResult({ tiers: [{ name: "daily", utilization: 5, resets_at: null }] }),
    })
    const snap = await s.fetch(ctx())
    expect(snap?.meters[0]).toMatchObject({
      id: "daily",
      labelKey: "subscription.limits.meter.session",
    })
  })
})

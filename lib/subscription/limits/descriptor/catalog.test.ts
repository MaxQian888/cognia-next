import { moonshotBalanceAdapter } from "@/lib/subscription/balance/adapters/moonshot"

import { BUILTIN_DESCRIPTORS, CATALOG_SOURCES } from "./catalog"
import { descriptorToSource } from "./engine"
import { balanceMeter } from "../meters"

import type { LimitsSourceContext, SourceDescriptor } from "@/types/subscription"

function ctx(over: Partial<LimitsSourceContext> = {}): LimitsSourceContext {
  return {
    provider: "opencode",
    accountId: "acc-1",
    accountLabel: "StepFun",
    token: "sk-step",
    baseUrl: "https://api.stepfun.com/v1",
    providerKey: "stepfun",
    authedGet: async () => "{}",
    now: 1_000_000,
    ...over,
  }
}

describe("BUILTIN_DESCRIPTORS", () => {
  it("exposes one source per descriptor with matching keys and unique ids", () => {
    expect(CATALOG_SOURCES).toHaveLength(BUILTIN_DESCRIPTORS.length)
    const ids = BUILTIN_DESCRIPTORS.map((d) => d.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(CATALOG_SOURCES.map((s) => s.key)).toEqual(ids)
  })
})

describe("stepfun descriptor", () => {
  const stepfun = CATALOG_SOURCES.find((s) => s.key === "stepfun")!

  it("matches by providerKey and by host, and yields a CNY credit meter", async () => {
    expect(stepfun.matches({ providerKey: "stepfun" })).toBe(true)
    expect(stepfun.matches({ providerKey: "stepfun-anthropic" })).toBe(true)
    expect(stepfun.matches({ baseUrl: "https://api.stepfun.com/v1" })).toBe(true)
    expect(stepfun.matches({ providerKey: "deepseek" })).toBe(false)

    const snap = await stepfun.fetch(
      ctx({
        authedGet: async (url) => {
          expect(url).toBe("https://api.stepfun.com/v1/accounts")
          return JSON.stringify({ balance: "42.5" }) // string-or-number tolerated
        },
      })
    )
    expect(snap?.provider).toBe("stepfun")
    expect(snap?.meters[0]).toMatchObject({ kind: "balance", remaining: 42.5, unit: "CNY" })
  })

  it("anchors /v1/accounts at the origin for a /step_plan relay preset baseUrl", async () => {
    let seenUrl = ""
    await stepfun.fetch(
      ctx({
        providerKey: "stepfun-anthropic",
        baseUrl: "https://api.stepfun.com/step_plan",
        authedGet: async (url) => {
          seenUrl = url
          return JSON.stringify({ balance: 1 })
        },
      })
    )
    expect(seenUrl).toBe("https://api.stepfun.com/v1/accounts")
  })
})

describe("glm (Zhipu Coding Plan) descriptor", () => {
  const glm = CATALOG_SOURCES.find((s) => s.key === "glm")!

  it("matches by providerKey and host", () => {
    expect(glm.matches({ providerKey: "glm" })).toBe(true)
    expect(glm.matches({ baseUrl: "https://api.z.ai/api" })).toBe(true)
    expect(glm.matches({ providerKey: "minimax" })).toBe(false)
    // New anthropic-relay providerKeys + the CN bigmodel.cn host both match.
    expect(glm.matches({ providerKey: "glm-anthropic" })).toBe(true)
    expect(glm.matches({ providerKey: "glm-anthropic-intl" })).toBe(true)
    expect(glm.matches({ baseUrl: "https://open.bigmodel.cn/api/anthropic" })).toBe(true)
  })

  it("anchors the quota URL at the host origin for a CN relay preset baseUrl", async () => {
    let seenUrl = ""
    await glm.fetch(
      ctx({
        token: "raw-glm-key",
        providerKey: "glm-anthropic",
        // Relay preset baseUrl carries the /api/anthropic path — the quota
        // endpoint must anchor at the bigmodel.cn origin, not double the path.
        baseUrl: "https://open.bigmodel.cn/api/anthropic",
        authedGet: async (url) => {
          seenUrl = url
          return JSON.stringify({ data: { limits: [{ unit: 3, percentage: 10 }] } })
        },
      })
    )
    expect(seenUrl).toBe("https://open.bigmodel.cn/api/monitor/usage/quota/limit")
  })

  it("sends a raw-key Authorization (no Bearer) and maps both tiers", async () => {
    let seenUrl = ""
    let seenHeaders: Record<string, string> | undefined
    const snap = await glm.fetch(
      ctx({
        token: "raw-glm-key",
        providerKey: "glm",
        baseUrl: "https://api.z.ai",
        authedGet: async (url, headers) => {
          seenUrl = url
          seenHeaders = headers
          // data.limits[] is discriminated by a numeric `unit` (3=5h, 6=weekly),
          // not a `TOKENS_LIMIT` string — verified against cc-switch coding_plan.rs.
          return JSON.stringify({
            data: {
              limits: [
                { unit: 3, percentage: 75.4, nextResetTime: 3000 },
                { unit: 6, percentage: 40, nextResetTime: 9000 },
              ],
            },
          })
        },
      })
    )
    expect(seenUrl).toBe("https://api.z.ai/api/monitor/usage/quota/limit")
    expect(seenHeaders?.Authorization).toBe("raw-glm-key") // raw key, no Bearer scheme
    expect(snap?.meters.map((m) => m.id)).toEqual(["session", "weekly"])
    expect(snap?.meters[0]).toMatchObject({ usedPct: 75, resetAt: 3_000_000 })
    expect(snap?.meters[1]).toMatchObject({ usedPct: 40, resetAt: 9_000_000 })
  })
})

describe("minimax (Coding Plan) descriptor", () => {
  const minimax = CATALOG_SOURCES.find((s) => s.key === "minimax")!

  it("matches by providerKey and host", () => {
    expect(minimax.matches({ providerKey: "minimax" })).toBe(true)
    expect(minimax.matches({ baseUrl: "https://api.minimaxi.com" })).toBe(true)
  })

  it("derives interval + weekly utilization from remaining-percent on the general model", async () => {
    let seenUrl = ""
    const snap = await minimax.fetch(
      ctx({
        providerKey: "minimax",
        baseUrl: "https://api.minimaxi.com",
        authedGet: async (url) => {
          seenUrl = url
          // Token Plan endpoint: model_remains[] keyed by model_name, each
          // carrying *remaining* percents (engine inverts to used%). The legacy
          // coding_plan/remains path returns 1004 "cookie missing" for API keys.
          return JSON.stringify({
            model_remains: [
              {
                model_name: "general",
                current_interval_remaining_percent: 67,
                end_time: 2000,
                current_weekly_remaining_percent: 80,
                weekly_end_time: 9000,
              },
            ],
          })
        },
      })
    )
    expect(seenUrl).toBe("https://api.minimaxi.com/v1/token_plan/remains")
    expect(snap?.meters.map((m) => m.id)).toEqual(["session", "weekly"])
    expect(snap?.meters[0]).toMatchObject({ usedPct: 33, resetAt: 2_000_000 }) // 100-67=33
    expect(snap?.meters[1]).toMatchObject({ usedPct: 20, resetAt: 9_000_000 }) // 100-80=20
  })
})

describe("kimi-coding (Coding Plan) descriptor", () => {
  const kimi = CATALOG_SOURCES.find((s) => s.key === "kimi-coding")!

  it("matches by providerKey and host, distinct from moonshot balance host", () => {
    expect(kimi.matches({ providerKey: "kimi-coding" })).toBe(true)
    expect(kimi.matches({ baseUrl: "https://api.kimi.com" })).toBe(true)
    // Moonshot inference balance lives at api.moonshot.cn — must NOT match here.
    expect(kimi.matches({ baseUrl: "https://api.moonshot.cn/v1" })).toBe(false)
  })

  it("derives the 5h aggregate from remaining/total", async () => {
    let seenUrl = ""
    const snap = await kimi.fetch(
      ctx({
        providerKey: "kimi-coding",
        baseUrl: "https://api.kimi.com",
        authedGet: async (url) => {
          seenUrl = url
          return JSON.stringify({ usage: { limit: 1000, remaining: 250, resetTime: 3000 } })
        },
      })
    )
    expect(seenUrl).toBe("https://api.kimi.com/coding/v1/usages")
    expect(snap?.meters.map((m) => m.id)).toEqual(["session"])
    // 1 - 250/1000 = 75%
    expect(snap?.meters[0]).toMatchObject({ usedPct: 75, resetAt: 3_000_000 })
  })

  it("does not double the /coding segment for the relay preset baseUrl", async () => {
    let seenUrl = ""
    await kimi.fetch(
      ctx({
        providerKey: "kimi-coding",
        // The relay preset baseUrl ends in /coding/ — origin-anchoring avoids
        // the previous `/coding/coding/v1/usages` bug.
        baseUrl: "https://api.kimi.com/coding/",
        authedGet: async (url) => {
          seenUrl = url
          return JSON.stringify({ usage: { limit: 10, remaining: 5, resetTime: 1 } })
        },
      })
    )
    expect(seenUrl).toBe("https://api.kimi.com/coding/v1/usages")
  })
})

describe("engine parity with a live balance adapter", () => {
  // Proves the declarative engine reproduces a hand-written adapter's meter, so
  // re-expressing existing providers as data is sound (we don't register this to
  // avoid double-matching the live moonshot adapter at runtime).
  it("a moonshot-shaped descriptor matches the live moonshot adapter's meter", async () => {
    const body = JSON.stringify({ data: { available_balance: 12.34 } })

    const live = moonshotBalanceAdapter.parse(200, body, {
      accountId: "acc-1",
      providerKey: "moonshot",
      baseUrl: "https://api.moonshot.cn/v1",
      token: "t",
    })
    const liveMeter = balanceMeter(live)

    const descriptor: SourceDescriptor = {
      id: "moonshot",
      match: { providerKey: "moonshot" },
      request: { path: "/users/me/balance" },
      extract: {
        kind: "balance",
        remainingPath: "data.available_balance",
        unit: "CNY",
        currency: "CNY",
      },
    }
    const snap = await descriptorToSource(descriptor).fetch(
      ctx({
        providerKey: "moonshot",
        baseUrl: "https://api.moonshot.cn/v1",
        authedGet: async () => body,
      })
    )
    const descMeter = snap!.meters[0]

    expect(descMeter.kind).toBe(liveMeter.kind)
    expect(descMeter.remaining).toBe(liveMeter.remaining)
    expect(descMeter.unit).toBe(liveMeter.unit)
    expect(descMeter.currency).toBe(liveMeter.currency)
    expect(descMeter.status).toBe(liveMeter.status)
  })
})

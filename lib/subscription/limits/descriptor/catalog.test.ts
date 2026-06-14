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
})

describe("glm (Zhipu Coding Plan) descriptor", () => {
  const glm = CATALOG_SOURCES.find((s) => s.key === "glm")!

  it("matches by providerKey and host", () => {
    expect(glm.matches({ providerKey: "glm" })).toBe(true)
    expect(glm.matches({ baseUrl: "https://api.z.ai/api" })).toBe(true)
    expect(glm.matches({ providerKey: "minimax" })).toBe(false)
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
          return JSON.stringify({
            data: {
              limits: [
                { TOKENS_LIMIT: "five_hour", percentage: 75.4, nextResetTime: 3000 },
                { TOKENS_LIMIT: "weekly", percentage: 40, nextResetTime: 9000 },
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

  it("derives interval + weekly utilization from counts", async () => {
    let seenUrl = ""
    const snap = await minimax.fetch(
      ctx({
        providerKey: "minimax",
        baseUrl: "https://api.minimaxi.com",
        authedGet: async (url) => {
          seenUrl = url
          return JSON.stringify({
            model_remains: [
              {
                current_interval_usage_count: 100,
                current_interval_total_count: 300,
                end_time: 2000,
                current_weekly_usage_count: 1000,
                current_weekly_total_count: 5000,
                weekly_end_time: 9000,
              },
            ],
          })
        },
      })
    )
    expect(seenUrl).toBe("https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains")
    expect(snap?.meters.map((m) => m.id)).toEqual(["session", "weekly"])
    expect(snap?.meters[0]).toMatchObject({ usedPct: 33, resetAt: 2_000_000 }) // 100/300≈33
    expect(snap?.meters[1]).toMatchObject({ usedPct: 20, resetAt: 9_000_000 }) // 1000/5000=20
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

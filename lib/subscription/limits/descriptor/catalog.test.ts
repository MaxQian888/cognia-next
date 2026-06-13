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

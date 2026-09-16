import {
  DEVIN_API_BASE,
  devinLimitsSource,
  devinPlanStatusMeters,
  parseDevinUserStatus,
  type DevinPlanStatus,
} from "./devin"

import type { LimitsSourceContext } from "@/types/subscription"

const NOW = 1_800_000_000_000

function ctx(over: Partial<LimitsSourceContext> = {}): LimitsSourceContext {
  return {
    provider: "devin",
    accountId: "devin",
    accountLabel: "devin",
    token: "wk-test-key",
    baseUrl: DEVIN_API_BASE,
    providerKey: "devin",
    authedGet: async () => "",
    authedRequest: async () => ({ status: 200, body: "{}" }),
    now: NOW,
    ...over,
  }
}

function userStatusBody(planStatus: DevinPlanStatus | null, extra: object = {}): string {
  return JSON.stringify({
    userStatus: {
      email: "fan@example.com",
      teamsTier: "TEAMS_TIER_DEVIN_PRO",
      planStatus,
      ...extra,
    },
  })
}

describe("devinLimitsSource.matches", () => {
  it("matches provider/providerKey devin and codeium hosts only", () => {
    expect(devinLimitsSource.matches({ provider: "devin" })).toBe(true)
    expect(devinLimitsSource.matches({ providerKey: "devin" })).toBe(true)
    expect(devinLimitsSource.matches({ baseUrl: "https://server.codeium.com" })).toBe(true)
    expect(
      devinLimitsSource.matches({ provider: "anthropic", baseUrl: "https://api.anthropic.com" })
    ).toBe(false)
    expect(devinLimitsSource.matches({ providerKey: "glm-anthropic" })).toBe(false)
  })
})

describe("devinLimitsSource.fetch", () => {
  it("declines without a token or an authedRequest seam", async () => {
    const call = jest.fn(async () => ({ status: 200, body: "{}" }))
    expect(await devinLimitsSource.fetch(ctx({ token: null, authedRequest: call }))).toBeNull()
    expect(await devinLimitsSource.fetch(ctx({ authedRequest: undefined }))).toBeNull()
    expect(call).not.toHaveBeenCalled()
  })

  it("POSTs the full five-field metadata envelope to the seat-management path", async () => {
    let seen: {
      url: string
      method?: string
      headers?: Record<string, string>
      body?: string
    } | null = null
    const authedRequest = jest.fn(
      async (req: {
        url: string
        method?: string
        headers?: Record<string, string>
        body?: string
      }) => {
        seen = req
        return { status: 200, body: userStatusBody({ weeklyQuotaRemainingPercent: 48 }) }
      }
    )
    await devinLimitsSource.fetch(ctx({ authedRequest, token: "wk-secret" }))
    expect(seen!.url).toBe(
      `${DEVIN_API_BASE}/exa.seat_management_pb.SeatManagementService/GetUserStatus`
    )
    expect(seen!.method).toBe("POST")
    expect(seen!.headers?.["Content-Type"]).toBe("application/json")
    const meta = JSON.parse(seen!.body!).metadata
    expect(meta).toMatchObject({
      apiKey: "wk-secret",
      ideName: expect.any(String),
      ideVersion: expect.any(String),
      extensionName: expect.any(String),
      extensionVersion: expect.any(String),
    })
  })

  it("honors a configured baseUrl (trailing slash trimmed)", async () => {
    let url = ""
    const authedRequest = jest.fn(async (req: { url: string }) => {
      url = req.url
      return { status: 200, body: userStatusBody({}) }
    })
    await devinLimitsSource.fetch(ctx({ authedRequest, baseUrl: "https://mirror.codeium.com/" }))
    expect(url).toBe(
      "https://mirror.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus"
    )
  })

  it("returns an error snapshot on non-2xx", async () => {
    const authedRequest = async () => ({ status: 401, body: '{"code":"unauthenticated"}' })
    const snap = await devinLimitsSource.fetch(ctx({ authedRequest }))
    expect(snap?.provider).toBe("devin")
    expect(snap?.meters).toHaveLength(0)
    expect(snap?.error).toContain("401")
    expect(snap?.error).toContain("unauthenticated")
  })

  it("returns an error snapshot when the transport throws", async () => {
    const authedRequest = async () => {
      throw new Error("socket hangup")
    }
    const snap = await devinLimitsSource.fetch(ctx({ authedRequest }))
    expect(snap?.error).toContain("socket hangup")
  })

  it("returns null on malformed JSON and on a response without planStatus", async () => {
    const bad = async () => ({ status: 200, body: "not json" })
    expect(await devinLimitsSource.fetch(ctx({ authedRequest: bad }))).toBeNull()
    const noPlan = async () => ({
      status: 200,
      body: JSON.stringify({ userStatus: { email: "a@b.c" } }),
    })
    expect(await devinLimitsSource.fetch(ctx({ authedRequest: noPlan }))).toBeNull()
  })
})

describe("devinPlanStatusMeters", () => {
  it("inverts weekly remaining% into used% and converts unix-second resets", () => {
    const meters = devinPlanStatusMeters({
      weeklyQuotaRemainingPercent: 48,
      weeklyQuotaResetAtUnix: "1789891200",
    })
    expect(meters).toHaveLength(1)
    expect(meters[0]).toMatchObject({
      id: "devin/weekly",
      labelKey: "subscription.limits.meter.weekly",
      label: "Weekly quota",
      kind: "window",
      usedPct: 52,
      resetAt: 1789891200000,
      status: "ok",
    })
  })

  it("maps the daily window when reported, skips it when hideDailyQuota", () => {
    const meters = devinPlanStatusMeters({
      dailyQuotaRemainingPercent: 10,
      dailyQuotaResetAtUnix: 1789459200,
    })
    expect(meters[0]).toMatchObject({ id: "devin/daily", usedPct: 90, status: "warn" })
    const hidden = devinPlanStatusMeters({
      dailyQuotaRemainingPercent: 10,
      planInfo: { hideDailyQuota: true },
    })
    expect(hidden.find((m) => m.id === "devin/daily")).toBeUndefined()
  })

  it("clamps an out-of-range remaining percent", () => {
    const meters = devinPlanStatusMeters({ weeklyQuotaRemainingPercent: 140 })
    expect(meters[0].usedPct).toBe(0)
  })

  it("maps ACU consumption to a window resetting at plan end", () => {
    const meters = devinPlanStatusMeters({
      acuConsumed: 120,
      acuLimit: 400,
      planEnd: "2026-10-11T08:39:36Z",
    })
    expect(meters[0]).toMatchObject({
      id: "devin/acu",
      usedPct: 30,
      resetAt: Date.parse("2026-10-11T08:39:36Z"),
    })
  })

  it("skips ACU when the limit is missing or zero", () => {
    expect(devinPlanStatusMeters({ acuConsumed: 5 })).toHaveLength(0)
    expect(devinPlanStatusMeters({ acuConsumed: 5, acuLimit: 0 })).toHaveLength(0)
  })

  it("converts overageBalanceMicros to a USD balance", () => {
    const meters = devinPlanStatusMeters({ overageBalanceMicros: 12_500_000 })
    expect(meters[0]).toMatchObject({
      id: "devin/overage",
      kind: "balance",
      remaining: 12.5,
      currency: "USD",
      status: "ok",
    })
  })

  it("treats -1 available credits as unlimited, never as a balance", () => {
    const meters = devinPlanStatusMeters({ availablePromptCredits: -1 })
    expect(meters[0]).toMatchObject({
      id: "devin/promptCredits",
      kind: "balance",
      status: "ok",
      label: "Prompt credits (unlimited)",
    })
    expect(meters[0].remaining).toBeUndefined()
  })

  it("maps finite credit balances with usage", () => {
    const meters = devinPlanStatusMeters({
      availableFlowCredits: 40,
      usedFlowCredits: 60,
      availableFlexCredits: 0,
    })
    expect(meters.map((m) => m.id)).toEqual(["devin/flowCredits", "devin/flexCredits"])
    expect(meters[0]).toMatchObject({ remaining: 40, used: 60, status: "ok" })
    expect(meters[1].status).toBe("exceeded")
  })

  it("emits a top-up balance only when enabled with a known cap", () => {
    const off = devinPlanStatusMeters({
      topUpStatus: { topUpEnabled: false, monthlyTopUpAmount: 50_000_000 },
    })
    expect(off.find((m) => m.id === "devin/topUp")).toBeUndefined()
    const on = devinPlanStatusMeters({
      topUpStatus: {
        topUpEnabled: true,
        monthlyTopUpAmount: 50_000_000,
        topUpSpent: 10_000_000,
      },
    })
    expect(on[0]).toMatchObject({
      id: "devin/topUp",
      kind: "balance",
      total: 50,
      used: 10,
      usedPct: 20,
      currency: "USD",
    })
  })
})

describe("parseDevinUserStatus", () => {
  const ctxArgs = { accountId: "devin", accountLabel: "devin", now: NOW }

  it("builds the account label from email + plan name", () => {
    const snap = parseDevinUserStatus(
      userStatusBody({ weeklyQuotaRemainingPercent: 48, planInfo: { planName: "Pro" } }),
      ctxArgs
    )
    expect(snap?.accountLabel).toBe("Devin · fan@example.com · Pro")
    expect(snap?.provider).toBe("devin")
    expect(snap?.fetchedAt).toBe(NOW)
  })

  it("falls back to the ctx label when the response carries no identity", () => {
    const snap = parseDevinUserStatus(
      JSON.stringify({ userStatus: { planStatus: { weeklyQuotaRemainingPercent: 48 } } }),
      ctxArgs
    )
    expect(snap?.accountLabel).toBe("devin")
  })

  it("attaches the vendor requestUsageAction notice only when a meter is tight", () => {
    const relaxed = parseDevinUserStatus(
      userStatusBody({
        weeklyQuotaRemainingPercent: 80,
        planInfo: { devinInfo: { requestUsageAction: { label: "Ask your account admin" } } },
      }),
      ctxArgs
    )
    expect(relaxed?.notice).toBeUndefined()
    const tight = parseDevinUserStatus(
      userStatusBody({
        weeklyQuotaRemainingPercent: 4,
        planInfo: {
          devinInfo: {
            requestUsageAction: { label: "Ask your account admin", url: "https://app.devin.ai/x" },
          },
        },
      }),
      ctxArgs
    )
    expect(tight?.notice).toBe("Ask your account admin https://app.devin.ai/x")
  })
})

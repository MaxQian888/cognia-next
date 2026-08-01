/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { __resetDbForTesting, getDb } from "@/lib/db/schema"

import {
  crossedLowBalanceThreshold,
  projectLegacyProviderBalanceRows,
  refreshProviderBalanceSources,
  resolveProviderBalanceSource,
  resolveSandboxBalanceSource,
  selectPrimaryBalanceSource,
} from "./balance"

describe("provider diagnostic balance sources", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    await getDb().open()
  })

  afterEach(() => __resetDbForTesting())

  it("defaults to an official account source and never combines native units", () => {
    const sources = selectPrimaryBalanceSource(
      [
        {
          id: "api-key",
          providerId: "deepseek",
          kind: "official",
          label: "API key",
          primary: false,
          enabled: true,
          credentialFingerprint: "credential:deepseek:primary",
        },
        {
          id: "oauth-account",
          providerId: "deepseek",
          accountId: "account-1",
          kind: "official",
          label: "Official account",
          primary: false,
          enabled: true,
          credentialFingerprint: "credential:subscription:account-1",
        },
      ],
      undefined
    )

    expect(sources.map((source) => [source.id, source.primary])).toEqual([
      ["api-key", false],
      ["oauth-account", true],
    ])
  })

  it("uses the typed status and persists a native-currency snapshot", async () => {
    const source = resolveProviderBalanceSource({
      providerId: "stepfun",
      providerKey: "stepfun",
      baseUrl: "https://api.stepfun.com/v1",
      token: "secret",
      credentialId: "primary",
      label: "StepFun API key",
    })
    const authedRequest = jest.fn(async () => ({
      status: 200,
      headers: [],
      body: JSON.stringify({ balance: "12.5", total_cash_balance: 10, total_voucher_balance: 5 }),
    }))

    const [snapshot] = await refreshProviderBalanceSources([source], {
      authedRequest,
      now: () => 1_000,
      randomUUID: () => "balance-1",
    })

    expect(authedRequest).toHaveBeenCalledWith(
      expect.objectContaining({ method: "GET", url: "https://api.stepfun.com/v1/accounts" })
    )
    expect(snapshot.amounts).toEqual([{ unit: "CNY", remaining: 12.5, total: 15 }])
    expect(await getDb().providerBalanceSnapshots.get("balance-1")).toEqual(snapshot)
  })

  it("keeps the last successful reading stale when authentication later fails", async () => {
    const source = resolveProviderBalanceSource({
      providerId: "stepfun",
      providerKey: "stepfun",
      baseUrl: "https://api.stepfun.com/v1",
      token: "secret",
      credentialId: "primary",
      label: "StepFun API key",
    })
    await refreshProviderBalanceSources([source], {
      authedRequest: async () => ({ status: 200, headers: [], body: '{"balance":8}' }),
      now: () => 1_000,
      randomUUID: () => "success",
    })
    const [stale] = await refreshProviderBalanceSources([source], {
      authedRequest: async () => ({ status: 401, headers: [], body: '{"error":"bad key"}' }),
      now: () => 2_000,
      randomUUID: () => "failure",
    })

    expect(stale.amounts).toEqual([{ unit: "CNY", remaining: 8 }])
    expect(stale.failure).toEqual(
      expect.objectContaining({ code: "authentication", httpStatus: 401 })
    )
    expect(stale.staleAt).toBe(1_000)
  })

  it("marks undocumented providers as actionable unverified sources without making a request", async () => {
    const source = resolveProviderBalanceSource({
      providerId: "groq",
      providerKey: "groq",
      baseUrl: "https://api.groq.com/openai/v1",
      token: "secret",
      label: "Groq",
    })
    const authedRequest = jest.fn()
    const [snapshot] = await refreshProviderBalanceSources([source], {
      authedRequest,
      now: () => 1_000,
      randomUUID: () => "unsupported",
    })

    expect(source.kind).toBe("unsupported")
    expect(snapshot.failure?.code).toBe("capability-unsupported")
    expect(authedRequest).not.toHaveBeenCalled()
  })

  it("projects legacy balance and quota rows without combining accounts or units", () => {
    const projected = projectLegacyProviderBalanceRows({
      providerId: "anthropic",
      balances: [
        {
          localId: 1,
          providerKey: "anthropic",
          accountId: "account-a",
          kind: "credit",
          currency: "USD",
          remaining: 4,
          fetchedAt: 100,
          raw: {},
        },
      ],
      limits: [
        {
          localId: 2,
          provider: "anthropic",
          accountId: "account-b",
          fetchedAt: 200,
          meters: [{ id: "weekly", kind: "window", usedPct: 25, status: "ok" }],
        },
      ],
    })

    expect(projected.sources).toHaveLength(2)
    expect(projected.snapshots.map((snapshot) => snapshot.amounts[0].unit)).toEqual([
      "weekly",
      "USD",
    ])
    expect(projected.snapshots.map((snapshot) => snapshot.accountId)).toEqual([
      "account-b",
      "account-a",
    ])
  })

  it("fires low-balance notifications only on a threshold transition", () => {
    expect(crossedLowBalanceThreshold({ previous: 11, current: 10, threshold: 10 })).toBe(true)
    expect(crossedLowBalanceThreshold({ previous: 9, current: 8, threshold: 10 })).toBe(false)
    expect(crossedLowBalanceThreshold({ previous: 8, current: 12, threshold: 10 })).toBe(false)
  })

  it("runs sandbox sources through the native policy boundary", async () => {
    const source = resolveSandboxBalanceSource({
      id: "script-1",
      providerId: "custom",
      label: "Custom balance",
      script: "safe script",
      sameOrigin: "https://api.example.com",
      credentialRef: "script-1",
      grants: [],
      enabled: true,
    })
    const runBalanceScript = jest.fn(async () => ({
      sourceId: "script-1",
      amounts: [{ unit: "credits", remaining: 2 }],
      available: true,
      requestCount: 1,
    }))
    const [snapshot] = await refreshProviderBalanceSources([source], {
      runBalanceScript,
      now: () => 1_000,
      randomUUID: () => "script-snapshot",
    })

    expect(runBalanceScript).toHaveBeenCalledWith(
      source.scriptConfig,
      expect.objectContaining({ providerId: "custom" })
    )
    expect(snapshot.amounts).toEqual([{ unit: "credits", remaining: 2 }])
  })
})

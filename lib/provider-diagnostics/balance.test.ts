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

  it("projects account-scoped relay readings by their original source identity", () => {
    const row = {
      provider: "codex",
      sourceId: "moonshot",
      accountId: "relay-account",
      fetchedAt: 200,
      meters: [
        {
          id: "credit",
          kind: "balance" as const,
          usedPct: null,
          remaining: 12,
          unit: "CNY",
          status: "ok" as const,
        },
      ],
    }
    const projected = projectLegacyProviderBalanceRows({
      providerId: "moonshot",
      balances: [],
      limits: [row],
    })
    expect(projected.snapshots).toHaveLength(1)
    expect(projected.snapshots[0]).toMatchObject({
      providerId: "moonshot",
      accountId: "relay-account",
      amounts: [{ unit: "CNY", remaining: 12 }],
    })
    expect(
      projectLegacyProviderBalanceRows({ providerId: "codex", balances: [], limits: [row] })
        .snapshots
    ).toEqual([])
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

  it.each([
    [403, "permission"],
    [429, "rate-limited"],
    [503, "transport"],
    [404, "invalid-response"],
    [200, "schema"],
  ])(
    "preserves HTTP %s failure semantics without accepting an unreadable balance",
    async (status, code) => {
      const source = resolveProviderBalanceSource({
        providerId: "stepfun",
        baseUrl: "https://api.stepfun.com/v1",
        token: "test",
        label: "StepFun",
      })
      const [result] = await refreshProviderBalanceSources([source], {
        authedRequest: async () => ({
          status: status as number,
          headers: [{ name: "retry-after", value: "15" }],
          body: "{}",
        }),
      })
      expect(result.failure?.code).toBe(code)
      expect(result.amounts).toEqual([])
      if (status === 429) expect(result.failure?.retryAfterMs).toBe(15_000)
    }
  )

  it.each([undefined, "invalid", "2099-01-01T00:00:00Z"])(
    "handles retry-after %s without inventing a delay",
    async (value) => {
      const source = resolveProviderBalanceSource({
        providerId: "stepfun",
        baseUrl: "https://api.stepfun.com",
        token: "test",
        label: "StepFun",
      })
      const [result] = await refreshProviderBalanceSources([source], {
        authedRequest: async () => ({
          status: 429,
          headers: value ? [{ name: "Retry-After", value }] : [],
          body: "{}",
        }),
      })
      expect(result.failure?.code).toBe("rate-limited")
      if (value?.startsWith("2099")) expect(result.failure?.retryAfterMs).toBeGreaterThan(0)
      else expect(result.failure?.retryAfterMs).toBeUndefined()
    }
  )

  it.each([new Error("request cancelled"), "network down"])(
    "persists transport failure %s",
    async (error) => {
      const source = resolveProviderBalanceSource({
        providerId: "stepfun",
        baseUrl: "https://api.stepfun.com",
        token: "test",
        label: "StepFun",
      })
      const [result] = await refreshProviderBalanceSources([source], {
        authedRequest: async () => {
          throw error
        },
      })
      expect(result.failure?.code).toBe(error instanceof Error ? "aborted" : "transport")
      expect(result.failure?.message).toBe(error instanceof Error ? error.message : error)
    }
  )

  it.each([new Error("domain grant missing"), "invalid output"])(
    "preserves sandbox rejection %s",
    async (error) => {
      const source = resolveSandboxBalanceSource({
        id: "script",
        providerId: "custom",
        label: "Custom",
        script: "script",
        sameOrigin: "https://example.com",
        credentialRef: "script",
        grants: [],
        enabled: true,
      })
      const [result] = await refreshProviderBalanceSources([source], {
        runBalanceScript: async () => {
          throw error
        },
      })
      expect(result.failure?.code).toBe(error instanceof Error ? "script-policy" : "schema")
      expect(result.amounts).toEqual([])
    }
  )

  it("honors an explicit primary source and falls back to enabled sources without combining them", () => {
    const official = resolveProviderBalanceSource({
      providerId: "stepfun",
      baseUrl: "https://api.stepfun.com",
      label: "StepFun",
    })
    const custom = resolveSandboxBalanceSource({
      id: "custom",
      providerId: "custom",
      label: "Custom",
      script: "script",
      sameOrigin: "https://example.com",
      credentialRef: "custom",
      grants: [],
      enabled: true,
    })
    expect(selectPrimaryBalanceSource([official, custom], custom.id).map((s) => s.primary)).toEqual(
      [false, true]
    )
    expect(selectPrimaryBalanceSource([official, custom]).map((s) => s.primary)).toEqual([
      true,
      false,
    ])
    expect(selectPrimaryBalanceSource([custom])[0].primary).toBe(true)
    expect(selectPrimaryBalanceSource([])).toEqual([])
  })

  it("projects unavailable balances and legacy error readings without manufacturing zero usage", () => {
    const projected = projectLegacyProviderBalanceRows({
      providerId: "stepfun",
      balances: [
        { providerKey: "other", accountId: "other", kind: "credit", fetchedAt: 1, raw: {} },
        {
          providerKey: "stepfun",
          accountId: "balance",
          kind: "credit",
          fetchedAt: 2,
          raw: {},
          error: "offline",
        },
      ],
      limits: [
        { provider: "stepfun", fetchedAt: 1, meters: [] },
        {
          provider: "stepfun",
          accountId: "quota",
          accountLabel: "Plan",
          fetchedAt: 3,
          error: "offline",
          meters: [
            { id: "week", unit: "weekly", kind: "window", usedPct: null, status: "unknown" },
            { id: "credit", kind: "balance", usedPct: null, status: "unknown" },
          ],
        },
      ],
    })
    expect(projected.snapshots).toHaveLength(2)
    expect(projected.snapshots[0].amounts[0]).toMatchObject({
      unit: "weekly",
      remaining: undefined,
      used: undefined,
    })
    expect(projected.snapshots.every((s) => s.failure?.message === "offline")).toBe(true)
  })
})

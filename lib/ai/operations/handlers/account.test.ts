/** @jest-environment node */
const fetchMock = jest.fn()
jest.mock("@/lib/network/proxy-fetch", () => ({
  proxyFetch: (...args: unknown[]) => fetchMock(...args),
}))
jest.mock("@/lib/subscription/balance/registry", () => ({ findBalanceAdapter: jest.fn() }))
const balance = jest.requireMock("@/lib/subscription/balance/registry") as {
  findBalanceAdapter: jest.Mock
}
jest.mock("@/lib/subscription/limits/registry", () => ({ resolveLimitsSources: jest.fn() }))
const limits = jest.requireMock("@/lib/subscription/limits/registry") as {
  resolveLimitsSources: jest.Mock
}
const usageRows: Array<Record<string, unknown>> = []
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    sessionUsage: {
      where: (index: string) => ({
        equals: (value: string) => ({
          and: (predicate: (row: Record<string, unknown>) => boolean) => ({
            toArray: async () => usageRows.filter((row) => row[index] === value && predicate(row)),
          }),
        }),
      }),
    },
  }),
}))
jest.mock("@/lib/usage/session-analytics", () => ({
  aggregateByModel: (rows: Array<{ model?: string; inputTokens: number; outputTokens: number }>) =>
    rows.map((row) => ({
      model: row.model ?? "?",
      turns: 1,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      costUsd: 0.5,
    })),
}))
jest.mock("./http", () => ({ providerRequest: jest.fn() }))
const http = jest.requireMock("./http") as { providerRequest: jest.Mock }

import {
  balanceReadOutput,
  quotaReadOutput,
  rateLimitsReadOutput,
  usageLocalReadOutput,
  usageProviderReadOutput,
  type ProviderOperationId,
} from "@cognia/provider-types"
import type { ResolvedProvider } from "@/lib/ai/provider-consumption"

import { getProviderOperationDescriptor } from "../manifest"
import { ProviderOperationHandlerRegistry } from "../registry"
import {
  ACCOUNT_HANDLERS,
  balanceReadHandler,
  dayOf,
  durationToMs,
  parseRateLimitHeaders,
  quotaOf,
  quotaReadHandler,
  rateLimitsReadHandler,
  registryProviderKey,
  usageLocalReadHandler,
} from "./account"

const provider: ResolvedProvider = {
  kind: "resolved",
  providerId: "deepseek-anthropic",
  protocol: "anthropic",
  apiKey: "sk-secret",
  baseURL: "https://api.deepseek.com/anthropic",
  model: "m",
  isCustomProvider: false,
  useProxy: false,
}
const settings = { defaultProvider: undefined, providers: {}, customProviders: [] }
function ctx<T>(operationId: ProviderOperationId, input: T, resolved = provider) {
  return {
    descriptor: getProviderOperationDescriptor(operationId)!,
    provider: resolved,
    settings,
    request: { operationId, scopes: ["account:read" as const], surface: "sidecar" as const, input },
  }
}

describe("account handlers", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    usageRows.length = 0
  })

  it("strips the wire suffix so relays share the vendor's registry entries", () => {
    expect(registryProviderKey("deepseek-anthropic")).toBe("deepseek")
    expect(registryProviderKey("vendor-anthropic-intl")).toBe("vendor")
    expect(registryProviderKey("openrouter")).toBe("openrouter")
  })

  it("reads a balance through the registry adapter into the contract shape", async () => {
    const adapter = {
      key: "deepseek",
      matches: () => true,
      request: (q: { token: string }) => ({
        url: "https://api.deepseek.com/user/balance",
        headers: { authorization: `Bearer ${q.token}` },
      }),
      parse: jest.fn((_status: number, body: string) => ({
        ...JSON.parse(body),
        fetchedAt: 1,
        providerKey: "deepseek",
        accountId: "a",
        kind: "credit",
        currency: "CNY",
        raw: {},
      })),
    }
    balance.findBalanceAdapter.mockReturnValue(adapter)
    fetchMock.mockResolvedValueOnce(new Response('{"remaining":4,"total":10}', { status: 200 }))
    const output = await balanceReadHandler.handler(ctx("balance.read", {}))
    expect(balance.findBalanceAdapter).toHaveBeenCalledWith({
      providerKey: "deepseek",
      baseUrl: provider.baseURL,
    })
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.deepseek.com/user/balance",
      expect.objectContaining({ headers: { authorization: "Bearer sk-secret" } })
    )
    expect(balanceReadOutput.parse(output)).toEqual({
      amount: 4,
      currency: "CNY",
      kind: "credits",
      capturedAt: 1,
    })
    expect(output.snapshot.total).toBe(10)

    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 401 }))
    await expect(balanceReadHandler.handler(ctx("balance.read", {}))).rejects.toMatchObject({
      failure: { code: "authentication" },
    })
    balance.findBalanceAdapter.mockReturnValue(undefined)
    await expect(balanceReadHandler.handler(ctx("balance.read", {}))).rejects.toMatchObject({
      failure: { code: "capability-unsupported" },
    })
  })

  it("walks the quota sources in order and projects the primary meter", async () => {
    const declined = { key: "first", matches: () => true, fetch: jest.fn(async () => null) }
    const answered = {
      key: "second",
      matches: () => true,
      fetch: jest.fn(async (c: { authedGet: (url: string) => Promise<string> }) => {
        const body = await c.authedGet("https://x/usage")
        return {
          provider: "deepseek",
          fetchedAt: 7,
          meters: [
            {
              id: "credit",
              kind: "balance",
              status: "ok",
              usedPct: null,
              used: 3,
              total: 10,
              unit: "USD",
            },
            { id: "session", kind: "window", status: "ok", usedPct: Number(body), resetAt: 99 },
          ],
        }
      }),
    }
    limits.resolveLimitsSources.mockReturnValue([declined, answered])
    fetchMock.mockResolvedValueOnce(new Response("42", { status: 200 }))
    const output = await quotaReadHandler.handler(ctx("quota.read", {}))
    expect(declined.fetch).toHaveBeenCalledWith(
      expect.objectContaining({ token: "sk-secret", providerKey: "deepseek" })
    )
    expect(quotaReadOutput.parse(output)).toEqual({
      used: 42,
      limit: 100,
      unit: "percent",
      resetsAt: 99,
      capturedAt: 7,
    })
    expect(output.source).toBe("second")
    expect(output.meters).toHaveLength(2)
    expect(
      quotaOf([
        { id: "c", kind: "balance", status: "ok", usedPct: null, used: 3, total: 10, unit: "USD" },
      ])
    ).toEqual({
      used: 3,
      limit: 10,
      unit: "USD",
    })

    limits.resolveLimitsSources.mockReturnValue([])
    await expect(quotaReadHandler.handler(ctx("quota.read", {}))).rejects.toMatchObject({
      failure: { code: "capability-unsupported" },
    })
  })

  it("derives rate limits from the vendor headers, in either spelling", () => {
    const now = 1_000_000
    const openai = new Headers({
      "x-ratelimit-limit-requests": "500",
      "x-ratelimit-remaining-requests": "499",
      "x-ratelimit-reset-requests": "1m30s",
      "x-ratelimit-limit-tokens": "30000",
      "content-type": "application/json",
    })
    expect(parseRateLimitHeaders(openai, now)).toEqual([
      { name: "requests", limit: 500, remaining: 499, resetsAt: now + 90_000 },
      { name: "tokens", limit: 30000 },
    ])
    const anthropic = new Headers({
      "anthropic-ratelimit-input-tokens-limit": "80000",
      "anthropic-ratelimit-input-tokens-remaining": "79000",
      "anthropic-ratelimit-input-tokens-reset": "2026-09-02T00:00:00Z",
    })
    expect(parseRateLimitHeaders(anthropic, now)).toEqual([
      {
        name: "input-tokens",
        limit: 80000,
        remaining: 79000,
        resetsAt: Date.parse("2026-09-02T00:00:00Z"),
      },
    ])
    expect(durationToMs("6m0s")).toBe(360_000)
    expect(durationToMs("20ms")).toBe(20)
    expect(durationToMs("2")).toBe(2000)
    expect(durationToMs("soon")).toBeUndefined()
  })

  it("reads rate limits off a cheap authenticated GET", async () => {
    http.providerRequest.mockResolvedValueOnce({
      headers: new Headers({ "x-ratelimit-remaining-requests": "9" }),
      json: {},
    })
    const output = await rateLimitsReadHandler.handler(ctx("rate-limits.read", {}))
    expect(http.providerRequest).toHaveBeenCalledWith(
      provider,
      expect.objectContaining({ path: "models" })
    )
    expect(rateLimitsReadOutput.parse(output).limits).toEqual([{ name: "requests", remaining: 9 }])
  })

  it("binds provider usage per vendor to its admin endpoint and answers daily rows", async () => {
    const registry = new ProviderOperationHandlerRegistry()
    for (const handler of ACCOUNT_HANDLERS) registry.register(handler)
    expect(registry.resolve("usage.provider.read", "deepseek", "openai")).toBeUndefined()
    const openai = registry.resolve("usage.provider.read", "openai", "openai")!
    http.providerRequest.mockResolvedValueOnce({
      json: {
        data: [
          {
            start_time: 1_700_000_000,
            end_time: 1_700_086_400,
            results: [{ input_tokens: 10, output_tokens: 5, num_model_requests: 2 }],
          },
          {
            start_time: 1_600_000_000,
            end_time: 1_600_086_400,
            results: [{ input_tokens: 99, output_tokens: 99 }],
          },
        ],
      },
    })
    const output = (await openai.handler(
      ctx(
        "usage.provider.read",
        { from: 1_700_000_000_000, to: 1_700_200_000_000 },
        { ...provider, providerId: "openai", protocol: "openai" }
      )
    )) as { rows: unknown[] }
    expect(http.providerRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        baseURL: "https://api.openai.com/v1",
        path: expect.stringContaining("start_time=1700000000"),
      })
    )
    expect(usageProviderReadOutput.parse(output).rows).toEqual([
      { day: dayOf(1_700_000_000_000), inputTokens: 10, outputTokens: 5 },
    ])
  })

  it("reads local usage from the session ledger scoped to the provider and window", async () => {
    usageRows.push(
      { providerId: "deepseek-anthropic", at: 50, model: "a", inputTokens: 1, outputTokens: 2 },
      { providerId: "deepseek-anthropic", at: 500, model: "b", inputTokens: 10, outputTokens: 20 },
      { providerId: "other", at: 50, model: "c", inputTokens: 100, outputTokens: 200 }
    )
    const output = await usageLocalReadHandler.handler(
      ctx("usage.local.read", { from: 0, to: 100 })
    )
    expect(usageLocalReadOutput.parse(output).rows).toEqual([
      {
        model: "a",
        providerId: "deepseek-anthropic",
        attribution: "exact",
        inputTokens: 1,
        outputTokens: 2,
        costUsd: 0.5,
      },
    ])
    await expect(
      usageLocalReadHandler.handler(ctx("usage.local.read", { from: 5, to: 5 }))
    ).rejects.toMatchObject({
      failure: { code: "schema" },
    })
  })

  it("excludes another agent's imported spend from what this install spent", async () => {
    // Since the external usage index shipped, `sessionUsage` also holds turns
    // another coding agent paid for, stamped with the provider ITS transcript
    // named. This operation feeds the CLI's `provider usage`, which is the
    // number a person checks against their own invoice.
    usageRows.push(
      { providerId: "deepseek-anthropic", at: 50, model: "a", inputTokens: 1, outputTokens: 2 },
      {
        providerId: "deepseek-anthropic",
        at: 50,
        model: "a",
        inputTokens: 999,
        outputTokens: 999,
        imported: true,
        sourceId: "codex",
      }
    )
    const output = await usageLocalReadHandler.handler(
      ctx("usage.local.read", { from: 0, to: 100 })
    )
    const rows = usageLocalReadOutput.parse(output).rows
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ inputTokens: 1, outputTokens: 2 })
  })
})

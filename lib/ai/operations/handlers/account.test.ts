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

import type { ProviderOperationId } from "@cognia/provider-types"
import type { ResolvedProvider } from "@/lib/ai/provider-consumption"

import { getProviderOperationDescriptor } from "../manifest"
import { ProviderOperationHandlerRegistry } from "../registry"
import {
  ACCOUNT_HANDLERS,
  balanceReadHandler,
  durationToMs,
  parseRateLimitHeaders,
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

  it("reads a balance through the registry adapter and maps a non-2xx to a typed failure", async () => {
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
        raw: {},
      })),
    }
    balance.findBalanceAdapter.mockReturnValue(adapter)
    fetchMock.mockResolvedValueOnce(new Response('{"remaining":4}', { status: 200 }))
    const output = await balanceReadHandler.handler(ctx("balance.read", {}))
    expect(balance.findBalanceAdapter).toHaveBeenCalledWith({
      providerKey: "deepseek",
      baseUrl: provider.baseURL,
    })
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.deepseek.com/user/balance",
      expect.objectContaining({ headers: { authorization: "Bearer sk-secret" } })
    )
    expect(output).toMatchObject({ remaining: 4, providerKey: "deepseek" })

    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 401 }))
    await expect(balanceReadHandler.handler(ctx("balance.read", {}))).rejects.toMatchObject({
      failure: { code: "authentication" },
    })
    balance.findBalanceAdapter.mockReturnValue(undefined)
    await expect(balanceReadHandler.handler(ctx("balance.read", {}))).rejects.toMatchObject({
      failure: { code: "capability-unsupported" },
    })
  })

  it("walks the quota sources in order and returns the first snapshot", async () => {
    const declined = { key: "first", matches: () => true, fetch: jest.fn(async () => null) }
    const answered = {
      key: "second",
      matches: () => true,
      fetch: jest.fn(async (c: { authedGet: (url: string) => Promise<string> }) => {
        const body = await c.authedGet("https://x/usage")
        return {
          provider: "deepseek",
          fetchedAt: 7,
          meters: [{ id: "session", kind: "window", usedPct: Number(body) }],
        }
      }),
    }
    limits.resolveLimitsSources.mockReturnValue([declined, answered])
    fetchMock.mockResolvedValueOnce(new Response("42", { status: 200 }))
    const output = await quotaReadHandler.handler(ctx("quota.read", {}))
    expect(declined.fetch).toHaveBeenCalledWith(
      expect.objectContaining({ token: "sk-secret", providerKey: "deepseek" })
    )
    expect(output).toEqual({
      source: "second",
      fetchedAt: 7,
      meters: [{ id: "session", kind: "window", usedPct: 42 }],
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
      { name: "requests", limit: 500, remaining: 499, resetAt: now + 90_000 },
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
        resetAt: Date.parse("2026-09-02T00:00:00Z"),
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
    expect(output.limits).toEqual([{ name: "requests", remaining: 9 }])
  })

  it("binds provider usage per vendor to its admin endpoint and sums the buckets", async () => {
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
        { since: 1_700_000_000_000, until: 1_700_200_000_000 },
        { ...provider, providerId: "openai", protocol: "openai" }
      )
    )) as { buckets: unknown[]; totals: unknown }
    expect(http.providerRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        baseURL: "https://api.openai.com/v1",
        path: expect.stringContaining("start_time=1700000000"),
      })
    )
    expect(output.buckets).toEqual([
      {
        start: 1_700_000_000_000,
        end: 1_700_086_400_000,
        inputTokens: 10,
        outputTokens: 5,
        requests: 2,
      },
    ])
    expect(output.totals).toEqual({ inputTokens: 10, outputTokens: 5, requests: 2 })
  })

  it("reads local usage from the session ledger scoped to the provider and window", async () => {
    usageRows.push(
      { providerId: "deepseek-anthropic", at: 50, model: "a", inputTokens: 1, outputTokens: 2 },
      { providerId: "deepseek-anthropic", at: 500, model: "b", inputTokens: 10, outputTokens: 20 },
      { providerId: "other", at: 50, model: "c", inputTokens: 100, outputTokens: 200 }
    )
    const output = await usageLocalReadHandler.handler(
      ctx("usage.local.read", { since: 0, until: 100 })
    )
    expect(output.turns).toBe(1)
    expect(output.totals).toEqual({ inputTokens: 1, outputTokens: 2, costUsd: 0.5 })
    expect(output.byModel.map((row) => row.model)).toEqual(["a"])
    await expect(
      usageLocalReadHandler.handler(ctx("usage.local.read", { since: 5, until: 5 }))
    ).rejects.toMatchObject({
      failure: { code: "schema" },
    })
  })
})

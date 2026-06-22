const proxyFetchMock = jest.fn()

import {
  OpenRouterError,
  buildChatRequestBody,
  buildChatRequestHeaders,
  formatCredits,
  formatUsage,
  getCredits,
  getEnabledBYOKProviders,
  getModelProvider,
  groupModelsByProvider,
  isModelFree,
  isProvisioningKey,
  isValidOpenRouterKey,
  listApiKeys,
  listModels,
  maskApiKey,
  parseModelPricing,
  sortModelsByProvider,
} from "./openrouter"
import type { OpenRouterModel } from "@cognia/provider-types/openrouter"
import {
  resetProviderCoreRuntimeAdaptersForTesting,
  setProviderCoreRuntimeAdapters,
} from "./runtime-adapters"

function response(body: unknown, status = 200, statusText = "") {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => body,
  } as Response
}

const model = (id: string, name: string, prompt = "0", completion = "0"): OpenRouterModel =>
  ({
    id,
    name,
    pricing: { prompt, completion },
  }) as OpenRouterModel

describe("OpenRouter API helpers", () => {
  beforeEach(() => {
    proxyFetchMock.mockReset()
    setProviderCoreRuntimeAdapters({ proxyFetch: proxyFetchMock })
  })

  afterEach(() => {
    resetProviderCoreRuntimeAdaptersForTesting()
  })

  it("lists API keys and models through proxyFetch", async () => {
    proxyFetchMock.mockResolvedValueOnce(response({ data: [{ hash: "key-hash" }] }))
    await expect(listApiKeys("sk-or-v1-admin", 10)).resolves.toEqual([{ hash: "key-hash" }])
    expect(proxyFetchMock.mock.calls[0][0]).toContain("/keys?offset=10")

    proxyFetchMock.mockResolvedValueOnce(response({ data: [model("openai/gpt-4o", "GPT-4o")] }))
    await expect(listModels("sk-or-user")).resolves.toHaveLength(1)
  })

  it("throws typed OpenRouter errors from structured error responses", async () => {
    proxyFetchMock.mockResolvedValueOnce(
      response({ error: { message: "No credits", code: 402, metadata: { credits: 0 } } }, 402)
    )

    await expect(getCredits("sk-or-user")).rejects.toMatchObject({
      name: "OpenRouterError",
      code: 402,
      metadata: { credits: 0 },
    } satisfies Partial<OpenRouterError>)
  })

  it("normalizes credits and formats display values", async () => {
    proxyFetchMock.mockResolvedValueOnce(response({ data: { total_credits: 10, total_usage: 3 } }))
    await expect(getCredits("sk-or-user")).resolves.toEqual({
      credits: 10,
      credits_used: 3,
      credits_remaining: 7,
    })

    expect(formatCredits(2)).toBe("$2.00")
    expect(formatCredits(0.005)).toBe("$0.005000")
    expect(formatUsage(1_500_000)).toBe("1.50M")
    expect(formatUsage(12_500)).toBe("12.5K")
  })

  it("builds chat request helpers and validates key shapes", () => {
    expect(buildChatRequestHeaders("sk-or-user", "https://app.example", "Cognia")).toMatchObject({
      Authorization: "Bearer sk-or-user",
      "HTTP-Referer": "https://app.example",
      "X-Title": "Cognia",
    })

    expect(
      buildChatRequestBody({
        apiKey: "sk-or-user",
        model: "openai/gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
        temperature: 0.2,
        maxTokens: 1000,
        topP: 0.9,
        stream: true,
        providerOrdering: { allow_fallbacks: true, order: ["openai"] },
      })
    ).toMatchObject({
      model: "openai/gpt-4o",
      temperature: 0.2,
      max_tokens: 1000,
      top_p: 0.9,
      stream: true,
      provider: { allow_fallbacks: true, order: ["openai"] },
    })

    expect(isValidOpenRouterKey("sk-or-1234567890")).toBe(true)
    expect(isProvisioningKey("sk-or-v1-admin")).toBe(true)
    expect(maskApiKey("sk-or-1234567890")).toBe("sk-or-12...7890")
  })

  it("groups, sorts, and prices models by provider", () => {
    const models = [
      model("z-provider/model-b", "B", "0.000001", "0.000002"),
      model("a-provider/model-a", "A"),
    ]

    expect(parseModelPricing(models[0])).toEqual({ promptPer1M: 1, completionPer1M: 2 })
    expect(isModelFree(models[1])).toBe(true)
    expect(getModelProvider("openai/gpt-4o")).toBe("openai")
    expect(sortModelsByProvider(models).map((m) => m.id)).toEqual([
      "a-provider/model-a",
      "z-provider/model-b",
    ])
    expect(groupModelsByProvider(models)["z-provider"]).toEqual([models[0]])
    expect(getEnabledBYOKProviders([{ provider: "openai", enabled: true } as never])).toEqual([
      "openai",
    ])
  })
})

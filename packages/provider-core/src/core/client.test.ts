// Each provider factory is mocked to return a callable provider. The provider
// records the model id it was called with and echoes back the factory options,
// so tests can assert both the factory wiring ({ apiKey, baseURL }) and the
// resolved model id without a real network client.
function makeFactoryMock(name: string) {
  return jest.fn((factoryOpts?: { apiKey?: string; baseURL?: string }) => {
    // The callable is the bare client; `.chat` / `.responses` mirror
    // @ai-sdk/openai's endpoint-family selectors so the openai branch can
    // assert which endpoint it chose. Non-openai factories never call these.
    const callable = Object.assign(
      jest.fn((modelId?: string) => ({ provider: name, modelId, factoryOpts })),
      {
        chat: jest.fn((modelId?: string) => ({ provider: `${name}.chat`, modelId, factoryOpts })),
        responses: jest.fn((modelId?: string) => ({
          provider: `${name}.responses`,
          modelId,
          factoryOpts,
        })),
      }
    )
    return callable
  })
}

jest.mock("@ai-sdk/anthropic", () => ({
  __esModule: true,
  createAnthropic: makeFactoryMock("anthropic"),
}))
jest.mock("@ai-sdk/openai", () => ({
  __esModule: true,
  createOpenAI: makeFactoryMock("openai"),
}))
jest.mock("@ai-sdk/google", () => ({
  __esModule: true,
  createGoogleGenerativeAI: makeFactoryMock("google"),
}))
jest.mock("@ai-sdk/mistral", () => ({
  __esModule: true,
  createMistral: makeFactoryMock("mistral"),
}))
jest.mock("@ai-sdk/cohere", () => ({
  __esModule: true,
  createCohere: makeFactoryMock("cohere"),
}))

import { getProviderModel, isGenuineOpenAiEndpoint } from "./client"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createOpenAI } from "@ai-sdk/openai"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createMistral } from "@ai-sdk/mistral"
import { createCohere } from "@ai-sdk/cohere"

type ResolvedModel = { provider: string; modelId?: string; factoryOpts?: Record<string, unknown> }

const mockAnthropic = createAnthropic as unknown as jest.Mock
const mockOpenAI = createOpenAI as unknown as jest.Mock
const mockGoogle = createGoogleGenerativeAI as unknown as jest.Mock
const mockMistral = createMistral as unknown as jest.Mock
const mockCohere = createCohere as unknown as jest.Mock

describe("getProviderModel", () => {
  beforeEach(() => {
    mockAnthropic.mockClear()
    mockOpenAI.mockClear()
    mockGoogle.mockClear()
    mockMistral.mockClear()
    mockCohere.mockClear()
    delete process.env.ANTHROPIC_API_KEY
  })

  it("creates an anthropic model with the supplied model id", () => {
    const m = getProviderModel({
      provider: "anthropic",
      model: "claude-3-7-haiku",
    }) as ResolvedModel
    expect(m.provider).toBe("anthropic")
    expect(m.modelId).toBe("claude-3-7-haiku")
  })

  it("falls back to claude-sonnet-4-5 when an anthropic model is empty", () => {
    const m = getProviderModel({ provider: "anthropic", model: "" }) as ResolvedModel
    expect(m.modelId).toBe("claude-sonnet-4-5")
  })

  it("routes genuine OpenAI (no base URL) through the Responses API, not Anthropic", () => {
    const m = getProviderModel({ provider: "openai", model: "gpt-4o-mini" }) as ResolvedModel
    // No base URL = the default OpenAI endpoint → richer Responses API.
    expect(m.provider).toBe("openai.responses")
    expect(m.modelId).toBe("gpt-4o-mini")
    expect(mockAnthropic).not.toHaveBeenCalled()
  })

  it("routes genuine OpenAI (api.openai.com base URL) through the Responses API", () => {
    const m = getProviderModel({
      provider: "openai",
      model: "gpt-4o",
      baseURL: "https://api.openai.com/v1",
    }) as ResolvedModel
    expect(m.provider).toBe("openai.responses")
  })

  it.each([
    ["google", "gemini-2.5-flash", () => mockGoogle],
    ["gemini", "gemini-2.5-pro", () => mockGoogle],
    ["mistral", "mistral-large", () => mockMistral],
    ["cohere", "command-r", () => mockCohere],
  ])("routes %s to its dedicated factory", (provider, model, getMock) => {
    const m = getProviderModel({ provider: provider as never, model }) as ResolvedModel
    expect(getMock()).toHaveBeenCalledTimes(1)
    expect(m.modelId).toBe(model)
  })

  it.each([
    ["deepseek", "https://api.deepseek.com/v1"],
    ["groq", "https://api.groq.com/openai/v1"],
    ["openrouter", "https://openrouter.ai/api/v1"],
    ["ollama", "http://localhost:11434/v1"],
    ["lmstudio", "http://localhost:1234/v1"],
    ["vllm", "http://localhost:8000/v1"],
  ])(
    "routes OpenAI-compatible gateway %s to Chat Completions (not the Responses API it would 404 on)",
    (provider, baseURL) => {
      const m = getProviderModel({
        provider: provider as never,
        model: "some-model",
        baseURL,
      }) as ResolvedModel
      // A non-*.openai.com base URL → Chat Completions, the only endpoint these
      // gateways implement. The bare client(model) would pick Responses → 404.
      expect(m.provider).toBe("openai.chat")
      expect(mockOpenAI).toHaveBeenCalledTimes(1)
    }
  )

  it("routes codex through the Responses API even on the ChatGPT backend (not *.openai.com)", () => {
    const m = getProviderModel({
      provider: "codex" as never,
      model: "gpt-5.2-codex",
      baseURL: "https://chatgpt.com/backend-api/codex",
    }) as ResolvedModel
    // chatgpt.com isn't *.openai.com, so the host check would pick Chat
    // Completions; codex is forced onto Responses (the only endpoint it serves).
    expect(m.provider).toBe("openai.responses")
  })

  it("forwards custom headers (Codex ChatGPT-login) into the OpenAI factory", () => {
    getProviderModel({
      provider: "codex" as never,
      model: "gpt-5.2-codex",
      apiKey: "chatgpt-bearer",
      baseURL: "https://chatgpt.com/backend-api/codex",
      headers: { "ChatGPT-Account-Id": "acct_123", "OAI-Product-Sku": "codex" },
    })
    expect(mockOpenAI).toHaveBeenCalledWith({
      apiKey: "chatgpt-bearer",
      baseURL: "https://chatgpt.com/backend-api/codex",
      headers: { "ChatGPT-Account-Id": "acct_123", "OAI-Product-Sku": "codex" },
    })
  })

  it("forwards apiKey and baseURL into the provider factory", () => {
    getProviderModel({
      provider: "openai",
      model: "gpt-4o",
      apiKey: "sk-test",
      baseURL: "https://proxy.example/v1",
    })
    expect(mockOpenAI).toHaveBeenCalledWith({
      apiKey: "sk-test",
      baseURL: "https://proxy.example/v1",
    })
  })

  it("never mutates process.env when an apiKey is supplied", () => {
    delete process.env.ANTHROPIC_API_KEY
    getProviderModel({ provider: "anthropic", model: "x", apiKey: "from-call" })
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it("throws for an unsupported provider instead of silently using Anthropic", () => {
    expect(() => getProviderModel({ provider: "totally-unknown" as never, model: "x" })).toThrow(
      /unsupported provider/i
    )
    expect(mockAnthropic).not.toHaveBeenCalled()
  })
})

describe("isGenuineOpenAiEndpoint", () => {
  it("treats a missing base URL as genuine OpenAI (the default endpoint)", () => {
    expect(isGenuineOpenAiEndpoint(undefined)).toBe(true)
  })
  it("accepts api.openai.com and its subdomains", () => {
    expect(isGenuineOpenAiEndpoint("https://api.openai.com/v1")).toBe(true)
    expect(isGenuineOpenAiEndpoint("https://eu.api.openai.com/v1")).toBe(true)
  })
  it("rejects compatible gateways and unparseable URLs", () => {
    expect(isGenuineOpenAiEndpoint("https://api.deepseek.com/v1")).toBe(false)
    expect(isGenuineOpenAiEndpoint("http://localhost:11434/v1")).toBe(false)
    expect(isGenuineOpenAiEndpoint("not a url")).toBe(false)
  })
})

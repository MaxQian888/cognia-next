// Each provider factory is mocked to return a callable provider. The provider
// records the model id it was called with and echoes back the factory options,
// so tests can assert both the factory wiring ({ apiKey, baseURL }) and the
// resolved model id without a real network client.
function makeFactoryMock(name: string) {
  return jest.fn((factoryOpts?: { apiKey?: string; baseURL?: string }) =>
    jest.fn((modelId?: string) => ({ provider: name, modelId, factoryOpts }))
  )
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

import { getProviderModel } from "./client"
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

  it("routes openai through the OpenAI factory, not Anthropic", () => {
    const m = getProviderModel({ provider: "openai", model: "gpt-4o-mini" }) as ResolvedModel
    expect(m.provider).toBe("openai")
    expect(m.modelId).toBe("gpt-4o-mini")
    expect(mockAnthropic).not.toHaveBeenCalled()
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

  it.each(["deepseek", "groq", "openrouter", "ollama", "lmstudio", "vllm"])(
    "routes OpenAI-compatible provider %s through the OpenAI factory",
    (provider) => {
      const m = getProviderModel({
        provider: provider as never,
        model: "some-model",
      }) as ResolvedModel
      expect(m.provider).toBe("openai")
      expect(mockOpenAI).toHaveBeenCalledTimes(1)
    }
  )

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

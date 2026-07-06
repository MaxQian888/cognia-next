/**
 * Coverage for `llm.ts`:
 *   - `extractJson` — the JSON-from-LLM-prose extractor.
 *   - `createLlmClient` provider dispatch — verifies each branch builds
 *     without throwing and that the back-compat alias still resolves.
 *
 * The full agent-side flow (a mocked `LlmClient` driving the distill
 * sub-agents) is covered separately by the agent tests; here we only
 * pin the parser + the client-factory dispatch.
 */

import {
  extractJson,
  createLlmClient,
  createAnthropicLlmClient,
  createTwinLanguageModel,
  readUsageDelta,
  type LlmConfig,
} from "./llm"
import { generateText } from "ai"
import { createAzure } from "@ai-sdk/azure"
import { createOpenAI } from "@ai-sdk/openai"

jest.mock("ai", () => ({
  generateText: jest.fn(async ({ model }) => ({
    text: `ok:${model.__provider}`,
    usage: { inputTokens: 1, outputTokens: 2 },
    providerMetadata: {},
  })),
  streamText: jest.fn(({ model }) => ({
    textStream: (async function* () {
      yield `stream:${model.__provider}`
    })(),
    usage: Promise.resolve({ inputTokens: 3, outputTokens: 4 }),
    providerMetadata: Promise.resolve({}),
  })),
}))

function makeEndpointFamilyFactory(provider: string) {
  return jest.fn((settings: unknown) => {
    const make = (entrypoint: string, id: string) => ({
      __provider: `${provider}.${entrypoint}`,
      id,
      settings,
    })
    const fn = Object.assign(
      jest.fn((id: string) => make("bare", id)),
      {
        chat: jest.fn((id: string) => make("chat", id)),
        responses: jest.fn((id: string) => make("responses", id)),
      }
    )
    return fn
  })
}

jest.mock("@ai-sdk/openai", () => ({
  createOpenAI: makeEndpointFamilyFactory("openai"),
}))

jest.mock("@ai-sdk/azure", () => ({
  createAzure: makeEndpointFamilyFactory("azure"),
}))

function lastGenerateTextCall() {
  return (generateText as jest.Mock).mock.calls.at(-1)?.[0] as
    | { model?: { __provider?: string; id?: string; settings?: unknown }; maxOutputTokens?: number }
    | undefined
}

describe("extractJson", () => {
  it("parses a bare JSON object", () => {
    const result = extractJson<{ a: number }>('{"a": 1}')
    expect(result).toEqual({ a: 1 })
  })

  it("parses a bare JSON array", () => {
    const result = extractJson<number[]>("[1, 2, 3]")
    expect(result).toEqual([1, 2, 3])
  })

  it("strips a leading fenced ```json block", () => {
    const text = '```json\n{"answer": 42}\n```'
    expect(extractJson<{ answer: number }>(text)).toEqual({ answer: 42 })
  })

  it("strips a leading ``` block (no language)", () => {
    const text = '```\n{"ok": true}\n```'
    expect(extractJson<{ ok: boolean }>(text)).toEqual({ ok: true })
  })

  it("ignores leading prose before a JSON object", () => {
    const text = `Sure, here's the result:\n{"a": 1, "b": "two"}`
    expect(extractJson<{ a: number; b: string }>(text)).toEqual({ a: 1, b: "two" })
  })

  it("ignores trailing prose after a JSON object", () => {
    const text = `{"a": 1}\n\nLet me know if you'd like me to refine.`
    expect(extractJson<{ a: number }>(text)).toEqual({ a: 1 })
  })

  it("respects nested braces inside string values", () => {
    const text = `{"snippet": "function f() { return {a:1}; }", "name": "f"}`
    const result = extractJson<{ snippet: string; name: string }>(text)
    expect(result.name).toBe("f")
    expect(result.snippet).toContain("return {a:1}")
  })

  it("respects escaped quotes inside strings", () => {
    const text = `{"q": "say \\"hi\\"", "ok": true}`
    expect(extractJson<{ q: string; ok: boolean }>(text)).toEqual({
      q: 'say "hi"',
      ok: true,
    })
  })

  it("throws when no JSON is present at all", () => {
    expect(() => extractJson("plain prose, no braces here")).toThrow(/no JSON object or array/)
  })

  it("throws on an unterminated JSON span", () => {
    expect(() => extractJson('{"a": 1, "b": ')).toThrow(/unterminated/)
  })
})

describe("createLlmClient", () => {
  // Each provider branch returns an object with `.complete(...)`. The
  // underlying SDK is loaded lazily, so just constructing the client must
  // never throw — that's the contract the workbench depends on so a
  // mis-configured provider surfaces the error at send time, not at
  // module load.
  const baseConfig = (provider: LlmConfig["provider"]): LlmConfig => ({
    provider,
    model: `${provider}-test-model`,
    apiKey: "test-key",
  })

  it("constructs an Anthropic client without throwing", () => {
    const client = createLlmClient(baseConfig("anthropic"))
    expect(typeof client.complete).toBe("function")
  })

  it("constructs an OpenAI client without throwing", () => {
    const client = createLlmClient(baseConfig("openai"))
    expect(typeof client.complete).toBe("function")
  })

  it("constructs a Google client without throwing", () => {
    const client = createLlmClient(baseConfig("google"))
    expect(typeof client.complete).toBe("function")
  })

  it("constructs a Mistral client without throwing", () => {
    const client = createLlmClient(baseConfig("mistral"))
    expect(typeof client.complete).toBe("function")
  })

  it("constructs a Cohere client without throwing", () => {
    const client = createLlmClient(baseConfig("cohere"))
    expect(typeof client.complete).toBe("function")
  })

  it("surfaces an unsupported-provider error on first complete() call", async () => {
    const client = createLlmClient({
      ...baseConfig("openai"),
      provider: "made-up-provider" as LlmConfig["provider"],
    })
    await expect(client.complete("hi")).rejects.toThrow(/unsupported provider/i)
  })

  it("createAnthropicLlmClient is the same factory for back-compat", () => {
    expect(createAnthropicLlmClient).toBe(createLlmClient)
  })

  it("createTwinLanguageModel returns an ai-sdk model handle", async () => {
    const model = await createTwinLanguageModel(baseConfig("openai"))
    expect(model).toBeDefined()
  })

  describe("OpenAI endpoint-family dispatch", () => {
    beforeEach(() => {
      ;(generateText as jest.Mock).mockClear()
      ;(createOpenAI as jest.Mock).mockClear()
      ;(createAzure as jest.Mock).mockClear()
    })

    it("routes OpenAI-compatible provider ids to Chat Completions by default", async () => {
      const client = createLlmClient({
        provider: "openrouter" as LlmConfig["provider"],
        model: "openrouter/auto",
        apiKey: "sk-or-v1-test",
        baseURL: "https://openrouter.ai/api/v1",
      })

      await expect(client.complete("hi")).resolves.toBe("ok:openai.chat")

      expect(createOpenAI).toHaveBeenCalledWith({
        apiKey: "sk-or-v1-test",
        baseURL: "https://openrouter.ai/api/v1",
      })
      expect(lastGenerateTextCall()?.model).toMatchObject({
        __provider: "openai.chat",
        id: "openrouter/auto",
      })
    })

    it("fills the catalog base URL for built-in OpenAI-compatible providers", async () => {
      const client = createLlmClient({
        provider: "openrouter" as LlmConfig["provider"],
        model: "openrouter/auto",
        apiKey: "sk-or-v1-test",
      })

      await expect(client.complete("hi")).resolves.toBe("ok:openai.chat")

      expect(createOpenAI).toHaveBeenCalledWith({
        apiKey: "sk-or-v1-test",
        baseURL: "https://openrouter.ai/api/v1",
      })
      expect(lastGenerateTextCall()?.model?.__provider).toBe("openai.chat")
    })

    it("routes genuine OpenAI through Responses by default", async () => {
      const client = createLlmClient({
        provider: "openai",
        model: "gpt-5.2",
        apiKey: "sk-openai",
      })

      await expect(client.complete("hi")).resolves.toBe("ok:openai.responses")

      expect(lastGenerateTextCall()?.model).toMatchObject({
        __provider: "openai.responses",
        id: "gpt-5.2",
      })
    })

    it("honors apiFlavor when a compatible endpoint explicitly supports Responses", async () => {
      const client = createLlmClient({
        provider: "openrouter" as LlmConfig["provider"],
        model: "gpt-5-proxy",
        apiKey: "sk-proxy",
        baseURL: "https://gateway.example/v1",
        apiFlavor: "responses",
      } as LlmConfig)

      await expect(client.complete("hi")).resolves.toBe("ok:openai.responses")

      expect(lastGenerateTextCall()?.model).toMatchObject({
        __provider: "openai.responses",
        id: "gpt-5-proxy",
      })
    })

    it("routes Codex ChatGPT-login backends through Responses and forwards headers", async () => {
      const headers = {
        "ChatGPT-Account-Id": "acct_123",
        "OpenAI-Beta": "responses=experimental",
      }
      const client = createLlmClient({
        provider: "codex" as LlmConfig["provider"],
        model: "gpt-5.2-codex",
        apiKey: "chatgpt-bearer",
        baseURL: "https://chatgpt.com/backend-api/codex",
        headers,
      } as LlmConfig)

      await expect(client.complete("hi")).resolves.toBe("ok:openai.responses")

      expect(createOpenAI).toHaveBeenCalledWith({
        apiKey: "chatgpt-bearer",
        baseURL: "https://chatgpt.com/backend-api/codex",
        headers,
      })
      expect(lastGenerateTextCall()?.model?.__provider).toBe("openai.responses")
    })

    it("routes Azure through Chat by default and Responses when explicitly requested", async () => {
      const auto = createLlmClient({
        provider: "azure" as LlmConfig["provider"],
        model: "gpt-5",
        apiKey: "sk-azure",
        baseURL: "https://example.openai.azure.com",
      })
      await expect(auto.complete("hi")).resolves.toBe("ok:azure.chat")

      const responses = createLlmClient({
        provider: "azure" as LlmConfig["provider"],
        model: "gpt-5",
        apiKey: "sk-azure",
        baseURL: "https://example.openai.azure.com",
        apiFlavor: "responses",
      } as LlmConfig)
      await expect(responses.complete("hi")).resolves.toBe("ok:azure.responses")

      expect(createAzure).toHaveBeenCalledTimes(2)
    })

    it("maps maxTokens to the AI SDK v6 maxOutputTokens option", async () => {
      const client = createLlmClient({
        provider: "openai",
        model: "gpt-5.2",
        apiKey: "sk-openai",
        defaultMaxTokens: 123,
      })

      await client.complete("hi")
      expect(lastGenerateTextCall()?.maxOutputTokens).toBe(123)

      await client.complete("hi", { maxTokens: 45 })
      expect(lastGenerateTextCall()?.maxOutputTokens).toBe(45)
    })
  })
})

describe("readUsageDelta", () => {
  it("reads AI SDK v6 input/output + cachedInputTokens (cache-read)", () => {
    expect(readUsageDelta({ inputTokens: 100, outputTokens: 40, cachedInputTokens: 70 })).toEqual({
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 70,
      cacheCreationTokens: 0,
    })
  })

  it("pulls Anthropic cache-write from providerMetadata", () => {
    const delta = readUsageDelta(
      { inputTokens: 10, outputTokens: 5, cachedInputTokens: 3 },
      { anthropic: { cacheCreationInputTokens: 22 } }
    )
    expect(delta.cacheCreationTokens).toBe(22)
    expect(delta.cacheReadTokens).toBe(3)
  })

  it("falls back to prompt/completion + openai/deepseek cache aliases", () => {
    expect(
      readUsageDelta({ promptTokens: 8, completionTokens: 2, promptCacheHitTokens: 6 })
    ).toEqual({
      inputTokens: 8,
      outputTokens: 2,
      cacheReadTokens: 6,
      cacheCreationTokens: 0,
    })
  })

  it("coalesces missing / non-numeric fields to 0 without throwing", () => {
    expect(readUsageDelta(undefined)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    })
    expect(readUsageDelta({ inputTokens: "x", outputTokens: null })).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    })
  })

  it("preserves a genuine 0 input without swallowing it via ??", () => {
    expect(readUsageDelta({ inputTokens: 0, promptTokens: 99 }).inputTokens).toBe(0)
  })
})

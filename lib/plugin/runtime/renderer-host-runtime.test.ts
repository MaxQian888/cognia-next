import { streamText } from "ai"
import { generateEmbeddings } from "@cognia/vector/embedding"
import { createFeatureProviderModel, resolveFeatureProvider } from "@/lib/ai/provider-consumption"

import { createRendererHostRuntime } from "./renderer-host-runtime"

jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: {
    getState: jest.fn(() => ({
      defaultProvider: "openai",
      providerSettings: {
        openai: {
          providerId: "openai",
          apiKey: "sk-openai",
          enabled: true,
          defaultModel: "gpt-4o",
        },
      },
      customProviders: {},
    })),
  },
}))

jest.mock("ai", () => ({ streamText: jest.fn() }))

jest.mock("@/lib/claude/plugin-tool-ipc", () => ({
  resolveWebToolDeps: jest.fn(async () => ({
    enabled: true,
    searchExecutor: async () => ({ query: "q", provider: "tavily", results: [] }),
  })),
}))

jest.mock("@cognia/vector/embedding", () => ({
  generateEmbeddings: jest.fn(async () => ({ embeddings: [[0.1, 0.2]] })),
  // Mirrors the shape the real catalog exports (built from
  // `RAG_EMBEDDING_PROVIDERS`). `anthropic` is deliberately absent — that is
  // what "this provider cannot embed" looks like.
  DEFAULT_EMBEDDING_MODELS: {
    openai: { provider: "openai", model: "text-embedding-3-small", dimensions: 1536 },
    google: { provider: "google", model: "text-embedding-004", dimensions: 768 },
    "amazon-bedrock": {
      provider: "amazon-bedrock",
      model: "amazon.titan-embed-text-v2:0",
      dimensions: 1024,
    },
  },
}))

jest.mock("@/lib/ai/provider-consumption", () => ({
  resolveFeatureProvider: jest.fn(() => ({
    kind: "resolved",
    providerId: "openai",
    apiKey: "sk-openai",
    modelId: "gpt-4o",
  })),
  createProviderSettingsSnapshot: jest.fn((value: unknown) => value),
  createFeatureProviderModel: jest.fn(() => ({ id: "gpt-4o" })),
}))

const mockStreamText = streamText as jest.Mock
const mockEmbeddings = generateEmbeddings as jest.Mock
const mockResolve = resolveFeatureProvider as jest.Mock
const mockModel = createFeatureProviderModel as jest.Mock

function textStream(chunks: string[]) {
  return {
    textStream: (async function* () {
      for (const chunk of chunks) yield chunk
    })(),
    usage: Promise.resolve({ inputTokens: 7, outputTokens: 3 }),
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockResolve.mockReturnValue({
    kind: "resolved",
    providerId: "openai",
    apiKey: "sk-openai",
    modelId: "gpt-4o",
  })
  mockModel.mockReturnValue({ id: "gpt-4o" })
})

describe("chat", () => {
  it("streams content and a trailing usage chunk", async () => {
    mockStreamText.mockReturnValue(textStream(["he", "llo"]))
    const runtime = createRendererHostRuntime({ pluginId: "p" })
    const chunks = []
    for await (const chunk of runtime.chat([{ role: "user", content: "hi" }])) chunks.push(chunk)
    expect(chunks.map((c) => c.content).join("")).toBe("hello")
    expect(chunks.at(-1)?.usage).toEqual({
      promptTokens: 7,
      completionTokens: 3,
      totalTokens: 10,
    })
  })

  it("maps the plugin-facing option names onto the AI SDK's", async () => {
    // `maxTokens` became `maxOutputTokens` in AI SDK v5; forwarding the old key
    // silently dropped every plugin's cap.
    mockStreamText.mockReturnValue(textStream([]))
    const runtime = createRendererHostRuntime({ pluginId: "p" })
    const controller = new AbortController()
    for await (const _ of runtime.chat([{ role: "user", content: "hi" }], {
      maxTokens: 128,
      temperature: 0.3,
      topP: 0.9,
      stop: ["END"],
      signal: controller.signal,
    })) {
      // drain
    }
    expect(mockStreamText).toHaveBeenCalledWith(
      expect.objectContaining({
        maxOutputTokens: 128,
        temperature: 0.3,
        topP: 0.9,
        stopSequences: ["END"],
        abortSignal: controller.signal,
      })
    )
  })

  it("throws a structured NO_PROVIDER_AVAILABLE error when nothing resolves", async () => {
    mockResolve.mockReturnValue({ kind: "unresolved", reason: "no key", nextAction: "add_api_key" })
    const runtime = createRendererHostRuntime({ pluginId: "p" })
    await expect(
      (async () => {
        for await (const _ of runtime.chat([{ role: "user", content: "hi" }])) {
          // drain
        }
      })()
    ).rejects.toMatchObject({ code: "NO_PROVIDER_AVAILABLE" })
  })
})

describe("embed", () => {
  it("uses the resolved provider's default embedding model", async () => {
    const runtime = createRendererHostRuntime({ pluginId: "p" })
    await expect(runtime.embed(["a"])).resolves.toEqual([[0.1, 0.2]])
    expect(mockEmbeddings).toHaveBeenCalledWith(
      ["a"],
      expect.objectContaining({ provider: "openai", model: "text-embedding-3-small" }),
      "sk-openai"
    )
  })

  it("refuses a provider with no embedding model instead of guessing one", async () => {
    mockResolve.mockReturnValue({ kind: "resolved", providerId: "anthropic", apiKey: "sk-a" })
    const runtime = createRendererHostRuntime({ pluginId: "p" })
    await expect(runtime.embed(["a"])).rejects.toMatchObject({ code: "NO_PROVIDER_AVAILABLE" })
  })
})

describe("defaults", () => {
  it("reads the live settings store", () => {
    const runtime = createRendererHostRuntime({ pluginId: "p" })
    expect(runtime.getDefaultProvider()).toBe("openai")
    expect(runtime.getDefaultModel()).toBe("gpt-4o")
  })
})

describe("runHostTool", () => {
  it("executes a promoted web tool against the host's own web deps", async () => {
    // The renderer runtime must not own a second search policy: it reuses the
    // exact snapshot the agent's promoted built-ins run with.
    const runtime = createRendererHostRuntime({ pluginId: "p" })
    const result = (await runtime.runHostTool("web_search", { query: "q" })) as Record<
      string,
      unknown
    >
    expect(result.ok).toBe(true)
    expect(result.provider).toBe("tavily")
  })

  it("refuses a host-private tool name", async () => {
    const runtime = createRendererHostRuntime({ pluginId: "p" })
    await expect(runtime.runHostTool("dispatch_agent" as never, {})).resolves.toMatchObject({
      ok: false,
      code: "not-author-callable",
    })
  })
})

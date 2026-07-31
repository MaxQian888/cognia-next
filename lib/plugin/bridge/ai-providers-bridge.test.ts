import { registerAiProvidersForPlugin, unregisterAiProvidersForPlugin } from "./ai-providers-bridge"
import { clearCustomAIProviders, getCustomAIProviders } from "@/lib/plugin/api/ai-provider-api"
import type { PluginManifest } from "@/types/plugin/plugin"

const manifest = (overrides: Partial<PluginManifest>): PluginManifest =>
  ({
    id: "p",
    name: "P",
    version: "1.0.0",
    description: "",
    type: "frontend",
    capabilities: ["tools"],
    main: "index.js",
    ...overrides,
  }) as PluginManifest

describe("ai-providers-bridge python backend", () => {
  beforeEach(() => {
    clearCustomAIProviders()
  })

  it("registers a python-backed LLM provider without importing any JS", async () => {
    const importer = jest.fn()
    const result = await registerAiProvidersForPlugin(
      manifest({
        type: "python",
        pythonMain: "main.py",
        aiProviders: [{ id: "pyllm", label: "Py LLM", kind: "llm", models: ["m"] }],
      }),
      "/plugins/p",
      { importer }
    )

    expect(result).toEqual({ registered: 1, errors: [] })
    expect(importer).not.toHaveBeenCalled()
    expect(getCustomAIProviders().some((p) => p.id === "p:pyllm")).toBe(true)
    unregisterAiProvidersForPlugin("p")
  })

  it("reports a JS-backed provider that omits entry/export", async () => {
    const result = await registerAiProvidersForPlugin(
      manifest({ aiProviders: [{ id: "broken", label: "Broken", kind: "llm" }] }),
      "/plugins/p",
      { importer: jest.fn() }
    )

    expect(result.registered).toBe(0)
    expect(result.errors[0]!.message).toMatch(/must declare both "entry" and "export"/)
  })
})

describe("ai-providers-bridge", () => {
  beforeEach(() => {
    clearCustomAIProviders()
  })

  it("registers an LLM provider via the existing host API", async () => {
    const m = manifest({
      aiProviders: [
        {
          id: "myllm",
          label: "My LLM",
          entry: "llm.js",
          export: "createLlm",
          kind: "llm",
          models: ["small", "large"],
        },
      ],
    })
    const importer = jest.fn(async () => ({
      createLlm: () => ({
        id: "myllm",
        complete: async () => ({ text: "hello world" }),
      }),
    }))
    const result = await registerAiProvidersForPlugin(m, "/plugins/p", { importer })
    expect(result).toEqual({ registered: 1, errors: [] })
    const all = getCustomAIProviders()
    expect(all.some((p) => p.id === "p:myllm")).toBe(true)
  })

  it("adapts complete() into the AsyncIterable chat shape", async () => {
    const m = manifest({
      aiProviders: [
        { id: "x", label: "X", entry: "x.js", export: "create", kind: "llm", models: ["one"] },
      ],
    })
    const importer = jest.fn(async () => ({
      create: () => ({ id: "x", complete: async () => ({ text: "buffered output" }) }),
    }))
    await registerAiProvidersForPlugin(m, "/plugins/p", { importer })
    const provider = getCustomAIProviders().find((p) => p.id === "p:x")!
    const chunks: string[] = []
    for await (const chunk of provider.chat([{ role: "user", content: "hi" }])) {
      chunks.push(chunk.content)
    }
    expect(chunks).toEqual(["buffered output"])
  })

  it("registers an embedding provider", async () => {
    const m = manifest({
      aiProviders: [
        {
          id: "emb",
          label: "Emb",
          entry: "e.js",
          export: "createEmb",
          kind: "embedding",
          dimensions: 4,
        },
      ],
    })
    const importer = jest.fn(async () => ({
      createEmb: () => ({
        id: "emb",
        dimensions: 4,
        embed: async (req: { texts: string[] }) => ({
          vectors: req.texts.map(() => [0.1, 0.2, 0.3, 0.4]),
          dimensions: 4,
        }),
      }),
    }))
    const result = await registerAiProvidersForPlugin(m, "/plugins/p", { importer })
    expect(result.registered).toBe(1)
    const provider = getCustomAIProviders().find((p) => p.id === "p:emb")!
    expect(provider.embed).toBeDefined()
    const vectors = await provider.embed!(["a", "b"])
    expect(vectors).toEqual([
      [0.1, 0.2, 0.3, 0.4],
      [0.1, 0.2, 0.3, 0.4],
    ])
  })

  it("registers and unregisters a namespaced declarative catalog contribution", async () => {
    const unregisterCatalog = jest.fn()
    const registerContribution = jest.fn(() => unregisterCatalog)
    const result = await registerAiProvidersForPlugin(
      manifest({
        id: "weather",
        aiProviders: [
          {
            id: "models",
            label: "Weather Models",
            kind: "llm",
            catalog: {
              tier: "experimental",
              modalities: ["language"],
              adapterFamily: "openai-compatible",
              models: [
                {
                  id: "forecast-small",
                  name: "Forecast Small",
                  modalities: { input: ["text"], output: ["text"] },
                },
              ],
              offerings: [
                {
                  id: "forecast",
                  modelRef: "forecast-small",
                  upstreamId: "forecast-v1",
                  endpointType: "chat-completions",
                },
              ],
            },
          },
        ],
      }),
      "/plugins/weather",
      {
        importer: jest.fn(),
        catalogRepository: { registerContribution } as never,
      }
    )

    expect(result).toEqual({ registered: 1, errors: [] })
    expect(registerContribution).toHaveBeenCalledWith(
      "weather",
      expect.objectContaining({
        providers: [expect.objectContaining({ id: "weather:models" })],
        models: [expect.objectContaining({ id: "weather:forecast-small" })],
        offerings: [
          expect.objectContaining({
            id: "weather:models:forecast",
            providerRef: "weather:models",
            modelRef: "weather:forecast-small",
          }),
        ],
      })
    )
    unregisterAiProvidersForPlugin("weather")
    expect(unregisterCatalog).toHaveBeenCalledTimes(1)
  })

  it("collects errors per failing entry", async () => {
    const m = manifest({
      aiProviders: [{ id: "bad", label: "Bad", entry: "b.js", export: "missing", kind: "llm" }],
    })
    const importer = jest.fn(async () => ({ other: () => ({}) }))
    const result = await registerAiProvidersForPlugin(m, "/plugins/p", { importer })
    expect(result.registered).toBe(0)
    expect(result.errors).toHaveLength(1)
  })

  it("unregister tears down every provider", async () => {
    const m = manifest({
      aiProviders: [{ id: "z", label: "Z", entry: "z.js", export: "create", kind: "llm" }],
    })
    const importer = jest.fn(async () => ({
      create: () => ({ id: "z", complete: async () => ({ text: "" }) }),
    }))
    await registerAiProvidersForPlugin(m, "/plugins/p", { importer })
    expect(getCustomAIProviders().some((p) => p.id === "p:z")).toBe(true)
    unregisterAiProvidersForPlugin("p")
    expect(getCustomAIProviders().some((p) => p.id === "p:z")).toBe(false)
  })
})

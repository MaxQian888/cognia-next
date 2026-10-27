import type { EvalCase } from "@/types/eval/eval"
import { createPureModelEvalTarget } from "./model"

const mockHasNoLeakingPiiDeep = jest.fn<boolean, [unknown]>(() => true)
jest.mock("@cognia/redact", () => ({
  ...jest.requireActual("@cognia/redact"),
  hasNoLeakingPiiDeep: (value: unknown) => mockHasNoLeakingPiiDeep(value),
}))

const evalCase: EvalCase = {
  id: "case-1",
  datasetId: "dataset-1",
  input: "Contact alice@example.com",
  contentParts: [
    { type: "text", text: "Contact alice@example.com" },
    {
      type: "asset",
      assetId: "image-1",
      mediaType: "image/png",
      privacy: "scanned",
    },
  ],
  capability: "vision",
  source: "handwritten",
  reference: { expectedOutput: "never send this answer" },
  createdAt: 1,
  updatedAt: 1,
}

describe("pure model evaluation target", () => {
  it.each([-1, NaN, Infinity])(
    "keeps valid usage components and marks malformed provider usage %p partial",
    async (invalid) => {
      const target = createPureModelEvalTarget(
        {
          label: "Malformed provider usage",
          providerId: "openai",
          modelId: "fixture",
          isLocal: false,
          settings: { defaultProvider: "openai", providerSettings: {}, customProviders: [] },
        },
        {
          createSnapshot: (() => ({})) as never,
          resolveProvider: (() => ({
            kind: "resolved",
            providerId: "openai",
            protocol: "openai",
            model: "fixture",
          })) as never,
          createModel: (() => ({})) as never,
          generateText: (async () => ({
            text: "proposal",
            finishReason: "stop",
            usage: {
              inputTokens: invalid,
              outputTokens: 7,
              inputTokenDetails: { cacheReadTokens: invalid, cacheWriteTokens: 2 },
            },
          })) as never,
          now: () => 1,
        }
      )
      const result = await target.run({ ...evalCase, contentParts: undefined })
      expect(result.usage).toEqual({
        inputTokens: 0,
        outputTokens: 7,
        cacheReadTokens: 0,
        cacheCreationTokens: 2,
      })
      expect(result.metricAvailability?.usage).toBe("partial")
      expect(result.metricAvailability?.cost).toBe("unavailable")
    }
  )
  it("honors required cloud redaction for a loopback forwarding proxy", async () => {
    mockHasNoLeakingPiiDeep.mockImplementation(
      jest.requireActual("@cognia/redact").hasNoLeakingPiiDeep
    )
    const generate = jest.fn(async (..._args: unknown[]) => ({
      text: "answer",
      usage: { inputTokens: 1, outputTokens: 1 },
      finishReason: "stop",
    }))
    const prepared = jest.fn()
    const target = createPureModelEvalTarget(
      {
        label: "Cloud forwarding proxy",
        providerId: "openai",
        modelId: "remote",
        isLocal: false,
        onPreparedTextParts: prepared,
        settings: { defaultProvider: "openai", providerSettings: {}, customProviders: [] },
      },
      {
        createSnapshot: (() => ({})) as never,
        resolveProvider: (() => ({
          kind: "resolved",
          providerId: "openai",
          protocol: "openai",
          baseURL: "http://127.0.0.1:8787/v1",
          model: "remote",
          isCustomProvider: false,
          useProxy: false,
        })) as never,
        createModel: (() => ({})) as never,
        generateText: generate as never,
        now: () => 1,
      }
    )
    const result = await target.run({ ...evalCase, contentParts: undefined })
    expect(result.redactionPolicy).toBe("cloud-redacted")
    expect(JSON.stringify(generate.mock.calls[0][0])).not.toContain("alice@example.com")
    expect(JSON.stringify(generate.mock.calls[0][0])).toContain("EMAIL_")
    expect(prepared).toHaveBeenCalledWith(["Contact <EMAIL_001>"])
    expect(prepared.mock.invocationCallOrder[0]).toBeLessThan(generate.mock.invocationCallOrder[0])
  })

  it("prices a forwarding loopback endpoint from explicit rates rather than assuming free inference", async () => {
    const target = createPureModelEvalTarget(
      {
        label: "Loopback forwarding proxy",
        providerId: "proxy",
        modelId: "remote",
        isLocal: true,
        price: { inputPerMillion: 1, outputPerMillion: 2, currency: "USD" },
        settings: { defaultProvider: "proxy", providerSettings: {}, customProviders: [] },
      },
      {
        createSnapshot: (() => ({})) as never,
        resolveProvider: (() => ({
          kind: "resolved",
          providerId: "proxy",
          protocol: "openai",
          baseURL: "http://127.0.0.1:8787/v1",
          model: "remote",
          isCustomProvider: true,
          useProxy: false,
        })) as never,
        createModel: (() => ({})) as never,
        generateText: (async () => ({
          text: "done",
          usage: {
            inputTokens: 100,
            outputTokens: 20,
            inputTokenDetails: { cacheReadTokens: 7, cacheWriteTokens: 3 },
          },
          finishReason: "stop",
        })) as never,
        now: () => 1,
      }
    )
    const result = await target.run({ ...evalCase, contentParts: undefined })
    expect(result.costUsd).toBeCloseTo(0.00014)
    expect(result.metricAvailability?.cost).toBe("estimated")
    expect(result.usage.cacheReadTokens).toBe(7)
    expect(result.usage.cacheCreationTokens).toBe(3)
  })

  it("marks missing usage and prices unavailable even on a loopback endpoint", async () => {
    const target = createPureModelEvalTarget(
      {
        label: "Unknown billing",
        providerId: "proxy",
        modelId: "remote",
        isLocal: true,
        settings: { defaultProvider: "proxy", providerSettings: {}, customProviders: [] },
      },
      {
        createSnapshot: (() => ({})) as never,
        resolveProvider: (() => ({
          kind: "resolved",
          providerId: "proxy",
          protocol: "openai",
          baseURL: "http://127.0.0.1:8787/v1",
          model: "remote",
          isCustomProvider: true,
          useProxy: false,
        })) as never,
        createModel: (() => ({})) as never,
        generateText: (async () => ({ text: "done", usage: {}, finishReason: "stop" })) as never,
        now: () => 1,
      }
    )
    const result = await target.run({ ...evalCase, contentParts: undefined })
    expect(result.metricAvailability).toMatchObject({
      usage: "unavailable",
      cost: "unavailable",
      latency: "known",
    })
    expect(result.executionStatus).toBe("completed")
    expect(result.executionProfile).toBe("pure-model")
  })
  beforeEach(() => {
    mockHasNoLeakingPiiDeep.mockReset().mockReturnValue(true)
  })

  it("uses the shared provider pipeline, redacts cloud text, and excludes references", async () => {
    const snapshot = jest.fn(() => ({ snapshot: true }))
    const resolve = jest.fn(() => ({
      kind: "resolved" as const,
      providerId: "cloud",
      protocol: "openai" as const,
      apiKey: "secret",
      baseURL: undefined,
      model: "configured",
      isCustomProvider: false,
      useProxy: false,
    }))
    const model = { id: "model" }
    const createModel = jest.fn(() => model)
    const generate = jest.fn(async (..._args: unknown[]) => ({
      text: "answer",
      usage: { inputTokens: 100, outputTokens: 20 },
      finishReason: "stop",
    }))
    const target = createPureModelEvalTarget(
      {
        label: "Cloud variant",
        reasoningEffort: "low",
        providerId: "cloud",
        modelId: "model-a",
        isLocal: false,
        price: { inputPerMillion: 1, outputPerMillion: 2, currency: "USD" },
        settings: {
          defaultProvider: "cloud",
          providerSettings: {},
          customProviders: [],
        },
      },
      {
        createSnapshot: snapshot as never,
        resolveProvider: resolve as never,
        createModel: createModel as never,
        generateText: generate as never,
        resolveAsset: async () => ({ data: "AAAA", mediaType: "image/png" }),
        now: (() => {
          let now = 100
          return () => (now += 25)
        })(),
      }
    )

    const result = await target.run(evalCase)

    expect(snapshot).toHaveBeenCalledTimes(1)
    expect(resolve).toHaveBeenCalledWith(
      expect.objectContaining({ featureId: "eval.pure-model", providerId: "cloud" }),
      expect.anything()
    )
    expect(createModel).toHaveBeenCalledWith(expect.objectContaining({ model: "model-a" }))
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: { openai: { reasoningEffort: "low" } },
      })
    )
    const payload = JSON.stringify(generate.mock.calls[0][0])
    expect(generate.mock.calls[0][0]).toMatchObject({ maxRetries: 0 })
    expect(payload).toContain("<EMAIL_001>")
    expect(payload).not.toContain("alice@example.com")
    expect(payload).not.toContain("never send this answer")
    expect(payload).toContain("image/png")
    expect(result).toMatchObject({
      output: "answer",
      latencyMs: 25,
      costUsd: 0.00014,
      usage: { inputTokens: 100, outputTokens: 20 },
      degraded: false,
    })
    expect(result.redactionPolicy).toBe("cloud-redacted")
    expect(result.redactionDigest).toMatch(/^sha256:/)
  })

  it("sends original text only to confirmed local providers", async () => {
    const generate = jest.fn(async (..._args: unknown[]) => ({
      text: "local",
      usage: { inputTokens: 1, outputTokens: 1 },
      finishReason: "stop",
    }))
    const target = createPureModelEvalTarget(
      {
        label: "Local",
        providerId: "ollama",
        modelId: "local-model",
        isLocal: true,
        settings: { defaultProvider: "ollama", providerSettings: {}, customProviders: [] },
      },
      {
        createSnapshot: (() => ({})) as never,
        resolveProvider: (() => ({
          kind: "resolved",
          providerId: "ollama",
          protocol: "openai",
          baseURL: "http://localhost:11434/v1",
          model: "local-model",
          isCustomProvider: false,
          useProxy: false,
        })) as never,
        createModel: (() => ({})) as never,
        generateText: generate as never,
        resolveAsset: async () => ({ data: "AAAA", mediaType: "image/png" }),
        now: () => 1,
      }
    )

    const result = await target.run({ ...evalCase, contentParts: undefined })

    expect(JSON.stringify(generate.mock.calls[0][0])).toContain("alice@example.com")
    expect(result.costUsd).toBe(0)
    expect(result.redactionPolicy).toBe("local-original")
  })

  it("fails closed before provider dispatch when the redacted payload still contains PII", async () => {
    const prepared = jest.fn()
    const generate = jest.fn(async (..._args: unknown[]) => ({
      text: "should not run",
      usage: { inputTokens: 1, outputTokens: 1 },
      finishReason: "stop",
    }))
    mockHasNoLeakingPiiDeep.mockReturnValue(false)
    const target = createPureModelEvalTarget(
      {
        label: "Cloud",
        providerId: "cloud",
        modelId: "model",
        isLocal: false,
        onPreparedTextParts: prepared,
        settings: { defaultProvider: "cloud", providerSettings: {}, customProviders: [] },
      },
      {
        createSnapshot: (() => ({})) as never,
        resolveProvider: (() => ({
          kind: "resolved",
          providerId: "cloud",
          protocol: "openai",
          model: "model",
          isCustomProvider: false,
          useProxy: false,
        })) as never,
        createModel: (() => ({})) as never,
        generateText: generate as never,
        resolveAsset: async () => ({ data: "AAAA", mediaType: "image/png" }),
        now: () => 1,
      }
    )

    await expect(target.run({ ...evalCase, contentParts: undefined })).rejects.toThrow(
      "PII redaction gate"
    )
    expect(generate).not.toHaveBeenCalled()
    expect(prepared).not.toHaveBeenCalled()
  })

  it("rejects cloud media that has not passed privacy clearance", async () => {
    const target = createPureModelEvalTarget(
      {
        label: "Cloud",
        providerId: "cloud",
        modelId: "model",
        isLocal: true,
        settings: { defaultProvider: "cloud", providerSettings: {}, customProviders: [] },
      },
      {
        createSnapshot: (() => ({})) as never,
        resolveProvider: (() => ({ kind: "resolved" })) as never,
        createModel: (() => ({})) as never,
        generateText: jest.fn() as never,
        resolveAsset: jest.fn() as never,
        now: () => 1,
      }
    )

    await expect(
      target.run({
        ...evalCase,
        contentParts: [
          {
            type: "asset",
            assetId: "private",
            mediaType: "application/pdf",
            privacy: "local-only",
          },
        ],
      })
    ).rejects.toThrow(/privacy clearance/i)
  })
})

/**
 * The host seam the pure packages' generations run through (ADR-0188 D27).
 *
 * The AI SDK is mocked because one case drives a real package function
 * (`chunkDocumentAsync`) through the seam: that is semantic chunking's nearest
 * host boundary, since no app code builds a `RAGPipeline` yet.
 */

jest.mock("ai", () => ({ generateText: jest.fn(), streamText: jest.fn() }))

import { generateText } from "ai"
import type { LanguageModel } from "ai"
import { chunkDocumentAsync } from "@cognia/provider-embedding/chunking"
import type {
  GenerationOverrides,
  GenerationSeam,
  GenerationSend,
} from "@cognia/provider-embedding/generation-seam"
import type * as WebSearchSeam from "@cognia/web-search/generation-seam"

import { __resetBreakerForTesting, getBreakerSnapshot } from "@/lib/router-fusion/gate/breaker"
import { RouterFusionRefusalError } from "@/lib/router-fusion/gate/faults"
import type { RouterFusionHost } from "@/lib/router-fusion/gate/load-engine"
import type {
  BeginLedgeredUtilityCallInput,
  UtilityCallHandleLike,
  UtilityGrant,
} from "@/lib/router-fusion/gate/utility-ledger"

import { ledgeredGenerationSeam, resolveLedgeredGenerationSeam } from "./ledgered-generation-seam"

const mockedGenerateText = generateText as jest.Mock

const ON = { routerFusion: { enabled: true, surfaces: { utilityLedger: true } } }
const OFF = { routerFusion: { enabled: false, surfaces: { utilityLedger: true } } }

const BINDING = {
  surface: "utilityLedger" as const,
  origin: "utility" as const,
  featureId: "project-knowledge-expansion",
  providerId: "anthropic",
  workspaceId: "project-1",
}

function fakeHandle(maxOutputTokens = 256) {
  const booked: { kind: string; usage?: unknown; reason?: string }[] = []
  const handle: UtilityCallHandleLike = {
    runId: "run-1",
    maxOutputTokens,
    async succeeded(usage) {
      booked.push({ kind: "succeeded", usage })
    },
    async failed(errorClass, usage = null) {
      booked.push({ kind: `failed:${errorClass}`, usage })
    },
    async unknown(reason) {
      booked.push({ kind: "unknown", reason })
    },
  }
  return { handle, booked }
}

/** A fusion host whose reservation is granted, refused, or faults on load. */
function fakeHost(grant: UtilityGrant | "fault") {
  const seen: BeginLedgeredUtilityCallInput[] = []
  const loadHost = async (): Promise<RouterFusionHost> => {
    if (grant === "fault") throw new Error("fusion database unavailable")
    return {
      beginLedgeredUtilityCall: async (input: BeginLedgeredUtilityCallInput) => {
        seen.push(input)
        return grant
      },
    } as unknown as RouterFusionHost
  }
  return { loadHost, seen }
}

/** The package side of the seam: records the overrides and reports usage. */
function fakeSend(text = "expanded") {
  const overrides: GenerationOverrides[] = []
  const send: GenerationSend = async (over) => {
    overrides.push(over)
    return { text, usage: { inputTokens: 100, outputTokens: 20 } }
  }
  return { send, overrides }
}

const REQUEST = {
  stage: "rag.hyde",
  modelId: "claude-haiku-4-5",
  prompt: "what is a ledger",
  temperature: 0.3,
}

beforeEach(() => {
  __resetBreakerForTesting()
  mockedGenerateText.mockReset()
})

describe("ledgeredGenerationSeam", () => {
  it("[ACC:OFF-03] injects no seam at all while the utility switch is off", () => {
    expect(ledgeredGenerationSeam({ binding: BINDING, settings: OFF })).toBeUndefined()
    expect(ledgeredGenerationSeam({ binding: BINDING, settings: null })).toBeUndefined()
  })

  it("reserves the call, bounds its output and stops the SDK's hidden retries", async () => {
    const { handle, booked } = fakeHandle()
    const { loadHost, seen } = fakeHost({ kind: "granted", handle })
    const { send, overrides } = fakeSend()
    const seam = ledgeredGenerationSeam({ binding: BINDING, settings: ON, loadHost })

    await expect(seam?.(REQUEST, send)).resolves.toBe("expanded")
    expect(seen[0]).toMatchObject({
      featureId: "project-knowledge-expansion:rag.hyde",
      providerId: "anthropic",
      modelId: "claude-haiku-4-5",
      prompt: "what is a ledger",
      workspaceId: "project-1",
    })
    expect(overrides).toEqual([{ maxOutputTokens: 256, maxRetries: 0 }])
    expect(booked).toEqual([{ kind: "succeeded", usage: { inputTokens: 100, outputTokens: 20 } }])
  })

  it("[ACC:ISO-04] raises a refusal and never sends the call", async () => {
    const { loadHost } = fakeHost({ kind: "refused", code: "RUN_CAP_EXCEEDED" })
    const { send, overrides } = fakeSend()
    const seam = ledgeredGenerationSeam({ binding: BINDING, settings: ON, loadHost })

    await expect(seam?.(REQUEST, send)).rejects.toBeInstanceOf(RouterFusionRefusalError)
    expect(overrides).toHaveLength(0)
    // A refusal is an answer, not a fault: the breaker stays clean.
    expect(getBreakerSnapshot("utilityLedger").consecutiveFaults).toBe(0)
  })

  it("[ACC:ISO-01] sends the package's own call, unledgered, when the ledger faults", async () => {
    const { loadHost } = fakeHost("fault")
    const { send, overrides } = fakeSend()
    const seam = ledgeredGenerationSeam({ binding: BINDING, settings: ON, loadHost })

    await expect(seam?.(REQUEST, send)).resolves.toBe("expanded")
    // No override: the call is byte-for-byte the one the package always made.
    expect(overrides).toEqual([{}])
    expect(getBreakerSnapshot("utilityLedger").consecutiveFaults).toBe(1)
  })

  it("books a provider failure at its class and still raises it", async () => {
    const { handle, booked } = fakeHandle()
    const { loadHost } = fakeHost({ kind: "granted", handle })
    const failure = Object.assign(new Error("overloaded"), { statusCode: 429 })
    const seam = ledgeredGenerationSeam({ binding: BINDING, settings: ON, loadHost })

    await expect(
      seam?.(REQUEST, async () => {
        throw failure
      })
    ).rejects.toBe(failure)
    expect(booked).toEqual([{ kind: "failed:rate_limited", usage: null }])
  })
})

describe("resolveLedgeredGenerationSeam", () => {
  const resolveBinding = jest.fn(async () => ({
    origin: "utility" as const,
    featureId: "project-knowledge-expansion",
    providerId: "anthropic",
    workspaceId: "project-1",
  }))

  beforeEach(() => resolveBinding.mockClear())

  it("[ACC:OFF-03] never even reads the binding while the switch is off", async () => {
    await expect(
      resolveLedgeredGenerationSeam({ surface: "utilityLedger", settings: OFF, resolveBinding })
    ).resolves.toBeUndefined()
    expect(resolveBinding).not.toHaveBeenCalled()
  })

  it("builds the seam from the resolved binding when the switch is on", async () => {
    const { handle } = fakeHandle()
    const { loadHost, seen } = fakeHost({ kind: "granted", handle })
    const seam = await resolveLedgeredGenerationSeam({
      surface: "utilityLedger",
      settings: ON,
      resolveBinding,
      loadHost,
    })
    await seam?.(REQUEST, fakeSend().send)
    expect(seen[0].featureId).toBe("project-knowledge-expansion:rag.hyde")
  })

  it("[ACC:ISO-01] falls back to no seam, and counts the fault, when the binding read fails", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    resolveBinding.mockRejectedValueOnce(new Error("settings row unreadable"))

    await expect(
      resolveLedgeredGenerationSeam({ surface: "utilityLedger", settings: ON, resolveBinding })
    ).resolves.toBeUndefined()
    expect(getBreakerSnapshot("utilityLedger").consecutiveFaults).toBe(1)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("unledgered"),
      expect.objectContaining({ code: "internal" })
    )
    warn.mockRestore()
  })
})

describe("the seam at a package's own boundary (semantic chunking)", () => {
  const model = { modelId: "claude-haiku-4-5" } as unknown as LanguageModel
  const document = `${"paragraph one. ".repeat(40)}\n\n${"paragraph two. ".repeat(40)}`

  it("runs the package's generation through the ledger when the switch is on", async () => {
    mockedGenerateText.mockResolvedValue({
      text: "[300]",
      usage: { inputTokens: 80, outputTokens: 12 },
    })
    const { handle } = fakeHandle(512)
    const { loadHost, seen } = fakeHost({ kind: "granted", handle })
    const generate = ledgeredGenerationSeam({
      binding: { ...BINDING, featureId: "project-knowledge-ingest", workspaceId: null },
      settings: ON,
      loadHost,
    }) as GenerationSeam

    const result = await chunkDocumentAsync(document, { strategy: "semantic", model, generate })

    expect(result.strategy).toBe("semantic")
    expect(seen[0]).toMatchObject({
      featureId: "project-knowledge-ingest:embedding.semantic-chunking",
      modelId: "claude-haiku-4-5",
    })
    expect(mockedGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({ model, temperature: 0.1, maxOutputTokens: 512, maxRetries: 0 })
    )
  })

  it("[ACC:OFF-02] makes the identical call with no seam injected", async () => {
    mockedGenerateText.mockResolvedValue({ text: "[300]" })

    await chunkDocumentAsync(document, { strategy: "semantic", model })

    const args = mockedGenerateText.mock.calls[0][0] as Record<string, unknown>
    expect(Object.keys(args).sort()).toEqual(["model", "prompt", "temperature"])
    expect(args).toMatchObject({ model, temperature: 0.1 })
  })
})

describe("the two package seam contracts", () => {
  it("are the same shape, so this one host seam satisfies both", () => {
    // Compile-time pin: a drift in either package's copy fails `tsc` here, the
    // one place that has to satisfy both.
    const fromEmbedding: GenerationSeam = async () => ""
    const forWebSearch: WebSearchSeam.GenerationSeam = fromEmbedding
    const back: GenerationSeam = forWebSearch
    expect(typeof back).toBe("function")
  })
})

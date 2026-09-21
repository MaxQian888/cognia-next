/**
 * The ledger seam for direct AI SDK generations (ADR-0188 D27, WP-L1).
 *
 * `ai` is mocked because this module reaches `readUsageDelta` through
 * `lib/twin/distill/llm`, which imports the SDK; the normalizer's own shapes
 * are pinned in `lib/twin/distill/llm.test.ts`.
 */

jest.mock("ai", () => ({ generateText: jest.fn(), streamText: jest.fn() }))

import { __resetBreakerForTesting, getBreakerSnapshot } from "@/lib/router-fusion/gate/breaker"
import { RouterFusionRefusalError } from "@/lib/router-fusion/gate/faults"
import type { RouterFusionHost } from "@/lib/router-fusion/gate/load-engine"
import type {
  BeginLedgeredUtilityCallInput,
  UtilityCallHandleLike,
  UtilityGrant,
} from "@/lib/router-fusion/gate/utility-ledger"

import {
  beginLedgeredGeneration,
  usageOfResult,
  withLedgeredGeneration,
  type LedgeredUtilityBinding,
} from "./ledgered-model-call"

const ON = { routerFusion: { enabled: true, surfaces: { utilityLedger: true } } }
const OFF = { routerFusion: { enabled: false, surfaces: { utilityLedger: true } } }

const BINDING: LedgeredUtilityBinding = {
  surface: "utilityLedger",
  origin: "utility",
  featureId: "canvas-suggestions",
  providerId: "anthropic",
  modelId: "claude-haiku-4-5",
  workspaceId: null,
}

function fakeHandle(maxOutputTokens = 512) {
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

beforeEach(() => {
  __resetBreakerForTesting()
  jest.restoreAllMocks()
})

describe("beginLedgeredGeneration", () => {
  it("returns null with the surface off, without loading the host", async () => {
    const host = fakeHost({ kind: "granted", handle: fakeHandle().handle })
    const loadHost = jest.fn(host.loadHost)
    const lease = await beginLedgeredGeneration({
      binding: BINDING,
      prompt: "hello",
      settings: OFF,
      loadHost,
    })
    expect(lease).toBeNull()
    expect(loadHost).not.toHaveBeenCalled()
  })

  it("reserves the call with the prompt and the caller's cap, and pins maxRetries to 0", async () => {
    const { handle } = fakeHandle(900)
    const host = fakeHost({ kind: "granted", handle })
    const lease = await beginLedgeredGeneration({
      binding: BINDING,
      prompt: "document",
      system: "be terse",
      maxOutputTokens: 200,
      settings: ON,
      loadHost: host.loadHost,
    })
    expect(host.seen[0]).toMatchObject({
      featureId: "canvas-suggestions",
      prompt: "document",
      system: "be terse",
      maxOutputTokens: 200,
      surface: "utilityLedger",
    })
    expect(lease?.options).toEqual({ maxRetries: 0, maxOutputTokens: 200 })
  })

  it("binds the reservation's output cap when the caller declared none", async () => {
    const host = fakeHost({ kind: "granted", handle: fakeHandle(777).handle })
    const lease = await beginLedgeredGeneration({
      binding: BINDING,
      prompt: "document",
      settings: ON,
      loadHost: host.loadHost,
    })
    expect(lease?.options.maxOutputTokens).toBe(777)
  })

  it("raises a refusal instead of making the call", async () => {
    const host = fakeHost({ kind: "refused", code: "BUDGET_EXHAUSTED", reasons: ["cap"] })
    await expect(
      beginLedgeredGeneration({
        binding: BINDING,
        prompt: "document",
        settings: ON,
        loadHost: host.loadHost,
      })
    ).rejects.toBeInstanceOf(RouterFusionRefusalError)
  })

  it("falls back to the original path on an infrastructure fault and feeds the breaker", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {})
    const host = fakeHost("fault")
    const lease = await beginLedgeredGeneration({
      binding: BINDING,
      prompt: "document",
      settings: ON,
      loadHost: host.loadHost,
    })
    expect(lease).toBeNull()
    expect(getBreakerSnapshot("utilityLedger").consecutiveFaults).toBe(1)
  })

  it("reads the host's settings when the caller passes none, and treats an unreadable switch as off", async () => {
    const host = fakeHost({ kind: "granted", handle: fakeHandle().handle })
    jest.spyOn(console, "warn").mockImplementation(() => {})
    const lease = await beginLedgeredGeneration({
      binding: BINDING,
      prompt: "document",
      loadHost: host.loadHost,
      readSettings: async () => {
        throw new Error("no settings store on this host")
      },
    })
    expect(lease).toBeNull()
  })

  it("books an abort as unknown, so money for a call that already left stays held", async () => {
    const { handle, booked } = fakeHandle()
    const host = fakeHost({ kind: "granted", handle })
    const lease = await beginLedgeredGeneration({
      binding: BINDING,
      prompt: "document",
      settings: ON,
      loadHost: host.loadHost,
    })
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" })
    await lease?.failed(abort)
    expect(booked).toEqual([{ kind: "unknown", reason: "aborted_before_answer" }])
  })

  it("classifies a provider status into the ledger's error class", async () => {
    const { handle, booked } = fakeHandle()
    const host = fakeHost({ kind: "granted", handle })
    const lease = await beginLedgeredGeneration({
      binding: BINDING,
      prompt: "document",
      settings: ON,
      loadHost: host.loadHost,
    })
    await lease?.failed(Object.assign(new Error("slow down"), { statusCode: 429 }))
    expect(booked[0].kind).toBe("failed:rate_limited")
  })

  it("never throws a settle failure at the caller", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {})
    const handle: UtilityCallHandleLike = {
      runId: "run-1",
      maxOutputTokens: 100,
      succeeded: async () => {
        throw new Error("ledger write failed")
      },
      failed: async () => {},
      unknown: async () => {},
    }
    const host = fakeHost({ kind: "granted", handle })
    const lease = await beginLedgeredGeneration({
      binding: BINDING,
      prompt: "document",
      settings: ON,
      loadHost: host.loadHost,
    })
    await expect(lease?.succeeded({ inputTokens: 1, outputTokens: 1 })).resolves.toBeUndefined()
  })
})

describe("usageOfResult", () => {
  it("reads the ai@7 nested cache counts", () => {
    expect(
      usageOfResult({
        inputTokens: 100,
        outputTokens: 20,
        inputTokenDetails: { cacheReadTokens: 40, cacheWriteTokens: 5 },
      })
    ).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 40,
      cacheWriteTokens: 5,
    })
  })

  it("answers null when the provider reported nothing", () => {
    expect(usageOfResult(undefined)).toBeNull()
    expect(usageOfResult({ inputTokens: 0, outputTokens: 0 })).toBeNull()
  })
})

describe("withLedgeredGeneration", () => {
  it("runs with no options and books nothing while the surface is off", async () => {
    const run = jest.fn(async () => ({ text: "hi" }))
    const result = await withLedgeredGeneration({
      binding: BINDING,
      prompt: "document",
      settings: OFF,
      run,
      usageOf: () => null,
    })
    expect(result).toEqual({ text: "hi" })
    expect(run).toHaveBeenCalledWith(undefined)
  })

  it("settles a successful call from the result's usage", async () => {
    const { handle, booked } = fakeHandle(300)
    const host = fakeHost({ kind: "granted", handle })
    const seenOptions: unknown[] = []
    await withLedgeredGeneration({
      binding: BINDING,
      prompt: "document",
      settings: ON,
      loadHost: host.loadHost,
      run: async (options) => {
        seenOptions.push(options)
        return { usage: { inputTokens: 90, outputTokens: 12 } }
      },
      usageOf: (result) => usageOfResult(result.usage),
    })
    expect(seenOptions).toEqual([{ maxRetries: 0, maxOutputTokens: 300 }])
    expect(booked).toEqual([{ kind: "succeeded", usage: { inputTokens: 90, outputTokens: 12 } }])
  })

  it("books a failure and rethrows the provider's error", async () => {
    const { handle, booked } = fakeHandle()
    const host = fakeHost({ kind: "granted", handle })
    await expect(
      withLedgeredGeneration({
        binding: BINDING,
        prompt: "document",
        settings: ON,
        loadHost: host.loadHost,
        run: async () => {
          throw Object.assign(new Error("boom"), { statusCode: 500 })
        },
        usageOf: () => null,
      })
    ).rejects.toThrow("boom")
    expect(booked[0].kind).toBe("failed:server_error")
  })
})

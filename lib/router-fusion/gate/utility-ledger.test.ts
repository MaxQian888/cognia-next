import type { RawUsage } from "@cognia/router-fusion"
import type { LlmClient, LlmClientCallOptions, LlmUsageSnapshot } from "@/lib/twin/distill/llm"

import { __resetBreakerForTesting, getBreakerSnapshot } from "./breaker"
import { reportLedgerBypass } from "./bypass-diagnostic"
import { RouterFusionRefusalError } from "./faults"
import type { RouterFusionHost } from "./load-engine"
import {
  classifyUtilityFailure,
  ledgerUtilityCalls,
  ledgeredLlmClient,
  rawUsageOf,
  usageDelta,
  type BeginLedgeredUtilityCallInput,
  type LedgeredUtilityBinding,
  type UtilityCallHandleLike,
  type UtilityGrant,
} from "./utility-ledger"

jest.mock("./bypass-diagnostic", () => ({ reportLedgerBypass: jest.fn() }))

const BINDING: LedgeredUtilityBinding = {
  surface: "utilityLedger",
  origin: "utility",
  featureId: "conversation-title",
  providerId: "openai",
  modelId: "gpt-5-mini",
  workspaceId: null,
}

const ON = {
  routerFusion: { enabled: true, surfaces: { utilityLedger: true } },
}
const OFF = { routerFusion: { enabled: false, surfaces: { utilityLedger: true } } }

/** A client whose cumulative snapshot grows by a fixed amount per call, like the real one. */
function fakeClient(
  options: {
    answer?: string
    perCall?: Partial<LlmUsageSnapshot>
    fail?: unknown
    withStream?: boolean
    withSnapshot?: boolean
  } = {}
) {
  const calls: { prompt: string; options: LlmClientCallOptions | undefined }[] = []
  const usage: LlmUsageSnapshot = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  const advance = () => {
    const per = options.perCall ?? { inputTokens: 100, outputTokens: 20 }
    usage.inputTokens += per.inputTokens ?? 0
    usage.outputTokens += per.outputTokens ?? 0
    usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + (per.cacheReadTokens ?? 0)
    usage.cacheCreationTokens = (usage.cacheCreationTokens ?? 0) + (per.cacheCreationTokens ?? 0)
    usage.totalTokens = usage.inputTokens + usage.outputTokens
  }
  const client: LlmClient = {
    provider: "openai",
    model: "gpt-5-mini",
    async complete(prompt, callOptions) {
      calls.push({ prompt, options: callOptions })
      if (options.fail) throw options.fail
      advance()
      return options.answer ?? "a title"
    },
    ...(options.withStream === false
      ? {}
      : {
          async *stream(prompt: string, callOptions?: LlmClientCallOptions) {
            calls.push({ prompt, options: callOptions })
            if (options.fail) throw options.fail
            yield options.answer ?? "a title"
            advance()
          },
        }),
    ...(options.withSnapshot === false ? {} : { getUsageSnapshot: () => ({ ...usage }) }),
  }
  return { client, calls }
}

function fakeHandle() {
  const booked: { kind: string; usage?: RawUsage | null; reason?: string }[] = []
  const handle: UtilityCallHandleLike = {
    runId: "run-1",
    maxOutputTokens: 256,
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

beforeEach(() => {
  __resetBreakerForTesting()
  ;(reportLedgerBypass as jest.Mock).mockClear()
})

/**
 * A client like the real one: every call reports its own usage through
 * `onUsage` and also moves the shared cumulative snapshot. Each call waits for
 * its gate, so a test decides the order the calls finish in.
 */
function perCallClient() {
  const usage: LlmUsageSnapshot = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  const gates: Array<() => void> = []
  const calls: Array<LlmClientCallOptions | undefined> = []
  const client: LlmClient = {
    reportsCallUsage: true,
    async complete(prompt, options) {
      calls.push(options)
      await new Promise<void>((resolve) => gates.push(resolve))
      const tokens = Number(prompt)
      usage.inputTokens += tokens
      usage.outputTokens += 1
      usage.totalTokens = usage.inputTokens + usage.outputTokens
      options?.onUsage?.({
        inputTokens: tokens,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      })
      return `answer ${prompt}`
    },
    getUsageSnapshot: () => ({ ...usage }),
  }
  return { client, gates, calls }
}

/** Resolve pending promise callbacks until `condition` holds. */
async function until(condition: () => boolean) {
  for (let i = 0; i < 50 && !condition(); i++) await Promise.resolve()
  expect(condition()).toBe(true)
}

describe("usageDelta", () => {
  it("reports what one call added, not the running total", () => {
    expect(
      usageDelta(
        { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
        { inputTokens: 110, outputTokens: 22, totalTokens: 132, cacheReadTokens: 5 }
      )
    ).toEqual({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 5 })
  })

  it("reads a snapshot that did not move as unknown, not as free", () => {
    const flat: LlmUsageSnapshot = { inputTokens: 7, outputTokens: 1, totalTokens: 8 }
    expect(usageDelta(flat, flat)).toBeNull()
    expect(usageDelta(undefined, undefined)).toBeNull()
  })
})

describe("rawUsageOf", () => {
  it("maps one call's report onto the ledger's buckets and reads nothing as unknown", () => {
    expect(
      rawUsageOf({ inputTokens: 9, outputTokens: 3, cacheReadTokens: 2, cacheCreationTokens: 1 })
    ).toEqual({ inputTokens: 9, outputTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 1 })
    expect(
      rawUsageOf({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 })
    ).toBeNull()
    expect(rawUsageOf(undefined)).toBeNull()
  })
})

describe("classifyUtilityFailure", () => {
  it("separates what was never sent from what was sent and never answered", () => {
    expect(classifyUtilityFailure(Object.assign(new Error("x"), { name: "AbortError" }))).toBe(
      "cancelled"
    )
    expect(classifyUtilityFailure(new TypeError("fetch failed"))).toBe("not_sent")
    expect(classifyUtilityFailure(Object.assign(new Error("slow"), { statusCode: 429 }))).toBe(
      "rate_limited"
    )
    expect(classifyUtilityFailure(Object.assign(new Error("nope"), { status: 401 }))).toBe("auth")
    expect(classifyUtilityFailure(Object.assign(new Error("bad"), { statusCode: 422 }))).toBe(
      "invalid_request"
    )
    expect(classifyUtilityFailure(Object.assign(new Error("oops"), { statusCode: 503 }))).toBe(
      "server_error"
    )
    expect(classifyUtilityFailure("something else")).toBe("server_error")
  })
})

describe("ledgeredLlmClient", () => {
  it("reserves the call, caps the AI SDK's own retries and books what it cost", async () => {
    const { client, calls } = fakeClient()
    const { handle, booked } = fakeHandle()
    const seen: BeginLedgeredUtilityCallInput[] = []
    const wrapped = ledgeredLlmClient(client, BINDING, {
      begin: async (input) => {
        seen.push(input)
        return { kind: "granted", handle }
      },
    })

    await expect(wrapped.complete("summarize", { system: "be brief" })).resolves.toBe("a title")
    expect(seen[0]).toMatchObject({
      featureId: "conversation-title",
      prompt: "summarize",
      system: "be brief",
      providerId: "openai",
    })
    expect(calls[0].options).toMatchObject({ maxRetries: 0, maxTokens: 256, system: "be brief" })
    expect(booked).toEqual([{ kind: "succeeded", usage: { inputTokens: 100, outputTokens: 20 } }])
  })

  it("leaves an output bound the caller set alone", async () => {
    const { client, calls } = fakeClient()
    const { handle } = fakeHandle()
    const wrapped = ledgeredLlmClient(client, BINDING, {
      begin: async () => ({ kind: "granted", handle }),
    })
    await wrapped.complete("x", { maxTokens: 32 })
    expect(calls[0].options).toMatchObject({ maxTokens: 32, maxRetries: 0 })
  })

  it("raises a refusal and never calls the provider", async () => {
    const { client, calls } = fakeClient()
    const wrapped = ledgeredLlmClient(client, BINDING, {
      begin: async () => ({ kind: "refused", code: "RUN_CAP_EXCEEDED", reasons: ["no budget"] }),
    })
    await expect(wrapped.complete("x")).rejects.toBeInstanceOf(RouterFusionRefusalError)
    await expect(wrapped.complete("x")).rejects.toMatchObject({ code: "RUN_CAP_EXCEEDED" })
    expect(calls).toHaveLength(0)
  })

  it("sends the call unledgered, with the caller's own options, when the ledger bypassed it", async () => {
    const { client, calls } = fakeClient()
    const wrapped = ledgeredLlmClient(client, BINDING, { begin: async () => null })
    await expect(wrapped.complete("x", { maxTokens: 8 })).resolves.toBe("a title")
    expect(calls[0].options).toEqual({ maxTokens: 8 })
    expect(calls[0].options).not.toHaveProperty("maxRetries")
  })

  it("books a failure at its class and still lets the caller see the error", async () => {
    const failure = Object.assign(new Error("overloaded"), { statusCode: 429 })
    const { client } = fakeClient({ fail: failure })
    const { handle, booked } = fakeHandle()
    const wrapped = ledgeredLlmClient(client, BINDING, {
      begin: async () => ({ kind: "granted", handle }),
    })
    await expect(wrapped.complete("x")).rejects.toBe(failure)
    expect(booked).toEqual([{ kind: "failed:rate_limited", usage: null }])
  })

  it("books an aborted call as sent-with-no-answer, so its money stays held", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" })
    const { client } = fakeClient({ fail: abort })
    const { handle, booked } = fakeHandle()
    const wrapped = ledgeredLlmClient(client, BINDING, {
      begin: async () => ({ kind: "granted", handle }),
    })
    await expect(wrapped.complete("x")).rejects.toBe(abort)
    expect(booked).toEqual([{ kind: "unknown", reason: "aborted_before_answer" }])
  })

  it("does not let a failed booking become the caller's error", async () => {
    const { client } = fakeClient()
    const wrapped = ledgeredLlmClient(client, BINDING, {
      begin: async () => ({
        kind: "granted",
        handle: {
          runId: "r",
          maxOutputTokens: 16,
          succeeded: async () => {
            throw new Error("the fusion database closed")
          },
          failed: async () => {},
          unknown: async () => {},
        },
      }),
    })
    const spy = jest.spyOn(console, "error").mockImplementation(() => {})
    await expect(wrapped.complete("x")).resolves.toBe("a title")
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it("settles a stream once it has finished producing text", async () => {
    const { client, calls } = fakeClient()
    const { handle, booked } = fakeHandle()
    const wrapped = ledgeredLlmClient(client, BINDING, {
      begin: async () => ({ kind: "granted", handle }),
    })
    const chunks: string[] = []
    for await (const chunk of wrapped.stream!("x")) chunks.push(chunk)
    expect(chunks).toEqual(["a title"])
    expect(calls[0].options).toMatchObject({ maxRetries: 0 })
    expect(booked).toEqual([{ kind: "succeeded", usage: { inputTokens: 100, outputTokens: 20 } }])
  })

  it("books a broken stream as sent-with-no-answer unless it never connected", async () => {
    const midStream = Object.assign(new Error("connection reset"), { statusCode: 500 })
    const { client } = fakeClient({ fail: midStream })
    const { handle, booked } = fakeHandle()
    const wrapped = ledgeredLlmClient(client, BINDING, {
      begin: async () => ({ kind: "granted", handle }),
    })
    await expect(
      (async () => {
        for await (const _chunk of wrapped.stream!("x")) void _chunk
      })()
    ).rejects.toBe(midStream)
    expect(booked).toEqual([{ kind: "unknown", reason: "stream_server_error" }])

    const never = new TypeError("fetch failed")
    const second = fakeClient({ fail: never })
    const other = fakeHandle()
    const wrapped2 = ledgeredLlmClient(second.client, BINDING, {
      begin: async () => ({ kind: "granted", handle: other.handle }),
    })
    await expect(
      (async () => {
        for await (const _chunk of wrapped2.stream!("x")) void _chunk
      })()
    ).rejects.toBe(never)
    expect(other.booked).toEqual([{ kind: "failed:not_sent", usage: null }])
  })

  it("settles two concurrent calls on one client with each call's own tokens", async () => {
    // lib/twin/distill/orchestrator.ts runs its distill calls on one client at
    // once. Reading the cumulative snapshot, the call that finished second
    // would have booked the first one's tokens as its own too.
    const { client, gates } = perCallClient()
    const bookings: Array<{ run: string; usage: RawUsage | null }> = []
    let next = 0
    const wrapped = ledgeredLlmClient(client, BINDING, {
      begin: async () => {
        const run = `run-${++next}`
        return {
          kind: "granted",
          handle: {
            runId: run,
            maxOutputTokens: 64,
            succeeded: async (usage) => {
              bookings.push({ run, usage })
            },
            failed: async () => {},
            unknown: async () => {},
          },
        }
      },
    })
    expect(wrapped.reportsCallUsage).toBe(true)
    const callerUsage = jest.fn()
    const first = wrapped.complete("100", { onUsage: callerUsage })
    const second = wrapped.complete("7")
    // Both are in flight together: a per-call client is never serialized.
    await until(() => gates.length === 2)
    gates[1]()
    await expect(second).resolves.toBe("answer 7")
    gates[0]()
    await expect(first).resolves.toBe("answer 100")
    expect(bookings).toEqual([
      { run: "run-2", usage: { inputTokens: 7, outputTokens: 1 } },
      { run: "run-1", usage: { inputTokens: 100, outputTokens: 1 } },
    ])
    // The caller's own callback still hears its call.
    expect(callerUsage).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 100 }))
  })

  it("runs a snapshot-only client's calls one at a time, so each delta is its own", async () => {
    const usage: LlmUsageSnapshot = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
    const gates: Array<() => void> = []
    const client: LlmClient = {
      async complete(prompt) {
        await new Promise<void>((resolve) => gates.push(resolve))
        usage.inputTokens += Number(prompt)
        usage.outputTokens += 1
        usage.totalTokens = usage.inputTokens + usage.outputTokens
        return prompt
      },
      getUsageSnapshot: () => ({ ...usage }),
    }
    const { handle, booked } = fakeHandle()
    const begin = jest.fn(async (): Promise<UtilityGrant> => ({ kind: "granted", handle }))
    const wrapped = ledgeredLlmClient(client, BINDING, { begin })
    expect(wrapped.reportsCallUsage).toBeUndefined()
    const first = wrapped.complete("100")
    const second = wrapped.complete("7")
    await until(() => gates.length === 1)
    // The second call waits for the first, reservation included.
    expect(begin).toHaveBeenCalledTimes(1)
    gates[0]()
    await expect(first).resolves.toBe("100")
    await until(() => gates.length === 2)
    gates[1]()
    await expect(second).resolves.toBe("7")
    expect(booked).toEqual([
      { kind: "succeeded", usage: { inputTokens: 100, outputTokens: 1 } },
      { kind: "succeeded", usage: { inputTokens: 7, outputTokens: 1 } },
    ])
  })

  it("books a stream the consumer abandoned as sent-with-no-answer", async () => {
    const client: LlmClient = {
      complete: async () => "",
      async *stream() {
        yield "one"
        yield "two"
      },
    }
    const { handle, booked } = fakeHandle()
    const wrapped = ledgeredLlmClient(client, BINDING, {
      begin: async () => ({ kind: "granted", handle }),
    })
    for await (const chunk of wrapped.stream!("x")) {
      expect(chunk).toBe("one")
      break
    }
    expect(booked).toEqual([{ kind: "unknown", reason: "stream_abandoned" }])
  })

  it("carries the inner client's identity, and omits a stream it does not have", () => {
    const plain = fakeClient({ withStream: false, withSnapshot: false })
    const wrapped = ledgeredLlmClient(plain.client, BINDING, { begin: async () => null })
    expect(wrapped.provider).toBe("openai")
    expect(wrapped.model).toBe("gpt-5-mini")
    expect(wrapped.stream).toBeUndefined()
    expect(wrapped.getUsageSnapshot).toBeUndefined()
  })
})

describe("ledgerUtilityCalls", () => {
  it("[ACC:OFF-01] hands back the very client it was given while the switch is off", () => {
    const { client } = fakeClient()
    expect(ledgerUtilityCalls(client, { binding: BINDING, settings: OFF })).toBe(client)
    expect(ledgerUtilityCalls(client, { binding: BINDING, settings: null })).toBe(client)
    expect(
      ledgerUtilityCalls(client, {
        binding: BINDING,
        // The master switch alone is not enough; the surface has to be on too.
        settings: { routerFusion: { enabled: true, surfaces: {} } },
      })
    ).toBe(client)
  })

  it("[ACC:OFF-02] loads no Router + Fusion module for a call made while the switch is off", async () => {
    const { client } = fakeClient()
    const loadHost = jest.fn()
    const wrapped = ledgerUtilityCalls(client, {
      binding: BINDING,
      settings: OFF,
      loadHost: loadHost as unknown as () => Promise<RouterFusionHost>,
    })
    await wrapped.complete("x")
    expect(loadHost).not.toHaveBeenCalled()
  })

  it("reserves through the host once the switch is on", async () => {
    const { client, calls } = fakeClient()
    const { handle, booked } = fakeHandle()
    const beginLedgeredUtilityCall = jest.fn(async (): Promise<UtilityGrant> => ({
      kind: "granted",
      handle,
    }))
    const wrapped = ledgerUtilityCalls(client, {
      binding: BINDING,
      settings: ON,
      loadHost: async () => ({ beginLedgeredUtilityCall }) as unknown as RouterFusionHost,
    })
    await expect(wrapped.complete("x")).resolves.toBe("a title")
    expect(beginLedgeredUtilityCall).toHaveBeenCalledTimes(1)
    expect(calls[0].options).toMatchObject({ maxRetries: 0 })
    expect(booked).toEqual([{ kind: "succeeded", usage: { inputTokens: 100, outputTokens: 20 } }])
  })

  it("[ACC:ISO-01] sends the call on the original path when Router + Fusion faults, and counts it", async () => {
    const { client, calls } = fakeClient()
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    const wrapped = ledgerUtilityCalls(client, {
      binding: BINDING,
      settings: ON,
      loadHost: async () => {
        throw new Error("chunk load failed")
      },
    })
    await expect(wrapped.complete("x")).resolves.toBe("a title")
    // Unledgered means unledgered: the caller's own options, no retry cap.
    expect(calls[0].options).toBeUndefined()
    expect(getBreakerSnapshot("utilityLedger").consecutiveFaults).toBe(1)
    // Utilities have no message to badge: the bypass is raised as a diagnostic.
    expect(reportLedgerBypass).toHaveBeenCalledWith({
      surface: "utilityLedger",
      featureId: "conversation-title",
      fault: expect.objectContaining({ code: "internal" }),
    })
    warn.mockRestore()
  })

  it("[ACC:ISO-04] never bypasses a refusal", async () => {
    const { client, calls } = fakeClient()
    const wrapped = ledgerUtilityCalls(client, {
      binding: BINDING,
      settings: ON,
      loadHost: async () =>
        ({
          beginLedgeredUtilityCall: async (): Promise<UtilityGrant> => ({
            kind: "refused",
            code: "TENANT_LIMIT_EXCEEDED",
          }),
        }) as unknown as RouterFusionHost,
    })
    await expect(wrapped.complete("x")).rejects.toMatchObject({ code: "TENANT_LIMIT_EXCEEDED" })
    expect(calls).toHaveLength(0)
    // A refusal is the system working; it must not move the breaker.
    expect(getBreakerSnapshot("utilityLedger").consecutiveFaults).toBe(0)
  })
})

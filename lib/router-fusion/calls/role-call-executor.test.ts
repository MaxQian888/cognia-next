import type { AppSettings } from "@cognia/agent-config-types"
import type { RoleCallRequest } from "@cognia/router-fusion"

const resolveDeploymentLlmConfigMock = jest.fn(
  (..._args: unknown[]) =>
    ({
      provider: "openai",
      model: "gpt-5-mini",
      apiKey: "sk-test",
    }) as unknown
)
jest.mock("@/lib/ai/renderer-llm-client", () => ({
  resolveDeploymentLlmConfig: (...args: unknown[]) => resolveDeploymentLlmConfigMock(...args),
}))

import {
  createRoleCallExecutor,
  jsonSystemInstruction,
  mapFinishReason,
  retryAfterMs,
  splitDeploymentId,
  toRawUsage,
} from "./role-call-executor"

const APP = {} as AppSettings

function request(overrides: Partial<RoleCallRequest> = {}): RoleCallRequest {
  return {
    runId: "run-1",
    logicalStepId: "direct:solver",
    attemptId: "attempt-1",
    role: "solver",
    deploymentId: "openai::gpt-5-mini",
    messages: [{ role: "user", content: "hello" }],
    maxOutputTokens: 512,
    toolPolicyId: null,
    ...overrides,
  } as RoleCallRequest
}

const OK = {
  text: "an answer",
  usage: { inputTokens: 100, outputTokens: 20 },
  providerMetadata: undefined,
  response: { id: "resp_1" },
  finishReason: "stop",
}

function executor(overrides: Record<string, unknown> = {}) {
  return createRoleCallExecutor({
    appSettings: APP,
    languageModel: async () => ({ __model: true }),
    generate: (async () => OK) as never,
    now: () => 1_700_000_000_000,
    ...overrides,
  })
}

beforeEach(() => {
  resolveDeploymentLlmConfigMock.mockClear()
  resolveDeploymentLlmConfigMock.mockReturnValue({
    provider: "openai",
    model: "gpt-5-mini",
    apiKey: "sk-test",
  })
})

describe("splitDeploymentId", () => {
  it("reads the provider and model out of a deployment id, and rejects what is not one", () => {
    expect(splitDeploymentId("openai::gpt-5-mini")).toEqual({
      providerId: "openai",
      modelId: "gpt-5-mini",
    })
    // A custom model id may contain colons of its own.
    expect(splitDeploymentId("ollama::qwen3:32b")).toEqual({
      providerId: "ollama",
      modelId: "qwen3:32b",
    })
    expect(splitDeploymentId("gpt-5-mini")).toBeNull()
    expect(splitDeploymentId("::gpt-5")).toBeNull()
    expect(splitDeploymentId("openai::")).toBeNull()
  })
})

describe("toRawUsage", () => {
  it("renames the AI SDK's cache fields into the ledger's buckets", () => {
    expect(
      toRawUsage({ inputTokens: 100, outputTokens: 20, cachedInputTokens: 30 }, undefined)
    ).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 30,
    })
    expect(
      toRawUsage(
        { inputTokens: 5, outputTokens: 1 },
        {
          anthropic: { cacheCreationInputTokens: 7 },
        }
      )
    ).toEqual({ inputTokens: 5, outputTokens: 1, cacheWriteTokens: 7 })
    expect(toRawUsage(undefined, undefined)).toEqual({ inputTokens: 0, outputTokens: 0 })
  })
})

describe("mapFinishReason", () => {
  it("keeps the three the contract distinguishes and treats anything else as a stop", () => {
    expect(mapFinishReason("length")).toBe("length")
    expect(mapFinishReason("tool-calls")).toBe("tool_calls")
    expect(mapFinishReason("tool_calls")).toBe("tool_calls")
    expect(mapFinishReason("content-filter")).toBe("stop")
    expect(mapFinishReason(undefined)).toBe("stop")
  })
})

describe("retryAfterMs", () => {
  const now = 1_700_000_000_000
  it("reads seconds and HTTP dates, and nothing when the header is missing or nonsense", () => {
    expect(retryAfterMs({ responseHeaders: { "retry-after": "30" } }, now)).toBe(30_000)
    expect(
      retryAfterMs({ responseHeaders: { "Retry-After": new Date(now + 5_000).toUTCString() } }, now)
    ).toBeGreaterThanOrEqual(4_000)
    expect(retryAfterMs({ responseHeaders: {} }, now)).toBeUndefined()
    expect(retryAfterMs({ responseHeaders: { "retry-after": "soon" } }, now)).toBeUndefined()
    expect(retryAfterMs(new Error("x"), now)).toBeUndefined()
  })
})

describe("createRoleCallExecutor", () => {
  it("calls the pinned deployment with the SDK's own retries off", async () => {
    const generate = jest.fn(async (_options: Record<string, unknown>) => OK)
    const response = await executor({ generate }).call(request(), new AbortController().signal)
    expect(response).toMatchObject({
      outcome: "ok",
      text: "an answer",
      providerRequestId: "resp_1",
      finishReason: "stop",
      usage: { inputTokens: 100, outputTokens: 20 },
    })
    expect(generate.mock.calls[0][0]).toMatchObject({
      maxRetries: 0,
      maxOutputTokens: 512,
      messages: [{ role: "user", content: "hello" }],
    })
    expect(resolveDeploymentLlmConfigMock).toHaveBeenCalledWith(
      APP,
      "openai",
      "gpt-5-mini",
      "router-fusion:solver"
    )
  })

  it("asks for JSON without rewriting the caller's own messages", async () => {
    const generate = jest.fn(async (_options: Record<string, unknown>) => OK)
    const schema = { type: "object", required: ["title"] }
    await executor({ generate }).call(request({ jsonSchema: schema }), new AbortController().signal)
    const messages = generate.mock.calls[0][0].messages as { role: string; content: string }[]
    expect(messages[0].role).toBe("system")
    expect(messages[0].content).toContain(JSON.stringify(schema))
    expect(messages[1]).toEqual({ role: "user", content: "hello" })
    expect(jsonSystemInstruction(schema)).toContain("no markdown fences")
  })

  it("fails the attempt rather than calling another model when the deployment has no credentials", async () => {
    resolveDeploymentLlmConfigMock.mockReturnValue(null)
    const generate = jest.fn(async () => OK)
    const response = await executor({ generate }).call(request(), new AbortController().signal)
    expect(response).toMatchObject({ outcome: "error", errorClass: "auth" })
    expect(generate).not.toHaveBeenCalled()
  })

  it("refuses a deployment id it cannot read", async () => {
    const response = await executor().call(
      request({ deploymentId: "not-a-deployment" }),
      new AbortController().signal
    )
    expect(response).toMatchObject({ outcome: "error", errorClass: "invalid_request" })
  })

  it("classifies a provider failure and carries its retry-after through", async () => {
    const failure = Object.assign(new Error("slow down"), {
      statusCode: 429,
      responseHeaders: { "retry-after": "12" },
    })
    const generate = jest.fn(async () => {
      throw failure
    })
    const response = await executor({ generate }).call(request(), new AbortController().signal)
    expect(response).toEqual({
      outcome: "error",
      errorClass: "rate_limited",
      message: "slow down",
      retryAfterMs: 12_000,
    })
  })

  it("streams deltas to the caller and settles the usage once the stream ends", async () => {
    const deltas: string[] = []
    const stream = jest.fn(() => ({
      textStream: (async function* () {
        yield "an "
        yield "answer"
      })(),
      usage: Promise.resolve({ inputTokens: 9, outputTokens: 3 }),
      providerMetadata: Promise.resolve(undefined),
      response: Promise.resolve({ id: "resp_stream" }),
      finishReason: Promise.resolve("length"),
    }))
    const response = await executor({ stream }).call(
      request({ onDelta: (text) => deltas.push(text) }),
      new AbortController().signal
    )
    expect(deltas).toEqual(["an ", "answer"])
    expect(response).toMatchObject({
      outcome: "ok",
      text: "an answer",
      providerRequestId: "resp_stream",
      finishReason: "length",
      usage: { inputTokens: 9, outputTokens: 3 },
    })
  })
})

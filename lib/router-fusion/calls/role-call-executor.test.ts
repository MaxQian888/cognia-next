import type { AppSettings } from "@cognia/agent-config-types"
import type { ToolDescriptor } from "@cognia/router-fusion"
import type { RoleCallRequest } from "@cognia/router-fusion"
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider"
import { jsonSchema, tool } from "ai"
import { MockLanguageModelV4 } from "ai/test"

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
  finishReasonWithTools,
  jsonSystemInstruction,
  mapFinishReason,
  retryAfterMs,
  sdkPrompt,
  splitDeploymentId,
  toRawUsage,
  toSdkToolSet,
  toToolArguments,
  toToolIntents,
  UNPARSED_TOOL_ARGUMENTS_KEY,
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

  it("reads the cache counts ai@7 moved into the usage details", () => {
    expect(
      toRawUsage(
        {
          inputTokens: 100,
          outputTokens: 20,
          inputTokenDetails: { noCacheTokens: 70, cacheReadTokens: 30, cacheWriteTokens: 7 },
        },
        undefined
      )
    ).toEqual({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 7 })
    // The flat field still wins where a provider reports it, so nothing is counted twice.
    expect(
      toRawUsage(
        { inputTokens: 5, outputTokens: 1, cachedInputTokens: 2, inputTokenDetails: {} },
        undefined
      )
    ).toEqual({ inputTokens: 5, outputTokens: 1, cacheReadTokens: 2 })
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

  it("asks for JSON in the instructions, without rewriting the caller's own messages", async () => {
    const generate = jest.fn(async (_options: Record<string, unknown>) => OK)
    const schema = { type: "object", required: ["title"] }
    await executor({ generate }).call(request({ jsonSchema: schema }), new AbortController().signal)
    const options = generate.mock.calls[0][0]
    // `ai@7` refuses a system turn inside `messages`, so the ask travels in
    // `instructions` — ahead of the role's own system prompt, as it did when
    // both were messages.
    const instructions = options.instructions as { role: string; content: string }[]
    expect(instructions[0].role).toBe("system")
    expect(instructions[0].content).toContain(JSON.stringify(schema))
    expect(options.messages).toEqual([{ role: "user", content: "hello" }])
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

// ── tools (D26, DESIGN §11) ──────────────────────────────────────────────────

const WEB_FETCH: ToolDescriptor = {
  name: "web_fetch",
  description: "Read one public web page.",
  parameters: {
    type: "object",
    required: ["url"],
    additionalProperties: false,
    properties: { url: { type: "string" } },
  },
  toolClass: "read_only",
}

const V4_USAGE = {
  inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
}

type MockCall = LanguageModelV4CallOptions

/** A real AI SDK request against the SDK's own mock model; nothing is stubbed between. */
function mockModel(reply: (options: MockCall) => unknown) {
  const seen: MockCall[] = []
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      seen.push(options)
      return reply(options) as never
    },
  })
  return { seen, languageModel: async () => model, generate: undefined, stream: undefined }
}

function toolCallReply(toolName: string, input: string, unified = "tool-calls") {
  return () => ({
    content: [{ type: "tool-call", toolCallId: "call_1", toolName, input }],
    finishReason: { unified, raw: "tool_use" },
    usage: V4_USAGE,
    warnings: [],
    response: { id: "resp_tools" },
  })
}

describe("toSdkToolSet", () => {
  it("offers each descriptor with its JSON schema and no implementation", () => {
    const set = toSdkToolSet([WEB_FETCH], { tool, jsonSchema }) as Record<
      string,
      { description: string; inputSchema: { jsonSchema: unknown }; execute?: unknown }
    >
    expect(Object.keys(set)).toEqual(["web_fetch"])
    expect(set.web_fetch.description).toBe(WEB_FETCH.description)
    expect(set.web_fetch.inputSchema.jsonSchema).toEqual(WEB_FETCH.parameters)
    // No `execute`: the SDK has nothing to run, so a tool call comes back as a
    // request and the run's ToolRuntime decides it.
    expect(set.web_fetch.execute).toBeUndefined()
  })
})

describe("toToolArguments", () => {
  it("keeps an object as it is and carries anything else where no tool schema accepts it", () => {
    expect(toToolArguments({ url: "https://example.com" })).toEqual({
      url: "https://example.com",
    })
    expect(toToolArguments("{not json")).toEqual({
      [UNPARSED_TOOL_ARGUMENTS_KEY]: "{not json",
    })
    expect(toToolArguments(["a"])).toEqual({ [UNPARSED_TOOL_ARGUMENTS_KEY]: '["a"]' })
    expect(toToolArguments(undefined)).toEqual({ [UNPARSED_TOOL_ARGUMENTS_KEY]: null })
  })
})

describe("toToolIntents", () => {
  it("keeps the provider's call id, so a receipt answers the request that asked", () => {
    expect(
      toToolIntents([{ toolCallId: "call_7", toolName: "web_fetch", input: { url: "u" } }])
    ).toEqual([{ id: "call_7", name: "web_fetch", arguments: { url: "u" } }])
  })
})

describe("finishReasonWithTools", () => {
  it("reports a tool request whatever the provider called it, and never hides a truncation", () => {
    const calls = [{ id: "1", name: "web_fetch", arguments: {} }]
    expect(finishReasonWithTools("stop", calls)).toBe("tool_calls")
    expect(finishReasonWithTools("tool-calls", calls)).toBe("tool_calls")
    expect(finishReasonWithTools("length", calls)).toBe("length")
    expect(finishReasonWithTools("stop", [])).toBe("stop")
  })
})

describe("sdkPrompt", () => {
  it("hoists the leading system turns and refuses a call with nothing to answer", () => {
    const prompt = sdkPrompt([
      { role: "system", content: "you are a panel member" },
      { role: "user", content: "the contract" },
    ])
    expect(prompt).toMatchObject({
      ok: true,
      options: {
        instructions: [{ role: "system", content: "you are a panel member" }],
        messages: [{ role: "user", content: "the contract" }],
      },
    })
    expect(sdkPrompt([{ role: "system", content: "only a rule" }])).toEqual({
      ok: false,
      message: expect.stringContaining("non-system"),
    })
  })
})

describe("createRoleCallExecutor: tools", () => {
  it("offers the step's tools to the model and returns what it asked for, running nothing", async () => {
    const model = mockModel(toolCallReply("web_fetch", JSON.stringify({ url: "https://e.com" })))
    const response = await executor(model).call(
      request({
        messages: [
          { role: "system", content: "you are a panel member" },
          { role: "user", content: "what is the tariff?" },
        ],
        tools: [WEB_FETCH],
        toolPolicyId: "panel-read-1",
      }),
      new AbortController().signal
    )
    expect(response).toMatchObject({
      outcome: "ok",
      finishReason: "tool_calls",
      providerRequestId: "resp_tools",
      toolCalls: [{ id: "call_1", name: "web_fetch", arguments: { url: "https://e.com" } }],
    })
    // One request: no `execute` to run and no second generation of its own.
    expect(model.seen).toHaveLength(1)
    expect(model.seen[0].tools).toEqual([
      {
        type: "function",
        name: "web_fetch",
        description: WEB_FETCH.description,
        inputSchema: WEB_FETCH.parameters,
      },
    ])
    expect(model.seen[0].maxOutputTokens).toBe(512)
    // The role's system prompt reached the model as system content, not as a
    // message the SDK would refuse.
    expect(model.seen[0].prompt[0]).toMatchObject({
      role: "system",
      content: "you are a panel member",
    })
    expect(model.seen[0].prompt[1]).toMatchObject({ role: "user" })
  })

  it("returns a tool call whose arguments are not JSON, so the runtime refuses it", async () => {
    const model = mockModel(toolCallReply("web_fetch", "{not json"))
    const response = await executor(model).call(
      request({ tools: [WEB_FETCH], toolPolicyId: "panel-read-1" }),
      new AbortController().signal
    )
    expect(response).toMatchObject({
      outcome: "ok",
      finishReason: "tool_calls",
      toolCalls: [
        {
          id: "call_1",
          name: "web_fetch",
          arguments: { [UNPARSED_TOOL_ARGUMENTS_KEY]: "{not json" },
        },
      ],
    })
  })

  it("[ACC:AUTH-05] returns a request for a tool nobody offered instead of dropping it", async () => {
    const model = mockModel(toolCallReply("shell", JSON.stringify({ command: "rm -rf /" })))
    const response = await executor(model).call(
      request({ tools: [WEB_FETCH], toolPolicyId: "panel-read-1" }),
      new AbortController().signal
    )
    // The runtime refuses it as TOOL_NOT_OFFERED and records the refusal; the
    // executor's job is to report the ask, never to decide it.
    expect(response).toMatchObject({
      outcome: "ok",
      finishReason: "tool_calls",
      toolCalls: [{ name: "shell" }],
    })
  })

  it("sends a tool round's results back as the transcript the workflow built, with no tools", async () => {
    const model = mockModel(() => ({
      content: [{ type: "text", text: '{"answer":"4%"}' }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: V4_USAGE,
      warnings: [],
      response: { id: "resp_second" },
    }))
    // What `workflows/panel.ts` sends for the second member call: the tool
    // round is a fenced user message and no tool is offered any more.
    const response = await executor(model).call(
      request({
        messages: [
          { role: "system", content: "you are a panel member" },
          { role: "user", content: "the contract" },
          { role: "assistant", content: "Requested tools: web_fetch" },
          { role: "user", content: "<untrusted-data>the page</untrusted-data>" },
        ],
        toolPolicyId: null,
      }),
      new AbortController().signal
    )
    expect(response).toMatchObject({ outcome: "ok", text: '{"answer":"4%"}', finishReason: "stop" })
    expect(response).not.toHaveProperty("toolCalls")
    expect(model.seen[0].tools ?? []).toEqual([])
    expect(
      model.seen[0].prompt.map((message: { role: string; content: unknown }) => [
        message.role,
        typeof message.content === "string"
          ? message.content
          : (message.content as Array<Record<string, unknown>>)
              .map((part) => (typeof part.text === "string" ? part.text : String(part.type)))
              .join(""),
      ])
    ).toEqual([
      ["system", "you are a panel member"],
      ["user", "the contract"],
      ["assistant", "Requested tools: web_fetch"],
      ["user", "<untrusted-data>the page</untrusted-data>"],
    ])
  })

  it("refuses a call with nothing but system content rather than sending it", async () => {
    const model = mockModel(() => ({
      content: [],
      finishReason: { unified: "stop", raw: "stop" },
      usage: V4_USAGE,
      warnings: [],
    }))
    const response = await executor(model).call(
      request({ messages: [{ role: "system", content: "a rule" }] }),
      new AbortController().signal
    )
    expect(response).toMatchObject({ outcome: "error", errorClass: "invalid_request" })
    expect(model.seen).toHaveLength(0)
  })

  it("returns the tool calls a streamed call ended on", async () => {
    const stream = jest.fn(() => ({
      textStream: (async function* () {
        yield ""
      })(),
      usage: Promise.resolve({ inputTokens: 9, outputTokens: 3 }),
      providerMetadata: Promise.resolve(undefined),
      response: Promise.resolve({ id: "resp_stream" }),
      finishReason: Promise.resolve("stop"),
      toolCalls: Promise.resolve([
        { toolCallId: "call_2", toolName: "web_fetch", input: { url: "https://e.com" } },
      ]),
    }))
    const response = await executor({ stream }).call(
      request({ tools: [WEB_FETCH], toolPolicyId: "panel-read-1", onDelta: () => {} }),
      new AbortController().signal
    )
    expect(response).toMatchObject({
      outcome: "ok",
      finishReason: "tool_calls",
      toolCalls: [{ id: "call_2", name: "web_fetch", arguments: { url: "https://e.com" } }],
    })
  })
})

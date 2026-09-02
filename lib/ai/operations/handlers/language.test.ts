/** @jest-environment node */
jest.mock("./ai-sdk-surface", () => ({
  generateTextGated: jest.fn(),
  streamTextGated: jest.fn(),
  generateObjectGated: jest.fn(),
  jsonSchemaTool: jest.fn((definition: unknown) => ({ tool: definition })),
  jsonSchemaOf: jest.fn((schema: unknown) => ({ schema })),
}))
const surface = jest.requireMock("./ai-sdk-surface") as {
  generateTextGated: jest.Mock
  streamTextGated: jest.Mock
  generateObjectGated: jest.Mock
  jsonSchemaTool: jest.Mock
  jsonSchemaOf: jest.Mock
}
jest.mock("@/lib/ai/provider-consumption", () => ({
  createFeatureProviderModel: jest.fn((resolved: { model: string }) => ({
    modelId: resolved.model,
  })),
}))
const consumption = jest.requireMock("@/lib/ai/provider-consumption") as {
  createFeatureProviderModel: jest.Mock
}

import type { ResolvedProvider } from "@/lib/ai/provider-consumption"

import { ProviderOperationFailureError } from "../failure"
import { getProviderOperationDescriptor } from "../manifest"
import {
  LANGUAGE_HANDLERS,
  languageGenerateHandler,
  languageStreamHandler,
  languageToolsHandler,
  promptArgsOf,
  type LanguageInput,
} from "./language"

const provider: ResolvedProvider = {
  kind: "resolved",
  providerId: "openai",
  protocol: "openai",
  apiKey: "k",
  baseURL: "https://a/v1",
  model: "configured",
  isCustomProvider: false,
  useProxy: false,
}
const settings = { defaultProvider: "openai", providers: {}, customProviders: [] }

function ctx(
  operationId:
    "language.generate" | "language.stream" | "language.tools" | "language.structured-output",
  input: LanguageInput
) {
  return {
    descriptor: getProviderOperationDescriptor(operationId)!,
    provider,
    settings,
    request: {
      operationId,
      scopes: ["provider:invoke" as const],
      surface: "sidecar" as const,
      input,
    },
  }
}

describe("language handlers", () => {
  beforeEach(() => jest.clearAllMocks())

  it("refuses a request with neither prompt nor messages", () => {
    expect(() => promptArgsOf({})).toThrow(ProviderOperationFailureError)
    expect(promptArgsOf({ prompt: "hi", system: "s" })).toEqual({ prompt: "hi", system: "s" })
    expect(promptArgsOf({ messages: [{ role: "user", content: "hi" }] })).toEqual({
      messages: [{ role: "user", content: "hi" }],
    })
  })

  it("generates over the requested model and maps usage and tool calls", async () => {
    surface.generateTextGated.mockResolvedValueOnce({
      text: "out",
      finishReason: "stop",
      usage: { inputTokens: 3, outputTokens: 5 },
      toolCalls: [{ toolCallId: "c1", toolName: "t", input: { a: 1 } }],
    })
    const output = await languageGenerateHandler.handler(
      ctx("language.generate", { model: "m1", prompt: "hi", maxOutputTokens: 9 })
    )
    expect(consumption.createFeatureProviderModel).toHaveBeenCalledWith(
      expect.objectContaining({ model: "m1" })
    )
    expect(surface.generateTextGated).toHaveBeenCalledWith(
      expect.objectContaining({ model: { modelId: "m1" }, prompt: "hi", maxOutputTokens: 9 })
    )
    expect(output).toEqual({
      text: "out",
      finishReason: "stop",
      usage: { inputTokens: 3, outputTokens: 5 },
      toolCalls: [{ toolCallId: "c1", toolName: "t", input: { a: 1 } }],
    })
  })

  it("passes JSON-schema tools through the surface helper and refuses an empty tool set", async () => {
    surface.generateTextGated.mockResolvedValueOnce({
      text: "",
      finishReason: "tool-calls",
      usage: {},
      toolCalls: [],
    })
    await languageToolsHandler.handler(
      ctx("language.tools", { prompt: "hi", tools: { echo: { inputSchema: { type: "object" } } } })
    )
    expect(surface.generateTextGated).toHaveBeenCalledWith(
      expect.objectContaining({ tools: { echo: { tool: { inputSchema: { type: "object" } } } } })
    )
    await expect(
      languageToolsHandler.handler(ctx("language.tools", { prompt: "hi" }))
    ).rejects.toThrow(/at least one tool/)
  })

  it("streams and resolves the final text once the stream settles", async () => {
    surface.streamTextGated.mockReturnValueOnce({
      textStream: (async function* () {
        yield "a"
      })(),
      text: Promise.resolve("a"),
      finishReason: Promise.resolve("stop"),
      usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
    })
    const output = await languageStreamHandler.handler(ctx("language.stream", { prompt: "hi" }))
    const chunks: string[] = []
    for await (const chunk of output.textStream) chunks.push(chunk)
    expect(chunks).toEqual(["a"])
    await expect(output.finished).resolves.toEqual({
      text: "a",
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    })
  })

  it("registers structured output as translated on anthropic and bedrock and native elsewhere", async () => {
    const structured = LANGUAGE_HANDLERS.filter(
      (h) => h.operationId === "language.structured-output"
    )
    expect(structured.map((h) => [h.providerMatch, h.support])).toEqual([
      [{ kind: "protocol", protocol: "anthropic" }, "translated"],
      [{ kind: "protocol", protocol: "bedrock" }, "translated"],
      [{ kind: "any" }, "native"],
    ])
    surface.generateObjectGated.mockResolvedValueOnce({
      object: { ok: true },
      usage: { inputTokens: 2, outputTokens: 2 },
    })
    const output = await structured[2].handler(
      ctx("language.structured-output", { prompt: "hi", schema: { type: "object" } })
    )
    expect(surface.jsonSchemaOf).toHaveBeenCalledWith({ type: "object" })
    expect(output).toEqual({ object: { ok: true }, usage: { inputTokens: 2, outputTokens: 2 } })
    await expect(
      structured[2].handler(ctx("language.structured-output", { prompt: "hi" }))
    ).rejects.toThrow(/JSON schema/)
  })
})

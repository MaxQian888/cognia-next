/** @jest-environment node */
jest.mock("./ai-sdk-surface", () => ({
  generateTextGated: jest.fn(),
  streamTextGated: jest.fn(),
  generateObjectGated: jest.fn(),
  jsonSchemaTool: jest.fn((definition: unknown) => ({ tool: definition })),
  jsonSchemaOf: jest.fn((schema: unknown) => ({ schema })),
}))
const surface = jest.requireMock("./ai-sdk-surface") as Record<string, jest.Mock>
jest.mock("@/lib/ai/provider-consumption", () => ({
  createFeatureProviderModel: jest.fn((resolved: { model: string }) => ({
    modelId: resolved.model,
  })),
}))
const consumption = jest.requireMock("@/lib/ai/provider-consumption") as {
  createFeatureProviderModel: jest.Mock
}

import {
  languageGenerateOutput,
  languageStreamOutput,
  languageStructuredOutputOutput,
  type ProviderOperationId,
} from "@cognia/provider-types"
import type { ResolvedProvider } from "@/lib/ai/provider-consumption"

import { ProviderOperationFailureError } from "../failure"
import { getProviderOperationDescriptor } from "../manifest"
import {
  LANGUAGE_HANDLERS,
  finishReasonOf,
  languageGenerateHandler,
  languageStreamHandler,
  languageToolsHandler,
  toModelMessages,
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
const user = [{ role: "user" as const, content: "hi" }]

function ctx<T>(operationId: ProviderOperationId, input: T) {
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

  it("maps contract messages to SDK messages, tool results included", () => {
    expect(
      toModelMessages([
        { role: "system", content: [{ type: "text", text: "be brief" }] },
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "text", text: "call" }] },
        { role: "tool", name: "echo", toolCallId: "c1", content: "done" },
      ])
    ).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "call" }] },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "echo",
            output: { type: "text", value: "done" },
          },
        ],
      },
    ])
    expect(finishReasonOf("unknown")).toBe("other")
    expect(finishReasonOf("tool-calls")).toBe("tool-calls")
  })

  it("generates over the requested model and answers in the contract shape", async () => {
    surface.generateTextGated.mockResolvedValueOnce({
      text: "out",
      finishReason: "stop",
      usage: { inputTokens: 3, outputTokens: 5 },
      toolCalls: [{ toolCallId: "c1", toolName: "t", input: { a: 1 } }],
      response: { modelId: "m1-2026" },
    })
    const output = await languageGenerateHandler.handler(
      ctx("language.generate", { model: "m1", messages: user, maxOutputTokens: 9, topP: 0.5 })
    )
    expect(consumption.createFeatureProviderModel).toHaveBeenCalledWith(
      expect.objectContaining({ model: "m1" })
    )
    expect(surface.generateTextGated).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { modelId: "m1" },
        messages: user,
        maxOutputTokens: 9,
        topP: 0.5,
      })
    )
    expect(languageGenerateOutput.parse(output)).toEqual({
      model: "m1-2026",
      text: "out",
      finishReason: "stop",
      toolCalls: [{ id: "c1", name: "t", input: { a: 1 } }],
      usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
    })
    await expect(
      languageGenerateHandler.handler(ctx("language.generate", { model: "m1", messages: [] }))
    ).rejects.toThrow(ProviderOperationFailureError)
  })

  it("passes JSON-schema tools and the tool choice through the surface helper", async () => {
    surface.generateTextGated.mockResolvedValueOnce({
      text: "",
      finishReason: "tool-calls",
      usage: {},
      toolCalls: [],
    })
    await languageToolsHandler.handler(
      ctx("language.tools", {
        model: "m",
        messages: user,
        tools: [{ name: "echo", inputSchema: { type: "object" } }],
        toolChoice: "required" as const,
      })
    )
    expect(surface.generateTextGated).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: { echo: { tool: { description: undefined, inputSchema: { type: "object" } } } },
        toolChoice: "required",
      })
    )
  })

  it("streams and writes the terminal aggregate into the contract output", async () => {
    surface.streamTextGated.mockReturnValueOnce({
      textStream: (async function* () {
        yield "a"
      })(),
      text: Promise.resolve("a"),
      finishReason: Promise.resolve("stop"),
      usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
    })
    const output = await languageStreamHandler.handler(
      ctx("language.stream", { model: "m", messages: user })
    )
    const chunks: string[] = []
    for await (const chunk of output.textStream) chunks.push(chunk)
    expect(chunks).toEqual(["a"])
    const final = await output.completed
    expect(final).toEqual({
      model: "m",
      text: "a",
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    })
    expect(languageStreamOutput.parse(output)).toEqual({
      streamId: output.streamId,
      model: "m",
      final,
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
      finishReason: "stop",
      usage: { inputTokens: 2, outputTokens: 2 },
    })
    const output = await structured[2].handler(
      ctx("language.structured-output", {
        model: "m",
        messages: user,
        schema: { type: "object" },
        schemaName: "Answer",
      })
    )
    expect(surface.jsonSchemaOf).toHaveBeenCalledWith({ type: "object" })
    expect(surface.generateObjectGated).toHaveBeenCalledWith(
      expect.objectContaining({ schemaName: "Answer" })
    )
    expect(languageStructuredOutputOutput.parse(output)).toMatchObject({
      object: { ok: true },
      text: '{"ok":true}',
    })
  })
})

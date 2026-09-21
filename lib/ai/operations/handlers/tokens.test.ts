/** @jest-environment node */
jest.mock("./http", () => ({
  providerRequest: jest.fn(async () => ({ json: { input_tokens: 77 } })),
}))
const http = jest.requireMock("./http") as { providerRequest: jest.Mock }

import type { ResolvedProvider } from "@/lib/ai/provider-consumption"

import { getProviderOperationDescriptor } from "../manifest"
import { ProviderOperationHandlerRegistry } from "../registry"
import { TOKENS_HANDLERS, hoistSystemContent, requestText } from "./tokens"

const settings = { defaultProvider: "openai", providers: {}, customProviders: [] }
function provider(protocol: ResolvedProvider["protocol"]): ResolvedProvider {
  return {
    kind: "resolved",
    providerId: "p",
    protocol,
    apiKey: "k",
    baseURL: "https://a/v1",
    model: undefined,
    isCustomProvider: false,
    useProxy: false,
  }
}
const input = {
  model: "m",
  system: "be terse",
  messages: [{ role: "user", content: "hello there" }],
  tools: [{ name: "t", inputSchema: { type: "object" } }],
}

describe("tokens.count", () => {
  const registry = new ProviderOperationHandlerRegistry()
  for (const handler of TOKENS_HANDLERS) registry.register(handler)

  it("is native on anthropic and an estimate elsewhere, and says which", async () => {
    const run = (p: ResolvedProvider) =>
      registry.resolve("tokens.count", p.providerId, p.protocol)!.handler({
        descriptor: getProviderOperationDescriptor("tokens.count")!,
        provider: p,
        settings,
        request: {
          operationId: "tokens.count",
          scopes: ["provider:read"],
          surface: "sidecar",
          input,
        },
      })
    expect(await run(provider("anthropic"))).toEqual({ inputTokens: 77, method: "provider" })
    expect(http.providerRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        path: "messages/count_tokens",
        body: expect.objectContaining({
          tools: [expect.objectContaining({ input_schema: { type: "object" } })],
        }),
      })
    )
    const estimate = (await run(provider("openai"))) as { method: string; inputTokens: number }
    expect(estimate.method).toBe("estimate")
    expect(estimate.inputTokens).toBeGreaterThan(0)
  })

  it("keeps a plain string system field when there is no system turn to hoist", () => {
    expect(hoistSystemContent(input)).toEqual({
      system: "be terse",
      messages: [{ role: "user", content: "hello there" }],
    })
  })

  it("hoists system turns out of messages, in order, as text blocks", async () => {
    // Anthropic rejects `role: "system"` inside `messages`; the top-level
    // `system` field is the only place that content can travel.
    const withSystemTurns = {
      ...input,
      messages: [
        { role: "system", content: "you are a linter" },
        { role: "user", content: "hello there" },
        { role: "system", content: [{ type: "text", text: "switch to bullets" }] },
        { role: "assistant", content: "ok" },
        { role: "system", content: "   " },
      ],
    }
    expect(hoistSystemContent(withSystemTurns)).toEqual({
      system: [
        { type: "text", text: "be terse" },
        { type: "text", text: "you are a linter" },
        { type: "text", text: "switch to bullets" },
      ],
      messages: [
        { role: "user", content: "hello there" },
        { role: "assistant", content: "ok" },
      ],
    })

    http.providerRequest.mockClear()
    const p = provider("anthropic")
    await registry.resolve("tokens.count", p.providerId, p.protocol)!.handler({
      descriptor: getProviderOperationDescriptor("tokens.count")!,
      provider: p,
      settings,
      request: {
        operationId: "tokens.count",
        scopes: ["provider:read"],
        surface: "sidecar",
        input: withSystemTurns,
      },
    })
    const body = http.providerRequest.mock.calls[0][1].body as {
      messages: Array<{ role: string }>
      system: unknown
    }
    expect(body.messages.map((m) => m.role)).toEqual(["user", "assistant"])
    expect(body.system).toEqual([
      { type: "text", text: "be terse" },
      { type: "text", text: "you are a linter" },
      { type: "text", text: "switch to bullets" },
    ])
  })

  it("estimates instead of sending when the hoist leaves no messages", async () => {
    http.providerRequest.mockClear()
    const p = provider("anthropic")
    const result = await registry.resolve("tokens.count", p.providerId, p.protocol)!.handler({
      descriptor: getProviderOperationDescriptor("tokens.count")!,
      provider: p,
      settings,
      request: {
        operationId: "tokens.count",
        scopes: ["provider:read"],
        surface: "sidecar",
        input: { ...input, messages: [{ role: "system", content: "only a rule" }] },
      },
    })
    expect(http.providerRequest).not.toHaveBeenCalled()
    expect(result).toEqual({
      inputTokens: expect.any(Number),
      method: "estimate",
    })
    expect((result as { inputTokens: number }).inputTokens).toBeGreaterThan(0)
  })

  it("flattens every text leaf for the estimate", () => {
    const text = requestText(input)
    expect(text).toContain("be terse")
    expect(text).toContain("hello there")
    expect(text).toContain('"type":"object"')
  })
})

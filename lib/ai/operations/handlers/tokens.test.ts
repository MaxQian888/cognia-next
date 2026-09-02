/** @jest-environment node */
jest.mock("./http", () => ({
  providerRequest: jest.fn(async () => ({ json: { input_tokens: 77 } })),
}))
const http = jest.requireMock("./http") as { providerRequest: jest.Mock }

import type { ResolvedProvider } from "@/lib/ai/provider-consumption"

import { getProviderOperationDescriptor } from "../manifest"
import { ProviderOperationHandlerRegistry } from "../registry"
import { TOKENS_HANDLERS, requestText } from "./tokens"

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

  it("flattens every text leaf for the estimate", () => {
    const text = requestText(input)
    expect(text).toContain("be terse")
    expect(text).toContain("hello there")
    expect(text).toContain('"type":"object"')
  })
})

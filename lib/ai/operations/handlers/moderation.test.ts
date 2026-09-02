/** @jest-environment node */
jest.mock("./http", () => ({
  providerRequest: jest.fn(async () => ({
    json: {
      results: [{ flagged: true, categories: { hate: true }, category_scores: { hate: 0.9 } }],
    },
  })),
}))
const http = jest.requireMock("./http") as { providerRequest: jest.Mock }

import { getProviderOperationDescriptor } from "../manifest"
import { ProviderOperationHandlerRegistry } from "../registry"
import { MODERATION_HANDLERS } from "./moderation"

describe("moderation.create", () => {
  const registry = new ProviderOperationHandlerRegistry()
  for (const handler of MODERATION_HANDLERS) registry.register(handler)

  it("is bound per vendor and maps the OpenAI-style answer", async () => {
    expect(registry.resolve("moderation.create", "deepseek", "openai")).toBeUndefined()
    const registration = registry.resolve("moderation.create", "openai", "openai")!
    const out = await registration.handler({
      descriptor: getProviderOperationDescriptor("moderation.create")!,
      provider: {
        kind: "resolved",
        providerId: "openai",
        protocol: "openai",
        apiKey: "k",
        baseURL: "https://a/v1",
        model: undefined,
        isCustomProvider: false,
        useProxy: false,
      },
      settings: { defaultProvider: "openai", providers: {}, customProviders: [] },
      request: {
        operationId: "moderation.create",
        scopes: ["provider:invoke"],
        surface: "sidecar",
        input: { input: "text" },
      },
    })
    expect(out).toEqual({
      results: [{ flagged: true, categories: { hate: true }, scores: { hate: 0.9 } }],
    })
    expect(http.providerRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        path: "moderations",
        body: { input: "text", model: "omni-moderation-latest" },
      })
    )
  })
})

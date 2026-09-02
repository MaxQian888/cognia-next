/** @jest-environment node */
jest.mock("./http", () => ({ ...jest.requireActual("./http"), providerRequest: jest.fn() }))
const http = jest.requireMock("./http") as { providerRequest: jest.Mock }

import { realtimeConnectOutput } from "@cognia/provider-types"
import type { ResolvedProvider } from "@/lib/ai/provider-consumption"

import { getProviderOperationDescriptor } from "../manifest"
import { ProviderOperationHandlerRegistry } from "../registry"
import {
  REALTIME_HANDLERS,
  geminiRealtimeHandler,
  openAiRealtimeHandler,
  socketBaseOf,
} from "./realtime"

function resolved(
  providerId: string,
  protocol: ResolvedProvider["protocol"],
  baseURL?: string
): ResolvedProvider {
  return {
    kind: "resolved",
    providerId,
    protocol,
    apiKey: "k",
    baseURL,
    model: undefined,
    isCustomProvider: false,
    useProxy: false,
  }
}
const settings = { defaultProvider: undefined, providers: {}, customProviders: [] }
const ctx = (
  provider: ResolvedProvider,
  input: { model: string; voice?: string; instructions?: string }
) => ({
  descriptor: getProviderOperationDescriptor("realtime.connect")!,
  provider,
  settings,
  request: {
    operationId: "realtime.connect" as const,
    scopes: ["provider:invoke" as const],
    surface: "sidecar" as const,
    input,
    deploymentRef: "dep-1",
  },
})

describe("realtime.connect", () => {
  beforeEach(() => jest.clearAllMocks())

  it("binds openai, azure and google, nothing else", () => {
    const registry = new ProviderOperationHandlerRegistry()
    for (const handler of REALTIME_HANDLERS) registry.register(handler)
    expect(registry.resolve("realtime.connect", "openai", "openai")).toBeDefined()
    expect(registry.resolve("realtime.connect", "azure", "azure")).toBeDefined()
    expect(registry.resolve("realtime.connect", "google", "google")).toBeDefined()
    expect(registry.resolve("realtime.connect", "anthropic", "anthropic")).toBeUndefined()
    expect(socketBaseOf("https://api.openai.com/v1")).toBe("wss://api.openai.com/v1")
    expect(socketBaseOf("http://localhost:8000/v1")).toBe("ws://localhost:8000/v1")
  })

  it("mints an OpenAI client secret and hands back the socket URL with the ephemeral token", async () => {
    const provider = resolved("openai", "openai", "https://api.openai.com/v1")
    http.providerRequest.mockResolvedValueOnce({
      json: { value: "ek_123", expires_at: 1_800_000_000, session: { id: "sess_1" } },
    })
    const output = realtimeConnectOutput.parse(
      await openAiRealtimeHandler.handler(
        ctx(provider, { model: "gpt-realtime", voice: "marin", instructions: "be brief" })
      )
    )
    expect(output).toMatchObject({
      transport: "websocket",
      url: "wss://api.openai.com/v1/realtime?model=gpt-realtime",
      ephemeralToken: "ek_123",
      expiresAt: 1_800_000_000_000,
    })
    expect(output.handle).toMatchObject({
      kind: "realtime-session",
      id: "sess_1",
      providerId: "openai",
      deploymentRef: "dep-1",
    })
    expect(http.providerRequest).toHaveBeenCalledWith(
      provider,
      expect.objectContaining({
        path: "realtime/client_secrets",
        body: {
          session: {
            type: "realtime",
            model: "gpt-realtime",
            instructions: "be brief",
            audio: { output: { voice: "marin" } },
          },
        },
      })
    )
    http.providerRequest.mockResolvedValueOnce({ json: {} })
    await expect(
      openAiRealtimeHandler.handler(ctx(provider, { model: "gpt-realtime" }))
    ).rejects.toMatchObject({ failure: { code: "invalid-response" } })
  })

  it("mints a Gemini ephemeral auth token constrained to the model and returns the Live socket", async () => {
    const provider = resolved("google", "google")
    http.providerRequest.mockResolvedValueOnce({
      json: { name: "auth_tokens/t1", expireTime: "2026-09-02T01:00:00Z" },
    })
    const output = realtimeConnectOutput.parse(
      await geminiRealtimeHandler.handler(ctx(provider, { model: "gemini-live", voice: "Kore" }))
    )
    expect(output.url).toContain("BidiGenerateContent?access_token=auth_tokens%2Ft1")
    expect(output.ephemeralToken).toBe("auth_tokens/t1")
    expect(output.expiresAt).toBe(Date.parse("2026-09-02T01:00:00Z"))
    expect(http.providerRequest).toHaveBeenCalledWith(
      provider,
      expect.objectContaining({
        baseURL: "https://generativelanguage.googleapis.com/v1alpha",
        path: "auth_tokens",
        body: expect.objectContaining({
          uses: 1,
          liveConnectConstraints: expect.objectContaining({ model: "models/gemini-live" }),
        }),
      })
    )
  })
})

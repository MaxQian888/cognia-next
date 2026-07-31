import type { ResolvedProvider } from "@/lib/ai/provider-consumption"
import { isConfirmedLocalProvider } from "./provider-locality"

function resolution(overrides: Partial<ResolvedProvider> = {}): ResolvedProvider {
  return {
    kind: "resolved",
    providerId: "ollama",
    protocol: "openai",
    apiKey: undefined,
    baseURL: "http://127.0.0.1:11434/v1",
    model: "local-model",
    isCustomProvider: false,
    useProxy: false,
    ...overrides,
  }
}

describe("isConfirmedLocalProvider", () => {
  it.each([
    "http://localhost:11434/v1",
    "http://127.0.0.1:8080/v1",
    "http://127.12.4.9:8080/v1",
    "http://[::1]:8080/v1",
  ])("accepts a resolved loopback endpoint: %s", (baseURL) => {
    expect(isConfirmedLocalProvider(resolution({ baseURL }))).toBe(true)
  })

  it.each([
    { baseURL: "https://api.example.com/v1" },
    { baseURL: undefined },
    { baseURL: "not a url" },
    { useProxy: true },
  ])("rejects an endpoint that is not confirmed local: %o", (overrides) => {
    expect(isConfirmedLocalProvider(resolution(overrides))).toBe(false)
  })
})

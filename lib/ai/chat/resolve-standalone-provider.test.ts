import type { AppSettings } from "@/lib/claude/types"

import { resolveStandaloneProvider } from "./resolve-standalone-provider"

type Slice = Pick<AppSettings, "defaultProvider" | "providerSettings" | "customProviders">

describe("resolveStandaloneProvider", () => {
  it("resolves the configured default provider when it has a key", () => {
    const settings = {
      defaultProvider: "anthropic",
      providerSettings: { anthropic: { enabled: true, apiKey: "sk-ant" } },
      customProviders: [],
    } as unknown as Slice
    const res = resolveStandaloneProvider(settings)
    expect(res.kind).toBe("resolved")
    if (res.kind === "resolved") {
      expect(res.providerId).toBe("anthropic")
      expect(res.apiKey).toBe("sk-ant")
    }
  })

  it("falls back to the first eligible provider when no default is set", () => {
    const settings = {
      defaultProvider: undefined,
      providerSettings: { openai: { enabled: true, apiKey: "sk-oai" } },
      customProviders: [],
    } as unknown as Slice
    const res = resolveStandaloneProvider(settings)
    expect(res.kind).toBe("resolved")
    if (res.kind === "resolved") expect(res.providerId).toBe("openai")
  })

  it("is unresolved when no provider has a key", () => {
    const res = resolveStandaloneProvider({
      defaultProvider: undefined,
      providerSettings: {},
      customProviders: [],
    } as unknown as Slice)
    expect(res.kind).toBe("unresolved")
  })

  it("tolerates null / undefined settings", () => {
    expect(resolveStandaloneProvider(null).kind).toBe("unresolved")
    expect(resolveStandaloneProvider(undefined).kind).toBe("unresolved")
  })
})

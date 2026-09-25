import { ProviderResolutionError } from "./provider-resolution-error"

describe("ProviderResolutionError", () => {
  it("keeps the resolver's structure next to its message", () => {
    const err = new ProviderResolutionError({
      reason: 'Provider "anthropic" is disabled.',
      code: "provider_disabled",
      nextAction: "enable_provider",
      providerId: "anthropic",
    })
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe("ProviderResolutionError")
    expect(err.message).toBe('Provider "anthropic" is disabled.')
    expect(err.code).toBe("provider_disabled")
    expect(err.nextAction).toBe("enable_provider")
    expect(err.providerId).toBe("anthropic")
  })

  it("falls back to a readable message when the resolver gave none", () => {
    const err = new ProviderResolutionError({ reason: "" })
    expect(err.message).toBe("No model provider is configured.")
    expect(err.code).toBeUndefined()
    expect(err.providerId).toBeUndefined()
  })
})

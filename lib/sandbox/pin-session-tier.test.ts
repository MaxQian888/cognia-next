import { decideSessionTierPin } from "./pin-session-tier"

describe("decideSessionTierPin", () => {
  it("pins an inherited tier so a settings change cannot re-tier the conversation", () => {
    // The drift this exists to stop: the conversation runs on `microvm` today
    // because the character says so, and would follow the character (or the app
    // default) down to `os` the moment either changed.
    expect(
      decideSessionTierPin({
        sandboxEnabled: true,
        inputs: { character: { sandboxTier: "microvm" } },
      })
    ).toEqual({ pin: true, tier: "microvm", source: "character" })

    expect(
      decideSessionTierPin({
        sandboxEnabled: true,
        inputs: { appSettings: { sandboxTier: "microvm" } },
      })
    ).toEqual({ pin: true, tier: "microvm", source: "appSettings" })
  })

  it("pins the fallback tier too", () => {
    // `os` is still an answer. Leaving it unpinned would let a later
    // `AppSettings.sandboxTier` change silently STRENGTHEN an old conversation,
    // which is less alarming than weakening it but is the same surprise.
    expect(decideSessionTierPin({ sandboxEnabled: true, inputs: {} })).toEqual({
      pin: true,
      tier: "os",
      source: "fallback",
    })
  })

  it("never rewrites a tier the session already carries", () => {
    expect(
      decideSessionTierPin({
        sandboxEnabled: true,
        inputs: {
          session: { sandboxTier: "os" },
          character: { sandboxTier: "microvm" },
        },
      })
    ).toEqual({ pin: false, tier: "os", source: "session" })
  })

  it("does not pin when the session is not running sandboxed", () => {
    // No isolation is in force, so there is nothing to freeze — and writing a
    // tier here would invent a claim the session never made.
    expect(
      decideSessionTierPin({
        sandboxEnabled: false,
        inputs: { character: { sandboxTier: "microvm" } },
      })
    ).toEqual({ pin: false, tier: "microvm", source: "character" })
  })

  it("reports the tier the binding resolver would use, not a second ladder", () => {
    // The decision and the routing must come from one implementation; a private
    // copy of the precedence here is exactly the drift being fixed.
    const inputs = {
      session: { sandboxTier: undefined },
      character: { sandboxTier: undefined },
      appSettings: { sandboxTier: "microvm" as const },
    }
    expect(decideSessionTierPin({ sandboxEnabled: true, inputs }).tier).toBe("microvm")
  })
})

import {
  ONBOARDING_MODES,
  ONBOARDING_SHELLS,
  ONBOARDING_STATE_VERSION,
  initialOnboardingProgress,
  isOnboardingSettled,
  resolveOnboardingMode,
  type OnboardingProgress,
} from "./onboarding"

describe("ONBOARDING_SHELLS", () => {
  it("enumerates the four first-run contexts exactly once each", () => {
    expect([...ONBOARDING_SHELLS].sort()).toEqual([
      "mobile-paired",
      "mobile-standalone",
      "tauri",
      "web",
    ])
    expect(new Set(ONBOARDING_SHELLS).size).toBe(ONBOARDING_SHELLS.length)
  })
})

describe("initialOnboardingProgress", () => {
  it("stamps the current version and starts at welcome", () => {
    const out = initialOnboardingProgress()
    expect(out.version).toBe(ONBOARDING_STATE_VERSION)
    expect(out.lastStep).toBe("welcome")
  })

  it("carries neither terminal stamp, so a fresh record is unsettled", () => {
    const out = initialOnboardingProgress()
    expect(out.completedAt).toBeUndefined()
    expect(out.skippedAt).toBeUndefined()
    expect(isOnboardingSettled(out)).toBe(false)
  })
})

describe("isOnboardingSettled", () => {
  const base: OnboardingProgress = { version: ONBOARDING_STATE_VERSION, path: "runtime_skipped" }

  it("is false when there is no record", () => {
    expect(isOnboardingSettled(undefined)).toBe(false)
  })

  it("is false for a record carrying neither terminal stamp", () => {
    expect(isOnboardingSettled({ ...base, lastStep: "scan" })).toBe(false)
  })

  it("is true once completed", () => {
    expect(isOnboardingSettled({ ...base, completedAt: "2026-08-01T00:00:00.000Z" })).toBe(true)
  })

  it("is true once skipped", () => {
    expect(isOnboardingSettled({ ...base, skippedAt: "2026-08-01T00:00:00.000Z" })).toBe(true)
  })

  it("treats a migrated legacy dismissal as settled", () => {
    expect(
      isOnboardingSettled({
        version: ONBOARDING_STATE_VERSION,
        path: "legacy_dismissed",
        skippedAt: "2026-05-18T00:00:00.000Z",
      })
    ).toBe(true)
  })
})

describe("ONBOARDING_MODES", () => {
  it("enumerates the two paths exactly once each", () => {
    expect(new Set(ONBOARDING_MODES).size).toBe(ONBOARDING_MODES.length)
    expect(ONBOARDING_MODES).toEqual(["express", "custom"])
  })
})

describe("resolveOnboardingMode", () => {
  it("returns nothing for a device that has never been asked", () => {
    // Defaulting either way would send a resuming user down a path they never
    // picked, so the fork gets asked rather than guessed.
    expect(resolveOnboardingMode(undefined)).toBeUndefined()
    expect(resolveOnboardingMode(initialOnboardingProgress())).toBeUndefined()
  })

  it("takes the stored answer when there is one", () => {
    expect(resolveOnboardingMode({ version: 2, path: "runtime_skipped", mode: "express" })).toBe(
      "express"
    )
    expect(resolveOnboardingMode({ version: 2, path: "runtime_skipped", mode: "custom" })).toBe(
      "custom"
    )
  })

  it("prefers the stored answer over the step it stopped on", () => {
    expect(
      resolveOnboardingMode({
        version: 2,
        path: "runtime_skipped",
        mode: "express",
        lastStep: "scan",
      })
    ).toBe("express")
  })

  it("reads a pre-fork record from the step it stopped on", () => {
    // v1 rows carry no `mode`. Any step past the intro belongs to the sequence
    // that had those steps, and only one path had them.
    for (const lastStep of ["scan", "provider", "first-run"] as const) {
      expect(resolveOnboardingMode({ version: 1, path: "runtime_skipped", lastStep })).toBe(
        "custom"
      )
    }
  })

  it("still asks a v1 record that never got past the intro", () => {
    expect(
      resolveOnboardingMode({ version: 1, path: "runtime_skipped", lastStep: "welcome" })
    ).toBeUndefined()
    expect(resolveOnboardingMode({ version: 1, path: "runtime_skipped" })).toBeUndefined()
  })
})

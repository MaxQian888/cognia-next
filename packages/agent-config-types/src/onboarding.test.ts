import {
  ONBOARDING_SHELLS,
  ONBOARDING_STATE_VERSION,
  initialOnboardingProgress,
  isOnboardingSettled,
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

import type { AppSettings } from "@cognia/agent-config-types"
import { ONBOARDING_STATE_VERSION } from "@cognia/agent-config-types"
import { migrateLegacyOnboarding } from "./migrate-legacy"

function makeSettings(patch: Partial<AppSettings> = {}): AppSettings {
  return {
    id: "singleton",
    permissionMode: "default",
    alwaysAllowTools: [],
    builtinTools: {} as AppSettings["builtinTools"],
    ...patch,
  } as AppSettings
}

describe("migrateLegacyOnboarding", () => {
  it("returns null on a fresh install (nothing to migrate)", () => {
    expect(migrateLegacyOnboarding(makeSettings())).toBeNull()
  })

  it("projects a legacy dismissal onto the structured record", () => {
    const out = migrateLegacyOnboarding(
      makeSettings({ onboardingDismissedAt: "2026-05-18T00:00:00.000Z" })
    )
    expect(out).toEqual({
      version: ONBOARDING_STATE_VERSION,
      path: "legacy_dismissed",
      skippedAt: "2026-05-18T00:00:00.000Z",
      finishBarDismissed: true,
    })
  })

  it("records skippedAt rather than completedAt — the old stamp never proved completion", () => {
    const out = migrateLegacyOnboarding(
      makeSettings({ onboardingDismissedAt: "2026-05-18T00:00:00.000Z" })
    )
    expect(out?.completedAt).toBeUndefined()
    expect(out?.skippedAt).toBe("2026-05-18T00:00:00.000Z")
  })

  it("carries no lastStep — legacy steps do not map onto the new flow", () => {
    const out = migrateLegacyOnboarding(
      makeSettings({ onboardingDismissedAt: "2026-05-18T00:00:00.000Z" })
    )
    expect(out?.lastStep).toBeUndefined()
  })

  it("is idempotent: a structured record already present wins", () => {
    const settings = makeSettings({
      onboardingDismissedAt: "2026-05-18T00:00:00.000Z",
      onboardingProgress: {
        version: ONBOARDING_STATE_VERSION,
        path: "completed",
        completedAt: "2026-08-01T00:00:00.000Z",
      },
    })
    expect(migrateLegacyOnboarding(settings)).toBeNull()
  })
})

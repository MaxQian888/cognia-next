import type { AppSettings, OnboardingProgress } from "@cognia/agent-config-types"
import { ONBOARDING_STATE_VERSION } from "@cognia/agent-config-types"
import { shouldEnterOnboarding, shouldShowFinishBar } from "./gate"

function makeSettings(patch: Partial<AppSettings> = {}): AppSettings {
  return {
    id: "singleton",
    permissionMode: "default",
    alwaysAllowTools: [],
    builtinTools: {} as AppSettings["builtinTools"],
    ...patch,
  } as AppSettings
}

function progress(patch: Partial<OnboardingProgress> = {}): OnboardingProgress {
  return { version: ONBOARDING_STATE_VERSION, path: "runtime_skipped", ...patch }
}

describe("shouldEnterOnboarding", () => {
  it("enters on a fresh install with no progress and no sessions", () => {
    expect(shouldEnterOnboarding(makeSettings(), 0)).toBe(true)
  })

  it("stays out once onboarding completed", () => {
    const settings = makeSettings({
      onboardingProgress: progress({ path: "completed", completedAt: "2026-08-01T00:00:00.000Z" }),
    })
    expect(shouldEnterOnboarding(settings, 0)).toBe(false)
  })

  it("stays out once onboarding was skipped", () => {
    const settings = makeSettings({
      onboardingProgress: progress({ skippedAt: "2026-08-01T00:00:00.000Z" }),
    })
    expect(shouldEnterOnboarding(settings, 0)).toBe(false)
  })

  it("re-enters when a progress record exists but neither stamp is set (resumable mid-flow)", () => {
    const settings = makeSettings({ onboardingProgress: progress({ lastStep: "scan" }) })
    expect(shouldEnterOnboarding(settings, 0)).toBe(true)
  })

  it("stays out for a legacy dismissal that has not been migrated yet", () => {
    // The migration runs on boot; the gate must not flash the flow in the
    // window before it lands.
    const settings = makeSettings({ onboardingDismissedAt: "2026-05-18T00:00:00.000Z" })
    expect(shouldEnterOnboarding(settings, 0)).toBe(false)
  })

  it("stays out for a long-time user with sessions but no progress record", () => {
    expect(shouldEnterOnboarding(makeSettings(), 3)).toBe(false)
  })

  it("does not consult provider configuration", () => {
    // A configured API key never meant the user had seen the product work, so
    // it must not suppress the flow — this is the behaviour change vs the old
    // `shouldShowOnboarding` predicate.
    const settings = makeSettings({ apiKey: "sk-ant-existing" })
    expect(shouldEnterOnboarding(settings, 0)).toBe(true)
  })
})

describe("shouldShowFinishBar", () => {
  it("hides when there is no progress record at all", () => {
    expect(shouldShowFinishBar(makeSettings())).toBe(false)
  })

  it.each(["provider_skipped", "runtime_skipped", "task_failed"] as const)(
    "shows for the %s exit path",
    (path) => {
      const settings = makeSettings({ onboardingProgress: progress({ path }) })
      expect(shouldShowFinishBar(settings)).toBe(true)
    }
  )

  it("hides after a completed run", () => {
    const settings = makeSettings({ onboardingProgress: progress({ path: "completed" }) })
    expect(shouldShowFinishBar(settings)).toBe(false)
  })

  it("hides for migrated legacy users so upgrades never nag", () => {
    const settings = makeSettings({ onboardingProgress: progress({ path: "legacy_dismissed" }) })
    expect(shouldShowFinishBar(settings)).toBe(false)
  })

  it("hides once the user closed the bar", () => {
    const settings = makeSettings({
      onboardingProgress: progress({ path: "runtime_skipped", finishBarDismissed: true }),
    })
    expect(shouldShowFinishBar(settings)).toBe(false)
  })
})

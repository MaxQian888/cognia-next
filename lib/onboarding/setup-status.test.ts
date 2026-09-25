import { ONBOARDING_STATE_VERSION, type OnboardingProgress } from "@cognia/agent-config-types"

import {
  deriveSetupGaps,
  focusForGap,
  isSetupUnfinished,
  resolveLiveModelAccess,
} from "./setup-status"

const SKIPPED_AT = "2026-09-01T00:00:00.000Z"

function progress(patch: Partial<OnboardingProgress> = {}): OnboardingProgress {
  return { version: ONBOARDING_STATE_VERSION, path: "runtime_skipped", ...patch }
}

describe("isSetupUnfinished", () => {
  it.each(["provider_skipped", "runtime_skipped", "task_failed"] as const)(
    "is true for a recorded %s exit",
    (path) => {
      expect(isSetupUnfinished(progress({ path, skippedAt: SKIPPED_AT }))).toBe(true)
    }
  )

  it("is false for a flow still in progress, whose path is only a placeholder", () => {
    expect(isSetupUnfinished(progress({ lastStep: "scan" }))).toBe(false)
  })

  it("is false once completed, even beside a stale skip", () => {
    expect(isSetupUnfinished(progress({ path: "completed", completedAt: SKIPPED_AT }))).toBe(false)
    expect(
      isSetupUnfinished(
        progress({ path: "provider_skipped", skippedAt: SKIPPED_AT, completedAt: SKIPPED_AT })
      )
    ).toBe(false)
  })

  it("is false for migrated legacy users and for no record at all", () => {
    expect(isSetupUnfinished(progress({ path: "legacy_dismissed", skippedAt: SKIPPED_AT }))).toBe(
      false
    )
    expect(isSetupUnfinished(undefined)).toBe(false)
  })
})

describe("resolveLiveModelAccess", () => {
  const none = {
    credentialsOk: false,
    providerConfigured: false,
    legacyApiKey: undefined,
    externalRuntimeReady: false,
  }

  it("is false when every source has answered and none can reach a model", () => {
    expect(resolveLiveModelAccess(none)).toBe(false)
  })

  it.each([
    ["the credential probe", { credentialsOk: true }],
    ["a configured provider", { providerConfigured: true }],
    ["the legacy key slot", { legacyApiKey: "sk-ant-x" }],
    ["a connected external agent", { externalRuntimeReady: true }],
  ])("is true from %s alone", (_, patch) => {
    expect(resolveLiveModelAccess({ ...none, ...patch })).toBe(true)
  })

  it("cannot say while the credential probe is in flight (or on a paired phone)", () => {
    expect(resolveLiveModelAccess({ ...none, credentialsOk: null })).toBeNull()
  })

  it("does not wait on the probe once another source already proves access", () => {
    expect(resolveLiveModelAccess({ ...none, credentialsOk: null, providerConfigured: true })).toBe(
      true
    )
  })
})

describe("deriveSetupGaps", () => {
  const skipped = (path: OnboardingProgress["path"]) => progress({ path, skippedAt: SKIPPED_AT })

  it("names the missing model first, whatever the recorded path said", () => {
    expect(
      deriveSetupGaps({ progress: skipped("runtime_skipped"), modelAccess: false, sessionCount: 0 })
    ).toEqual(["model", "first-task"])
  })

  it("drops the model gap the moment access appears elsewhere", () => {
    // The bug this replaces: a key added in Settings → Providers left the bar
    // saying "can't reach a model" forever.
    expect(
      deriveSetupGaps({ progress: skipped("provider_skipped"), modelAccess: true, sessionCount: 0 })
    ).toEqual(["first-task"])
  })

  it("never raises a model gap it cannot confirm", () => {
    expect(
      deriveSetupGaps({ progress: skipped("provider_skipped"), modelAccess: null, sessionCount: 3 })
    ).toEqual([])
  })

  it("asks for a retry after a failed first task", () => {
    expect(
      deriveSetupGaps({ progress: skipped("task_failed"), modelAccess: true, sessionCount: 1 })
    ).toEqual(["task-failed"])
  })

  it("stops asking for a first task once the user has conversations of their own", () => {
    expect(
      deriveSetupGaps({ progress: skipped("runtime_skipped"), modelAccess: true, sessionCount: 2 })
    ).toEqual([])
  })

  it("does not ask for a first task while the session count is still loading", () => {
    expect(
      deriveSetupGaps({
        progress: skipped("runtime_skipped"),
        modelAccess: true,
        sessionCount: null,
      })
    ).toEqual([])
  })

  it("reports only a missing model for a user who finished setup", () => {
    const done = progress({ path: "completed", completedAt: SKIPPED_AT })
    expect(deriveSetupGaps({ progress: done, modelAccess: true, sessionCount: 0 })).toEqual([])
    expect(deriveSetupGaps({ progress: done, modelAccess: false, sessionCount: 0 })).toEqual([
      "model",
    ])
  })

  it("ignores the bar's dismissal — closing a reminder is not finishing setup", () => {
    const dismissed = progress({
      path: "provider_skipped",
      skippedAt: SKIPPED_AT,
      finishBarDismissed: true,
    })
    expect(deriveSetupGaps({ progress: dismissed, modelAccess: false, sessionCount: 0 })).toEqual([
      "model",
      "first-task",
    ])
  })
})

describe("focusForGap", () => {
  it("sends a missing model to the sign-in and everything else to the cards", () => {
    expect(focusForGap("model")).toBe("model")
    expect(focusForGap("task-failed")).toBe("task")
    expect(focusForGap("first-task")).toBe("task")
  })
})

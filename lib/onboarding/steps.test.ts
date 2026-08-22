import type { OnboardingMode, OnboardingShell } from "@cognia/agent-config-types"
import {
  ONBOARDING_STEPS,
  nextStep,
  previousStep,
  progressPosition,
  resolveStepSequence,
  resumeStep,
} from "./steps"

const ids = (shell: OnboardingShell, hasModelAccess = false, mode: OnboardingMode = "custom") =>
  resolveStepSequence({ shell, mode, hasModelAccess }).map((s) => s.id)

/** The step-by-step sequence, which most of these cases are about. */
const custom = (shell: OnboardingShell, hasModelAccess = false) =>
  resolveStepSequence({ shell, mode: "custom", hasModelAccess })

describe("ONBOARDING_STEPS", () => {
  it("keeps welcome out of the progress count", () => {
    expect(ONBOARDING_STEPS.find((s) => s.id === "welcome")?.countsAsProgress).toBe(false)
  })

  it("declares every step for at least one shell", () => {
    for (const step of ONBOARDING_STEPS) {
      expect(step.availableIn.length).toBeGreaterThan(0)
    }
  })

  it("declares every step for at least one path", () => {
    for (const step of ONBOARDING_STEPS) {
      expect(step.modes.length).toBeGreaterThan(0)
    }
  })

  it("puts welcome in both paths — it is where the fork is asked", () => {
    expect(ONBOARDING_STEPS.find((s) => s.id === "welcome")?.modes).toEqual(["express", "custom"])
  })
})

describe("resolveStepSequence — the path fork", () => {
  it("offers only the intro until the user picks a path", () => {
    // Every step after the intro belongs to one path or the other, so picking
    // one for them would take the fork away before they saw it.
    expect(
      resolveStepSequence({ shell: "tauri", mode: undefined, hasModelAccess: false }).map(
        (s) => s.id
      )
    ).toEqual(["welcome"])
  })

  it("collapses the recommended path to two screens on every shell", () => {
    for (const shell of ["tauri", "web", "mobile-standalone", "mobile-paired"] as const) {
      expect(ids(shell, false, "express")).toEqual(["welcome", "express"])
    }
  })

  it("keeps model access from re-sequencing the recommended path", () => {
    // The express screen carries the sign-in line itself, so the fact that
    // suppresses the step-by-step sign-in step must not remove a screen here.
    expect(ids("tauri", true, "express")).toEqual(["welcome", "express"])
  })

  it("never mixes the two paths' steps into one sequence", () => {
    expect(ids("tauri", false, "express")).not.toContain("scan")
    expect(ids("tauri", false, "custom")).not.toContain("express")
  })
})

describe("resolveStepSequence", () => {
  it("gives desktop the full sequence", () => {
    expect(ids("tauri")).toEqual(["welcome", "scan", "provider", "first-run"])
  })

  it("drops the scan step in the browser — there is no local runtime to find", () => {
    expect(ids("web")).toEqual(["welcome", "provider", "first-run"])
  })

  it("drops the scan step for a standalone phone", () => {
    expect(ids("mobile-standalone")).toEqual(["welcome", "provider", "first-run"])
  })

  it("gives a paired phone scan (as the pairing flow) but never provider", () => {
    // A paired phone borrows the desktop's credentials; authenticating it
    // separately would configure the wrong machine.
    expect(ids("mobile-paired")).toEqual(["welcome", "scan", "first-run"])
  })

  it("drops the provider step once model access already exists", () => {
    expect(ids("tauri", true)).toEqual(["welcome", "scan", "first-run"])
    expect(ids("web", true)).toEqual(["welcome", "first-run"])
  })

  it("leaves a paired phone unchanged by hasModelAccess (it never had the step)", () => {
    expect(ids("mobile-paired", true)).toEqual(ids("mobile-paired", false))
  })
})

describe("nextStep / previousStep", () => {
  const seq = custom("tauri")

  it("walks forward through the sequence", () => {
    expect(nextStep(seq, "welcome")).toBe("scan")
    expect(nextStep(seq, "scan")).toBe("provider")
    expect(nextStep(seq, "provider")).toBe("first-run")
  })

  it("returns null past the last step", () => {
    expect(nextStep(seq, "first-run")).toBeNull()
  })

  it("walks backward and stops at the entry step", () => {
    expect(previousStep(seq, "scan")).toBe("welcome")
    expect(previousStep(seq, "welcome")).toBeNull()
  })

  it("restarts when asked to advance from a step this device does not show", () => {
    // e.g. a phone switched paired → standalone, stranding a persisted "scan".
    const webSeq = custom("web")
    expect(nextStep(webSeq, "scan")).toBe("welcome")
  })

  it("returns null for an unknown step when walking backward", () => {
    const webSeq = custom("web")
    expect(previousStep(webSeq, "scan")).toBeNull()
  })
})

describe("resumeStep", () => {
  const seq = custom("tauri")

  it("resumes a persisted step that is still in the sequence", () => {
    expect(resumeStep(seq, "provider")).toBe("provider")
  })

  it("starts over when there is no persisted step", () => {
    expect(resumeStep(seq, undefined)).toBe("welcome")
  })

  it("starts over when the persisted step was filtered out for this device", () => {
    const webSeq = custom("web")
    expect(resumeStep(webSeq, "scan")).toBe("welcome")
  })
})

describe("progressPosition", () => {
  it("reports the recommended path's single counted screen", () => {
    // In the sequence so back/next and resume work, but the panel hides the
    // stepper in this mode — "1 of 1" is not progress information.
    const seq = resolveStepSequence({ shell: "tauri", mode: "express", hasModelAccess: false })
    expect(progressPosition(seq, "express")).toEqual({ index: 0, total: 1 })
  })

  it("counts only progress-bearing steps", () => {
    const seq = custom("tauri")
    expect(progressPosition(seq, "scan")).toEqual({ index: 0, total: 3 })
    expect(progressPosition(seq, "first-run")).toEqual({ index: 2, total: 3 })
  })

  it("reports index -1 on welcome so the rail can omit a counter", () => {
    const seq = custom("tauri")
    expect(progressPosition(seq, "welcome")).toEqual({ index: -1, total: 3 })
  })

  it("shrinks the total when a step is filtered out", () => {
    const seq = custom("web", true)
    expect(progressPosition(seq, "first-run")).toEqual({ index: 0, total: 1 })
  })
})

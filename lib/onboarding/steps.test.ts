import type { OnboardingShell } from "@cognia/agent-config-types"
import {
  ONBOARDING_STEPS,
  nextStep,
  previousStep,
  progressPosition,
  resolveStepSequence,
  resumeStep,
} from "./steps"

const ids = (shell: OnboardingShell, hasModelAccess = false) =>
  resolveStepSequence({ shell, hasModelAccess }).map((s) => s.id)

describe("ONBOARDING_STEPS", () => {
  it("keeps welcome out of the progress count", () => {
    expect(ONBOARDING_STEPS.find((s) => s.id === "welcome")?.countsAsProgress).toBe(false)
  })

  it("declares every step for at least one shell", () => {
    for (const step of ONBOARDING_STEPS) {
      expect(step.availableIn.length).toBeGreaterThan(0)
    }
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
  const seq = resolveStepSequence({ shell: "tauri", hasModelAccess: false })

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
    const webSeq = resolveStepSequence({ shell: "web", hasModelAccess: false })
    expect(nextStep(webSeq, "scan")).toBe("welcome")
  })

  it("returns null for an unknown step when walking backward", () => {
    const webSeq = resolveStepSequence({ shell: "web", hasModelAccess: false })
    expect(previousStep(webSeq, "scan")).toBeNull()
  })
})

describe("resumeStep", () => {
  const seq = resolveStepSequence({ shell: "tauri", hasModelAccess: false })

  it("resumes a persisted step that is still in the sequence", () => {
    expect(resumeStep(seq, "provider")).toBe("provider")
  })

  it("starts over when there is no persisted step", () => {
    expect(resumeStep(seq, undefined)).toBe("welcome")
  })

  it("starts over when the persisted step was filtered out for this device", () => {
    const webSeq = resolveStepSequence({ shell: "web", hasModelAccess: false })
    expect(resumeStep(webSeq, "scan")).toBe("welcome")
  })
})

describe("progressPosition", () => {
  it("counts only progress-bearing steps", () => {
    const seq = resolveStepSequence({ shell: "tauri", hasModelAccess: false })
    expect(progressPosition(seq, "scan")).toEqual({ index: 0, total: 3 })
    expect(progressPosition(seq, "first-run")).toEqual({ index: 2, total: 3 })
  })

  it("reports index -1 on welcome so the rail can omit a counter", () => {
    const seq = resolveStepSequence({ shell: "tauri", hasModelAccess: false })
    expect(progressPosition(seq, "welcome")).toEqual({ index: -1, total: 3 })
  })

  it("shrinks the total when a step is filtered out", () => {
    const seq = resolveStepSequence({ shell: "web", hasModelAccess: true })
    expect(progressPosition(seq, "first-run")).toEqual({ index: 0, total: 1 })
  })
})

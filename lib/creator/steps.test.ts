import {
  CREATOR_STEPS,
  CREATOR_STEP_IDS,
  canAdvance,
  canWrite,
  creatorStep,
  creatorStepIndex,
  firstIncompleteStep,
  isTerminalCreatorStep,
  nextCreatorStep,
} from "./steps"
import type { CreatorStepId } from "@/types/creator"

const ALL_BEFORE = (step: CreatorStepId): CreatorStepId[] =>
  CREATOR_STEP_IDS.slice(0, CREATOR_STEP_IDS.indexOf(step))

describe("the step catalog", () => {
  it("has exactly the nine documented steps, in order", () => {
    expect(CREATOR_STEP_IDS).toEqual([
      "collect-requirements",
      "survey-existing",
      "plan-scaffold",
      "approve-permissions",
      "apply-changes",
      "verify",
      "preview",
      "review",
      "approve-delivery",
    ])
  })

  // The ordering IS the security property, so it gets its own assertion rather
  // than being implied by the list above.
  it("puts the only writing step after the permission gate", () => {
    const writing = CREATOR_STEPS.filter((step) => step.writes).map((step) => step.id)
    expect(writing).toEqual(["apply-changes"])
    expect(creatorStepIndex("apply-changes")).toBeGreaterThan(
      creatorStepIndex("approve-permissions")
    )
  })

  it("gates the permission and delivery steps on distinct approvals", () => {
    expect(creatorStep("approve-permissions").requiresApproval).toBe("permission-widening")
    expect(creatorStep("approve-delivery").requiresApproval).toBe("install")
  })

  it("throws on an unknown step rather than returning undefined", () => {
    expect(() => creatorStep("nope" as CreatorStepId)).toThrow(/Unknown Creator step/)
    expect(() => nextCreatorStep("nope" as CreatorStepId)).toThrow(/Unknown Creator step/)
  })

  it("walks the chain and terminates", () => {
    expect(nextCreatorStep("collect-requirements")).toBe("survey-existing")
    expect(nextCreatorStep("approve-delivery")).toBeUndefined()
    expect(isTerminalCreatorStep("approve-delivery")).toBe(true)
    expect(isTerminalCreatorStep("review")).toBe(false)
  })
})

describe("canAdvance", () => {
  it("allows the first step from an empty run", () => {
    expect(canAdvance("collect-requirements", { completed: [], approvals: [] })).toEqual({
      allowed: true,
    })
  })

  it("blocks a step whose predecessor has not completed", () => {
    expect(
      canAdvance("plan-scaffold", { completed: ["collect-requirements"], approvals: [] })
    ).toEqual({ allowed: false, reason: "out-of-order", blockedBy: "survey-existing" })
  })

  it("blocks an approval-gated step until the approval is granted", () => {
    const state = { completed: ALL_BEFORE("approve-permissions"), approvals: [] as never[] }
    expect(canAdvance("approve-permissions", state)).toEqual({
      allowed: false,
      reason: "awaiting-approval",
      approval: "permission-widening",
    })
  })

  it("allows it once the approval is granted", () => {
    expect(
      canAdvance("approve-permissions", {
        completed: ALL_BEFORE("approve-permissions"),
        approvals: ["permission-widening"],
      })
    ).toEqual({ allowed: true })
  })

  it("blocks re-running a non-repeatable step", () => {
    expect(
      canAdvance("apply-changes", {
        completed: [...ALL_BEFORE("apply-changes"), "apply-changes"],
        approvals: ["permission-widening"],
      })
    ).toEqual({ allowed: false, reason: "already-completed" })
  })

  it("allows re-running a repeatable step", () => {
    expect(
      canAdvance("verify", {
        completed: [...ALL_BEFORE("verify"), "verify"],
        approvals: ["permission-widening"],
      })
    ).toEqual({ allowed: true })
  })

  it("rejects an unknown step id", () => {
    expect(canAdvance("nope" as CreatorStepId, { completed: [], approvals: [] })).toEqual({
      allowed: false,
      reason: "unknown-step",
    })
  })

  it("is insensitive to the order the completed list is given in", () => {
    const shuffled = [...ALL_BEFORE("apply-changes")].reverse()
    expect(
      canAdvance("apply-changes", { completed: shuffled, approvals: ["permission-widening"] })
    ).toEqual({ allowed: true })
  })
})

describe("canWrite", () => {
  it("is false before the gate step completes", () => {
    expect(canWrite({ completed: [], approvals: ["permission-widening"] })).toBe(false)
  })

  it("is false when the step completed but the approval was revoked", () => {
    // A completed gate step is not enough on its own: the approval can be
    // withdrawn afterwards, and the write path re-checks rather than trusting
    // that the step once passed.
    expect(canWrite({ completed: ["approve-permissions"], approvals: [] })).toBe(false)
  })

  it("is true only with both the completed step and the live approval", () => {
    expect(
      canWrite({ completed: ["approve-permissions"], approvals: ["permission-widening"] })
    ).toBe(true)
  })
})

describe("firstIncompleteStep", () => {
  it("returns the first gap, not the first unlisted id", () => {
    expect(firstIncompleteStep(["collect-requirements", "plan-scaffold"])).toBe("survey-existing")
  })

  it("returns undefined for a finished run", () => {
    expect(firstIncompleteStep(CREATOR_STEP_IDS)).toBeUndefined()
  })
})

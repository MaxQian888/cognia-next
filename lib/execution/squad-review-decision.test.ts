import {
  isWellFormedSquadReviewDecision,
  validateSquadReviewDecision,
} from "./squad-review-decision"

const interrupt = (type: Parameters<typeof validateSquadReviewDecision>[0]["type"]) => ({ type })

describe("validateSquadReviewDecision", () => {
  it("accepts a plain approve or deny for the plan and the capability audit", () => {
    expect(validateSquadReviewDecision(interrupt("plan_approval"), "approve", undefined)).toEqual({
      ok: true,
      kind: "plan",
    })
    expect(
      validateSquadReviewDecision(interrupt("squad_capability_audit"), "approve", undefined)
    ).toEqual({ ok: true, kind: "capability_audit" })
    expect(validateSquadReviewDecision(interrupt("squad_budget"), "deny", undefined)).toEqual({
      ok: true,
      kind: "budget_extension",
    })
  })

  it("requires a payload to approve a budget, deadlock, repair or recovery", () => {
    for (const type of [
      "squad_budget",
      "squad_deadlock",
      "squad_teammate_repair",
      "team_recovery",
    ] as const) {
      expect(validateSquadReviewDecision(interrupt(type), "approve", undefined).problem).toBe(
        "decision_required"
      )
    }
  })

  it("rejects a decision whose kind does not match the interrupt", () => {
    expect(
      validateSquadReviewDecision(interrupt("squad_budget"), "approve", {
        kind: "deadlock",
        resetAll: true,
      })
    ).toEqual({ ok: false, problem: "kind_mismatch", kind: "budget_extension" })
  })

  it("rejects a decision on a non-Squad interrupt", () => {
    expect(
      validateSquadReviewDecision(interrupt("tool_approval"), "approve", { kind: "plan" })
    ).toEqual({ ok: false, problem: "not_a_squad_review" })
    expect(validateSquadReviewDecision(interrupt("tool_approval"), "approve", undefined)).toEqual({
      ok: true,
    })
  })

  it("checks the budget amount is a positive bounded integer", () => {
    const budget = interrupt("squad_budget")
    expect(
      validateSquadReviewDecision(budget, "approve", {
        kind: "budget_extension",
        extraTokens: 5000,
      }).ok
    ).toBe(true)
    for (const extraTokens of [0, -1, 1.5, Number.NaN, 20_000_000, "5000"]) {
      expect(
        validateSquadReviewDecision(budget, "approve", { kind: "budget_extension", extraTokens })
          .problem
      ).toBe("malformed")
    }
  })

  it("requires the selected teammates or resetAll for a deadlock", () => {
    const deadlock = interrupt("squad_deadlock")
    expect(
      validateSquadReviewDecision(deadlock, "approve", { kind: "deadlock", resetAll: true }).ok
    ).toBe(true)
    expect(
      validateSquadReviewDecision(deadlock, "approve", { kind: "deadlock", teammateIds: ["a"] }).ok
    ).toBe(true)
    expect(
      validateSquadReviewDecision(deadlock, "approve", { kind: "deadlock", teammateIds: [] })
        .problem
    ).toBe("malformed")
    expect(
      validateSquadReviewDecision(deadlock, "approve", { kind: "deadlock", teammateIds: [""] })
        .problem
    ).toBe("malformed")
  })

  it("requires a target host for retry_host and nothing else", () => {
    const recovery = interrupt("team_recovery")
    expect(
      validateSquadReviewDecision(recovery, "approve", {
        kind: "team_recovery",
        choice: "retry_host",
      }).problem
    ).toBe("malformed")
    expect(
      validateSquadReviewDecision(recovery, "approve", {
        kind: "team_recovery",
        choice: "retry_host",
        hostRef: "device-2",
      }).ok
    ).toBe(true)
    expect(
      validateSquadReviewDecision(recovery, "approve", {
        kind: "team_recovery",
        choice: "terminate",
      }).ok
    ).toBe(true)
    expect(
      validateSquadReviewDecision(recovery, "approve", { kind: "team_recovery", choice: "replay" })
        .problem
    ).toBe("malformed")
  })

  it("bounds free-text feedback", () => {
    expect(isWellFormedSquadReviewDecision({ kind: "plan", feedback: "x".repeat(4_000) })).toBe(
      true
    )
    expect(isWellFormedSquadReviewDecision({ kind: "plan", feedback: "x".repeat(4_001) })).toBe(
      false
    )
  })

  it("rejects non-object payloads and unknown kinds", () => {
    expect(validateSquadReviewDecision(interrupt("plan_approval"), "approve", "yes").problem).toBe(
      "malformed"
    )
    expect(isWellFormedSquadReviewDecision({ kind: "mystery" })).toBe(false)
    expect(isWellFormedSquadReviewDecision(null)).toBe(false)
  })
})

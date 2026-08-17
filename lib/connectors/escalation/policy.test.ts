import type { EscalationPolicy } from "@/types/connectors/escalation"
import { dueSteps, overdueMinutesAt, validateEscalationPolicy } from "./policy"

const POLICY: EscalationPolicy = {
  steps: [
    { afterOverdueMinutes: 0, actions: [{ type: "notify" }] },
    { afterOverdueMinutes: 15, actions: [{ type: "switchMode", mode: "manual" }] },
    { afterOverdueMinutes: 60, actions: [{ type: "reassign", assignee: { kind: "human" } }] },
  ],
}

describe("dueSteps", () => {
  it("returns nothing for an absent / empty policy or a not-yet-due deadline", () => {
    expect(dueSteps(undefined, 10, undefined)).toEqual([])
    expect(dueSteps({ steps: [] }, 10, undefined)).toEqual([])
    expect(dueSteps(POLICY, -1, undefined)).toEqual([])
    expect(dueSteps(POLICY, Number.NaN, undefined)).toEqual([])
  })

  it("fires step 0 at the deadline and later steps as the overdue grows", () => {
    expect(dueSteps(POLICY, 0, undefined).map((d) => d.index)).toEqual([0])
    expect(dueSteps(POLICY, 14.9, undefined).map((d) => d.index)).toEqual([0])
    expect(dueSteps(POLICY, 15, undefined).map((d) => d.index)).toEqual([0, 1])
    expect(dueSteps(POLICY, 999, undefined).map((d) => d.index)).toEqual([0, 1, 2])
  })

  it("skips steps at or below the last fired step (each step fires once)", () => {
    expect(dueSteps(POLICY, 999, 0).map((d) => d.index)).toEqual([1, 2])
    expect(dueSteps(POLICY, 20, 1)).toEqual([])
    expect(dueSteps(POLICY, 999, 2)).toEqual([])
    expect(dueSteps(POLICY, 999, 7)).toEqual([])
  })

  it("stops scanning at the first not-yet-due step and hands back the step object", () => {
    const due = dueSteps(POLICY, 15, undefined)
    expect(due[1].step).toBe(POLICY.steps[1])
  })

  it("overdueMinutesAt is negative before the deadline and positive after", () => {
    expect(overdueMinutesAt(120_000, 60_000)).toBe(-1)
    expect(overdueMinutesAt(60_000, 120_000)).toBe(1)
  })
})

describe("validateEscalationPolicy", () => {
  it("accepts a well-formed chain and an empty (escalation-off) chain", () => {
    expect(validateEscalationPolicy(POLICY)).toEqual({ ok: true, issues: [] })
    expect(validateEscalationPolicy({ steps: [] }).ok).toBe(true)
    expect(
      validateEscalationPolicy({
        steps: [
          {
            afterOverdueMinutes: 5,
            actions: [
              { type: "reassign", assignee: { kind: "team", id: "t1" } },
              { type: "urgent", userIds: ["ou_1"], via: "sms" },
            ],
          },
        ],
      }).ok
    ).toBe(true)
  })

  it("rejects more than 10 steps", () => {
    const steps = Array.from({ length: 11 }, (_, i) => ({
      afterOverdueMinutes: i,
      actions: [{ type: "notify" as const }],
    }))
    expect(validateEscalationPolicy({ steps }).issues).toContainEqual({
      code: "too_many_steps",
      max: 10,
    })
  })

  it("rejects non-integer / negative minutes and non-ascending steps", () => {
    const { issues } = validateEscalationPolicy({
      steps: [
        { afterOverdueMinutes: 10, actions: [{ type: "notify" }] },
        { afterOverdueMinutes: 10, actions: [{ type: "notify" }] },
        { afterOverdueMinutes: 5, actions: [{ type: "notify" }] },
        { afterOverdueMinutes: -1, actions: [{ type: "notify" }] },
        { afterOverdueMinutes: 1.5, actions: [{ type: "notify" }] },
      ],
    })
    expect(issues).toEqual(
      expect.arrayContaining([
        { code: "steps_not_ascending", step: 1 },
        { code: "steps_not_ascending", step: 2 },
        { code: "step_minutes_invalid", step: 3 },
        { code: "step_minutes_invalid", step: 4 },
      ])
    )
  })

  it("rejects steps without actions and malformed actions", () => {
    const { issues } = validateEscalationPolicy({
      steps: [
        { afterOverdueMinutes: 0, actions: [] },
        {
          afterOverdueMinutes: 1,
          actions: [
            { type: "bogus" } as never,
            { type: "reassign", assignee: { kind: "character", id: " " } },
            { type: "reassign", assignee: undefined as never },
            { type: "switchMode", mode: "auto" as never },
            { type: "urgent", userIds: [] },
            { type: "urgent", userIds: [" "] },
          ],
        },
      ],
    })
    expect(issues).toEqual([
      { code: "step_without_actions", step: 0 },
      { code: "action_type_unknown", step: 1, action: 0 },
      { code: "reassign_target_missing", step: 1, action: 1 },
      { code: "reassign_target_missing", step: 1, action: 2 },
      { code: "switch_mode_invalid", step: 1, action: 3 },
      { code: "urgent_users_missing", step: 1, action: 4 },
      { code: "urgent_users_missing", step: 1, action: 5 },
    ])
  })

  it("tolerates a malformed root (missing steps array)", () => {
    expect(validateEscalationPolicy({} as EscalationPolicy).ok).toBe(true)
    expect(validateEscalationPolicy({ steps: [undefined as never] }).issues).toEqual([
      { code: "step_minutes_invalid", step: 0 },
      { code: "step_without_actions", step: 0 },
    ])
  })
})

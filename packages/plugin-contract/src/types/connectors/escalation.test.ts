import {
  ESCALATION_ACTION_TYPES,
  MAX_ESCALATION_STEPS,
  URGENT_CAPABLE_PLATFORMS,
  isUrgentCapablePlatform,
  type EscalationAction,
  type EscalationPolicy,
} from "./escalation"

describe("types/connectors/escalation", () => {
  it("lists every action discriminant exactly once", () => {
    expect([...ESCALATION_ACTION_TYPES].sort()).toEqual(
      ["notify", "reassign", "switchMode", "urgent"].sort()
    )
    expect(new Set(ESCALATION_ACTION_TYPES).size).toBe(ESCALATION_ACTION_TYPES.length)
  })

  it("caps the chain length at 10 steps", () => {
    expect(MAX_ESCALATION_STEPS).toBe(10)
  })

  it("marks only Lark as urgent-capable (the action is intentionally inert elsewhere)", () => {
    expect([...URGENT_CAPABLE_PLATFORMS]).toEqual(["lark"])
    expect(isUrgentCapablePlatform("lark")).toBe(true)
    expect(isUrgentCapablePlatform("telegram")).toBe(false)
    expect(isUrgentCapablePlatform(undefined)).toBe(false)
  })

  it("type-checks a full policy shape", () => {
    const urgent: EscalationAction = { type: "urgent", userIds: ["ou_1"], via: "sms" }
    const policy: EscalationPolicy = {
      steps: [
        { afterOverdueMinutes: 0, actions: [{ type: "notify" }] },
        {
          afterOverdueMinutes: 15,
          actions: [
            { type: "reassign", assignee: { kind: "team", id: "t1" } },
            { type: "switchMode", mode: "manual" },
            urgent,
          ],
        },
      ],
    }
    expect(policy.steps).toHaveLength(2)
    expect(policy.steps[1].actions.map((a) => a.type)).toEqual(["reassign", "switchMode", "urgent"])
  })
})

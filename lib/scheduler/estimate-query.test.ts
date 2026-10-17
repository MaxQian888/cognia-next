import { externalAgentProviderId } from "@/lib/ai/agent/external/session/session-models"

import { scheduledTaskEstimateQuery } from "./estimate-query"

describe("scheduledTaskEstimateQuery", () => {
  it("estimates scheduled goals and squads from goal and squad history", () => {
    expect(scheduledTaskEstimateQuery({ taskType: "goal" })).toEqual({ surface: "goal" })
    expect(scheduledTaskEstimateQuery({ taskType: "agent-team" })).toEqual({ surface: "team" })
  })

  it("uses the scheduled bucket and the draft model for conversation tasks", () => {
    for (const taskType of ["chat", "agent", "skill"] as const) {
      expect(scheduledTaskEstimateQuery({ taskType, model: " gpt-5 " })).toEqual({
        surface: "scheduled",
        model: "gpt-5",
      })
    }
    expect(scheduledTaskEstimateQuery({ taskType: "chat", model: "" })).toEqual({
      surface: "scheduled",
      model: null,
    })
  })

  it("keys external-agent tasks on the configured agent, unknown until one is picked", () => {
    expect(
      scheduledTaskEstimateQuery({ taskType: "external-agent", externalAgentId: "cfg" })
    ).toEqual({
      surface: "scheduled",
      providerId: externalAgentProviderId("cfg"),
    })
    expect(
      scheduledTaskEstimateQuery({ taskType: "external-agent", externalAgentId: " " })
    ).toEqual({
      surface: "scheduled",
      harness: null,
    })
  })

  it("has no estimate for task types that launch no agent run", () => {
    for (const taskType of [
      "workflow",
      "backup",
      "im-push",
      "background-command",
      "plan",
    ] as const) {
      expect(scheduledTaskEstimateQuery({ taskType })).toBeNull()
    }
  })
})

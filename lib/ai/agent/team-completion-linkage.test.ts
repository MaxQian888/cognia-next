const dispatchTriggerMock = jest.fn()
jest.mock("@/lib/workflow/runtime/trigger-bridge", () => ({
  dispatchTrigger: (...args: unknown[]) => dispatchTriggerMock(...args),
}))

const findMatchingWorkflowsMock = jest.fn()
jest.mock("@/lib/workflow/runtime/trigger-subscriptions", () => ({
  findMatchingWorkflows: (...args: unknown[]) => findMatchingWorkflowsMock(...args),
}))

const hasNoLeakingPiiMock = jest.fn<boolean, [string]>()
jest.mock("@cognia/redact", () => ({
  hasNoLeakingPii: (text: string) => hasNoLeakingPiiMock(text),
}))

import {
  dispatchTeamCompletedTriggers,
  MAX_TEAM_TRIGGER_CHAIN_DEPTH,
  type TeamCompletedEvent,
} from "./team-completion-linkage"

const baseEvent: TeamCompletedEvent = {
  teamId: "team-1",
  teamName: "Alpha",
  runId: "run_team_1",
  status: "completed",
  reason: "all tasks done",
  finalResult: "The synthesized report.",
  chainDepth: 0,
}

beforeEach(() => {
  dispatchTriggerMock.mockReset().mockResolvedValue(undefined)
  findMatchingWorkflowsMock.mockReset().mockReturnValue([])
  hasNoLeakingPiiMock.mockReset().mockReturnValue(true)
})

describe("dispatchTeamCompletedTriggers", () => {
  it("fans out to every matching workflow with the team payload + incremented depth", async () => {
    findMatchingWorkflowsMock.mockReturnValue([
      { workflowId: "wf-1", nodeId: "n1", params: {} },
      { workflowId: "wf-2", nodeId: "n2", params: {} },
    ])
    await dispatchTeamCompletedTriggers(baseEvent)

    expect(findMatchingWorkflowsMock).toHaveBeenCalledWith("trigger.team", {
      teamId: "team-1",
      status: "completed",
    })
    expect(dispatchTriggerMock).toHaveBeenCalledTimes(2)
    expect(dispatchTriggerMock.mock.calls[0][0]).toMatchObject({
      workflowId: "wf-1",
      kind: "trigger.team",
      payload: {
        event: "team.completed",
        teamId: "team-1",
        teamName: "Alpha",
        runId: "run_team_1",
        status: "completed",
        reason: "all tasks done",
        finalResult: "The synthesized report.",
        chainDepth: 1,
      },
      binding: { teamId: "team-1" },
    })
  })

  it("stops at the chain-depth cap (loop guard)", async () => {
    findMatchingWorkflowsMock.mockReturnValue([{ workflowId: "wf-1", nodeId: "n1", params: {} }])
    await dispatchTeamCompletedTriggers({
      ...baseEvent,
      chainDepth: MAX_TEAM_TRIGGER_CHAIN_DEPTH,
    })
    expect(findMatchingWorkflowsMock).not.toHaveBeenCalled()
    expect(dispatchTriggerMock).not.toHaveBeenCalled()
  })

  it("omits reason/finalResult that fail the PII gate", async () => {
    findMatchingWorkflowsMock.mockReturnValue([{ workflowId: "wf-1", nodeId: "n1", params: {} }])
    hasNoLeakingPiiMock.mockReturnValue(false)
    await dispatchTeamCompletedTriggers(baseEvent)

    const payload = (dispatchTriggerMock.mock.calls[0][0] as { payload: Record<string, unknown> })
      .payload
    expect(payload.reason).toBeUndefined()
    expect(payload.finalResult).toBeUndefined()
    // Identity fields still flow.
    expect(payload.teamId).toBe("team-1")
    expect(payload.status).toBe("completed")
  })

  it("truncates an oversized finalResult", async () => {
    findMatchingWorkflowsMock.mockReturnValue([{ workflowId: "wf-1", nodeId: "n1", params: {} }])
    await dispatchTeamCompletedTriggers({ ...baseEvent, finalResult: "x".repeat(10_000) })
    const payload = (dispatchTriggerMock.mock.calls[0][0] as { payload: { finalResult: string } })
      .payload
    expect(payload.finalResult).toHaveLength(4000)
  })

  it("does nothing when no workflow subscribes", async () => {
    await dispatchTeamCompletedTriggers(baseEvent)
    expect(dispatchTriggerMock).not.toHaveBeenCalled()
  })

  it("isolates per-match dispatch failures and never throws", async () => {
    findMatchingWorkflowsMock.mockReturnValue([
      { workflowId: "wf-bad", nodeId: "n1", params: {} },
      { workflowId: "wf-good", nodeId: "n2", params: {} },
    ])
    dispatchTriggerMock.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(undefined)
    await expect(dispatchTeamCompletedTriggers(baseEvent)).resolves.toBeUndefined()
    expect(dispatchTriggerMock).toHaveBeenCalledTimes(2)
  })
})

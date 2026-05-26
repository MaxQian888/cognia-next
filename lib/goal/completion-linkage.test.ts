import type { Goal } from "@/types/goal"

const notifyMock = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/tauri/notification", () => ({
  notify: (...a: unknown[]) => notifyMock(...a),
}))

const dispatchTriggerMock = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/workflow/runtime/trigger-bridge", () => ({
  dispatchTrigger: (...a: unknown[]) => dispatchTriggerMock(...a),
}))

const findMatchingWorkflowsMock = jest.fn(() => [] as Array<{ workflowId: string }>)
jest.mock("@/lib/workflow/runtime/trigger-subscriptions", () => ({
  findMatchingWorkflows: (...a: unknown[]) => findMatchingWorkflowsMock(...(a as [])),
}))

import { onGoalTerminal } from "./completion-linkage"

function buildGoal(over: Partial<Goal> = {}): Goal {
  const now = Date.now()
  return {
    id: "g1",
    sessionId: "ses_a",
    characterId: "char_1",
    rawObjective: "email alice@example.com the report",
    safeObjective: "email <EMAIL_001> the report",
    redactionMapEnc: "",
    status: "completed",
    turnsUsed: 4,
    tokensUsed: 1234,
    judgeFailureCount: 0,
    config: { maxTurns: 20, maxTokens: 200_000, maxJudgeFailures: 3, timeoutMs: 1_800_000 },
    generationId: "gen-1",
    createdAt: now,
    updatedAt: now,
    ...over,
  }
}

beforeEach(() => {
  notifyMock.mockReset().mockResolvedValue(undefined)
  dispatchTriggerMock.mockReset().mockResolvedValue(undefined)
  findMatchingWorkflowsMock.mockReset().mockReturnValue([])
})

describe("onGoalTerminal", () => {
  it("sends a notification with the status + redacted objective", async () => {
    await onGoalTerminal(buildGoal())
    expect(notifyMock).toHaveBeenCalledTimes(1)
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining("completed"),
        body: "email <EMAIL_001> the report",
      })
    )
  })

  it("fires matching goal-completed workflows with a redacted payload", async () => {
    findMatchingWorkflowsMock.mockReturnValue([{ workflowId: "wf1" }])
    await onGoalTerminal(buildGoal())
    expect(findMatchingWorkflowsMock).toHaveBeenCalledWith(
      "trigger.goal.completed",
      expect.objectContaining({ goalId: "g1", status: "completed", sessionId: "ses_a" })
    )
    expect(dispatchTriggerMock).toHaveBeenCalledTimes(1)
    const arg = dispatchTriggerMock.mock.calls[0]![0] as {
      kind: string
      payload: Record<string, unknown>
    }
    expect(arg.kind).toBe("trigger.goal.completed")
    expect(arg.payload.safeObjective).toBe("email <EMAIL_001> the report")
    // PII red-line: the raw objective must never reach the workflow payload.
    expect(arg.payload).not.toHaveProperty("rawObjective")
  })

  it("does not dispatch when no workflow matches", async () => {
    findMatchingWorkflowsMock.mockReturnValue([])
    await onGoalTerminal(buildGoal())
    expect(dispatchTriggerMock).not.toHaveBeenCalled()
  })

  it("is best-effort — a notification failure does not throw", async () => {
    notifyMock.mockRejectedValueOnce(new Error("permission denied"))
    await expect(onGoalTerminal(buildGoal())).resolves.toBeUndefined()
  })

  it("is best-effort — a dispatch failure does not throw", async () => {
    findMatchingWorkflowsMock.mockReturnValue([{ workflowId: "wf1" }])
    dispatchTriggerMock.mockRejectedValueOnce(new Error("workflow blew up"))
    await expect(onGoalTerminal(buildGoal())).resolves.toBeUndefined()
  })
})

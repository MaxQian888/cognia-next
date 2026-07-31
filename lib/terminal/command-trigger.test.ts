/**
 * Tests for the `trigger.terminal.command` fan-out
 * (`dispatchTerminalCommandTriggers`): the three safety gates
 * (agent-spawned tabs, blank commands, PII), match-context shape,
 * payload shape, and per-match failure isolation.
 */

const dispatchTriggerMock = jest.fn()
jest.mock("@/lib/workflow/runtime/trigger-bridge", () => ({
  dispatchTrigger: (...args: unknown[]) => dispatchTriggerMock(...args),
}))

const findMatchingWorkflowsMock = jest.fn()
jest.mock("@/lib/workflow/runtime/trigger-subscriptions", () => ({
  findMatchingWorkflows: (...args: unknown[]) => findMatchingWorkflowsMock(...args),
}))

const hasNoLeakingPiiMock = jest.fn()
jest.mock("@cognia/redact", () => ({
  hasNoLeakingPii: (...args: unknown[]) => hasNoLeakingPiiMock(...args),
}))

import { dispatchTerminalCommandTriggers, type TerminalCommandEndEvent } from "./command-trigger"

function makeEvent(overrides: Partial<TerminalCommandEndEvent> = {}): TerminalCommandEndEvent {
  return {
    sessionId: "tab-1",
    projectId: "proj-1",
    agentSpawner: null,
    command: "pnpm test",
    exitCode: 0,
    endedAt: 1000,
    ...overrides,
  }
}

beforeEach(() => {
  dispatchTriggerMock.mockReset().mockResolvedValue(undefined)
  findMatchingWorkflowsMock.mockReset().mockReturnValue([])
  hasNoLeakingPiiMock.mockReset().mockReturnValue(true)
})

describe("dispatchTerminalCommandTriggers", () => {
  it("queries subscriptions with the full match context", async () => {
    await dispatchTerminalCommandTriggers(makeEvent())
    expect(findMatchingWorkflowsMock).toHaveBeenCalledWith("trigger.terminal.command", {
      sessionId: "tab-1",
      projectId: "proj-1",
      status: "success",
      command: "pnpm test",
    })
  })

  it("dispatches one trigger per match with the redaction-gated payload", async () => {
    findMatchingWorkflowsMock.mockReturnValue([
      { workflowId: "wf-a", nodeId: "n1", params: {} },
      { workflowId: "wf-b", nodeId: "n2", params: {} },
    ])
    await dispatchTerminalCommandTriggers(makeEvent({ exitCode: 2 }))
    expect(dispatchTriggerMock).toHaveBeenCalledTimes(2)
    expect(dispatchTriggerMock).toHaveBeenCalledWith({
      workflowId: "wf-a",
      triggerId: "n1",
      kind: "trigger.terminal.command",
      payload: {
        sessionId: "tab-1",
        projectId: "proj-1",
        command: "pnpm test",
        exitCode: 2,
        status: "failure",
        endedAt: 1000,
      },
      originAt: 1000,
      binding: { sessionId: "tab-1" },
    })
  })

  it("never dispatches for agent/workflow-spawned tabs (self-trigger loop guard)", async () => {
    await dispatchTerminalCommandTriggers(makeEvent({ agentSpawner: "run-99" }))
    expect(findMatchingWorkflowsMock).not.toHaveBeenCalled()
    expect(dispatchTriggerMock).not.toHaveBeenCalled()
  })

  it("never dispatches for blank command lines (bare Enter)", async () => {
    await dispatchTerminalCommandTriggers(makeEvent({ command: "   " }))
    expect(findMatchingWorkflowsMock).not.toHaveBeenCalled()
  })

  it("redacts the command when the PII gate fails — matching and payload see an empty string", async () => {
    hasNoLeakingPiiMock.mockReturnValue(false)
    findMatchingWorkflowsMock.mockReturnValue([{ workflowId: "wf-a", nodeId: "n1", params: {} }])
    await dispatchTerminalCommandTriggers(makeEvent({ command: "export TOKEN=sk-secret" }))
    expect(findMatchingWorkflowsMock).toHaveBeenCalledWith(
      "trigger.terminal.command",
      expect.objectContaining({ command: "" })
    )
    expect(dispatchTriggerMock.mock.calls[0][0].payload.command).toBe("")
  })

  it("passes projectId through as undefined when the tab has none", async () => {
    await dispatchTerminalCommandTriggers(makeEvent({ projectId: null }))
    expect(findMatchingWorkflowsMock).toHaveBeenCalledWith(
      "trigger.terminal.command",
      expect.objectContaining({ projectId: undefined })
    )
  })

  it("skips dispatch entirely when nothing matches", async () => {
    await dispatchTerminalCommandTriggers(makeEvent())
    expect(dispatchTriggerMock).not.toHaveBeenCalled()
  })

  it("isolates per-match failures — one bad workflow can't block the others", async () => {
    findMatchingWorkflowsMock.mockReturnValue([
      { workflowId: "wf-bad", nodeId: "n1", params: {} },
      { workflowId: "wf-good", nodeId: "n2", params: {} },
    ])
    dispatchTriggerMock.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(undefined)
    await expect(dispatchTerminalCommandTriggers(makeEvent())).resolves.toBeUndefined()
    expect(dispatchTriggerMock).toHaveBeenCalledTimes(2)
  })

  it("swallows a missing workflow runtime (best-effort)", async () => {
    findMatchingWorkflowsMock.mockImplementation(() => {
      throw new Error("runtime unavailable")
    })
    await expect(dispatchTerminalCommandTriggers(makeEvent())).resolves.toBeUndefined()
  })
})

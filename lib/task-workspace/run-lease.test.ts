const begin = jest.fn()
const settle = jest.fn()

jest.mock("./client", () => ({
  beginTaskWorkspaceTurn: (...args: unknown[]) => begin(...args),
  settleTaskWorkspaceRunWithProjection: (...args: unknown[]) => settle(...args),
}))

import { withTaskWorkspaceRun } from "./run-lease"

describe("withTaskWorkspaceRun", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    begin.mockResolvedValue({ runId: "workspace-run", executionRoot: "/isolated" })
    settle.mockResolvedValue([{ path: "src/a.ts", kind: "modified", captureClass: "source" }])
  })

  it("executes in the isolated root and settles with correlated identities", async () => {
    const execute = jest.fn(async (cwd: string) => `ran:${cwd}`)
    const outcome = await withTaskWorkspaceRun(
      {
        enabled: true,
        workspaceRoot: "/repo",
        base: { kind: "gitRef", gitRef: "origin/dev" },
        sessionId: "session-1",
        runId: "execution-1",
        turnId: "turn-1",
        attemptId: "attempt-1",
        providerAttemptId: "provider-1",
        executionRunId: "journal-1",
        traceId: "trace-1",
        traceSpanId: "span-1",
        surface: "workflow-agent-turn",
        agentId: "agent-1",
        agentKind: "in-app",
      },
      execute
    )

    expect(execute).toHaveBeenCalledWith("/isolated")
    expect(settle).toHaveBeenCalledWith("workspace-run", "ready")
    expect(begin).toHaveBeenCalledWith(
      expect.objectContaining({
        executionRunId: "journal-1",
        traceId: "trace-1",
        turnId: "turn-1",
        attemptId: "attempt-1",
        providerAttemptId: "provider-1",
        surface: "workflow-agent-turn",
      })
    )
    expect(outcome).toEqual(
      expect.objectContaining({ value: "ran:/isolated", taskWorkspaceRunId: "workspace-run" })
    )
  })

  it("settles failed work without replacing the original error", async () => {
    const failure = new Error("provider failed")
    await expect(
      withTaskWorkspaceRun(
        {
          enabled: true,
          workspaceRoot: "/repo",
          sessionId: "session-1",
          runId: "execution-1",
          attemptId: "attempt-1",
          surface: "plugin",
          agentId: "plugin-1",
          agentKind: "plugin",
        },
        async () => {
          throw failure
        }
      )
    ).rejects.toBe(failure)
    expect(settle).toHaveBeenCalledWith("workspace-run", "failed")
  })

  it("settles aborted work as cancelled", async () => {
    const cancellation = new Error("cancelled")
    cancellation.name = "AbortError"
    await expect(
      withTaskWorkspaceRun(
        {
          enabled: true,
          workspaceRoot: "/repo",
          sessionId: "session-1",
          runId: "execution-1",
          attemptId: "attempt-1",
          surface: "workflow",
          agentId: "agent-1",
          agentKind: "workflow",
        },
        async () => {
          throw cancellation
        }
      )
    ).rejects.toBe(cancellation)
    expect(settle).toHaveBeenCalledWith("workspace-run", "cancelled")
  })

  it("reports host-unavailable tracking instead of claiming an empty ledger", async () => {
    begin.mockResolvedValue(null)
    const outcome = await withTaskWorkspaceRun(
      {
        enabled: true,
        workspaceRoot: "/repo",
        sessionId: "session-1",
        runId: "execution-1",
        attemptId: "attempt-1",
        surface: "plugin",
        agentId: "plugin-1",
        agentKind: "plugin",
      },
      async (cwd) => cwd
    )
    expect(outcome.value).toBe("/repo")
    expect(outcome.trackingUnavailable).toBe(true)
    expect(settle).not.toHaveBeenCalled()
  })
})

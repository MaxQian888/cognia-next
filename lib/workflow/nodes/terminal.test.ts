/**
 * Tests for the `action.system.terminal` workflow executor.
 *
 * The executor delegates to `runTerminalDockAction` (covered by its own
 * suite). These tests verify the wiring: arg composition, timeout
 * clamping, decision/branch routing, error surfaces.
 */

const mockRun = jest.fn()
jest.mock("@/lib/terminal/dock-tool-handler", () => ({
  runTerminalDockAction: (...args: unknown[]) => mockRun(...args),
}))

const mockHeadless = jest.fn()
jest.mock("@/lib/terminal/headless-exec", () => ({
  runHeadlessExec: (...args: unknown[]) => mockHeadless(...args),
}))

// Force the executor to register on import.
import "./terminal"

import { getExecutor } from "./registry"
import type { StepExecutionContext } from "@/types/workflow/visual"

function makeCtx(
  overrides: Partial<StepExecutionContext> & { params?: Record<string, unknown> }
): StepExecutionContext {
  const base = {
    runId: "run-1",
    stepId: "step-1",
    workflowId: "wf-1",
    upstream: {},
    trigger: { workflowId: "wf-1", kind: "trigger.manual" as const, payload: null, originAt: 0 },
    params: overrides.params ?? {},
    signal: new AbortController().signal,
    log: jest.fn(),
    resolveSecret: jest.fn(async () => ""),
  } as unknown as StepExecutionContext
  return base
}

beforeEach(() => {
  mockRun.mockReset()
  mockHeadless.mockReset()
})

describe("action.system.terminal executor", () => {
  it("is registered with typeVersion 1", () => {
    const reg = getExecutor("action.system.terminal", 1)
    expect(reg).toBeDefined()
    expect(reg?.retryable).toBe(false)
  })

  it("rejects when command is missing", async () => {
    const reg = getExecutor("action.system.terminal", 1)!
    await expect(reg.execute(makeCtx({ params: {} }))).rejects.toThrow(/non-empty 'command'/)
  })

  it("calls runTerminalDockAction with action=spawn when no tabId given", async () => {
    mockRun.mockResolvedValue({
      ok: true,
      sessionId: "tab-new",
      exitCode: 0,
      output: "pnpm test",
    })
    const reg = getExecutor("action.system.terminal", 1)!
    await reg.execute(
      makeCtx({
        params: { command: "pnpm test", cwd: "/repo", projectId: "p1", timeoutSec: 90 },
      })
    )
    expect(mockRun).toHaveBeenCalledTimes(1)
    const arg = mockRun.mock.calls[0][0]
    expect(arg.action).toBe("spawn")
    expect(arg.chatSessionId).toBe("run-1")
    expect(arg.args.command).toBe("pnpm test")
    expect(arg.args.cwd).toBe("/repo")
    expect(arg.args.projectId).toBe("p1")
    expect(arg.args.timeoutSec).toBe(90)
  })

  it("calls runTerminalDockAction with action=write when tabId is set", async () => {
    mockRun.mockResolvedValue({
      ok: true,
      sessionId: "tab-X",
      exitCode: 0,
      output: "ls",
    })
    const reg = getExecutor("action.system.terminal", 1)!
    await reg.execute(makeCtx({ params: { command: "ls", tabId: "tab-X" } }))
    const arg = mockRun.mock.calls[0][0]
    expect(arg.action).toBe("write")
    expect(arg.args.tabId).toBe("tab-X")
  })

  it("composes extra args into the command line", async () => {
    mockRun.mockResolvedValue({
      ok: true,
      sessionId: "t",
      exitCode: 0,
      output: "",
    })
    const reg = getExecutor("action.system.terminal", 1)!
    await reg.execute(makeCtx({ params: { command: "git", args: ["status", "--short"] } }))
    expect(mockRun.mock.calls[0][0].args.command).toBe("git status --short")
  })

  it("clamps timeoutSec to the [5, 600] range", async () => {
    mockRun.mockResolvedValue({ ok: true, sessionId: "t", exitCode: 0, output: "" })
    const reg = getExecutor("action.system.terminal", 1)!
    await reg.execute(makeCtx({ params: { command: "x", timeoutSec: 0 } }))
    expect(mockRun.mock.calls[0][0].args.timeoutSec).toBe(5)
    mockRun.mockClear()
    await reg.execute(makeCtx({ params: { command: "x", timeoutSec: 99999 } }))
    expect(mockRun.mock.calls[0][0].args.timeoutSec).toBe(600)
  })

  it("returns decision=success and exitCode=0 on successful exit", async () => {
    mockRun.mockResolvedValue({ ok: true, sessionId: "t", exitCode: 0, output: "ok" })
    const reg = getExecutor("action.system.terminal", 1)!
    const result = await reg.execute(makeCtx({ params: { command: "true" } }))
    expect(result.decision).toBe("success")
    expect((result.output as { exitCode: number }).exitCode).toBe(0)
  })

  it("throws by default on non-zero exit (onFailure=throw)", async () => {
    mockRun.mockResolvedValue({ ok: true, sessionId: "t", exitCode: 1, output: "" })
    const reg = getExecutor("action.system.terminal", 1)!
    await expect(reg.execute(makeCtx({ params: { command: "false" } }))).rejects.toThrow(
      /exited with code 1/
    )
  })

  it("routes to decision=failure on non-zero exit when onFailure=branch", async () => {
    mockRun.mockResolvedValue({ ok: true, sessionId: "t", exitCode: 2, output: "" })
    const reg = getExecutor("action.system.terminal", 1)!
    const result = await reg.execute(makeCtx({ params: { command: "false", onFailure: "branch" } }))
    expect(result.decision).toBe("failure")
    expect((result.output as { exitCode: number }).exitCode).toBe(2)
  })

  it("surfaces structured errors from runTerminalDockAction as workflow failures", async () => {
    mockRun.mockResolvedValue({ ok: false, reason: "agent terminal access is disabled" })
    const reg = getExecutor("action.system.terminal", 1)!
    await expect(reg.execute(makeCtx({ params: { command: "ls" } }))).rejects.toThrow(
      /agent terminal access is disabled/
    )
  })

  describe("unattended mode", () => {
    it("routes through runHeadlessExec with run context, never the dock", async () => {
      mockHeadless.mockResolvedValue({
        ok: true,
        exitCode: 0,
        output: "done",
        durationMs: 30,
        timedOut: false,
        verdict: "allow",
      })
      const reg = getExecutor("action.system.terminal", 1)!
      const result = await reg.execute(
        makeCtx({
          params: {
            command: "pnpm test",
            unattended: true,
            onAskVerdict: "run",
            timeoutSec: 30,
            cwd: "/repo",
          },
        })
      )
      expect(mockRun).not.toHaveBeenCalled()
      expect(mockHeadless).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "pnpm test",
          cwd: "/repo",
          timeoutMs: 30_000,
          onAskVerdict: "run",
          runId: "run-1",
          source: "workflow",
        })
      )
      expect(result.decision).toBe("success")
      expect(result.output).toMatchObject({ exitCode: 0, output: "done" })
    })

    it("surfaces policy blocks as workflow failures", async () => {
      mockHeadless.mockResolvedValue({ ok: false, reason: "blocked by the classifier" })
      const reg = getExecutor("action.system.terminal", 1)!
      await expect(
        reg.execute(makeCtx({ params: { command: "rm -rf /", unattended: true } }))
      ).rejects.toThrow(/blocked by the classifier/)
    })

    it("throws on a timeout by default and branches with onFailure=branch", async () => {
      mockHeadless.mockResolvedValue({
        ok: true,
        exitCode: null,
        output: "partial",
        durationMs: 9000,
        timedOut: true,
        verdict: "allow",
      })
      const reg = getExecutor("action.system.terminal", 1)!
      await expect(
        reg.execute(makeCtx({ params: { command: "sleep 99", unattended: true } }))
      ).rejects.toThrow(/timed out/)
      const result = await reg.execute(
        makeCtx({ params: { command: "sleep 99", unattended: true, onFailure: "branch" } })
      )
      expect(result.decision).toBe("failure")
      expect(result.output).toMatchObject({ timedOut: true })
    })
  })
})

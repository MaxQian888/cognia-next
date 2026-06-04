/**
 * Tests for the `action.terminal.session.{open,run,close}` executors.
 *
 * The dock path, the headless policy layer, and the run-session registry
 * have their own suites — these tests verify the wiring: mode selection,
 * registry bookkeeping, decision routing, error surfaces.
 */

const mockDock = jest.fn()
jest.mock("@/lib/terminal/dock-tool-handler", () => ({
  runTerminalDockAction: (...args: unknown[]) => mockDock(...args),
}))

const mockHeadless = jest.fn()
jest.mock("@/lib/terminal/headless-exec", () => ({
  runHeadlessExec: (...args: unknown[]) => mockHeadless(...args),
}))

const mockInvoke = jest.fn()
jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

jest.mock("@/lib/tauri", () => ({ isTauri: () => true }))

jest.mock("@/stores/settings", () => {
  const state = { allowUnattendedExecution: true }
  return {
    __mockUnattended: state,
    useSettingsStore: {
      getState: () => ({
        settings: { terminal: { allowUnattendedExecution: state.allowUnattendedExecution } },
      }),
    },
  }
})

const mockKillFromDock = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("@/lib/terminal/spawn-orchestrator", () => ({
  killFromDock: (...args: unknown[]) => mockKillFromDock(...args),
}))
jest.mock("@/stores/terminal/terminal-store", () => ({
  useTerminalStore: { getState: () => ({}) },
}))

// Force the executors to register on import.
import "./terminal-session"

import { getExecutor } from "./registry"
import {
  __clearRunSessionsForTesting,
  listRunSessions,
  registerRunSession,
} from "@/lib/terminal/headless-session-registry"
import type { StepExecutionContext } from "@/types/workflow/visual"

const { __mockUnattended } = jest.requireMock("@/stores/settings") as {
  __mockUnattended: { allowUnattendedExecution: boolean }
}

function makeCtx(params: Record<string, unknown>, runId = "run-1"): StepExecutionContext {
  return {
    runId,
    stepId: "step-1",
    workflowId: "wf-1",
    upstream: {},
    trigger: { workflowId: "wf-1", kind: "trigger.manual" as const, payload: null, originAt: 0 },
    params,
    signal: new AbortController().signal,
    log: jest.fn(),
    resolveSecret: jest.fn(async () => ""),
  } as unknown as StepExecutionContext
}

beforeEach(() => {
  __clearRunSessionsForTesting()
  __mockUnattended.allowUnattendedExecution = true
  mockDock.mockReset()
  mockHeadless.mockReset()
  mockInvoke.mockReset()
  mockKillFromDock.mockReset().mockResolvedValue(undefined)
})

describe("action.terminal.session.open", () => {
  it("is registered", () => {
    expect(getExecutor("action.terminal.session.open", 1)).toBeDefined()
  })

  it("dock mode spawns via the dock handler and registers the session", async () => {
    mockDock.mockResolvedValue({ ok: true, sessionId: "tab-1" })
    const reg = getExecutor("action.terminal.session.open", 1)!
    const result = await reg.execute(makeCtx({ cwd: "/repo" }))
    expect(mockDock).toHaveBeenCalledWith(
      expect.objectContaining({ chatSessionId: "run-1", action: "spawn" })
    )
    expect(result.output).toMatchObject({ sessionId: "tab-1", mode: "dock" })
    expect(listRunSessions("run-1")).toEqual([{ sessionId: "tab-1", mode: "dock" }])
  })

  it("unattended mode spawns the headless backend and registers it", async () => {
    mockInvoke.mockResolvedValue({ sessionId: "hl-1", shell: "pwsh.exe" })
    const reg = getExecutor("action.terminal.session.open", 1)!
    const result = await reg.execute(makeCtx({ unattended: true, cwd: "/repo" }))
    expect(mockInvoke).toHaveBeenCalledWith(
      "terminal_headless_spawn",
      expect.objectContaining({ cwd: "/repo" })
    )
    expect(result.output).toMatchObject({ sessionId: "hl-1", mode: "headless" })
    expect(listRunSessions("run-1")).toEqual([{ sessionId: "hl-1", mode: "headless" }])
  })

  it("unattended mode fails closed when the master switch is off", async () => {
    __mockUnattended.allowUnattendedExecution = false
    const reg = getExecutor("action.terminal.session.open", 1)!
    await expect(reg.execute(makeCtx({ unattended: true }))).rejects.toThrow(/disabled/)
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it("surfaces dock failures", async () => {
    mockDock.mockResolvedValue({ ok: false, reason: "agent terminal access is disabled" })
    const reg = getExecutor("action.terminal.session.open", 1)!
    await expect(reg.execute(makeCtx({}))).rejects.toThrow(/disabled/)
  })
})

describe("action.terminal.session.run", () => {
  it("requires sessionId and command", async () => {
    const reg = getExecutor("action.terminal.session.run", 1)!
    await expect(reg.execute(makeCtx({ command: "ls" }))).rejects.toThrow(/sessionId/)
    await expect(reg.execute(makeCtx({ sessionId: "s" }))).rejects.toThrow(/command/)
  })

  it("rejects sessions not opened by this run", async () => {
    registerRunSession("other-run", "s-1", "headless")
    const reg = getExecutor("action.terminal.session.run", 1)!
    await expect(reg.execute(makeCtx({ sessionId: "s-1", command: "ls" }))).rejects.toThrow(
      /not opened by this run/
    )
  })

  it("headless sessions route through the policy layer with run context", async () => {
    registerRunSession("run-1", "hl-1", "headless")
    mockHeadless.mockResolvedValue({
      ok: true,
      exitCode: 0,
      output: "done",
      durationMs: 40,
      timedOut: false,
      verdict: "allow",
    })
    const reg = getExecutor("action.terminal.session.run", 1)!
    const result = await reg.execute(
      makeCtx({ sessionId: "hl-1", command: "git", args: ["status"], timeoutSec: 30 })
    )
    expect(mockHeadless).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "git status",
        sessionId: "hl-1",
        timeoutMs: 30_000,
        runId: "run-1",
        source: "workflow",
      })
    )
    expect(result.decision).toBe("success")
    expect(result.output).toMatchObject({ exitCode: 0, output: "done" })
  })

  it("dock sessions route through the dock write action", async () => {
    registerRunSession("run-1", "tab-1", "dock")
    mockDock.mockResolvedValue({ ok: true, sessionId: "tab-1", exitCode: 0, output: "ok" })
    const reg = getExecutor("action.terminal.session.run", 1)!
    const result = await reg.execute(makeCtx({ sessionId: "tab-1", command: "ls" }))
    expect(mockDock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "write",
        args: expect.objectContaining({ tabId: "tab-1", command: "ls" }),
      })
    )
    expect(result.decision).toBe("success")
  })

  it("throws on non-zero exit by default, branches with onFailure=branch", async () => {
    registerRunSession("run-1", "hl-1", "headless")
    mockHeadless.mockResolvedValue({
      ok: true,
      exitCode: 2,
      output: "",
      durationMs: 5,
      timedOut: false,
      verdict: "allow",
    })
    const reg = getExecutor("action.terminal.session.run", 1)!
    await expect(reg.execute(makeCtx({ sessionId: "hl-1", command: "false" }))).rejects.toThrow(
      /exited with code 2/
    )
    const result = await reg.execute(
      makeCtx({ sessionId: "hl-1", command: "false", onFailure: "branch" })
    )
    expect(result.decision).toBe("failure")
  })

  it("treats a timeout as failure", async () => {
    registerRunSession("run-1", "hl-1", "headless")
    mockHeadless.mockResolvedValue({
      ok: true,
      exitCode: null,
      output: "partial",
      durationMs: 1000,
      timedOut: true,
      verdict: "allow",
    })
    const reg = getExecutor("action.terminal.session.run", 1)!
    await expect(reg.execute(makeCtx({ sessionId: "hl-1", command: "sleep 99" }))).rejects.toThrow(
      /timed out/
    )
  })

  it("surfaces policy blocks as workflow failures", async () => {
    registerRunSession("run-1", "hl-1", "headless")
    mockHeadless.mockResolvedValue({ ok: false, reason: "blocked by the classifier" })
    const reg = getExecutor("action.terminal.session.run", 1)!
    await expect(reg.execute(makeCtx({ sessionId: "hl-1", command: "rm -rf /" }))).rejects.toThrow(
      /blocked by the classifier/
    )
  })
})

describe("action.terminal.session.close", () => {
  it("closes a headless session and deregisters it", async () => {
    registerRunSession("run-1", "hl-1", "headless")
    mockInvoke.mockResolvedValue(undefined)
    const reg = getExecutor("action.terminal.session.close", 1)!
    const result = await reg.execute(makeCtx({ sessionId: "hl-1" }))
    expect(mockInvoke).toHaveBeenCalledWith("terminal_headless_kill", { sessionId: "hl-1" })
    expect(result.output).toMatchObject({ closed: true })
    expect(listRunSessions("run-1")).toEqual([])
  })

  it("closes a dock session via killFromDock", async () => {
    registerRunSession("run-1", "tab-1", "dock")
    const reg = getExecutor("action.terminal.session.close", 1)!
    await reg.execute(makeCtx({ sessionId: "tab-1" }))
    expect(mockKillFromDock).toHaveBeenCalledWith("tab-1", expect.anything())
    expect(listRunSessions("run-1")).toEqual([])
  })

  it("treats an unknown session as a no-op", async () => {
    const reg = getExecutor("action.terminal.session.close", 1)!
    const result = await reg.execute(makeCtx({ sessionId: "ghost" }))
    expect(result.output).toMatchObject({ closed: false })
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it("requires sessionId", async () => {
    const reg = getExecutor("action.terminal.session.close", 1)!
    await expect(reg.execute(makeCtx({}))).rejects.toThrow(/sessionId/)
  })
})

/**
 * Tests for the `action.terminal.script` workflow executor.
 *
 * Interpreter detection itself is covered by
 * `lib/terminal/script-runner.test.ts`; here we verify the wiring:
 * command-line composition (detection vs override, quoting), routing
 * through the dock vs the headless policy layer, decision/branch routing,
 * and error surfaces.
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
import "./script"

import { composeScriptCommand } from "./script"
import { getExecutor } from "../registry"
import type { StepExecutionContext } from "@/types/workflow/visual"

function makeCtx(params: Record<string, unknown>): StepExecutionContext {
  return {
    runId: "run-1",
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
  mockRun.mockReset()
  mockHeadless.mockReset()
})

describe("composeScriptCommand", () => {
  it("detects the interpreter from the extension", async () => {
    await expect(composeScriptCommand({ scriptPath: "scripts/build.sh" })).resolves.toBe(
      "bash scripts/build.sh"
    )
  })

  it("includes interpreter flags (.ps1 → pwsh -NoLogo -File)", async () => {
    await expect(composeScriptCommand({ scriptPath: "deploy.ps1" })).resolves.toBe(
      "pwsh -NoLogo -File deploy.ps1"
    )
  })

  it("an explicit interpreter override bypasses detection", async () => {
    await expect(
      composeScriptCommand({ scriptPath: "tool.weird", interpreter: "deno" })
    ).resolves.toBe("deno tool.weird")
  })

  it("appends script args and quotes whitespace-containing tokens", async () => {
    await expect(
      composeScriptCommand({
        scriptPath: "C:\\My Repo\\run.py",
        interpreter: "python",
        args: ["--name", "hello world"],
      })
    ).resolves.toBe('python "C:\\My Repo\\run.py" --name "hello world"')
  })

  it("throws a non-retryable error for an unknown extension without override", async () => {
    await expect(composeScriptCommand({ scriptPath: "notes.txt" })).rejects.toThrow(
      /cannot determine an interpreter/
    )
  })
})

describe("action.terminal.script executor", () => {
  it("is registered with typeVersion 1 and non-retryable", () => {
    const reg = getExecutor("action.terminal.script", 1)
    expect(reg).toBeDefined()
    expect(reg?.retryable).toBe(false)
  })

  it("rejects when scriptPath is missing", async () => {
    const reg = getExecutor("action.terminal.script", 1)!
    await expect(reg.execute(makeCtx({}))).rejects.toThrow(/non-empty 'scriptPath'/)
  })

  it("dock mode: spawns a tab with the composed command line", async () => {
    mockRun.mockResolvedValue({ ok: true, sessionId: "tab-1", exitCode: 0, output: "ok" })
    const reg = getExecutor("action.terminal.script", 1)!
    const result = await reg.execute(
      makeCtx({ scriptPath: "scripts/build.sh", cwd: "/repo", projectId: "p1", timeoutSec: 90 })
    )
    expect(mockHeadless).not.toHaveBeenCalled()
    const arg = mockRun.mock.calls[0][0]
    expect(arg.action).toBe("spawn")
    expect(arg.chatSessionId).toBe("run-1")
    expect(arg.args.command).toBe("bash scripts/build.sh")
    expect(arg.args.cwd).toBe("/repo")
    expect(arg.args.projectId).toBe("p1")
    expect(arg.args.timeoutSec).toBe(90)
    expect(result.decision).toBe("success")
    expect(result.output).toMatchObject({
      exitCode: 0,
      command: "bash scripts/build.sh",
      scriptPath: "scripts/build.sh",
    })
  })

  it("unattended mode: routes through runHeadlessExec with run context", async () => {
    mockHeadless.mockResolvedValue({
      ok: true,
      exitCode: 0,
      output: "done",
      durationMs: 25,
      timedOut: false,
      verdict: "allow",
    })
    const reg = getExecutor("action.terminal.script", 1)!
    const result = await reg.execute(
      makeCtx({ scriptPath: "run.py", unattended: true, onAskVerdict: "run", timeoutSec: 30 })
    )
    expect(mockRun).not.toHaveBeenCalled()
    expect(mockHeadless).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.stringMatching(/^python3? run\.py$/),
        timeoutMs: 30_000,
        onAskVerdict: "run",
        runId: "run-1",
        source: "workflow",
      })
    )
    expect(result.decision).toBe("success")
    expect(result.output).toMatchObject({ exitCode: 0, output: "done", durationMs: 25 })
  })

  it("throws by default on non-zero exit and branches with onFailure=branch", async () => {
    mockRun.mockResolvedValue({ ok: true, sessionId: "t", exitCode: 3, output: "" })
    const reg = getExecutor("action.terminal.script", 1)!
    await expect(reg.execute(makeCtx({ scriptPath: "fail.sh" }))).rejects.toThrow(
      /exited with code 3/
    )
    const result = await reg.execute(makeCtx({ scriptPath: "fail.sh", onFailure: "branch" }))
    expect(result.decision).toBe("failure")
    expect(result.output).toMatchObject({ exitCode: 3 })
  })

  it("clamps timeoutSec to the [5, 600] range", async () => {
    mockRun.mockResolvedValue({ ok: true, sessionId: "t", exitCode: 0, output: "" })
    const reg = getExecutor("action.terminal.script", 1)!
    await reg.execute(makeCtx({ scriptPath: "a.sh", timeoutSec: 1 }))
    expect(mockRun.mock.calls[0][0].args.timeoutSec).toBe(5)
    mockRun.mockClear()
    await reg.execute(makeCtx({ scriptPath: "a.sh", timeoutSec: 9999 }))
    expect(mockRun.mock.calls[0][0].args.timeoutSec).toBe(600)
  })

  it("surfaces dock policy errors as workflow failures", async () => {
    mockRun.mockResolvedValue({ ok: false, reason: "agent terminal access is disabled" })
    const reg = getExecutor("action.terminal.script", 1)!
    await expect(reg.execute(makeCtx({ scriptPath: "a.sh" }))).rejects.toThrow(
      /agent terminal access is disabled/
    )
  })

  it("surfaces headless policy blocks as workflow failures", async () => {
    mockHeadless.mockResolvedValue({ ok: false, reason: "blocked by the classifier" })
    const reg = getExecutor("action.terminal.script", 1)!
    await expect(
      reg.execute(makeCtx({ scriptPath: "danger.sh", unattended: true }))
    ).rejects.toThrow(/blocked by the classifier/)
  })

  it("treats an unattended timeout as failure (throw / branch)", async () => {
    mockHeadless.mockResolvedValue({
      ok: true,
      exitCode: null,
      output: "partial",
      durationMs: 9000,
      timedOut: true,
      verdict: "allow",
    })
    const reg = getExecutor("action.terminal.script", 1)!
    await expect(reg.execute(makeCtx({ scriptPath: "slow.sh", unattended: true }))).rejects.toThrow(
      /timed out/
    )
    const result = await reg.execute(
      makeCtx({ scriptPath: "slow.sh", unattended: true, onFailure: "branch" })
    )
    expect(result.decision).toBe("failure")
    expect(result.output).toMatchObject({ timedOut: true })
  })

  it("rejects unexpected records-shaped dock results defensively", async () => {
    mockRun.mockResolvedValue({ ok: true, records: [] })
    const reg = getExecutor("action.terminal.script", 1)!
    await expect(reg.execute(makeCtx({ scriptPath: "a.sh" }))).rejects.toThrow(
      /unexpected dock result shape/
    )
  })
})

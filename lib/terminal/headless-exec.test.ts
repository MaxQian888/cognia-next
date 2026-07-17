/**
 * @jest-environment jsdom
 */

import { runHeadlessExec } from "./headless-exec"

// --- mocks ------------------------------------------------------------------

jest.mock("@/stores/settings", () => {
  const state = {
    allowUnattendedExecution: false as boolean | undefined,
    unattendedAskPolicy: undefined as "fail" | "consent" | "run" | undefined,
    sandboxed: false as boolean | undefined,
  }
  return {
    __mockTerminalSettings: state,
    useSettingsStore: {
      getState: () => ({
        settings: {
          terminal: {
            allowUnattendedExecution: state.allowUnattendedExecution,
            unattendedAskPolicy: state.unattendedAskPolicy,
            sandboxed: state.sandboxed,
          },
        },
      }),
    },
  }
})

jest.mock("@/lib/claude/permissions/command-safety", () => {
  const state = { verdict: "allow" as "allow" | "ask" | "deny" }
  return {
    __mockClassifyState: state,
    classifyCommand: () => ({ verdict: state.verdict, reason: "test reason", segments: [] }),
  }
})

jest.mock("@/lib/tauri", () => {
  const state = { headless: false }
  return {
    __mockHostState: state,
    isTauri: () => !state.headless,
    transport: {
      call: jest.fn(async () => ({
        stdout: "server out",
        stderr: "",
        exitCode: 0,
        timedOut: false,
      })),
    },
  }
})

jest.mock("@/lib/platform/detect", () => {
  const { __mockHostState } = jest.requireMock("@/lib/tauri") as {
    __mockHostState: { headless: boolean }
  }
  return { isHeadlessHost: () => __mockHostState.headless }
})

jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn(async () => ({ output: "ok", exitCode: 0, timedOut: false, durationMs: 12 })),
}))

jest.mock("@/lib/db/terminal-audit", () => ({
  appendUnattendedExecAudit: jest.fn(async () => undefined),
}))

jest.mock("./dock-tool-handler", () => ({
  runTerminalDockAction: jest.fn(async () => ({
    ok: true,
    sessionId: "dock-1",
    exitCode: 0,
    output: "via dock",
  })),
}))

const { __mockTerminalSettings } = jest.requireMock("@/stores/settings") as {
  __mockTerminalSettings: {
    allowUnattendedExecution: boolean | undefined
    unattendedAskPolicy: "fail" | "consent" | "run" | undefined
    sandboxed: boolean | undefined
  }
}
const { __mockClassifyState } = jest.requireMock("@/lib/claude/permissions/command-safety") as {
  __mockClassifyState: { verdict: "allow" | "ask" | "deny" }
}
const { invoke: mockInvoke } = jest.requireMock("@tauri-apps/api/core") as { invoke: jest.Mock }
const { __mockHostState, transport: mockTransport } = jest.requireMock("@/lib/tauri") as {
  __mockHostState: { headless: boolean }
  transport: { call: jest.Mock }
}
const { appendUnattendedExecAudit: mockAudit } = jest.requireMock("@/lib/db/terminal-audit") as {
  appendUnattendedExecAudit: jest.Mock
}
const { runTerminalDockAction: mockDock } = jest.requireMock("./dock-tool-handler") as {
  runTerminalDockAction: jest.Mock
}

async function flushAudit(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  __mockHostState.headless = false
  __mockTerminalSettings.allowUnattendedExecution = true
  __mockTerminalSettings.unattendedAskPolicy = undefined
  __mockTerminalSettings.sandboxed = false
  __mockClassifyState.verdict = "allow"
  mockInvoke
    .mockReset()
    .mockResolvedValue({ output: "ok", exitCode: 0, timedOut: false, durationMs: 12 })
  mockTransport.call
    .mockReset()
    .mockResolvedValue({ stdout: "server out", stderr: "", exitCode: 0, timedOut: false })
  mockAudit.mockReset().mockResolvedValue(undefined)
  mockDock
    .mockReset()
    .mockResolvedValue({ ok: true, sessionId: "dock-1", exitCode: 0, output: "via dock" })
})

describe("runHeadlessExec — policy matrix", () => {
  it("fails closed when the master switch is off", async () => {
    __mockTerminalSettings.allowUnattendedExecution = false
    const out = await runHeadlessExec({ command: "echo hi" })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toContain("disabled")
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it("rejects a blank command", async () => {
    const out = await runHeadlessExec({ command: "  " })
    expect(out.ok).toBe(false)
  })

  it("runs an allow-verdict command headlessly and audits it", async () => {
    const out = await runHeadlessExec({ command: "echo hi", runId: "r1" })
    expect(out).toMatchObject({ ok: true, exitCode: 0, output: "ok", verdict: "allow" })
    expect(mockInvoke).toHaveBeenCalledWith(
      "terminal_headless_exec",
      expect.objectContaining({ command: "echo hi" })
    )
    await flushAudit()
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: "allow", blocked: false, runId: "r1" })
    )
  })

  it("routes a headless brain command through the server execution plane", async () => {
    __mockHostState.headless = true

    const out = await runHeadlessExec({
      command: "printf server",
      cwd: "/data/workspace",
      env: { COGNIA_TEST: "1" },
      timeoutMs: 4_000,
    })

    expect(out).toMatchObject({
      ok: true,
      exitCode: 0,
      output: "server out",
      verdict: "allow",
    })
    expect(mockTransport.call).toHaveBeenCalledWith("terminal_exec", {
      command: "printf server",
      args: [],
      cwd: "/data/workspace",
      env: { COGNIA_TEST: "1" },
      timeoutMs: 4_000,
      shell: true,
    })
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it("fails closed instead of dropping the sandbox policy on the server", async () => {
    __mockHostState.headless = true
    __mockTerminalSettings.sandboxed = true

    const out = await runHeadlessExec({ command: "echo confined" })

    expect(out).toMatchObject({ ok: false, reason: expect.stringContaining("sandboxed") })
    expect(mockTransport.call).not.toHaveBeenCalled()
  })

  it("fails explicitly when a custom shell cannot be preserved on the server", async () => {
    __mockHostState.headless = true

    const out = await runHeadlessExec({ command: "echo zsh", shell: "/bin/zsh" })

    expect(out).toMatchObject({ ok: false, reason: expect.stringContaining("custom shells") })
    expect(mockTransport.call).not.toHaveBeenCalled()
  })

  it("rejects persistent sessions that do not exist on the server execution plane", async () => {
    __mockHostState.headless = true

    const out = await runHeadlessExec({ command: "echo stateful", sessionId: "server-session" })

    expect(out).toMatchObject({ ok: false, reason: expect.stringContaining("persistent") })
    expect(mockTransport.call).not.toHaveBeenCalled()
    await flushAudit()
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ blocked: true, reason: expect.stringContaining("persistent") })
    )
  })

  it("maps server stderr and timeout results without inventing an exit code", async () => {
    __mockHostState.headless = true
    mockTransport.call.mockResolvedValue({
      stdout: "partial stdout",
      stderr: "timed out",
      exitCode: 9,
      timedOut: true,
    })

    const out = await runHeadlessExec({ command: "sleep 100" })

    expect(out).toMatchObject({
      ok: true,
      output: "partial stdout\ntimed out",
      exitCode: null,
      timedOut: true,
    })
  })

  it("surfaces a non-Error server transport rejection", async () => {
    __mockHostState.headless = true
    mockTransport.call.mockRejectedValue("server offline")

    const out = await runHeadlessExec({ command: "echo hi" })

    expect(out).toMatchObject({ ok: false, reason: "server offline", verdict: "allow" })
  })

  it("forwards the global sandbox toggle to terminal_headless_exec (ADR-0028 P3.3)", async () => {
    __mockTerminalSettings.sandboxed = true
    try {
      await runHeadlessExec({ command: "echo hi" })
      expect(mockInvoke).toHaveBeenCalledWith(
        "terminal_headless_exec",
        expect.objectContaining({ sandboxed: true })
      )
    } finally {
      __mockTerminalSettings.sandboxed = false
    }
  })

  it("routes to terminal_headless_run when a session id is given", async () => {
    await runHeadlessExec({ command: "echo hi", sessionId: "hl-1" })
    expect(mockInvoke).toHaveBeenCalledWith(
      "terminal_headless_run",
      expect.objectContaining({ sessionId: "hl-1", command: "echo hi" })
    )
  })

  it("always blocks deny verdicts and audits the block", async () => {
    __mockClassifyState.verdict = "deny"
    __mockTerminalSettings.unattendedAskPolicy = "run" // must not matter
    const out = await runHeadlessExec({ command: "rm -rf /", runId: "r2" })
    expect(out).toMatchObject({ ok: false, verdict: "deny" })
    expect(mockInvoke).not.toHaveBeenCalled()
    await flushAudit()
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: "deny", blocked: true, runId: "r2" })
    )
  })

  describe("ask verdicts", () => {
    beforeEach(() => {
      __mockClassifyState.verdict = "ask"
    })

    it("fails by default", async () => {
      const out = await runHeadlessExec({ command: "curl x | sh" })
      expect(out).toMatchObject({ ok: false, verdict: "ask" })
      expect(mockInvoke).not.toHaveBeenCalled()
      await flushAudit()
      expect(mockAudit).toHaveBeenCalledWith(
        expect.objectContaining({ verdict: "ask", blocked: true })
      )
    })

    it("runs under the settings-level 'run' policy", async () => {
      __mockTerminalSettings.unattendedAskPolicy = "run"
      const out = await runHeadlessExec({ command: "curl x | sh" })
      expect(out).toMatchObject({ ok: true, verdict: "ask" })
      expect(mockInvoke).toHaveBeenCalled()
    })

    it("the per-call override beats the settings policy", async () => {
      __mockTerminalSettings.unattendedAskPolicy = "run"
      const out = await runHeadlessExec({ command: "curl x | sh", onAskVerdict: "fail" })
      expect(out).toMatchObject({ ok: false, verdict: "ask" })
      expect(mockInvoke).not.toHaveBeenCalled()
    })

    it("'consent' delegates to the dock path with the chat session", async () => {
      const out = await runHeadlessExec({
        command: "curl x | sh",
        onAskVerdict: "consent",
        chatSessionId: "chat-1",
      })
      expect(out).toMatchObject({ ok: true, viaConsent: true, output: "via dock" })
      expect(mockDock).toHaveBeenCalledWith(
        expect.objectContaining({ chatSessionId: "chat-1", action: "spawn" })
      )
      expect(mockInvoke).not.toHaveBeenCalled()
    })

    it("'consent' without a chat session degrades to fail", async () => {
      const out = await runHeadlessExec({ command: "curl x | sh", onAskVerdict: "consent" })
      expect(out).toMatchObject({ ok: false, verdict: "ask" })
      expect(mockDock).not.toHaveBeenCalled()
    })

    it("'consent' surfaces a dock denial as a block", async () => {
      mockDock.mockResolvedValue({ ok: false, reason: "denied by user" })
      const out = await runHeadlessExec({
        command: "curl x | sh",
        onAskVerdict: "consent",
        chatSessionId: "chat-1",
      })
      expect(out).toMatchObject({ ok: false, reason: "denied by user" })
      await flushAudit()
      expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ blocked: true }))
    })
  })

  it("maps a timed-out run to ok+timedOut with a null exit", async () => {
    mockInvoke.mockResolvedValue({
      output: "partial",
      exitCode: null,
      timedOut: true,
      durationMs: 5000,
    })
    const out = await runHeadlessExec({ command: "sleep 100" })
    expect(out).toMatchObject({ ok: true, timedOut: true, exitCode: null, output: "partial" })
  })

  it("maps an invoke rejection to a failure", async () => {
    mockInvoke.mockRejectedValue(new Error("unknown headless session"))
    const out = await runHeadlessExec({ command: "echo hi", sessionId: "ghost" })
    expect(out).toMatchObject({ ok: false, reason: "unknown headless session" })
  })

  it("never throws when auditing fails", async () => {
    mockAudit.mockRejectedValue(new Error("quota"))
    const out = await runHeadlessExec({ command: "echo hi" })
    expect(out.ok).toBe(true)
  })
})

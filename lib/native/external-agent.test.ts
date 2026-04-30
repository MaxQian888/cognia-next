/**
 * Tests for native/external-agent — Tauri command + event-listener wrappers
 * and high-level helpers (executeCommand, createInteractiveTerminal).
 */

import { invoke } from "@tauri-apps/api/core"

const listenMock = jest.fn()
jest.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, cb: unknown) => listenMock(event, cb),
}))

import {
  spawnExternalAgent,
  sendToExternalAgent,
  killExternalAgent,
  getExternalAgentStatus,
  listExternalAgents,
  killAllExternalAgents,
  receiveExternalAgentStderr,
  isExternalAgentRunning,
  checkExternalAgentCommandExists,
  getExternalAgentInfo,
  setExternalAgentRunning,
  setExternalAgentFailed,
  acpTerminalCreate,
  acpTerminalOutput,
  acpTerminalKill,
  acpTerminalRelease,
  acpTerminalWaitForExit,
  acpTerminalWrite,
  acpTerminalGetSessionTerminals,
  acpTerminalKillSessionTerminals,
  acpTerminalIsRunning,
  acpTerminalGetInfo,
  acpTerminalList,
  onExternalAgentSpawn,
  onExternalAgentStdout,
  onExternalAgentExit,
  onExternalAgentStateChange,
  onExternalAgentStderr,
  executeCommand,
  createInteractiveTerminal,
  cleanupSessionTerminals,
} from "./external-agent"

const mockedInvoke = invoke as unknown as jest.Mock

beforeEach(() => {
  mockedInvoke.mockReset()
  listenMock.mockReset()
})

describe("external-agent commands", () => {
  it("spawnExternalAgent forwards config", async () => {
    mockedInvoke.mockResolvedValueOnce("agent-1")
    const cfg = { id: "a", command: "sh" }
    await expect(spawnExternalAgent(cfg)).resolves.toBe("agent-1")
    expect(mockedInvoke).toHaveBeenCalledWith("spawn_external_agent", { config: cfg })
  })

  it("sendToExternalAgent forwards agentId/message", async () => {
    mockedInvoke.mockResolvedValueOnce(undefined)
    await sendToExternalAgent("a-1", "hello")
    expect(mockedInvoke).toHaveBeenCalledWith("send_to_external_agent", {
      agentId: "a-1",
      message: "hello",
    })
  })

  it("killExternalAgent forwards agentId", async () => {
    mockedInvoke.mockResolvedValueOnce(undefined)
    await killExternalAgent("a-1")
    expect(mockedInvoke).toHaveBeenCalledWith("kill_external_agent", { agentId: "a-1" })
  })

  it("getExternalAgentStatus returns the status string", async () => {
    mockedInvoke.mockResolvedValueOnce("Running")
    await expect(getExternalAgentStatus("a-1")).resolves.toBe("Running")
    expect(mockedInvoke).toHaveBeenCalledWith("get_external_agent_status", { agentId: "a-1" })
  })

  it("listExternalAgents and killAllExternalAgents are no-arg", async () => {
    mockedInvoke.mockResolvedValueOnce(["a-1"])
    await expect(listExternalAgents()).resolves.toEqual(["a-1"])
    expect(mockedInvoke).toHaveBeenLastCalledWith("list_external_agents")

    mockedInvoke.mockResolvedValueOnce(undefined)
    await killAllExternalAgents()
    expect(mockedInvoke).toHaveBeenLastCalledWith("kill_all_external_agents")
  })

  it("receiveExternalAgentStderr forwards agentId", async () => {
    mockedInvoke.mockResolvedValueOnce(["err line"])
    await receiveExternalAgentStderr("a-1")
    expect(mockedInvoke).toHaveBeenCalledWith("receive_external_agent_stderr", {
      agentId: "a-1",
    })
  })

  it("isExternalAgentRunning returns the boolean", async () => {
    mockedInvoke.mockResolvedValueOnce(true)
    await expect(isExternalAgentRunning("a-1")).resolves.toBe(true)
    expect(mockedInvoke).toHaveBeenCalledWith("is_external_agent_running", { agentId: "a-1" })
  })

  it("checkExternalAgentCommandExists forwards the command", async () => {
    mockedInvoke.mockResolvedValueOnce(false)
    await checkExternalAgentCommandExists("node")
    expect(mockedInvoke).toHaveBeenCalledWith("check_command_exists", { command: "node" })
  })

  it("getExternalAgentInfo returns the info record", async () => {
    const info = {
      id: "a-1",
      pid: 42,
      state: "Running",
      command: "sh",
      args: [],
      cwd: null,
      env: {},
    }
    mockedInvoke.mockResolvedValueOnce(info)
    await expect(getExternalAgentInfo("a-1")).resolves.toEqual(info)
    expect(mockedInvoke).toHaveBeenCalledWith("get_external_agent_info", { agentId: "a-1" })
  })

  it("setExternalAgentRunning / setExternalAgentFailed", async () => {
    mockedInvoke.mockResolvedValueOnce(undefined)
    await setExternalAgentRunning("a-1")
    expect(mockedInvoke).toHaveBeenLastCalledWith("set_external_agent_running", {
      agentId: "a-1",
    })

    mockedInvoke.mockResolvedValueOnce(undefined)
    await setExternalAgentFailed("a-1")
    expect(mockedInvoke).toHaveBeenLastCalledWith("set_external_agent_failed", {
      agentId: "a-1",
    })
  })
})

describe("ACP terminal commands", () => {
  it("acpTerminalCreate forwards default empty args/no env", async () => {
    mockedInvoke.mockResolvedValueOnce("term-1")
    await acpTerminalCreate("sess-1", "sh")
    expect(mockedInvoke).toHaveBeenCalledWith("acp_terminal_create", {
      sessionId: "sess-1",
      command: "sh",
      args: [],
      cwd: undefined,
      env: undefined,
      outputByteLimit: undefined,
    })
  })

  it("acpTerminalCreate forwards optional fields", async () => {
    mockedInvoke.mockResolvedValueOnce("term-1")
    await acpTerminalCreate("sess-1", "sh", ["-c", "ls"], "/tmp", { K: "V" }, 4096)
    expect(mockedInvoke).toHaveBeenCalledWith("acp_terminal_create", {
      sessionId: "sess-1",
      command: "sh",
      args: ["-c", "ls"],
      cwd: "/tmp",
      env: { K: "V" },
      outputByteLimit: 4096,
    })
  })

  it("acpTerminalOutput forwards outputByteLimit", async () => {
    mockedInvoke.mockResolvedValueOnce({
      output: "",
      truncated: false,
      exitStatus: { exitCode: 0, signal: null },
    })
    await acpTerminalOutput("term-1", 1024)
    expect(mockedInvoke).toHaveBeenCalledWith("acp_terminal_output", {
      terminalId: "term-1",
      outputByteLimit: 1024,
    })
  })

  it("acpTerminalKill / Release / Write / WaitForExit forward args", async () => {
    mockedInvoke.mockResolvedValueOnce(undefined)
    await acpTerminalKill("term-1")
    expect(mockedInvoke).toHaveBeenLastCalledWith("acp_terminal_kill", { terminalId: "term-1" })

    mockedInvoke.mockResolvedValueOnce(undefined)
    await acpTerminalRelease("term-1")
    expect(mockedInvoke).toHaveBeenLastCalledWith("acp_terminal_release", {
      terminalId: "term-1",
    })

    mockedInvoke.mockResolvedValueOnce(undefined)
    await acpTerminalWrite("term-1", "data")
    expect(mockedInvoke).toHaveBeenLastCalledWith("acp_terminal_write", {
      terminalId: "term-1",
      data: "data",
    })

    mockedInvoke.mockResolvedValueOnce({ exitStatus: { exitCode: 0, signal: null } })
    await acpTerminalWaitForExit("term-1", 5000)
    expect(mockedInvoke).toHaveBeenLastCalledWith("acp_terminal_wait_for_exit", {
      terminalId: "term-1",
      timeout: 5000,
    })
  })

  it("acpTerminalGet/Kill SessionTerminals + IsRunning + GetInfo + List", async () => {
    mockedInvoke.mockResolvedValueOnce(["term-1"])
    await acpTerminalGetSessionTerminals("sess-1")
    expect(mockedInvoke).toHaveBeenLastCalledWith("acp_terminal_get_session_terminals", {
      sessionId: "sess-1",
    })

    mockedInvoke.mockResolvedValueOnce(undefined)
    await acpTerminalKillSessionTerminals("sess-1")
    expect(mockedInvoke).toHaveBeenLastCalledWith("acp_terminal_kill_session_terminals", {
      sessionId: "sess-1",
    })

    mockedInvoke.mockResolvedValueOnce(true)
    await acpTerminalIsRunning("term-1")
    expect(mockedInvoke).toHaveBeenLastCalledWith("acp_terminal_is_running", {
      terminalId: "term-1",
    })

    mockedInvoke.mockResolvedValueOnce({ id: "term-1", sessionId: "sess-1", command: "sh" })
    await acpTerminalGetInfo("term-1")
    expect(mockedInvoke).toHaveBeenLastCalledWith("acp_terminal_get_info", {
      terminalId: "term-1",
    })

    mockedInvoke.mockResolvedValueOnce(["term-1"])
    await acpTerminalList()
    expect(mockedInvoke).toHaveBeenLastCalledWith("acp_terminal_list")
  })
})

describe("event listener wrappers", () => {
  function setupListenMock(): { capturedHandler: (e: { payload: unknown }) => void } {
    const captured: { capturedHandler: (e: { payload: unknown }) => void } = {
      capturedHandler: () => undefined,
    }
    listenMock.mockImplementationOnce(
      async (_evt: string, cb: (e: { payload: unknown }) => void) => {
        captured.capturedHandler = cb
        return () => undefined
      }
    )
    return captured
  }

  it("onExternalAgentSpawn subscribes and unwraps payload", async () => {
    const cap = setupListenMock()
    const handler = jest.fn()
    await onExternalAgentSpawn(handler)
    expect(listenMock).toHaveBeenCalledWith("external-agent://spawn", expect.any(Function))
    cap.capturedHandler({ payload: { agentId: "a", status: "Running" } })
    expect(handler).toHaveBeenCalledWith({ agentId: "a", status: "Running" })
  })

  it("onExternalAgentStdout subscribes and unwraps payload", async () => {
    const cap = setupListenMock()
    const handler = jest.fn()
    await onExternalAgentStdout(handler)
    expect(listenMock).toHaveBeenCalledWith("external-agent://stdout", expect.any(Function))
    cap.capturedHandler({ payload: { agentId: "a", data: "x" } })
    expect(handler).toHaveBeenCalledWith({ agentId: "a", data: "x" })
  })

  it("onExternalAgentExit subscribes and unwraps payload", async () => {
    const cap = setupListenMock()
    const handler = jest.fn()
    await onExternalAgentExit(handler)
    expect(listenMock).toHaveBeenCalledWith("external-agent://exit", expect.any(Function))
    cap.capturedHandler({ payload: { agentId: "a", code: 0 } })
    expect(handler).toHaveBeenCalledWith({ agentId: "a", code: 0 })
  })

  it("onExternalAgentStateChange subscribes and unwraps payload", async () => {
    const cap = setupListenMock()
    const handler = jest.fn()
    await onExternalAgentStateChange(handler)
    expect(listenMock).toHaveBeenCalledWith("external-agent://state-change", expect.any(Function))
    cap.capturedHandler({ payload: { agentId: "a", state: "Running" } })
    expect(handler).toHaveBeenCalledWith({ agentId: "a", state: "Running" })
  })

  it("onExternalAgentStderr subscribes and unwraps payload", async () => {
    const cap = setupListenMock()
    const handler = jest.fn()
    await onExternalAgentStderr(handler)
    expect(listenMock).toHaveBeenCalledWith("external-agent://stderr", expect.any(Function))
    cap.capturedHandler({ payload: { agentId: "a", data: "err" } })
    expect(handler).toHaveBeenCalledWith({ agentId: "a", data: "err" })
  })
})

describe("high-level helpers", () => {
  it("executeCommand polls output via onOutput callback and waits for exit", async () => {
    jest.useFakeTimers()
    try {
      const onOutput = jest.fn()
      const callOrder: string[] = []
      mockedInvoke.mockImplementation(async (cmd: string) => {
        callOrder.push(cmd)
        switch (cmd) {
          case "acp_terminal_create":
            return "term-1"
          case "acp_terminal_output":
            return {
              output: "line\n",
              truncated: false,
              exitStatus: { exitCode: 0, signal: null },
            }
          case "acp_terminal_wait_for_exit":
            return { exitStatus: { exitCode: 0, signal: null } }
          case "acp_terminal_release":
            return undefined
          default:
            return undefined
        }
      })

      const promise = executeCommand("sess-1", "sh", ["-c", "ls"], {
        cwd: "/tmp",
        timeout: 1000,
        onOutput,
      })

      // Drive the polling interval once so the onOutput branch is exercised.
      await Promise.resolve()
      jest.advanceTimersByTime(100)
      await Promise.resolve()
      jest.runOnlyPendingTimers()

      const result = await promise
      expect(result.exitCode).toBe(0)
      expect(result.output).toBe("line\n")
      expect(callOrder).toContain("acp_terminal_create")
      expect(callOrder).toContain("acp_terminal_wait_for_exit")
      expect(callOrder).toContain("acp_terminal_release")
    } finally {
      jest.useRealTimers()
    }
  })

  it("executeCommand without onOutput skips the polling loop", async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      switch (cmd) {
        case "acp_terminal_create":
          return "term-1"
        case "acp_terminal_wait_for_exit":
          return { exitStatus: { exitCode: 7, signal: null } }
        case "acp_terminal_output":
          return {
            output: "final",
            truncated: false,
            exitStatus: { exitCode: 7, signal: null },
          }
        case "acp_terminal_release":
          return undefined
        default:
          return undefined
      }
    })

    const result = await executeCommand("sess-1", "sh")
    expect(result).toEqual({ output: "final", exitCode: 7 })
  })

  it("executeCommand returns -1 when exitCode is null", async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      switch (cmd) {
        case "acp_terminal_create":
          return "term-1"
        case "acp_terminal_wait_for_exit":
          return { exitStatus: { exitCode: null, signal: null } }
        case "acp_terminal_output":
          return { output: "", truncated: false, exitStatus: { exitCode: null, signal: null } }
        case "acp_terminal_release":
          return undefined
        default:
          return undefined
      }
    })

    const result = await executeCommand("sess-1", "sh")
    expect(result.exitCode).toBe(-1)
  })

  it("executeCommand polling tolerates errors from acpTerminalOutput", async () => {
    // Real timers — polling fires every 100ms. We gate wait_for_exit until
    // we've observed at least one polling failure, then the final
    // acpTerminalOutput read succeeds.
    const onOutput = jest.fn()
    let pollErrors = 0
    let releaseWait: (() => void) | null = null
    const waitGate = new Promise<void>((resolve) => {
      releaseWait = resolve
    })
    mockedInvoke.mockImplementation(async (cmd: string) => {
      switch (cmd) {
        case "acp_terminal_create":
          return "term-1"
        case "acp_terminal_output":
          if (pollErrors < 1) {
            pollErrors += 1
            // Release wait shortly so the test doesn't hang.
            setTimeout(() => releaseWait?.(), 0)
            throw new Error("terminal released")
          }
          return { output: "", truncated: false, exitStatus: { exitCode: 0, signal: null } }
        case "acp_terminal_wait_for_exit":
          await waitGate
          return { exitStatus: { exitCode: 0, signal: null } }
        case "acp_terminal_release":
          return undefined
        default:
          return undefined
      }
    })

    const result = await executeCommand("sess-1", "sh", [], { onOutput })
    expect(result.exitCode).toBe(0)
    // The polling loop fired at least once and threw; the catch branch
    // suppressed it.
    expect(pollErrors).toBe(1)
  }, 5000)

  it("executeCommand cleans up the polling interval on wait error", async () => {
    jest.useFakeTimers()
    try {
      mockedInvoke.mockImplementation(async (cmd: string) => {
        switch (cmd) {
          case "acp_terminal_create":
            return "term-1"
          case "acp_terminal_wait_for_exit":
            throw new Error("wait failed")
          case "acp_terminal_output":
            return {
              output: "",
              truncated: false,
              exitStatus: { exitCode: 0, signal: null },
            }
          case "acp_terminal_release":
            return undefined
          default:
            return undefined
        }
      })

      const onOutput = jest.fn()
      const promise = executeCommand("sess-1", "sh", [], { onOutput })
      await expect(promise).rejects.toThrow("wait failed")
    } finally {
      jest.useRealTimers()
    }
  })

  it("executeCommand swallows errors from acpTerminalRelease", async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      switch (cmd) {
        case "acp_terminal_create":
          return "term-1"
        case "acp_terminal_wait_for_exit":
          return { exitStatus: { exitCode: 0, signal: null } }
        case "acp_terminal_output":
          return { output: "", truncated: false, exitStatus: { exitCode: 0, signal: null } }
        case "acp_terminal_release":
          throw new Error("release failed")
        default:
          return undefined
      }
    })

    await expect(executeCommand("sess-1", "sh")).resolves.toEqual({
      output: "",
      exitCode: 0,
    })
  })

  it("createInteractiveTerminal returns method-bound helpers", async () => {
    mockedInvoke.mockResolvedValueOnce("term-1") // create
    const t = await createInteractiveTerminal("sess-1", "sh", ["-i"], "/tmp")
    expect(t.terminalId).toBe("term-1")
    expect(mockedInvoke).toHaveBeenCalledWith("acp_terminal_create", {
      sessionId: "sess-1",
      command: "sh",
      args: ["-i"],
      cwd: "/tmp",
      env: undefined,
      outputByteLimit: undefined,
    })

    mockedInvoke.mockResolvedValueOnce(undefined)
    await t.write("echo hi")
    expect(mockedInvoke).toHaveBeenLastCalledWith("acp_terminal_write", {
      terminalId: "term-1",
      data: "echo hi",
    })

    mockedInvoke.mockResolvedValueOnce({
      output: "",
      truncated: false,
      exitStatus: { exitCode: 0, signal: null },
    })
    await t.read()
    expect(mockedInvoke).toHaveBeenLastCalledWith("acp_terminal_output", {
      terminalId: "term-1",
      outputByteLimit: undefined,
    })

    mockedInvoke.mockResolvedValueOnce(true)
    await t.isRunning()
    expect(mockedInvoke).toHaveBeenLastCalledWith("acp_terminal_is_running", {
      terminalId: "term-1",
    })

    mockedInvoke.mockResolvedValueOnce(undefined)
    await t.kill()
    expect(mockedInvoke).toHaveBeenLastCalledWith("acp_terminal_kill", {
      terminalId: "term-1",
    })

    mockedInvoke.mockResolvedValueOnce({ exitStatus: { exitCode: 0, signal: null } })
    await t.waitForExit(2000)
    expect(mockedInvoke).toHaveBeenLastCalledWith("acp_terminal_wait_for_exit", {
      terminalId: "term-1",
      timeout: 2000,
    })

    mockedInvoke.mockResolvedValueOnce(undefined)
    await t.release()
    expect(mockedInvoke).toHaveBeenLastCalledWith("acp_terminal_release", {
      terminalId: "term-1",
    })
  })

  it("createInteractiveTerminal defaults args to []", async () => {
    mockedInvoke.mockResolvedValueOnce("term-2")
    await createInteractiveTerminal("sess-1", "sh")
    expect(mockedInvoke).toHaveBeenCalledWith("acp_terminal_create", {
      sessionId: "sess-1",
      command: "sh",
      args: [],
      cwd: undefined,
      env: undefined,
      outputByteLimit: undefined,
    })
  })

  it("cleanupSessionTerminals delegates to acp_terminal_kill_session_terminals", async () => {
    mockedInvoke.mockResolvedValueOnce(undefined)
    await cleanupSessionTerminals("sess-1")
    expect(mockedInvoke).toHaveBeenCalledWith("acp_terminal_kill_session_terminals", {
      sessionId: "sess-1",
    })
  })
})

/**
 * @jest-environment jsdom
 *
 * Tauri-runtime branch coverage for createExternalAgentActionsSlice.
 *
 * The plain `actions.slice.test.ts` exercises the non-Tauri "throw" / "no-op"
 * paths. This file mocks `@/lib/utils` so `isTauri()` returns true and mocks
 * `@/lib/native/external-agent` so we can exercise every Tauri-only branch
 * (success + error) without touching real IPC.
 */

jest.mock("@/lib/logger", () => {
  const child = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: () => child,
  }
  return {
    loggers: {
      agent: { ...child, child: () => child },
    },
  }
})

jest.mock("@/lib/utils", () => {
  const actual = jest.requireActual("@/lib/utils")
  return {
    ...actual,
    isTauri: jest.fn(() => true),
  }
})

jest.mock("@/lib/native/external-agent", () => ({
  spawnExternalAgent: jest.fn(),
  sendToExternalAgent: jest.fn(),
  killExternalAgent: jest.fn(),
  getExternalAgentStatus: jest.fn(),
  listExternalAgents: jest.fn(),
  killAllExternalAgents: jest.fn(),
  acpTerminalCreate: jest.fn(),
  acpTerminalOutput: jest.fn(),
  acpTerminalKill: jest.fn(),
  acpTerminalRelease: jest.fn(),
  acpTerminalWaitForExit: jest.fn(),
  acpTerminalWrite: jest.fn(),
  acpTerminalGetSessionTerminals: jest.fn(),
  acpTerminalKillSessionTerminals: jest.fn(),
  acpTerminalIsRunning: jest.fn(),
  acpTerminalGetInfo: jest.fn(),
  acpTerminalList: jest.fn(),
}))

import { useExternalAgentStore } from "../store"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const native = require("@/lib/native/external-agent") as {
  spawnExternalAgent: jest.Mock
  sendToExternalAgent: jest.Mock
  killExternalAgent: jest.Mock
  getExternalAgentStatus: jest.Mock
  listExternalAgents: jest.Mock
  killAllExternalAgents: jest.Mock
  acpTerminalCreate: jest.Mock
  acpTerminalOutput: jest.Mock
  acpTerminalKill: jest.Mock
  acpTerminalRelease: jest.Mock
  acpTerminalWaitForExit: jest.Mock
  acpTerminalWrite: jest.Mock
  acpTerminalGetSessionTerminals: jest.Mock
  acpTerminalKillSessionTerminals: jest.Mock
  acpTerminalIsRunning: jest.Mock
  acpTerminalGetInfo: jest.Mock
  acpTerminalList: jest.Mock
}

const reset = () => {
  useExternalAgentStore.getState().reset()
}

beforeEach(() => {
  reset()
  jest.clearAllMocks()
})

// =============================================================================
// spawnAgent
// =============================================================================

describe("spawnAgent (Tauri)", () => {
  it("seeds a runningAgents entry on success and clears isLoading", async () => {
    native.spawnExternalAgent.mockResolvedValue("agent-1")
    const id = await useExternalAgentStore.getState().spawnAgent({
      id: "agent-1",
      command: "echo",
      args: ["hi"],
    })
    expect(id).toBe("agent-1")
    const state = useExternalAgentStore.getState()
    expect(state.isLoading).toBe(false)
    expect(state.runningAgents["agent-1"]).toMatchObject({
      id: "agent-1",
      status: "running",
      output: [],
    })
    expect(state.runningAgentIds).toContain("agent-1")
  })

  it("records lastError and rethrows when native call rejects with Error", async () => {
    native.spawnExternalAgent.mockRejectedValue(new Error("boom"))
    await expect(
      useExternalAgentStore.getState().spawnAgent({
        id: "agent-2",
        command: "x",
      })
    ).rejects.toThrow("boom")
    const state = useExternalAgentStore.getState()
    expect(state.lastError).toBe("boom")
    expect(state.isLoading).toBe(false)
  })

  it("stringifies non-Error rejections", async () => {
    native.spawnExternalAgent.mockRejectedValue("plain string fail")
    await expect(
      useExternalAgentStore.getState().spawnAgent({
        id: "agent-3",
        command: "x",
      })
    ).rejects.toBe("plain string fail")
    expect(useExternalAgentStore.getState().lastError).toBe("plain string fail")
  })
})

// =============================================================================
// sendToAgent
// =============================================================================

describe("sendToAgent (Tauri)", () => {
  it("calls native when in Tauri", async () => {
    native.sendToExternalAgent.mockResolvedValue(undefined)
    await useExternalAgentStore.getState().sendToAgent("a", "msg")
    expect(native.sendToExternalAgent).toHaveBeenCalledWith("a", "msg")
  })

  it("records lastError on Error rejection and rethrows", async () => {
    native.sendToExternalAgent.mockRejectedValue(new Error("send fail"))
    await expect(useExternalAgentStore.getState().sendToAgent("a", "msg")).rejects.toThrow(
      "send fail"
    )
    expect(useExternalAgentStore.getState().lastError).toBe("send fail")
  })

  it("stringifies non-Error rejections", async () => {
    native.sendToExternalAgent.mockRejectedValue(42)
    await expect(useExternalAgentStore.getState().sendToAgent("a", "msg")).rejects.toBe(42)
    expect(useExternalAgentStore.getState().lastError).toBe("42")
  })
})

// =============================================================================
// killRunningAgent
// =============================================================================

describe("killRunningAgent (Tauri)", () => {
  it("marks an existing agent as stopped", async () => {
    native.killExternalAgent.mockResolvedValue(undefined)
    useExternalAgentStore.setState({
      runningAgents: {
        a: { id: "a", status: "running", output: [], spawnedAt: 1 },
      },
      runningAgentIds: ["a"],
    })
    await useExternalAgentStore.getState().killRunningAgent("a")
    expect(useExternalAgentStore.getState().runningAgents["a"].status).toBe("stopped")
  })

  it("is a no-op state change when the agent is not tracked", async () => {
    native.killExternalAgent.mockResolvedValue(undefined)
    await useExternalAgentStore.getState().killRunningAgent("ghost")
    expect(useExternalAgentStore.getState().runningAgents).toEqual({})
  })

  it("records lastError and rethrows on Error", async () => {
    native.killExternalAgent.mockRejectedValue(new Error("kill fail"))
    await expect(useExternalAgentStore.getState().killRunningAgent("a")).rejects.toThrow(
      "kill fail"
    )
    expect(useExternalAgentStore.getState().lastError).toBe("kill fail")
  })

  it("stringifies non-Error rejection", async () => {
    native.killExternalAgent.mockRejectedValue({ code: "x" })
    await expect(useExternalAgentStore.getState().killRunningAgent("a")).rejects.toEqual({
      code: "x",
    })
    expect(useExternalAgentStore.getState().lastError).toBe("[object Object]")
  })
})

// =============================================================================
// getRunningAgentStatus
// =============================================================================

describe("getRunningAgentStatus (Tauri)", () => {
  it("delegates to native and returns the status string", async () => {
    native.getExternalAgentStatus.mockResolvedValue("Running")
    const status = await useExternalAgentStore.getState().getRunningAgentStatus("a")
    expect(status).toBe("Running")
    expect(native.getExternalAgentStatus).toHaveBeenCalledWith("a")
  })
})

// =============================================================================
// refreshRunningAgents
// =============================================================================

describe("refreshRunningAgents (Tauri)", () => {
  it("rebuilds runningAgents map preserving existing output / spawnedAt / exitCode", async () => {
    native.listExternalAgents.mockResolvedValue(["a", "b"])
    native.getExternalAgentStatus.mockResolvedValueOnce("Running").mockResolvedValueOnce("Stopped")
    useExternalAgentStore.setState({
      runningAgents: {
        a: {
          id: "a",
          status: "running",
          output: ["hello"],
          spawnedAt: 1234,
          exitCode: 7,
        },
      },
    })
    await useExternalAgentStore.getState().refreshRunningAgents()
    const state = useExternalAgentStore.getState()
    expect(state.isLoading).toBe(false)
    expect(state.runningAgentIds).toEqual(["a", "b"])
    expect(state.runningAgents.a).toMatchObject({
      id: "a",
      status: "running",
      output: ["hello"],
      spawnedAt: 1234,
      exitCode: 7,
    })
    expect(state.runningAgents.b).toMatchObject({
      id: "b",
      status: "stopped",
      output: [],
    })
    expect(typeof state.runningAgents.b.spawnedAt).toBe("number")
  })

  it("records lastError on Error", async () => {
    native.listExternalAgents.mockRejectedValue(new Error("list fail"))
    await useExternalAgentStore.getState().refreshRunningAgents()
    expect(useExternalAgentStore.getState().lastError).toBe("list fail")
    expect(useExternalAgentStore.getState().isLoading).toBe(false)
  })

  it("stringifies non-Error rejection", async () => {
    native.listExternalAgents.mockRejectedValue("oops")
    await useExternalAgentStore.getState().refreshRunningAgents()
    expect(useExternalAgentStore.getState().lastError).toBe("oops")
  })
})

// =============================================================================
// killAllRunningAgents
// =============================================================================

describe("killAllRunningAgents (Tauri)", () => {
  it("clears runningAgents on success", async () => {
    native.killAllExternalAgents.mockResolvedValue(undefined)
    useExternalAgentStore.setState({
      runningAgents: { a: { id: "a", status: "running", output: [], spawnedAt: 1 } },
      runningAgentIds: ["a"],
    })
    await useExternalAgentStore.getState().killAllRunningAgents()
    expect(useExternalAgentStore.getState().runningAgents).toEqual({})
    expect(useExternalAgentStore.getState().runningAgentIds).toEqual([])
  })

  it("records lastError and rethrows on Error", async () => {
    native.killAllExternalAgents.mockRejectedValue(new Error("nope"))
    await expect(useExternalAgentStore.getState().killAllRunningAgents()).rejects.toThrow("nope")
    expect(useExternalAgentStore.getState().lastError).toBe("nope")
  })

  it("stringifies non-Error rejection", async () => {
    native.killAllExternalAgents.mockRejectedValue(123)
    await expect(useExternalAgentStore.getState().killAllRunningAgents()).rejects.toBe(123)
    expect(useExternalAgentStore.getState().lastError).toBe("123")
  })
})

// =============================================================================
// createTerminal
// =============================================================================

describe("createTerminal (Tauri)", () => {
  it("seeds a terminal entry on success", async () => {
    native.acpTerminalCreate.mockResolvedValue("term-1")
    const id = await useExternalAgentStore
      .getState()
      .createTerminal("session-1", "ls", ["-la"], "/tmp")
    expect(id).toBe("term-1")
    const state = useExternalAgentStore.getState()
    expect(state.isLoading).toBe(false)
    expect(state.terminals["term-1"]).toMatchObject({
      id: "term-1",
      sessionId: "session-1",
      command: "ls",
      isRunning: true,
      output: "",
      exitCode: null,
    })
    expect(state.terminalIds).toContain("term-1")
  })

  it("uses default args=[] when omitted", async () => {
    native.acpTerminalCreate.mockResolvedValue("term-2")
    await useExternalAgentStore.getState().createTerminal("session-2", "ls")
    expect(native.acpTerminalCreate).toHaveBeenCalledWith("session-2", "ls", [], undefined)
  })

  it("records lastError and rethrows on Error", async () => {
    native.acpTerminalCreate.mockRejectedValue(new Error("term boom"))
    await expect(useExternalAgentStore.getState().createTerminal("s", "ls")).rejects.toThrow(
      "term boom"
    )
    expect(useExternalAgentStore.getState().lastError).toBe("term boom")
    expect(useExternalAgentStore.getState().isLoading).toBe(false)
  })

  it("stringifies non-Error rejection", async () => {
    native.acpTerminalCreate.mockRejectedValue("term str fail")
    await expect(useExternalAgentStore.getState().createTerminal("s", "ls")).rejects.toBe(
      "term str fail"
    )
    expect(useExternalAgentStore.getState().lastError).toBe("term str fail")
  })
})

// =============================================================================
// writeToTerminal
// =============================================================================

describe("writeToTerminal (Tauri)", () => {
  it("calls native and resolves on success", async () => {
    native.acpTerminalWrite.mockResolvedValue(undefined)
    await useExternalAgentStore.getState().writeToTerminal("t", "data")
    expect(native.acpTerminalWrite).toHaveBeenCalledWith("t", "data")
  })

  it("records lastError and rethrows on Error", async () => {
    native.acpTerminalWrite.mockRejectedValue(new Error("write fail"))
    await expect(useExternalAgentStore.getState().writeToTerminal("t", "x")).rejects.toThrow(
      "write fail"
    )
    expect(useExternalAgentStore.getState().lastError).toBe("write fail")
  })

  it("stringifies non-Error rejection", async () => {
    native.acpTerminalWrite.mockRejectedValue(false)
    await expect(useExternalAgentStore.getState().writeToTerminal("t", "x")).rejects.toBe(false)
    expect(useExternalAgentStore.getState().lastError).toBe("false")
  })
})

// =============================================================================
// getTerminalOutput
// =============================================================================

describe("getTerminalOutput (Tauri)", () => {
  it("merges output into existing terminal record (with exitCode)", async () => {
    native.acpTerminalOutput.mockResolvedValue({
      output: "hello",
      truncated: false,
      exitStatus: { exitCode: null, signal: null },
      exitCode: 0,
    })
    useExternalAgentStore.setState({
      terminals: {
        t1: {
          id: "t1",
          sessionId: "s",
          command: "ls",
          isRunning: true,
          output: "",
          exitCode: null,
          createdAt: 1,
        },
      },
      terminalIds: ["t1"],
    })
    const result = await useExternalAgentStore.getState().getTerminalOutput("t1")
    expect(result.output).toBe("hello")
    expect(useExternalAgentStore.getState().terminals.t1.output).toBe("hello")
    expect(useExternalAgentStore.getState().terminals.t1.exitCode).toBe(0)
  })

  it("falls back to exitStatus.exitCode when result.exitCode is missing", async () => {
    native.acpTerminalOutput.mockResolvedValue({
      output: "done",
      truncated: false,
      exitStatus: { exitCode: 5, signal: null },
    })
    useExternalAgentStore.setState({
      terminals: {
        t1: {
          id: "t1",
          sessionId: "s",
          command: "ls",
          isRunning: true,
          output: "",
          exitCode: null,
          createdAt: 1,
        },
      },
    })
    await useExternalAgentStore.getState().getTerminalOutput("t1")
    expect(useExternalAgentStore.getState().terminals.t1.exitCode).toBe(5)
  })

  it("uses null when both result.exitCode and exitStatus.exitCode are missing", async () => {
    native.acpTerminalOutput.mockResolvedValue({
      output: "x",
      truncated: false,
      exitStatus: { exitCode: null, signal: null },
    })
    useExternalAgentStore.setState({
      terminals: {
        t1: {
          id: "t1",
          sessionId: "s",
          command: "ls",
          isRunning: true,
          output: "",
          exitCode: null,
          createdAt: 1,
        },
      },
    })
    await useExternalAgentStore.getState().getTerminalOutput("t1")
    expect(useExternalAgentStore.getState().terminals.t1.exitCode).toBeNull()
  })

  it("returns the result without mutating state when terminal is unknown", async () => {
    native.acpTerminalOutput.mockResolvedValue({
      output: "x",
      truncated: false,
      exitStatus: { exitCode: null, signal: null },
    })
    const result = await useExternalAgentStore.getState().getTerminalOutput("ghost")
    expect(result.output).toBe("x")
    expect(useExternalAgentStore.getState().terminals).toEqual({})
  })
})

// =============================================================================
// killTerminal
// =============================================================================

describe("killTerminal (Tauri)", () => {
  it("flips isRunning to false on existing terminal", async () => {
    native.acpTerminalKill.mockResolvedValue(undefined)
    useExternalAgentStore.setState({
      terminals: {
        t1: {
          id: "t1",
          sessionId: "s",
          command: "x",
          isRunning: true,
          output: "",
          exitCode: null,
          createdAt: 1,
        },
      },
    })
    await useExternalAgentStore.getState().killTerminal("t1")
    expect(useExternalAgentStore.getState().terminals.t1.isRunning).toBe(false)
  })

  it("is a no-op state change when the terminal is unknown", async () => {
    native.acpTerminalKill.mockResolvedValue(undefined)
    await useExternalAgentStore.getState().killTerminal("ghost")
    expect(useExternalAgentStore.getState().terminals).toEqual({})
  })

  it("records lastError and rethrows on Error", async () => {
    native.acpTerminalKill.mockRejectedValue(new Error("kill term fail"))
    await expect(useExternalAgentStore.getState().killTerminal("t")).rejects.toThrow(
      "kill term fail"
    )
    expect(useExternalAgentStore.getState().lastError).toBe("kill term fail")
  })

  it("stringifies non-Error rejection", async () => {
    native.acpTerminalKill.mockRejectedValue("string fail")
    await expect(useExternalAgentStore.getState().killTerminal("t")).rejects.toBe("string fail")
    expect(useExternalAgentStore.getState().lastError).toBe("string fail")
  })
})

// =============================================================================
// releaseTerminal
// =============================================================================

describe("releaseTerminal (Tauri)", () => {
  it("removes the terminal entry and id", async () => {
    native.acpTerminalRelease.mockResolvedValue(undefined)
    useExternalAgentStore.setState({
      terminals: {
        t1: {
          id: "t1",
          sessionId: "s",
          command: "x",
          isRunning: false,
          output: "",
          exitCode: 0,
          createdAt: 1,
        },
      },
      terminalIds: ["t1"],
    })
    await useExternalAgentStore.getState().releaseTerminal("t1")
    expect(useExternalAgentStore.getState().terminals).toEqual({})
    expect(useExternalAgentStore.getState().terminalIds).toEqual([])
  })

  it("records lastError and rethrows on Error", async () => {
    native.acpTerminalRelease.mockRejectedValue(new Error("release fail"))
    await expect(useExternalAgentStore.getState().releaseTerminal("t")).rejects.toThrow(
      "release fail"
    )
    expect(useExternalAgentStore.getState().lastError).toBe("release fail")
  })

  it("stringifies non-Error rejection", async () => {
    native.acpTerminalRelease.mockRejectedValue(0)
    await expect(useExternalAgentStore.getState().releaseTerminal("t")).rejects.toBe(0)
    expect(useExternalAgentStore.getState().lastError).toBe("0")
  })
})

// =============================================================================
// waitForTerminalExit
// =============================================================================

describe("waitForTerminalExit (Tauri)", () => {
  it("returns exit code from result.exitCode and updates the terminal record", async () => {
    native.acpTerminalWaitForExit.mockResolvedValue({
      exitStatus: { exitCode: null, signal: null },
      exitCode: 9,
    })
    useExternalAgentStore.setState({
      terminals: {
        t1: {
          id: "t1",
          sessionId: "s",
          command: "x",
          isRunning: true,
          output: "",
          exitCode: null,
          createdAt: 1,
        },
      },
    })
    const code = await useExternalAgentStore.getState().waitForTerminalExit("t1", 1000)
    expect(code).toBe(9)
    expect(useExternalAgentStore.getState().terminals.t1.isRunning).toBe(false)
    expect(useExternalAgentStore.getState().terminals.t1.exitCode).toBe(9)
  })

  it("falls back to exitStatus.exitCode when result.exitCode is missing", async () => {
    native.acpTerminalWaitForExit.mockResolvedValue({
      exitStatus: { exitCode: 2, signal: null },
    })
    useExternalAgentStore.setState({
      terminals: {
        t1: {
          id: "t1",
          sessionId: "s",
          command: "x",
          isRunning: true,
          output: "",
          exitCode: null,
          createdAt: 1,
        },
      },
    })
    const code = await useExternalAgentStore.getState().waitForTerminalExit("t1")
    expect(code).toBe(2)
  })

  it("returns null when both exit codes are missing and the terminal is unknown", async () => {
    native.acpTerminalWaitForExit.mockResolvedValue({
      exitStatus: { exitCode: null, signal: null },
    })
    const code = await useExternalAgentStore.getState().waitForTerminalExit("ghost")
    expect(code).toBeNull()
  })

  it("records lastError and rethrows on Error", async () => {
    native.acpTerminalWaitForExit.mockRejectedValue(new Error("wait fail"))
    await expect(useExternalAgentStore.getState().waitForTerminalExit("t")).rejects.toThrow(
      "wait fail"
    )
    expect(useExternalAgentStore.getState().lastError).toBe("wait fail")
  })

  it("stringifies non-Error rejection", async () => {
    native.acpTerminalWaitForExit.mockRejectedValue(null)
    await expect(useExternalAgentStore.getState().waitForTerminalExit("t")).rejects.toBeNull()
    expect(useExternalAgentStore.getState().lastError).toBe("null")
  })
})

// =============================================================================
// getSessionTerminals
// =============================================================================

describe("getSessionTerminals (Tauri)", () => {
  it("delegates to native", async () => {
    native.acpTerminalGetSessionTerminals.mockResolvedValue(["t1", "t2"])
    const ids = await useExternalAgentStore.getState().getSessionTerminals("s")
    expect(ids).toEqual(["t1", "t2"])
    expect(native.acpTerminalGetSessionTerminals).toHaveBeenCalledWith("s")
  })
})

// =============================================================================
// killSessionTerminals
// =============================================================================

describe("killSessionTerminals (Tauri)", () => {
  it("removes terminals matching the session and keeps others", async () => {
    native.acpTerminalKillSessionTerminals.mockResolvedValue(undefined)
    useExternalAgentStore.setState({
      terminals: {
        t1: {
          id: "t1",
          sessionId: "s",
          command: "x",
          isRunning: true,
          output: "",
          exitCode: null,
          createdAt: 1,
        },
        t2: {
          id: "t2",
          sessionId: "other",
          command: "y",
          isRunning: true,
          output: "",
          exitCode: null,
          createdAt: 1,
        },
      },
      terminalIds: ["t1", "t2"],
    })
    await useExternalAgentStore.getState().killSessionTerminals("s")
    const state = useExternalAgentStore.getState()
    expect(Object.keys(state.terminals)).toEqual(["t2"])
    expect(state.terminalIds).toEqual(["t2"])
  })

  it("records lastError and rethrows on Error", async () => {
    native.acpTerminalKillSessionTerminals.mockRejectedValue(new Error("ks fail"))
    await expect(useExternalAgentStore.getState().killSessionTerminals("s")).rejects.toThrow(
      "ks fail"
    )
    expect(useExternalAgentStore.getState().lastError).toBe("ks fail")
  })

  it("stringifies non-Error rejection", async () => {
    native.acpTerminalKillSessionTerminals.mockRejectedValue(undefined)
    await expect(useExternalAgentStore.getState().killSessionTerminals("s")).rejects.toBeUndefined()
    expect(useExternalAgentStore.getState().lastError).toBe("undefined")
  })
})

// =============================================================================
// isTerminalRunning
// =============================================================================

describe("isTerminalRunning (Tauri)", () => {
  it("updates the terminal record when found", async () => {
    native.acpTerminalIsRunning.mockResolvedValue(false)
    useExternalAgentStore.setState({
      terminals: {
        t1: {
          id: "t1",
          sessionId: "s",
          command: "x",
          isRunning: true,
          output: "",
          exitCode: null,
          createdAt: 1,
        },
      },
    })
    const result = await useExternalAgentStore.getState().isTerminalRunning("t1")
    expect(result).toBe(false)
    expect(useExternalAgentStore.getState().terminals.t1.isRunning).toBe(false)
  })

  it("does not mutate state when the terminal is unknown", async () => {
    native.acpTerminalIsRunning.mockResolvedValue(true)
    const result = await useExternalAgentStore.getState().isTerminalRunning("ghost")
    expect(result).toBe(true)
    expect(useExternalAgentStore.getState().terminals).toEqual({})
  })
})

// =============================================================================
// getTerminalInfo
// =============================================================================

describe("getTerminalInfo (Tauri)", () => {
  it("delegates to native", async () => {
    const info = {
      id: "t1",
      sessionId: "s",
      command: "x",
      state: { type: "Running" },
      exitCode: null,
    }
    native.acpTerminalGetInfo.mockResolvedValue(info)
    const got = await useExternalAgentStore.getState().getTerminalInfo("t1")
    expect(got).toBe(info)
    expect(native.acpTerminalGetInfo).toHaveBeenCalledWith("t1")
  })
})

// =============================================================================
// refreshTerminals
// =============================================================================

describe("refreshTerminals (Tauri)", () => {
  it("rebuilds the terminals map preserving existing createdAt", async () => {
    native.acpTerminalList.mockResolvedValue(["t1", "t2"])
    native.acpTerminalGetInfo
      .mockResolvedValueOnce({
        id: "t1",
        sessionId: "s1",
        command: "ls",
        state: { type: "Running" },
        exitCode: null,
      })
      .mockResolvedValueOnce({
        id: "t2",
        sessionId: "s2",
        command: "echo",
        state: { type: "Exited", code: 0 },
        exitCode: 0,
      })
    native.acpTerminalOutput
      .mockResolvedValueOnce({
        output: "out1",
        truncated: false,
        exitStatus: { exitCode: null, signal: null },
      })
      .mockResolvedValueOnce({
        output: "out2",
        truncated: false,
        exitStatus: { exitCode: 0, signal: null },
        exitCode: 0,
      })
    native.acpTerminalIsRunning.mockResolvedValueOnce(true).mockResolvedValueOnce(false)

    useExternalAgentStore.setState({
      terminals: {
        t1: {
          id: "t1",
          sessionId: "s1",
          command: "ls",
          isRunning: false,
          output: "",
          exitCode: null,
          createdAt: 9999,
        },
      },
    })

    await useExternalAgentStore.getState().refreshTerminals()
    const state = useExternalAgentStore.getState()
    expect(state.isLoading).toBe(false)
    expect(state.terminalIds).toEqual(["t1", "t2"])
    expect(state.terminals.t1).toMatchObject({
      id: "t1",
      sessionId: "s1",
      command: "ls",
      isRunning: true,
      output: "out1",
      createdAt: 9999,
    })
    expect(state.terminals.t2).toMatchObject({
      id: "t2",
      sessionId: "s2",
      command: "echo",
      isRunning: false,
      output: "out2",
      exitCode: 0,
    })
    expect(typeof state.terminals.t2.createdAt).toBe("number")
  })

  it("falls back to null exitCode when both exit codes are absent", async () => {
    native.acpTerminalList.mockResolvedValue(["t-null"])
    native.acpTerminalGetInfo.mockResolvedValueOnce({
      id: "t-null",
      sessionId: "s",
      command: "x",
      state: { type: "Running" },
      exitCode: null,
    })
    native.acpTerminalOutput.mockResolvedValueOnce({
      output: "",
      truncated: false,
      exitStatus: { exitCode: null, signal: null },
    })
    native.acpTerminalIsRunning.mockResolvedValueOnce(true)
    await useExternalAgentStore.getState().refreshTerminals()
    expect(useExternalAgentStore.getState().terminals["t-null"].exitCode).toBeNull()
  })

  it("skips a released terminal (per-id error) but still completes the refresh", async () => {
    native.acpTerminalList.mockResolvedValue(["good", "bad"])
    native.acpTerminalGetInfo
      .mockResolvedValueOnce({
        id: "good",
        sessionId: "s",
        command: "ls",
        state: { type: "Running" },
        exitCode: null,
      })
      .mockRejectedValueOnce(new Error("released"))
    native.acpTerminalOutput.mockResolvedValueOnce({
      output: "ok",
      truncated: false,
      exitStatus: { exitCode: null, signal: null },
    })
    native.acpTerminalIsRunning.mockResolvedValueOnce(true)

    await useExternalAgentStore.getState().refreshTerminals()
    const state = useExternalAgentStore.getState()
    expect(state.terminals.good).toBeDefined()
    expect(state.terminals.bad).toBeUndefined()
    expect(state.terminalIds).toEqual(["good", "bad"])
    expect(state.lastError).toBeNull()
  })

  it("records lastError when listing fails (Error path)", async () => {
    native.acpTerminalList.mockRejectedValue(new Error("list fail"))
    await useExternalAgentStore.getState().refreshTerminals()
    expect(useExternalAgentStore.getState().lastError).toBe("list fail")
    expect(useExternalAgentStore.getState().isLoading).toBe(false)
  })

  it("stringifies non-Error rejection on the listing failure", async () => {
    native.acpTerminalList.mockRejectedValue("oops")
    await useExternalAgentStore.getState().refreshTerminals()
    expect(useExternalAgentStore.getState().lastError).toBe("oops")
  })
})

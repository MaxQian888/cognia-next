const getTeam = jest.fn((id: string) => ({ id, task: "original objective", config: {} }))
const getTeammates = jest.fn(() => [])
const getTeamTasks = jest.fn(() => [])
const addMessage = jest.fn()
const setTaskStatus = jest.fn()
const updateTeammate = jest.fn()
const runTeamLifecycle = jest.fn(
  async (_teamId: string, _deps: unknown, _signal?: AbortSignal) => ({
    runId: "run_1",
    status: "completed" as const,
    output: { report: "final answer" },
    traceId: "tr",
  })
)

jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: {
    getState: () => ({
      getTeam,
      getTeammates,
      getTeamTasks,
      addMessage,
      setTaskStatus,
      updateTeammate,
      setFinalResult: jest.fn(),
    }),
  },
}))
jest.mock("@/lib/ai/agent/agent-team-runtime", () => ({ runTeamLifecycle }))
jest.mock("@/lib/ai/agent/agent-team-runtime-deps", () => ({
  buildAgentTeamRuntimeDeps: () => ({ runLeadPlanning: undefined, notifierDeps: undefined }),
}))
jest.mock("@/lib/db/agent-traces", () => ({ queryByTrace: jest.fn(async () => []) }))
jest.mock("@/lib/tauri", () => ({ isTauri: () => true }))

import { defaultTeamTargetDeps, extractTeamText } from "./team-default-deps"

describe("extractTeamText", () => {
  it("prefers an ultracode report, then string, then JSON", () => {
    expect(extractTeamText({ report: "r" })).toBe("r")
    expect(extractTeamText("plain")).toBe("plain")
    expect(extractTeamText({ a: 1 })).toBe('{"a":1}')
    expect(extractTeamText(undefined)).toBe("")
  })
})

describe("defaultTeamTargetDeps.runTeam", () => {
  it("overrides the team objective with the eval prompt and threads the trace id", async () => {
    const deps = defaultTeamTargetDeps()
    const out = await deps.runTeam({ teamId: "tm1", prompt: "eval prompt", traceId: "tr" })
    expect(out.text).toBe("final answer")
    expect(out.traceId).toBe("tr")
    // the storeReader handed to runTeamLifecycle injects the prompt as task
    const passedDeps = runTeamLifecycle.mock.calls[0][1] as {
      traceId: string
      storeReader: { getTeam: (id: string) => { task: string } }
    }
    expect(passedDeps.traceId).toBe("tr")
    expect(passedDeps.storeReader.getTeam("tm1").task).toBe("eval prompt")
  })

  it("reports tool capability via isTauri", () => {
    expect(defaultTeamTargetDeps().isToolCapable()).toBe(true)
  })

  it("wires storeReader + storeWriter closures through to the live store", async () => {
    const deps = defaultTeamTargetDeps()
    await deps.runTeam({ teamId: "tm1", prompt: "p", traceId: "tr" })
    const passed = runTeamLifecycle.mock.calls[0][1] as {
      storeReader: { getTeammates: (id: string) => unknown; getTeamTasks: (id: string) => unknown }
      storeWriter: {
        addMessage: (i: unknown) => void
        setTaskStatus: (a: string, b: string, c?: string, d?: string) => void
        updateTeammate: (a: string, b: unknown) => void
      }
    }
    passed.storeReader.getTeammates("tm1")
    passed.storeReader.getTeamTasks("tm1")
    passed.storeWriter.addMessage({ teamId: "tm1" })
    passed.storeWriter.setTaskStatus("task", "completed", "res")
    passed.storeWriter.updateTeammate("mate", { name: "x" })
    expect(getTeammates).toHaveBeenCalledWith("tm1")
    expect(getTeamTasks).toHaveBeenCalledWith("tm1")
    expect(addMessage).toHaveBeenCalledWith({ teamId: "tm1" })
    expect(setTaskStatus).toHaveBeenCalledWith("task", "completed", "res", undefined)
    expect(updateTeammate).toHaveBeenCalledWith("mate", { name: "x" })
  })
})

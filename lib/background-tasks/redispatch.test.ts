import { redispatchBackgroundRun } from "./redispatch"
import type { BackgroundTaskJournalRecord } from "./registry-core"

const getDispatchableSubagentDef = jest.fn()
const resolveCaller = jest.fn(async () => ({
  parentDepth: 0,
  maxDepth: 2,
  parentChain: [],
  budgetRoot: "dispatch:chat-1",
}))
const startDispatchRun = jest.fn(async () => ({ runId: "new-run", text: "started" }))
const updateBackgroundTaskRecord = jest.fn(async () => undefined)

jest.mock("@/lib/claude/agents/subagents", () => ({
  getDispatchableSubagentDef: (...args: unknown[]) => getDispatchableSubagentDef(...(args as [])),
}))
jest.mock("@/lib/claude/agents/dispatch-run", () => ({
  resolveCaller: (...args: unknown[]) => resolveCaller(...(args as [])),
  startDispatchRun: (...args: unknown[]) => startDispatchRun(...(args as [])),
}))
jest.mock("@/lib/db/background-tasks", () => ({
  updateBackgroundTaskRecord: (...args: unknown[]) => updateBackgroundTaskRecord(...(args as [])),
}))

function record(over: Partial<BackgroundTaskJournalRecord> = {}): BackgroundTaskJournalRecord {
  return {
    runId: "orig-1",
    kind: "subagent",
    subagentId: "explore",
    prompt: "look around",
    sessionId: "chat-1",
    host: "renderer",
    status: "interrupted",
    startedAt: 1000,
    settledAt: 2000,
    mode: "background",
    toolsEnabled: false,
    ...over,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  getDispatchableSubagentDef.mockReturnValue({ id: "explore" })
})

describe("redispatchBackgroundRun", () => {
  it("re-dispatches with the original subagent/prompt/tool flag as a background run", async () => {
    const outcome = await redispatchBackgroundRun(record(), { kind: "manual" })

    expect(outcome).toEqual({ ok: true, runId: "new-run" })
    expect(resolveCaller).toHaveBeenCalledWith("chat-1")
    expect(startDispatchRun).toHaveBeenCalledWith(
      expect.objectContaining({
        subagentId: "explore",
        prompt: "look around",
        toolsEnabled: false,
        background: true,
        parentSessionId: "chat-1",
        resumeOfRunId: "orig-1",
        resumeAttempt: 0, // manual resets the chain
      })
    )
    expect(updateBackgroundTaskRecord).toHaveBeenCalledWith("orig-1", {
      resumedByRunId: "new-run",
    })
  })

  it("chains the attempt counter for auto re-dispatch", async () => {
    await redispatchBackgroundRun(record({ resumeAttempt: 1 }), { kind: "auto" })
    expect(startDispatchRun).toHaveBeenCalledWith(expect.objectContaining({ resumeAttempt: 2 }))
  })

  it("caps auto chains at maxAutoResumeAttempts (crash-loop guard)", async () => {
    const outcome = await redispatchBackgroundRun(record({ resumeAttempt: 2 }), {
      kind: "auto",
      maxAutoResumeAttempts: 2,
    })
    expect(outcome).toMatchObject({ ok: false, reason: "attempt-cap" })
    expect(startDispatchRun).not.toHaveBeenCalled()
  })

  it("manual re-run ignores the attempt cap (explicit user intent)", async () => {
    const outcome = await redispatchBackgroundRun(record({ resumeAttempt: 5 }), {
      kind: "manual",
    })
    expect(outcome).toEqual({ ok: true, runId: "new-run" })
    expect(startDispatchRun).toHaveBeenCalledWith(expect.objectContaining({ resumeAttempt: 0 }))
  })

  it("refuses runs that are still running", async () => {
    const outcome = await redispatchBackgroundRun(record({ status: "running" }), {
      kind: "manual",
    })
    expect(outcome).toMatchObject({ ok: false, reason: "still-running" })
    expect(startDispatchRun).not.toHaveBeenCalled()
  })

  it("is a structured no-op when the subagent def no longer exists", async () => {
    getDispatchableSubagentDef.mockReturnValue(undefined)
    const outcome = await redispatchBackgroundRun(record(), { kind: "manual" })
    expect(outcome).toMatchObject({ ok: false, reason: "missing-subagent" })
    expect(startDispatchRun).not.toHaveBeenCalled()
  })

  it("defaults toolsEnabled to true for legacy rows without the flag", async () => {
    const legacy = record()
    delete (legacy as Partial<BackgroundTaskJournalRecord>).toolsEnabled
    await redispatchBackgroundRun(legacy, { kind: "manual" })
    expect(startDispatchRun).toHaveBeenCalledWith(expect.objectContaining({ toolsEnabled: true }))
  })

  it("survives a failed provenance write", async () => {
    updateBackgroundTaskRecord.mockRejectedValueOnce(new Error("db down"))
    await expect(redispatchBackgroundRun(record(), { kind: "manual" })).resolves.toEqual({
      ok: true,
      runId: "new-run",
    })
  })
})

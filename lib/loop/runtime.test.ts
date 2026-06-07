import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { __resetRedactionKey } from "@/lib/twin/ingest/redaction-key"
import { getLoop, listLoopEvents } from "@/lib/db/loops"
import { __resetGoalRuntimeForTesting, getGoalRuntime } from "@/lib/goal/runtime"

const schedulerMock = {
  createTask: jest.fn(),
  pauseTask: jest.fn().mockResolvedValue(true),
  resumeTask: jest.fn().mockResolvedValue(true),
  deleteTask: jest.fn().mockResolvedValue(true),
}
jest.mock("@/lib/scheduler/task-scheduler", () => ({
  getTaskScheduler: () => schedulerMock,
}))

import {
  DEFAULT_LOOP_CONFIG,
  LoopGoalConflict,
  __resetLoopRuntimeForTesting,
  getLoopRuntime,
  resolveLoopConfig,
} from "./runtime"
import type { AppSettings } from "@/lib/claude/types"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await __resetRedactionKey()
  __resetLoopRuntimeForTesting()
  __resetGoalRuntimeForTesting()
  schedulerMock.createTask.mockReset().mockResolvedValue({ id: "task_1" })
  schedulerMock.pauseTask.mockReset().mockResolvedValue(true)
  schedulerMock.resumeTask.mockReset().mockResolvedValue(true)
  schedulerMock.deleteTask.mockReset().mockResolvedValue(true)
})

describe("resolveLoopConfig", () => {
  it("returns hard-coded defaults when settings are null", () => {
    expect(resolveLoopConfig(null)).toEqual(DEFAULT_LOOP_CONFIG)
  })

  it("merges AppSettings.loops and lets overrides win", () => {
    const settings = { loops: { maxIterations: 10, minDelayMs: 120_000 } } as unknown as AppSettings
    expect(resolveLoopConfig(settings).maxIterations).toBe(10)
    expect(resolveLoopConfig(settings).minDelayMs).toBe(120_000)
    expect(resolveLoopConfig(settings, { maxIterations: 3 }).maxIterations).toBe(3)
  })
})

describe("LoopRuntime.createLoop — self-paced", () => {
  it("creates an active row with redaction, expiry, and a created event", async () => {
    const rt = getLoopRuntime()
    const loop = await rt.createLoop({
      sessionId: "ses_a",
      rawPrompt: "ping alice@example.com hourly",
      mode: "self_paced",
    })
    expect(loop.status).toBe("active")
    expect(loop.safePrompt).toContain("<EMAIL_001>")
    expect(loop.redactionMapEnc).not.toBe("")
    expect(loop.expiresAt).toBeGreaterThan(Date.now())
    expect(loop.isSlashCommand).toBe(false)
    expect(schedulerMock.createTask).not.toHaveBeenCalled()
    const events = await listLoopEvents(loop.id)
    expect(events.some((e) => e.kind === "loop_created")).toBe(true)
  })

  it("flags a slash-command prompt", async () => {
    const rt = getLoopRuntime()
    const loop = await rt.createLoop({
      sessionId: "ses_a",
      rawPrompt: "/review latest changes",
      mode: "self_paced",
    })
    expect(loop.isSlashCommand).toBe(true)
    expect(loop.commandName).toBe("review")
  })

  it("stops an existing open loop before creating the new one", async () => {
    const rt = getLoopRuntime()
    const first = await rt.createLoop({ sessionId: "ses_a", rawPrompt: "a", mode: "self_paced" })
    const second = await rt.createLoop({ sessionId: "ses_a", rawPrompt: "b", mode: "self_paced" })
    expect((await getLoop(first.id))?.status).toBe("stopped")
    expect((await getLoop(second.id))?.status).toBe("active")
  })

  it("refuses when the session has an active goal (LoopGoalConflict)", async () => {
    await getGoalRuntime().createGoal({ sessionId: "ses_a", rawObjective: "objective" })
    const rt = getLoopRuntime()
    await expect(
      rt.createLoop({ sessionId: "ses_a", rawPrompt: "x", mode: "self_paced" })
    ).rejects.toThrow(LoopGoalConflict)
  })

  it("interval loops are NOT blocked by an active goal", async () => {
    await getGoalRuntime().createGoal({ sessionId: "ses_a", rawObjective: "objective" })
    const rt = getLoopRuntime()
    const loop = await rt.createLoop({
      sessionId: "ses_a",
      rawPrompt: "x",
      mode: "interval",
      intervalMs: 300_000,
    })
    expect(loop.status).toBe("active")
  })
})

describe("LoopRuntime.createLoop — interval", () => {
  it("creates the backing scheduler task and stores its id", async () => {
    const rt = getLoopRuntime()
    const loop = await rt.createLoop({
      sessionId: "ses_a",
      rawPrompt: "check deploy",
      mode: "interval",
      intervalMs: 5 * 60_000,
    })
    expect(schedulerMock.createTask).toHaveBeenCalledTimes(1)
    const input = schedulerMock.createTask.mock.calls[0][0]
    expect(input.type).toBe("chat")
    expect(input.tags).toEqual(["loop"])
    expect(loop.scheduledTaskId).toBe("task_1")
    expect(loop.intervalMs).toBe(5 * 60_000)
  })

  it("rolls the loop row back when scheduler task creation fails", async () => {
    schedulerMock.createTask.mockRejectedValue(new Error("daemon down"))
    const rt = getLoopRuntime()
    await expect(
      rt.createLoop({ sessionId: "ses_a", rawPrompt: "x", mode: "interval", intervalMs: 60_000 })
    ).rejects.toThrow("daemon down")
    expect(await rt.getOpenLoopForSession("ses_a")).toBeUndefined()
  })
})

describe("LoopRuntime — pause/resume/stop", () => {
  it("pause rotates the generation and mirrors into the scheduler", async () => {
    const rt = getLoopRuntime()
    const loop = await rt.createLoop({
      sessionId: "ses_a",
      rawPrompt: "x",
      mode: "interval",
      intervalMs: 60_000,
    })
    const before = (await getLoop(loop.id))!.generationId
    const paused = await rt.pauseLoop(loop.id)
    expect(paused?.status).toBe("paused")
    expect(paused?.generationId).not.toBe(before)
    expect(schedulerMock.pauseTask).toHaveBeenCalledWith("task_1")
  })

  it("resume reactivates and mirrors into the scheduler", async () => {
    const rt = getLoopRuntime()
    const loop = await rt.createLoop({
      sessionId: "ses_a",
      rawPrompt: "x",
      mode: "interval",
      intervalMs: 60_000,
    })
    await rt.pauseLoop(loop.id)
    const resumed = await rt.resumeLoop(loop.id)
    expect(resumed?.status).toBe("active")
    expect(schedulerMock.resumeTask).toHaveBeenCalledWith("task_1")
  })

  it("stop deletes the backing scheduler task", async () => {
    const rt = getLoopRuntime()
    const loop = await rt.createLoop({
      sessionId: "ses_a",
      rawPrompt: "x",
      mode: "interval",
      intervalMs: 60_000,
    })
    const stopped = await rt.stopLoop(loop.id)
    expect(stopped?.status).toBe("stopped")
    expect(stopped?.endedAt).toBeGreaterThan(0)
    expect(schedulerMock.deleteTask).toHaveBeenCalledWith("task_1")
  })

  it("pause fires the registered abort controller", async () => {
    const rt = getLoopRuntime()
    const loop = await rt.createLoop({ sessionId: "ses_a", rawPrompt: "x", mode: "self_paced" })
    const ac = new AbortController()
    rt.registerAbortController(loop.id, ac)
    await rt.pauseLoop(loop.id)
    expect(ac.signal.aborted).toBe(true)
  })

  it("transitions are no-ops on terminal loops", async () => {
    const rt = getLoopRuntime()
    const loop = await rt.createLoop({ sessionId: "ses_a", rawPrompt: "x", mode: "self_paced" })
    await rt.stopLoop(loop.id)
    expect((await rt.pauseLoop(loop.id))?.status).toBe("stopped")
    expect((await rt.resumeLoop(loop.id))?.status).toBe("stopped")
    expect((await rt.stopLoop(loop.id))?.status).toBe("stopped")
  })
})

describe("LoopRuntime.updateConfig + deleteLoop", () => {
  it("patches config and logs config_updated", async () => {
    const rt = getLoopRuntime()
    const loop = await rt.createLoop({ sessionId: "ses_a", rawPrompt: "x", mode: "self_paced" })
    const updated = await rt.updateConfig(loop.id, { maxIterations: 7 })
    expect(updated?.config.maxIterations).toBe(7)
    expect((await listLoopEvents(loop.id)).some((e) => e.kind === "config_updated")).toBe(true)
  })

  it("deleteLoop tears down the scheduler task and the rows", async () => {
    const rt = getLoopRuntime()
    const loop = await rt.createLoop({
      sessionId: "ses_a",
      rawPrompt: "x",
      mode: "interval",
      intervalMs: 60_000,
    })
    await rt.deleteLoop(loop.id)
    expect(schedulerMock.deleteTask).toHaveBeenCalledWith("task_1")
    expect(await getLoop(loop.id)).toBeUndefined()
  })
})

describe("GoalRuntime symmetric exclusivity", () => {
  it("createGoal refuses when an active self-paced loop exists", async () => {
    const rt = getLoopRuntime()
    await rt.createLoop({ sessionId: "ses_a", rawPrompt: "x", mode: "self_paced" })
    await expect(
      getGoalRuntime().createGoal({ sessionId: "ses_a", rawObjective: "objective" })
    ).rejects.toThrow(/self-paced \/loop/)
  })

  it("createGoal proceeds when only an interval loop exists", async () => {
    const rt = getLoopRuntime()
    await rt.createLoop({
      sessionId: "ses_a",
      rawPrompt: "x",
      mode: "interval",
      intervalMs: 60_000,
    })
    const goal = await getGoalRuntime().createGoal({ sessionId: "ses_a", rawObjective: "obj" })
    expect(goal.status).toBe("active")
  })
})

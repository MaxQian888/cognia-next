/** @jest-environment jsdom */

import { cancelScheduledTaskCore, listScheduledTasksCore, scheduleTaskCore } from "./scheduling"
import type { ScheduledTask } from "@/types/scheduler"

function task(id: string, sessionId: string): ScheduledTask {
  const now = new Date("2026-07-30T00:00:00.000Z")
  return {
    id,
    name: id,
    type: "chat",
    trigger: { type: "interval", intervalMs: 60_000 },
    payload: { prompt: "x", sessionId },
    config: { timeout: 1, maxRetries: 0, retryDelay: 1, runMissedOnStartup: true },
    notification: { onStart: false, onComplete: false, onError: true },
    status: "active",
    createdBy: { kind: "agent", sessionId },
    runCount: 0,
    successCount: 0,
    failureCount: 0,
    createdAt: now,
    updatedAt: now,
  }
}

function deps(seed: ScheduledTask[] = []) {
  return {
    scheduler: {
      getAllTasks: jest.fn().mockResolvedValue(seed),
      createTask: jest.fn().mockImplementation(async (input) => ({
        ...task("created", input.createdBy?.sessionId ?? ""),
        ...input,
        id: "created",
        nextRunAt: new Date("2026-07-30T00:01:00.000Z"),
      })),
      deleteTask: jest.fn().mockResolvedValue(true),
    },
    getSession: jest.fn().mockResolvedValue({ id: "session-1" }),
  }
}

describe("agent scheduler handlers", () => {
  it("rejects sub-minute schedules and ambiguous trigger inputs", async () => {
    await expect(
      scheduleTaskCore({ sessionId: "session-1", prompt: "x", intervalMs: 30_000 }, deps())
    ).resolves.toEqual(expect.objectContaining({ ok: false }))
    await expect(
      scheduleTaskCore(
        {
          sessionId: "session-1",
          prompt: "x",
          intervalMs: 60_000,
          cronExpression: "* * * * *",
        },
        deps()
      )
    ).resolves.toEqual(expect.objectContaining({ ok: false }))
  })

  it("creates a provenance-scoped chat task", async () => {
    const port = deps()
    const result = await scheduleTaskCore(
      { sessionId: "session-1", prompt: "run a check", intervalMs: 60_000 },
      port
    )
    expect(result.ok).toBe(true)
    expect(port.scheduler.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "chat",
        createdBy: { kind: "agent", sessionId: "session-1" },
        payload: { sessionId: "session-1", prompt: "run a check" },
      })
    )
  })

  it("uses the connector digest executor for an IM-bound session", async () => {
    const port = deps()
    port.getSession.mockResolvedValue({
      id: "session-1",
      characterId: "char-1",
      platformBinding: { adapterId: "bot-1", conversationKey: "telegram:bot-1:chat" },
    })
    await scheduleTaskCore(
      { sessionId: "session-1", prompt: "digest", cronExpression: "0 9 * * *" },
      port
    )
    expect(port.scheduler.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "connection:scheduled:digest",
        payload: expect.objectContaining({
          adapterId: "bot-1",
          conversationKey: "telegram:bot-1:chat",
          characterId: "char-1",
        }),
      })
    )
  })

  it("lists and cancels only tasks owned by the calling agent session", async () => {
    const port = deps([task("own", "session-1"), task("other", "session-2")])
    await expect(listScheduledTasksCore({ sessionId: "session-1" }, port)).resolves.toEqual({
      ok: true,
      tasks: [expect.objectContaining({ id: "own" })],
    })
    await expect(
      cancelScheduledTaskCore({ sessionId: "session-1", taskId: "other" }, port)
    ).resolves.toEqual({ ok: false, error: "task is not owned by this agent session" })
    await expect(
      cancelScheduledTaskCore({ sessionId: "session-1", taskId: "own" }, port)
    ).resolves.toEqual({ ok: true, cancelled: true })
  })
})

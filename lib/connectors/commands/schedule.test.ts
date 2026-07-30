/** @jest-environment jsdom */

import {
  handleScheduleCommand,
  listVisibleScheduleTasks,
  MAX_SCHEDULES_PER_CONVERSATION,
  parseScheduleAction,
  type ScheduleCommandScheduler,
} from "./schedule"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { ScheduledTask } from "@/types/scheduler"

function task(
  id: string,
  conversationKey = "telegram:bot:private",
  senderId = "alice"
): ScheduledTask {
  const now = new Date("2026-07-30T00:00:00.000Z")
  return {
    id,
    name: `Task ${id}`,
    type: "connection:scheduled:digest",
    trigger: { type: "interval", intervalMs: 300_000 },
    payload: {
      scheduleProvenance: {
        source: "im",
        adapterId: "bot",
        conversationKey,
        senderId,
      },
    },
    config: {
      timeout: 60_000,
      maxRetries: 0,
      retryDelay: 1_000,
      runMissedOnStartup: true,
    },
    notification: { onStart: false, onComplete: false, onError: true },
    status: "active",
    runCount: 0,
    successCount: 0,
    failureCount: 0,
    createdAt: now,
    updatedAt: now,
    nextRunAt: new Date("2026-07-30T00:05:00.000Z"),
  }
}

function event(): NormalizedInboundEvent {
  return {
    platform: "telegram",
    adapterId: "bot",
    selfId: "self",
    messageId: "m1",
    conversationRef: { platform: "telegram", adapterId: "bot" },
    conversationKey: "telegram:bot:private",
    sender: { id: "alice", remoteUserId: "alice", platform: "telegram", adapterId: "bot" },
    channel: { id: "private", kind: "private" },
    segments: [{ type: "text", text: "x" }],
    plainText: "x",
    mentions: { selfMentioned: false, users: [] },
    timestamp: Date.now(),
    raw: {},
  }
}

function scheduler(seed: ScheduledTask[] = []): ScheduleCommandScheduler & {
  createTask: jest.Mock
  deleteTask: jest.Mock
} {
  return {
    getAllTasks: jest.fn().mockResolvedValue(seed),
    createTask: jest.fn().mockImplementation(async (input) => ({
      ...task("created"),
      ...input,
      id: "created",
      nextRunAt: new Date("2026-07-30T00:05:00.000Z"),
    })),
    deleteTask: jest.fn().mockResolvedValue(true),
  }
}

describe("parseScheduleAction", () => {
  it("parses interval, cron, and off forms", () => {
    expect(parseScheduleAction("5m summarize")).toEqual({
      kind: "create",
      trigger: { type: "interval", intervalMs: 300_000 },
      prompt: "summarize",
    })
    expect(parseScheduleAction("cron 0 9 * * 1-5 daily digest")).toEqual({
      kind: "create",
      trigger: { type: "cron", cronExpression: "0 9 * * 1-5" },
      prompt: "daily digest",
    })
    expect(parseScheduleAction("off 2")).toEqual({ kind: "off", selector: "2" })
  })

  it("rejects sub-minute and incomplete schedules", () => {
    expect(parseScheduleAction("30s too often")).toEqual({ kind: "invalid" })
    expect(parseScheduleAction("5m")).toEqual({ kind: "invalid" })
    expect(parseScheduleAction("cron 0 9 * * *")).toEqual({ kind: "invalid" })
  })
})

describe("IM schedule policy", () => {
  it("lists only tasks from the current conversation", () => {
    expect(
      listVisibleScheduleTasks(
        [task("visible"), task("other", "telegram:bot:other")],
        "telegram:bot:private"
      ).map((row) => row.id)
    ).toEqual(["visible"])
  })

  it("creates a digest bound to the source conversation and IM failure target", async () => {
    const runtime = scheduler()
    const reply = jest.fn().mockResolvedValue(undefined)
    await handleScheduleCommand({
      name: "schedule",
      arg: "5m summarize this chat",
      event: event(),
      characterId: "char-1",
      reply,
      scheduler: runtime,
    })

    expect(runtime.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "connection:scheduled:digest",
        trigger: { type: "interval", intervalMs: 300_000 },
        payload: expect.objectContaining({
          adapterId: "bot",
          conversationKey: "telegram:bot:private",
          characterId: "char-1",
          prompt: "summarize this chat",
        }),
        notification: expect.objectContaining({
          channels: ["im"],
          imTarget: { conversationKey: "telegram:bot:private" },
        }),
      })
    )
  })

  it("enforces the per-conversation quota before creating", async () => {
    const runtime = scheduler(
      Array.from({ length: MAX_SCHEDULES_PER_CONVERSATION }, (_, index) => task(`task-${index}`))
    )
    const reply = jest.fn().mockResolvedValue(undefined)
    await handleScheduleCommand({
      name: "schedule",
      arg: "5m summarize",
      event: event(),
      reply,
      scheduler: runtime,
    })
    expect(runtime.createTask).not.toHaveBeenCalled()
    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining("最多"),
      "denied",
      expect.objectContaining({ reason: "schedule_conversation_quota" })
    )
  })

  it("removes only a visible task selected by list number", async () => {
    const runtime = scheduler([task("visible"), task("other", "telegram:bot:other")])
    await handleScheduleCommand({
      name: "schedule",
      arg: "off 1",
      event: event(),
      reply: jest.fn().mockResolvedValue(undefined),
      scheduler: runtime,
    })
    expect(runtime.deleteTask).toHaveBeenCalledWith("visible")
  })

  it("renders /tasks as a portable A2UI card", async () => {
    const reply = jest.fn().mockResolvedValue(undefined)
    await handleScheduleCommand({
      name: "tasks",
      arg: "",
      event: event(),
      reply,
      scheduler: scheduler([task("visible")]),
    })
    expect(reply).toHaveBeenCalledWith([expect.objectContaining({ type: "a2ui" })], "applied", {
      taskCount: 1,
    })
    expect(JSON.stringify(reply.mock.calls[0]?.[0])).toContain("cognia://scheduler/task/visible")
  })
})

/**
 * The family's shared vocabulary.
 *
 * These are the pure parts: the trigger conversion, the agent-visible
 * projection, and the deliberately-narrower type list. The narrowing is worth
 * a test of its own, because widening it silently would hand an agent task
 * types whose payloads only mean something to the subsystem that owns them.
 */

import {
  AGENT_SCHEDULABLE_TASK_TYPES,
  assertAgentTaskPayload,
  assertAgentTaskTrigger,
  describeTrigger,
  formatDuration,
  toAgentVisibleTask,
  toTaskTrigger,
} from "./_core"

describe("AGENT_SCHEDULABLE_TASK_TYPES", () => {
  it("covers every kind of agent run the scheduler has an executor for", () => {
    for (const type of ["chat", "agent", "skill", "external-agent", "agent-team", "goal", "plan"]) {
      expect(AGENT_SCHEDULABLE_TASK_TYPES).toContain(type)
    }
  })

  it("excludes the types a subsystem authors from its own settings card", () => {
    // Their payloads only mean something to the code that registered the
    // executor, so an agent filling one in is guessing.
    for (const type of ["twin", "wiki-rebuild", "wiki-lint", "radar-report", "github-issue-sync"]) {
      expect(AGENT_SCHEDULABLE_TASK_TYPES).not.toContain(type)
    }
  })

  it("excludes script, which has a switch of its own", () => {
    // An agent that wants a command has `background-command`, which the
    // `scriptTasksEnabled` switch does not silently cover.
    expect(AGENT_SCHEDULABLE_TASK_TYPES).not.toContain("script")
    expect(AGENT_SCHEDULABLE_TASK_TYPES).toContain("background-command")
  })

  it("excludes the deprecated types", () => {
    expect(AGENT_SCHEDULABLE_TASK_TYPES).not.toContain("sync")
    expect(AGENT_SCHEDULABLE_TASK_TYPES).not.toContain("ai-generation")
  })
})

describe("toTaskTrigger", () => {
  it("passes a cron through, with its timezone only when given", () => {
    expect(toTaskTrigger({ type: "cron", cronExpression: "0 9 * * *" })).toEqual({
      type: "cron",
      cronExpression: "0 9 * * *",
    })
    expect(
      toTaskTrigger({ type: "cron", cronExpression: "0 9 * * *", timezone: "Asia/Shanghai" })
    ).toEqual({ type: "cron", cronExpression: "0 9 * * *", timezone: "Asia/Shanghai" })
  })

  it("converts an interval", () => {
    expect(toTaskTrigger({ type: "interval", intervalMs: 60_000 })).toEqual({
      type: "interval",
      intervalMs: 60_000,
    })
  })

  it("parses a one-off instant into a Date", () => {
    expect(toTaskTrigger({ type: "once", runAt: "2026-09-05T09:00:00.000Z" })).toEqual({
      type: "once",
      runAt: new Date("2026-09-05T09:00:00.000Z"),
    })
  })

  it("refuses an unparseable instant rather than scheduling at the epoch", () => {
    // `new Date("next tuesday")` is Invalid Date, and an Invalid Date reaching
    // the scheduler is a task that never fires and never says why.
    expect(() => toTaskTrigger({ type: "once", runAt: "next tuesday" })).toThrow(/ISO-8601/)
  })

  it("converts an event trigger", () => {
    expect(toTaskTrigger({ type: "event", eventType: "chat:completed" })).toEqual({
      type: "event",
      eventType: "chat:completed",
    })
  })
})

describe("toAgentVisibleTask", () => {
  const base = {
    id: "t1",
    name: "Digest",
    type: "chat",
    status: "active",
    trigger: { type: "cron", cronExpression: "0 9 * * *" },
    runCount: 2,
    successCount: 1,
    failureCount: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  }

  it("serializes dates and flattens the creator to its kind", () => {
    const visible = toAgentVisibleTask({
      ...base,
      nextRunAt: new Date("2026-09-05T09:00:00Z"),
      createdBy: { kind: "agent", sessionId: "s1" },
    } as never)
    expect(visible.nextRunAt).toBe("2026-09-05T09:00:00.000Z")
    // The session id is provenance the panel needs and the model does not.
    expect(visible.createdBy).toBe("agent")
  })

  it("omits absent fields rather than emitting undefined keys", () => {
    const visible = toAgentVisibleTask(base as never)
    expect(visible).not.toHaveProperty("nextRunAt")
    expect(visible).not.toHaveProperty("lastError")
    expect(visible).not.toHaveProperty("tags")
  })

  it("carries the terminal reason, which is what explains a stuck task", () => {
    const visible = toAgentVisibleTask({
      ...base,
      lastTerminalReason: "unsupported-on-host",
    } as never)
    expect(visible.lastTerminalReason).toBe("unsupported-on-host")
  })
})

describe("describeTrigger", () => {
  it("reads as something a person can check", () => {
    expect(describeTrigger({ type: "cron", cronExpression: "0 9 * * *" })).toBe("cron 0 9 * * *")
    expect(describeTrigger({ type: "interval", intervalMs: 90_000 })).toBe("every 1 min 30 s")
    expect(describeTrigger({ type: "interval", intervalMs: 3_600_000 })).toBe("every 1 h")
    expect(describeTrigger({ type: "once", runAt: "2026-09-05T09:00:00Z" })).toContain("once at")
    expect(describeTrigger({ type: "event", eventType: "chat:completed" })).toBe(
      "on event chat:completed"
    )
  })

  it("shows a one-off time on the local clock with its zone, not as GMT", () => {
    const runAt = "2026-09-26T01:00:00Z"
    const text = describeTrigger({ type: "once", runAt })
    expect(text).not.toContain(new Date(runAt).toUTCString())
    expect(text).toBe(
      `once at ${new Date(runAt).toLocaleString("en-US", {
        weekday: "short",
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "short",
      })}`
    )
    expect(describeTrigger({ type: "once", runAt: "not a date" })).toBe("once at not a date")
  })
})

describe("assertAgentTaskPayload", () => {
  it("accepts the documented shape for every agent-schedulable type", async () => {
    const good: Record<string, Record<string, unknown>> = {
      chat: { prompt: "hi" },
      agent: { prompt: "hi", characterId: "c1" },
      skill: { prompt: "hi", skillId: "s1" },
      "external-agent": { prompt: "hi", agentId: "a1" },
      goal: { objective: "ship it" },
      plan: { planId: "p1" },
      "agent-team": { teamId: "t1" },
      workflow: { workflowId: "w1" },
      "im-push": { conversationKey: "lark:1:oc", text: "hello" },
      "background-command": { command: "pnpm build", cwd: "/repo" },
      backup: {},
    }
    for (const type of AGENT_SCHEDULABLE_TASK_TYPES) {
      await expect(assertAgentTaskPayload(type, good[type])).resolves.toBeUndefined()
    }
  })

  it("names the missing key, mirroring the executor that would fail", async () => {
    await expect(assertAgentTaskPayload("chat", {})).rejects.toThrow(/prompt/)
    await expect(assertAgentTaskPayload("agent", { prompt: "hi" })).rejects.toThrow(/characterId/)
    await expect(assertAgentTaskPayload("skill", { prompt: "hi" })).rejects.toThrow(/skillId/)
    await expect(assertAgentTaskPayload("goal", { objective: "  " })).rejects.toThrow(/objective/)
    await expect(assertAgentTaskPayload("plan", {})).rejects.toThrow(/planId/)
    await expect(assertAgentTaskPayload("agent-team", {})).rejects.toThrow(/teamId/)
    await expect(assertAgentTaskPayload("background-command", { command: "ls" })).rejects.toThrow(
      /cwd/
    )
  })

  it("accepts an im-push with segments instead of text, and refuses one with neither", async () => {
    await expect(
      assertAgentTaskPayload("im-push", {
        conversationKey: "k",
        segments: [{ type: "text", text: "hi" }],
      })
    ).resolves.toBeUndefined()
    await expect(assertAgentTaskPayload("im-push", { conversationKey: "k" })).rejects.toThrow(
      /text/
    )
  })
})

describe("assertAgentTaskTrigger", () => {
  const now = new Date("2026-09-25T00:00:00Z")

  it("accepts every valid shape", async () => {
    await expect(
      assertAgentTaskTrigger(
        { type: "cron", cronExpression: "0 9 * * 1-5", timezone: "Asia/Shanghai" },
        now
      )
    ).resolves.toBeUndefined()
    await expect(
      assertAgentTaskTrigger({ type: "interval", intervalMs: 60_000 }, now)
    ).resolves.toBeUndefined()
    await expect(
      assertAgentTaskTrigger({ type: "once", runAt: "2026-09-26T09:00:00Z" }, now)
    ).resolves.toBeUndefined()
    await expect(
      assertAgentTaskTrigger({ type: "event", eventType: "chat:completed" }, now)
    ).resolves.toBeUndefined()
  })

  it("rejects what the scheduler would reject", async () => {
    await expect(
      assertAgentTaskTrigger({ type: "cron", cronExpression: "nope" }, now)
    ).rejects.toThrow()
    await expect(
      assertAgentTaskTrigger(
        { type: "cron", cronExpression: "0 9 * * *", timezone: "Mars/Olympus" },
        now
      )
    ).rejects.toThrow()
    await expect(
      assertAgentTaskTrigger({ type: "once", runAt: "2026-09-24T09:00:00Z" }, now)
    ).rejects.toThrow(/future/)
  })
})

describe("formatDuration", () => {
  it("reads the way a person says it", () => {
    expect(formatDuration(45_000)).toBe("45 s")
    expect(formatDuration(30 * 60_000)).toBe("30 min")
    expect(formatDuration(90 * 60_000)).toBe("1 h 30 min")
    expect(formatDuration(24 * 3_600_000)).toBe("24 h")
  })
})

describe("toAgentVisibleTask · workspace and description", () => {
  it("carries the description and owning workspace when the task has them", () => {
    const visible = toAgentVisibleTask({
      id: "t",
      name: "n",
      description: "why it exists",
      projectId: "proj-1",
      type: "chat",
      status: "active",
      trigger: { type: "interval", intervalMs: 60_000 },
      runCount: 0,
      successCount: 0,
      failureCount: 0,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    } as never)
    expect(visible).toMatchObject({ description: "why it exists", projectId: "proj-1" })
  })
})

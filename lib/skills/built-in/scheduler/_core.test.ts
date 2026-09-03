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
  describeTrigger,
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
    expect(describeTrigger({ type: "interval", intervalMs: 90_000 })).toBe("every 90s")
    expect(describeTrigger({ type: "once", runAt: "2026-09-05T09:00:00Z" })).toContain("once at")
    expect(describeTrigger({ type: "event", eventType: "chat:completed" })).toBe(
      "on event chat:completed"
    )
  })
})

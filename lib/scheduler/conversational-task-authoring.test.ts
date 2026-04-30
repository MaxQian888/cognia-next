import {
  createScheduledAgentTaskDraft,
  createScheduledChatTaskDraft,
  normalizeConversationalTaskPayload,
} from "./conversational-task-authoring"
import { SchedulerError } from "./errors"

describe("conversational-task-authoring", () => {
  describe("createScheduledChatTaskDraft", () => {
    it("builds a scheduled chat draft with session binding and defaults", () => {
      const draft = createScheduledChatTaskDraft(
        {
          message: "每天早上提醒我查看重点任务",
          sessionId: "session-1",
        },
        {
          timezone: "Asia/Shanghai",
          provider: "openai",
          model: "gpt-4o",
        }
      )

      expect(draft.input.type).toBe("chat")
      expect(draft.input.trigger).toEqual({
        type: "cron",
        cronExpression: "0 9 * * *",
        timezone: "Asia/Shanghai",
      })
      expect(draft.input.payload).toEqual(
        expect.objectContaining({
          message: "每天早上提醒我查看重点任务",
          sessionId: "session-1",
          autoReply: true,
          provider: "openai",
          model: "gpt-4o",
        })
      )
      expect(draft.summary).toContain("每天早上提醒我查看重点任务")
    })
  })

  describe("createScheduledAgentTaskDraft", () => {
    it("builds a scheduled agent draft with provider/model defaults", () => {
      const draft = createScheduledAgentTaskDraft(
        {
          agentTask: "每周一总结上周项目进展并给出风险提示",
        },
        {
          timezone: "UTC",
          provider: "anthropic",
          model: "claude-3-5-sonnet",
        }
      )

      expect(draft.input.type).toBe("agent")
      expect(draft.input.trigger).toEqual({
        type: "cron",
        cronExpression: "0 9 * * *",
        timezone: "UTC",
      })
      expect(draft.input.payload).toEqual(
        expect.objectContaining({
          agentTask: "每周一总结上周项目进展并给出风险提示",
          config: expect.objectContaining({
            provider: "anthropic",
            model: "claude-3-5-sonnet",
            planningEnabled: true,
            maxSteps: 10,
          }),
        })
      )
      expect(draft.summary).toContain("每周一总结上周项目进展并给出风险提示")
    })

    it("uses caller-provided maxSteps and planningEnabled overrides", () => {
      const draft = createScheduledAgentTaskDraft({
        agentTask: "Generate report",
        maxSteps: 25,
        planningEnabled: false,
      })

      const config = (draft.input.payload as Record<string, unknown>).config as Record<
        string,
        unknown
      >
      expect(config.maxSteps).toBe(25)
      expect(config.planningEnabled).toBe(false)
    })

    it("honors explicit name override when provided", () => {
      const draft = createScheduledAgentTaskDraft({
        agentTask: "Long agent prompt",
        name: "My Custom Name",
      })

      expect(draft.input.name).toBe("My Custom Name")
    })

    it("truncates long names when no explicit name provided", () => {
      const longTask = "a".repeat(100)
      const draft = createScheduledAgentTaskDraft({ agentTask: longTask })
      expect(draft.input.name).toMatch(/^Scheduled Agent: a+\.\.\.$/)
      expect(draft.input.name.length).toBeLessThanOrEqual(80)
    })
  })

  describe("createScheduledChatTaskDraft trigger variations", () => {
    it("returns an interval trigger when caller specifies interval", () => {
      const draft = createScheduledChatTaskDraft({
        message: "Run every minute",
        trigger: { type: "interval", intervalMs: 60_000, dependsOn: ["task-a"] },
      })

      expect(draft.input.trigger).toEqual({
        type: "interval",
        intervalMs: 60_000,
        dependsOn: ["task-a"],
      })
    })

    it("returns a once trigger when caller specifies once", () => {
      const runAt = new Date(Date.now() + 60_000)
      const draft = createScheduledChatTaskDraft({
        message: "Run once",
        trigger: { type: "once", runAt, dependsOn: ["x"] },
      })

      expect(draft.input.trigger).toEqual({
        type: "once",
        runAt,
        dependsOn: ["x"],
      })
    })

    it("returns an event trigger when caller specifies event", () => {
      const draft = createScheduledChatTaskDraft({
        message: "On event",
        trigger: {
          type: "event",
          eventType: "workflow:completed",
          eventSource: "system",
          dependsOn: ["y"],
        },
      })

      expect(draft.input.trigger).toEqual({
        type: "event",
        eventType: "workflow:completed",
        eventSource: "system",
        dependsOn: ["y"],
      })
    })

    it("falls back to default cron when overridden cron expression is whitespace", () => {
      const draft = createScheduledChatTaskDraft(
        {
          message: "hello",
          trigger: { type: "cron", cronExpression: "   " },
        },
        { timezone: "UTC" }
      )
      expect(draft.input.trigger).toEqual({
        type: "cron",
        cronExpression: "0 9 * * *",
        timezone: "UTC",
      })
    })

    it("respects explicit autoReply=false override", () => {
      const draft = createScheduledChatTaskDraft({
        message: "silent",
        autoReply: false,
      })
      const payload = draft.input.payload as Record<string, unknown>
      expect(payload.autoReply).toBe(false)
    })
  })

  describe("normalizeConversationalTaskPayload", () => {
    it("returns undefined for non-conversational task without payload", () => {
      const result = normalizeConversationalTaskPayload("script", undefined)
      expect(result).toBeUndefined()
    })

    it("throws when chat task has no payload", () => {
      expect(() => normalizeConversationalTaskPayload("chat", undefined)).toThrow(SchedulerError)
      expect(() => normalizeConversationalTaskPayload("chat", undefined)).toThrow(/message/)
    })

    it("throws when agent task has no payload", () => {
      expect(() => normalizeConversationalTaskPayload("agent", undefined)).toThrow(SchedulerError)
      expect(() => normalizeConversationalTaskPayload("agent", undefined)).toThrow(/agent/)
    })

    it("throws when payload is non-object primitive", () => {
      expect(() =>
        normalizeConversationalTaskPayload(
          "chat",
          "plain string" as unknown as Record<string, unknown>
        )
      ).toThrow(/object/)
    })

    it("returns payload as-is for non-conversational tasks (script)", () => {
      const result = normalizeConversationalTaskPayload("script", {
        code: "console.log(1)",
      } as Record<string, unknown>)
      expect(result).toEqual({ code: "console.log(1)" })
    })

    it("throws when chat payload message is whitespace", () => {
      expect(() =>
        normalizeConversationalTaskPayload("chat", { message: "   " } as Record<string, unknown>)
      ).toThrow(/message/)
    })

    it("normalizes valid chat payload and applies defaults", () => {
      const result = normalizeConversationalTaskPayload("chat", {
        message: " hello ",
        autoReply: false,
        sessionId: "s1",
        provider: "p",
        model: "m",
      } as Record<string, unknown>) as Record<string, unknown>

      expect(result.message).toBe("hello")
      expect(result.autoReply).toBe(false)
      expect(result.sessionId).toBe("s1")
      expect(result.provider).toBe("p")
      expect(result.model).toBe("m")
    })

    it("defaults autoReply to true when missing from chat payload", () => {
      const result = normalizeConversationalTaskPayload("chat", { message: "hi" } as Record<
        string,
        unknown
      >) as Record<string, unknown>
      expect(result.autoReply).toBe(true)
    })

    it("throws when agent payload has whitespace agentTask", () => {
      expect(() =>
        normalizeConversationalTaskPayload("agent", { agentTask: "  " } as Record<string, unknown>)
      ).toThrow(/agent/)
    })

    it("normalizes agent payload, flooring maxSteps and applying defaults", () => {
      const result = normalizeConversationalTaskPayload("agent", {
        agentTask: "  Plan trip  ",
        config: { maxSteps: 7.9, planningEnabled: false, provider: "anthropic" },
      } as Record<string, unknown>) as Record<string, unknown>

      expect(result.agentTask).toBe("Plan trip")
      const config = result.config as Record<string, unknown>
      expect(config.maxSteps).toBe(7)
      expect(config.planningEnabled).toBe(false)
      expect(config.provider).toBe("anthropic")
    })

    it("uses default maxSteps when value is invalid", () => {
      const result = normalizeConversationalTaskPayload("agent", {
        agentTask: "do thing",
        config: { maxSteps: -3 },
      } as Record<string, unknown>) as Record<string, unknown>
      const config = result.config as Record<string, unknown>
      expect(config.maxSteps).toBe(10)
    })

    it("handles missing config object on agent payload", () => {
      const result = normalizeConversationalTaskPayload("agent", {
        agentTask: "do",
        config: "not-an-object",
      } as unknown as Record<string, unknown>) as Record<string, unknown>
      const config = result.config as Record<string, unknown>
      expect(config.maxSteps).toBe(10)
      expect(config.planningEnabled).toBe(true)
    })
  })
})

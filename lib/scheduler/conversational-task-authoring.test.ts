import {
  createScheduledAgentTaskDraft,
  createScheduledChatTaskDraft,
  createScheduledExternalAgentTaskDraft,
  createScheduledSkillTaskDraft,
  normalizeConversationalTaskPayload,
} from "./conversational-task-authoring"
import { SchedulerError } from "./errors"

describe("conversational-task-authoring", () => {
  // =========================================================================
  // createScheduledChatTaskDraft
  // =========================================================================

  describe("createScheduledChatTaskDraft", () => {
    it("builds a scheduled chat draft with session binding and defaults (using `message` legacy alias)", () => {
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
      // Canonical field is now `prompt`, not `message`.
      expect(draft.input.payload).toEqual(
        expect.objectContaining({
          prompt: "每天早上提醒我查看重点任务",
          sessionId: "session-1",
          autoReply: true,
          provider: "openai",
          model: "gpt-4o",
        })
      )
      expect(draft.summary).toContain("每天早上提醒我查看重点任务")
    })

    it("accepts the new canonical `prompt` field directly", () => {
      const draft = createScheduledChatTaskDraft({ prompt: "hello world" })
      expect(draft.input.payload).toMatchObject({ prompt: "hello world" })
    })

    it("throws when neither prompt nor message is provided", () => {
      expect(() => createScheduledChatTaskDraft({})).toThrow(SchedulerError)
    })

    it("forwards chat-like overrides (allowedTools, mcpServerIds, builtinTools, etc.) into the payload", () => {
      const draft = createScheduledChatTaskDraft({
        prompt: "hi",
        allowedTools: ["Read", "Bash"],
        mcpServerIds: ["mcp-a"],
        builtinTools: { git: false },
        permissionMode: "acceptEdits",
        agentModeId: "code-gen",
        teamId: "team-1",
        additionalDirectories: ["/repo"],
        appendSystemPrompt: "extra context",
        maxTurns: 12,
        effort: "high",
        disabledSkillIds: ["s1"],
      })
      const p = draft.input.payload as Record<string, unknown>
      expect(p).toMatchObject({
        prompt: "hi",
        allowedTools: ["Read", "Bash"],
        mcpServerIds: ["mcp-a"],
        builtinTools: { git: false },
        permissionMode: "acceptEdits",
        agentModeId: "code-gen",
        teamId: "team-1",
        additionalDirectories: ["/repo"],
        appendSystemPrompt: "extra context",
        maxTurns: 12,
        effort: "high",
        disabledSkillIds: ["s1"],
      })
    })
  })

  // =========================================================================
  // createScheduledAgentTaskDraft
  // =========================================================================

  describe("createScheduledAgentTaskDraft", () => {
    it("builds a scheduled agent draft with provider/model defaults (using legacy `agentTask` alias)", () => {
      const draft = createScheduledAgentTaskDraft(
        {
          agentTask: "每周一总结上周项目进展并给出风险提示",
          characterId: "char-1",
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
      const payload = draft.input.payload as Record<string, unknown>
      // Canonical field is now `prompt`; provider/model live at the top level
      // and `maxTurns` replaces the legacy nested config.maxSteps.
      expect(payload).toEqual(
        expect.objectContaining({
          prompt: "每周一总结上周项目进展并给出风险提示",
          characterId: "char-1",
          provider: "anthropic",
          model: "claude-3-5-sonnet",
          planningEnabled: true,
          maxTurns: 10,
        })
      )
      expect(draft.summary).toContain("每周一总结上周项目进展并给出风险提示")
    })

    it("accepts the canonical `prompt` field and a characterId", () => {
      const draft = createScheduledAgentTaskDraft({
        prompt: "do work",
        characterId: "c",
      })
      const payload = draft.input.payload as Record<string, unknown>
      expect(payload).toMatchObject({ prompt: "do work", characterId: "c" })
    })

    it("uses caller-provided maxSteps and planningEnabled overrides (mapped to maxTurns)", () => {
      const draft = createScheduledAgentTaskDraft({
        agentTask: "Generate report",
        maxSteps: 25,
        planningEnabled: false,
      })

      const payload = draft.input.payload as Record<string, unknown>
      expect(payload.maxTurns).toBe(25)
      expect(payload.planningEnabled).toBe(false)
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

    it("emits a draft without characterId when caller doesn't supply one (intent-classifier path)", () => {
      const draft = createScheduledAgentTaskDraft({ agentTask: "later" })
      const payload = draft.input.payload as Record<string, unknown>
      expect(payload.characterId).toBeUndefined()
    })

    it("throws when no prompt is supplied", () => {
      expect(() =>
        createScheduledAgentTaskDraft({ characterId: "c" } as unknown as {
          characterId: string
          agentTask?: string
        })
      ).toThrow(SchedulerError)
    })
  })

  // =========================================================================
  // createScheduledSkillTaskDraft
  // =========================================================================

  describe("createScheduledSkillTaskDraft", () => {
    it("builds a typed skill draft", () => {
      const draft = createScheduledSkillTaskDraft({
        prompt: "Use the planner",
        skillId: "skill-plan",
      })
      expect(draft.input.type).toBe("skill")
      expect(draft.input.payload).toMatchObject({
        prompt: "Use the planner",
        skillId: "skill-plan",
      })
    })

    it("throws without prompt", () => {
      expect(() =>
        createScheduledSkillTaskDraft({ skillId: "s" } as unknown as {
          prompt: string
          skillId: string
        })
      ).toThrow(SchedulerError)
    })

    it("throws without skillId", () => {
      expect(() =>
        createScheduledSkillTaskDraft({ prompt: "p" } as unknown as {
          prompt: string
          skillId: string
        })
      ).toThrow(SchedulerError)
    })
  })

  // =========================================================================
  // createScheduledExternalAgentTaskDraft
  // =========================================================================

  describe("createScheduledExternalAgentTaskDraft", () => {
    it("builds a typed external-agent draft", () => {
      const draft = createScheduledExternalAgentTaskDraft({
        prompt: "Open Cursor and tidy",
        agentId: "cursor",
        permissionMode: "acceptEdits",
        cwd: "/repo",
        timeoutMs: 60_000,
      })
      expect(draft.input.type).toBe("external-agent")
      expect(draft.input.payload).toEqual({
        prompt: "Open Cursor and tidy",
        agentId: "cursor",
        permissionMode: "acceptEdits",
        cwd: "/repo",
        timeoutMs: 60_000,
      })
    })

    it("drops empty optional fields", () => {
      const draft = createScheduledExternalAgentTaskDraft({
        prompt: "p",
        agentId: "a",
      })
      expect(draft.input.payload).toEqual({ prompt: "p", agentId: "a" })
    })

    it("throws without prompt", () => {
      expect(() =>
        createScheduledExternalAgentTaskDraft({ agentId: "a" } as unknown as {
          prompt: string
          agentId: string
        })
      ).toThrow(SchedulerError)
    })

    it("throws without agentId", () => {
      expect(() =>
        createScheduledExternalAgentTaskDraft({ prompt: "p" } as unknown as {
          prompt: string
          agentId: string
        })
      ).toThrow(SchedulerError)
    })
  })

  // =========================================================================
  // Trigger variations
  // =========================================================================

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

  // =========================================================================
  // normalizeConversationalTaskPayload
  // =========================================================================

  describe("normalizeConversationalTaskPayload", () => {
    it("returns undefined for non-conversational task without payload", () => {
      const result = normalizeConversationalTaskPayload("script", undefined)
      expect(result).toBeUndefined()
    })

    it("throws when chat task has no payload", () => {
      expect(() => normalizeConversationalTaskPayload("chat", undefined)).toThrow(SchedulerError)
      expect(() => normalizeConversationalTaskPayload("chat", undefined)).toThrow(/prompt/)
    })

    it("throws when agent task has no payload", () => {
      expect(() => normalizeConversationalTaskPayload("agent", undefined)).toThrow(SchedulerError)
      expect(() => normalizeConversationalTaskPayload("agent", undefined)).toThrow(/prompt/)
    })

    it("throws when skill task has no payload", () => {
      expect(() => normalizeConversationalTaskPayload("skill", undefined)).toThrow(SchedulerError)
    })

    it("throws when external-agent task has no payload", () => {
      expect(() => normalizeConversationalTaskPayload("external-agent", undefined)).toThrow(
        SchedulerError
      )
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

    it("throws when chat payload prompt is whitespace", () => {
      expect(() =>
        normalizeConversationalTaskPayload("chat", { prompt: "   " } as Record<string, unknown>)
      ).toThrow(/prompt/)
    })

    it("rewrites legacy chat payload `message` to `prompt`", () => {
      const result = normalizeConversationalTaskPayload(
        "chat",
        {
          message: " hello ",
          autoReply: false,
          sessionId: "s1",
          provider: "p",
          model: "m",
        } as Record<string, unknown>,
        "warn-1"
      ) as Record<string, unknown>

      expect(result.prompt).toBe("hello")
      expect(result.message).toBeUndefined()
      expect(result.autoReply).toBe(false)
      expect(result.sessionId).toBe("s1")
      expect(result.provider).toBe("p")
      expect(result.model).toBe("m")
    })

    it("defaults autoReply to true when missing from chat payload", () => {
      const result = normalizeConversationalTaskPayload("chat", {
        prompt: "hi",
      } as Record<string, unknown>) as Record<string, unknown>
      expect(result.autoReply).toBe(true)
    })

    it("rewrites legacy agent payload `agentTask` to `prompt`", () => {
      const result = normalizeConversationalTaskPayload(
        "agent",
        {
          agentTask: "  Plan trip  ",
          config: { maxSteps: 7.9, planningEnabled: false, provider: "anthropic" },
        } as Record<string, unknown>,
        "warn-2"
      ) as Record<string, unknown>

      expect(result.prompt).toBe("Plan trip")
      expect(result.agentTask).toBeUndefined()
      // Legacy nested config gets hoisted out.
      expect(result.config).toBeUndefined()
      expect(result.maxTurns).toBe(7)
      expect(result.planningEnabled).toBe(false)
      expect(result.provider).toBe("anthropic")
    })

    it("uses default maxTurns when value is invalid", () => {
      const result = normalizeConversationalTaskPayload("agent", {
        prompt: "do thing",
        config: { maxSteps: -3 },
      } as Record<string, unknown>) as Record<string, unknown>
      expect(result.maxTurns).toBe(10)
    })

    it("handles missing config object on agent payload", () => {
      const result = normalizeConversationalTaskPayload("agent", {
        prompt: "do",
        config: "not-an-object",
      } as unknown as Record<string, unknown>) as Record<string, unknown>
      expect(result.maxTurns).toBe(10)
      expect(result.planningEnabled).toBe(true)
    })

    it("normalizes a skill payload (validates skillId and prompt)", () => {
      const result = normalizeConversationalTaskPayload("skill", {
        prompt: "hi",
        skillId: "s1",
      } as Record<string, unknown>) as Record<string, unknown>
      expect(result).toMatchObject({ prompt: "hi", skillId: "s1" })
    })

    it("rejects skill payload missing skillId", () => {
      expect(() =>
        normalizeConversationalTaskPayload("skill", { prompt: "hi" } as Record<string, unknown>)
      ).toThrow(/skillId/)
    })

    it("normalizes an external-agent payload", () => {
      const result = normalizeConversationalTaskPayload("external-agent", {
        prompt: "hi",
        agentId: "a",
        cwd: "/tmp",
      } as Record<string, unknown>) as Record<string, unknown>
      expect(result).toMatchObject({ prompt: "hi", agentId: "a", cwd: "/tmp" })
    })

    it("rejects external-agent payload missing agentId", () => {
      expect(() =>
        normalizeConversationalTaskPayload("external-agent", { prompt: "hi" } as Record<
          string,
          unknown
        >)
      ).toThrow(/agentId/)
    })
  })
})

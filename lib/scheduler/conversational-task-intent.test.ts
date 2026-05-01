import { detectConversationalSchedulerDraft } from "./conversational-task-intent"

describe("conversational-task-intent", () => {
  it("detects scheduled chat creation requests in chat mode", () => {
    const draft = detectConversationalSchedulerDraft("每天早上9点提醒我整理今日待办", {
      mode: "chat",
      sessionId: "session-1",
      timezone: "Asia/Shanghai",
      provider: "openai",
      model: "gpt-4o",
    })

    expect(draft).not.toBeNull()
    expect(draft?.input.type).toBe("chat")
    expect(draft?.input.payload).toEqual(
      expect.objectContaining({
        sessionId: "session-1",
      })
    )
  })

  it("detects scheduled agent creation requests in agent mode", () => {
    const draft = detectConversationalSchedulerDraft("每周一运行 agent 总结上周项目风险", {
      mode: "agent",
      sessionId: "session-1",
      timezone: "UTC",
      provider: "anthropic",
      model: "claude-3-5-sonnet",
    })

    expect(draft).not.toBeNull()
    expect(draft?.input.type).toBe("agent")
    expect(draft?.input.payload).toEqual(
      expect.objectContaining({
        prompt: "每周一运行 agent 总结上周项目风险",
      })
    )
  })

  it("ignores general chat requests without scheduling intent", () => {
    const draft = detectConversationalSchedulerDraft("帮我解释一下这个报错是什么意思", {
      mode: "chat",
      sessionId: "session-1",
    })

    expect(draft).toBeNull()
  })

  it("ignores casual time mentions without scheduling action intent", () => {
    const draft = detectConversationalSchedulerDraft("我们 3pm 继续看这个报错，先别建任务", {
      mode: "chat",
      sessionId: "session-1",
    })

    expect(draft).toBeNull()
  })

  it("keeps reminder-style requests as chat drafts even in agent mode", () => {
    const draft = detectConversationalSchedulerDraft("明早9点提醒我发邮件给客户", {
      mode: "agent",
      sessionId: "session-1",
      timezone: "Asia/Shanghai",
      provider: "openai",
      model: "gpt-4o",
    })

    expect(draft).not.toBeNull()
    expect(draft?.input.type).toBe("chat")
    expect(draft?.input.payload).toEqual(
      expect.objectContaining({
        prompt: "明早9点提醒我发邮件给客户",
        sessionId: "session-1",
      })
    )
  })

  it("falls through to the agent branch when both chat and agent hints fire", () => {
    // 提醒 + 消息 (chat hints) AND agent (agent hint) → both intents true →
    // falls past the chat-only and agent-only branches to the explicitAgentIntent
    // fallback (line 82).
    const draft = detectConversationalSchedulerDraft("每天提醒 agent 发送一条状态消息", {
      mode: "chat",
      sessionId: "session-1",
    })
    expect(draft).not.toBeNull()
    expect(draft?.input.type).toBe("agent")
  })

  it("uses agent draft when mode is 'agent' and no explicit hint is present", () => {
    // 每天 (scheduler intent) with no chat or agent keywords → mode === "agent"
    // branch fires (line 91).
    const draft = detectConversationalSchedulerDraft("每天分析昨天的运营数据", {
      mode: "agent",
      sessionId: "session-1",
    })
    expect(draft).not.toBeNull()
    expect(draft?.input.type).toBe("agent")
  })

  it("falls back to a chat draft when mode is non-agent and no hints fire", () => {
    // 每天 (scheduler intent) with no chat or agent keywords + non-agent mode →
    // default chat draft branch (line 100).
    const draft = detectConversationalSchedulerDraft("每天分析昨天的运营数据", {
      mode: "research",
      sessionId: "session-1",
    })
    expect(draft).not.toBeNull()
    expect(draft?.input.type).toBe("chat")
  })
})

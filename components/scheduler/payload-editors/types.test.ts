/**
 * Tests for the draft <-> payload conversion helpers used by the structured
 * task-payload editors.
 */

import {
  EMPTY_CHAT_LIKE_DRAFT,
  EMPTY_EXTERNAL_AGENT_DRAFT,
  payloadToChatLikeDraft,
  payloadToExternalAgentDraft,
  chatLikeDraftToPayload,
  externalAgentDraftToPayload,
  isChatLikeTaskType,
  isStructuredEditableTaskType,
  DraftValidationError,
  type ChatLikeDraft,
} from "./types"

describe("payloadToChatLikeDraft", () => {
  it("returns the empty draft on null/undefined/non-object input", () => {
    expect(payloadToChatLikeDraft("chat", undefined)).toEqual(EMPTY_CHAT_LIKE_DRAFT)
    expect(payloadToChatLikeDraft("chat", null)).toEqual(EMPTY_CHAT_LIKE_DRAFT)
    expect(payloadToChatLikeDraft("chat", "string")).toEqual(EMPTY_CHAT_LIKE_DRAFT)
    expect(payloadToChatLikeDraft("chat", [1, 2, 3])).toEqual(EMPTY_CHAT_LIKE_DRAFT)
  })

  it("lifts canonical prompt", () => {
    const d = payloadToChatLikeDraft("chat", { prompt: "hi" })
    expect(d.prompt).toBe("hi")
  })

  it("falls back to legacy `message` for chat", () => {
    const d = payloadToChatLikeDraft("chat", { message: "old" })
    expect(d.prompt).toBe("old")
  })

  it("falls back to legacy `agentTask` for agent", () => {
    const d = payloadToChatLikeDraft("agent", { agentTask: "old" })
    expect(d.prompt).toBe("old")
  })

  it("hoists tool / mcp / additional / disabled fields", () => {
    const d = payloadToChatLikeDraft("chat", {
      prompt: "p",
      allowedTools: ["Read", 42, "Write"],
      disallowedTools: ["X"],
      mcpServerIds: ["m1", "m2"],
      additionalDirectories: ["/a", null, "/b"],
      disabledSkillIds: ["s1"],
    })
    expect(d.allowedTools).toEqual(["Read", "Write"])
    expect(d.disallowedTools).toEqual(["X"])
    expect(d.mcpServerIds).toEqual(["m1", "m2"])
    expect(d.mcpMode).toBe("custom")
    expect(d.additionalDirectories).toEqual(["/a", "/b"])
    expect(d.disabledSkillIds).toEqual(["s1"])
  })

  it("filters builtinTools to known keys with boolean values", () => {
    const d = payloadToChatLikeDraft("chat", {
      prompt: "p",
      builtinTools: { git: false, fileExtras: true, garbage: "x" },
    })
    expect(d.builtinTools).toEqual({ git: false, fileExtras: true })
  })

  it("ignores builtinTools when the partial is empty", () => {
    const d = payloadToChatLikeDraft("chat", {
      prompt: "p",
      builtinTools: {},
    })
    expect(d.builtinTools).toBeUndefined()
  })

  it("preserves agentModeId null vs string vs undefined", () => {
    expect(payloadToChatLikeDraft("chat", { prompt: "p", agentModeId: null }).agentModeId).toBe(
      null
    )
    expect(
      payloadToChatLikeDraft("chat", { prompt: "p", agentModeId: "general" }).agentModeId
    ).toBe("general")
    expect(payloadToChatLikeDraft("chat", { prompt: "p" }).agentModeId).toBeUndefined()
  })

  it("only keeps positive maxTurns", () => {
    expect(payloadToChatLikeDraft("chat", { prompt: "p", maxTurns: 5 }).maxTurns).toBe(5)
    expect(payloadToChatLikeDraft("chat", { prompt: "p", maxTurns: 0 }).maxTurns).toBeUndefined()
    expect(payloadToChatLikeDraft("chat", { prompt: "p", maxTurns: -1 }).maxTurns).toBeUndefined()
  })

  it("hoists model / effort / appendSystemPrompt", () => {
    const d = payloadToChatLikeDraft("chat", {
      prompt: "p",
      model: "claude-x",
      effort: "high",
      appendSystemPrompt: "extra",
    })
    expect(d.model).toBe("claude-x")
    expect(d.effort).toBe("high")
    expect(d.appendSystemPrompt).toBe("extra")
  })

  it("hoists session continuity fields", () => {
    const d = payloadToChatLikeDraft("chat", {
      prompt: "p",
      sessionId: "s1",
      sessionTitle: "title",
      teamId: "team-1",
    })
    expect(d).toMatchObject({ sessionId: "s1", sessionTitle: "title", teamId: "team-1" })
  })
})

describe("payloadToExternalAgentDraft", () => {
  it("returns empty draft for non-object inputs", () => {
    expect(payloadToExternalAgentDraft(undefined)).toEqual(EMPTY_EXTERNAL_AGENT_DRAFT)
    expect(payloadToExternalAgentDraft([1])).toEqual(EMPTY_EXTERNAL_AGENT_DRAFT)
  })

  it("hoists prompt / agentId / permissionMode / cwd / timeoutMs", () => {
    const d = payloadToExternalAgentDraft({
      prompt: "p",
      agentId: "a",
      permissionMode: "acceptEdits",
      cwd: "/tmp",
      timeoutMs: 1000,
    })
    expect(d).toEqual({
      prompt: "p",
      agentId: "a",
      permissionMode: "acceptEdits",
      cwd: "/tmp",
      timeoutMs: 1000,
    })
  })

  it("ignores zero / negative timeoutMs", () => {
    expect(payloadToExternalAgentDraft({ timeoutMs: 0 }).timeoutMs).toBeUndefined()
    expect(payloadToExternalAgentDraft({ timeoutMs: -1 }).timeoutMs).toBeUndefined()
  })
})

describe("chatLikeDraftToPayload", () => {
  function base(): ChatLikeDraft {
    return { prompt: "hi", mcpMode: "default" }
  }

  it("requires prompt for chat", () => {
    const draft: ChatLikeDraft = { prompt: "  ", mcpMode: "default" }
    let caught: DraftValidationError | undefined
    try {
      chatLikeDraftToPayload("chat", draft)
    } catch (e) {
      caught = e as DraftValidationError
    }
    expect(caught).toBeInstanceOf(DraftValidationError)
    expect(caught?.errors.prompt).toBe("promptRequired")
  })

  it("requires characterId for agent", () => {
    let caught: DraftValidationError | undefined
    try {
      chatLikeDraftToPayload("agent", base())
    } catch (e) {
      caught = e as DraftValidationError
    }
    expect(caught?.errors.characterId).toBe("characterIdRequired")
  })

  it("requires skillId for skill", () => {
    let caught: DraftValidationError | undefined
    try {
      chatLikeDraftToPayload("skill", base())
    } catch (e) {
      caught = e as DraftValidationError
    }
    expect(caught?.errors.skillId).toBe("skillIdRequired")
  })

  it("emits a chat payload", () => {
    const out = chatLikeDraftToPayload("chat", {
      ...base(),
      model: "m",
      allowedTools: ["Read"],
      mcpMode: "custom",
      mcpServerIds: ["a"],
      builtinTools: { git: false },
      permissionMode: "plan",
      additionalDirectories: ["/a"],
      disabledSkillIds: ["s1"],
      appendSystemPrompt: "extra",
      maxTurns: 5,
      effort: "high",
      teamId: "team-1",
      sessionId: "s",
      sessionTitle: "t",
    })
    expect(out).toMatchObject({
      prompt: "hi",
      model: "m",
      allowedTools: ["Read"],
      mcpServerIds: ["a"],
      builtinTools: { git: false },
      permissionMode: "plan",
      additionalDirectories: ["/a"],
      disabledSkillIds: ["s1"],
      appendSystemPrompt: "extra",
      maxTurns: 5,
      effort: "high",
      teamId: "team-1",
      sessionId: "s",
      sessionTitle: "t",
    })
  })

  it("strips empty optional fields and trims strings", () => {
    const out = chatLikeDraftToPayload("chat", {
      ...base(),
      prompt: "  hi  ",
      model: "  ",
      sessionId: "  ",
      sessionTitle: "  ",
      teamId: "  ",
      allowedTools: [],
      additionalDirectories: [],
      builtinTools: {},
    }) as Record<string, unknown>
    expect(out.prompt).toBe("hi")
    expect(out.model).toBeUndefined()
    expect(out.sessionId).toBeUndefined()
    expect(out.sessionTitle).toBeUndefined()
    expect(out.teamId).toBeUndefined()
    expect(out.allowedTools).toBeUndefined()
    expect(out.additionalDirectories).toBeUndefined()
    expect(out.builtinTools).toBeUndefined()
  })

  it("emits agentModeId null vs string vs undefined correctly", () => {
    expect(
      (chatLikeDraftToPayload("chat", { ...base(), agentModeId: null }) as Record<string, unknown>)
        .agentModeId
    ).toBe(null)
    expect(
      (
        chatLikeDraftToPayload("chat", { ...base(), agentModeId: "general" }) as Record<
          string,
          unknown
        >
      ).agentModeId
    ).toBe("general")
    expect(
      (chatLikeDraftToPayload("chat", { ...base() }) as Record<string, unknown>).agentModeId
    ).toBeUndefined()
  })

  it("emits an empty mcpServerIds array when mode='custom' and no servers picked", () => {
    const out = chatLikeDraftToPayload("chat", { ...base(), mcpMode: "custom" }) as Record<
      string,
      unknown
    >
    expect(out.mcpServerIds).toEqual([])
  })

  it("omits mcpServerIds when mode='default'", () => {
    const out = chatLikeDraftToPayload("chat", {
      ...base(),
      mcpMode: "default",
      mcpServerIds: ["x"],
    }) as Record<string, unknown>
    expect(out.mcpServerIds).toBeUndefined()
  })

  it("emits an agent payload with characterId", () => {
    const out = chatLikeDraftToPayload("agent", { ...base(), characterId: "c" })
    expect(out).toMatchObject({ prompt: "hi", characterId: "c" })
  })

  it("emits a skill payload with skillId (and characterId when present)", () => {
    const out = chatLikeDraftToPayload("skill", {
      ...base(),
      skillId: "s",
      characterId: "c",
    })
    expect(out).toMatchObject({ prompt: "hi", skillId: "s", characterId: "c" })
  })

  it("ignores characterId on skill when blank", () => {
    const out = chatLikeDraftToPayload("skill", {
      ...base(),
      skillId: "s",
      characterId: "  ",
    })
    expect(out).toMatchObject({ prompt: "hi", skillId: "s" })
    expect((out as { characterId?: unknown }).characterId).toBeUndefined()
  })
})

describe("externalAgentDraftToPayload", () => {
  it("requires prompt", () => {
    let caught: DraftValidationError | undefined
    try {
      externalAgentDraftToPayload({ prompt: "  ", agentId: "a" })
    } catch (e) {
      caught = e as DraftValidationError
    }
    expect(caught?.errors.prompt).toBe("promptRequired")
  })

  it("requires agentId", () => {
    let caught: DraftValidationError | undefined
    try {
      externalAgentDraftToPayload({ prompt: "p", agentId: "" })
    } catch (e) {
      caught = e as DraftValidationError
    }
    expect(caught?.errors.agentId).toBe("agentIdRequired")
  })

  it("emits a complete payload", () => {
    expect(
      externalAgentDraftToPayload({
        prompt: "p",
        agentId: "a",
        permissionMode: "plan",
        cwd: "/tmp",
        timeoutMs: 1000,
      })
    ).toEqual({ prompt: "p", agentId: "a", permissionMode: "plan", cwd: "/tmp", timeoutMs: 1000 })
  })

  it("strips blank cwd", () => {
    expect(
      externalAgentDraftToPayload({
        prompt: "p",
        agentId: "a",
        cwd: "  ",
      })
    ).toEqual({ prompt: "p", agentId: "a" })
  })

  it("ignores invalid timeoutMs", () => {
    expect(
      externalAgentDraftToPayload({
        prompt: "p",
        agentId: "a",
        timeoutMs: 0,
      })
    ).toEqual({ prompt: "p", agentId: "a" })
  })
})

describe("isChatLikeTaskType / isStructuredEditableTaskType", () => {
  it("recognises chat / agent / skill as chat-like", () => {
    expect(isChatLikeTaskType("chat")).toBe(true)
    expect(isChatLikeTaskType("agent")).toBe(true)
    expect(isChatLikeTaskType("skill")).toBe(true)
  })
  it("rejects non-chat-like types", () => {
    expect(isChatLikeTaskType("backup")).toBe(false)
    expect(isChatLikeTaskType("script")).toBe(false)
    expect(isChatLikeTaskType("external-agent")).toBe(false)
  })
  it("includes external-agent in the structured-editable set", () => {
    expect(isStructuredEditableTaskType("external-agent")).toBe(true)
    expect(isStructuredEditableTaskType("chat")).toBe(true)
    expect(isStructuredEditableTaskType("backup")).toBe(false)
  })
})

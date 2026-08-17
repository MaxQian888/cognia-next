import * as R from "./render"

describe("renderStatus", () => {
  it("renders every line including the provider row (W1)", () => {
    const text = R.renderStatus({
      mode: "auto",
      model: "claude-fable-5（bot 默认 / bot default）",
      provider: "anthropic",
      character: "Researcher",
      reasoning: "high",
      approvalMode: "prompt",
      team: "team_bot（bot 默认 / bot default）",
      workflow: "无 / none",
      routeSource: "路由规则 / dispatch rule",
      matchedRule: "Status route (rule-status)",
      responseAdapter: "tg-reply（路由规则 / dispatch rule）",
      enabledRules: ["1. Status route (rule-status) → team:team_bot, respond-via:tg-reply"],
      sessionTitle: "Main",
      sessionIdPrefix: "abc12345",
    })
    expect(text).toContain("mode: auto")
    expect(text).toContain("model: claude-fable-5（bot 默认 / bot default）")
    expect(text).toContain("provider: anthropic")
    expect(text).toContain("reasoning: high")
    expect(text).toContain("character: Researcher")
    expect(text).toContain("team: team_bot（bot 默认 / bot default）")
    expect(text).toContain("source: 路由规则 / dispatch rule")
    expect(text).toContain("matched rule: Status route (rule-status)")
    expect(text).toContain("response adapter: tg-reply（路由规则 / dispatch rule）")
    expect(text).toContain("1. Status route (rule-status) → team:team_bot, respond-via:tg-reply")
    expect(text).toContain("Future messages are matched again")
    expect(text).toContain("session: Main (abc12345)")
  })
})

describe("withBotDefault", () => {
  it("annotates a value as coming from the bot-instance default", () => {
    expect(R.withBotDefault("claude-fable-5")).toBe("claude-fable-5（bot 默认 / bot default）")
  })
})

describe("team confirmations", () => {
  it("distinguishes plain unbind from the bot-default-suppressing disable", () => {
    expect(R.confirmTeamCleared()).toMatch(/Team unbound/)
    expect(R.confirmTeamDisabled()).toMatch(/including the bot default/)
    expect(R.confirmTeamDisabled()).toMatch(/包括机器人默认团队/)
  })

  it("confirmTeam names the bound team", () => {
    expect(R.confirmTeam("Researchers")).toMatch(/Team bound: Researchers/)
  })
})

describe("assignment provenance (slice 1A)", () => {
  it("sourceLabel knows the assignment source and falls back to the raw key", () => {
    expect(R.sourceLabel("assignment")).toBe("会话分配 / assignment")
    expect(R.sourceLabel("override")).toBe("会话覆盖 / conversation override")
    expect(R.sourceLabel("mystery")).toBe("mystery")
    expect(R.withSource("team_1", "assignment")).toBe("team_1（会话分配 / assignment）")
  })

  it("renderAssignee describes human / character / team and hides when unassigned", () => {
    expect(R.renderAssignee(undefined)).toBeUndefined()
    expect(R.renderAssignee({ kind: "human" })).toBe("人工 / me")
    expect(R.renderAssignee({ kind: "character", id: "c1", label: "Ava" })).toBe(
      "角色 / character: Ava"
    )
    expect(R.renderAssignee({ kind: "team", id: "t1" })).toBe("团队 / team: t1")
    expect(R.renderAssignee({ kind: "team" })).toBe("团队 / team: ?")
  })

  it("renderStatus adds the assignee line only when assigned", () => {
    const base = {
      mode: "manual",
      model: "m",
      provider: "p",
      character: "c",
      reasoning: "r",
      approvalMode: "prompt",
      team: "t",
      workflow: "w",
      routeSource: "会话分配 / assignment",
      matchedRule: "无 / none",
      responseAdapter: "tg",
      enabledRules: [],
      sessionTitle: "Main",
      sessionIdPrefix: "abc",
    }
    expect(R.renderStatus(base)).not.toContain("assignee:")
    const text = R.renderStatus({ ...base, assignee: "人工 / me" })
    expect(text).toContain("• 分配 / assignee: 人工 / me")
    // Sits right after the mode line.
    const lines = text.split("\n")
    expect(lines[lines.indexOf("• 模式 / mode: manual") + 1]).toBe("• 分配 / assignee: 人工 / me")
  })
})

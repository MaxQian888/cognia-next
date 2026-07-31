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
      sessionTitle: "Main",
      sessionIdPrefix: "abc12345",
    })
    expect(text).toContain("mode: auto")
    expect(text).toContain("model: claude-fable-5（bot 默认 / bot default）")
    expect(text).toContain("provider: anthropic")
    expect(text).toContain("reasoning: high")
    expect(text).toContain("character: Researcher")
    expect(text).toContain("team: team_bot（bot 默认 / bot default）")
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

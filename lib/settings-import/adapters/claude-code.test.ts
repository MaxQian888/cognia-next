import { settingsFromClaudeCode } from "./claude-code"

describe("settingsFromClaudeCode", () => {
  it("maps model, effort, output style, permissions, and marks hooks shared", () => {
    const drafts = settingsFromClaudeCode(
      { defaultModel: "old", agentPermissions: { toolRules: { Bash: "ask" } } },
      {
        model: "claude-opus-5",
        effortLevel: "high",
        outputStyle: "concise",
        permissions: { allow: ["Read"], ask: ["Bash"], deny: ["Write"] },
        hooks: { Notification: [{ hooks: [] }] },
      }
    )
    expect(drafts.map((draft) => [draft.target, draft.incoming])).toEqual(
      expect.arrayContaining([
        ["defaultModel", "claude-opus-5"],
        ["defaultEffort", "high"],
        ["outputStyle", "concise"],
        ["agentPermissions.toolRules", { Read: "allow", Bash: "ask", Write: "deny" }],
      ])
    )
    expect(drafts.find((draft) => draft.target === "claudeHooks")).toMatchObject({
      supported: true,
      shared: true,
    })
  })
})

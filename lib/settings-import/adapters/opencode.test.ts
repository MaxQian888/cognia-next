import { settingsFromOpencode } from "./opencode"

describe("settingsFromOpencode", () => {
  it("preserves OpenCode permission rules and reports settings with no Cognia equivalent", () => {
    const drafts = settingsFromOpencode(
      {},
      {
        model: "anthropic/claude-sonnet-5",
        permission: { edit: "deny", bash: { "git status*": "allow", "*": "ask" } },
        theme: "tokyonight",
        instructions: ["CONTRIBUTING.md"],
        share: "manual",
        autoupdate: true,
      }
    )
    expect(drafts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: "defaultModel", incoming: "anthropic/claude-sonnet-5" }),
        expect.objectContaining({
          target: "agentPermissions.toolRules",
          incoming: { edit: "deny", bash: { "git status*": "allow", "*": "ask" } },
        }),
        expect.objectContaining({ key: "theme", supported: false }),
        expect.objectContaining({ key: "instructions", supported: false }),
        expect.objectContaining({ key: "share", supported: false }),
        expect.objectContaining({ key: "autoupdate", supported: false }),
      ])
    )
  })
})

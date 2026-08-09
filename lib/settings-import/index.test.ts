import { previewSettingsImport } from "./index"

describe("previewSettingsImport", () => {
  it("loads Codex through the existing agent config reader", async () => {
    const readAgentConfig = jest.fn(async () => ({ parsed: { model: "gpt-5.4" } }))
    const drafts = await previewSettingsImport("codex", {
      currentSettings: () => ({ defaultModel: "old" }),
      readAgentConfig,
      readClaudeEffectiveSettings: jest.fn(),
    })
    expect(readAgentConfig).toHaveBeenCalledWith("codex")
    expect(drafts).toEqual([
      expect.objectContaining({ target: "defaultModel", incoming: "gpt-5.4" }),
    ])
  })

  it("loads Claude Code through the effective-settings reader", async () => {
    const readClaudeEffectiveSettings = jest.fn(async () => ({
      merged: { outputStyle: "concise" },
    }))
    const drafts = await previewSettingsImport("claude-code", {
      currentSettings: () => ({}),
      readAgentConfig: jest.fn(),
      readClaudeEffectiveSettings,
    })
    expect(drafts[0]).toMatchObject({ target: "outputStyle", incoming: "concise" })
  })
})

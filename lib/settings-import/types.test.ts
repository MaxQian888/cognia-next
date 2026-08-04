import { isSettingsImportDraft } from "./types"

describe("isSettingsImportDraft", () => {
  it("accepts a complete draft and rejects unsupported shapes", () => {
    expect(
      isSettingsImportDraft({
        id: "codex:model",
        source: "codex",
        group: "model",
        key: "model",
        target: "defaultModel",
        current: "old",
        incoming: "new",
        warnings: [],
        supported: true,
        shared: false,
      })
    ).toBe(true)
    expect(isSettingsImportDraft({ source: "cursor" })).toBe(false)
  })
})

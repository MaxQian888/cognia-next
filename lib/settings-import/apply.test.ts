import { applySettingsImport } from "./apply"
import type { SettingsImportDraft } from "./types"

const draft = (overrides: Partial<SettingsImportDraft>): SettingsImportDraft => ({
  id: "opencode:model",
  source: "opencode",
  group: "model",
  key: "model",
  target: "defaultModel",
  current: "old",
  incoming: "new",
  warnings: [],
  supported: true,
  shared: false,
  ...overrides,
})

describe("applySettingsImport", () => {
  it("writes only selected supported settings and merges nested tool rules", async () => {
    const save = jest.fn(async () => undefined)
    const result = await applySettingsImport(
      [
        draft({}),
        draft({
          id: "opencode:permissions",
          group: "permissions",
          target: "agentPermissions.toolRules",
          incoming: { edit: "deny" },
        }),
        draft({ id: "opencode:theme", key: "theme", supported: false }),
      ],
      ["opencode:model", "opencode:permissions", "opencode:theme"],
      "overwrite",
      {
        currentSettings: () => ({ agentPermissions: { commandRules: { "git push*": "ask" } } }),
        save,
        readClaudeUserSettings: jest.fn(),
        writeClaudeUserSettings: jest.fn(),
      }
    )
    expect(save).toHaveBeenCalledWith({
      defaultModel: "new",
      agentPermissions: {
        commandRules: { "git push*": "ask" },
        toolRules: { edit: "deny" },
      },
    })
    expect(result).toMatchObject({ applied: 2, skipped: 1 })
  })

  it("patches Claude hooks without dropping unknown settings", async () => {
    const writeClaudeUserSettings = jest.fn(async () => ({ path: "/settings.json" }))
    await applySettingsImport(
      [
        draft({
          id: "codex:hooks",
          source: "codex",
          group: "hooks",
          target: "claudeHooks",
          current: undefined,
          incoming: { Notification: [{ hooks: [{ type: "command", command: "notify" }] }] },
        }),
      ],
      ["codex:hooks"],
      "overwrite",
      {
        currentSettings: () => ({}),
        save: jest.fn(),
        readClaudeUserSettings: jest.fn(async () => ({ model: "keep", extra: { future: true } })),
        writeClaudeUserSettings,
      }
    )
    expect(writeClaudeUserSettings).toHaveBeenCalledWith({
      model: "keep",
      extra: { future: true },
      hooks: { Notification: [{ hooks: [{ type: "command", command: "notify" }] }] },
    })
  })
})

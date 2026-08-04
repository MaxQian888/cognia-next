import { settingsFromCodex } from "./codex"

describe("settingsFromCodex", () => {
  it("maps model, effort, approval, and sandbox without hiding unsupported policies", () => {
    const drafts = settingsFromCodex(
      {},
      {
        model: "gpt-5.4",
        model_reasoning_effort: "high",
        approval_policy: "never",
        sandbox_mode: "read-only",
        shell_environment_policy: { include_only: ["PATH"] },
        notify: ["terminal-notifier"],
      }
    )
    expect(drafts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: "defaultModel", incoming: "gpt-5.4", supported: true }),
        expect.objectContaining({ target: "defaultEffort", incoming: "high", supported: true }),
        expect.objectContaining({ target: "permissionMode", incoming: "bypassPermissions" }),
        expect.objectContaining({ target: "sandboxDefaultEnabled", incoming: true }),
        expect.objectContaining({ key: "shellEnvironmentPolicy", supported: false }),
        expect.objectContaining({ key: "notify", supported: false }),
      ])
    )
  })
})

import { settingsDraft, type SettingsImportDraft, type SettingsSnapshot } from "../types"

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function approvalMode(value: unknown): string | undefined {
  if (value === "never") return "bypassPermissions"
  if (value === "on-failure") return "acceptEdits"
  if (value === "on-request" || value === "untrusted") return "default"
  return undefined
}

export function settingsFromCodex(
  current: SettingsSnapshot,
  input: unknown
): SettingsImportDraft[] {
  const source = record(input)
  const drafts: SettingsImportDraft[] = []
  if (typeof source.model === "string") {
    drafts.push(
      settingsDraft("codex", "model", "model", "defaultModel", current.defaultModel, source.model)
    )
  }
  if (typeof source.model_reasoning_effort === "string") {
    drafts.push(
      settingsDraft(
        "codex",
        "model",
        "effort",
        "defaultEffort",
        current.defaultEffort,
        source.model_reasoning_effort
      )
    )
  }
  const mode = approvalMode(source.approval_policy)
  if (mode) {
    drafts.push(
      settingsDraft(
        "codex",
        "permissions",
        "approvalPolicy",
        "permissionMode",
        current.permissionMode,
        mode,
        {
          warnings:
            mode === "bypassPermissions" ? ["This imports Codex's no-approval policy."] : [],
        }
      )
    )
  }
  if (typeof source.sandbox_mode === "string") {
    const enabled = source.sandbox_mode !== "danger-full-access"
    drafts.push(
      settingsDraft(
        "codex",
        "sandbox",
        "sandboxMode",
        "sandboxDefaultEnabled",
        current.sandboxDefaultEnabled,
        enabled
      )
    )
    drafts.push(
      settingsDraft(
        "codex",
        "sandbox",
        "workspaceConfinement",
        "workspaceConfinementEnabled",
        current.workspaceConfinementEnabled,
        enabled
      )
    )
  }
  if (source.shell_environment_policy !== undefined) {
    drafts.push(
      settingsDraft(
        "codex",
        "env",
        "shellEnvironmentPolicy",
        "unsupported",
        undefined,
        source.shell_environment_policy,
        {
          supported: false,
          warnings: ["Cognia has no equivalent shell environment allowlist setting."],
        }
      )
    )
  }
  if (source.notify !== undefined) {
    drafts.push(
      settingsDraft("codex", "hooks", "notify", "unsupported", undefined, source.notify, {
        supported: false,
        warnings: ["Codex notify commands cannot be translated losslessly into Claude hooks."],
      })
    )
  }
  return drafts
}

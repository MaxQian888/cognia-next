import type { AppSettings } from "@cognia/agent-config-types"

export type SettingsSourceId = "claude-code" | "codex" | "opencode" | "pi"
export type SettingsGroup = "model" | "permissions" | "sandbox" | "env" | "hooks" | "ui"
export type SettingsImportTarget =
  | "defaultModel"
  | "defaultEffort"
  | "outputStyle"
  | "permissionMode"
  | "agentPermissions.toolRules"
  | "sandboxDefaultEnabled"
  | "workspaceConfinementEnabled"
  | "claudeHooks"
  | "unsupported"

export interface SettingsImportDraft {
  id: string
  source: SettingsSourceId
  group: SettingsGroup
  key: string
  target: SettingsImportTarget
  current: unknown
  incoming: unknown
  warnings: string[]
  supported: boolean
  /** True when Cognia and the source already read the same underlying file. */
  shared: boolean
}

export type SettingsImportMergeStrategy = "skip" | "overwrite" | "duplicate"
export type SettingsSnapshot = Partial<AppSettings>

const SOURCES = new Set<SettingsSourceId>(["claude-code", "codex", "opencode", "pi"])
const GROUPS = new Set<SettingsGroup>(["model", "permissions", "sandbox", "env", "hooks", "ui"])

export function isSettingsImportDraft(value: unknown): value is SettingsImportDraft {
  if (!value || typeof value !== "object") return false
  const draft = value as Partial<SettingsImportDraft>
  return (
    typeof draft.id === "string" &&
    SOURCES.has(draft.source as SettingsSourceId) &&
    GROUPS.has(draft.group as SettingsGroup) &&
    typeof draft.key === "string" &&
    typeof draft.target === "string" &&
    Array.isArray(draft.warnings) &&
    typeof draft.supported === "boolean" &&
    typeof draft.shared === "boolean"
  )
}

export function settingsDraft(
  source: SettingsSourceId,
  group: SettingsGroup,
  key: string,
  target: SettingsImportTarget,
  current: unknown,
  incoming: unknown,
  options: Partial<Pick<SettingsImportDraft, "warnings" | "supported" | "shared">> = {}
): SettingsImportDraft {
  return {
    id: `${source}:${key}`,
    source,
    group,
    key,
    target,
    current,
    incoming,
    warnings: options.warnings ?? [],
    supported: options.supported ?? true,
    shared: options.shared ?? false,
  }
}

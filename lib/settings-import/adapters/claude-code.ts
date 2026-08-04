import type { ClaudeSettings } from "@/lib/claude/settings"
import type { Ruleset } from "@/lib/claude/permissions/ruleset"
import { settingsDraft, type SettingsImportDraft, type SettingsSnapshot } from "../types"

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : []
}

function permissionRules(value: unknown): Ruleset {
  if (!value || typeof value !== "object") return {}
  const source = value as Record<string, unknown>
  const out: Ruleset = {}
  for (const verdict of ["allow", "ask", "deny"] as const) {
    for (const tool of stringList(source[verdict])) out[tool] = verdict
  }
  return out
}

export function settingsFromClaudeCode(
  current: SettingsSnapshot,
  source: ClaudeSettings
): SettingsImportDraft[] {
  const drafts: SettingsImportDraft[] = []
  if (typeof source.model === "string") {
    drafts.push(
      settingsDraft(
        "claude-code",
        "model",
        "model",
        "defaultModel",
        current.defaultModel,
        source.model
      )
    )
  }
  if (typeof source.effortLevel === "string") {
    drafts.push(
      settingsDraft(
        "claude-code",
        "model",
        "effort",
        "defaultEffort",
        current.defaultEffort,
        source.effortLevel
      )
    )
  }
  if (typeof source.outputStyle === "string") {
    drafts.push(
      settingsDraft(
        "claude-code",
        "ui",
        "outputStyle",
        "outputStyle",
        current.outputStyle,
        source.outputStyle
      )
    )
  }
  const rules = permissionRules(source.permissions)
  if (Object.keys(rules).length > 0) {
    drafts.push(
      settingsDraft(
        "claude-code",
        "permissions",
        "permissions",
        "agentPermissions.toolRules",
        current.agentPermissions?.toolRules,
        rules
      )
    )
  }
  drafts.push(
    settingsDraft("claude-code", "hooks", "hooks", "claudeHooks", source.hooks, source.hooks, {
      shared: true,
      warnings: ["Claude Code and Cognia already share this hooks file."],
    })
  )
  return drafts
}

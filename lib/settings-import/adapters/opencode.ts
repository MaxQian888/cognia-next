import type { PermissionVerdict, Ruleset, ToolRules } from "@/lib/claude/permissions/ruleset"
import { settingsDraft, type SettingsImportDraft, type SettingsSnapshot } from "../types"

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function verdict(value: unknown): PermissionVerdict | undefined {
  return value === "allow" || value === "ask" || value === "deny" ? value : undefined
}

function normalizeRuleset(value: unknown): Ruleset {
  const out: Ruleset = {}
  for (const [tool, rule] of Object.entries(record(value))) {
    const direct = verdict(rule)
    if (direct) {
      out[tool] = direct
      continue
    }
    const nested: ToolRules = {}
    for (const [pattern, effect] of Object.entries(record(rule))) {
      const normalized = verdict(effect)
      if (normalized) nested[pattern] = normalized
    }
    if (Object.keys(nested).length > 0) out[tool] = nested
  }
  return out
}

export function settingsFromOpencode(
  current: SettingsSnapshot,
  input: unknown
): SettingsImportDraft[] {
  const source = record(input)
  const drafts: SettingsImportDraft[] = []
  if (typeof source.model === "string") {
    drafts.push(
      settingsDraft(
        "opencode",
        "model",
        "model",
        "defaultModel",
        current.defaultModel,
        source.model
      )
    )
  }
  const rules = normalizeRuleset(source.permission)
  if (Object.keys(rules).length > 0) {
    drafts.push(
      settingsDraft(
        "opencode",
        "permissions",
        "permission",
        "agentPermissions.toolRules",
        current.agentPermissions?.toolRules,
        rules
      )
    )
  }
  for (const [key, group] of [
    ["theme", "ui"],
    ["instructions", "env"],
    ["share", "ui"],
    ["autoupdate", "ui"],
  ] as const) {
    if (source[key] === undefined) continue
    drafts.push(
      settingsDraft("opencode", group, key, "unsupported", undefined, source[key], {
        supported: false,
        warnings: [`OpenCode ${key} has no lossless Cognia setting equivalent.`],
      })
    )
  }
  return drafts
}

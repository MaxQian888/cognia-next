import type { AppSettings } from "@cognia/agent-config-types"
import type { ClaudeSettings } from "@/lib/claude/settings"
import type { SettingsImportDraft, SettingsImportMergeStrategy, SettingsSnapshot } from "./types"

export interface ApplySettingsImportDeps {
  currentSettings: () => SettingsSnapshot
  save: (patch: Partial<Omit<AppSettings, "id">>) => Promise<void>
  readClaudeUserSettings: () => Promise<ClaudeSettings | null>
  writeClaudeUserSettings: (payload: ClaudeSettings) => Promise<unknown>
}

export interface ApplySettingsImportResult {
  applied: number
  skipped: number
  warnings: string[]
}

async function defaultDeps(): Promise<ApplySettingsImportDeps> {
  const [{ useSettingsStore }, claudeSettings] = await Promise.all([
    import("@/stores/settings/settings-store"),
    import("@/lib/claude/settings"),
  ])
  return {
    currentSettings: () => useSettingsStore.getState().settings ?? {},
    save: (patch) => useSettingsStore.getState().save(patch),
    readClaudeUserSettings: claudeSettings.readClaudeUserSettings,
    writeClaudeUserSettings: claudeSettings.writeClaudeUserSettings,
  }
}

export async function applySettingsImport(
  drafts: SettingsImportDraft[],
  selectedIds: readonly string[],
  strategy: SettingsImportMergeStrategy,
  deps?: ApplySettingsImportDeps
): Promise<ApplySettingsImportResult> {
  const resolved = deps ?? (await defaultDeps())
  const selected = new Set(selectedIds)
  const current = resolved.currentSettings()
  const patch: Partial<Omit<AppSettings, "id">> = {}
  const warnings: string[] = []
  let applied = 0
  let skipped = 0

  for (const draft of drafts) {
    if (!selected.has(draft.id)) continue
    warnings.push(...draft.warnings)
    if (!draft.supported || draft.shared || draft.target === "unsupported") {
      skipped += 1
      continue
    }
    if (strategy !== "overwrite" && draft.current !== undefined && draft.current !== null) {
      skipped += 1
      continue
    }
    if (draft.target === "claudeHooks") {
      const settings = (await resolved.readClaudeUserSettings()) ?? {}
      await resolved.writeClaudeUserSettings({
        ...settings,
        hooks: draft.incoming as Record<string, unknown>,
      })
      applied += 1
      continue
    }
    if (draft.target === "agentPermissions.toolRules") {
      patch.agentPermissions = {
        ...current.agentPermissions,
        ...patch.agentPermissions,
        toolRules: draft.incoming as NonNullable<AppSettings["agentPermissions"]>["toolRules"],
      }
      applied += 1
      continue
    }
    ;(patch as Record<string, unknown>)[draft.target] = draft.incoming
    applied += 1
  }

  if (Object.keys(patch).length > 0) await resolved.save(patch)
  return { applied, skipped, warnings }
}

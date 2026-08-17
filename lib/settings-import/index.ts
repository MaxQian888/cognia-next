import type { AgentReadResult } from "@/lib/claude/ipc"
import type { EffectiveSettings } from "@/lib/claude/settings"
import { settingsFromClaudeCode } from "./adapters/claude-code"
import { settingsFromCodex } from "./adapters/codex"
import { settingsFromOpencode } from "./adapters/opencode"
import { settingsFromPi } from "./adapters/pi"
import type { SettingsImportDraft, SettingsSnapshot, SettingsSourceId } from "./types"

export interface SettingsImportPreviewDeps {
  currentSettings: () => SettingsSnapshot
  readAgentConfig: (agent: "codex" | "opencode" | "pi") => Promise<Pick<AgentReadResult, "parsed">>
  readClaudeEffectiveSettings: () => Promise<Pick<EffectiveSettings, "merged">>
}

async function defaultDeps(): Promise<SettingsImportPreviewDeps> {
  const [{ useSettingsStore }, ipc, claudeSettings] = await Promise.all([
    import("@/stores/settings/settings-store"),
    import("@/lib/claude/ipc"),
    import("@/lib/claude/settings"),
  ])
  return {
    currentSettings: () => useSettingsStore.getState().settings ?? {},
    readAgentConfig: ipc.readAgentConfig,
    readClaudeEffectiveSettings: claudeSettings.readClaudeEffectiveSettings,
  }
}

export async function previewSettingsImport(
  source: SettingsSourceId,
  deps?: SettingsImportPreviewDeps
): Promise<SettingsImportDraft[]> {
  const resolved = deps ?? (await defaultDeps())
  const current = resolved.currentSettings()
  if (source === "claude-code") {
    const effective = await resolved.readClaudeEffectiveSettings()
    return settingsFromClaudeCode(current, effective.merged)
  }
  const config = await resolved.readAgentConfig(source)
  if (source === "codex") return settingsFromCodex(current, config.parsed)
  if (source === "pi") return settingsFromPi(current, config.parsed)
  return settingsFromOpencode(current, config.parsed)
}

export * from "./types"

// Tauri IPC wrappers for CCSwitch. Pattern matches `lib/claude/ipc.ts`:
// each function `ensureTauri()`s and forwards through `invoke()`.
//
// All five commands are read-only on CCSwitch's database. The status command
// always succeeds (returns `{ exists: false }` when CCSwitch isn't installed
// or the DB hasn't been created yet); the list commands fail only when an
// existing DB can't be opened (corruption, permissions).

import { invoke } from "@tauri-apps/api/core"
import { isTauri } from "@/lib/tauri"
import type {
  CcswitchMcpServer,
  CcswitchPrompt,
  CcswitchProvider,
  CcswitchSkill,
  CcswitchStatus,
} from "./types"

function ensureTauri() {
  if (!isTauri()) {
    throw new Error(
      "CCSwitch interop is only available inside Tauri. Run `pnpm tauri dev` instead of `pnpm dev`."
    )
  }
}

export async function ccswitchStatus(): Promise<CcswitchStatus> {
  ensureTauri()
  return invoke<CcswitchStatus>("ccswitch_status")
}

export async function ccswitchListProviders(): Promise<CcswitchProvider[]> {
  ensureTauri()
  return invoke<CcswitchProvider[]>("ccswitch_list_providers")
}

export async function ccswitchListMcpServers(): Promise<CcswitchMcpServer[]> {
  ensureTauri()
  return invoke<CcswitchMcpServer[]>("ccswitch_list_mcp_servers")
}

export async function ccswitchListPrompts(): Promise<CcswitchPrompt[]> {
  ensureTauri()
  return invoke<CcswitchPrompt[]>("ccswitch_list_prompts")
}

export async function ccswitchListSkills(): Promise<CcswitchSkill[]> {
  ensureTauri()
  return invoke<CcswitchSkill[]>("ccswitch_list_skills")
}

/**
 * Patch the `env` block in `~/.claude/settings.json` (Claude Code's runtime
 * settings file). Used by `applySwitch` to propagate a CCSwitch provider
 * switch into Claude Code so subsequent CLI invocations pick up the new key
 * + base URL. `null` removes a key (e.g., clearing `ANTHROPIC_BASE_URL` when
 * switching back to the official endpoint).
 */
export async function writeClaudeSettingsEnv(
  envUpdates: Record<string, string | null>
): Promise<{ path: string; backupPath?: string }> {
  ensureTauri()
  return invoke<{ path: string; backupPath?: string }>("write_claude_settings_env", {
    envUpdates,
  })
}

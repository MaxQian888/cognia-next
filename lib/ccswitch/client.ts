// Tauri IPC wrappers for CCSwitch. Pattern matches `lib/claude/ipc.ts`:
// each function `ensureTauri()`s and forwards through `invoke()`.
//
// All five commands are read-only on CCSwitch's database. The status command
// returns `{ exists: false }` when the DB is missing and reports schema/read
// failures in `status.error`; list commands reject invalid schemas or unreadable data.

import { invoke } from "@tauri-apps/api/core"
import { getSettings } from "@/lib/db/settings"
import { isTauri } from "@/lib/tauri"
import type {
  CcswitchMcpServer,
  CcswitchPrompt,
  CcswitchProvider,
  CcswitchSkill,
  CcswitchStatus,
} from "@/types/ccswitch"

function ensureTauri() {
  if (!isTauri()) {
    throw new Error(
      "CCSwitch interop is only available inside Tauri. Run `pnpm tauri dev` instead of `pnpm dev`."
    )
  }
}

/**
 * Optional manual data-dir override (`AppSettings.ccswitchSync.manualDataDir`).
 * Threaded into the read commands so a user who keeps cc-switch.db in a
 * non-standard folder can point cognia at it. Blank values are dropped so the
 * Rust side falls through to its normal resolution chain.
 */
async function manualArg(manualDataDir?: string): Promise<{ manualDataDir?: string }> {
  const directory = manualDataDir ?? (await getSettings()).ccswitchSync?.manualDataDir
  const trimmed = directory?.trim()
  return trimmed ? { manualDataDir: trimmed } : {}
}

export async function ccswitchStatus(manualDataDir?: string): Promise<CcswitchStatus> {
  ensureTauri()
  return invoke<CcswitchStatus>("ccswitch_status", await manualArg(manualDataDir))
}

export async function ccswitchListProviders(manualDataDir?: string): Promise<CcswitchProvider[]> {
  ensureTauri()
  return invoke<CcswitchProvider[]>("ccswitch_list_providers", await manualArg(manualDataDir))
}

export async function ccswitchListMcpServers(manualDataDir?: string): Promise<CcswitchMcpServer[]> {
  ensureTauri()
  return invoke<CcswitchMcpServer[]>("ccswitch_list_mcp_servers", await manualArg(manualDataDir))
}

export async function ccswitchListPrompts(manualDataDir?: string): Promise<CcswitchPrompt[]> {
  ensureTauri()
  return invoke<CcswitchPrompt[]>("ccswitch_list_prompts", await manualArg(manualDataDir))
}

export async function ccswitchListSkills(manualDataDir?: string): Promise<CcswitchSkill[]> {
  ensureTauri()
  return invoke<CcswitchSkill[]>("ccswitch_list_skills", await manualArg(manualDataDir))
}

/**
 * Start the live cc-switch.db watcher (Phase 4.2). The backend emits
 * `ccswitch://db-changed` on debounced db mutations so the hook layer can
 * `refresh()`. Returns whether a watch is now active. No-op-safe to call
 * repeatedly — the Rust side replaces any prior watcher.
 */
export async function ccswitchWatchStart(manualDataDir?: string): Promise<boolean> {
  ensureTauri()
  return invoke<boolean>("ccswitch_watch_start", await manualArg(manualDataDir))
}

/** Stop the live cc-switch.db watcher. */
export async function ccswitchWatchStop(): Promise<void> {
  ensureTauri()
  await invoke("ccswitch_watch_stop")
}

/**
 * Patch the `env` block in `~/.claude/settings.json` (Claude Code's runtime
 * settings file). Used by `applySwitch` to propagate a CCSwitch provider
 * switch into Claude Code so subsequent CLI invocations pick up the new key
 * + base URL. `null` removes a key (e.g., clearing `ANTHROPIC_BASE_URL` when
 * switching back to the official endpoint).
 *
 * The Rust side enforces a write-time mtime drift check; rejections come
 * back as `drift_detected` so the renderer can re-read and retry without
 * clobbering a parallel write by cc-switch itself.
 */
export async function writeClaudeSettingsEnv(
  envUpdates: Record<string, string | null>
): Promise<{ path: string; backupPath?: string }> {
  ensureTauri()
  return invoke<{ path: string; backupPath?: string }>("write_claude_settings_env", {
    envUpdates,
  })
}

/**
 * Patch a provider entry in OpenCode CLI's `auth.json` (the same file cognia
 * reads in discovery). The Rust side writes `{ "type": "api", "key": <value> }`
 * for the target provider.
 *
 * Keys:
 *   - `OPENCODE_API_KEY` → the api key to write (null/empty removes the entry).
 *   - `__provider` → the provider id to target (default "anthropic"); consumed
 *     by the writer, never persisted into auth.json.
 *
 * Atomic write + mtime drift detection + bounded backup rotation apply.
 */
export async function writeOpencodeAuthEnv(
  envUpdates: Record<string, string | null>
): Promise<{ path: string; backupPath?: string }> {
  ensureTauri()
  return invoke<{ path: string; backupPath?: string }>("write_opencode_auth_env", {
    envUpdates,
  })
}

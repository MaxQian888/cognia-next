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
} from "@/types/ccswitch"

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
 * Patch the top-level `OPENAI_API_KEY` + `auth_mode` fields of
 * `~/.codex/auth.json` (codex-cli's auth file). Mirrors the Claude variant
 * for ccswitch's switch flow when the user opts to propagate to codex.
 *
 * Keys that map onto the auth file's recognised fields:
 *   - `OPENAI_API_KEY` (with non-empty `value`) → sets the field and flips
 *     `auth_mode` to `"ApiKey"`.
 *   - `OPENAI_API_KEY` (with `null` / empty `value`) → removes the field
 *     and clears `auth_mode` (so codex-cli falls back to ChatGPT mode if
 *     the `tokens` block is still present).
 *
 * Other keys are accepted for forward-compatibility but are written to a
 * top-level field of the JSON document verbatim — codex-cli ignores
 * unknown top-level keys. Atomic write + mtime drift detection apply.
 */
export async function writeCodexAuthEnv(
  envUpdates: Record<string, string | null>
): Promise<{ path: string; backupPath?: string }> {
  ensureTauri()
  return invoke<{ path: string; backupPath?: string }>("write_codex_auth_env", {
    envUpdates,
  })
}

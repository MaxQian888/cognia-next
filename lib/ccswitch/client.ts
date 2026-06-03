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

/**
 * Optional manual data-dir override (`AppSettings.ccswitchSync.manualDataDir`).
 * Threaded into the read commands so a user who keeps cc-switch.db in a
 * non-standard folder can point cognia at it. Blank values are dropped so the
 * Rust side falls through to its normal resolution chain.
 */
function manualArg(manualDataDir?: string): { manualDataDir?: string } {
  const trimmed = manualDataDir?.trim()
  return trimmed ? { manualDataDir: trimmed } : {}
}

export async function ccswitchStatus(manualDataDir?: string): Promise<CcswitchStatus> {
  ensureTauri()
  return invoke<CcswitchStatus>("ccswitch_status", manualArg(manualDataDir))
}

export async function ccswitchListProviders(manualDataDir?: string): Promise<CcswitchProvider[]> {
  ensureTauri()
  return invoke<CcswitchProvider[]>("ccswitch_list_providers", manualArg(manualDataDir))
}

export async function ccswitchListMcpServers(manualDataDir?: string): Promise<CcswitchMcpServer[]> {
  ensureTauri()
  return invoke<CcswitchMcpServer[]>("ccswitch_list_mcp_servers", manualArg(manualDataDir))
}

export async function ccswitchListPrompts(manualDataDir?: string): Promise<CcswitchPrompt[]> {
  ensureTauri()
  return invoke<CcswitchPrompt[]>("ccswitch_list_prompts", manualArg(manualDataDir))
}

export async function ccswitchListSkills(manualDataDir?: string): Promise<CcswitchSkill[]> {
  ensureTauri()
  return invoke<CcswitchSkill[]>("ccswitch_list_skills", manualArg(manualDataDir))
}

/**
 * Start the live cc-switch.db watcher (Phase 4.2). The backend emits
 * `ccswitch://db-changed` on debounced db mutations so the hook layer can
 * `refresh()`. Returns whether a watch is now active. No-op-safe to call
 * repeatedly — the Rust side replaces any prior watcher.
 */
export async function ccswitchWatchStart(manualDataDir?: string): Promise<boolean> {
  ensureTauri()
  return invoke<boolean>("ccswitch_watch_start", manualArg(manualDataDir))
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

/**
 * Patch the `env` block of Gemini CLI's `~/.gemini/settings.json`. Used by
 * `applySwitch` to propagate a CCSwitch provider switch into gemini-cli.
 *
 * Recognised keys (verified against google-gemini/gemini-cli docs):
 *   - `GEMINI_API_KEY` → the api key for gemini-api-key auth.
 *   - `GOOGLE_GEMINI_BASE_URL` → overrides the default Gemini API base URL.
 *
 * `null` / empty removes the key. Atomic write + mtime drift detection +
 * bounded backup rotation apply on the Rust side.
 */
export async function writeGeminiSettingsEnv(
  envUpdates: Record<string, string | null>
): Promise<{ path: string; backupPath?: string }> {
  ensureTauri()
  return invoke<{ path: string; backupPath?: string }>("write_gemini_settings_env", {
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

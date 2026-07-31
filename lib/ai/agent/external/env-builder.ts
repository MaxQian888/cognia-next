// Pre-spawn environment-variable assembly for external agents.
//
// The Tauri command `spawn_external_agent` (src-tauri/src/external_agent/process.rs:225)
// receives `env: HashMap<String, String>` and pipes it straight through
// `tokio::process::Command::env(...)`. Anything we want the child process to
// see has to be in that map before the IPC call.
//
// The presets that need subscription-backed env injection are `codex` (the
// @zed-industries/codex-acp shim) and `codex-app-server` (the native
// app-server) — both reuse codex-cli's `OPENAI_API_KEY` / `CODEX_ACCESS_TOKEN`
// env contract, so dropping an adopted bearer into the spawn env lets that
// account carry through without a second login.
//
// **ADR-0025**: env resolution goes through the unified subscription module.
// The Rust side maintains an `ActiveAccountState` cache keyed by provider; we
// ask it for the currently active codex account's env pairs. Discovery is NOT a
// runtime fallback — a discovered credential is adopted explicitly through the
// UI's "Reuse" flow, which writes the v2 vault and sets the account active.
//
// That is a correctness requirement, not just determinism. The spawn never
// clears the child's environment, and codex resolves its provider and model
// from `CODEX_HOME`'s config.toml. A codex-cli pointed at a third-party relay
// authenticates with a bare `OPENAI_API_KEY` in auth.json; injecting a
// *different* key we happened to discover would silently break a working login
// the user never asked us to touch. With no adopted account we inject nothing
// and the child inherits its own config exactly as codex-cli would.

import { getSettings } from "@/lib/db/settings"
import { refreshCodexAccountIfStale } from "@/lib/subscription/codex/refresh"
import { getActiveAccount } from "@/lib/subscription/core/transport"
import type { ExternalAgentConfig } from "@/types/agent/external-agent"
import {
  DEFAULT_CODEX_SUBSCRIPTION_SETTINGS,
  type ActiveSnapshot,
  type CodexSubscriptionSettings,
} from "@/types/subscription"

/**
 * Compute the env map that should be passed to `spawn_external_agent`.
 * Caller-supplied entries always win — if the user explicitly typed an
 * `OPENAI_API_KEY` into the agent's settings, we don't overwrite it.
 *
 * For the `codex` preset we read the active codex account's env pairs from
 * the in-process `ActiveAccountState` (populated by `subscription_set_active`
 * + the boot-time migration of v1 credentials). When no active account is
 * registered the function silently returns the base env unchanged.
 */
export async function buildAgentEnv(
  config: ExternalAgentConfig,
  baseEnv: Record<string, string> = {}
): Promise<Record<string, string>> {
  const overlay = await codexEnvOverlay(config)
  if (!overlay) return { ...baseEnv }
  // Caller-supplied env wins. The overlay supplies fields the caller didn't
  // explicitly set — for the typical "Adopt → spawn" flow `baseEnv` is
  // empty so the overlay just becomes the full env.
  const merged: Record<string, string> = { ...overlay }
  for (const [k, v] of Object.entries(baseEnv)) {
    merged[k] = v
  }
  return merged
}

interface PresetMetadata {
  preset?: unknown
}

function presetIdOf(config: ExternalAgentConfig): string | null {
  const meta = config.metadata as PresetMetadata | undefined
  if (typeof meta?.preset === "string") return meta.preset
  return null
}

async function codexEnvOverlay(
  config: ExternalAgentConfig
): Promise<Record<string, string> | null> {
  // Both the ACP shim (`codex`) and the native app-server (`codex-app-server`)
  // preset reuse the same Codex credential env contract.
  const preset = presetIdOf(config)
  if (preset !== "codex" && preset !== "codex-app-server") return null

  const settings = await loadCodexSettings()

  let snapshot: ActiveSnapshot
  try {
    snapshot = await getActiveAccount("codex")
  } catch (err) {
    // Tolerate transient failures (transport offline, Rust panic on a stale
    // vault, etc.) — agent launches shouldn't be blocked on env injection
    // since callers can still supply env directly. The Settings UI surfaces
    // the underlying problem.
    console.warn("env-builder: subscription_get_active(codex) failed:", err)
    return null
  }

  // Active account path. The Rust-side `env_for_sidecar` already folded the
  // resolved preset (base URL, headers, model mapping) into `snapshot.env`.
  if (snapshot.activeAccountId && snapshot.env.length > 0) {
    if (settings.autoRefreshNearExpiry) {
      const refreshed = await maybeRefreshActiveCodex(snapshot.activeAccountId)
      if (refreshed) snapshot = refreshed
    }
    return pairsToRecord(snapshot.env)
  }

  // No active account → no overlay, so the child inherits its own CODEX_HOME
  // (auth.json + config.toml) exactly as codex-cli would. See the header: a
  // discovered credential is adopted explicitly, never injected behind the
  // user's back.
  return null
}

async function loadCodexSettings(): Promise<CodexSubscriptionSettings> {
  try {
    const settings = await getSettings()
    return settings.codexSubscriptionSettings ?? DEFAULT_CODEX_SUBSCRIPTION_SETTINGS
  } catch {
    return DEFAULT_CODEX_SUBSCRIPTION_SETTINGS
  }
}

function pairsToRecord(pairs: Array<[string, string]>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of pairs) out[k] = v
  return out
}

/**
 * When the active codex (chatgpt-mode) credential is within the freshness
 * grace of expiry, refresh it ahead of spawn, persist the rotated token, and
 * re-resolve the active env. Returns the refreshed snapshot, or `null` when no
 * refresh happened (fresh, api-key mode, or any failure — caller keeps the
 * stale env, which the agent can still attempt with).
 */
async function maybeRefreshActiveCodex(accountId: string): Promise<ActiveSnapshot | null> {
  try {
    // Staleness check, refresh exchange and vault write-back are shared with the
    // chat path (`lib/subscription/codex/refresh.ts`) so the two can't drift.
    // `reactivate: true` re-runs set-active, which rebuilds the in-process env
    // cache with the new bearer — the part only this path needs.
    const fresh = await refreshCodexAccountIfStale(accountId, { reactivate: true })
    if (!fresh) return null
    return await getActiveAccount("codex")
  } catch (err) {
    console.warn("env-builder: codex auto-refresh failed:", err)
    return null
  }
}

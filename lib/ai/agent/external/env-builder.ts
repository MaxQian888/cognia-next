// Pre-spawn environment-variable assembly for external agents.
//
// The Tauri command `spawn_external_agent` (src-tauri/src/external_agent/process.rs:225)
// receives `env: HashMap<String, String>` and pipes it straight through
// `tokio::process::Command::env(...)`. Anything we want the child process to
// see has to be in that map before the IPC call.
//
// Currently the only preset that needs subscription-backed env injection is
// `codex` — the @zed-industries/codex-acp adapter we spawn reuses the same
// `OPENAI_API_KEY` / `CODEX_ACCESS_TOKEN` env-var contract as codex-cli, so
// dropping the bearer into the spawn env lets the user's existing ChatGPT
// session carry through without forcing them to log in again.
//
// **ADR-0025 change**: env resolution now goes through the unified
// subscription module. The Rust side maintains an `ActiveAccountState` cache
// keyed by provider; we ask it for the currently active codex account's env
// pairs. Discovery is no longer a runtime fallback — users adopt a
// discovered credential explicitly through the UI's "Reuse" flow, which
// writes to the v2 vault and sets the new account active. This makes
// runtime env injection deterministic (no surprise switches) at the cost of
// requiring one extra click per new install.

import { getSettings } from "@/lib/db/settings"
import { discoverCodexAuth, discoveredToCredential } from "@/lib/subscription/codex/discovery"
import {
  isCodexCredentialFresh,
  refreshCodexToken,
  toProviderCredential,
  tokenResponseToCredential,
} from "@/lib/subscription/codex/oauth"
import {
  getAccount,
  getActiveAccount,
  saveAccount,
  setActiveAccount,
} from "@/lib/subscription/core/transport"
import type { ExternalAgentConfig } from "@/types/agent/external-agent"
import {
  DEFAULT_CODEX_SUBSCRIPTION_SETTINGS,
  type ActiveSnapshot,
  type CodexCredentialData,
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

  // No active account. When the user opted into `preferDiscovered`, fall back
  // to the live `~/.codex/auth.json` discovery so an existing codex-cli login
  // carries through without an explicit Adopt.
  if (settings.preferDiscovered) {
    try {
      const overlay = await discoveredCodexOverlay()
      if (overlay) return overlay
    } catch (err) {
      console.warn("env-builder: codex discovery fallback failed:", err)
    }
  }
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
    const account = await getAccount("codex", accountId)
    if (!account || account.credential.provider !== "codex") return null
    const cred = account.credential as CodexCredentialData & { provider: "codex" }
    if (cred.authMode !== "chatgpt" || !cred.refreshToken) return null
    if (isCodexCredentialFresh(cred)) return null

    const response = await refreshCodexToken(cred.refreshToken)
    const fresh = tokenResponseToCredential(response, { previous: cred, authMode: "chatgpt" })
    await saveAccount("codex", { ...account, credential: toProviderCredential(fresh) })
    // Re-running set-active rebuilds the in-process env cache with the new bearer.
    await setActiveAccount("codex", accountId)
    return await getActiveAccount("codex")
  } catch (err) {
    console.warn("env-builder: codex auto-refresh failed:", err)
    return null
  }
}

async function discoveredCodexOverlay(): Promise<Record<string, string> | null> {
  const discovered = await discoverCodexAuth()
  if (!discovered) return null
  const cred = discoveredToCredential(discovered)
  if (!cred) return null
  return codexCredentialToEnv(cred)
}

/**
 * Mirror of the Rust `codex::env_for_sidecar` mapping for the discovery
 * fallback (which never carries a preset). chatgpt mode → CODEX_ACCESS_TOKEN;
 * api_key mode → OPENAI_API_KEY + CODEX_API_KEY.
 */
function codexCredentialToEnv(cred: CodexCredentialData): Record<string, string> {
  if (cred.authMode === "api_key") {
    return { OPENAI_API_KEY: cred.accessToken, CODEX_API_KEY: cred.accessToken }
  }
  return { CODEX_ACCESS_TOKEN: cred.accessToken }
}

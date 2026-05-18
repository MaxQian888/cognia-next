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

import { getActiveAccount } from "@/lib/subscription/core/transport"
import type { ExternalAgentConfig } from "@/types/agent/external-agent"

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
  if (presetIdOf(config) !== "codex") return null

  try {
    const snapshot = await getActiveAccount("codex")
    if (!snapshot.activeAccountId || snapshot.env.length === 0) {
      return null
    }
    const overlay: Record<string, string> = {}
    for (const [k, v] of snapshot.env) {
      overlay[k] = v
    }
    return overlay
  } catch (err) {
    // Tolerate transient failures (transport offline, Rust panic on a stale
    // vault, etc.) — agent launches shouldn't be blocked on env injection
    // since callers can still supply env directly. The Settings UI surfaces
    // the underlying problem.
    console.warn("env-builder: subscription_get_active(codex) failed:", err)
    return null
  }
}

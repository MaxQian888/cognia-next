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

import { CODEX_ENV_VARS } from "@/lib/codex-subscription/constants"
import {
  loadCodexCredential,
  isCodexCredentialFresh,
} from "@/lib/codex-subscription/credential-store"
import { discoverCodexAuth, discoveredToCredential } from "@/lib/codex-subscription/discovery"
import type { CodexCredential, DiscoveredCodexAuth } from "@/lib/codex-subscription/types"
import type { ExternalAgentConfig } from "@/types/agent/external-agent"

/**
 * Compute the env map that should be passed to `spawn_external_agent`.
 * Caller-supplied entries always win — if the user explicitly typed an
 * `OPENAI_API_KEY` into the agent's settings, we don't overwrite it.
 *
 * For the `codex` preset we (in order):
 *   1. Read our own keyring (`com.cognia.codex-subscription/v1`). If it
 *      contains a fresh credential, use it.
 *   2. If our keyring is empty, fall back to a live discovery probe of
 *      `~/.codex/auth.json` + codex-cli's `"Codex Auth"` keyring entry.
 *      This is the "reuse" path that lets users who already ran
 *      `codex login` skip the cognia-side adoption flow if they want.
 *   3. If neither source has a usable token, return the base env unchanged.
 *
 * The function silently returns the base env on any failure — we treat env
 * injection as best-effort so a flaky keyring read doesn't block agent
 * launches. Callers that need stricter semantics can wrap and observe.
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

  // 1. Try our keyring first.
  let credential: CodexCredential | null = null
  try {
    credential = await loadCodexCredential()
  } catch (err) {
    console.warn("env-builder: codex credential load failed:", err)
  }

  if (credential && isCodexCredentialFresh(credential)) {
    return envForCredential(credential)
  }

  // 2. Fall back to live discovery.
  let discovered: DiscoveredCodexAuth | null = null
  try {
    discovered = await discoverCodexAuth()
  } catch (err) {
    console.warn("env-builder: codex discovery failed:", err)
  }
  if (discovered) {
    const fromDiscovery = discoveredToCredential(discovered)
    if (fromDiscovery && isCodexCredentialFresh(fromDiscovery)) {
      return envForCredential(fromDiscovery)
    }
  }

  return null
}

function envForCredential(credential: CodexCredential): Record<string, string> {
  if (credential.authMode === "api_key") {
    return {
      [CODEX_ENV_VARS.OPENAI_KEY]: credential.accessToken,
      [CODEX_ENV_VARS.CODEX_KEY]: credential.accessToken,
    }
  }
  // ChatGPT mode — codex-cli's adapter recognises CODEX_ACCESS_TOKEN as the
  // ChatGPT bearer. We also expose OPENAI_API_KEY when the credential carries
  // a parallel API key (rare, but the OpenAI account page lets some plans
  // mint one alongside ChatGPT auth).
  const env: Record<string, string> = {
    [CODEX_ENV_VARS.ACCESS_TOKEN]: credential.accessToken,
  }
  return env
}

// ADR-0028 — per-`query()` env injection: resolve the env tuple for the
// account that will serve this turn, plus the per-session proxy env.
//
// `resolveSendOptions` consumes both and merges them into `opts.env` ahead of
// other env layers (e.g. `debugMode`). The dispatch chain on the sidecar side
// (`sidecar/dispatch/anthropic.mjs:117`) then spreads them onto
// `{ ...process.env, ...sendOptions.env }` so the spawned CLI subprocess
// inherits the right OAuth identity, `CLAUDE_CONFIG_DIR`, base URL, and proxy
// for this specific session — without flipping the global `ActiveAccountState`
// pointer.

import { transport } from "@/lib/tauri"
import { useAccountStore } from "@/stores/account/account-store"
import type { AppSettings, Character, ChatSession } from "@/lib/claude/types"

/**
 * Walk the ADR-0028 precedence chain to pick the accountId for this turn:
 *
 *   session.accountId
 *     ?? character.accountIdOverride
 *     ?? settings.defaultAccountId
 *     ?? null
 *
 * A `null` result tells the caller "fall through to the global active pointer"
 * — exactly today's single-account behaviour. Pure: no I/O.
 */
export function resolveAccountId(
  session: ChatSession | null | undefined,
  character: Character | null | undefined,
  settings: AppSettings | null | undefined
): string | null {
  return session?.accountId ?? character?.accountIdOverride ?? settings?.defaultAccountId ?? null
}

/**
 * Fetch the per-account env tuple from the Rust subscription layer
 * (`subscription/active.rs::env_for_account`). The Rust side ensure-creates
 * the per-account `CLAUDE_CONFIG_DIR` directory and returns the OAuth /
 * `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_BASE_URL` / `ANTHROPIC_CUSTOM_HEADER_*`
 * pairs plus `CLAUDE_CONFIG_DIR`.
 *
 * Returns an empty record when:
 *   - `accountId` is null (caller fell through to the global active pointer);
 *   - the account_id is unknown to the vault;
 *   - the Tauri command throws (best-effort — never block a send on this).
 *
 * Callers merge this on top of `process.env` semantics (the sidecar does the
 * `{ ...process.env, ...env }` spread); duplicate keys make the account env
 * authoritative — exactly the intent.
 */
export async function resolveAccountEnv(
  providerId: string,
  accountId: string | null
): Promise<Record<string, string>> {
  if (!accountId) return {}
  const localAccountId = useAccountStore.getState().unlockedAccountId
  if (!localAccountId) return {}
  try {
    const pairs = await transport.call<Array<[string, string]> | null>("claude_env_for_account", {
      provider: providerId,
      localAccountId,
      accountId,
    })
    if (!pairs) return {}
    return Object.fromEntries(pairs)
  } catch (err) {
    // Vault load failure or unknown provider — surface in logs but don't
    // block the send. The next layer (ActiveAccountState defaults) still
    // applies via the sidecar spawn env (`src-tauri/src/claude/sidecar.rs`).
    console.warn("resolveAccountEnv failed", err)
    return {}
  }
}

/**
 * Fetch the per-session proxy env from the Rust `proxy_config` layer. The
 * `sessionId` parameter is forward-compat for deferred V2 per-session proxy
 * overrides — V1 always returns the process-level proxy (the same one
 * `src-tauri/src/claude/sidecar.rs:163` already injects at sidecar spawn).
 *
 * Returns an empty record when no proxy is configured.
 */
export async function resolveProxyEnv(
  sessionId: string | null | undefined
): Promise<Record<string, string>> {
  try {
    const pairs = await transport.call<Array<[string, string]>>("claude_proxy_env_for_session", {
      sessionId: sessionId ?? "",
    })
    return Object.fromEntries(pairs ?? [])
  } catch (err) {
    console.warn("resolveProxyEnv failed", err)
    return {}
  }
}

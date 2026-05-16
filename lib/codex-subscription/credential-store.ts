// Frontend façade over the Codex subscription credential Tauri commands
// defined in `src-tauri/src/codex_subscription/commands.rs`. Routes through
// the module-scope `transport` so Capacitor mode can transparently proxy
// these to the desktop's keyring through the companion API.

import { transport } from "@/lib/tauri"
import { CODEX_CREDENTIAL_FRESH_GRACE_MS } from "./constants"
import type { CodexCredential } from "./types"

/**
 * Persist a credential to the OS keyring. Rejects if both `accessToken`
 * and `refreshToken` are empty — pass `clearCodexCredential` to remove.
 */
export async function saveCodexCredential(payload: CodexCredential): Promise<void> {
  await transport.call("codex_sub_save_token", { payload })
}

/**
 * Read the credential. Returns `null` when no entry exists. Rejects when
 * the keyring entry exists but its JSON payload is unparsable — callers
 * surface that as a "credential corrupted" banner.
 */
export async function loadCodexCredential(): Promise<CodexCredential | null> {
  const got = await transport.call<CodexCredential | null>("codex_sub_load_token")
  return got ?? null
}

/** Remove the credential. No-op when nothing is stored. */
export async function clearCodexCredential(): Promise<void> {
  await transport.call("codex_sub_clear_token")
}

/**
 * `true` when the credential is usable right now. For `chatgpt` mode this
 * means the access token hasn't expired (with a 60-second grace by default).
 * For `api_key` mode the credential never "expires" locally — `true` as long
 * as `accessToken` is non-empty.
 */
export function isCodexCredentialFresh(
  credential: CodexCredential | null,
  nowMs: number = Date.now(),
  graceMs: number = CODEX_CREDENTIAL_FRESH_GRACE_MS
): boolean {
  if (!credential || !credential.accessToken) return false
  if (credential.authMode === "api_key") return true
  if (credential.expiresAtMs === 0) return true
  return credential.expiresAtMs - graceMs > nowMs
}

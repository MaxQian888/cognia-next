// Frontend façade over the three Tauri commands defined in
// `src-tauri/src/anthropic_subscription/commands.rs`. Routes through the
// module-scope `transport` so Capacitor mode (M2.7) can transparently
// proxy these to the desktop's keyring through the companion API.

import { transport } from "@/lib/tauri"
import type { SubscriptionCredential } from "./types"

/**
 * Persist a credential to the OS keyring. Throws if the access_token is
 * empty (the Rust side enforces this — pass through `clearCredential` to
 * remove instead).
 */
export async function saveCredential(payload: SubscriptionCredential): Promise<void> {
  await transport.call("claude_sub_save_token", { payload })
}

/**
 * Read the credential. Returns `null` when no entry exists. Rejects when
 * the keyring entry exists but its JSON payload is unparsable — callers
 * should surface that as a "credential corrupted" banner so the user can
 * sign in again.
 */
export async function loadCredential(): Promise<SubscriptionCredential | null> {
  const got = await transport.call<SubscriptionCredential | null>("claude_sub_load_token")
  return got ?? null
}

/** Remove the credential. No-op when nothing is stored. */
export async function clearCredential(): Promise<void> {
  await transport.call("claude_sub_clear_token")
}

/**
 * `true` when an `accessToken` is present *and* the absolute expiry hasn't
 * elapsed. Use this for the "logged in?" badge; kicking off a refresh is
 * the caller's job.
 */
export function isCredentialFresh(
  credential: SubscriptionCredential | null,
  nowMs: number = Date.now(),
  graceMs: number = 60_000
): boolean {
  if (!credential || !credential.accessToken) return false
  return credential.expiresAtMs - graceMs > nowMs
}

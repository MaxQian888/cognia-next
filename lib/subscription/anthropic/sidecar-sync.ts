// Bridge between the keyring-backed vault and the in-process Rust ApiKeyState
// that the sidecar reads on spawn.
//
// One direction only — the vault is the source of truth, this module pushes
// active-account changes down to the sidecar via the unified
// `subscription_set_active` Tauri command. The Rust side handles three things
// in one atomic step:
//
//   1. Resolves the active account's credential from the v2 vault.
//   2. Pushes the OAuth bearer into `ApiKeyState::set_oauth_bearer`.
//   3. Kills the sidecar so the next spawn sees the new env.
//
// Passing `null` for the account id clears the active pointer (and, with it,
// the in-memory bearer + sidecar restart). Use `signOutAnthropic()` for that.
//
// This module is a thin shim over `core/transport.ts`. It exists to give the
// account dialog + hooks a domain-named entry point that's symmetric with
// the codex/opencode flows.

import { isTauri } from "@/lib/tauri"

import { setActiveAccount } from "../core/transport"

/**
 * Activate an Anthropic account. Triggers the sidecar restart that makes the
 * new bearer effective on the next `claude_send`.
 *
 * @param accountId UUIDv7 of the account stored in the v2 vault.
 */
export async function activateAnthropicAccount(accountId: string): Promise<void> {
  if (!isTauri()) return
  await setActiveAccount("anthropic", accountId)
}

/**
 * Clear the active Anthropic account. Mirrors the previous
 * `clearCredentialFromSidecar()` shape but goes through the unified vault.
 * The next sidecar spawn falls back to the API-key path (or has no auth).
 */
export async function signOutAnthropic(): Promise<void> {
  if (!isTauri()) return
  await setActiveAccount("anthropic", null)
}

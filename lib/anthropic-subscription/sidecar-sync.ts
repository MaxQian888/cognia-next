// Bridge between the keyring-backed credential store and the in-process
// Rust ApiKeyState that the sidecar reads on spawn.
//
// One direction only — the keyring is the source of truth, this module pushes
// changes down to the sidecar:
//
//   syncCredentialToSidecar(credential)   — push the access token + restart
//   clearCredentialFromSidecar()          — clear the token + restart
//
// Restart is necessary because the agent SDK reads `CLAUDE_CODE_OAUTH_TOKEN`
// at init time only.

import { restartSidecar, setOauthBearer } from "@/lib/claude/ipc"
import { isTauri } from "@/lib/tauri"

import type { SubscriptionCredential } from "./types"

/**
 * Push the access token to the sidecar's env store and restart so the next
 * `claude_send` spawns with `CLAUDE_CODE_OAUTH_TOKEN` set. No-op on the web.
 */
export async function syncCredentialToSidecar(credential: SubscriptionCredential): Promise<void> {
  if (!isTauri()) return
  await setOauthBearer(credential.accessToken)
  await restartSidecar()
}

/**
 * Clear the OAuth bearer from the sidecar's env store and restart so the
 * next `claude_send` falls back to API-key auth (or has no auth).
 */
export async function clearCredentialFromSidecar(): Promise<void> {
  if (!isTauri()) return
  await setOauthBearer(null)
  await restartSidecar()
}

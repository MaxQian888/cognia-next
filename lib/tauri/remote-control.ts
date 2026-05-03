/**
 * Tauri-side wrappers for the remote-control subsystem.
 *
 * The actual axum HTTP server, OS-keyring backed token + signing secret, and
 * graceful shutdown live in `src-tauri/src/remote_control/`. Frontend code
 * never calls `invoke` directly — every boundary goes through this module so
 * `isTauri()` gating, error normalization, and the typed signatures stay in
 * one place.
 *
 * Mirrors the convention established in `lib/tauri/canvas.ts`:
 *   - `isTauri()` guards desktop-only commands so web builds throw clearly
 *     instead of silently calling `invoke` against a missing global.
 *   - Snake-cased command names match `invoke_handler!` in `lib.rs`.
 */

import { invoke } from "@tauri-apps/api/core"
import { isTauri } from "@/lib/tauri"
import type { RemoteControlConfig, RemoteControlStatus } from "@/types/remote-control"

function ensureTauri(command: string): void {
  if (!isTauri()) {
    throw new Error(`${command} requires the Tauri desktop runtime`)
  }
}

/** Fetch the live status of the inbound listener. */
export async function remoteControlGetStatus(): Promise<RemoteControlStatus> {
  ensureTauri("remote_control_get_status")
  return invoke<RemoteControlStatus>("remote_control_get_status")
}

/** Start the inbound listener using the persisted config. Idempotent. */
export async function remoteControlStart(): Promise<void> {
  ensureTauri("remote_control_start")
  await invoke("remote_control_start")
}

/** Stop the inbound listener. Idempotent. */
export async function remoteControlStop(): Promise<void> {
  ensureTauri("remote_control_stop")
  await invoke("remote_control_stop")
}

/**
 * Read the current bearer token. Backed by the OS keyring on desktop. Used
 * sparingly — the UI fetches once when the user clicks "Reveal" / "Copy".
 *
 * Returns `null` when no token has been generated yet.
 */
export async function remoteControlGetToken(): Promise<string | null> {
  ensureTauri("remote_control_get_token")
  return invoke<string | null>("remote_control_get_token")
}

/** Generate a fresh token and persist it. Returns the new value. */
export async function remoteControlRotateToken(): Promise<string> {
  ensureTauri("remote_control_rotate_token")
  return invoke<string>("remote_control_rotate_token")
}

/** Persist non-secret config (port, allowlist, rate limit, custom headers, signing-secret presence flag). */
export async function remoteControlUpdateConfig(config: RemoteControlConfig): Promise<void> {
  ensureTauri("remote_control_update_config")
  await invoke("remote_control_update_config", { config })
}

/**
 * Set the outbound HMAC signing secret. Pass `null` to clear it. The plain
 * value lives in the OS keyring; only `hasSigningSecret: boolean` flows back
 * to the renderer.
 */
export async function remoteControlSetSigningSecret(secret: string | null): Promise<void> {
  ensureTauri("remote_control_set_signing_secret")
  await invoke("remote_control_set_signing_secret", { secret })
}

/**
 * Read the outbound signing secret. Used by `getOutboundConfig()` in the
 * notification-integration helper just before each outbound webhook delivery
 * so the secret never has to live in any TS-side store.
 */
export async function remoteControlGetSigningSecret(): Promise<string | null> {
  ensureTauri("remote_control_get_signing_secret")
  return invoke<string | null>("remote_control_get_signing_secret")
}

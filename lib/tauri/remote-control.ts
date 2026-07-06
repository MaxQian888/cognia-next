/**
 * Tauri-side wrappers for the remote-control subsystem.
 *
 * The actual axum HTTP server, OS-keyring backed token + signing secret, and
 * graceful shutdown live in `src-tauri/src/remote_control/`. Frontend code
 * never calls Tauri IPC directly — every boundary goes through this module so
 * `transport`-level error normalization and the typed signatures stay in
 * one place.
 *
 * Snake-cased command names match `invoke_handler!` in `lib.rs`. The
 * underlying transport (TauriTransport on desktop, CompanionTransport on
 * mobile from M2.7) decides whether the call goes through Tauri IPC or HTTP.
 */

import { transport } from "@/lib/tauri"
import type { RemoteControlConfig, RemoteControlStatus } from "@/types/remote-control"

/** Fetch the live status of the inbound listener. */
export async function remoteControlGetStatus(): Promise<RemoteControlStatus> {
  return transport.call<RemoteControlStatus>("remote_control_get_status")
}

/** Start the inbound listener using the persisted config. Idempotent. */
export async function remoteControlStart(): Promise<void> {
  await transport.call<void>("remote_control_start")
}

/** Stop the inbound listener. Idempotent. */
export async function remoteControlStop(): Promise<void> {
  await transport.call<void>("remote_control_stop")
}

/**
 * Read the current bearer token. Backed by the OS keyring on desktop. Used
 * sparingly — the UI fetches once when the user clicks "Reveal" / "Copy".
 *
 * Returns `null` when no token has been generated yet.
 */
export async function remoteControlGetToken(): Promise<string | null> {
  return transport.call<string | null>("remote_control_get_token")
}

/** Generate a fresh token and persist it. Returns the new value. */
export async function remoteControlRotateToken(): Promise<string> {
  return transport.call<string>("remote_control_rotate_token")
}

/** Persist non-secret config (port, allowlist, rate limit, custom headers, signing-secret presence flag). */
export async function remoteControlUpdateConfig(config: RemoteControlConfig): Promise<void> {
  await transport.call<void>("remote_control_update_config", { config })
}

/**
 * Set the outbound HMAC signing secret. Pass `null` to clear it. The plain
 * value lives in the OS keyring; only `hasSigningSecret: boolean` flows back
 * to the renderer.
 */
export async function remoteControlSetSigningSecret(secret: string | null): Promise<void> {
  await transport.call<void>("remote_control_set_signing_secret", { secret })
}

/**
 * Read the outbound signing secret. Used by `getOutboundConfig()` in the
 * notification-integration helper just before each outbound webhook delivery
 * so the secret never has to live in any TS-side store.
 */
export async function remoteControlGetSigningSecret(): Promise<string | null> {
  return transport.call<string | null>("remote_control_get_signing_secret")
}

/**
 * Answer a GET read the inbound server requested via `remote-control://query`.
 * `payload` is the renderer's Dexie read result (PII-gated). Unknown /
 * already-timed-out request ids are a silent no-op on the Rust side.
 */
export async function remoteControlQueryResponse(
  requestId: string,
  payload: unknown
): Promise<void> {
  await transport.call<void>("remote_control_query_response", { requestId, payload })
}

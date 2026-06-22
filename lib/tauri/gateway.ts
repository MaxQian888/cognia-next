/**
 * Tauri-side wrappers for the inbound LLM gateway.
 *
 * The axum HTTP server, OS-keyring-backed bearer token, protocol
 * translation, and the routing snapshot live in `src-tauri/src/gateway/`.
 * Frontend code never calls Tauri IPC directly — every boundary goes through
 * this module so error normalization and typed signatures stay in one place.
 *
 * Snake-cased command names match `generate_handler!` in `lib.rs`.
 */

import { transport } from "@/lib/tauri"
import type {
  GatewayConfig,
  GatewayRoutingSnapshot,
  GatewaySnapshotEntry,
  GatewayStatus,
} from "@/types/gateway"

export async function gatewayGetStatus(): Promise<GatewayStatus> {
  return transport.call<GatewayStatus>("gateway_get_status")
}

export async function gatewayUpdateConfig(config: GatewayConfig): Promise<void> {
  await transport.call<void>("gateway_update_config", { config })
}

/** Start the listener using the persisted config. */
export async function gatewayStart(): Promise<void> {
  await transport.call<void>("gateway_start")
}

/** Stop the listener. */
export async function gatewayStop(): Promise<void> {
  await transport.call<void>("gateway_stop")
}

/** Read the current bearer token (OS keyring). `null` when none generated. */
export async function gatewayGetToken(): Promise<string | null> {
  return transport.call<string | null>("gateway_get_token")
}

/** Generate + persist a fresh token. Returns the new value. */
export async function gatewayRotateToken(): Promise<string> {
  return transport.call<string>("gateway_rotate_token")
}

/** Delete the persisted bearer token from the OS keyring. */
export async function gatewayClearToken(): Promise<void> {
  await transport.call<void>("gateway_clear_token")
}

/**
 * Push the renderer's routing + credential snapshot into the live server.
 * The snapshot carries API keys — they stay in Rust memory only.
 */
export async function gatewayPushSnapshot(snapshot: GatewayRoutingSnapshot): Promise<void> {
  await transport.call<void>("gateway_push_snapshot", { snapshot })
}

/**
 * Answer a `gateway://decide` request with the live routing engine's
 * pre-ordered candidate chain. An empty list leaves the gateway to fall back
 * to its snapshot.
 */
export async function gatewayDecisionResponse(
  requestId: string,
  entries: GatewaySnapshotEntry[]
): Promise<void> {
  await transport.call<void>("gateway_decision_response", { requestId, entries })
}

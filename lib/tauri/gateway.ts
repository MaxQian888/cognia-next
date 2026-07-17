/**
 * Tauri-side wrappers for the inbound LLM gateway.
 *
 * The axum HTTP server, keyring-backed scoped API keys, protocol translation,
 * and the routing snapshot live in `src-tauri/src/gateway/`. Frontend code
 * never calls Tauri IPC directly — every boundary goes through this module so
 * error normalization and typed signatures stay in one place.
 *
 * Snake-cased command names match `generate_handler!` in `lib.rs`.
 */

import { transport } from "@/lib/tauri"
import type {
  GatewayApiKey,
  GatewayApiKeyPatch,
  GatewayApiKeyRedacted,
  GatewayConfig,
  GatewayKeyCooldown,
  GatewayRoutingSnapshot,
  GatewaySnapshotEntry,
  GatewayStatus,
} from "@/types/gateway"

export async function gatewayGetStatus(): Promise<GatewayStatus> {
  return transport.call<GatewayStatus>("gateway_get_status")
}

/** Read the persisted config so the settings UI hydrates from saved values. */
export async function gatewayGetConfig(): Promise<GatewayConfig> {
  return transport.call<GatewayConfig>("gateway_get_config")
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

// ---- API keys ---------------------------------------------------------------

/** List keys with secrets redacted to a fingerprint. */
export async function gatewayListKeys(): Promise<GatewayApiKeyRedacted[]> {
  return transport.call<GatewayApiKeyRedacted[]>("gateway_list_keys")
}

/**
 * Create a scoped key. Returns the FULL key (secret included) so the UI can
 * show it once for copying — subsequent lists are redacted.
 */
export async function gatewayCreateKey(input: {
  name: string
  modelAllowlist: string[]
  expiresAtMs: number | null
  rateLimitPerMin: number | null
  quotaTokens?: number | null
}): Promise<GatewayApiKey> {
  return transport.call<GatewayApiKey>("gateway_create_key", {
    name: input.name,
    modelAllowlist: input.modelAllowlist,
    expiresAtMs: input.expiresAtMs,
    rateLimitPerMin: input.rateLimitPerMin,
    quotaTokens: input.quotaTokens ?? null,
  })
}

export async function gatewayUpdateKey(id: string, patch: GatewayApiKeyPatch): Promise<void> {
  await transport.call<void>("gateway_update_key", { id, patch })
}

export async function gatewayDeleteKey(id: string): Promise<void> {
  await transport.call<void>("gateway_delete_key", { id })
}

/** Zero a key's consumed-quota counter (the "reset usage" action). */
export async function gatewayResetKeyQuota(id: string): Promise<void> {
  await transport.call<void>("gateway_reset_key_quota", { id })
}

/** Reveal a key's full secret (explicit user action). */
export async function gatewayRevealKey(id: string): Promise<string | null> {
  return transport.call<string | null>("gateway_reveal_key", { id })
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

/**
 * List pooled upstream keys currently cooling (429/529) or permanently disabled
 * (401 / quota — W1.1 + W3.1). Secrets are fingerprinted, never returned whole.
 */
export async function gatewayListCooldowns(): Promise<GatewayKeyCooldown[]> {
  return transport.call<GatewayKeyCooldown[]>("gateway_list_cooldowns")
}

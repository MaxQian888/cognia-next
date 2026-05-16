// Codex OAuth state-machine helpers + thin wrappers around the four Tauri
// commands defined in `src-tauri/src/codex_subscription/commands.rs`.
//
// The renderer drives the device-code flow:
//   1. `requestDeviceCode()` — surfaces user_code + verification_uri.
//   2. Render those for the user; open a browser to verification_uri.
//   3. `pollDeviceCode(deviceCode)` on a tick (respect `interval`).
//   4. On `Granted` → call `tokenResponseToCredential` and persist via
//      `saveCodexCredential`.

import { transport } from "@/lib/tauri"
import {
  CODEX_DEVICE_CODE_DEFAULT_INTERVAL_MS,
  CODEX_DEVICE_CODE_MAX_DURATION_MS,
} from "./constants"
import type {
  CodexCredential,
  DeviceCodePendingPayload,
  DeviceCodeResponse,
  PollOutcome,
  TokenResponse,
} from "./types"

export async function requestCodexDeviceCode(): Promise<DeviceCodeResponse> {
  return await transport.call<DeviceCodeResponse>("codex_sub_request_device_code")
}

export async function pollCodexDeviceCode(deviceCode: string): Promise<PollOutcome> {
  return await transport.call<PollOutcome>("codex_sub_poll_device_code", {
    deviceCode,
  })
}

export async function refreshCodexToken(refreshToken: string): Promise<TokenResponse> {
  return await transport.call<TokenResponse>("codex_sub_refresh", {
    refreshToken,
  })
}

export async function revokeCodexToken(token: string): Promise<void> {
  await transport.call("codex_sub_revoke", { token })
}

/**
 * Render a freshly granted token response as a persistable `CodexCredential`.
 * Computes `expiresAtMs` from `expires_in` (server seconds + now).
 *
 * `previous` is the credential whose `refresh_token` was used to obtain
 * `response`. When the server doesn't rotate `refresh_token` we keep the
 * previous one — otherwise the new one wins. The same applies to
 * `idTokenRaw` (refresh responses sometimes omit it).
 */
export function tokenResponseToCredential(
  response: TokenResponse,
  options: {
    authMode?: CodexCredential["authMode"]
    previous?: CodexCredential | null
    nowMs?: number
  } = {}
): CodexCredential {
  const now = options.nowMs ?? Date.now()
  const authMode: CodexCredential["authMode"] =
    options.authMode ?? options.previous?.authMode ?? "chatgpt"
  const expiresAtMs =
    response.expires_in && response.expires_in > 0 ? now + response.expires_in * 1000 : 0
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token ?? options.previous?.refreshToken ?? "",
    idTokenRaw: response.id_token ?? options.previous?.idTokenRaw ?? "",
    expiresAtMs,
    authMode,
    email: options.previous?.email,
    chatgptPlanType: options.previous?.chatgptPlanType,
    chatgptUserId: options.previous?.chatgptUserId,
    accountId: options.previous?.accountId,
    originalSource: options.previous?.originalSource ?? "oauth",
    storedAtMs: now,
  }
}

/** Helper for the renderer poll loop — server's `interval` is in seconds. */
export function intervalMsFromResponse(res: DeviceCodeResponse): number {
  if (!res.interval || res.interval <= 0) {
    return CODEX_DEVICE_CODE_DEFAULT_INTERVAL_MS
  }
  return res.interval * 1000
}

/** `expires_in` (seconds) → absolute deadline (ms epoch). */
export function deadlineMsFromResponse(
  res: DeviceCodeResponse,
  nowMs: number = Date.now()
): number {
  if (!res.expires_in || res.expires_in <= 0) {
    return nowMs + CODEX_DEVICE_CODE_MAX_DURATION_MS
  }
  return nowMs + res.expires_in * 1000
}

export function pollOutcomeKind(outcome: PollOutcome): "pending" | "granted" {
  if (typeof outcome === "object" && outcome !== null && "Granted" in outcome) {
    return "granted"
  }
  return "pending"
}

export function pollOutcomePayload(outcome: PollOutcome): DeviceCodePendingPayload | TokenResponse {
  if (typeof outcome === "object" && outcome !== null && "Granted" in outcome) {
    return outcome.Granted
  }
  // We've already established this is pending — safe cast.
  return (outcome as { Pending: DeviceCodePendingPayload }).Pending
}

/**
 * Boolean predicate the renderer uses to decide whether to keep polling
 * after a `Pending` outcome. `expired_token` and `access_denied` are
 * terminal; the others should keep looping.
 */
export function pendingIsTerminal(pending: DeviceCodePendingPayload): boolean {
  return pending.error === "expired_token" || pending.error === "access_denied"
}

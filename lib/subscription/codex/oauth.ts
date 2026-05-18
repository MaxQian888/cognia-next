// Codex OAuth state-machine helpers + thin wrappers around the four Tauri
// commands defined in `src-tauri/src/subscription/codex/commands.rs`.
//
// The renderer drives the device-code flow:
//   1. `requestCodexDeviceCode()` — surfaces user_code + verification_uri.
//   2. Render those for the user; open a browser to verification_uri.
//   3. `pollCodexDeviceCode(deviceCode)` on a tick (respect `interval`).
//   4. On `Granted` → call `tokenResponseToCredential` and persist via
//      `subscription_save_account` → `subscription_set_active`.

import type { CodexCredentialData, ProviderCredential } from "../core/types"
import {
  codexOauthPollDeviceCode,
  codexOauthRefresh,
  codexOauthRequestDeviceCode,
  codexOauthRevoke,
  type DeviceCodePendingPayload,
  type DeviceCodeResponse,
  type PollOutcome,
  type TokenResponse,
} from "../core/transport"
import {
  CODEX_CREDENTIAL_FRESH_GRACE_MS,
  CODEX_DEVICE_CODE_DEFAULT_INTERVAL_MS,
  CODEX_DEVICE_CODE_MAX_DURATION_MS,
} from "./constants"

export type { DeviceCodePendingPayload, DeviceCodeResponse, PollOutcome, TokenResponse }

export async function requestCodexDeviceCode(): Promise<DeviceCodeResponse> {
  return await codexOauthRequestDeviceCode()
}

export async function pollCodexDeviceCode(deviceCode: string): Promise<PollOutcome> {
  return await codexOauthPollDeviceCode(deviceCode)
}

export async function refreshCodexToken(refreshToken: string): Promise<TokenResponse> {
  return await codexOauthRefresh(refreshToken)
}

export async function revokeCodexToken(token: string): Promise<void> {
  await codexOauthRevoke(token)
}

/**
 * Render a freshly granted token response as a persistable `CodexCredentialData`.
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
    authMode?: CodexCredentialData["authMode"]
    previous?: CodexCredentialData | null
    nowMs?: number
  } = {}
): CodexCredentialData {
  const now = options.nowMs ?? Date.now()
  const authMode: CodexCredentialData["authMode"] =
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

/**
 * Pack a `CodexCredentialData` into a `ProviderCredential` tagged union — the
 * shape `subscription_save_account` expects.
 */
export function toProviderCredential(c: CodexCredentialData): ProviderCredential {
  return { provider: "codex", ...c }
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

/**
 * `true` when a stored Codex credential is usable right now. For `chatgpt`
 * mode this means the access token hasn't expired (with a 60-second grace
 * by default). For `api_key` mode the credential never expires locally —
 * `true` as long as `accessToken` is non-empty.
 */
export function isCodexCredentialFresh(
  credential: CodexCredentialData | null,
  nowMs: number = Date.now(),
  graceMs: number = CODEX_CREDENTIAL_FRESH_GRACE_MS
): boolean {
  if (!credential || !credential.accessToken) return false
  if (credential.authMode === "api_key") return true
  if (credential.expiresAtMs === 0) return true
  return credential.expiresAtMs - graceMs > nowMs
}

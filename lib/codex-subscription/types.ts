// Type definitions shared across the Codex (OpenAI) subscription subsystem.
// Mirrors the Rust struct in `src-tauri/src/codex_subscription/credential.rs`
// and the `DiscoveredCodexAuth` payload returned by `codex_sub_discover`.

/**
 * Two operating modes:
 *  - `"chatgpt"` — ChatGPT-issued bearer JWT + refresh_token (parallel to
 *    Claude's Pro/Max subscription path).
 *  - `"api_key"` — bare OpenAI API key, no refresh, no expiry.
 */
export type CodexAuthMode = "chatgpt" | "api_key"

/**
 * Where a credential was originally adopted from. Used by the Account tab
 * so the user can see whether the bearer in our keyring came from their
 * existing codex-cli install or from a fresh device-code login.
 */
export type CodexCredentialSource = "file" | "keyring" | "oauth"

/**
 * Persisted shape of a Codex credential. Stored as JSON inside a single
 * keyring entry (`com.cognia.codex-subscription/v1` / account `default`).
 *
 * Field names match the Rust struct's `serde(rename = ...)` attributes so
 * the wire format is stable across the IPC boundary.
 */
export interface CodexCredential {
  /** Either the ChatGPT bearer JWT or the raw OpenAI API key. */
  accessToken: string
  /** Long-lived refresh token. Empty in api-key mode. */
  refreshToken: string
  /** id_token JWT verbatim. Empty in api-key mode. */
  idTokenRaw: string
  /** Absolute expiry, ms epoch. 0 when not applicable (api-key mode). */
  expiresAtMs: number
  /** `"chatgpt"` or `"api_key"`. */
  authMode: CodexAuthMode
  /** Optional account email surfaced in the Account tab. */
  email?: string
  /** ChatGPT plan ("free" | "plus" | "pro" | "team" | "enterprise" | ...). */
  chatgptPlanType?: string
  /** Optional ChatGPT user id. */
  chatgptUserId?: string
  /** Optional organization/account id. */
  accountId?: string
  /** Where this credential was first adopted from. */
  originalSource?: CodexCredentialSource
  /** When this record was last written (ms epoch). */
  storedAtMs: number
}

/**
 * Source we found a codex-cli credential at. Returned by the discovery IPC.
 */
export type CodexDiscoverySource = "file" | "keyring"

/**
 * One probe result from `codex_sub_discover`. The renderer shows this
 * directly in the "Reuse" mode of the login dialog.
 */
export interface DiscoveredCodexAuth {
  source: CodexDiscoverySource
  /** Resolved absolute path to `auth.json` even when source==="keyring". */
  authJsonPath: string
  /** `"ChatGPT"` or `"ApiKey"` exactly as codex-cli serialises it. */
  authMode?: string
  openaiApiKey?: string
  tokens?: DiscoveredCodexTokens
  /** `last_refresh` parsed as ISO-8601, when present. */
  lastRefreshIso?: string
}

export interface DiscoveredCodexTokens {
  accessToken: string
  refreshToken: string
  /** id_token JWT verbatim. */
  idTokenRaw: string
  accountId?: string
  email?: string
  chatgptPlanType?: string
  chatgptUserId?: string
  chatgptAccountId?: string
}

/**
 * Settings that drive the Codex subscription subsystem. Lives under
 * `AppSettings.codexSubscriptionSettings`.
 */
export interface CodexSubscriptionSettings {
  /**
   * When `true` (default), env-builder reads the discovered codex-cli
   * credential live whenever our own keyring is empty; flipping this off
   * forces the user through the explicit Adopt flow before any token is
   * propagated to the external codex agent.
   */
  preferDiscovered: boolean
  /**
   * When `true`, refresh the bearer automatically when it's within ~5 min
   * of expiry instead of waiting for the next failed call.
   */
  autoRefreshNearExpiry: boolean
}

export const DEFAULT_CODEX_SUBSCRIPTION_SETTINGS: CodexSubscriptionSettings = {
  preferDiscovered: true,
  autoRefreshNearExpiry: true,
}

/**
 * Response shape of `codex_sub_request_device_code`. Mirrors the OAuth
 * spec — the renderer renders `userCode` for the user to type and
 * `verificationUri` (or `verificationUriComplete`, when provided) as the
 * URL/QR they need to visit.
 */
export interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete?: string
  expires_in: number
  interval: number
}

/** OAuth-spec pending response codes the renderer recognises. */
export type DeviceCodePendingCode =
  | "authorization_pending"
  | "slow_down"
  | "expired_token"
  | "access_denied"
  | string

export interface DeviceCodePendingPayload {
  error: DeviceCodePendingCode
  error_description?: string
}

/**
 * Discriminated union the renderer uses to advance the poll loop. Granted
 * means the credential can be persisted; pending means keep polling
 * (unless `error` is `expired_token` / `access_denied`).
 */
export type PollOutcome = { Pending: DeviceCodePendingPayload } | { Granted: TokenResponse }

export interface TokenResponse {
  access_token: string
  refresh_token?: string
  id_token?: string
  token_type?: string
  expires_in?: number
  scope?: string
}

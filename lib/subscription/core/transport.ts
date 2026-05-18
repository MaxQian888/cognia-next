// Typed Tauri command wrappers for the ADR-0025 unified subscription module.
//
// Routes everything through the module-scope `transport` from `@/lib/tauri`
// so Capacitor mode (M2.7) can proxy these to the desktop's keyring through
// the companion API. Eighteen commands total:
//   - 10 shared CRUD + active + preset
//   - 1 Anthropic (PKCE save hook)
//   - 5 Codex OAuth (discover + 4 device-code steps)
//   - 2 OpenCode (discover + save zen key)

import { transport } from "@/lib/tauri"

import type {
  Account,
  AccountSummary,
  ActiveSnapshot,
  AnthropicCredentialData,
  MigrationOutcome,
  ProviderId,
  ProviderPreset,
} from "./types"

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/**
 * Run v1 → v2 migration for every provider in one shot. Idempotent — the
 * Rust side detects already-migrated accounts and returns `AlreadyMigrated`
 * without duplicating. Called once on app boot from
 * `SubscriptionInitializer` in `app/layout.tsx`.
 */
export async function subscriptionInit(): Promise<MigrationOutcome[]> {
  return await transport.call<MigrationOutcome[]>("subscription_init")
}

// ---------------------------------------------------------------------------
// Account CRUD
// ---------------------------------------------------------------------------

export async function listAccounts(provider: ProviderId): Promise<AccountSummary[]> {
  return await transport.call<AccountSummary[]>("subscription_list_accounts", { provider })
}

export async function getAccount(provider: ProviderId, accountId: string): Promise<Account | null> {
  const got = await transport.call<Account | null>("subscription_get_account", {
    provider,
    accountId,
  })
  return got ?? null
}

export async function saveAccount(provider: ProviderId, account: Account): Promise<void> {
  await transport.call("subscription_save_account", { provider, account })
}

export async function deleteAccount(provider: ProviderId, accountId: string): Promise<void> {
  await transport.call("subscription_delete_account", { provider, accountId })
}

export async function renameAccount(
  provider: ProviderId,
  accountId: string,
  label: string | null
): Promise<void> {
  await transport.call("subscription_rename_account", {
    provider,
    accountId,
    label,
  })
}

// ---------------------------------------------------------------------------
// Active pointer
// ---------------------------------------------------------------------------

/**
 * Set or clear the active account for a provider.
 *
 * For Anthropic: also pushes the resolved OAuth bearer into the in-process
 * `ApiKeyState` and kills the sidecar so the next spawn sees the new env.
 * For Codex / OpenCode: the env-builder reads `ActiveAccountState` directly
 * at the next external-agent spawn — no sidecar restart needed.
 */
export async function setActiveAccount(
  provider: ProviderId,
  accountId: string | null
): Promise<void> {
  await transport.call("subscription_set_active", { provider, accountId })
}

export async function getActiveAccount(provider: ProviderId): Promise<ActiveSnapshot> {
  return await transport.call<ActiveSnapshot>("subscription_get_active", { provider })
}

// ---------------------------------------------------------------------------
// Provider preset
// ---------------------------------------------------------------------------

export async function getProviderPreset(provider: ProviderId): Promise<ProviderPreset | null> {
  const got = await transport.call<ProviderPreset | null>("subscription_get_preset", { provider })
  return got ?? null
}

export async function setProviderPreset(
  provider: ProviderId,
  preset: ProviderPreset | null
): Promise<void> {
  await transport.call("subscription_set_preset", { provider, preset })
}

// ---------------------------------------------------------------------------
// Anthropic (PKCE save hook)
// ---------------------------------------------------------------------------

/**
 * Persist the result of a successful TS-side PKCE exchange. The renderer
 * holds the access/refresh tokens after the PKCE round-trip and posts them
 * down here; Rust validates + appends to the Anthropic vault.
 *
 * `label` is the optional user-provided alias; pass `null` and the Rust side
 * derives one from plan + email claims.
 */
export async function anthropicOauthSavePkceResult(
  payload: AnthropicCredentialData,
  label: string | null = null
): Promise<Account> {
  return await transport.call<Account>("anthropic_oauth_save_pkce_result", {
    payload,
    label,
  })
}

// ---------------------------------------------------------------------------
// Codex (device-code OAuth + discovery)
// ---------------------------------------------------------------------------

/** Outcome of probing for an existing codex-cli credential. */
export interface DiscoveredCodexAuth {
  source: "file" | "keyring"
  authJsonPath: string
  authMode?: string
  openaiApiKey?: string
  tokens?: DiscoveredCodexTokens
  lastRefreshIso?: string
}

export interface DiscoveredCodexTokens {
  accessToken: string
  refreshToken: string
  idTokenRaw: string
  accountId?: string
  email?: string
  chatgptPlanType?: string
  chatgptUserId?: string
  chatgptAccountId?: string
}

export async function codexOauthDiscover(): Promise<DiscoveredCodexAuth | null> {
  const got = await transport.call<DiscoveredCodexAuth | null>("codex_oauth_discover")
  return got ?? null
}

export interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete?: string
  expires_in: number
  interval: number
}

export interface TokenResponse {
  access_token: string
  refresh_token?: string
  id_token?: string
  token_type?: string
  expires_in?: number
  scope?: string
}

export interface DeviceCodePendingPayload {
  error: string
  error_description?: string
}

export type PollOutcome = { Pending: DeviceCodePendingPayload } | { Granted: TokenResponse }

export async function codexOauthRequestDeviceCode(): Promise<DeviceCodeResponse> {
  return await transport.call<DeviceCodeResponse>("codex_oauth_request_device_code")
}

export async function codexOauthPollDeviceCode(deviceCode: string): Promise<PollOutcome> {
  return await transport.call<PollOutcome>("codex_oauth_poll_device_code", { deviceCode })
}

export async function codexOauthRefresh(refreshToken: string): Promise<TokenResponse> {
  return await transport.call<TokenResponse>("codex_oauth_refresh", { refreshToken })
}

export async function codexOauthRevoke(token: string): Promise<void> {
  await transport.call("codex_oauth_revoke", { token })
}

// ---------------------------------------------------------------------------
// OpenCode (discovery + paste-zen-key)
// ---------------------------------------------------------------------------

export interface DiscoveredOpencodeEntry {
  /** Whitelist value: "anthropic" | "openai" | "opencode-zen". */
  subProvider: string
  /** "api-key" | "oauth" | "unknown". */
  kind: string
  /** Verbatim JSON object for this sub-provider's entry. */
  payloadJson: string
}

export interface DiscoveredOpencodeAuth {
  /** Resolved path that was read (or would have been read). */
  authJsonPath: string
  /** Whitelisted sub-providers actually present in auth.json. */
  entries: DiscoveredOpencodeEntry[]
}

export async function opencodeOauthDiscover(): Promise<DiscoveredOpencodeAuth | null> {
  const got = await transport.call<DiscoveredOpencodeAuth | null>("opencode_oauth_discover")
  return got ?? null
}

export async function opencodeSaveZenKey(
  accessToken: string,
  baseUrl: string | null,
  label: string | null = null
): Promise<Account> {
  return await transport.call<Account>("opencode_save_zen_key", {
    accessToken,
    baseUrl,
    label,
  })
}

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
import { markSubscriptionVaultChanged } from "@/lib/subscription/sync/change-tracker"
import { notifySubscriptionChanged } from "@/lib/subscription/core/subscription-events"
import { useAccountStore } from "@/stores/account/account-store"

import type {
  Account,
  AccountSummary,
  ActiveSnapshot,
  AnthropicCredentialData,
  MigrationOutcome,
  ProviderId,
  ProviderPreset,
} from "@/types/subscription"

/**
 * Stamp the vault dirty-marker after a successful mutating command so the
 * WebDAV cloud sync (when enabled) schedules a debounced unattended upload.
 */
function vaultMutated(): void {
  markSubscriptionVaultChanged()
  notifySubscriptionChanged()
}

function requireLocalAccountId(): string {
  const localAccountId = useAccountStore.getState().unlockedAccountId
  if (!localAccountId) {
    throw new Error("A local account must be unlocked before subscription credentials can be used.")
  }
  return localAccountId
}

function subscriptionScope(): { localAccountId: string } {
  return { localAccountId: requireLocalAccountId() }
}

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
  return await transport.call<MigrationOutcome[]>("subscription_init", subscriptionScope())
}

// ---------------------------------------------------------------------------
// Account CRUD
// ---------------------------------------------------------------------------

export async function listAccounts(provider: ProviderId): Promise<AccountSummary[]> {
  return await transport.call<AccountSummary[]>("subscription_list_accounts", {
    provider,
    ...subscriptionScope(),
  })
}

export async function getAccount(provider: ProviderId, accountId: string): Promise<Account | null> {
  const got = await transport.call<Account | null>("subscription_get_account", {
    provider,
    ...subscriptionScope(),
    accountId,
  })
  return got ?? null
}

export async function saveAccount(provider: ProviderId, account: Account): Promise<void> {
  await transport.call("subscription_save_account", { provider, ...subscriptionScope(), account })
  vaultMutated()
}

export async function deleteAccount(
  provider: ProviderId,
  accountId: string,
  replacementAccountId: string | null = null
): Promise<void> {
  await transport.call("subscription_delete_account", {
    provider,
    ...subscriptionScope(),
    accountId,
    replacementAccountId,
  })
  vaultMutated()
}

export async function renameAccount(
  provider: ProviderId,
  accountId: string,
  label: string | null
): Promise<void> {
  await transport.call("subscription_rename_account", {
    provider,
    ...subscriptionScope(),
    accountId,
    label,
  })
  vaultMutated()
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
  await transport.call("subscription_set_active", { provider, ...subscriptionScope(), accountId })
  vaultMutated()
}

/**
 * Clear every in-process provider credential owned by one local Cognia
 * account. Unlike the vault-scoped helpers this accepts the scope explicitly:
 * local-account lock/switch calls it before clearing `unlockedAccountId`.
 */
export async function clearSubscriptionRuntime(localAccountId: string): Promise<void> {
  if (!localAccountId.trim()) throw new Error("localAccountId must not be empty")
  await transport.call("subscription_clear_runtime", { localAccountId })
}

export async function getActiveAccount(provider: ProviderId): Promise<ActiveSnapshot> {
  return await transport.call<ActiveSnapshot>("subscription_get_active", {
    provider,
    ...subscriptionScope(),
  })
}

// ---------------------------------------------------------------------------
// Provider preset
// ---------------------------------------------------------------------------

export async function getProviderPreset(provider: ProviderId): Promise<ProviderPreset | null> {
  const got = await transport.call<ProviderPreset | null>("subscription_get_preset", {
    provider,
    ...subscriptionScope(),
  })
  return got ?? null
}

export async function setProviderPreset(
  provider: ProviderId,
  preset: ProviderPreset | null
): Promise<void> {
  await transport.call("subscription_set_preset", { provider, ...subscriptionScope(), preset })
  vaultMutated()
}

// ---------------------------------------------------------------------------
// Preset library (v3 — multiple presets per provider, per-account binding)
// ---------------------------------------------------------------------------

/** Enumerate every preset in the provider's vault. */
export async function listPresets(provider: ProviderId): Promise<ProviderPreset[]> {
  return await transport.call<ProviderPreset[]>("subscription_list_presets", {
    provider,
    ...subscriptionScope(),
  })
}

/** Upsert a preset by id into the provider's library. */
export async function saveProviderPreset(
  provider: ProviderId,
  preset: ProviderPreset
): Promise<void> {
  await transport.call("subscription_save_preset", { provider, ...subscriptionScope(), preset })
  vaultMutated()
}

/** Remove a preset by id; also clears the default + any account bindings to it. */
export async function deleteProviderPreset(provider: ProviderId, presetId: string): Promise<void> {
  await transport.call("subscription_delete_preset", {
    provider,
    ...subscriptionScope(),
    presetId,
  })
  vaultMutated()
}

/** Set or clear the provider-level default preset id. */
export async function setDefaultPreset(
  provider: ProviderId,
  presetId: string | null
): Promise<void> {
  await transport.call("subscription_set_default_preset", {
    provider,
    ...subscriptionScope(),
    presetId,
  })
  vaultMutated()
}

// ---------------------------------------------------------------------------
// Authed HTTP passthrough (CORS-free; used by balance-query adapters in
// Phase 3). The Rust side performs the GET with reqwest and returns the raw
// response body as text; the renderer's adapter parses it.
// ---------------------------------------------------------------------------

export async function authedGet(
  url: string,
  headers: Record<string, string> = {}
): Promise<string> {
  const entries = Object.entries(headers).map(([name, value]) => ({ name, value }))
  return await transport.call<string>("subscription_authed_get", { url, headers: entries })
}

export interface AuthedHttpRequest {
  url: string
  method?: "GET" | "POST"
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  maxBodyBytes?: number
}

export interface AuthedHttpHeader {
  name: string
  value: string
}

export interface AuthedHttpResponse {
  status: number
  headers: AuthedHttpHeader[]
  body: string
}

/**
 * Typed CORS-free transport for balance and quota sources. Unlike the legacy
 * GET wrapper, non-2xx responses are returned intact so adapters can classify
 * authentication, quota, and rate-limit failures without parsing error text.
 */
export async function authedRequest(request: AuthedHttpRequest): Promise<AuthedHttpResponse> {
  const headers = Object.entries(request.headers ?? {}).map(([name, value]) => ({ name, value }))
  return await transport.call<AuthedHttpResponse>("subscription_authed_request", {
    request: {
      url: request.url,
      method: request.method ?? "GET",
      headers,
      body: request.body,
      timeoutMs: request.timeoutMs ?? 15_000,
      maxBodyBytes: request.maxBodyBytes ?? 1_048_576,
    },
  })
}

/** One usage window returned by `subscription_volcengine_usage`. */
export interface VolcengineUsageTier {
  /** cognia meter id: "session" | "weekly" | "monthly". */
  name: string
  /** Used percent (0-100). */
  utilization: number
  /** ISO-8601 reset time, when known. */
  resets_at?: string | null
}

/** Result of the Volcengine (火山方舟) Agent/Coding Plan usage query. */
export interface VolcengineUsageResult {
  ok: boolean
  plan?: string | null
  tiers: VolcengineUsageTier[]
  error?: string | null
  /** `true` when the AK/SK were rejected (prompt the user to re-enter). */
  auth_error: boolean
}

/**
 * Query Volcengine Agent/Coding Plan usage via the Rust SigV4-signed OpenAPI
 * command. AK/SK are the Volcengine account AccessKey pair (distinct from the
 * inference bearer). Rejects only on transient transport errors.
 */
export async function volcengineUsage(
  accessKeyId: string,
  secretAccessKey: string,
  baseUrl: string
): Promise<VolcengineUsageResult> {
  return await transport.call<VolcengineUsageResult>("subscription_volcengine_usage", {
    accessKeyId,
    secretAccessKey,
    baseUrl,
  })
}

// ---------------------------------------------------------------------------
// Anthropic (PKCE save hook)
// ---------------------------------------------------------------------------

/**
 * Validate and construct the result of a successful TS-side PKCE exchange.
 * The renderer then passes the account to the generic atomic save command.
 *
 * `label` is the optional user-provided alias; pass `null` and the Rust side
 * derives one from plan + email claims.
 */
export async function anthropicOauthSavePkceResult(
  payload: AnthropicCredentialData,
  label: string | null = null
): Promise<Account> {
  const account = await transport.call<Account>("anthropic_oauth_save_pkce_result", {
    ...subscriptionScope(),
    payload,
    label,
  })
  return account
}

// ---------------------------------------------------------------------------
// Anthropic (discovery of an existing Claude Code CLI login)
// ---------------------------------------------------------------------------

/**
 * Outcome of probing for an existing Claude Code CLI subscription login
 * (`~/.claude/.credentials.json` or the `"Claude Code-credentials"` OS
 * keyring entry). Mirrors `subscription::anthropic::discovery::
 * DiscoveredAnthropicAuth` field-for-field.
 */
export interface DiscoveredAnthropicAuth {
  source: "file" | "keyring"
  credentialsPath: string
  accessToken: string
  refreshToken: string
  /** Absolute expiry of the access token, ms epoch. 0 when absent. */
  expiresAtMs: number
  scopes: string[]
  /** "max" | "pro" | "team" | … as Claude Code serialises it. */
  subscriptionType?: string
  rateLimitTier?: string
}

export async function anthropicOauthDiscover(): Promise<DiscoveredAnthropicAuth | null> {
  const got = await transport.call<DiscoveredAnthropicAuth | null>("anthropic_oauth_discover")
  return got ?? null
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

export async function codexOauthPollDeviceCode(
  deviceCode: string,
  userCode: string
): Promise<PollOutcome> {
  const outcome = await transport.call<PollOutcome>("codex_oauth_poll_device_code", {
    ...subscriptionScope(),
    deviceCode,
    userCode,
  })
  // A granted poll persists the new account Rust-side — that's a mutation.
  if (outcome && "Granted" in outcome) vaultMutated()
  return outcome
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
  /**
   * Whitelist value: "anthropic" | "openai" | "opencode" | "opencode-go" |
   * "opencode-zen" (must stay in sync with `OPENCODE_WHITELIST`).
   */
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

/**
 * Adopt one discovered auth.json entry into the vault. Managed-plan keys
 * (opencode / opencode-go / opencode-zen) become usable Zen/Go accounts;
 * anthropic/openai (and OAuth-shaped) entries are snapshotted as
 * `opencode-discovered` accounts. The key is re-read host-side, so the secret
 * never crosses the renderer.
 */
export async function opencodeAdoptDiscovered(
  subProvider: string,
  accountId: string | null = null
): Promise<AccountSummary> {
  const account = await transport.call<AccountSummary>("opencode_adopt_discovered", {
    ...subscriptionScope(),
    subProvider,
    accountId,
  })
  vaultMutated()
  return account
}

export async function opencodeSaveZenKey(
  accessToken: string,
  baseUrl: string | null,
  label: string | null = null,
  plan: string | null = null
): Promise<Account> {
  const account = await transport.call<Account>("opencode_save_zen_key", {
    ...subscriptionScope(),
    accessToken,
    baseUrl,
    label,
    plan,
  })
  return account
}

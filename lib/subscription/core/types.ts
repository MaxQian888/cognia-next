// Unified subscription / OAuth credential type surface (ADR 0025).
//
// One file, three providers (anthropic, codex, opencode), N accounts per
// provider, one `ProviderVault` per provider in the OS keyring. Mirrors the
// Rust shapes in `src-tauri/src/subscription/vault.rs` field-for-field so the
// IPC wire format stays stable.

// ---------------------------------------------------------------------------
// Provider id
// ---------------------------------------------------------------------------

/**
 * Stable provider identifier. Used as the keyring `account` field for the
 * per-provider vault entry and as the discriminator throughout the
 * subscription module.
 */
export type ProviderId = "anthropic" | "codex" | "opencode"

export const ALL_PROVIDER_IDS: readonly ProviderId[] = ["anthropic", "codex", "opencode"] as const

// ---------------------------------------------------------------------------
// Provider-specific credential data shapes
// ---------------------------------------------------------------------------

/** Which Anthropic OAuth flow the credential came from. */
export type AnthropicAuthMode = "subscription" | "console"

/**
 * Anthropic PKCE credential. Mirrors `subscription::vault::AnthropicCredentialData`
 * in Rust and the v1 `SubscriptionCredential` shape we migrated from.
 */
export interface AnthropicCredentialData {
  accessToken: string
  refreshToken: string
  /** Absolute expiry, ms epoch. `Date.now() + expires_in * 1000`. */
  expiresAtMs: number
  mode: AnthropicAuthMode
  scope?: string
  email?: string
  /** "pro" | "max" | "team" | "console" | other. */
  plan?: string
  storedAtMs: number
}

/**
 * Two operating modes:
 *  - `"chatgpt"` — ChatGPT-issued bearer JWT + refresh_token.
 *  - `"api_key"` — bare OpenAI API key, no refresh, no expiry.
 */
export type CodexAuthMode = "chatgpt" | "api_key"

/**
 * Where a Codex credential was originally adopted from. Surfaced in the
 * Account tab so the user knows whether the bearer came from their existing
 * codex-cli install or from a fresh device-code login.
 */
export type CodexCredentialSource = "file" | "keyring" | "oauth"

/** Codex device-code / api-key credential. */
export interface CodexCredentialData {
  accessToken: string
  /** Empty in api-key mode. */
  refreshToken: string
  /** id_token JWT verbatim. Empty in api-key mode. */
  idTokenRaw: string
  /** Absolute expiry, ms epoch. 0 = not applicable (api-key mode). */
  expiresAtMs: number
  authMode: CodexAuthMode
  email?: string
  chatgptPlanType?: string
  chatgptUserId?: string
  accountId?: string
  originalSource?: CodexCredentialSource
  storedAtMs: number
}

/**
 * Pointer record for a credential cognia discovered inside the OpenCode CLI's
 * `auth.json`. Stored when the user clicks "Adopt" on a discovery row but
 * the underlying provider isn't one we know how to consume directly.
 *
 * Note: today's renderer flows turn an OpenCode discovery into either an
 * Anthropic account or a Codex account when the sub-provider matches — this
 * variant is the future-proofing slot for "opencode-zen via discovery"
 * (distinct from explicit paste-key Zen).
 */
export interface OpencodeDiscoveredData {
  /** "anthropic" | "openai" | "opencode-zen" — whitelisted sub-providers. */
  subProvider: string
  /** Resolved path to the source `auth.json`. */
  authJsonPath: string
  /** Verbatim JSON object for this sub-provider's entry, kept as a string. */
  originalPayloadJson: string
  lastSeenAtMs: number
}

/** Phase-1 OpenCode-Zen credential — paste-key flow until OAuth lands. */
export interface OpencodeZenData {
  accessToken: string
  /** Optional regional endpoint override. */
  baseUrl?: string
  storedAtMs: number
}

/**
 * Tagged union of every provider-specific credential shape. The discriminator
 * is `provider` — Rust serde uses `tag = "provider"` and `rename_all =
 * "kebab-case"`, so the wire values are exactly the strings below.
 */
export type ProviderCredential =
  | ({ provider: "anthropic" } & AnthropicCredentialData)
  | ({ provider: "codex" } & CodexCredentialData)
  | ({ provider: "opencode-discovered" } & OpencodeDiscoveredData)
  | ({ provider: "opencode-zen" } & OpencodeZenData)

/** Which `ProviderId` does a `ProviderCredential` belong to? */
export function providerIdForCredential(c: ProviderCredential): ProviderId {
  switch (c.provider) {
    case "anthropic":
      return "anthropic"
    case "codex":
      return "codex"
    case "opencode-discovered":
    case "opencode-zen":
      return "opencode"
  }
}

// ---------------------------------------------------------------------------
// Vault + Account
// ---------------------------------------------------------------------------

/** Provider preset — Anthropic + Codex only. Rejected for OpenCode. */
export interface ProviderPreset {
  /** UUIDv7. */
  id: string
  /** User-facing alias ("AWS Bedrock", "Azure OpenAI", "Custom proxy"). */
  label: string
  /** Base URL the provider's HTTP client targets instead of the default. */
  baseUrl: string
  /** Optional extra headers added on every request. */
  extraHeaders?: Record<string, string>
}

/** One credential entry in a provider's vault. */
export interface Account {
  /** UUIDv7. */
  id: string
  /** User-overridable alias. When absent, UI derives one from claims. */
  label?: string
  credential: ProviderCredential
  createdAtMs: number
  lastUsedAtMs: number
}

/**
 * Renderer-safe projection of `Account` — strips the secret bearer. Returned
 * by `subscription_list_accounts` so the account picker doesn't see any token
 * bytes unless the renderer explicitly fetches the full `Account` for an
 * edit dialog.
 */
export interface AccountSummary {
  id: string
  label?: string
  provider: ProviderId
  /**
   * Variant tag distinguishing OpenCode discovery rows from Zen rows:
   * "anthropic" | "codex" | "opencode-discovered" | "opencode-zen".
   */
  variant: "anthropic" | "codex" | "opencode-discovered" | "opencode-zen"
  email?: string
  plan?: string
  /** 0 when not applicable (api_key / opencode-zen). */
  expiresAtMs: number
  createdAtMs: number
  lastUsedAtMs: number
}

/** Top-level vault — one entry per provider in the keyring. */
export interface ProviderVault {
  schemaVersion: 2
  accounts: Account[]
  activeAccountId?: string
  preset?: ProviderPreset
}

// ---------------------------------------------------------------------------
// Active snapshot (subscription_get_active return shape)
// ---------------------------------------------------------------------------

/**
 * Snapshot of the in-process active state for one provider. The renderer
 * reads this via `subscription_get_active(provider)`; consumers like the
 * external-agent env-builder use it to compose spawn env.
 */
export interface ActiveSnapshot {
  activeAccountId?: string
  /**
   * Env-var pairs the spawning code should set. Pairs (not Record) so the
   * server-side preserves insertion order for deterministic merge behavior.
   */
  env: Array<[string, string]>
}

// ---------------------------------------------------------------------------
// Migration outcomes
// ---------------------------------------------------------------------------

/** Result of running `subscription_init` for one provider. */
export type MigrationOutcome =
  | { kind: "no-legacy-data"; provider: ProviderId }
  | { kind: "migrated"; provider: ProviderId; accountId: string }
  | { kind: "already-migrated"; provider: ProviderId }

// ---------------------------------------------------------------------------
// Anthropic usage tracking — Anthropic-only by design (ADR 0025 explicit
// non-goal of generalization). These types live here because they're
// referenced from both `subscription/anthropic/` and `lib/db/schema.ts`.
// ---------------------------------------------------------------------------

/** Passive vs probe sample lineage. */
export type UsageSource = "passive" | "probe"

/** Top-level `anthropic-ratelimit-unified-status` value. */
export type UsageStatus = "allowed" | "allowed_warning" | "rate_limited" | "unknown"

export type RepresentativeClaim = "five_hour" | "seven_day"

export interface UsageWindow {
  utilization: number
  resetAt: number
  status: string
}

export interface UsageSnapshot {
  fetchedAt: number
  source: UsageSource
  status: UsageStatus
  representativeClaim: RepresentativeClaim | null
  fiveHour: UsageWindow | null
  sevenDay: UsageWindow | null
  fallbackPercentage: number | null
  overageDisabledReason: string | null
  rawHeaders: Record<string, string>
}

export interface SubscriptionUsageRow extends UsageSnapshot {
  localId?: number
}

/** Anthropic-specific subscription settings (probe loop). */
export interface AnthropicSubscriptionSettings {
  probeEnabled: boolean
  visibleIntervalMs: number
  idleIntervalMs: number
  warnThresholdPct: number
}

export const DEFAULT_ANTHROPIC_SUBSCRIPTION_SETTINGS: AnthropicSubscriptionSettings = {
  probeEnabled: false,
  visibleIntervalMs: 5 * 60 * 1000,
  idleIntervalMs: 30 * 60 * 1000,
  warnThresholdPct: 90,
}

/** Codex-specific subscription settings. */
export interface CodexSubscriptionSettings {
  /**
   * When `true`, env-builder reads the live `~/.codex/auth.json` discovery
   * whenever our own vault has no active codex account. When `false`,
   * codex env stays empty until the user explicitly Adopts a discovered
   * credential.
   */
  preferDiscovered: boolean
  /** Refresh the bearer ~5min before expiry instead of waiting for failure. */
  autoRefreshNearExpiry: boolean
}

export const DEFAULT_CODEX_SUBSCRIPTION_SETTINGS: CodexSubscriptionSettings = {
  preferDiscovered: true,
  autoRefreshNearExpiry: true,
}

// ---------------------------------------------------------------------------
// Back-compat shape aliases — for files that import the v1 names while the
// renderer migration is in flight. Anything new should reach the v2 names
// above directly.
// ---------------------------------------------------------------------------

/** @deprecated use `AnthropicAuthMode` */
export type OAuthMode = AnthropicAuthMode
/** @deprecated use `AnthropicSubscriptionSettings` */
export type SubscriptionSettings = AnthropicSubscriptionSettings
/** @deprecated use `DEFAULT_ANTHROPIC_SUBSCRIPTION_SETTINGS` */
export const DEFAULT_SUBSCRIPTION_SETTINGS = DEFAULT_ANTHROPIC_SUBSCRIPTION_SETTINGS

/**
 * Render an `AccountSummary.variant` from a `ProviderCredential`. Used by
 * tests + the renderer when projecting accounts manually.
 */
export function variantOf(c: ProviderCredential): AccountSummary["variant"] {
  switch (c.provider) {
    case "anthropic":
      return "anthropic"
    case "codex":
      return "codex"
    case "opencode-discovered":
      return "opencode-discovered"
    case "opencode-zen":
      return "opencode-zen"
  }
}

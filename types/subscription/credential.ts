// Unified subscription / OAuth credential type surface (ADR 0025).
//
// Three providers (anthropic, codex, opencode), N accounts per provider, one
// `ProviderVault` per provider in the OS keyring. Mirrors the Rust shapes in
// `src-tauri/src/subscription/vault.rs` field-for-field so the IPC wire format
// stays stable.

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
  /**
   * "anthropic" | "openai" | "opencode" | "opencode-go" | "opencode-zen" —
   * whitelisted sub-providers.
   */
  subProvider: string
  /** Resolved path to the source `auth.json`. */
  authJsonPath: string
  /** Verbatim JSON object for this sub-provider's entry, kept as a string. */
  originalPayloadJson: string
  lastSeenAtMs: number
}

/** OpenCode managed-plan plan tag: pay-per-request Zen or flat-rate Go. */
export type OpencodePlan = "zen" | "go"

/**
 * OpenCode managed-subscription credential — paste-key flow until OAuth
 * lands. Covers both the Zen and Go plans; `plan` absent means "zen"
 * (accounts saved before the Go plan existed).
 */
export interface OpencodeZenData {
  accessToken: string
  /** Optional regional endpoint override. */
  baseUrl?: string
  /** "zen" | "go". Absent = "zen". */
  plan?: OpencodePlan
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

/** Variant tag distinguishing the four credential shapes in projections. */
export type AccountVariant = "anthropic" | "codex" | "opencode-discovered" | "opencode-zen"

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

/**
 * Render an `AccountSummary.variant` from a `ProviderCredential`. Used by
 * tests + the renderer when projecting accounts manually.
 */
export function variantOf(c: ProviderCredential): AccountVariant {
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

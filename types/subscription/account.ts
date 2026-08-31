// Vault + account shapes. Mirrors `src-tauri/src/subscription/vault.rs`
// field-for-field so the IPC wire format stays stable.

import type { AccountVariant, ProviderCredential, ProviderId } from "./credential"
import type { ProviderPreset } from "./preset"

export type CredentialHealth = "ready" | "expiring" | "reauth_required" | "source_unavailable"

/** Stable, non-secret identity used to prevent targeted Codex reauth account swaps. */
export interface CodexIdentityFingerprint {
  issuer?: string
  subject?: string
  workspaceId?: string
  email?: string
}

/** Persisted lifecycle facts. Transient network failures are intentionally not stored. */
export interface AccountAuthMetadata {
  codexIdentity?: CodexIdentityFingerprint
  reauthRequiredAtMs?: number
  reauthReason?: string
  lastCredentialRotationAtMs?: number
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
  /**
   * Per-account preset binding (v3). When set, the resolved env uses this
   * preset id; when absent, the provider-level `defaultPresetId` applies.
   */
  presetId?: string
  authMetadata?: AccountAuthMetadata
}

/**
 * Renderer-safe projection of `Account` — strips the secret bearer. Returned
 * by `subscription_list_accounts` so the account picker never receives token
 * bytes. Credential replacement and reauthentication use scoped operations.
 */
export interface AccountSummary {
  id: string
  label?: string
  provider: ProviderId
  /**
   * Variant tag distinguishing OpenCode discovery rows from Zen rows:
   * "anthropic" | "codex" | "opencode-discovered" | "opencode-zen".
   */
  variant: AccountVariant
  email?: string
  plan?: string
  /** 0 when not applicable (api_key / opencode-zen). */
  expiresAtMs: number
  createdAtMs: number
  lastUsedAtMs: number
  /** Provider-specific mode such as `chatgpt`, `api_key`, or `subscription`. */
  authMode: string
  /** `managed`, `oauth`, `file`, or `keyring`. */
  credentialSource: string
  health: CredentialHealth
  /** True for pointers/imports whose authoritative credential lives outside Cognia. */
  isExternal: boolean
  reauthReason?: string
}

/** Renderer-safe selected-account payload. It contains no credential bytes. */
export interface AccountDetail extends AccountSummary {
  presetId?: string
  codexIdentity?: CodexIdentityFingerprint
  lastCredentialRotationAtMs?: number
}

/** Top-level vault — one entry per provider in the keyring. */
export interface ProviderVault {
  schemaVersion: 4
  accounts: Account[]
  activeAccountId?: string
  /** Preset library (v3). Accounts bind to one by id; `defaultPresetId` is the fallback. */
  presets: ProviderPreset[]
  /** Provider-level default preset id (v3). Points at a `ProviderPreset.id` in `presets`. */
  defaultPresetId?: string
  /** @deprecated legacy v2 single preset — folded into `presets` by the v2→v3 migration. */
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

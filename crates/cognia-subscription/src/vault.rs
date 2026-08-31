// Provider-vault storage layer.
//
// One keyring entry per provider:
//   service = "com.cognia.subscription/v2"
//   account = "anthropic" | "codex" | "opencode"
//   payload = JSON blob shaped as `ProviderVault`
//
// `ProviderVault` holds N `Account`s, an optional `activeAccountId` pointer,
// and an optional `ProviderPreset`. The vault layer is responsible for keyring
// I/O and structural validation; provider-specific credential validation is
// delegated to `SubscriptionProvider::validate`.

use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::preset::ProviderPreset;
use crate::provider::ProviderId;

pub const SERVICE: &str = "com.cognia.subscription/v2";
pub const SCHEMA_VERSION: u32 = 4;
/// Serializes every provider-vault read-modify-write across the app and the
/// extracted subscription crate. A vault is persisted as one keyring blob, so
/// account-scoped locks alone cannot prevent updates to different accounts
/// from overwriting each other.
pub static VAULT_MUTATION_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const EXPIRING_WINDOW_MS: i64 = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Credential variants — provider-specific shapes. Fields mirror today's v1
// schemas verbatim so the migration is a straight wrap.
// ---------------------------------------------------------------------------

/// Anthropic credential (PKCE flow). Mirrors the v1 `SubscriptionCredential`
/// from `anthropic_subscription/credential.rs` field-for-field.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct AnthropicCredentialData {
    /// OAuth bearer. Sent as `Authorization: Bearer <token>`. Treat as secret.
    #[serde(rename = "accessToken")]
    pub access_token: String,
    /// Long-lived refresh token. May rotate on every refresh — callers must
    /// always persist the latest value returned by the token endpoint.
    #[serde(rename = "refreshToken")]
    pub refresh_token: String,
    /// Absolute expiry in ms epoch. `Date.now() + expires_in*1000` at exchange.
    #[serde(rename = "expiresAtMs")]
    pub expires_at_ms: i64,
    /// `"subscription"` (Pro/Max) or `"console"` (API billing).
    pub mode: String,
    /// OAuth scope string echoed from the server.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    /// Account email (optional — server may not return one).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    /// Plan label ("pro", "max", "team", "console").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    /// `"file"` or `"keyring"` when this account follows Claude Code's login.
    #[serde(
        rename = "originalSource",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub original_source: Option<String>,
    /// When this record was last written (ms epoch).
    #[serde(rename = "storedAtMs", default)]
    pub stored_at_ms: i64,
}

/// Codex credential (device-code flow). Mirrors the v1 `CodexCredential` from
/// `codex_subscription/credential.rs` field-for-field.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct CodexCredentialData {
    /// Either the ChatGPT bearer JWT or — for api_key mode — the raw key.
    #[serde(
        rename = "accessToken",
        default,
        skip_serializing_if = "String::is_empty"
    )]
    pub access_token: String,
    /// Long-lived refresh token (chatgpt mode only). May rotate.
    #[serde(
        rename = "refreshToken",
        default,
        skip_serializing_if = "String::is_empty"
    )]
    pub refresh_token: String,
    /// Raw id_token JWT verbatim (chatgpt mode only).
    #[serde(
        rename = "idTokenRaw",
        default,
        skip_serializing_if = "String::is_empty"
    )]
    pub id_token_raw: String,
    /// Absolute expiry in ms epoch. 0 = doesn't apply (api_key mode).
    #[serde(rename = "expiresAtMs", default)]
    pub expires_at_ms: i64,
    /// `"chatgpt"` or `"api_key"`.
    #[serde(rename = "authMode")]
    pub auth_mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(
        rename = "chatgptPlanType",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub chatgpt_plan_type: Option<String>,
    #[serde(
        rename = "chatgptUserId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub chatgpt_user_id: Option<String>,
    #[serde(rename = "accountId", default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    /// `"file"` | `"keyring"` | `"oauth"` — where the credential was first adopted.
    #[serde(
        rename = "originalSource",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub original_source: Option<String>,
    #[serde(rename = "storedAtMs", default)]
    pub stored_at_ms: i64,
}

/// Pointer-style record for an OpenCode-discovered credential. We capture
/// where it came from + the original JSON payload (for forensics / future
/// adoption) without copying the full secret payload into our own keyring —
/// the user can always re-adopt by clicking "Use" in the UI, which then
/// flows through `OpencodeZenData` for `opencode-zen` or `opencode_save_zen_key`.
///
/// Note: discovery results are surfaced separately via `opencode_oauth_discover`
/// and are NOT routinely persisted into the vault. This variant is created by
/// the `opencode_adopt_discovered` command when a non-managed-plan entry
/// (anthropic / openai, or an OAuth-shaped payload) is adopted — managed-plan
/// keys adopt into `OpencodeZenData` instead.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct OpencodeDiscoveredData {
    /// `"anthropic"` | `"openai"` | `"opencode"` | `"opencode-go"` |
    /// `"opencode-zen"` — whitelisted sub-providers.
    #[serde(rename = "subProvider")]
    pub sub_provider: String,
    /// Resolved path to the source `auth.json`.
    #[serde(rename = "authJsonPath")]
    pub auth_json_path: String,
    /// The original JSON payload for the sub-provider entry, verbatim. Kept
    /// as a string (not a typed value) because OpenCode's schema is open-ended
    /// — keeping the original bytes is the safest way to round-trip future
    /// fields we don't yet know about.
    #[serde(rename = "originalPayloadJson")]
    pub original_payload_json: String,
    #[serde(rename = "lastSeenAtMs", default)]
    pub last_seen_at_ms: i64,
}

/// OpenCode managed-subscription API key (paste-key flow). Covers both the
/// pay-per-request Zen plan and the flat-rate Go plan — same gateway, same
/// key shape, different default base URL. Full OAuth into opencode.ai is
/// deferred until the endpoints are documented.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct OpencodeZenData {
    #[serde(rename = "accessToken")]
    pub access_token: String,
    /// Optional regional override. Free-text URL today; future versions may
    /// swap to a dropdown when opencode.ai publishes the region list.
    #[serde(rename = "baseUrl", default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    /// `"zen"` | `"go"`. Absent = `"zen"` (accounts saved before the Go plan
    /// existed). Additive optional field — no vault SCHEMA_VERSION bump.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    #[serde(rename = "storedAtMs", default)]
    pub stored_at_ms: i64,
}

impl OpencodeZenData {
    /// Effective plan with the legacy default applied.
    pub fn effective_plan(&self) -> &str {
        match self.plan.as_deref() {
            Some("go") => "go",
            _ => "zen",
        }
    }
}

/// Discriminated union of every provider-specific credential shape. Tag is
/// `"provider"` for ergonomic JSON: `{"provider":"anthropic","accessToken":...}`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "provider", rename_all = "kebab-case")]
pub enum ProviderCredential {
    Anthropic(AnthropicCredentialData),
    Codex(CodexCredentialData),
    OpencodeDiscovered(OpencodeDiscoveredData),
    OpencodeZen(OpencodeZenData),
}

impl ProviderCredential {
    /// Which `ProviderId` does this credential belong under in the vault?
    pub fn provider(&self) -> ProviderId {
        match self {
            ProviderCredential::Anthropic(_) => ProviderId::Anthropic,
            ProviderCredential::Codex(_) => ProviderId::Codex,
            ProviderCredential::OpencodeDiscovered(_) | ProviderCredential::OpencodeZen(_) => {
                ProviderId::Opencode
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Account + Vault + AccountSummary
// ---------------------------------------------------------------------------

/// One credential entry in a provider's vault.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Account {
    /// UUIDv7. Stable across renames; UI sorts by `created_at_ms`.
    pub id: String,
    /// Optional user label ("公司 Pro", "Personal Max"). When `None`, the UI
    /// falls back to provider-derived defaults (email / plan / etc.).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// The actual credential payload.
    pub credential: ProviderCredential,
    #[serde(rename = "createdAtMs")]
    pub created_at_ms: i64,
    #[serde(rename = "lastUsedAtMs", default)]
    pub last_used_at_ms: i64,
    /// Per-account preset binding (v3). When `Some`, the resolved env uses this
    /// preset; when `None`, the provider-level `default_preset_id` applies.
    /// Points at a `ProviderPreset.id` in the same vault's `presets` list.
    #[serde(rename = "presetId", default, skip_serializing_if = "Option::is_none")]
    pub preset_id: Option<String>,
    /// Non-secret lifecycle metadata. Kept outside the credential so the
    /// renderer-safe projection never needs to deserialize bearer material.
    #[serde(
        rename = "authMetadata",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub auth_metadata: Option<AccountAuthMetadata>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct CodexIdentityFingerprint {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issuer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    #[serde(
        rename = "workspaceId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
}

impl CodexIdentityFingerprint {
    pub fn is_verifiable(&self) -> bool {
        self.workspace_id.is_some() && (self.subject.is_some() || self.email.is_some())
    }

    /// Targeted reauthentication is fail-closed: both identities need the
    /// same workspace and the same stable subject (email is a legacy fallback).
    pub fn matches(&self, candidate: &Self) -> bool {
        if self.workspace_id.is_none() || self.workspace_id != candidate.workspace_id {
            return false;
        }
        match (&self.subject, &candidate.subject) {
            (Some(current), Some(next)) => current == next,
            (None, None) => self.email == candidate.email && self.email.is_some(),
            _ => false,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct AccountAuthMetadata {
    #[serde(
        rename = "codexIdentity",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub codex_identity: Option<CodexIdentityFingerprint>,
    #[serde(
        rename = "reauthRequiredAtMs",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub reauth_required_at_ms: Option<i64>,
    #[serde(
        rename = "reauthReason",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub reauth_reason: Option<String>,
    #[serde(
        rename = "lastCredentialRotationAtMs",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub last_credential_rotation_at_ms: Option<i64>,
}

/// Renderer-safe projection of `Account` — strips the secret bearer. Used by
/// `subscription_list_accounts` so the renderer's account picker doesn't see
/// any token bytes unless it explicitly fetches the full `Account` for an
/// edit dialog.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AccountSummary {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Provider id (string form so the renderer can switch on it directly).
    pub provider: String,
    /// One-letter variant tag for inspection: `"anthropic"`, `"codex"`,
    /// `"opencode-discovered"`, `"opencode-zen"`. Useful when the UI wants
    /// to render an icon distinguishing Zen vs discovered.
    pub variant: String,
    /// User-facing extra context derived from claims (email, plan, etc.).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    /// 0 = doesn't apply (api_key / opencode-zen).
    #[serde(rename = "expiresAtMs", default)]
    pub expires_at_ms: i64,
    #[serde(rename = "createdAtMs")]
    pub created_at_ms: i64,
    #[serde(rename = "lastUsedAtMs", default)]
    pub last_used_at_ms: i64,
    #[serde(rename = "authMode")]
    pub auth_mode: String,
    #[serde(rename = "credentialSource")]
    pub credential_source: String,
    pub health: String,
    #[serde(rename = "isExternal")]
    pub is_external: bool,
    #[serde(
        rename = "reauthReason",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub reauth_reason: Option<String>,
}

impl AccountSummary {
    pub fn from_account(account: &Account) -> Self {
        Self::from_account_at(account, current_unix_ms())
    }

    pub fn from_account_at(account: &Account, now_ms: i64) -> Self {
        let (email, plan, expires_at_ms, variant, auth_mode, credential_source, is_external) =
            match &account.credential {
                ProviderCredential::Anthropic(c) => (
                    c.email.clone(),
                    c.plan.clone(),
                    c.expires_at_ms,
                    "anthropic",
                    c.mode.as_str(),
                    c.original_source.as_deref().unwrap_or("managed"),
                    c.original_source.is_some(),
                ),
                ProviderCredential::Codex(c) => (
                    c.email.clone(),
                    c.chatgpt_plan_type.clone(),
                    c.expires_at_ms,
                    "codex",
                    c.auth_mode.as_str(),
                    c.original_source.as_deref().unwrap_or("managed"),
                    matches!(c.original_source.as_deref(), Some("file" | "keyring")),
                ),
                ProviderCredential::OpencodeDiscovered(_) => (
                    None,
                    None,
                    0,
                    "opencode-discovered",
                    "external",
                    "file",
                    true,
                ),
                ProviderCredential::OpencodeZen(z) => (
                    None,
                    Some(z.effective_plan().to_string()),
                    0,
                    "opencode-zen",
                    "api_key",
                    "managed",
                    false,
                ),
            };
        let reauth_reason = account
            .auth_metadata
            .as_ref()
            .and_then(|metadata| metadata.reauth_reason.clone());
        let health = if account
            .auth_metadata
            .as_ref()
            .and_then(|metadata| metadata.reauth_required_at_ms)
            .is_some()
        {
            "reauth_required"
        } else if variant == "opencode-discovered" {
            "source_unavailable"
        } else if expires_at_ms > 0 && expires_at_ms <= now_ms + EXPIRING_WINDOW_MS {
            "expiring"
        } else {
            "ready"
        };
        Self {
            id: account.id.clone(),
            label: account.label.clone(),
            provider: account.credential.provider().as_str().to_string(),
            variant: variant.to_string(),
            email,
            plan,
            expires_at_ms,
            created_at_ms: account.created_at_ms,
            last_used_at_ms: account.last_used_at_ms,
            auth_mode: auth_mode.to_string(),
            credential_source: credential_source.to_string(),
            health: health.to_string(),
            is_external,
            reauth_reason,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AccountDetail {
    #[serde(flatten)]
    pub summary: AccountSummary,
    #[serde(rename = "presetId", default, skip_serializing_if = "Option::is_none")]
    pub preset_id: Option<String>,
    #[serde(
        rename = "codexIdentity",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub codex_identity: Option<CodexIdentityFingerprint>,
    #[serde(
        rename = "lastCredentialRotationAtMs",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub last_credential_rotation_at_ms: Option<i64>,
}

impl AccountDetail {
    pub fn from_account(account: &Account) -> Self {
        let metadata = account.auth_metadata.as_ref();
        Self {
            summary: AccountSummary::from_account(account),
            preset_id: account.preset_id.clone(),
            codex_identity: metadata.and_then(|value| value.codex_identity.clone()),
            last_credential_rotation_at_ms: metadata
                .and_then(|value| value.last_credential_rotation_at_ms),
        }
    }
}

/// The full vault as stored in the keyring entry for one provider.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderVault {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u32,
    #[serde(default)]
    pub accounts: Vec<Account>,
    #[serde(
        rename = "activeAccountId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub active_account_id: Option<String>,
    /// Preset library (v3). Multiple endpoint presets per provider; accounts
    /// bind to one by id, with `default_preset_id` as the provider-wide fallback.
    #[serde(default)]
    pub presets: Vec<ProviderPreset>,
    /// Provider-level default preset id (v3). Applied when an account has no
    /// `preset_id`. Points at a `ProviderPreset.id` in `presets`.
    #[serde(
        rename = "defaultPresetId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub default_preset_id: Option<String>,
    /// Legacy single preset (v2). Read at load time and folded into `presets`
    /// by the v2→v3 migration, then never written again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset: Option<ProviderPreset>,
}

impl ProviderVault {
    pub fn empty() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            accounts: Vec::new(),
            active_account_id: None,
            presets: Vec::new(),
            default_preset_id: None,
            preset: None,
        }
    }

    /// In-place upgrade to the current schema. Idempotent: when the vault is
    /// already current it still normalizes a stray legacy `preset` and any
    /// missing Codex identity. Returns `true` when anything changed (so callers
    /// can persist the upgraded blob).
    pub fn migrate_to_current(&mut self) -> bool {
        let mut changed = false;
        // Fold a legacy v2 single preset into the v3 library + default pointer.
        if let Some(legacy) = self.preset.take() {
            if !self.presets.iter().any(|p| p.id == legacy.id) {
                if self.default_preset_id.is_none() {
                    self.default_preset_id = Some(legacy.id.clone());
                }
                self.presets.push(legacy);
            }
            changed = true;
        }
        // Not gated on the version bump. An account can reach a current vault
        // without an identity (added by a path that skipped normalization, or
        // migrated while its `id_token_raw` was not yet parseable), and once the
        // version matched, a version-gated backfill would never look again. The
        // derivation is pure and only runs while the fingerprint is missing.
        for account in &mut self.accounts {
            if account
                .auth_metadata
                .as_ref()
                .is_some_and(|metadata| metadata.codex_identity.is_some())
            {
                continue;
            }
            let ProviderCredential::Codex(credential) = &account.credential else {
                continue;
            };
            let Some(identity) = derive_codex_identity(&credential.id_token_raw, credential)
                .filter(CodexIdentityFingerprint::is_verifiable)
            else {
                continue;
            };
            account
                .auth_metadata
                .get_or_insert_with(AccountAuthMetadata::default)
                .codex_identity = Some(identity);
            changed = true;
        }
        if self.schema_version < SCHEMA_VERSION {
            self.schema_version = SCHEMA_VERSION;
            changed = true;
        }
        changed
    }

    /// Resolve the effective preset for an account: its own `preset_id`, else
    /// the provider `default_preset_id`, else `None`. Dangling ids resolve to
    /// `None` rather than erroring (the account simply runs preset-less).
    pub fn resolve_preset(&self, account: &Account) -> Option<&ProviderPreset> {
        let id = account
            .preset_id
            .as_ref()
            .or(self.default_preset_id.as_ref())?;
        self.presets.iter().find(|p| &p.id == id)
    }

    /// Upsert a preset by id (replace existing, append if new).
    pub fn upsert_preset(&mut self, preset: ProviderPreset) {
        if let Some(existing) = self.presets.iter_mut().find(|p| p.id == preset.id) {
            *existing = preset;
        } else {
            self.presets.push(preset);
        }
    }

    /// Remove a preset by id. Clears `default_preset_id` and any account
    /// binding pointing at it. Returns `true` if a preset was removed.
    pub fn remove_preset(&mut self, preset_id: &str) -> bool {
        let before = self.presets.len();
        self.presets.retain(|p| p.id != preset_id);
        let removed = self.presets.len() != before;
        if removed {
            if self.default_preset_id.as_deref() == Some(preset_id) {
                self.default_preset_id = None;
            }
            for a in &mut self.accounts {
                if a.preset_id.as_deref() == Some(preset_id) {
                    a.preset_id = None;
                }
            }
        }
        removed
    }

    /// Upsert an account by id (replace existing, append if new). Returns the
    /// id that was written.
    pub fn upsert_account(&mut self, account: Account) -> String {
        let id = account.id.clone();
        if let Some(existing) = self.accounts.iter_mut().find(|a| a.id == account.id) {
            *existing = account;
        } else {
            self.accounts.push(account);
        }
        id
    }

    /// Remove an account by id. Returns `true` if anything was removed. If the
    /// removed account was the active pointer, clears it.
    pub fn remove_account(&mut self, account_id: &str) -> bool {
        let before = self.accounts.len();
        self.accounts.retain(|a| a.id != account_id);
        let removed = self.accounts.len() != before;
        if removed && self.active_account_id.as_deref() == Some(account_id) {
            self.active_account_id = None;
        }
        removed
    }

    /// Find an account by id.
    pub fn find_account(&self, account_id: &str) -> Option<&Account> {
        self.accounts.iter().find(|a| a.id == account_id)
    }

    /// Returns `true` if `active_account_id` is `Some` but no account in
    /// `accounts` matches. Used by `subscription_set_active` to detect orphan
    /// pointers.
    pub fn has_orphan_active(&self) -> bool {
        match &self.active_account_id {
            Some(id) => !self.accounts.iter().any(|a| &a.id == id),
            None => false,
        }
    }
}

// ---------------------------------------------------------------------------
// Keyring I/O
// ---------------------------------------------------------------------------

pub fn service_name_for_account(local_account_id: &str) -> Result<String, String> {
    let trimmed = local_account_id.trim();
    if trimmed.is_empty() {
        return Err("localAccountId must not be empty".into());
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("localAccountId contains unsafe characters".into());
    }
    Ok(format!("{SERVICE}/account/{trimmed}"))
}

fn validate_vault(vault: &ProviderVault) -> Result<(), String> {
    if vault.schema_version != SCHEMA_VERSION {
        return Err(format!(
            "vault schemaVersion must be {SCHEMA_VERSION}, got {}",
            vault.schema_version
        ));
    }
    if vault.has_orphan_active() {
        return Err("vault.activeAccountId does not match any account in vault.accounts".into());
    }
    if let Some(id) = &vault.default_preset_id {
        if !vault.presets.iter().any(|p| &p.id == id) {
            return Err("vault.defaultPresetId does not match any preset in vault.presets".into());
        }
    }
    Ok(())
}

fn parse_vault_blob(blob: &str) -> Result<ProviderVault, String> {
    let mut parsed: ProviderVault =
        serde_json::from_str(blob).map_err(|e| format!("vault parse failed: {e}"))?;
    parsed.migrate_to_current();
    Ok(parsed)
}

fn current_unix_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

pub fn derive_codex_identity(
    raw_jwt: &str,
    credential: &CodexCredentialData,
) -> Option<CodexIdentityFingerprint> {
    let payload = raw_jwt.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    let claims: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let auth = claims.get("https://api.openai.com/auth");
    let identity = CodexIdentityFingerprint {
        issuer: claims
            .get("iss")
            .and_then(|value| value.as_str())
            .map(str::to_owned),
        subject: claims
            .get("sub")
            .and_then(|value| value.as_str())
            .map(str::to_owned),
        workspace_id: auth
            .and_then(|value| value.get("chatgpt_account_id"))
            .and_then(|value| value.as_str())
            .map(str::to_owned)
            .or_else(|| credential.account_id.clone()),
        email: claims
            .get("email")
            .and_then(|value| value.as_str())
            .map(|value| value.trim().to_ascii_lowercase())
            .or_else(|| {
                credential
                    .email
                    .as_ref()
                    .map(|value| value.trim().to_ascii_lowercase())
            }),
    };
    identity.is_verifiable().then_some(identity)
}

/// Populate missing non-secret identity metadata from credential bytes already
/// supplied by the caller. This is pure and never consults an external store.
pub fn normalize_account_auth_metadata(account: &mut Account) {
    let ProviderCredential::Codex(credential) = &account.credential else {
        return;
    };
    let Some(identity) = derive_codex_identity(&credential.id_token_raw, credential) else {
        return;
    };
    account
        .auth_metadata
        .get_or_insert_with(AccountAuthMetadata::default)
        .codex_identity
        .get_or_insert(identity);
}

/// Persist a vault for the given provider. Overwrites the existing keyring
/// entry. Validates structural invariants (schema version, orphan active
/// pointer); provider-specific credential validation is the caller's job
/// (typically through `SubscriptionProvider::validate` before upsert).
#[allow(dead_code)]
pub fn save(provider: ProviderId, vault: &ProviderVault) -> Result<(), String> {
    validate_vault(vault)?;
    let blob = serde_json::to_string(vault).map_err(|e| format!("vault serialize failed: {e}"))?;
    cognia_secrets::secret_store::set(SERVICE, provider.as_str(), &blob)
}

#[allow(dead_code)]
pub fn save_for_account(
    local_account_id: &str,
    provider: ProviderId,
    vault: &ProviderVault,
) -> Result<(), String> {
    validate_vault(vault)?;
    let blob = serde_json::to_string(vault).map_err(|e| format!("vault serialize failed: {e}"))?;
    let service = service_name_for_account(local_account_id)?;
    cognia_secrets::secret_store::set(&service, provider.as_str(), &blob)
}

/// Read the vault. Returns `Ok(None)` when no entry exists, surfaces parse
/// errors as `Err` so the UI can show "credential corrupted" rather than
/// silently dropping the user back to "logged out".
pub fn load(provider: ProviderId) -> Result<Option<ProviderVault>, String> {
    match cognia_secrets::secret_store::get(SERVICE, provider.as_str())? {
        Some(blob) => Ok(Some(parse_vault_blob(&blob)?)),
        None => Ok(None),
    }
}

#[allow(dead_code)]
pub fn load_for_account(
    local_account_id: &str,
    provider: ProviderId,
) -> Result<Option<ProviderVault>, String> {
    let service = service_name_for_account(local_account_id)?;
    match cognia_secrets::secret_store::get(&service, provider.as_str())? {
        Some(blob) => Ok(Some(parse_vault_blob(&blob)?)),
        None => adopt_legacy_vault_for_account(local_account_id, provider),
    }
}

#[allow(dead_code)]
fn adopt_legacy_vault_for_account(
    local_account_id: &str,
    provider: ProviderId,
) -> Result<Option<ProviderVault>, String> {
    let Some(vault) = load(provider)? else {
        return Ok(None);
    };
    save_for_account(local_account_id, provider, &vault)?;
    clear(provider)?;
    Ok(Some(vault))
}

/// Remove the vault entry. Idempotent. Exposed on the public surface for
/// the future "sign out all" admin flow + every test in the migration suite
/// that needs to reset between runs.
#[allow(dead_code)]
pub fn clear(provider: ProviderId) -> Result<(), String> {
    cognia_secrets::secret_store::delete(SERVICE, provider.as_str())
}

#[allow(dead_code)]
pub fn clear_for_account(local_account_id: &str, provider: ProviderId) -> Result<(), String> {
    let service = service_name_for_account(local_account_id)?;
    cognia_secrets::secret_store::delete(&service, provider.as_str())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn vault_mutation_lock_serializes_whole_blob_updates() {
        let first = VAULT_MUTATION_LOCK.lock().await;
        assert!(VAULT_MUTATION_LOCK.try_lock().is_err());
        drop(first);
        assert!(VAULT_MUTATION_LOCK.try_lock().is_ok());
    }

    fn keyring_available() -> bool {
        std::env::var("COGNIA_TEST_KEYRING").ok().as_deref() == Some("1")
    }

    fn anthropic_account() -> Account {
        Account {
            id: "0193c2b0-0000-7000-8000-000000000001".into(),
            label: Some("Default".into()),
            credential: ProviderCredential::Anthropic(AnthropicCredentialData {
                access_token: "oat01-vault-test".into(),
                refresh_token: "rt-vault-test".into(),
                expires_at_ms: 1_800_000_000_000,
                mode: "subscription".into(),
                scope: Some("user:profile".into()),
                email: Some("user@example.com".into()),
                plan: Some("pro".into()),
                original_source: Some("keyring".into()),
                stored_at_ms: 1_700_000_000_000,
            }),
            created_at_ms: 1_700_000_000_000,
            last_used_at_ms: 1_700_000_000_000,
            preset_id: None,
            auth_metadata: None,
        }
    }

    fn codex_account() -> Account {
        Account {
            id: "0193c2b0-0000-7000-8000-000000000002".into(),
            label: None,
            credential: ProviderCredential::Codex(CodexCredentialData {
                access_token: "oat-codex-vault".into(),
                refresh_token: "rt-codex-vault".into(),
                id_token_raw: "eyJ.fake.jwt".into(),
                expires_at_ms: 1_800_000_000_000,
                auth_mode: "chatgpt".into(),
                email: Some("user@example.com".into()),
                chatgpt_plan_type: Some("plus".into()),
                chatgpt_user_id: Some("user_abc".into()),
                account_id: Some("acct_def".into()),
                original_source: Some("oauth".into()),
                stored_at_ms: 1_700_000_000_000,
            }),
            created_at_ms: 1_700_000_000_000,
            last_used_at_ms: 1_700_000_000_000,
            preset_id: None,
            auth_metadata: None,
        }
    }

    #[test]
    fn provider_id_round_trip() {
        for s in ["anthropic", "codex", "opencode"] {
            let p = ProviderId::parse(s).unwrap();
            assert_eq!(p.as_str(), s);
        }
        assert!(ProviderId::parse("unknown").is_err());
    }

    #[test]
    fn account_scoped_service_includes_local_account_id() {
        assert_eq!(
            service_name_for_account("acct-A_01").unwrap(),
            "com.cognia.subscription/v2/account/acct-A_01"
        );
    }

    #[test]
    fn account_scoped_service_rejects_empty_or_unsafe_local_account_id() {
        assert!(service_name_for_account("").is_err());
        assert!(service_name_for_account("   ").is_err());
        assert!(service_name_for_account("../acct").is_err());
        assert!(service_name_for_account("acct/a").is_err());
    }

    #[test]
    fn provider_credential_provider_dispatch() {
        let a = ProviderCredential::Anthropic(AnthropicCredentialData::default());
        assert_eq!(a.provider(), ProviderId::Anthropic);
        let c = ProviderCredential::Codex(CodexCredentialData::default());
        assert_eq!(c.provider(), ProviderId::Codex);
        let d = ProviderCredential::OpencodeDiscovered(OpencodeDiscoveredData::default());
        assert_eq!(d.provider(), ProviderId::Opencode);
        let z = ProviderCredential::OpencodeZen(OpencodeZenData::default());
        assert_eq!(z.provider(), ProviderId::Opencode);
    }

    #[test]
    fn anthropic_credential_round_trip() {
        let original = anthropic_account();
        let blob = serde_json::to_string(&original).unwrap();
        let parsed: Account = serde_json::from_str(&blob).unwrap();
        assert_eq!(parsed, original);
        // camelCase fields survive
        assert!(blob.contains("\"accessToken\""));
        assert!(blob.contains("\"refreshToken\""));
        assert!(blob.contains("\"originalSource\":\"keyring\""));
        assert!(blob.contains("\"createdAtMs\""));
    }

    #[test]
    fn codex_credential_round_trip() {
        let original = codex_account();
        let blob = serde_json::to_string(&original).unwrap();
        let parsed: Account = serde_json::from_str(&blob).unwrap();
        assert_eq!(parsed, original);
        assert!(blob.contains("\"authMode\""));
        assert!(blob.contains("\"idTokenRaw\""));
    }

    #[test]
    fn opencode_zen_round_trip() {
        let zen = Account {
            id: "0193c2b0-0000-7000-8000-000000000003".into(),
            label: Some("Zen Default".into()),
            credential: ProviderCredential::OpencodeZen(OpencodeZenData {
                access_token: "ozk-1".into(),
                base_url: Some("https://zen.opencode.ai".into()),
                plan: None,
                stored_at_ms: 1_700_000_000_000,
            }),
            created_at_ms: 1_700_000_000_000,
            last_used_at_ms: 1_700_000_000_000,
            preset_id: None,
            auth_metadata: None,
        };
        let blob = serde_json::to_string(&zen).unwrap();
        let parsed: Account = serde_json::from_str(&blob).unwrap();
        assert_eq!(parsed, zen);
    }

    #[test]
    fn provider_credential_serializes_as_tagged_union() {
        let c = ProviderCredential::Anthropic(AnthropicCredentialData::default());
        let blob = serde_json::to_string(&c).unwrap();
        assert!(blob.contains("\"provider\":\"anthropic\""));
        let c2 = ProviderCredential::OpencodeZen(OpencodeZenData::default());
        let blob2 = serde_json::to_string(&c2).unwrap();
        assert!(blob2.contains("\"provider\":\"opencode-zen\""));
    }

    #[test]
    fn upsert_account_inserts_new() {
        let mut vault = ProviderVault::empty();
        let id = vault.upsert_account(anthropic_account());
        assert_eq!(vault.accounts.len(), 1);
        assert_eq!(id, "0193c2b0-0000-7000-8000-000000000001");
    }

    #[test]
    fn upsert_account_replaces_existing_by_id() {
        let mut vault = ProviderVault::empty();
        let mut a = anthropic_account();
        vault.upsert_account(a.clone());
        a.label = Some("Renamed".into());
        vault.upsert_account(a);
        assert_eq!(vault.accounts.len(), 1);
        assert_eq!(vault.accounts[0].label.as_deref(), Some("Renamed"));
    }

    #[test]
    fn remove_account_clears_active_when_matching() {
        let mut vault = ProviderVault::empty();
        let a = anthropic_account();
        let id = a.id.clone();
        vault.upsert_account(a);
        vault.active_account_id = Some(id.clone());
        assert!(vault.remove_account(&id));
        assert!(vault.active_account_id.is_none());
    }

    #[test]
    fn remove_account_preserves_active_when_different() {
        let mut vault = ProviderVault::empty();
        vault.upsert_account(anthropic_account());
        vault.upsert_account(codex_account()); // wrong provider per real schema, but vault doesn't enforce that
        vault.active_account_id = Some("0193c2b0-0000-7000-8000-000000000002".into());
        assert!(vault.remove_account("0193c2b0-0000-7000-8000-000000000001"));
        assert_eq!(
            vault.active_account_id.as_deref(),
            Some("0193c2b0-0000-7000-8000-000000000002")
        );
    }

    #[test]
    fn has_orphan_active_detects_dangling_pointer() {
        let mut vault = ProviderVault::empty();
        vault.upsert_account(anthropic_account());
        vault.active_account_id = Some("nonexistent".into());
        assert!(vault.has_orphan_active());
        vault.active_account_id = Some("0193c2b0-0000-7000-8000-000000000001".into());
        assert!(!vault.has_orphan_active());
    }

    #[test]
    fn save_rejects_wrong_schema_version() {
        let mut vault = ProviderVault::empty();
        vault.schema_version = 99;
        let err = save(ProviderId::Anthropic, &vault).expect_err("should reject");
        assert!(err.contains("schemaVersion"));
    }

    #[test]
    fn save_rejects_orphan_active() {
        let mut vault = ProviderVault::empty();
        vault.active_account_id = Some("nonexistent".into());
        let err = save(ProviderId::Anthropic, &vault).expect_err("should reject");
        assert!(err.contains("activeAccountId"));
    }

    #[test]
    fn vault_round_trips_through_keyring() {
        if !keyring_available() {
            return;
        }
        let _ = clear(ProviderId::Anthropic);
        let mut vault = ProviderVault::empty();
        vault.upsert_account(anthropic_account());
        vault.active_account_id = Some("0193c2b0-0000-7000-8000-000000000001".into());
        save(ProviderId::Anthropic, &vault).unwrap();
        let got = load(ProviderId::Anthropic).unwrap().unwrap();
        assert_eq!(got, vault);
        clear(ProviderId::Anthropic).unwrap();
        assert!(load(ProviderId::Anthropic).unwrap().is_none());
    }

    #[test]
    fn clear_when_missing_is_ok() {
        if !keyring_available() {
            return;
        }
        let _ = clear(ProviderId::Anthropic);
        assert!(clear(ProviderId::Anthropic).is_ok());
    }

    #[test]
    fn account_summary_strips_secrets() {
        let s = AccountSummary::from_account(&anthropic_account());
        let blob = serde_json::to_string(&s).unwrap();
        assert!(!blob.contains("oat01-vault-test"));
        assert!(!blob.contains("rt-vault-test"));
        assert_eq!(s.provider, "anthropic");
        assert_eq!(s.variant, "anthropic");
        assert_eq!(s.email.as_deref(), Some("user@example.com"));
        assert_eq!(s.plan.as_deref(), Some("pro"));
        assert_eq!(s.credential_source, "keyring");
        assert!(s.is_external);
    }

    #[test]
    fn account_detail_strips_every_secret_field() {
        let detail = AccountDetail::from_account(&codex_account());
        let blob = serde_json::to_string(&detail).unwrap();
        for secret in ["oat-codex-vault", "rt-codex-vault", "eyJ.fake.jwt"] {
            assert!(!blob.contains(secret));
        }
        assert_eq!(detail.summary.auth_mode, "chatgpt");
    }

    #[test]
    fn summary_health_prefers_persisted_reauth_and_derives_expiring() {
        let mut account = codex_account();
        if let ProviderCredential::Codex(credential) = &mut account.credential {
            credential.expires_at_ms = 1_000 + EXPIRING_WINDOW_MS;
        }
        assert_eq!(
            AccountSummary::from_account_at(&account, 1_000).health,
            "expiring"
        );
        account.auth_metadata = Some(AccountAuthMetadata {
            reauth_required_at_ms: Some(900),
            reauth_reason: Some("refresh_token_revoked".into()),
            ..AccountAuthMetadata::default()
        });
        let summary = AccountSummary::from_account_at(&account, 1_000);
        assert_eq!(summary.health, "reauth_required");
        assert_eq!(
            summary.reauth_reason.as_deref(),
            Some("refresh_token_revoked")
        );
    }

    #[test]
    fn v3_migration_derives_codex_identity_without_external_io() {
        let claims = serde_json::json!({
            "iss": "https://auth.openai.com",
            "sub": "user-subject",
            "email": "  USER@Example.COM ",
            "https://api.openai.com/auth": { "chatgpt_account_id": "workspace-1" }
        });
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&claims).unwrap());
        let mut account = codex_account();
        if let ProviderCredential::Codex(credential) = &mut account.credential {
            credential.id_token_raw = format!("header.{payload}.signature");
        }
        let mut vault = ProviderVault::empty();
        vault.schema_version = 3;
        vault.accounts.push(account);

        assert!(vault.migrate_to_current());
        assert_eq!(vault.schema_version, 4);
        let identity = vault.accounts[0]
            .auth_metadata
            .as_ref()
            .and_then(|metadata| metadata.codex_identity.as_ref())
            .expect("identity should be derived from the supplied fixture JWT");
        assert_eq!(identity.subject.as_deref(), Some("user-subject"));
        assert_eq!(identity.workspace_id.as_deref(), Some("workspace-1"));
        assert_eq!(identity.email.as_deref(), Some("user@example.com"));
    }

    // An account can land in an already-current vault with no fingerprint. A
    // version-gated backfill would never look at it again, so targeted
    // reauthentication would have nothing persisted to compare against.
    #[test]
    fn identity_backfill_also_heals_a_vault_already_at_the_current_version() {
        let claims = serde_json::json!({
            "sub": "user-subject",
            "https://api.openai.com/auth": { "chatgpt_account_id": "workspace-1" }
        });
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&claims).unwrap());
        let mut account = codex_account();
        if let ProviderCredential::Codex(credential) = &mut account.credential {
            credential.id_token_raw = format!("header.{payload}.signature");
        }
        let mut vault = ProviderVault::empty();
        vault.schema_version = SCHEMA_VERSION;
        vault.accounts.push(account);

        assert!(vault.migrate_to_current());
        assert_eq!(
            vault.accounts[0]
                .auth_metadata
                .as_ref()
                .and_then(|metadata| metadata.codex_identity.as_ref())
                .and_then(|identity| identity.workspace_id.as_deref()),
            Some("workspace-1")
        );
        // Idempotent: a second pass has nothing left to normalize.
        assert!(!vault.migrate_to_current());
    }

    #[test]
    fn codex_identity_match_is_workspace_and_subject_safe() {
        let current = CodexIdentityFingerprint {
            workspace_id: Some("workspace-1".into()),
            subject: Some("subject-1".into()),
            ..CodexIdentityFingerprint::default()
        };
        assert!(current.matches(&current));
        assert!(!current.matches(&CodexIdentityFingerprint {
            workspace_id: Some("workspace-2".into()),
            subject: Some("subject-1".into()),
            ..CodexIdentityFingerprint::default()
        }));
        assert!(!current.matches(&CodexIdentityFingerprint {
            workspace_id: Some("workspace-1".into()),
            subject: Some("subject-2".into()),
            ..CodexIdentityFingerprint::default()
        }));
    }

    #[test]
    fn account_summary_distinguishes_opencode_variants() {
        let discovered = Account {
            id: "x".into(),
            label: None,
            credential: ProviderCredential::OpencodeDiscovered(OpencodeDiscoveredData::default()),
            created_at_ms: 0,
            last_used_at_ms: 0,
            preset_id: None,
            auth_metadata: None,
        };
        let zen = Account {
            id: "y".into(),
            label: None,
            credential: ProviderCredential::OpencodeZen(OpencodeZenData::default()),
            created_at_ms: 0,
            last_used_at_ms: 0,
            preset_id: None,
            auth_metadata: None,
        };
        assert_eq!(
            AccountSummary::from_account(&discovered).variant,
            "opencode-discovered"
        );
        assert_eq!(AccountSummary::from_account(&zen).variant, "opencode-zen");
    }
}

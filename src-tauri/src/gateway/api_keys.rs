//! Gateway API keys — multiple scoped bearer credentials.
//!
//! Replaces the single-bearer model: the user issues one key per external
//! tool (a revocable "sk-cognia-…" secret), each optionally scoped to a set of
//! models, given an expiry, its own rate limit, and an enable/disable toggle.
//!
//! The whole list (secrets included) is persisted as one JSON blob in the
//! OS-keyring-backed [`crate::secret_store`] — the same place the old single
//! token lived. Secrets never touch the plaintext config file, are never
//! logged, and are only returned to the renderer on an explicit reveal.
//!
//! Backward compatibility: on first load, a legacy `bearer-token` keyring
//! entry (from the single-token era) is migrated into a "Default" key and the
//! legacy entry is deleted. Idempotent — once the keys blob exists, migration
//! never runs again.

use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;

use crate::secret_store;

const SERVICE: &str = "com.cognia.gateway";
const KEYS_ACCOUNT: &str = "api-keys";
const LEGACY_TOKEN_ACCOUNT: &str = "bearer-token";

/// One scoped bearer credential. Serialized camelCase to mirror
/// `types/gateway/index.ts`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GatewayApiKey {
    pub id: String,
    pub name: String,
    /// The bearer secret the external tool sends. Keyring-backed; only ever
    /// revealed on an explicit `gateway_reveal_key`.
    pub secret: String,
    /// Model/alias ids this key may call. Empty = every exposed model.
    #[serde(default)]
    pub model_allowlist: Vec<String>,
    /// Epoch-ms expiry; `None` = never expires.
    #[serde(default)]
    pub expires_at_ms: Option<i64>,
    pub enabled: bool,
    /// Per-key per-minute request budget; `None` = only the global limit.
    #[serde(default)]
    pub rate_limit_per_min: Option<u32>,
    pub created_at_ms: i64,
    #[serde(default)]
    pub last_used_at_ms: Option<i64>,
}

/// A key with its secret redacted — safe to hand to the renderer for listing.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RedactedApiKey {
    pub id: String,
    pub name: String,
    pub model_allowlist: Vec<String>,
    pub expires_at_ms: Option<i64>,
    pub enabled: bool,
    pub rate_limit_per_min: Option<u32>,
    pub created_at_ms: i64,
    pub last_used_at_ms: Option<i64>,
    /// e.g. `sk-cognia-…a1b2` — enough to identify, not to use.
    pub secret_preview: String,
}

impl GatewayApiKey {
    pub fn is_expired(&self, now_ms: i64) -> bool {
        matches!(self.expires_at_ms, Some(exp) if now_ms >= exp)
    }

    /// Enabled AND not expired — the gate the auth middleware applies.
    pub fn is_usable(&self, now_ms: i64) -> bool {
        self.enabled && !self.is_expired(now_ms)
    }

    pub fn redacted(&self) -> RedactedApiKey {
        RedactedApiKey {
            id: self.id.clone(),
            name: self.name.clone(),
            model_allowlist: self.model_allowlist.clone(),
            expires_at_ms: self.expires_at_ms,
            enabled: self.enabled,
            rate_limit_per_min: self.rate_limit_per_min,
            created_at_ms: self.created_at_ms,
            last_used_at_ms: self.last_used_at_ms,
            secret_preview: preview_secret(&self.secret),
        }
    }
}

/// Short non-reversible preview: the human-readable prefix + last 4 chars.
fn preview_secret(secret: &str) -> String {
    let last4: String = secret.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
    let prefix: String = secret.chars().take(10).collect();
    format!("{prefix}…{last4}")
}

/// Generate a fresh, recognizable secret: `sk-cognia-` + 48 hex chars. The
/// `sk-` prefix keeps OpenAI clients that sanity-check the shape happy.
pub fn generate_secret() -> String {
    let a = uuid::Uuid::new_v4().simple().to_string();
    let b = uuid::Uuid::new_v4().simple().to_string();
    format!("sk-cognia-{}{}", &a[..24], &b[..24])
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Load the persisted key list, running the one-time legacy migration if the
/// blob is absent but an old single token exists.
pub fn load_keys() -> Result<Vec<GatewayApiKey>, String> {
    if let Some(raw) = secret_store::get(SERVICE, KEYS_ACCOUNT)? {
        let keys: Vec<GatewayApiKey> = serde_json::from_str(&raw)
            .map_err(|e| format!("corrupt gateway key store: {e}"))?;
        return Ok(keys);
    }
    // No keys blob yet — migrate a legacy single token if present.
    if let Some(legacy) = secret_store::get(SERVICE, LEGACY_TOKEN_ACCOUNT)? {
        let migrated = vec![GatewayApiKey {
            id: uuid::Uuid::new_v4().simple().to_string(),
            name: "Default".to_string(),
            secret: legacy,
            model_allowlist: Vec::new(),
            expires_at_ms: None,
            enabled: true,
            rate_limit_per_min: None,
            created_at_ms: now_ms(),
            last_used_at_ms: None,
        }];
        save_keys(&migrated)?;
        // Best-effort cleanup — the blob is now authoritative.
        let _ = secret_store::delete(SERVICE, LEGACY_TOKEN_ACCOUNT);
        return Ok(migrated);
    }
    Ok(Vec::new())
}

pub fn save_keys(keys: &[GatewayApiKey]) -> Result<(), String> {
    let raw = serde_json::to_string(keys).map_err(|e| format!("serialize keys: {e}"))?;
    secret_store::set(SERVICE, KEYS_ACCOUNT, &raw)
}

/// Create a new key with a freshly generated secret and persist it.
#[allow(clippy::too_many_arguments)]
pub fn create_key(
    keys: &mut Vec<GatewayApiKey>,
    name: String,
    model_allowlist: Vec<String>,
    expires_at_ms: Option<i64>,
    rate_limit_per_min: Option<u32>,
) -> Result<GatewayApiKey, String> {
    let key = GatewayApiKey {
        id: uuid::Uuid::new_v4().simple().to_string(),
        name,
        secret: generate_secret(),
        model_allowlist,
        expires_at_ms,
        enabled: true,
        rate_limit_per_min,
        created_at_ms: now_ms(),
        last_used_at_ms: None,
    };
    keys.push(key.clone());
    save_keys(keys)?;
    Ok(key)
}

/// Fields the renderer may mutate on an existing key (secret is immutable —
/// rotate by deleting + recreating).
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyPatch {
    pub name: Option<String>,
    pub model_allowlist: Option<Vec<String>>,
    /// `Some(None)` clears the expiry; absent leaves it unchanged.
    #[serde(default, deserialize_with = "double_option")]
    pub expires_at_ms: Option<Option<i64>>,
    pub enabled: Option<bool>,
    #[serde(default, deserialize_with = "double_option")]
    pub rate_limit_per_min: Option<Option<u32>>,
}

/// Distinguish "field absent" from "field present and null" during deserialize
/// so a patch can explicitly clear an optional value.
fn double_option<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    Ok(Some(Option::deserialize(deserializer)?))
}

pub fn apply_patch(
    keys: &mut [GatewayApiKey],
    id: &str,
    patch: ApiKeyPatch,
) -> Result<(), String> {
    let key = keys
        .iter_mut()
        .find(|k| k.id == id)
        .ok_or_else(|| format!("no such key: {id}"))?;
    if let Some(name) = patch.name {
        key.name = name;
    }
    if let Some(models) = patch.model_allowlist {
        key.model_allowlist = models;
    }
    if let Some(exp) = patch.expires_at_ms {
        key.expires_at_ms = exp;
    }
    if let Some(enabled) = patch.enabled {
        key.enabled = enabled;
    }
    if let Some(rl) = patch.rate_limit_per_min {
        key.rate_limit_per_min = rl;
    }
    Ok(())
}

pub fn delete_key(keys: &mut Vec<GatewayApiKey>, id: &str) -> bool {
    let before = keys.len();
    keys.retain(|k| k.id != id);
    keys.len() != before
}

/// Find the usable key whose secret matches `supplied`, comparing in constant
/// time. Returns the matched key's index (so the caller can bump `last_used`).
pub fn match_index(keys: &[GatewayApiKey], supplied: &str, now_ms: i64) -> Option<usize> {
    let supplied_bytes = supplied.as_bytes();
    let mut matched: Option<usize> = None;
    for (i, key) in keys.iter().enumerate() {
        if !key.is_usable(now_ms) {
            continue;
        }
        let secret = key.secret.as_bytes();
        if secret.len() == supplied_bytes.len()
            && secret.ct_eq(supplied_bytes).unwrap_u8() == 1
        {
            matched = Some(i);
        }
    }
    matched
}

/// Whether at least one usable (enabled + unexpired) key exists.
pub fn has_usable_key(keys: &[GatewayApiKey], now_ms: i64) -> bool {
    keys.iter().any(|k| k.is_usable(now_ms))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(id: &str, secret: &str) -> GatewayApiKey {
        GatewayApiKey {
            id: id.to_string(),
            name: id.to_string(),
            secret: secret.to_string(),
            model_allowlist: Vec::new(),
            expires_at_ms: None,
            enabled: true,
            rate_limit_per_min: None,
            created_at_ms: 0,
            last_used_at_ms: None,
        }
    }

    #[test]
    fn generated_secret_has_prefix_and_length() {
        let s = generate_secret();
        assert!(s.starts_with("sk-cognia-"));
        assert_eq!(s.len(), "sk-cognia-".len() + 48);
    }

    #[test]
    fn expiry_and_usability() {
        let mut k = key("a", "s");
        assert!(k.is_usable(1000));
        k.expires_at_ms = Some(500);
        assert!(k.is_expired(500));
        assert!(!k.is_usable(500));
        k.expires_at_ms = Some(2000);
        assert!(k.is_usable(1000));
        k.enabled = false;
        assert!(!k.is_usable(1000));
    }

    #[test]
    fn match_index_finds_usable_and_rejects_wrong_or_expired() {
        let mut keys = vec![key("a", "secret-aaaa"), key("b", "secret-bbbb")];
        assert_eq!(match_index(&keys, "secret-bbbb", 0), Some(1));
        assert_eq!(match_index(&keys, "nope", 0), None);
        // length mismatch never matches
        assert_eq!(match_index(&keys, "secret-bbbb-extra", 0), None);
        keys[1].expires_at_ms = Some(10);
        assert_eq!(match_index(&keys, "secret-bbbb", 20), None); // expired
        keys[0].enabled = false;
        assert_eq!(match_index(&keys, "secret-aaaa", 0), None); // disabled
    }

    #[test]
    fn has_usable_key_reflects_state() {
        let mut keys = vec![key("a", "s")];
        assert!(has_usable_key(&keys, 0));
        keys[0].enabled = false;
        assert!(!has_usable_key(&keys, 0));
    }

    #[test]
    fn create_and_delete_round_trip() {
        // secret_store routes through an in-memory map under cfg(test).
        let mut keys = load_keys().unwrap();
        let start = keys.len();
        let made = create_key(&mut keys, "Tool".into(), vec!["fast".into()], Some(999), Some(60))
            .unwrap();
        assert_eq!(keys.len(), start + 1);
        assert!(made.secret.starts_with("sk-cognia-"));
        assert_eq!(made.model_allowlist, vec!["fast".to_string()]);
        // reloading yields the persisted key
        let reloaded = load_keys().unwrap();
        assert!(reloaded.iter().any(|k| k.id == made.id));
        // delete
        assert!(delete_key(&mut keys, &made.id));
        save_keys(&keys).unwrap();
        assert!(!load_keys().unwrap().iter().any(|k| k.id == made.id));
    }

    #[test]
    fn apply_patch_mutates_and_clears() {
        let mut keys = vec![key("a", "s")];
        let patch: ApiKeyPatch = serde_json::from_value(serde_json::json!({
            "name": "renamed",
            "enabled": false,
            "expiresAtMs": 4242,
            "modelAllowlist": ["only-this"],
        }))
        .unwrap();
        apply_patch(&mut keys, "a", patch).unwrap();
        assert_eq!(keys[0].name, "renamed");
        assert!(!keys[0].enabled);
        assert_eq!(keys[0].expires_at_ms, Some(4242));
        assert_eq!(keys[0].model_allowlist, vec!["only-this".to_string()]);

        // Explicit null clears the expiry.
        let clear: ApiKeyPatch =
            serde_json::from_value(serde_json::json!({ "expiresAtMs": null })).unwrap();
        apply_patch(&mut keys, "a", clear).unwrap();
        assert_eq!(keys[0].expires_at_ms, None);

        // Absent field leaves it unchanged.
        let noop: ApiKeyPatch = serde_json::from_value(serde_json::json!({ "name": "x" })).unwrap();
        apply_patch(&mut keys, "a", noop).unwrap();
        assert_eq!(keys[0].expires_at_ms, None);
        assert_eq!(keys[0].name, "x");

        assert!(apply_patch(&mut keys, "missing", ApiKeyPatch::default()).is_err());
    }

    #[test]
    fn redacted_hides_secret_but_keeps_fingerprint() {
        let k = key("a", "sk-cognia-abcdef1234");
        let r = k.redacted();
        assert!(!serde_json::to_string(&r).unwrap().contains("abcdef1234"));
        assert!(r.secret_preview.contains('…'));
        assert!(r.secret_preview.ends_with("1234"));
    }
}

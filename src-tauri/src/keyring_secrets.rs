//! Generic OS-keyring-backed key/value secret store.
//!
//! Used by the workflow runtime (`SecretResolver`) and by per-plugin
//! credential stores (GitHub Delivery PAT / App key, E2B API key, …) that
//! need to keep tokens out of IndexedDB. Each entry is identified by a
//! `(namespace, key)` pair; the underlying keyring service name is
//! `com.cognia.<namespace>/v1` and the account is the key verbatim.
//!
//! The existing `anthropic_subscription` keyring module is left alone —
//! it has a specialised JSON shape and its own command surface. This module
//! is for plain string-valued secrets.
//!
//! Lookup / set / delete commands all swallow keyring `NoEntry` errors as
//! `Ok(None)` / no-ops so the caller can keep a single happy path.

use keyring::Entry;
use serde::{Deserialize, Serialize};

const SERVICE_PREFIX: &str = "com.cognia.";
const SERVICE_SUFFIX: &str = "/v1";

fn service_name(namespace: &str) -> String {
    format!("{SERVICE_PREFIX}{namespace}{SERVICE_SUFFIX}")
}

fn entry(namespace: &str, key: &str) -> Result<Entry, String> {
    if namespace.is_empty() {
        return Err("keyring namespace must not be empty".into());
    }
    if key.is_empty() {
        return Err("keyring key must not be empty".into());
    }
    Entry::new(&service_name(namespace), key).map_err(|e| format!("keyring init failed: {e}"))
}

/// Read a single secret. Returns `Ok(None)` when nothing is stored under
/// `(namespace, key)`.
pub fn get(namespace: &str, key: &str) -> Result<Option<String>, String> {
    let entry = entry(namespace, key)?;
    match entry.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keyring get failed: {e}")),
    }
}

/// Upsert a secret. Empty `value` is rejected — call {@link clear} to remove.
pub fn set(namespace: &str, key: &str, value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err("keyring set: value must not be empty".into());
    }
    entry(namespace, key)?
        .set_password(value)
        .map_err(|e| format!("keyring set failed: {e}"))
}

/// Remove an entry. Idempotent — missing entries return `Ok(())`.
pub fn clear(namespace: &str, key: &str) -> Result<(), String> {
    let entry = entry(namespace, key)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keyring clear failed: {e}")),
    }
}

// ── IPC surface ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyringInput {
    pub namespace: String,
    pub key: String,
    #[serde(default)]
    pub value: Option<String>,
}

#[tauri::command]
pub async fn keyring_secret_get(input: KeyringInput) -> Result<Option<String>, String> {
    get(&input.namespace, &input.key)
}

#[tauri::command]
pub async fn keyring_secret_set(input: KeyringInput) -> Result<(), String> {
    let value = input
        .value
        .as_deref()
        .ok_or_else(|| "keyring set: value is required".to_string())?;
    set(&input.namespace, &input.key, value)
}

#[tauri::command]
pub async fn keyring_secret_clear(input: KeyringInput) -> Result<(), String> {
    clear(&input.namespace, &input.key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn service_name_includes_namespace() {
        assert_eq!(service_name("github-delivery"), "com.cognia.github-delivery/v1");
    }

    #[test]
    fn entry_rejects_empty_namespace_and_key() {
        assert!(entry("", "k").is_err());
        assert!(entry("ns", "").is_err());
    }

    #[test]
    fn set_rejects_empty_value() {
        let err = set("test-ns", "k", "").unwrap_err();
        assert!(err.contains("must not be empty"));
    }
}

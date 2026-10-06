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
//! Lookup / set / delete all swallow keyring `NoEntry` errors as `Ok(None)` /
//! no-ops so the caller can keep a single happy path. The thin
//! `keyring_secret_*` `#[tauri::command]` shells live app-side.

use crate::secret_store;

const SERVICE_PREFIX: &str = "com.cognia.";
const SERVICE_SUFFIX: &str = "/v1";

fn service_name(namespace: &str) -> String {
    format!("{SERVICE_PREFIX}{namespace}{SERVICE_SUFFIX}")
}

/// Validate the `(namespace, key)` pair and return the resolved keyring
/// service name. Storage now goes through [`crate::secret_store`].
fn resolved_service(namespace: &str, key: &str) -> Result<String, String> {
    validate_namespace(namespace)?;
    validate_key(key)?;
    Ok(service_name(namespace))
}

/// A namespace may use `/` to separate its parts (`account-sync/v1`,
/// `mcp-credentials/v1`, `retrieval-profile-dek/v1`): every secret is a row in
/// one encrypted map keyed by `(service, account)` (`crate::secret_store`), so
/// a slash names nothing on disk, and `service_name` stays one-to-one because
/// it only wraps the namespace in a fixed prefix and suffix. What stays refused
/// is what still reads as a path or is ambiguous: empty parts (a leading,
/// trailing or doubled `/`), `.` / `..` parts, backslashes and control
/// characters.
fn validate_namespace(namespace: &str) -> Result<(), String> {
    if namespace.trim().is_empty() {
        return Err("keyring namespace must not be empty".into());
    }
    if namespace.trim() != namespace {
        return Err("keyring namespace must not have surrounding whitespace".into());
    }
    if namespace.chars().any(|ch| ch.is_control() || ch == '\\') {
        return Err("keyring namespace contains invalid characters".into());
    }
    if namespace
        .split('/')
        .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err("keyring namespace has an empty or relative path part".into());
    }
    Ok(())
}

fn validate_key(key: &str) -> Result<(), String> {
    if key.trim().is_empty() {
        return Err("keyring key must not be empty".into());
    }
    if key.trim() != key {
        return Err("keyring key must not have surrounding whitespace".into());
    }
    if key.chars().any(char::is_control) {
        return Err("keyring key contains invalid characters".into());
    }
    Ok(())
}

/// Read a single secret. Returns `Ok(None)` when nothing is stored under
/// `(namespace, key)`.
pub fn get(namespace: &str, key: &str) -> Result<Option<String>, String> {
    let service = resolved_service(namespace, key)?;
    secret_store::get(&service, key)
}

/// Upsert a secret. Empty `value` is rejected — call {@link clear} to remove.
pub fn set(namespace: &str, key: &str, value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err("keyring set: value must not be empty".into());
    }
    let service = resolved_service(namespace, key)?;
    secret_store::set(&service, key, value)
}

/// Remove an entry. Idempotent — missing entries return `Ok(())`.
pub fn clear(namespace: &str, key: &str) -> Result<(), String> {
    let service = resolved_service(namespace, key)?;
    secret_store::delete(&service, key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn service_name_includes_namespace() {
        assert_eq!(service_name("demo-delivery"), "com.cognia.demo-delivery/v1");
        assert_eq!(service_name("plugin:p"), "com.cognia.plugin:p/v1");
    }

    #[test]
    fn resolved_service_rejects_empty_namespace_and_key() {
        assert!(resolved_service("", "k").is_err());
        assert!(resolved_service("ns", "").is_err());
    }

    #[test]
    fn resolved_service_rejects_blank_or_untrimmed_namespace_and_key() {
        assert!(resolved_service("   ", "k").is_err());
        assert!(resolved_service(" ns", "k").is_err());
        assert!(resolved_service("ns ", "k").is_err());
        assert!(resolved_service("ns", "   ").is_err());
        assert!(resolved_service("ns", " key").is_err());
        assert!(resolved_service("ns", "key ").is_err());
    }

    #[test]
    fn resolved_service_rejects_backslashes_and_control_chars() {
        assert!(resolved_service("bad\\name", "k").is_err());
        assert!(resolved_service("bad\nname", "k").is_err());
        assert_eq!(
            resolved_service("plugin:p", "token").unwrap(),
            "com.cognia.plugin:p/v1"
        );
    }

    // The app's own namespaces use `/` between a name and its version; they
    // were refused here, so nothing under them could be stored on desktop or
    // a headless host (account sync keys, MCP credentials, retrieval keys).
    #[test]
    fn resolved_service_accepts_slash_separated_namespaces() {
        for namespace in [
            "account-sync/v1",
            "mcp-credentials/v1",
            "retrieval-profile-dek/v1",
        ] {
            assert_eq!(
                resolved_service(namespace, "k").unwrap(),
                format!("com.cognia.{namespace}/v1")
            );
        }
    }

    #[test]
    fn resolved_service_rejects_empty_or_relative_path_parts() {
        for namespace in [
            "/name", "name/", "a//b", ".", "..", "a/./b", "a/../b", "../a",
        ] {
            assert!(resolved_service(namespace, "k").is_err(), "{namespace}");
        }
    }

    #[test]
    fn slash_namespaces_round_trip_and_stay_apart_from_their_parent() {
        set("keyring-slash/v1", "tok", "child").unwrap();
        set("keyring-slash", "tok", "parent").unwrap();
        assert_eq!(
            get("keyring-slash/v1", "tok").unwrap(),
            Some("child".to_string())
        );
        assert_eq!(
            get("keyring-slash", "tok").unwrap(),
            Some("parent".to_string())
        );
        clear("keyring-slash/v1", "tok").unwrap();
        clear("keyring-slash", "tok").unwrap();
        assert_eq!(get("keyring-slash/v1", "tok").unwrap(), None);
    }

    #[test]
    fn set_rejects_empty_value() {
        let err = set("test-ns", "k", "").unwrap_err();
        assert!(err.contains("must not be empty"));
    }

    #[test]
    fn get_set_clear_round_trip() {
        // Hermetic via the in-memory secret_store global under cfg(test).
        let ns = "keyring-secrets-round-trip";
        assert_eq!(get(ns, "tok").unwrap(), None);
        set(ns, "tok", "s3cr3t").unwrap();
        assert_eq!(get(ns, "tok").unwrap(), Some("s3cr3t".to_string()));
        clear(ns, "tok").unwrap();
        assert_eq!(get(ns, "tok").unwrap(), None);
    }
}

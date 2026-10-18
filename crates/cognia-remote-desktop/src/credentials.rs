//! Binding credentials live in the Host secret store (ADR-0234 §5), keyed by
//! binding id and kind. They are read only by the bridge that authenticates
//! to the server and are never returned to a client.

use serde::{Deserialize, Serialize};

pub const NAMESPACE: &str = "remote-desktop";
/// VncAuth uses the first eight bytes; the cap only bounds what is stored.
pub const MAX_CREDENTIAL_BYTES: usize = 256;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CredentialKind {
    /// Full-control password.
    Control,
    /// Server-enforced view-only password.
    View,
}

impl CredentialKind {
    pub fn as_str(self) -> &'static str {
        match self {
            CredentialKind::Control => "control",
            CredentialKind::View => "view",
        }
    }
}

pub fn key(binding_id: &str, kind: CredentialKind) -> String {
    format!("{binding_id}:{}", kind.as_str())
}

/// Blocking secret access; callers run it off the async workers.
pub trait CredentialStore: Send + Sync + 'static {
    fn get(&self, key: &str) -> Result<Option<String>, String>;
    fn set(&self, key: &str, value: &str) -> Result<(), String>;
    fn clear(&self, key: &str) -> Result<(), String>;
}

/// The Host's encrypted secret store (`cognia-secrets`). Headless Hosts must
/// have run `secret_store::init_headless` first, as the server already does.
pub struct KeyringCredentials;

impl CredentialStore for KeyringCredentials {
    fn get(&self, key: &str) -> Result<Option<String>, String> {
        cognia_secrets::keyring_secrets::get(NAMESPACE, key)
    }

    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        cognia_secrets::keyring_secrets::set(NAMESPACE, key, value)
    }

    fn clear(&self, key: &str) -> Result<(), String> {
        cognia_secrets::keyring_secrets::clear(NAMESPACE, key)
    }
}

/// In-memory store for tests of the Host facade.
#[cfg(test)]
#[derive(Default)]
pub(crate) struct MemoryCredentials {
    pub entries: parking_lot::Mutex<std::collections::HashMap<String, String>>,
    pub fail: std::sync::atomic::AtomicBool,
}

#[cfg(test)]
impl MemoryCredentials {
    fn check(&self) -> Result<(), String> {
        if self.fail.load(std::sync::atomic::Ordering::SeqCst) {
            Err("secret store unavailable".into())
        } else {
            Ok(())
        }
    }
}

#[cfg(test)]
impl CredentialStore for MemoryCredentials {
    fn get(&self, key: &str) -> Result<Option<String>, String> {
        self.check()?;
        Ok(self.entries.lock().get(key).cloned())
    }

    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        self.check()?;
        self.entries.lock().insert(key.into(), value.into());
        Ok(())
    }

    fn clear(&self, key: &str) -> Result<(), String> {
        self.check()?;
        self.entries.lock().remove(key);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_name_the_binding_and_kind() {
        assert_eq!(key("b1", CredentialKind::Control), "b1:control");
        assert_eq!(key("b1", CredentialKind::View), "b1:view");
        assert_eq!(
            serde_json::to_value(CredentialKind::View).unwrap(),
            serde_json::json!("view")
        );
    }

    #[test]
    fn the_memory_store_round_trips_and_can_fail() {
        let store = MemoryCredentials::default();
        store.set("k", "v").unwrap();
        assert_eq!(store.get("k").unwrap().as_deref(), Some("v"));
        store.clear("k").unwrap();
        assert_eq!(store.get("k").unwrap(), None);
        store.fail.store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(store.get("k").is_err());
    }
}

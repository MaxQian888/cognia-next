//! Credential persistence seam (ADR-0067 Phase 4).
//!
//! `cognia-vector` must not depend on the desktop app's `secret_store` /
//! `keyring_secrets` (that would re-introduce an upward edge). Instead the app
//! installs a [`CredentialStore`] implementation at boot; the vector credential
//! CRUD in [`crate::credentials`] resolves it through the process-global set
//! here. This mirrors the instrumentation registry pattern — a single global,
//! installed once.

use once_cell::sync::OnceCell;

/// Persist per-provider vector credentials out of process (the OS keyring in
/// the desktop app). Entries are namespaced `(namespace, key)` string values;
/// errors surface as a `String` and are wrapped into `VectorError::Auth` by the
/// caller.
pub trait CredentialStore: Send + Sync {
    fn set(&self, namespace: &str, key: &str, value: &str) -> Result<(), String>;
    fn get(&self, namespace: &str, key: &str) -> Result<Option<String>, String>;
    fn clear(&self, namespace: &str, key: &str) -> Result<(), String>;
}

static STORE: OnceCell<Box<dyn CredentialStore>> = OnceCell::new();

/// Install the process credential store. Called once at app boot; a second
/// call is ignored (first install wins).
pub fn install_credential_store(store: Box<dyn CredentialStore>) {
    let _ = STORE.set(store);
}

/// Resolve the installed store, or an error if the app never installed one
/// (e.g. a unit test that exercises a credential command without wiring).
pub(crate) fn store() -> Result<&'static dyn CredentialStore, String> {
    STORE
        .get()
        .map(|b| b.as_ref())
        .ok_or_else(|| "vector credential store not installed".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use parking_lot::Mutex;
    use std::collections::HashMap;

    struct MemStore(Mutex<HashMap<(String, String), String>>);
    impl CredentialStore for MemStore {
        fn set(&self, ns: &str, key: &str, value: &str) -> Result<(), String> {
            self.0.lock().insert((ns.into(), key.into()), value.into());
            Ok(())
        }
        fn get(&self, ns: &str, key: &str) -> Result<Option<String>, String> {
            Ok(self.0.lock().get(&(ns.into(), key.into())).cloned())
        }
        fn clear(&self, ns: &str, key: &str) -> Result<(), String> {
            self.0.lock().remove(&(ns.into(), key.into()));
            Ok(())
        }
    }

    #[test]
    fn store_roundtrips_through_the_trait() {
        let s = MemStore(Mutex::new(HashMap::new()));
        s.set("ns", "k", "v").unwrap();
        assert_eq!(s.get("ns", "k").unwrap().as_deref(), Some("v"));
        s.clear("ns", "k").unwrap();
        assert_eq!(s.get("ns", "k").unwrap(), None);
    }

    #[test]
    fn store_returns_error_when_uninstalled() {
        // The process-global is either unset (this test) or set by a sibling
        // test; only assert the uninstalled branch when it is genuinely unset.
        if STORE.get().is_none() {
            assert!(store().is_err());
        }
    }
}

//! Native vector store subsystem.
//!
//! Mirrors `src-tauri/src/scheduler/` byte-for-byte at the module level:
//! - `commands` — Tauri command handlers exposed to JS.
//! - `db` — SQLite-backed `VectorStore` with a `parking_lot::Mutex<Connection>`.
//! - `error` — `thiserror`-derived `VectorError` + `Result<T>` alias.
//! - `filters` — pure SQL builder for the unified filter DSL.
//! - `schema` — versioned migration tuples.
//! - `types` — wire types (`Point`, `Collection`, `SearchHit`, `Filter`,
//!   `FilterOp`, …) shared by `commands` and `db`.
//!
//! `VectorState` wraps `Option<VectorStore>` so an init failure (corrupt
//! file, missing data dir, sqlite-vec extension load error) leaves the
//! commands operational but reporting `NotAvailable` — same posture as
//! `scheduler::SchedulerState`'s `metadata_store`.

pub mod backend;
pub mod backends;
pub mod commands;
pub mod credential_store;
pub mod credentials;
pub mod db;
pub mod error;
pub mod filters;
pub mod registry;
pub mod schema;
pub mod types;

use std::path::PathBuf;

use log::error;
use parking_lot::Mutex;

pub use backend::VectorBackend;
pub use credential_store::{install_credential_store, CredentialStore};
pub use db::{ScrollPage, VectorStore};
pub use error::{Result, VectorError};
pub use registry::VectorRegistry;
#[allow(unused_imports)]
pub use types::*;

/// Tri-state for the lazily-opened vector store.
///
/// `Unavailable` is terminal: once an open attempt fails (or no path was
/// provided) we don't retry, so a corrupt file doesn't pay the open cost on
/// every query.
enum LazyStore {
    Uninit,
    Ready(VectorStore),
    Unavailable,
}

/// Application state wrapper. Held by Tauri via `.manage(...)`.
///
/// Opening the store (sqlite-vec extension load + `Connection::open` +
/// migrations) is **deferred to first use** rather than done in `new()`:
/// nothing on the app-startup path touches the vector store — RAG/twin
/// queries are all user-initiated — so building it eagerly only blocked the
/// synchronous Tauri `setup()`/builder path. The `Mutex` serialises the
/// one-time open and the (rare) `reset`.
pub struct VectorState {
    /// SQLite path; `None` in web mode / tests with no backing file.
    path: Option<PathBuf>,
    store: Mutex<LazyStore>,
}

impl VectorState {
    pub fn new(path: Option<PathBuf>) -> Self {
        Self {
            path,
            store: Mutex::new(LazyStore::Uninit),
        }
    }

    /// Resolve the lazy slot to a terminal state under the held lock. Safe
    /// under concurrency: the mutex serialises the one-time open so a second
    /// caller never observes `Uninit` mid-open.
    fn ensure(&self, slot: &mut LazyStore) {
        if matches!(slot, LazyStore::Uninit) {
            *slot = match self.path.as_ref() {
                Some(p) => match VectorStore::new(p.clone()) {
                    Ok(s) => LazyStore::Ready(s),
                    Err(e) => {
                        error!("vector store init failed: {}", e);
                        LazyStore::Unavailable
                    }
                },
                None => LazyStore::Unavailable,
            };
        }
    }

    /// Borrow the underlying store for a read-only operation, opening it on
    /// first call. Returns `NotAvailable` when init failed or no path was
    /// provided.
    ///
    /// We hand back a `MutexGuard` mapped to `&VectorStore` so callers can
    /// chain into `VectorStore` methods without separately locking. The
    /// guard lifetime is tied to `&self` — see callers in `commands.rs`.
    pub fn store(&self) -> Result<VectorStoreGuard<'_>> {
        let mut guard = self.store.lock();
        self.ensure(&mut guard);
        if !matches!(*guard, LazyStore::Ready(_)) {
            return Err(VectorError::NotAvailable(
                "vector store not initialised".into(),
            ));
        }
        Ok(VectorStoreGuard { guard })
    }

    /// Replace the store with a fresh empty one — calls
    /// `VectorStore::reset_store` on the existing instance, preserving
    /// the SQLite path. Opens the store first if it hasn't been yet. Returns
    /// `NotAvailable` if no path was provided or the open failed.
    pub fn reset(&self) -> Result<()> {
        let mut guard = self.store.lock();
        self.ensure(&mut guard);
        match &mut *guard {
            LazyStore::Ready(store) => store.reset_store(),
            _ => Err(VectorError::NotAvailable(
                "vector store not initialised".into(),
            )),
        }
    }
}

impl Default for VectorState {
    fn default() -> Self {
        Self::new(None)
    }
}

/// RAII guard that derefs to `&VectorStore`. The mutex is held for the
/// whole borrow — same posture as `parking_lot::MutexGuard`. Inside a
/// command handler the lock is released as soon as the borrow ends.
pub struct VectorStoreGuard<'a> {
    guard: parking_lot::MutexGuard<'a, LazyStore>,
}

impl<'a> std::ops::Deref for VectorStoreGuard<'a> {
    type Target = VectorStore;

    fn deref(&self) -> &Self::Target {
        // `store()` only builds a guard after confirming the slot is `Ready`.
        match &*self.guard {
            LazyStore::Ready(store) => store,
            _ => unreachable!("store was Ready at borrow time"),
        }
    }
}

impl<'a> std::fmt::Debug for VectorStoreGuard<'a> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VectorStoreGuard").finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn state_with_valid_path_yields_store() {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("v.sqlite");
        let state = VectorState::new(Some(path.clone()));
        let guard = state.store().expect("store");
        // Smoke: list collections on a fresh store should succeed.
        let list = guard.list_collections().expect("list");
        assert!(list.is_empty());
    }

    #[test]
    fn state_without_path_returns_not_available() {
        let state = VectorState::new(None);
        let err = state.store().unwrap_err();
        assert!(matches!(err, VectorError::NotAvailable(_)));
        let reset_err = state.reset().unwrap_err();
        assert!(matches!(reset_err, VectorError::NotAvailable(_)));
    }

    #[test]
    fn open_is_deferred_until_first_access() {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("lazy.sqlite");
        let state = VectorState::new(Some(path.clone()));
        // Construction must NOT touch disk — the eager open used to run here
        // on the synchronous Tauri startup path.
        assert!(!path.exists(), "sqlite file created before first access");
        // First access opens it.
        let _ = state.store().expect("store");
        assert!(path.exists(), "sqlite file not created on first access");
    }

    #[test]
    fn reset_clears_existing_collections() {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("v.sqlite");
        let state = VectorState::new(Some(path));
        {
            let guard = state.store().expect("store");
            guard
                .create_collection("c", 3, None, None, None, None)
                .expect("create");
            assert_eq!(guard.list_collections().expect("list").len(), 1);
        }
        state.reset().expect("reset");
        let guard = state.store().expect("store after reset");
        assert!(guard.list_collections().expect("list").is_empty());
    }
}

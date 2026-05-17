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
pub use db::{ScrollPage, VectorStore};
pub use error::{Result, VectorError};
pub use registry::VectorRegistry;
#[allow(unused_imports)]
pub use types::*;

/// Application state wrapper. Held by Tauri via `.manage(...)`. The inner
/// `Mutex` is short-lived: only `reset_store` actually replaces the
/// store; everything else takes a shared `&VectorStore`.
pub struct VectorState {
    store: Mutex<Option<VectorStore>>,
}

impl VectorState {
    pub fn new(path: Option<PathBuf>) -> Self {
        let store = path.and_then(|p| match VectorStore::new(p) {
            Ok(s) => Some(s),
            Err(e) => {
                error!("vector store init failed: {}", e);
                None
            }
        });
        Self {
            store: Mutex::new(store),
        }
    }

    /// Borrow the underlying store for a read-only operation. Returns
    /// `NotAvailable` when init failed or no path was provided.
    ///
    /// We hand back a `MutexGuard` mapped to `&VectorStore` so callers can
    /// chain into `VectorStore` methods without separately locking. The
    /// guard lifetime is tied to `&self` — see callers in `commands.rs`.
    pub fn store(&self) -> Result<VectorStoreGuard<'_>> {
        let guard = self.store.lock();
        if guard.is_none() {
            return Err(VectorError::NotAvailable(
                "vector store not initialised".into(),
            ));
        }
        Ok(VectorStoreGuard { guard })
    }

    /// Replace the store with a fresh empty one — calls
    /// `VectorStore::reset_store` on the existing instance, preserving
    /// the SQLite path. Returns `NotAvailable` if the store was never
    /// initialised.
    pub fn reset(&self) -> Result<()> {
        let mut guard = self.store.lock();
        let store = guard.as_mut().ok_or_else(|| {
            VectorError::NotAvailable("vector store not initialised".into())
        })?;
        store.reset_store()
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
    guard: parking_lot::MutexGuard<'a, Option<VectorStore>>,
}

impl<'a> std::ops::Deref for VectorStoreGuard<'a> {
    type Target = VectorStore;

    fn deref(&self) -> &Self::Target {
        // `store()` already verified the inner `Option` is `Some`.
        self.guard.as_ref().expect("store was Some at borrow time")
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

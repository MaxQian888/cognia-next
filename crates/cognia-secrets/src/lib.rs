//! Secrets foundation shared across cognia subsystem crates (ADR-0067).
//!
//! - [`secret_store`] — the single-keychain encrypted store (one master key in
//!   the OS keyring, everything else AES-256-GCM in one file).
//! - [`keyring_secrets`] — namespaced plain-string secrets on top of it.
//! - [`api_key`] — the in-process Anthropic provider env store pushed by the
//!   frontend and injected into the sidecar environment at spawn.
//!
//! `app_lib` re-aliases each module (`pub use cognia_secrets::secret_store;`)
//! so existing `crate::secret_store::…` call sites are unchanged. The thin
//! `#[tauri::command]` shells (`keyring_secret_*`) stay app-side.
//!
//! Dependents' test suites MUST enable the `test-inmemory` feature from their
//! `[dev-dependencies]` — see the note in `Cargo.toml`.

pub mod api_key;
pub mod keyring_secrets;
pub mod secret_store;

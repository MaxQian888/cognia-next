//! Confined filesystem access for cognia (ADR-0067 Tier C — extracted from
//! `app_lib`).
//!
//! Everything lives in the [`files`] submodule rather than at this crate root:
//! its 23 `#[tauri::command]` fns are declared at module level, and a
//! `#[tauri::command]` at a library crate root collides in the macro namespace
//! (E0255) — the same reason `cognia-ocr` keeps its commands in `native`.
//!
//! `app_lib` re-exports that submodule as `pub use cognia_files::files;`, so
//! the 23 `files::…` entries in `generate_handler!` and every
//! `crate::files::…` call site in `companion_api/rpc/*`, `companion_api/acp`
//! and `codeserver` resolve unchanged.
//!
//! The allowed-roots and remote-git-workspace registries are process-global
//! `OnceLock`s, deliberately not Tauri managed state: the headless server and
//! the desktop shell seed the same process. `app_lib`'s setup still calls
//! `files::seed_default_allowed_roots()`, now through this crate.

//! Ten items that were `pub(crate)` inside `app_lib` are `pub` here — the
//! `companion_api` RPC layer and `codeserver` call them and stayed app-side.
//! The two `*_impl` helpers with no outside caller stay `pub(crate)`.

pub mod files;

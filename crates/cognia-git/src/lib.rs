//! Source Control subsystem (ADR-0038) — a VSCode-style Git panel backend.
//!
//! Hybrid by necessity: this build of `git2`/libgit2 has no network transport
//! (`Cargo.toml`: `default-features = false`, no `https`/`ssh`), so read
//! operations use git2 directly while every mutating / network operation
//! shells out to the user's system `git` (which also runs hooks, signing, and
//! the OS credential manager). See the submodule docs for the split.
//!
//! Command surface: `commands::git_*` (registered in `lib.rs`). The only
//! persistent state is [`watcher::GitWatcherState`].

pub mod blame;
pub mod branch;
// ADR-0067 Tier C — local code-adoption tracking moved in from `app_lib`;
// its only cross-module need was this crate's `diff::file_diff`.
pub mod code_adoption;
// ADR-0196 P6 — the Twin git-history importer, out of `app_lib`, where it was
// the last direct `git2` user.
pub mod code_repo;
/// The command surface. The bodies are host-neutral, so the companion RPC
/// families call them on any host; the `#[tauri::command]` shells over them,
/// and the watcher commands that need an `AppHandle`, are behind `tauri-host`,
/// which only `src-tauri` enables (ADR-0196).
pub mod commands;
pub mod commit;
pub mod diff;
pub mod diff_stat;
pub mod error;
pub mod exec;
// ADR-0196 P6 — the plugin GitHub workspace (clone, commit-and-push), out of
// `app_lib`.
pub mod github;
pub mod history;
pub mod interactive_rebase;
pub mod merge;
// ADR-0227 §6 — immutable-key history/blame cache.
pub mod query_cache;
pub mod read;
pub mod remote;
pub mod repo;
pub mod reset;
pub mod restore;
pub mod sequencer;
pub mod stack;
pub mod stage;
pub mod stash;
pub mod status;
pub mod tag;
pub mod types;
pub mod watcher;
pub mod worktree;

pub use watcher::GitWatcherState;

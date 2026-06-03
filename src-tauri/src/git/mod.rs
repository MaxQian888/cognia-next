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
pub mod commands;
pub mod commit;
pub mod diff;
pub mod error;
pub mod exec;
pub mod history;
pub mod interactive_rebase;
pub mod merge;
pub mod read;
pub mod remote;
pub mod reset;
pub mod restore;
pub mod sequencer;
pub mod stage;
pub mod stash;
pub mod status;
pub mod tag;
pub mod types;
pub mod watcher;

pub use watcher::GitWatcherState;

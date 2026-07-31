//! UX/TUI infrastructure shared by every `cognia plugin *` subcommand.
//!
//! The CLI is otherwise pure command-and-exit. This module centralizes:
//!
//! - `RuntimeUi` — per-invocation flags (color, json, quiet, verbose, yes)
//!   plus the user-input adapter (`Prompter`).
//! - `Prompter` — trait abstraction over `dialoguer` so tests can inject
//!   deterministic answers without spawning a TTY.
//! - `progress` — factories for `indicatif` spinners / bars that hide
//!   themselves when not on a TTY.
//! - `style` — owo-colors palette shared by every command.
//! - `error` — `color-eyre` install hook + `Suggestion` helper.
//!
//! See `plans/cli-tui-majestic-quokka.md` for the full design.

pub mod error;
pub mod progress;
pub mod prompter;
pub mod runtime;
pub mod style;

// Public re-exports — surface for tests + future external consumers.
// Marked `unused_imports` because not every binary build of cognia-cli
// references every symbol at the top level (most live inside `commands::*`
// modules, which import them directly from `ui::prompter` / `ui::runtime`).
#[allow(unused_imports)]
pub use prompter::{MockPrompter, NoninteractivePrompter, PromptError, Prompter};
#[allow(unused_imports)]
pub use runtime::{ColorMode, RuntimeUi};

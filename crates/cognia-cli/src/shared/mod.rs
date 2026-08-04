//! Cross-cutting helpers shared by the command handlers and engines.
//!
//! Everything here is small, dependency-light, and reused by more than one
//! command, so it lives one layer below `commands/` and `engine/`. Leaf items
//! are re-exported flat (`crate::shared::read_plugin_manifest`) to keep call
//! sites terse.

pub(crate) mod encoding;
pub(crate) mod exit;
pub(crate) mod manifest;
pub(crate) mod process;
pub(crate) mod semver;

pub(crate) use encoding::{b64_decode, b64_encode};
pub(crate) use exit::JsonFailureExit;
pub(crate) use manifest::read_plugin_manifest;
pub(crate) use process::{
    clear_process_interrupt, request_process_interrupt, run_streaming, ProcessInterrupted,
};
pub(crate) use semver::looks_like_semver;

#[cfg(test)]
pub(crate) use exit::test_env;

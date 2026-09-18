//! Cross-cutting helpers shared by the command handlers and engines.
//!
//! Everything here is small, dependency-light, and reused by more than one
//! command, so it lives one layer below `commands/` and `engine/`. Leaf items
//! are re-exported flat (`crate::shared::read_plugin_manifest`) to keep call
//! sites terse.

pub(crate) mod encoding;
pub(crate) mod exit;
pub(crate) mod json_path;
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

/// Serialize `payload` as pretty JSON on stdout, projected through a
/// `--query` dot-path when one is given. Shared by the bridge commands,
/// whose payloads are typed structs rather than pre-built `Value`s.
pub(crate) fn print_json_projected<T: serde::Serialize>(
    payload: &T,
    query: Option<&str>,
) -> anyhow::Result<()> {
    let value = match query {
        Some(expression) => {
            json_path::project(&serde_json::to_value(payload)?, expression)
                .map_err(anyhow::Error::msg)?
        }
        None => serde_json::to_value(payload)?,
    };
    println!("{}", serde_json::to_string_pretty(&value)?);
    Ok(())
}

#[cfg(test)]
pub(crate) use exit::test_env;

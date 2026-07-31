//! Locate and parse a plugin's `plugin.json` manifest.

use anyhow::{bail, Context, Result};
use std::path::{Path, PathBuf};

/// Helper used across subcommands: read a plugin.json given a directory,
/// returning the parsed value plus the absolute path that was opened.
pub(crate) fn read_plugin_manifest(dir: &Path) -> Result<(serde_json::Value, PathBuf)> {
    let mut path = dir.join("plugin.json");
    if !path.exists() {
        // Allow running from the crate root where plugin.json sits next to
        // Cargo.toml; or from one level deeper if the user organized files.
        let alt = dir.join("manifest").join("plugin.json");
        if alt.exists() {
            path = alt;
        } else {
            bail!("plugin.json not found in {}", dir.display());
        }
    }
    let bytes = std::fs::read(&path).with_context(|| format!("read {}", path.display()))?;
    let parsed: serde_json::Value =
        serde_json::from_slice(&bytes).with_context(|| format!("parse {}", path.display()))?;
    Ok((parsed, path))
}

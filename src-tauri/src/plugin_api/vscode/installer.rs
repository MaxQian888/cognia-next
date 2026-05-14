//! `.vsix` installation.
//!
//! The renderer's `lib/plugin/vscode-shim/vsix-installer.ts` already
//! handles the JSZip-based extraction in JavaScript. This module mirrors
//! the same behaviour in Rust so installation can happen entirely on the
//! Tauri side (out-of-band of the renderer) — useful for headless installs,
//! CI smoke tests, and the upcoming Open VSX background-fetch path
//! (Phase M2).
//!
//! The Rust implementation reads the `.vsix` ZIP, validates the
//! `extension/package.json` shape, and unpacks every file under
//! `extension/` into `<extension_install_dir>/<publisher.name>/`.
//!
//! No JSZip dep — we use the `zip` crate for the actual decompression
//! (already a transitive dep of `tauri-plugin-store`).
//!
//! `dead_code` is silenced because `install_vsix` is called from
//! `commands.rs::plugin_vscode_install_vsix`, which is itself "dead" due
//! to the `tauri::generate_handler!` macro hiding callsites.
#![allow(dead_code)]

use std::fs;
use std::io::Read;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zip::ZipArchive;

#[derive(Debug, thiserror::Error)]
pub enum InstallError {
    #[error("VSIX exceeds size cap: {0} bytes")]
    TooLarge(usize),
    #[error("VSIX could not be opened as a ZIP: {0}")]
    InvalidZip(String),
    #[error("VSIX is missing extension/package.json")]
    MissingManifest,
    #[error("VSIX package.json is invalid JSON: {0}")]
    BadManifest(String),
    #[error("VSIX is missing required field: {0}")]
    MissingField(&'static str),
    #[error("filesystem error: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstallResult {
    pub extension_id: String,
    pub install_path: PathBuf,
    pub sha256_hex: String,
    pub package_json: serde_json::Value,
}

const MAX_VSIX_BYTES: usize = 200 * 1024 * 1024;
const MANIFEST_PATH: &str = "extension/package.json";
const EXTENSION_PREFIX: &str = "extension/";

pub fn install_vsix(
    payload: &[u8],
    install_root: &PathBuf,
) -> Result<InstallResult, InstallError> {
    if payload.len() > MAX_VSIX_BYTES {
        return Err(InstallError::TooLarge(payload.len()));
    }

    let mut hasher = Sha256::new();
    hasher.update(payload);
    let sha256_hex = hex::encode(hasher.finalize());

    let cursor = std::io::Cursor::new(payload);
    let mut archive = ZipArchive::new(cursor)
        .map_err(|e| InstallError::InvalidZip(format!("{e}")))?;

    // Read the manifest first to derive the canonical id.
    let manifest_bytes = {
        let mut entry = archive
            .by_name(MANIFEST_PATH)
            .map_err(|_| InstallError::MissingManifest)?;
        let mut buf = Vec::with_capacity(entry.size() as usize);
        entry.read_to_end(&mut buf)?;
        buf
    };
    let manifest: serde_json::Value = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| InstallError::BadManifest(format!("{e}")))?;
    let publisher = manifest
        .get("publisher")
        .and_then(|v| v.as_str())
        .ok_or(InstallError::MissingField("publisher"))?;
    let name = manifest
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or(InstallError::MissingField("name"))?;
    let extension_id = format!(
        "{}.{}",
        super::super::sanitize_plugin_id(publisher),
        super::super::sanitize_plugin_id(name)
    );

    // Materialise to disk.
    let install_path = install_root.join(&extension_id);
    if install_path.exists() {
        fs::remove_dir_all(&install_path)?;
    }
    fs::create_dir_all(&install_path)?;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| InstallError::InvalidZip(format!("entry {i}: {e}")))?;
        let name = entry.name().to_string();
        if !name.starts_with(EXTENSION_PREFIX) {
            continue;
        }
        let rel = &name[EXTENSION_PREFIX.len()..];
        if rel.is_empty() {
            continue;
        }
        // Reject path traversal — the zip crate already validates entry
        // names but defense-in-depth never hurts.
        if rel.contains("..") {
            continue;
        }
        let out_path = install_path.join(rel);
        if entry.is_dir() {
            fs::create_dir_all(&out_path)?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut out = fs::File::create(&out_path)?;
        std::io::copy(&mut entry, &mut out)?;
    }

    Ok(InstallResult {
        extension_id,
        install_path,
        sha256_hex,
        package_json: manifest,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::FileOptions;

    fn make_test_vsix() -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let options = FileOptions::<()>::default();
            zip.start_file("extension/package.json", options).unwrap();
            zip.write_all(
                br#"{ "publisher": "cognia", "name": "hello", "version": "1.0.0", "engines": { "vscode": ">=1.74.0" } }"#,
            )
            .unwrap();
            zip.start_file("extension/out/extension.js", options).unwrap();
            zip.write_all(b"module.exports = { activate() {}, deactivate() {} }")
                .unwrap();
            zip.finish().unwrap();
        }
        buf
    }

    #[test]
    fn rejects_payload_over_size_cap() {
        let huge = vec![0u8; MAX_VSIX_BYTES + 1];
        let result = install_vsix(&huge, &PathBuf::from("/tmp/x"));
        assert!(matches!(result, Err(InstallError::TooLarge(_))));
    }

    #[test]
    fn rejects_non_zip_payload() {
        let result = install_vsix(b"not a zip", &PathBuf::from("/tmp/x"));
        assert!(matches!(result, Err(InstallError::InvalidZip(_))));
    }

    #[test]
    fn install_unpacks_to_disk() {
        let dir = tempfile::tempdir().unwrap();
        let result = install_vsix(&make_test_vsix(), &dir.path().to_path_buf()).unwrap();
        assert_eq!(result.extension_id, "cognia.hello");
        assert!(result
            .install_path
            .join("out/extension.js")
            .exists());
        assert!(result.sha256_hex.len() == 64);
    }
}

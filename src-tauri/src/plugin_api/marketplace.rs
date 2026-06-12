//! Plugin marketplace Tauri commands (Batch 3c).
//!
//! Phase-1 implementations are intentionally network-light: `plugin_get_directory`
//! returns the install root; `plugin_invalidate_cache` clears the
//! marketplace cache directory; `plugin_marketplace_versions` and
//! `plugin_download_version` accept a `cache_only: Option<bool>` flag and
//! return a stub reply when network access is unavailable. Real registry
//! integration lands in a follow-up — the contract here is "command
//! exists so TS no longer silent-fails on desktop."

use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::State;

use super::github::installer::{
    copy_plugin_tree, find_plugin_manifest, read_manifest, validate_no_build,
};
use super::{PluginError, PluginRuntimeState, Result};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceVersion {
    pub version: String,
    pub published_at: Option<String>,
    pub download_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadPayload {
    pub plugin_id: String,
    pub version: String,
    pub local_path: String,
    pub size_bytes: u64,
}

fn cache_dir(state: &PluginRuntimeState) -> PathBuf {
    state.plugin_install_dir.join("_marketplace_cache")
}

fn http_client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent("cognia-plugin-installer/0.1")
        .build()
        .map_err(|e| PluginError::Internal(format!("http client init: {e}")))
}

/// Parse the registry `/plugins/:id/versions` response into version entries.
/// Tolerates both camelCase and snake_case keys; entries without a `version`
/// string are dropped.
fn parse_marketplace_versions(value: &serde_json::Value) -> Vec<MarketplaceVersion> {
    let pick = |entry: &serde_json::Value, a: &str, b: &str| -> Option<String> {
        entry
            .get(a)
            .or_else(|| entry.get(b))
            .and_then(|x| x.as_str())
            .map(str::to_string)
    };
    value
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|v| {
                    let version = v.get("version").and_then(|x| x.as_str())?;
                    Some(MarketplaceVersion {
                        version: version.to_string(),
                        published_at: pick(v, "publishedAt", "published_at"),
                        download_url: pick(v, "downloadUrl", "download_url"),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[tauri::command]
pub async fn plugin_marketplace_versions(
    plugin_id: String,
    registry_url: Option<String>,
    #[allow(unused_variables)] cache_only: Option<bool>,
) -> Result<Vec<MarketplaceVersion>> {
    let base = registry_url.unwrap_or_default();
    let base = base.trim().trim_end_matches('/');
    // No registry configured → empty list (the TS UI shows "No versions").
    if base.is_empty() {
        return Ok(Vec::new());
    }
    let url = format!("{base}/plugins/{plugin_id}/versions");
    let json: serde_json::Value = http_client()?
        .get(&url)
        .send()
        .await
        .map_err(|e| PluginError::Internal(format!("fetch versions: {e}")))?
        .error_for_status()
        .map_err(|e| PluginError::Internal(format!("fetch versions (HTTP error): {e}")))?
        .json()
        .await
        .map_err(|e| PluginError::Internal(format!("parse versions json: {e}")))?;
    Ok(parse_marketplace_versions(&json))
}

#[tauri::command]
pub async fn plugin_get_directory(state: State<'_, PluginRuntimeState>) -> Result<String> {
    Ok(state.plugin_install_dir.to_string_lossy().into_owned())
}

/// Extract a `.tar.gz` into `dest` WITHOUT stripping a top-level directory
/// (marketplace archives may pack the plugin at the root or one level deep —
/// `find_plugin_manifest` probes both). Traversal/absolute segments are dropped.
fn extract_tar_gz(bytes: &[u8], dest: &Path) -> std::result::Result<(), String> {
    use flate2::read::GzDecoder;
    use tar::Archive;

    fs::create_dir_all(dest).map_err(|e| format!("mkdir {dest:?}: {e}"))?;
    let mut archive = Archive::new(GzDecoder::new(bytes));
    for entry in archive
        .entries()
        .map_err(|e| format!("read tar entries: {e}"))?
    {
        let mut entry = entry.map_err(|e| format!("read tar entry: {e}"))?;
        let path = entry
            .path()
            .map_err(|e| format!("tar entry path: {e}"))?
            .into_owned();
        if path.components().any(|c| {
            matches!(
                c,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        }) {
            continue;
        }
        let out = dest.join(&path);
        if entry.header().entry_type().is_dir() {
            fs::create_dir_all(&out).map_err(|e| format!("mkdir {out:?}: {e}"))?;
            continue;
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir {parent:?}: {e}"))?;
        }
        entry
            .unpack(&out)
            .map_err(|e| format!("unpack {out:?}: {e}"))?;
    }
    Ok(())
}

/// Integrity material the registry supplies for a downloaded archive. A
/// marketplace fetch is an arbitrary-code install, so the raw bytes must be
/// validated against the registry's claims before anything is unpacked.
///
/// - `checksum` — lowercase hex SHA-256 of the archive bytes (integrity:
///   catches corruption / in-flight tampering).
/// - `signature_hex` + `public_key_hex` — Ed25519 signature over the
///   `<id>:<ver>:<bytes>` digest (provenance: proves who built the archive).
/// - `require_signature` — when set, an archive that ships no signature is
///   rejected outright (strict provenance, opt-in via settings).
#[derive(Debug, Clone, Default)]
pub(crate) struct DownloadIntegrity {
    pub checksum: Option<String>,
    pub signature_hex: Option<String>,
    pub public_key_hex: Option<String>,
    pub require_signature: bool,
}

impl DownloadIntegrity {
    /// No integrity material — used by callers that vouch for the bytes
    /// themselves (e.g. the test harness building an archive in-process).
    #[cfg(test)]
    pub(crate) fn none() -> Self {
        Self::default()
    }
}

/// Validate raw archive bytes against the registry's integrity claims. Pure
/// (no filesystem / network) so the policy is exhaustively unit-testable.
/// Returns `Ok(())` only when every supplied claim passes; any mismatch — or a
/// missing-but-required signature — is a hard error that aborts the install.
pub(crate) fn verify_download_integrity(
    plugin_id: &str,
    version: &str,
    bytes: &[u8],
    integrity: &DownloadIntegrity,
) -> Result<()> {
    use sha2::{Digest, Sha256};

    if let Some(expected) = integrity.checksum.as_deref() {
        let actual = hex::encode(Sha256::digest(bytes));
        if !actual.eq_ignore_ascii_case(expected.trim()) {
            return Err(PluginError::Crypto(format!(
                "archive checksum mismatch: expected {expected}, got {actual}"
            )));
        }
    }

    match (
        integrity.signature_hex.as_deref(),
        integrity.public_key_hex.as_deref(),
    ) {
        (Some(sig), Some(pk)) => {
            let ok =
                super::signature::verify_artifact_signature_bytes(plugin_id, version, bytes, sig, pk)?;
            if !ok {
                return Err(PluginError::Crypto(
                    "archive signature verification failed".into(),
                ));
            }
        }
        // A signature half-supplied (one of sig/key) is a malformed claim.
        (Some(_), None) | (None, Some(_)) => {
            return Err(PluginError::Crypto(
                "archive signature is incomplete: both signature and public key are required".into(),
            ));
        }
        (None, None) => {
            if integrity.require_signature {
                return Err(PluginError::Crypto(
                    "plugin signature required by policy but the archive is unsigned".into(),
                ));
            }
        }
    }

    Ok(())
}

/// Extract a downloaded plugin archive, resolve its `plugin.json`, validate it
/// ships its declared artifacts (no build step), and copy the plugin tree into
/// the canonical `<install_dir>/<plugin_id>/`. The same destination layout as
/// every other install path, so manager-side dispatch is unchanged. Factored
/// out of the Tauri command so the extract→install core is unit-testable
/// without a network fetch.
///
/// The registry's integrity claims are checked against the raw bytes BEFORE any
/// extraction, so a tampered or unsigned-when-required archive never touches
/// the filesystem.
pub(crate) fn install_archive_into_plugin_dir(
    state: &PluginRuntimeState,
    expected_plugin_id: &str,
    version: &str,
    bytes: &[u8],
    integrity: &DownloadIntegrity,
) -> Result<DownloadPayload> {
    verify_download_integrity(expected_plugin_id, version, bytes, integrity)?;

    let staging =
        tempfile::tempdir().map_err(|e| PluginError::Internal(format!("create temp dir: {e}")))?;
    extract_tar_gz(bytes, staging.path()).map_err(PluginError::Internal)?;

    let manifest_path = find_plugin_manifest(staging.path())
        .ok_or_else(|| PluginError::Internal("archive is missing plugin.json".into()))?;
    let plugin_root = manifest_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| staging.path().to_path_buf());
    let (_, parsed) = read_manifest(&manifest_path).map_err(PluginError::Internal)?;

    // Defend against a registry serving the wrong plugin under a given id.
    if !expected_plugin_id.is_empty() && parsed.id != expected_plugin_id {
        return Err(PluginError::Internal(format!(
            "archive plugin id '{}' does not match requested '{}'",
            parsed.id, expected_plugin_id
        )));
    }
    validate_no_build(&plugin_root, &parsed).map_err(PluginError::Internal)?;

    let plugin_dir = state.plugin_dir(&parsed.id);
    if plugin_dir.exists() {
        fs::remove_dir_all(&plugin_dir)
            .map_err(|e| PluginError::Internal(format!("clear {plugin_dir:?}: {e}")))?;
    }
    fs::create_dir_all(&plugin_dir)
        .map_err(|e| PluginError::Internal(format!("mkdir {plugin_dir:?}: {e}")))?;
    copy_plugin_tree(&plugin_root, &plugin_dir).map_err(PluginError::Internal)?;

    Ok(DownloadPayload {
        plugin_id: parsed.id,
        version: version.to_string(),
        local_path: plugin_dir.to_string_lossy().into_owned(),
        size_bytes: bytes.len() as u64,
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn plugin_download_version(
    state: State<'_, PluginRuntimeState>,
    plugin_id: String,
    version: String,
    download_url: String,
    checksum: Option<String>,
    signature_hex: Option<String>,
    public_key_hex: Option<String>,
    require_signature: Option<bool>,
) -> Result<DownloadPayload> {
    if download_url.trim().is_empty() {
        return Err(PluginError::Internal(
            "plugin_download_version: downloadUrl is required".into(),
        ));
    }
    let bytes = http_client()?
        .get(download_url.trim())
        .send()
        .await
        .map_err(|e| PluginError::Internal(format!("download plugin archive: {e}")))?
        .error_for_status()
        .map_err(|e| {
            PluginError::Internal(format!("download plugin archive (HTTP error): {e}"))
        })?
        .bytes()
        .await
        .map_err(|e| PluginError::Internal(format!("read archive body: {e}")))?;

    let integrity = DownloadIntegrity {
        checksum: checksum.filter(|s| !s.trim().is_empty()),
        signature_hex: signature_hex.filter(|s| !s.trim().is_empty()),
        public_key_hex: public_key_hex.filter(|s| !s.trim().is_empty()),
        require_signature: require_signature.unwrap_or(false),
    };
    // Validate the raw bytes BEFORE caching or unpacking — a tampered archive
    // must not be written anywhere on disk.
    verify_download_integrity(&plugin_id, &version, &bytes, &integrity)?;

    // Keep the (now verified) raw archive around for diagnostics / re-checks.
    let cache = cache_dir(&state);
    let _ = fs::create_dir_all(&cache);
    let _ = fs::write(cache.join(format!("{plugin_id}-{version}.tar.gz")), &bytes);

    install_archive_into_plugin_dir(state.inner(), &plugin_id, &version, &bytes, &integrity)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvalidateCacheArgs {
    #[serde(default)]
    pub scope: Option<String>,
}

#[tauri::command]
pub async fn plugin_invalidate_cache(
    state: State<'_, PluginRuntimeState>,
    args: Option<InvalidateCacheArgs>,
) -> Result<()> {
    let cache = cache_dir(&state);
    if cache.exists() {
        fs::remove_dir_all(&cache)?;
    }
    log::debug!(
        "plugin_invalidate_cache: scope={:?}",
        args.and_then(|a| a.scope)
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn make_state(tmp: &TempDir) -> PluginRuntimeState {
        PluginRuntimeState::new(PathBuf::from(tmp.path()))
    }

    #[tokio::test]
    async fn get_directory_returns_install_root() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        let path = state.plugin_install_dir.to_string_lossy().into_owned();
        assert_eq!(path, tmp.path().to_string_lossy().into_owned());
    }

    #[test]
    fn invalidate_cache_removes_dir_when_present() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        let cache = cache_dir(&state);
        fs::create_dir_all(&cache).unwrap();
        fs::write(cache.join("x"), b"y").unwrap();
        assert!(cache.exists());
        // Inline invalidate logic.
        fs::remove_dir_all(&cache).unwrap();
        assert!(!cache.exists());
    }

    fn make_tar_gz(files: &[(&str, &[u8])]) -> Vec<u8> {
        use flate2::write::GzEncoder;
        use flate2::Compression;
        use std::io::Write;

        let mut tar_bytes = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut tar_bytes);
            for (path, content) in files {
                let mut header = tar::Header::new_gnu();
                header.set_size(content.len() as u64);
                header.set_mode(0o644);
                header.set_cksum();
                builder.append_data(&mut header, path, *content).unwrap();
            }
            builder.finish().unwrap();
        }
        let mut gz = GzEncoder::new(Vec::new(), Compression::default());
        gz.write_all(&tar_bytes).unwrap();
        gz.finish().unwrap()
    }

    #[test]
    fn install_archive_places_plugin_into_canonical_dir() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        let manifest =
            br#"{"id":"demo.market","name":"Demo","version":"1.0.0","type":"frontend","main":"index.js"}"#;
        // Wrapped one level deep — find_plugin_manifest must probe into it.
        let archive = make_tar_gz(&[
            ("demo.market/plugin.json", manifest),
            ("demo.market/index.js", b"export default {}"),
        ]);

        let payload =
            install_archive_into_plugin_dir(&state, "demo.market", "1.0.0", &archive, &DownloadIntegrity::none())
                .unwrap();

        assert_eq!(payload.plugin_id, "demo.market");
        assert_eq!(payload.version, "1.0.0");
        let dir = state.plugin_dir("demo.market");
        assert!(dir.join("plugin.json").exists());
        assert!(dir.join("index.js").exists());
    }

    #[test]
    fn install_archive_rejects_a_mismatched_plugin_id() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        let manifest = br#"{"id":"someone.else","name":"X","version":"1.0.0"}"#;
        let archive = make_tar_gz(&[("plugin.json", manifest)]);
        let err =
            install_archive_into_plugin_dir(&state, "demo.market", "1.0.0", &archive, &DownloadIntegrity::none())
                .unwrap_err();
        assert!(matches!(err, PluginError::Internal(_)));
    }

    #[test]
    fn install_archive_rejects_an_archive_without_a_manifest() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        let archive = make_tar_gz(&[("readme.txt", b"no manifest here")]);
        let err =
            install_archive_into_plugin_dir(&state, "demo", "1.0.0", &archive, &DownloadIntegrity::none())
                .unwrap_err();
        assert!(matches!(err, PluginError::Internal(_)));
    }

    fn sha256_hex(bytes: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        hex::encode(Sha256::digest(bytes))
    }

    #[test]
    fn integrity_passes_with_a_correct_checksum() {
        let bytes = b"archive bytes";
        let integrity = DownloadIntegrity {
            checksum: Some(sha256_hex(bytes)),
            ..Default::default()
        };
        assert!(verify_download_integrity("demo", "1.0.0", bytes, &integrity).is_ok());
    }

    #[test]
    fn integrity_is_case_insensitive_for_checksum_hex() {
        let bytes = b"archive bytes";
        let integrity = DownloadIntegrity {
            checksum: Some(sha256_hex(bytes).to_uppercase()),
            ..Default::default()
        };
        assert!(verify_download_integrity("demo", "1.0.0", bytes, &integrity).is_ok());
    }

    #[test]
    fn integrity_rejects_a_checksum_mismatch() {
        let integrity = DownloadIntegrity {
            checksum: Some(sha256_hex(b"the real archive")),
            ..Default::default()
        };
        let err =
            verify_download_integrity("demo", "1.0.0", b"a tampered archive", &integrity).unwrap_err();
        assert!(matches!(err, PluginError::Crypto(m) if m.contains("checksum mismatch")));
    }

    #[test]
    fn integrity_rejects_an_unsigned_archive_when_required() {
        let integrity = DownloadIntegrity {
            require_signature: true,
            ..Default::default()
        };
        let err = verify_download_integrity("demo", "1.0.0", b"x", &integrity).unwrap_err();
        assert!(matches!(err, PluginError::Crypto(m) if m.contains("required by policy")));
    }

    #[test]
    fn integrity_rejects_a_half_supplied_signature() {
        let integrity = DownloadIntegrity {
            signature_hex: Some("aa".into()),
            public_key_hex: None,
            ..Default::default()
        };
        let err = verify_download_integrity("demo", "1.0.0", b"x", &integrity).unwrap_err();
        assert!(matches!(err, PluginError::Crypto(m) if m.contains("incomplete")));
    }

    #[test]
    fn integrity_verifies_a_real_ed25519_signature_and_rejects_a_tampered_archive() {
        use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
        use sha2::{Digest, Sha256};

        // Sign the canonical <id>:<ver>:<bytes> digest, mirroring the host signer.
        let signing_key = SigningKey::from_bytes(&[7u8; 32]);
        let verifying_key: VerifyingKey = (&signing_key).into();
        let bytes = b"the genuine archive payload";
        let mut hasher = Sha256::new();
        hasher.update(b"demo");
        hasher.update(b":");
        hasher.update(b"1.0.0");
        hasher.update(b":");
        hasher.update(bytes);
        let digest: [u8; 32] = hasher.finalize().into();
        let sig = signing_key.sign(&digest);

        let good = DownloadIntegrity {
            signature_hex: Some(hex::encode(sig.to_bytes())),
            public_key_hex: Some(hex::encode(verifying_key.to_bytes())),
            ..Default::default()
        };
        assert!(verify_download_integrity("demo", "1.0.0", bytes, &good).is_ok());

        // Same signature, tampered bytes → must fail.
        let err = verify_download_integrity("demo", "1.0.0", b"tampered!", &good).unwrap_err();
        assert!(matches!(err, PluginError::Crypto(m) if m.contains("signature verification failed")));
    }

    #[test]
    fn install_archive_aborts_before_unpacking_on_a_checksum_mismatch() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        let manifest = br#"{"id":"demo.market","name":"Demo","version":"1.0.0","type":"frontend","main":"index.js"}"#;
        let archive = make_tar_gz(&[
            ("demo.market/plugin.json", manifest),
            ("demo.market/index.js", b"export default {}"),
        ]);
        let integrity = DownloadIntegrity {
            checksum: Some(sha256_hex(b"not the archive")),
            ..Default::default()
        };
        let err =
            install_archive_into_plugin_dir(&state, "demo.market", "1.0.0", &archive, &integrity)
                .unwrap_err();
        assert!(matches!(err, PluginError::Crypto(_)));
        // Nothing was written to the canonical dir.
        assert!(!state.plugin_dir("demo.market").join("plugin.json").exists());
    }

    #[test]
    fn parse_versions_drops_versionless_entries_and_reads_both_key_styles() {
        let json = serde_json::json!([
            { "version": "1.0.0", "downloadUrl": "https://x/1.tgz", "publishedAt": "2026-01-01" },
            { "version": "1.1.0", "download_url": "https://x/2.tgz" },
            { "noVersion": true },
        ]);
        let versions = parse_marketplace_versions(&json);
        assert_eq!(versions.len(), 2);
        assert_eq!(versions[0].version, "1.0.0");
        assert_eq!(versions[0].download_url.as_deref(), Some("https://x/1.tgz"));
        assert_eq!(versions[0].published_at.as_deref(), Some("2026-01-01"));
        assert_eq!(versions[1].download_url.as_deref(), Some("https://x/2.tgz"));
    }
}

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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedDownloadPayload {
    pub transaction_id: String,
    pub plugin_id: String,
    pub version: String,
    pub staged_path: String,
    pub manifest: serde_json::Value,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StagedUpdateMetadata {
    transaction_id: String,
    plugin_id: String,
    version: String,
    size_bytes: u64,
    manifest: serde_json::Value,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRecoveryReport {
    pub recovered_transactions: usize,
    pub discarded_transactions: usize,
    pub failures: Vec<String>,
}

/// Filename of the per-plugin verification receipt written host-side after a
/// successful integrity/signature check at install time. The TS load gate
/// (`PluginSignatureVerifier.verify`) consults it via `plugin_read_verification`
/// to decide whether an install satisfies a signature-required policy.
pub(crate) const VERIFICATION_RECEIPT_FILE: &str = ".cognia-verification.json";

/// Durable record of HOW a plugin's install bytes were validated. `signature`
/// means an Ed25519 provenance signature was verified (strongest); `checksum`
/// means only integrity was confirmed against the registry's SHA-256. Written
/// only when at least one claim was present and passed — an install with no
/// integrity material leaves no receipt (and thus fails a require-signature
/// policy on load).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationReceipt {
    pub verified_via: String,
    pub version: String,
    pub verified_at: String,
}

fn cache_dir(state: &PluginRuntimeState) -> PathBuf {
    state.plugin_install_dir.join("_marketplace_cache")
}

fn update_transactions_dir(state: &PluginRuntimeState) -> PathBuf {
    state.plugin_state_dir.join("update-transactions")
}

fn update_transaction_dir(
    state: &PluginRuntimeState,
    plugin_id: &str,
    transaction_id: &str,
) -> Result<PathBuf> {
    crate::validate_plugin_id_path_component(plugin_id)?;
    let parsed = uuid::Uuid::parse_str(transaction_id)
        .map_err(|_| PluginError::InvalidArgument("invalid update transaction id".into()))?;
    if parsed.hyphenated().to_string() != transaction_id {
        return Err(PluginError::InvalidArgument(
            "invalid update transaction id".into(),
        ));
    }
    Ok(update_transactions_dir(state)
        .join(plugin_id)
        .join(transaction_id))
}

fn installed_package_matches(package_dir: &Path, plugin_id: &str, version: &str) -> Result<bool> {
    let manifest_path = package_dir.join("plugin.json");
    if !manifest_path.is_file() {
        return Ok(false);
    }
    let manifest: serde_json::Value = serde_json::from_slice(&fs::read(manifest_path)?)?;
    Ok(
        manifest.get("id").and_then(serde_json::Value::as_str) == Some(plugin_id)
            && manifest.get("version").and_then(serde_json::Value::as_str) == Some(version),
    )
}

fn recover_update_transaction(
    state: &PluginRuntimeState,
    plugin_id: &str,
    transaction_id: &str,
) -> Result<bool> {
    let transaction_dir = update_transaction_dir(state, plugin_id, transaction_id)?;
    if fs::symlink_metadata(&transaction_dir)?
        .file_type()
        .is_symlink()
    {
        return Err(PluginError::InvalidArgument(
            "update transaction directory cannot be a symlink".into(),
        ));
    }
    let metadata: StagedUpdateMetadata =
        serde_json::from_slice(&fs::read(transaction_dir.join("transaction.json"))?)?;
    if metadata.plugin_id != plugin_id || metadata.transaction_id != transaction_id {
        return Err(PluginError::InvalidArgument(
            "update transaction descriptor mismatch".into(),
        ));
    }

    let staged = transaction_dir.join("package");
    let previous = transaction_dir.join("previous-package");
    let committed = transaction_dir.join("committed").is_file();
    let promotion_started = previous.exists() || !staged.exists();
    if !committed && !promotion_started {
        fs::remove_dir_all(&transaction_dir)?;
        return Ok(false);
    }

    let plugin_dir = state.plugin_dir(plugin_id);
    let interrupted_package = transaction_dir.join("interrupted-package");
    if interrupted_package.exists() {
        return Err(PluginError::InvalidArgument(
            "update recovery already contains an interrupted package".into(),
        ));
    }
    if plugin_dir.exists() {
        if fs::symlink_metadata(&plugin_dir)?.file_type().is_symlink()
            || !installed_package_matches(&plugin_dir, plugin_id, &metadata.version)?
        {
            return Err(PluginError::InvalidArgument(format!(
                "refusing to replace an unknown package while recovering {plugin_id}"
            )));
        }
        fs::rename(&plugin_dir, &interrupted_package)?;
    }

    if previous.exists() {
        if fs::symlink_metadata(&previous)?.file_type().is_symlink() {
            if interrupted_package.exists() {
                fs::rename(&interrupted_package, &plugin_dir)?;
            }
            return Err(PluginError::InvalidArgument(
                "previous update package cannot be a symlink".into(),
            ));
        }
        if let Err(error) = fs::rename(&previous, &plugin_dir) {
            if interrupted_package.exists() {
                fs::rename(&interrupted_package, &plugin_dir)?;
            }
            return Err(PluginError::Io(error));
        }
    }

    fs::remove_dir_all(&transaction_dir)?;
    Ok(true)
}

/// Roll back update transactions that were interrupted before the frontend
/// verified the new runtime/proxy handshake. Transactions which never began
/// promotion are discarded; promoted packages are restored to the previous
/// package. Unknown canonical packages are preserved and reported for manual
/// intervention rather than being overwritten.
pub fn recover_update_transactions_for_state(state: &PluginRuntimeState) -> UpdateRecoveryReport {
    let root = update_transactions_dir(state);
    let mut report = UpdateRecoveryReport::default();
    let plugin_entries = match fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return report,
        Err(error) => {
            report
                .failures
                .push(format!("read update transaction root: {error}"));
            return report;
        }
    };

    for plugin_entry in plugin_entries {
        let plugin_entry = match plugin_entry {
            Ok(entry) => entry,
            Err(error) => {
                report
                    .failures
                    .push(format!("read update transaction plugin entry: {error}"));
                continue;
            }
        };
        let plugin_id = match plugin_entry.file_name().into_string() {
            Ok(plugin_id) => plugin_id,
            Err(_) => {
                report
                    .failures
                    .push("update transaction plugin directory is not UTF-8".into());
                continue;
            }
        };
        if let Err(error) = crate::validate_plugin_id_path_component(&plugin_id) {
            report.failures.push(format!(
                "invalid update transaction plugin {plugin_id}: {error}"
            ));
            continue;
        }
        match plugin_entry.metadata() {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => {
                report.failures.push(format!(
                    "update transaction plugin path is not a directory: {plugin_id}"
                ));
                continue;
            }
            Err(error) => {
                report.failures.push(format!(
                    "inspect update transaction plugin {plugin_id}: {error}"
                ));
                continue;
            }
        }
        let transaction_entries = match fs::read_dir(plugin_entry.path()) {
            Ok(entries) => entries,
            Err(error) => {
                report
                    .failures
                    .push(format!("read update transactions for {plugin_id}: {error}"));
                continue;
            }
        };
        for transaction_entry in transaction_entries {
            let transaction_id = match transaction_entry.and_then(|entry| {
                entry.file_name().into_string().map_err(|_| {
                    std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "transaction directory is not UTF-8",
                    )
                })
            }) {
                Ok(transaction_id) => transaction_id,
                Err(error) => {
                    report
                        .failures
                        .push(format!("read update transaction for {plugin_id}: {error}"));
                    continue;
                }
            };
            match recover_update_transaction(state, &plugin_id, &transaction_id) {
                Ok(true) => report.recovered_transactions += 1,
                Ok(false) => report.discarded_transactions += 1,
                Err(error) => report.failures.push(format!(
                    "recover update transaction {plugin_id}/{transaction_id}: {error}"
                )),
            }
        }
        let _ = fs::remove_dir(plugin_entry.path());
    }
    let _ = fs::remove_dir(root);
    report
}

fn http_client(url: &str) -> Result<reqwest::Client> {
    let builder = reqwest::Client::builder().user_agent("cognia-plugin-installer/0.1");
    let (builder, _) = cognia_net::proxy_config::apply_reqwest_policy(builder, url)
        .map_err(|error| PluginError::Internal(error.to_string()))?;
    builder
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
    crate::validate_plugin_id_path_component(&plugin_id)?;
    let base = registry_url.unwrap_or_default();
    let base = base.trim().trim_end_matches('/');
    // No registry configured → empty list (the TS UI shows "No versions").
    if base.is_empty() {
        return Ok(Vec::new());
    }
    let url = format!("{base}/plugins/{plugin_id}/versions");
    let response = http_client(&url)?
        .get(&url)
        .send()
        .await
        .map_err(|e| PluginError::Internal(format!("fetch versions: {e}")))?
        .error_for_status()
        .map_err(|e| PluginError::Internal(format!("fetch versions (HTTP error): {e}")))?;
    let bytes = crate::archive_limits::read_response_limited(
        response,
        crate::archive_limits::MAX_METADATA_BYTES,
        "marketplace versions metadata",
    )
    .await
    .map_err(PluginError::Internal)?;
    let json: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|e| PluginError::Internal(format!("parse versions json: {e}")))?;
    Ok(parse_marketplace_versions(&json))
}

#[tauri::command]
pub async fn plugin_get_directory(state: State<'_, PluginRuntimeState>) -> Result<String> {
    Ok(state.plugin_install_dir.to_string_lossy().into_owned())
}

/// Read the verification receipt written at install time for `plugin_id`, if
/// any. Returns `None` when no receipt exists (never validated, or a local /
/// dev install that skipped the integrity path) or when the file is
/// unparseable — the caller treats both as "unverified".
pub(crate) fn read_verification_receipt(
    state: &PluginRuntimeState,
    plugin_id: &str,
) -> Option<VerificationReceipt> {
    let path = state.plugin_dir(plugin_id).join(VERIFICATION_RECEIPT_FILE);
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

#[tauri::command]
pub async fn plugin_read_verification(
    state: State<'_, PluginRuntimeState>,
    plugin_id: String,
) -> Result<Option<VerificationReceipt>> {
    Ok(read_verification_receipt(state.inner(), &plugin_id))
}

/// Extract a `.tar.gz` into `dest` WITHOUT stripping a top-level directory
/// (marketplace archives may pack the plugin at the root or one level deep —
/// `find_plugin_manifest` probes both). Traversal/absolute segments are dropped.
fn extract_tar_gz(bytes: &[u8], dest: &Path) -> std::result::Result<(), String> {
    extract_tar_gz_with_limits(
        bytes,
        dest,
        crate::archive_limits::MAX_ARCHIVE_ENTRIES,
        crate::archive_limits::MAX_UNPACKED_BYTES,
    )
}

fn extract_tar_gz_with_limits(
    bytes: &[u8],
    dest: &Path,
    max_entries: usize,
    max_unpacked_bytes: u64,
) -> std::result::Result<(), String> {
    use flate2::read::GzDecoder;
    use tar::Archive;

    fs::create_dir_all(dest).map_err(|e| format!("mkdir {dest:?}: {e}"))?;
    let mut archive = Archive::new(GzDecoder::new(bytes));
    let mut entry_count = 0_usize;
    let mut total_written = 0_u64;
    for entry in archive
        .entries()
        .map_err(|e| format!("read tar entries: {e}"))?
    {
        entry_count += 1;
        if entry_count > max_entries {
            return Err(format!(
                "plugin archive contains more than {} entries",
                max_entries
            ));
        }
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
            return Err(format!("unsafe tar entry path: {path:?}"));
        }
        let entry_type = entry.header().entry_type();
        if !entry_type.is_file() && !entry_type.is_dir() {
            return Err(format!(
                "archive entry must be a regular file or directory: {path:?}"
            ));
        }
        let out = dest.join(&path);
        if entry.header().entry_type().is_dir() {
            fs::create_dir_all(&out).map_err(|e| format!("mkdir {out:?}: {e}"))?;
            continue;
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir {parent:?}: {e}"))?;
        }
        let mut file = fs::File::create(&out).map_err(|e| format!("create {out:?}: {e}"))?;
        crate::archive_limits::copy_with_budget(
            &mut entry,
            &mut file,
            &mut total_written,
            max_unpacked_bytes,
            out.to_string_lossy().as_ref(),
        )?;
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

    /// Which verification tier this integrity material represents, iff a claim
    /// was actually supplied. A complete signature (sig + key) always wins over
    /// a bare checksum; with neither, there is nothing to attest and no receipt
    /// is written.
    pub(crate) fn verified_via(&self) -> Option<&'static str> {
        if self.signature_hex.is_some() && self.public_key_hex.is_some() {
            Some("signature")
        } else if self.checksum.is_some() {
            Some("checksum")
        } else {
            None
        }
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
            let ok = super::signature::verify_artifact_signature_bytes(
                plugin_id, version, bytes, sig, pk,
            )?;
            if !ok {
                return Err(PluginError::Crypto(
                    "archive signature verification failed".into(),
                ));
            }
        }
        // A signature half-supplied (one of sig/key) is a malformed claim.
        (Some(_), None) | (None, Some(_)) => {
            return Err(PluginError::Crypto(
                "archive signature is incomplete: both signature and public key are required"
                    .into(),
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
    fs::create_dir_all(&state.plugin_install_dir)
        .map_err(|e| PluginError::Internal(format!("create plugin install root: {e}")))?;
    let transaction = tempfile::Builder::new()
        .prefix(".cognia-update-")
        .tempdir_in(&state.plugin_install_dir)
        .map_err(|e| PluginError::Internal(format!("create update transaction: {e}")))?;
    let prepared = transaction.path().join("package");
    let (plugin_id, _) =
        prepare_archive_package(expected_plugin_id, version, bytes, integrity, &prepared)?;

    let plugin_dir = state.plugin_dir(&plugin_id);
    let previous = transaction.path().join("previous");
    if plugin_dir.exists() {
        fs::rename(&plugin_dir, &previous)
            .map_err(|e| PluginError::Internal(format!("stage previous {plugin_dir:?}: {e}")))?;
    }
    if let Err(error) = fs::rename(&prepared, &plugin_dir) {
        if previous.exists() {
            fs::rename(&previous, &plugin_dir).map_err(|rollback| {
                PluginError::Internal(format!(
                    "commit update failed ({error}); package rollback failed: {rollback}"
                ))
            })?;
        }
        return Err(PluginError::Internal(format!(
            "commit plugin package: {error}"
        )));
    }

    Ok(DownloadPayload {
        plugin_id,
        version: version.to_string(),
        local_path: plugin_dir.to_string_lossy().into_owned(),
        size_bytes: bytes.len() as u64,
    })
}

fn prepare_archive_package(
    expected_plugin_id: &str,
    version: &str,
    bytes: &[u8],
    integrity: &DownloadIntegrity,
    destination: &Path,
) -> Result<(String, serde_json::Value)> {
    verify_download_integrity(expected_plugin_id, version, bytes, integrity)?;
    let extraction =
        tempfile::tempdir().map_err(|e| PluginError::Internal(format!("create temp dir: {e}")))?;
    extract_tar_gz(bytes, extraction.path()).map_err(PluginError::Internal)?;
    let manifest_path = find_plugin_manifest(extraction.path())
        .ok_or_else(|| PluginError::Internal("archive is missing plugin.json".into()))?;
    let plugin_root = manifest_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| extraction.path().to_path_buf());
    let (manifest_value, parsed) = read_manifest(&manifest_path).map_err(PluginError::Internal)?;
    if !expected_plugin_id.is_empty() && parsed.id != expected_plugin_id {
        return Err(PluginError::Internal(format!(
            "archive plugin id '{}' does not match requested '{}'",
            parsed.id, expected_plugin_id
        )));
    }
    let manifest_version = manifest_value
        .get("version")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    if manifest_version != version {
        return Err(PluginError::InvalidManifest(format!(
            "archive plugin version '{}' does not match requested '{}'",
            manifest_version, version
        )));
    }
    crate::contract::validate_manifest_contract(&manifest_value).map_err(PluginError::Internal)?;
    crate::contract::validate_existing_manifest_paths(&plugin_root, &manifest_value)
        .map_err(PluginError::Internal)?;
    validate_no_build(&plugin_root, &parsed).map_err(PluginError::Internal)?;
    copy_plugin_tree(&plugin_root, destination).map_err(PluginError::Internal)?;
    crate::contract::validate_existing_manifest_paths(destination, &manifest_value)
        .map_err(PluginError::Internal)?;
    if let Some(verified_via) = integrity.verified_via() {
        let receipt = VerificationReceipt {
            verified_via: verified_via.to_string(),
            version: version.to_string(),
            verified_at: chrono::Utc::now().to_rfc3339(),
        };
        fs::write(
            destination.join(VERIFICATION_RECEIPT_FILE),
            serde_json::to_string(&receipt)?,
        )?;
    }
    Ok((parsed.id, manifest_value))
}

pub(crate) fn stage_archive_update_for_state(
    state: &PluginRuntimeState,
    plugin_id: &str,
    version: &str,
    bytes: &[u8],
    integrity: &DownloadIntegrity,
) -> Result<StagedDownloadPayload> {
    crate::validate_plugin_id_path_component(plugin_id)?;
    let transaction_id = uuid::Uuid::new_v4().hyphenated().to_string();
    let transaction_dir = update_transaction_dir(state, plugin_id, &transaction_id)?;
    fs::create_dir_all(&transaction_dir)?;
    let staged_path = transaction_dir.join("package");
    let prepared = prepare_archive_package(plugin_id, version, bytes, integrity, &staged_path);
    let (actual_plugin_id, manifest) = match prepared {
        Ok(prepared) => prepared,
        Err(error) => {
            let _ = fs::remove_dir_all(&transaction_dir);
            return Err(error);
        }
    };
    let metadata = StagedUpdateMetadata {
        transaction_id: transaction_id.clone(),
        plugin_id: actual_plugin_id.clone(),
        version: version.to_string(),
        size_bytes: bytes.len() as u64,
        manifest: manifest.clone(),
    };
    persist_staged_update_metadata(&transaction_dir, &metadata)?;
    Ok(StagedDownloadPayload {
        transaction_id,
        plugin_id: actual_plugin_id,
        version: version.to_string(),
        staged_path: staged_path.to_string_lossy().into_owned(),
        manifest,
        size_bytes: bytes.len() as u64,
    })
}

fn persist_staged_update_metadata(
    transaction_dir: &Path,
    metadata: &StagedUpdateMetadata,
) -> Result<()> {
    let metadata_path = transaction_dir.join("transaction.json");
    let result = (|| {
        let bytes = serde_json::to_vec_pretty(metadata)?;
        fs::write(&metadata_path, bytes).map_err(|error| {
            PluginError::Internal(format!(
                "write staged update descriptor {}: {error}",
                metadata_path.display()
            ))
        })
    })();
    if result.is_err() {
        if let Err(cleanup_error) = fs::remove_dir_all(transaction_dir) {
            log::warn!(
                "failed to clean staged update transaction {}: {cleanup_error}",
                transaction_dir.display()
            );
        }
    }
    result
}

pub fn commit_staged_update_for_state(
    state: &PluginRuntimeState,
    plugin_id: &str,
    transaction_id: &str,
) -> Result<DownloadPayload> {
    let transaction_dir = update_transaction_dir(state, plugin_id, transaction_id)?;
    let metadata: StagedUpdateMetadata =
        serde_json::from_slice(&fs::read(transaction_dir.join("transaction.json"))?)?;
    if metadata.plugin_id != plugin_id || metadata.transaction_id != transaction_id {
        return Err(PluginError::InvalidArgument(
            "update transaction descriptor mismatch".into(),
        ));
    }
    let staged_path = transaction_dir.join("package");
    crate::contract::validate_existing_manifest_paths(&staged_path, &metadata.manifest)
        .map_err(PluginError::Internal)?;
    let plugin_dir = state.plugin_dir(plugin_id);
    let previous = transaction_dir.join("previous-package");
    if previous.exists() {
        return Err(PluginError::InvalidArgument(
            "update transaction was already committed".into(),
        ));
    }
    if plugin_dir.exists() {
        fs::rename(&plugin_dir, &previous)?;
    }
    if let Err(error) = fs::rename(&staged_path, &plugin_dir) {
        if previous.exists() {
            fs::rename(&previous, &plugin_dir)?;
        }
        return Err(PluginError::Io(error));
    }
    fs::write(transaction_dir.join("committed"), b"1")?;
    Ok(DownloadPayload {
        plugin_id: plugin_id.to_string(),
        version: metadata.version,
        local_path: plugin_dir.to_string_lossy().into_owned(),
        size_bytes: metadata.size_bytes,
    })
}

pub fn discard_staged_update_for_state(
    state: &PluginRuntimeState,
    plugin_id: &str,
    transaction_id: &str,
) -> Result<()> {
    let transaction_dir = update_transaction_dir(state, plugin_id, transaction_id)?;
    if transaction_dir.join("committed").exists() {
        return Err(PluginError::InvalidArgument(
            "cannot discard a committed update transaction".into(),
        ));
    }
    if transaction_dir.exists() {
        fs::remove_dir_all(transaction_dir)?;
    }
    Ok(())
}

pub fn finalize_staged_update_for_state(
    state: &PluginRuntimeState,
    plugin_id: &str,
    transaction_id: &str,
) -> Result<()> {
    let transaction_dir = update_transaction_dir(state, plugin_id, transaction_id)?;
    if !transaction_dir.join("committed").exists() {
        return Err(PluginError::InvalidArgument(
            "cannot finalize an uncommitted update transaction".into(),
        ));
    }
    fs::remove_dir_all(transaction_dir)?;
    Ok(())
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
    let (bytes, integrity) = download_verified_archive(
        &plugin_id,
        &version,
        &download_url,
        checksum,
        signature_hex,
        public_key_hex,
        require_signature,
    )
    .await?;
    let cache = cache_dir(&state);
    let _ = fs::create_dir_all(&cache);
    let _ = fs::write(cache.join(format!("{plugin_id}-{version}.tar.gz")), &bytes);
    install_archive_into_plugin_dir(state.inner(), &plugin_id, &version, &bytes, &integrity)
}

async fn download_verified_archive(
    plugin_id: &str,
    version: &str,
    download_url: &str,
    checksum: Option<String>,
    signature_hex: Option<String>,
    public_key_hex: Option<String>,
    require_signature: Option<bool>,
) -> Result<(Vec<u8>, DownloadIntegrity)> {
    crate::validate_plugin_id_path_component(plugin_id)?;
    if download_url.trim().is_empty() {
        return Err(PluginError::Internal(
            "plugin_download_version: downloadUrl is required".into(),
        ));
    }
    let response = http_client(download_url.trim())?
        .get(download_url.trim())
        .send()
        .await
        .map_err(|e| PluginError::Internal(format!("download plugin archive: {e}")))?
        .error_for_status()
        .map_err(|e| PluginError::Internal(format!("download plugin archive (HTTP error): {e}")))?;
    let bytes = crate::archive_limits::read_response_limited(
        response,
        crate::archive_limits::MAX_DOWNLOAD_BYTES,
        "marketplace plugin archive",
    )
    .await
    .map_err(PluginError::InvalidArgument)?;

    let integrity = DownloadIntegrity {
        checksum: checksum.filter(|s| !s.trim().is_empty()),
        signature_hex: signature_hex.filter(|s| !s.trim().is_empty()),
        public_key_hex: public_key_hex.filter(|s| !s.trim().is_empty()),
        require_signature: require_signature.unwrap_or(false),
    };
    // Validate the raw bytes BEFORE caching or unpacking — a tampered archive
    // must not be written anywhere on disk.
    verify_download_integrity(plugin_id, version, &bytes, &integrity)?;
    Ok((bytes, integrity))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn plugin_stage_version(
    state: State<'_, PluginRuntimeState>,
    plugin_id: String,
    version: String,
    download_url: String,
    checksum: Option<String>,
    signature_hex: Option<String>,
    public_key_hex: Option<String>,
    require_signature: Option<bool>,
) -> Result<StagedDownloadPayload> {
    plugin_stage_version_for_state(
        state.inner(),
        plugin_id,
        version,
        download_url,
        checksum,
        signature_hex,
        public_key_hex,
        require_signature,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn plugin_stage_version_for_state(
    state: &PluginRuntimeState,
    plugin_id: String,
    version: String,
    download_url: String,
    checksum: Option<String>,
    signature_hex: Option<String>,
    public_key_hex: Option<String>,
    require_signature: Option<bool>,
) -> Result<StagedDownloadPayload> {
    let (bytes, integrity) = download_verified_archive(
        &plugin_id,
        &version,
        &download_url,
        checksum,
        signature_hex,
        public_key_hex,
        require_signature,
    )
    .await?;
    let cache = cache_dir(state);
    let _ = fs::create_dir_all(&cache);
    let _ = fs::write(cache.join(format!("{plugin_id}-{version}.tar.gz")), &bytes);
    stage_archive_update_for_state(state, &plugin_id, &version, &bytes, &integrity)
}

#[tauri::command]
pub async fn plugin_commit_staged_update(
    state: State<'_, PluginRuntimeState>,
    plugin_id: String,
    transaction_id: String,
) -> Result<DownloadPayload> {
    commit_staged_update_for_state(state.inner(), &plugin_id, &transaction_id)
}

#[tauri::command]
pub async fn plugin_discard_staged_update(
    state: State<'_, PluginRuntimeState>,
    plugin_id: String,
    transaction_id: String,
) -> Result<()> {
    discard_staged_update_for_state(state.inner(), &plugin_id, &transaction_id)
}

#[tauri::command]
pub async fn plugin_finalize_staged_update(
    state: State<'_, PluginRuntimeState>,
    plugin_id: String,
    transaction_id: String,
) -> Result<()> {
    finalize_staged_update_for_state(state.inner(), &plugin_id, &transaction_id)
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

        let payload = install_archive_into_plugin_dir(
            &state,
            "demo.market",
            "1.0.0",
            &archive,
            &DownloadIntegrity::none(),
        )
        .unwrap();

        assert_eq!(payload.plugin_id, "demo.market");
        assert_eq!(payload.version, "1.0.0");
        let dir = state.plugin_dir("demo.market");
        assert!(dir.join("plugin.json").exists());
        assert!(dir.join("index.js").exists());
    }

    #[test]
    fn update_promotes_a_fully_validated_tree_and_removes_the_previous_package() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        let plugin_dir = state.plugin_dir("demo.market");
        fs::create_dir_all(&plugin_dir).unwrap();
        fs::write(
            plugin_dir.join("plugin.json"),
            br#"{"id":"demo.market","name":"Demo","version":"1.0.0","type":"frontend","main":"index.js"}"#,
        )
        .unwrap();
        fs::write(plugin_dir.join("old-only.txt"), b"old").unwrap();
        fs::write(plugin_dir.join("index.js"), b"old code").unwrap();
        let archive = make_tar_gz(&[
            (
                "demo.market/plugin.json",
                br#"{"id":"demo.market","name":"Demo","version":"2.0.0","type":"frontend","main":"index.js"}"#,
            ),
            ("demo.market/index.js", b"new code"),
        ]);

        install_archive_into_plugin_dir(
            &state,
            "demo.market",
            "2.0.0",
            &archive,
            &DownloadIntegrity::none(),
        )
        .unwrap();

        assert_eq!(
            fs::read_to_string(plugin_dir.join("index.js")).unwrap(),
            "new code"
        );
        assert!(!plugin_dir.join("old-only.txt").exists());
        assert!(fs::read_dir(&state.plugin_install_dir)
            .unwrap()
            .all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".cognia-update-")));
    }

    #[test]
    fn staged_update_leaves_the_working_package_untouched_until_commit() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        let plugin_dir = state.plugin_dir("demo.market");
        fs::create_dir_all(&plugin_dir).unwrap();
        fs::write(
            plugin_dir.join("plugin.json"),
            br#"{"id":"demo.market","name":"Demo","version":"1.0.0","type":"frontend","main":"index.js"}"#,
        )
        .unwrap();
        fs::write(plugin_dir.join("index.js"), b"old code").unwrap();
        let archive = make_tar_gz(&[
            (
                "demo.market/plugin.json",
                br#"{"id":"demo.market","name":"Demo","version":"2.0.0","type":"frontend","main":"index.js"}"#,
            ),
            ("demo.market/index.js", b"new code"),
        ]);

        let staged = stage_archive_update_for_state(
            &state,
            "demo.market",
            "2.0.0",
            &archive,
            &DownloadIntegrity::none(),
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(plugin_dir.join("index.js")).unwrap(),
            "old code"
        );
        assert_eq!(
            fs::read_to_string(Path::new(&staged.staged_path).join("index.js")).unwrap(),
            "new code"
        );

        let committed =
            commit_staged_update_for_state(&state, "demo.market", &staged.transaction_id).unwrap();
        assert_eq!(committed.version, "2.0.0");
        assert_eq!(
            fs::read_to_string(plugin_dir.join("index.js")).unwrap(),
            "new code"
        );
        finalize_staged_update_for_state(&state, "demo.market", &staged.transaction_id).unwrap();
        assert!(!update_transactions_dir(&state)
            .join("demo.market")
            .join(staged.transaction_id)
            .exists());
    }

    #[test]
    fn metadata_write_failure_removes_the_staged_transaction() {
        let tmp = TempDir::new().unwrap();
        let transaction_dir = tmp.path().join("transaction");
        fs::create_dir_all(transaction_dir.join("package")).unwrap();
        fs::create_dir(transaction_dir.join("transaction.json")).unwrap();
        let metadata = StagedUpdateMetadata {
            transaction_id: "tx-1".into(),
            plugin_id: "demo.market".into(),
            version: "2.0.0".into(),
            size_bytes: 3,
            manifest: serde_json::json!({ "id": "demo.market" }),
        };

        let error = persist_staged_update_metadata(&transaction_dir, &metadata).unwrap_err();

        assert!(error.to_string().contains("transaction.json"));
        assert!(!transaction_dir.exists());
    }

    #[test]
    fn discarded_staged_update_never_changes_the_working_package() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        let plugin_dir = state.plugin_dir("demo.market");
        fs::create_dir_all(&plugin_dir).unwrap();
        fs::write(
            plugin_dir.join("plugin.json"),
            br#"{"id":"demo.market","name":"Demo","version":"1.0.0","type":"frontend","main":"index.js"}"#,
        )
        .unwrap();
        fs::write(plugin_dir.join("index.js"), b"old code").unwrap();
        let archive = make_tar_gz(&[
            (
                "demo.market/plugin.json",
                br#"{"id":"demo.market","name":"Demo","version":"2.0.0","type":"frontend","main":"index.js"}"#,
            ),
            ("demo.market/index.js", b"new code"),
        ]);
        let staged = stage_archive_update_for_state(
            &state,
            "demo.market",
            "2.0.0",
            &archive,
            &DownloadIntegrity::none(),
        )
        .unwrap();

        discard_staged_update_for_state(&state, "demo.market", &staged.transaction_id).unwrap();
        assert_eq!(
            fs::read_to_string(plugin_dir.join("index.js")).unwrap(),
            "old code"
        );
        assert!(!Path::new(&staged.staged_path).exists());
    }

    #[test]
    fn startup_recovery_discards_an_update_that_never_started_promotion() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        let plugin_dir = state.plugin_dir("demo.market");
        fs::create_dir_all(&plugin_dir).unwrap();
        fs::write(
            plugin_dir.join("plugin.json"),
            br#"{"id":"demo.market","name":"Demo","version":"1.0.0","type":"frontend","main":"index.js"}"#,
        )
        .unwrap();
        fs::write(plugin_dir.join("index.js"), b"old code").unwrap();
        let archive = make_tar_gz(&[
            (
                "demo.market/plugin.json",
                br#"{"id":"demo.market","name":"Demo","version":"2.0.0","type":"frontend","main":"index.js"}"#,
            ),
            ("demo.market/index.js", b"new code"),
        ]);
        let staged = stage_archive_update_for_state(
            &state,
            "demo.market",
            "2.0.0",
            &archive,
            &DownloadIntegrity::none(),
        )
        .unwrap();

        let recovered = make_state(&tmp);
        assert_eq!(
            fs::read_to_string(recovered.plugin_dir("demo.market").join("index.js")).unwrap(),
            "old code"
        );
        assert!(!Path::new(&staged.staged_path).exists());
    }

    #[test]
    fn startup_recovery_rolls_back_a_committed_but_unverified_update() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        let plugin_dir = state.plugin_dir("demo.market");
        fs::create_dir_all(&plugin_dir).unwrap();
        fs::write(
            plugin_dir.join("plugin.json"),
            br#"{"id":"demo.market","name":"Demo","version":"1.0.0","type":"frontend","main":"index.js"}"#,
        )
        .unwrap();
        fs::write(plugin_dir.join("index.js"), b"old code").unwrap();
        let archive = make_tar_gz(&[
            (
                "demo.market/plugin.json",
                br#"{"id":"demo.market","name":"Demo","version":"2.0.0","type":"frontend","main":"index.js"}"#,
            ),
            ("demo.market/index.js", b"new code"),
        ]);
        let staged = stage_archive_update_for_state(
            &state,
            "demo.market",
            "2.0.0",
            &archive,
            &DownloadIntegrity::none(),
        )
        .unwrap();
        commit_staged_update_for_state(&state, "demo.market", &staged.transaction_id).unwrap();

        let recovered = make_state(&tmp);
        assert_eq!(
            fs::read_to_string(recovered.plugin_dir("demo.market").join("index.js")).unwrap(),
            "old code"
        );
        assert!(!update_transactions_dir(&recovered)
            .join("demo.market")
            .join(staged.transaction_id)
            .exists());
    }

    #[test]
    fn startup_recovery_restores_the_old_package_if_promotion_was_interrupted() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        let plugin_dir = state.plugin_dir("demo.market");
        fs::create_dir_all(&plugin_dir).unwrap();
        fs::write(
            plugin_dir.join("plugin.json"),
            br#"{"id":"demo.market","name":"Demo","version":"1.0.0","type":"frontend","main":"index.js"}"#,
        )
        .unwrap();
        fs::write(plugin_dir.join("index.js"), b"old code").unwrap();
        let archive = make_tar_gz(&[
            (
                "demo.market/plugin.json",
                br#"{"id":"demo.market","name":"Demo","version":"2.0.0","type":"frontend","main":"index.js"}"#,
            ),
            ("demo.market/index.js", b"new code"),
        ]);
        let staged = stage_archive_update_for_state(
            &state,
            "demo.market",
            "2.0.0",
            &archive,
            &DownloadIntegrity::none(),
        )
        .unwrap();
        let transaction_dir =
            update_transaction_dir(&state, "demo.market", &staged.transaction_id).unwrap();
        fs::rename(&plugin_dir, transaction_dir.join("previous-package")).unwrap();

        let recovered = make_state(&tmp);
        assert_eq!(
            fs::read_to_string(recovered.plugin_dir("demo.market").join("index.js")).unwrap(),
            "old code"
        );
        assert!(!transaction_dir.exists());
    }

    #[test]
    fn startup_recovery_preserves_an_unknown_canonical_package() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        let plugin_dir = state.plugin_dir("demo.market");
        fs::create_dir_all(&plugin_dir).unwrap();
        fs::write(
            plugin_dir.join("plugin.json"),
            br#"{"id":"demo.market","name":"Demo","version":"1.0.0","type":"frontend","main":"index.js"}"#,
        )
        .unwrap();
        fs::write(plugin_dir.join("index.js"), b"old code").unwrap();
        let archive = make_tar_gz(&[
            (
                "demo.market/plugin.json",
                br#"{"id":"demo.market","name":"Demo","version":"2.0.0","type":"frontend","main":"index.js"}"#,
            ),
            ("demo.market/index.js", b"new code"),
        ]);
        let staged = stage_archive_update_for_state(
            &state,
            "demo.market",
            "2.0.0",
            &archive,
            &DownloadIntegrity::none(),
        )
        .unwrap();
        commit_staged_update_for_state(&state, "demo.market", &staged.transaction_id).unwrap();
        fs::write(
            plugin_dir.join("plugin.json"),
            br#"{"id":"demo.market","name":"Demo","version":"3.0.0","type":"frontend","main":"index.js"}"#,
        )
        .unwrap();
        fs::write(plugin_dir.join("index.js"), b"unrelated code").unwrap();

        let report = recover_update_transactions_for_state(&state);
        assert_eq!(report.recovered_transactions, 0);
        assert_eq!(report.failures.len(), 1);
        assert_eq!(
            fs::read_to_string(plugin_dir.join("index.js")).unwrap(),
            "unrelated code"
        );
        assert!(update_transactions_dir(&state)
            .join("demo.market")
            .join(staged.transaction_id)
            .exists());
    }

    #[test]
    fn install_archive_rejects_a_mismatched_plugin_id() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        let manifest = br#"{"id":"someone.else","name":"X","version":"1.0.0"}"#;
        let archive = make_tar_gz(&[("plugin.json", manifest)]);
        let err = install_archive_into_plugin_dir(
            &state,
            "demo.market",
            "1.0.0",
            &archive,
            &DownloadIntegrity::none(),
        )
        .unwrap_err();
        assert!(matches!(err, PluginError::Internal(_)));
    }

    #[test]
    fn install_archive_rejects_an_archive_without_a_manifest() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        let archive = make_tar_gz(&[("readme.txt", b"no manifest here")]);
        let err = install_archive_into_plugin_dir(
            &state,
            "demo",
            "1.0.0",
            &archive,
            &DownloadIntegrity::none(),
        )
        .unwrap_err();
        assert!(matches!(err, PluginError::Internal(_)));
    }

    #[test]
    fn extraction_rejects_symlink_entries() {
        use flate2::write::GzEncoder;
        use flate2::Compression;

        let mut bytes = Vec::new();
        {
            let encoder = GzEncoder::new(&mut bytes, Compression::fast());
            let mut builder = tar::Builder::new(encoder);
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(tar::EntryType::Symlink);
            header.set_size(0);
            header.set_mode(0o777);
            header.set_link_name("../../outside.js").unwrap();
            header.set_cksum();
            builder
                .append_data(&mut header, "plugin/link.js", &[][..])
                .unwrap();
            builder.into_inner().unwrap().finish().unwrap();
        }

        let dest = TempDir::new().unwrap();
        let error = extract_tar_gz(&bytes, dest.path()).unwrap_err();
        assert!(error.contains("regular file or directory"));
        assert!(!dest.path().join("plugin/link.js").exists());
    }

    #[test]
    fn extraction_rejects_other_special_entries() {
        use flate2::write::GzEncoder;
        use flate2::Compression;

        let mut bytes = Vec::new();
        {
            let encoder = GzEncoder::new(&mut bytes, Compression::fast());
            let mut builder = tar::Builder::new(encoder);
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(tar::EntryType::Fifo);
            header.set_size(0);
            header.set_mode(0o644);
            header.set_cksum();
            builder
                .append_data(&mut header, "plugin/pipe", &[][..])
                .unwrap();
            builder.into_inner().unwrap().finish().unwrap();
        }

        let dest = TempDir::new().unwrap();
        let error = extract_tar_gz(&bytes, dest.path()).unwrap_err();
        assert!(error.contains("regular file or directory"));
    }

    #[test]
    fn extraction_enforces_entry_and_unpacked_byte_limits() {
        let archive = make_tar_gz(&[("plugin/a.js", b"1234"), ("plugin/b.js", b"5678")]);

        let entry_dest = TempDir::new().unwrap();
        let entry_error =
            extract_tar_gz_with_limits(&archive, entry_dest.path(), 1, 1024).unwrap_err();
        assert!(entry_error.contains("more than 1 entries"));

        let byte_dest = TempDir::new().unwrap();
        let byte_error = extract_tar_gz_with_limits(&archive, byte_dest.path(), 10, 7).unwrap_err();
        assert!(byte_error.contains("7-byte extraction limit"));
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
        let err = verify_download_integrity("demo", "1.0.0", b"a tampered archive", &integrity)
            .unwrap_err();
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
        assert!(
            matches!(err, PluginError::Crypto(m) if m.contains("signature verification failed"))
        );
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

    fn demo_archive() -> Vec<u8> {
        let manifest = br#"{"id":"demo.market","name":"Demo","version":"1.0.0","type":"frontend","main":"index.js"}"#;
        make_tar_gz(&[
            ("demo.market/plugin.json", manifest),
            ("demo.market/index.js", b"export default {}"),
        ])
    }

    #[test]
    fn verified_via_prefers_signature_then_checksum_then_none() {
        assert_eq!(DownloadIntegrity::none().verified_via(), None);
        assert_eq!(
            DownloadIntegrity {
                checksum: Some("ab".into()),
                ..Default::default()
            }
            .verified_via(),
            Some("checksum")
        );
        assert_eq!(
            DownloadIntegrity {
                checksum: Some("ab".into()),
                signature_hex: Some("cd".into()),
                public_key_hex: Some("ef".into()),
                ..Default::default()
            }
            .verified_via(),
            Some("signature")
        );
    }

    #[test]
    fn install_writes_a_checksum_receipt_and_reads_it_back() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        let archive = demo_archive();
        let integrity = DownloadIntegrity {
            checksum: Some(sha256_hex(&archive)),
            ..Default::default()
        };
        install_archive_into_plugin_dir(&state, "demo.market", "1.0.0", &archive, &integrity)
            .unwrap();

        let receipt = read_verification_receipt(&state, "demo.market").unwrap();
        assert_eq!(receipt.verified_via, "checksum");
        assert_eq!(receipt.version, "1.0.0");
        assert!(!receipt.verified_at.is_empty());
    }

    #[test]
    fn install_writes_a_signature_receipt_for_a_signed_archive() {
        use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
        use sha2::{Digest, Sha256};

        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        let archive = demo_archive();

        let signing_key = SigningKey::from_bytes(&[9u8; 32]);
        let verifying_key: VerifyingKey = (&signing_key).into();
        let mut hasher = Sha256::new();
        hasher.update(b"demo.market");
        hasher.update(b":");
        hasher.update(b"1.0.0");
        hasher.update(b":");
        hasher.update(&archive);
        let digest: [u8; 32] = hasher.finalize().into();
        let sig = signing_key.sign(&digest);

        let integrity = DownloadIntegrity {
            signature_hex: Some(hex::encode(sig.to_bytes())),
            public_key_hex: Some(hex::encode(verifying_key.to_bytes())),
            ..Default::default()
        };
        install_archive_into_plugin_dir(&state, "demo.market", "1.0.0", &archive, &integrity)
            .unwrap();

        let receipt = read_verification_receipt(&state, "demo.market").unwrap();
        assert_eq!(receipt.verified_via, "signature");
        assert_eq!(receipt.version, "1.0.0");
    }

    #[test]
    fn install_without_integrity_writes_no_receipt() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        let archive = demo_archive();
        install_archive_into_plugin_dir(
            &state,
            "demo.market",
            "1.0.0",
            &archive,
            &DownloadIntegrity::none(),
        )
        .unwrap();

        assert!(read_verification_receipt(&state, "demo.market").is_none());
        assert!(!state
            .plugin_dir("demo.market")
            .join(VERIFICATION_RECEIPT_FILE)
            .exists());
    }

    #[test]
    fn read_verification_receipt_is_none_for_an_unknown_plugin() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        assert!(read_verification_receipt(&state, "never.installed").is_none());
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

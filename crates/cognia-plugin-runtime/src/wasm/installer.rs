//! Install WASM plugin bundles from various sources (HTTP, Git, local file).
//!
//! Every install path lands at the same destination: a directory under
//! `<install_dir>/<plugin_id>/` containing the manifest JSON, the `.wasm`
//! component, and any auxiliary assets shipped in the bundle. Signature
//! verification (Ed25519 detached) and manifest sanity-checks happen
//! before the bundle is unpacked.

// Without `tauri-host` the commands compile out (ADR-0196), leaving imports
// and helpers only they use; the feature build still lints all of them.
#![cfg_attr(not(feature = "tauri-host"), allow(dead_code, unused_imports))]

use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::process::Command;

use base64::Engine as _;
use ed25519_dalek::{Signature, VerifyingKey, SIGNATURE_LENGTH};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(feature = "tauri-host")]
use tauri::State;

use super::super::PluginRuntimeState;

/// What we return to the TS side after a successful install. Mirrors the
/// `plugin_install` command's response so the manager-side dispatch is
/// unchanged for new install paths.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WasmInstallResult {
    pub manifest: serde_json::Value,
    pub path: String,
    pub source: String,
    pub install_root_kind: String,
    pub signature_verified: bool,
    pub bundle_sha256: Option<String>,
    pub transaction_id: Option<String>,
    pub author_public_key: Option<String>,
    pub author_fingerprint: Option<String>,
    /// The exact commit a Git install checked out (ADR-0209). `None` for
    /// bundle installs, which are pinned by `bundle_sha256` instead.
    pub resolved_commit: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PartialManifest {
    id: String,
    #[serde(default)]
    #[serde(rename = "type")]
    plugin_type: Option<String>,
    #[serde(rename = "wasmMain", default)]
    wasm_main: Option<String>,
    #[serde(default)]
    author: Option<serde_json::Value>,
    #[serde(default)]
    wasm: Option<PartialWasmBlock>,
}

#[derive(Debug, Deserialize)]
struct PartialWasmBlock {
    #[serde(rename = "apiVersion")]
    api_version: String,
}

fn b64() -> base64::engine::general_purpose::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

fn verify_detached(
    bundle: &[u8],
    signature_base64: &str,
    public_key_base64: &str,
) -> Result<(), String> {
    let pk = b64()
        .decode(public_key_base64.as_bytes())
        .map_err(|e| format!("public key base64 decode: {e}"))?;
    let pk: [u8; 32] = pk
        .as_slice()
        .try_into()
        .map_err(|_| "public key must be 32 bytes".to_string())?;
    let verifying =
        VerifyingKey::from_bytes(&pk).map_err(|e| format!("invalid public key: {e}"))?;
    let sig = b64()
        .decode(signature_base64.as_bytes())
        .map_err(|e| format!("signature base64 decode: {e}"))?;
    let sig: [u8; SIGNATURE_LENGTH] = sig
        .as_slice()
        .try_into()
        .map_err(|_| format!("signature must be {SIGNATURE_LENGTH} bytes"))?;
    let signature = Signature::from_bytes(&sig);
    verifying
        .verify_strict(bundle, &signature)
        .map_err(|e| format!("signature verification failed: {e}"))
}

/// Extract a `.zip` plugin bundle into `target_dir`. Unsafe paths or archive
/// links reject the whole bundle. Returns the extracted `plugin.json` path.
fn extract_zip_bundle(bytes: &[u8], target_dir: &Path) -> Result<PathBuf, String> {
    extract_zip_bundle_with_limits(
        bytes,
        target_dir,
        crate::archive_limits::MAX_ARCHIVE_ENTRIES,
        crate::archive_limits::MAX_UNPACKED_BYTES,
    )
}

fn extract_zip_bundle_with_limits(
    bytes: &[u8],
    target_dir: &Path,
    max_entries: usize,
    max_unpacked_bytes: u64,
) -> Result<PathBuf, String> {
    let reader = Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(reader).map_err(|e| format!("open zip bundle: {e}"))?;
    if archive.len() > max_entries {
        return Err(format!(
            "plugin archive contains {} entries, limit is {}",
            archive.len(),
            max_entries
        ));
    }
    let mut manifest_paths = Vec::new();
    let mut total_written = 0_u64;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("read zip entry {i}: {e}"))?;
        let entry_path = entry
            .enclosed_name()
            .ok_or_else(|| format!("unsafe zip entry path: {}", entry.name()))?
            .to_path_buf();
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(format!(
                "symbolic-link zip entries are not allowed: {}",
                entry.name()
            ));
        }
        let target = target_dir.join(&entry_path);
        if entry.is_dir() {
            std::fs::create_dir_all(&target).map_err(|e| format!("mkdir {target:?}: {e}"))?;
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {parent:?}: {e}"))?;
        }
        let mut out =
            std::fs::File::create(&target).map_err(|e| format!("write {target:?}: {e}"))?;
        crate::archive_limits::copy_with_budget(
            &mut entry,
            &mut out,
            &mut total_written,
            max_unpacked_bytes,
            entry_path.to_string_lossy().as_ref(),
        )?;
        #[cfg(unix)]
        if let Some(mode) = entry.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            // Retain executability for plugin-owned servers without setuid/setgid or broad write bits.
            let safe_mode = if mode & 0o111 != 0 { 0o755 } else { 0o644 };
            std::fs::set_permissions(&target, std::fs::Permissions::from_mode(safe_mode))
                .map_err(|error| format!("set plugin file mode {target:?}: {error}"))?;
        }
        if entry_path.file_name().is_some_and(|n| n == "plugin.json") {
            manifest_paths.push(target.clone());
        }
    }
    let root_manifest = target_dir.join("plugin.json");
    if manifest_paths.contains(&root_manifest) {
        return Ok(root_manifest);
    }
    match manifest_paths.as_slice() {
        [manifest] => Ok(manifest.clone()),
        [] => Err("bundle is missing plugin.json".into()),
        _ => Err("bundle has multiple nested plugin.json files and no root manifest".into()),
    }
}

fn read_manifest(path: &Path) -> Result<(serde_json::Value, PartialManifest), String> {
    let bytes = std::fs::read(path).map_err(|e| format!("read manifest {path:?}: {e}"))?;
    let raw: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("parse manifest: {e}"))?;
    let parsed: PartialManifest =
        serde_json::from_slice(&bytes).map_err(|e| format!("parse manifest fields: {e}"))?;
    Ok((raw, parsed))
}

fn assert_wasm_manifest(parsed: &PartialManifest) -> Result<(), String> {
    if parsed.plugin_type.as_deref() != Some("wasm") {
        return Err("bundle manifest is not type: \"wasm\"".into());
    }
    if parsed
        .wasm_main
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .is_empty()
    {
        return Err("bundle manifest is missing wasmMain".into());
    }
    crate::contained_path::validate_plugin_relative_path(
        parsed.wasm_main.as_deref().unwrap_or_default(),
    )
    .map_err(|error| format!("bundle manifest has unsafe wasmMain: {error}"))?;
    if parsed
        .wasm
        .as_ref()
        .map(|w| w.api_version.trim())
        .unwrap_or("")
        .is_empty()
    {
        return Err("bundle manifest is missing wasm.apiVersion".into());
    }
    Ok(())
}

#[cfg(feature = "tauri-host")]
#[tauri::command]
pub async fn plugin_wasm_install_from_url(
    state: State<'_, PluginRuntimeState>,
    bundle_url: String,
    signature_url: Option<String>,
    expected_public_key_base64: Option<String>,
    preview_only: Option<bool>,
    expected_bundle_sha256: Option<String>,
    defer_commit: Option<bool>,
) -> Result<WasmInstallResult, String> {
    install_bundle_from_url(
        state,
        bundle_url,
        signature_url,
        expected_public_key_base64,
        preview_only,
        expected_bundle_sha256,
        defer_commit,
        true,
    )
    .await
}

#[cfg(feature = "tauri-host")]
#[tauri::command]
pub async fn plugin_bundle_install_from_url(
    state: State<'_, PluginRuntimeState>,
    bundle_url: String,
    signature_url: Option<String>,
    expected_public_key_base64: Option<String>,
    preview_only: Option<bool>,
    expected_bundle_sha256: Option<String>,
    defer_commit: Option<bool>,
) -> Result<WasmInstallResult, String> {
    install_bundle_from_url(
        state,
        bundle_url,
        signature_url,
        expected_public_key_base64,
        preview_only,
        expected_bundle_sha256,
        defer_commit,
        false,
    )
    .await
}

#[cfg(feature = "tauri-host")]
async fn install_bundle_from_url(
    state: State<'_, PluginRuntimeState>,
    bundle_url: String,
    signature_url: Option<String>,
    expected_public_key_base64: Option<String>,
    preview_only: Option<bool>,
    expected_bundle_sha256: Option<String>,
    defer_commit: Option<bool>,
    wasm_only: bool,
) -> Result<WasmInstallResult, String> {
    // Step 1 — fetch the bundle.
    cognia_net::proxy_config::ensure_crypto_provider();
    let builder = reqwest::Client::builder().user_agent("cognia-plugin-installer/0.1");
    let (builder, _) = cognia_net::proxy_config::apply_reqwest_policy(builder, &bundle_url)
        .map_err(|error| error.to_string())?;
    let client = builder
        .build()
        .map_err(|e| format!("http client init: {e}"))?;
    let response = client
        .get(&bundle_url)
        .send()
        .await
        .map_err(|e| format!("download bundle: {e}"))?
        .error_for_status()
        .map_err(|e| format!("download bundle (HTTP error): {e}"))?;
    let bundle = crate::archive_limits::read_response_limited(
        response,
        crate::archive_limits::MAX_DOWNLOAD_BYTES,
        "plugin bundle",
    )
    .await?;

    // Step 2 — verify signature if requested.
    let mut signature_verified = false;
    if let (Some(sig_url), Some(pk_b64)) =
        (signature_url.as_ref(), expected_public_key_base64.as_ref())
    {
        let sig_response = client
            .get(sig_url)
            .send()
            .await
            .map_err(|e| format!("download signature: {e}"))?
            .error_for_status()
            .map_err(|e| format!("download signature (HTTP error): {e}"))?;
        let sig_body = crate::archive_limits::read_response_limited(
            sig_response,
            crate::archive_limits::MAX_SIGNATURE_BYTES,
            "plugin signature",
        )
        .await?;
        let sig_body = std::str::from_utf8(&sig_body)
            .map_err(|_| "plugin signature response is not UTF-8".to_string())?;
        verify_detached(&bundle, sig_body.trim(), pk_b64)?;
        signature_verified = true;
    } else if expected_public_key_base64.is_some() || signature_url.is_some() {
        return Err(
            "signature_url and expected_public_key_base64 must be provided together".into(),
        );
    }

    let install_root = state.plugin_install_dir.clone();
    let state_root = state.plugin_state_dir.clone();
    let bundle = bundle.to_vec();
    tokio::task::spawn_blocking(move || {
        install_downloaded_plugin_bundle(
            &install_root,
            &bundle,
            signature_verified
                .then_some(expected_public_key_base64.as_deref())
                .flatten(),
            preview_only.unwrap_or(false),
            expected_bundle_sha256.as_deref(),
            defer_commit
                .unwrap_or(false)
                .then_some(state_root.as_path()),
            wasm_only,
        )
    })
    .await
    .map_err(|error| format!("WASM bundle install task failed: {error}"))?
}

/// Install a WASM plugin bundle the user picked off this machine's disk.
///
/// The third source this module's docblock has always named, and the only one
/// that was never written. `install-wasm-plugin-button.tsx` therefore had
/// nowhere to send a picked file and fell back to `plugin_install`, which
/// unpacks nothing at all (it validates a manifest, creates a directory and
/// writes `manifest.json`) and whose signature the call did not match anyway,
/// so the button could not succeed under any input.
///
/// Everything after "have the bytes" is the path `plugin_wasm_install_from_url`
/// already takes, so a local bundle gets the same archive limits, the same
/// manifest-contract validation, and the same atomic replace over any prior
/// install. Only the two steps that differ live here: reading the file instead
/// of streaming a response, and verifying a signature that is handed over
/// directly rather than fetched from a second URL.
///
/// A `.zip` only, despite older wording elsewhere about a bare `.wasm`. A lone
/// component carries no manifest, so there is no id to install under, nothing
/// to validate and no capabilities to grant. Refusing it by name beats
/// accepting the file and failing deeper in with an archive error.
///
/// Deliberately ABSENT from `protocol/companion-commands.json`, unlike its two
/// siblings. They name a URL or a repository, while this names a path on the
/// HOST, so publishing it remotely would hand a paired client a read primitive
/// over the host filesystem. That is a decision to take on its own evidence,
/// not as a side effect of adding a local installer.
#[cfg(feature = "tauri-host")]
#[tauri::command]
pub async fn plugin_wasm_install_from_file(
    state: State<'_, PluginRuntimeState>,
    bundle_path: String,
    signature_base64: Option<String>,
    expected_public_key_base64: Option<String>,
    preview_only: Option<bool>,
    expected_bundle_sha256: Option<String>,
    defer_commit: Option<bool>,
) -> Result<WasmInstallResult, String> {
    install_bundle_from_file(
        state,
        bundle_path,
        signature_base64,
        expected_public_key_base64,
        preview_only,
        expected_bundle_sha256,
        defer_commit,
        true,
    )
    .await
}

#[cfg(feature = "tauri-host")]
#[tauri::command]
pub async fn plugin_bundle_install_from_file(
    state: State<'_, PluginRuntimeState>,
    bundle_path: String,
    signature_base64: Option<String>,
    expected_public_key_base64: Option<String>,
    preview_only: Option<bool>,
    expected_bundle_sha256: Option<String>,
    defer_commit: Option<bool>,
) -> Result<WasmInstallResult, String> {
    install_bundle_from_file(
        state,
        bundle_path,
        signature_base64,
        expected_public_key_base64,
        preview_only,
        expected_bundle_sha256,
        defer_commit,
        false,
    )
    .await
}

#[cfg(feature = "tauri-host")]
async fn install_bundle_from_file(
    state: State<'_, PluginRuntimeState>,
    bundle_path: String,
    signature_base64: Option<String>,
    expected_public_key_base64: Option<String>,
    preview_only: Option<bool>,
    expected_bundle_sha256: Option<String>,
    defer_commit: Option<bool>,
    wasm_only: bool,
) -> Result<WasmInstallResult, String> {
    let install_root = state.plugin_install_dir.clone();
    let state_root = state.plugin_state_dir.clone();
    let path = PathBuf::from(bundle_path.trim());
    if !path.is_absolute() {
        return Err("bundle_path must be an absolute path".into());
    }

    let bundle = {
        let path = path.clone();
        tokio::task::spawn_blocking(move || {
            read_bundle_file_limited(&path, crate::archive_limits::MAX_DOWNLOAD_BYTES)
        })
        .await
        .map_err(|error| format!("read plugin bundle task failed: {error}"))??
    };

    // The same pairing rule the URL installer enforces: a signature with no key
    // (or a key with no signature) is a verification the caller asked for and
    // this cannot perform, which is a refusal rather than a reason to install
    // the bundle unverified.
    let signature_verified = match (
        signature_base64.as_deref(),
        expected_public_key_base64.as_deref(),
    ) {
        (Some(signature), Some(public_key)) => {
            verify_detached(&bundle, signature.trim(), public_key.trim())?;
            true
        }
        (None, None) => false,
        _ => {
            return Err(
                "signature_base64 and expected_public_key_base64 must be provided together".into(),
            );
        }
    };

    let mut result = tokio::task::spawn_blocking(move || {
        install_downloaded_plugin_bundle(
            &install_root,
            &bundle,
            signature_verified
                .then_some(expected_public_key_base64.as_deref())
                .flatten(),
            preview_only.unwrap_or(false),
            expected_bundle_sha256.as_deref(),
            defer_commit
                .unwrap_or(false)
                .then_some(state_root.as_path()),
            wasm_only,
        )
    })
    .await
    .map_err(|error| format!("WASM bundle install task failed: {error}"))??;
    // The shared helper is written for the marketplace path and stamps that
    // provenance. This bundle came off the user's own disk, and `source` is
    // what the plugin store shows and filters on.
    result.source = "local".into();
    Ok(result)
}

/// Stage a validated local directory without replacing a running plugin.
/// Kept local-only: remote companion callers must never select host paths.
#[cfg(feature = "tauri-host")]
#[tauri::command]
pub async fn plugin_stage_from_directory(
    state: State<'_, PluginRuntimeState>,
    source_dir: String,
) -> Result<WasmInstallResult, String> {
    let install_root = state.plugin_install_dir.clone();
    let state_root = state.plugin_state_dir.clone();
    tokio::task::spawn_blocking(move || {
        stage_plugin_directory(&install_root, &state_root, Path::new(&source_dir))
    })
    .await
    .map_err(|error| format!("stage plugin directory task failed: {error}"))?
}

fn stage_plugin_directory(
    install_root: &Path,
    state_root: &Path,
    source: &Path,
) -> Result<WasmInstallResult, String> {
    if !source.is_absolute() || !source.is_dir() {
        return Err("sourceDir must be an absolute plugin directory".into());
    }
    crate::contained_path::validate_symlink_free_tree(source)?;
    let (manifest, parsed) = read_manifest(&source.join("plugin.json"))?;
    crate::contract::validate_manifest_contract(&manifest)?;
    crate::contract::validate_existing_manifest_paths(source, &manifest)?;
    let plugin_id =
        crate::validate_plugin_id_path_component(&parsed.id).map_err(|error| error.to_string())?;
    let prepared = tempfile::tempdir().map_err(|error| error.to_string())?;
    copy_dir_recursive(source, prepared.path(), &[".git", "node_modules", "target"])?;
    // Local authored trees cannot grant themselves a signature receipt.
    let receipt = prepared
        .path()
        .join(crate::marketplace::VERIFICATION_RECEIPT_FILE);
    if receipt.exists() {
        std::fs::remove_file(receipt).map_err(|error| error.to_string())?;
    }
    let transaction_id =
        crate::marketplace::stage_tree_install(state_root, prepared.path(), &manifest)
            .map_err(|error| error.to_string())?;
    Ok(WasmInstallResult {
        manifest,
        path: install_root.join(plugin_id).to_string_lossy().into_owned(),
        source: "local".into(),
        install_root_kind: "installed".into(),
        signature_verified: false,
        bundle_sha256: None,
        transaction_id: Some(transaction_id),
        author_public_key: None,
        author_fingerprint: None,
        resolved_commit: None,
    })
}

/// Read a local bundle without letting an enormous file become an OOM.
///
/// The size is checked from metadata BEFORE the read rather than after, which
/// is the whole point: `std::fs::read` on a 40 GB file allocates 40 GB first
/// and reports the limit violation second.
fn read_bundle_file_limited(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let metadata =
        std::fs::metadata(path).map_err(|error| format!("stat {}: {error}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!("{} is not a file", path.display()));
    }
    if metadata.len() > limit {
        return Err(format!(
            "plugin bundle is {} bytes, limit is {limit}",
            metadata.len()
        ));
    }
    std::fs::read(path).map_err(|error| format!("read {}: {error}", path.display()))
}

#[cfg(test)]
fn install_downloaded_wasm_bundle(
    install_root: &Path,
    bundle: &[u8],
    verified_public_key: Option<&str>,
    preview_only: bool,
    expected_bundle_sha256: Option<&str>,
    deferred_state_root: Option<&Path>,
) -> Result<WasmInstallResult, String> {
    install_downloaded_plugin_bundle(
        install_root,
        bundle,
        verified_public_key,
        preview_only,
        expected_bundle_sha256,
        deferred_state_root,
        true,
    )
}

fn install_downloaded_plugin_bundle(
    install_root: &Path,
    bundle: &[u8],
    verified_public_key: Option<&str>,
    preview_only: bool,
    expected_bundle_sha256: Option<&str>,
    deferred_state_root: Option<&Path>,
    wasm_only: bool,
) -> Result<WasmInstallResult, String> {
    let digest = sha256_hex(bundle);
    if expected_bundle_sha256.is_some_and(|expected| !expected.eq_ignore_ascii_case(&digest)) {
        return Err(
            "plugin bundle changed since preview; inspect it again before installing".into(),
        );
    }
    // Extract to a temp dir, parse manifest, validate.
    let staging = tempfile::tempdir().map_err(|e| format!("create temp dir: {e}"))?;
    let manifest_path = extract_zip_bundle(bundle, staging.path())?;
    let (manifest_value, parsed) = read_manifest(&manifest_path)?;
    if wasm_only || parsed.plugin_type.as_deref() == Some("wasm") {
        assert_wasm_manifest(&parsed)?;
    } else if parsed.plugin_type.as_deref() != Some("frontend") {
        return Err("bundle installer supports prebuilt frontend and WASM plugins".into());
    }
    crate::contract::validate_manifest_contract(&manifest_value)?;
    let plugin_root = manifest_path.parent().unwrap_or(staging.path());
    crate::contract::validate_existing_manifest_paths(plugin_root, &manifest_value)?;

    // Stage the validated bundle beside the destination and atomically
    // replace any prior install only after the copied tree passes the same gate.
    let plugin_id =
        crate::validate_plugin_id_path_component(&parsed.id).map_err(|error| error.to_string())?;
    let plugin_dir = install_root.join(plugin_id);
    let declared_key = parsed
        .author
        .as_ref()
        .and_then(|author| author.get("publicKey").and_then(serde_json::Value::as_str));
    if let (Some(verified), Some(declared)) = (verified_public_key, declared_key) {
        if b64()
            .decode(verified.trim())
            .map_err(|error| error.to_string())?
            != b64()
                .decode(declared.trim())
                .map_err(|error| error.to_string())?
        {
            return Err("manifest author public key does not match the verified signer".into());
        }
    }
    let author_key = verified_public_key
        .or(declared_key)
        .map(|key| key.trim().to_string());
    let (author_pk, author_fp) = match author_key {
        Some(pk) => {
            let decoded = b64().decode(pk.as_bytes()).ok();
            let fp = decoded.as_ref().map(|b| sha256_hex(b));
            (Some(pk), fp)
        }
        None => (None, None),
    };

    let transaction_id = if preview_only {
        None
    } else {
        // A package cannot author its own verification receipt.
        let receipt_path = plugin_root.join(crate::marketplace::VERIFICATION_RECEIPT_FILE);
        if receipt_path.exists() {
            std::fs::remove_file(&receipt_path)
                .map_err(|error| format!("remove bundled verification receipt: {error}"))?;
        }
        if verified_public_key.is_some() {
            let receipt = crate::marketplace::VerificationReceipt {
                verified_via: "signature".into(),
                version: manifest_value
                    .get("version")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .into(),
                verified_at: chrono::Utc::now().to_rfc3339(),
            };
            std::fs::write(
                &receipt_path,
                serde_json::to_vec(&receipt).map_err(|error| error.to_string())?,
            )
            .map_err(|error| format!("write verified signer receipt: {error}"))?;
        }
        if let Some(state_root) = deferred_state_root {
            Some(
                crate::marketplace::stage_tree_install(state_root, plugin_root, &manifest_value)
                    .map_err(|error| error.to_string())?,
            )
        } else {
            atomically_install_tree(plugin_root, &plugin_dir, &manifest_value)?;
            None
        }
    };
    Ok(WasmInstallResult {
        manifest: manifest_value,
        path: plugin_dir.to_string_lossy().into_owned(),
        source: "marketplace".into(),
        install_root_kind: "installed".into(),
        signature_verified: verified_public_key.is_some(),
        bundle_sha256: Some(digest),
        transaction_id,
        author_public_key: author_pk,
        author_fingerprint: author_fp,
        resolved_commit: None,
    })
}

pub(crate) fn copy_dir_recursive(
    src: &Path,
    dst: &Path,
    excluded_top_level: &[&str],
) -> Result<(), String> {
    for entry in std::fs::read_dir(src).map_err(|e| format!("read_dir {src:?}: {e}"))? {
        let entry = entry.map_err(|e| format!("dir entry: {e}"))?;
        let path = entry.path();
        if excluded_top_level
            .iter()
            .any(|excluded| entry.file_name() == std::ffi::OsStr::new(excluded))
        {
            continue;
        }
        let rel = path.strip_prefix(src).unwrap();
        let target = dst.join(rel);
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|e| format!("stat source entry {path:?}: {e}"))?;
        if metadata.file_type().is_symlink() {
            return Err(format!("plugin source contains a symbolic link: {path:?}"));
        }
        if metadata.is_dir() {
            std::fs::create_dir_all(&target).map_err(|e| format!("mkdir {target:?}: {e}"))?;
            copy_dir_recursive(&path, &target, &[])?;
        } else if metadata.is_file() {
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {parent:?}: {e}"))?;
            }
            std::fs::copy(&path, &target).map_err(|e| format!("copy {path:?}: {e}"))?;
        } else {
            return Err(format!("plugin source contains a non-file entry: {path:?}"));
        }
    }
    Ok(())
}

pub(crate) fn atomically_install_tree(
    source_root: &Path,
    plugin_dir: &Path,
    manifest: &serde_json::Value,
) -> Result<(), String> {
    crate::contract::validate_existing_manifest_paths(source_root, manifest)?;
    let parent = plugin_dir
        .parent()
        .ok_or_else(|| format!("plugin directory has no parent: {plugin_dir:?}"))?;
    std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {parent:?}: {e}"))?;
    let transaction = tempfile::Builder::new()
        .prefix(".plugin-install-")
        .tempdir_in(parent)
        .map_err(|e| format!("create install transaction: {e}"))?;
    let prepared = transaction.path().join("payload");
    std::fs::create_dir(&prepared).map_err(|e| format!("mkdir {prepared:?}: {e}"))?;
    copy_dir_recursive(source_root, &prepared, &[])?;
    let marker = prepared.join(crate::marketplace::INSTALL_TRANSACTION_FILE);
    if marker.exists() {
        std::fs::remove_file(marker).map_err(|error| error.to_string())?;
    }
    crate::contract::validate_existing_manifest_paths(&prepared, manifest)?;

    let _guard = crate::marketplace::INSTALL_COMMIT_LOCK
        .lock()
        .map_err(|_| "install commit lock poisoned".to_string())?;
    crate::marketplace::ensure_install_not_pending(plugin_dir)
        .map_err(|error| error.to_string())?;
    let transaction_path = transaction.path().to_path_buf();
    let prepared = transaction_path.join("payload");
    let backup = parent.join(format!(".plugin-backup-{}", uuid::Uuid::new_v4()));
    let had_previous = plugin_dir.exists();
    if had_previous {
        std::fs::rename(plugin_dir, &backup)
            .map_err(|e| format!("move prior plugin install to backup: {e}"))?;
    }
    if let Err(error) = std::fs::rename(&prepared, plugin_dir) {
        let rollback_error = had_previous
            .then(|| std::fs::rename(&backup, plugin_dir).err())
            .flatten();
        let _ = std::fs::remove_dir_all(&transaction_path);
        if let Some(rollback_error) = rollback_error {
            return Err(format!(
                "activate validated plugin install: {error}; restoring prior install also failed: {rollback_error}; backup remains at {backup:?}"
            ));
        }
        return Err(format!("activate validated plugin install: {error}"));
    }
    if had_previous {
        if let Err(error) = std::fs::remove_dir_all(&backup) {
            log::warn!(
                "plugin install committed but prior backup cleanup failed for {backup:?}: {error}"
            );
        }
    }
    if let Err(error) = std::fs::remove_dir_all(&transaction_path) {
        log::warn!(
            "plugin install committed but transaction cleanup failed for {transaction_path:?}: {error}"
        );
    }
    Ok(())
}

/// Clone a Git repo (shallow) and install an already-built WASM component.
/// The host never runs repository build scripts or proc macros; authors build
/// and sign release bundles outside the app trust boundary.
#[cfg(feature = "tauri-host")]
#[tauri::command]
pub async fn plugin_wasm_install_from_git(
    state: State<'_, PluginRuntimeState>,
    repo_url: String,
    branch: Option<String>,
    commit: Option<String>,
) -> Result<WasmInstallResult, String> {
    let install_root = state.plugin_install_dir.clone();
    tokio::task::spawn_blocking(move || {
        install_prebuilt_wasm_from_git(
            &install_root,
            &repo_url,
            branch.as_deref(),
            commit.as_deref(),
        )
    })
    .await
    .map_err(|error| format!("WASM Git install task failed: {error}"))?
}

/// True for a full 40-hex SHA-1 commit id. An abbreviated id or a ref name is
/// not a pin: it can name a different commit tomorrow.
pub(crate) fn is_full_commit_sha(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

fn run_git(args: &[&std::ffi::OsStr], context: &str) -> Result<std::process::Output, String> {
    // Never prompt: a cogpack names the repository, and a private or missing
    // HTTPS repo must fail instead of blocking this thread on a credential ask.
    let output = Command::new("git")
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| format!("{context} (is git installed?): {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "{context} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(output)
}

/// Check the repository out into `staging` and return the commit it is at.
///
/// With `commit`, fetch exactly that commit (shallow) and refuse anything else:
/// this is how a cogpack reinstalls the revision it pinned (ADR-0209). Without
/// it, shallow-clone `branch` (or the default branch) as before and report the
/// commit that produced, so the install can be pinned afterwards.
pub(crate) fn checkout_git_source(
    staging: &Path,
    repo_url: &str,
    branch: Option<&str>,
    commit: Option<&str>,
) -> Result<String, String> {
    use std::ffi::OsStr;
    let dir = staging.as_os_str();
    if let Some(commit) = commit {
        if !is_full_commit_sha(commit) {
            return Err(format!(
                "git commit must be a full 40-character SHA: {commit:?}"
            ));
        }
        run_git(
            &[OsStr::new("init"), OsStr::new("--quiet"), dir],
            "git init",
        )?;
        run_git(
            &[
                OsStr::new("-C"),
                dir,
                OsStr::new("remote"),
                OsStr::new("add"),
                OsStr::new("origin"),
                OsStr::new("--"),
                OsStr::new(repo_url),
            ],
            "git remote add",
        )?;
        run_git(
            &[
                OsStr::new("-C"),
                dir,
                OsStr::new("fetch"),
                OsStr::new("--depth=1"),
                OsStr::new("origin"),
                OsStr::new(commit),
            ],
            "git fetch",
        )?;
        run_git(
            &[
                OsStr::new("-C"),
                dir,
                OsStr::new("checkout"),
                OsStr::new("--quiet"),
                OsStr::new("--detach"),
                OsStr::new("FETCH_HEAD"),
            ],
            "git checkout",
        )?;
    } else {
        let mut args: Vec<&OsStr> = vec![OsStr::new("clone"), OsStr::new("--depth=1")];
        if let Some(b) = branch {
            args.push(OsStr::new("--branch"));
            args.push(OsStr::new(b));
        }
        args.push(OsStr::new("--"));
        args.push(OsStr::new(repo_url));
        args.push(dir);
        run_git(&args, "git clone")?;
    }
    let head = run_git(
        &[
            OsStr::new("-C"),
            dir,
            OsStr::new("rev-parse"),
            OsStr::new("HEAD"),
        ],
        "git rev-parse",
    )?;
    let resolved = String::from_utf8_lossy(&head.stdout)
        .trim()
        .to_ascii_lowercase();
    if !is_full_commit_sha(&resolved) {
        return Err(format!(
            "git rev-parse returned an invalid commit: {resolved:?}"
        ));
    }
    if let Some(commit) = commit {
        if !resolved.eq_ignore_ascii_case(commit) {
            return Err(format!(
                "git checked out {resolved} but the pinned commit is {commit}"
            ));
        }
    }
    Ok(resolved)
}

fn install_prebuilt_wasm_from_git(
    install_root: &Path,
    repo_url: &str,
    branch: Option<&str>,
    commit: Option<&str>,
) -> Result<WasmInstallResult, String> {
    let staging = tempfile::tempdir().map_err(|e| format!("create temp dir: {e}"))?;
    let staging_path = staging.path().to_path_buf();

    // Step 1 — check out the source, pinned when a commit is given.
    let resolved_commit = checkout_git_source(&staging_path, repo_url, branch, commit)?;

    // Reject repository-authored symlinks before reading a manifest or running
    // a build. Build output directories are created only after this gate.
    crate::contained_path::validate_symlink_free_tree(&staging_path)?;

    // Locate the manifest + pre-built .wasm in the staging tree.
    let manifest_path = find_plugin_manifest(&staging_path)
        .ok_or_else(|| "repository is missing plugin.json".to_string())?;
    let (manifest_value, parsed) = read_manifest(&manifest_path)?;
    assert_wasm_manifest(&parsed)?;
    crate::contract::validate_manifest_contract(&manifest_value)?;

    let wasm_main = parsed.wasm_main.clone().unwrap_or_default();
    let wasm_src = find_wasm_artifact(&staging_path, &wasm_main)
        .ok_or_else(|| format!("could not locate produced .wasm matching {wasm_main:?}"))?;
    let plugin_root = manifest_path
        .parent()
        .ok_or_else(|| "plugin manifest has no parent directory".to_string())?;
    let prepared = tempfile::tempdir().map_err(|e| format!("prepare Git plugin tree: {e}"))?;
    copy_dir_recursive(plugin_root, prepared.path(), &[".git", "target"])?;
    let wasm_relative = wasm_src
        .strip_prefix(&staging_path)
        .map_err(|_| "WASM artifact escaped the cloned repository".to_string())?;
    let wasm_bytes = crate::contained_path::read_existing_plugin_file(
        &staging_path,
        &wasm_relative.to_string_lossy(),
    )?;
    crate::contained_path::write_plugin_file(prepared.path(), &wasm_main, &wasm_bytes)?;
    let plugin_id =
        crate::validate_plugin_id_path_component(&parsed.id).map_err(|error| error.to_string())?;
    let plugin_dir = install_root.join(plugin_id);
    atomically_install_tree(prepared.path(), &plugin_dir, &manifest_value)?;

    let (author_pk, author_fp) = match parsed.author.as_ref().and_then(|a| {
        a.get("publicKey")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
    }) {
        Some(pk) => {
            let decoded = b64().decode(pk.as_bytes()).ok();
            let fp = decoded.as_ref().map(|b| sha256_hex(b));
            (Some(pk), fp)
        }
        None => (None, None),
    };

    Ok(WasmInstallResult {
        manifest: manifest_value,
        path: plugin_dir.to_string_lossy().into_owned(),
        source: "git".into(),
        install_root_kind: "installed".into(),
        signature_verified: false,
        bundle_sha256: None,
        transaction_id: None,
        author_public_key: author_pk,
        author_fingerprint: author_fp,
        resolved_commit: Some(resolved_commit),
    })
}

fn find_plugin_manifest(root: &Path) -> Option<PathBuf> {
    let candidate = root.join("plugin.json");
    if candidate.exists() {
        return Some(candidate);
    }
    // Allow `manifest/plugin.json` and one level of nesting for monorepo
    // layouts. We only look one level deep on purpose so a misplaced file
    // can't be silently picked.
    let entries = std::fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            let nested = p.join("plugin.json");
            if nested.exists() {
                return Some(nested);
            }
        }
    }
    None
}

fn find_wasm_artifact(root: &Path, expected_basename: &str) -> Option<PathBuf> {
    let target_release = root.join("target").join("wasm32-wasip2").join("release");
    let target_release_p1 = root.join("target").join("wasm32-wasip1").join("release");
    let component_release = root
        .join("target")
        .join("wasm32-wasip2")
        .join("release")
        .join("component");
    for dir in [&target_release, &target_release_p1, &component_release] {
        if !dir.exists() {
            continue;
        }
        if !expected_basename.is_empty() {
            let direct = dir.join(expected_basename);
            if direct.exists() {
                return Some(direct);
            }
        }
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.extension().and_then(|e| e.to_str()) == Some("wasm") {
                    return Some(p);
                }
            }
        }
    }
    let direct = root.join(expected_basename);
    if direct.exists() {
        return Some(direct);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use std::io::Write;

    fn git_available() -> bool {
        Command::new("git").arg("--version").output().is_ok()
    }

    fn git(dir: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.com")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    /// A local repository with two commits; returns (dir, first, second).
    fn two_commit_repo() -> (tempfile::TempDir, String, String) {
        let repo = tempfile::tempdir().unwrap();
        git(repo.path(), &["init", "--quiet", "--initial-branch=main"]);
        std::fs::write(repo.path().join("plugin.json"), "{\"v\":1}").unwrap();
        git(repo.path(), &["add", "."]);
        git(repo.path(), &["commit", "--quiet", "-m", "one"]);
        let first = git(repo.path(), &["rev-parse", "HEAD"]);
        std::fs::write(repo.path().join("plugin.json"), "{\"v\":2}").unwrap();
        git(repo.path(), &["commit", "--quiet", "-am", "two"]);
        let second = git(repo.path(), &["rev-parse", "HEAD"]);
        (repo, first, second)
    }

    #[test]
    fn full_commit_sha_is_forty_hex_characters() {
        assert!(is_full_commit_sha(&"a".repeat(40)));
        assert!(is_full_commit_sha(
            "0123456789ABCDEF0123456789abcdef01234567"
        ));
        assert!(!is_full_commit_sha(&"a".repeat(39)));
        assert!(!is_full_commit_sha("main"));
        assert!(!is_full_commit_sha(&"g".repeat(40)));
    }

    #[test]
    fn unpinned_checkout_reports_the_commit_it_cloned() {
        if !git_available() {
            return;
        }
        let (repo, _first, second) = two_commit_repo();
        let url = format!("file://{}", repo.path().display());
        let staging = tempfile::tempdir().unwrap();
        let resolved = checkout_git_source(staging.path(), &url, None, None).unwrap();
        assert_eq!(resolved, second);
    }

    #[test]
    fn pinned_checkout_fetches_exactly_the_commit() {
        if !git_available() {
            return;
        }
        let (repo, first, _second) = two_commit_repo();
        git(
            repo.path(),
            &["config", "uploadpack.allowReachableSHA1InWant", "true"],
        );
        let url = format!("file://{}", repo.path().display());
        let staging = tempfile::tempdir().unwrap();
        let resolved = checkout_git_source(staging.path(), &url, None, Some(&first)).unwrap();
        assert_eq!(resolved, first);
        assert_eq!(
            std::fs::read_to_string(staging.path().join("plugin.json")).unwrap(),
            "{\"v\":1}"
        );
    }

    #[test]
    fn pinned_checkout_refuses_an_abbreviated_commit() {
        let staging = tempfile::tempdir().unwrap();
        let error = checkout_git_source(staging.path(), "file:///nowhere", None, Some("abc123"))
            .unwrap_err();
        assert!(error.contains("full 40-character SHA"), "{error}");
    }

    fn make_test_zip(plugin_json: &str, wasm_bytes: &[u8]) -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let cursor = Cursor::new(&mut buf);
            let mut writer = zip::ZipWriter::new(cursor);
            let options: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            writer.start_file("plugin.json", options).unwrap();
            writer.write_all(plugin_json.as_bytes()).unwrap();
            writer.start_file("main.wasm", options).unwrap();
            writer.write_all(wasm_bytes).unwrap();
            writer.finish().unwrap();
        }
        buf
    }

    #[test]
    fn preview_does_not_create_or_replace_installation() {
        let manifest = r#"{"id":"demo.wasm","type":"wasm","wasmMain":"main.wasm","wasm":{"apiVersion":"0.1.0"}}"#;
        let bundle = make_test_zip(manifest, b"new");
        let root = tempfile::tempdir().unwrap();
        let absent = root.path().join("absent");
        let result =
            install_downloaded_wasm_bundle(&absent, &bundle, None, true, None, None).unwrap();
        assert_eq!(
            result.bundle_sha256.as_deref(),
            Some(sha256_hex(&bundle).as_str())
        );
        assert!(!absent.exists(), "preview must not create install root");
        let existing = root.path().join("demo.wasm");
        std::fs::create_dir(&existing).unwrap();
        std::fs::write(existing.join("main.wasm"), b"old").unwrap();
        install_downloaded_wasm_bundle(root.path(), &bundle, None, true, None, None).unwrap();
        assert_eq!(std::fs::read(existing.join("main.wasm")).unwrap(), b"old");
    }

    #[test]
    fn confirmed_bundle_digest_must_match_before_replacement() {
        let manifest = r#"{"id":"demo.wasm","type":"wasm","wasmMain":"main.wasm","wasm":{"apiVersion":"0.1.0"}}"#;
        let bundle = make_test_zip(manifest, b"changed after preview");
        let root = tempfile::tempdir().unwrap();
        let error = install_downloaded_wasm_bundle(
            root.path(),
            &bundle,
            None,
            false,
            Some(&sha256_hex(b"preview")),
            None,
        )
        .unwrap_err();
        assert!(error.contains("changed since preview"), "{error}");
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
    }

    #[test]
    fn verified_signer_cannot_claim_another_author_key() {
        let signer = SigningKey::from_bytes(&[7; 32]);
        let other = SigningKey::from_bytes(&[9; 32]);
        let key = b64().encode(signer.verifying_key().as_bytes());
        let manifest = serde_json::json!({"id":"demo.wasm","type":"wasm","wasmMain":"main.wasm","wasm":{"apiVersion":"0.1.0"},"author":{"publicKey":b64().encode(other.verifying_key().as_bytes())}});
        let bundle = make_test_zip(&manifest.to_string(), b"wasm");
        verify_detached(
            &bundle,
            &b64().encode(signer.sign(&bundle).to_bytes()),
            &key,
        )
        .unwrap();
        let root = tempfile::tempdir().unwrap();
        let error =
            install_downloaded_wasm_bundle(root.path(), &bundle, Some(&key), false, None, None)
                .unwrap_err();
        assert!(error.contains("verified signer"), "{error}");
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
    }

    #[test]
    fn verified_signer_metadata_does_not_require_manifest_author() {
        let signer = SigningKey::from_bytes(&[7; 32]);
        let key = b64().encode(signer.verifying_key().as_bytes());
        let manifest = r#"{"id":"demo.wasm","type":"wasm","wasmMain":"main.wasm","wasm":{"apiVersion":"0.1.0"}}"#;
        let bundle = make_test_zip(manifest, b"wasm");
        let root = tempfile::tempdir().unwrap();
        let result =
            install_downloaded_wasm_bundle(root.path(), &bundle, Some(&key), true, None, None)
                .unwrap();
        assert_eq!(result.author_public_key.as_deref(), Some(key.as_str()));
        assert_eq!(
            result.author_fingerprint,
            Some(sha256_hex(signer.verifying_key().as_bytes()))
        );
    }

    #[test]
    fn deferred_signed_archive_stages_receipt_and_preserves_old_until_commit() {
        let root = tempfile::tempdir().unwrap();
        let state = crate::PluginRuntimeState::new(root.path().to_path_buf());
        let old = root.path().join("demo.wasm");
        std::fs::create_dir(&old).unwrap();
        std::fs::write(old.join("main.wasm"), b"old").unwrap();
        let signer = SigningKey::from_bytes(&[7; 32]);
        let key = b64().encode(signer.verifying_key().as_bytes());
        let manifest = r#"{"id":"demo.wasm","version":"1.0.0","type":"wasm","wasmMain":"main.wasm","wasm":{"apiVersion":"0.1.0"}}"#;
        let bytes = make_test_zip(manifest, b"new");
        let result = install_downloaded_wasm_bundle(
            root.path(),
            &bytes,
            Some(&key),
            false,
            Some(&sha256_hex(&bytes)),
            Some(&state.plugin_state_dir),
        )
        .unwrap();
        let transaction = result.transaction_id.unwrap();
        assert_eq!(std::fs::read(old.join("main.wasm")).unwrap(), b"old");
        crate::marketplace::commit_staged_update_for_state(&state, "demo.wasm", &transaction)
            .unwrap();
        let receipt = crate::marketplace::read_verification_receipt(&state, "demo.wasm").unwrap();
        assert_eq!(receipt.verified_via, "signature");
        assert_eq!(receipt.version, "1.0.0");
        crate::marketplace::discard_staged_update_for_state(&state, "demo.wasm", &transaction)
            .unwrap();
        assert_eq!(std::fs::read(old.join("main.wasm")).unwrap(), b"old");
    }

    // The local-file source: `plugin_wasm_install_from_file` only adds "read the
    // bytes" in front of the shared install path, so these pin the reading half
    // and that the bytes it produces really do install.

    #[test]
    fn local_bundle_reads_and_installs_through_the_shared_path() {
        let manifest = r#"{"id":"demo.wasm","type":"wasm","wasmMain":"main.wasm","wasm":{"apiVersion":"0.1.0"}}"#;
        let source = tempfile::tempdir().unwrap();
        let bundle_path = source.path().join("demo.zip");
        std::fs::write(&bundle_path, make_test_zip(manifest, &[0, 1, 2, 3])).unwrap();

        let bytes = read_bundle_file_limited(&bundle_path, 1024 * 1024).unwrap();
        let install_root = tempfile::tempdir().unwrap();
        let result =
            install_downloaded_wasm_bundle(install_root.path(), &bytes, None, false, None, None)
                .unwrap();

        assert_eq!(result.manifest["id"], "demo.wasm");
        assert!(!result.signature_verified);
        assert!(install_root
            .path()
            .join("demo.wasm")
            .join("main.wasm")
            .exists());
    }

    fn frontend_test_zip(entry: &str) -> Vec<u8> {
        use std::io::Write;
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default();
        writer.start_file("plugin.json", options).unwrap();
        writer.write_all(serde_json::json!({"id":"demo.frontend", "version":"1.0.0", "type":"frontend", "main":entry, "author":"Cognia"}).to_string().as_bytes()).unwrap();
        writer
            .start_file(entry, options.unix_permissions(0o755))
            .unwrap();
        writer
            .write_all(b"module.exports = { activate() {} };")
            .unwrap();
        writer.start_file("assets/icon.png", options).unwrap();
        writer.write_all(b"image").unwrap();
        writer.finish().unwrap().into_inner()
    }

    #[test]
    fn frontend_zip_uses_verified_staged_install_and_preserves_assets() {
        let root = tempfile::tempdir().unwrap();
        let state = PluginRuntimeState::new(root.path().to_path_buf());
        let existing = state.plugin_dir("demo.frontend");
        std::fs::create_dir_all(&existing).unwrap();
        std::fs::write(existing.join("index.js"), "old").unwrap();
        let bytes = frontend_test_zip("dist/index.js");
        let preview = install_downloaded_plugin_bundle(
            &state.plugin_install_dir,
            &bytes,
            None,
            true,
            None,
            None,
            false,
        )
        .unwrap();
        assert!(preview.transaction_id.is_none());
        assert_eq!(preview.manifest["author"], "Cognia");
        let result = install_downloaded_plugin_bundle(
            &state.plugin_install_dir,
            &bytes,
            None,
            false,
            preview.bundle_sha256.as_deref(),
            Some(&state.plugin_state_dir),
            false,
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(existing.join("index.js")).unwrap(),
            "old"
        );
        let transaction = result.transaction_id.unwrap();
        crate::marketplace::commit_staged_update_for_state(&state, "demo.frontend", &transaction)
            .unwrap();
        assert!(existing.join("dist/index.js").is_file());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(existing.join("dist/index.js"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o755
            );
        }
        assert_eq!(
            std::fs::read(existing.join("assets/icon.png")).unwrap(),
            b"image"
        );
        crate::marketplace::discard_staged_update_for_state(&state, "demo.frontend", &transaction)
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(existing.join("index.js")).unwrap(),
            "old"
        );
    }

    #[test]
    fn frontend_zip_rejects_uncompiled_source_and_wasm_endpoint_remains_strict() {
        let root = tempfile::tempdir().unwrap();
        let error = install_downloaded_plugin_bundle(
            root.path(),
            &frontend_test_zip("src/index.ts"),
            None,
            false,
            None,
            None,
            false,
        )
        .unwrap_err();
        assert!(error.contains("compiled distribution"), "{error}");
        assert!(!root.path().join("demo.frontend").exists());
        assert!(install_downloaded_wasm_bundle(
            root.path(),
            &frontend_test_zip("index.js"),
            None,
            false,
            None,
            None
        )
        .unwrap_err()
        .contains("wasm"));
    }

    #[test]
    fn local_directory_stages_without_overwriting_and_drops_authored_receipts() {
        let root = tempfile::tempdir().unwrap();
        let state = PluginRuntimeState::new(root.path().to_path_buf());
        let source = tempfile::tempdir().unwrap();
        extract_zip_bundle(&frontend_test_zip("dist/index.js"), source.path()).unwrap();
        std::fs::write(
            source
                .path()
                .join(crate::marketplace::VERIFICATION_RECEIPT_FILE),
            "forged",
        )
        .unwrap();
        let result = stage_plugin_directory(
            &state.plugin_install_dir,
            &state.plugin_state_dir,
            source.path(),
        )
        .unwrap();
        assert_eq!(result.source, "local");
        assert!(!state.plugin_dir("demo.frontend").exists());
        let transaction = result.transaction_id.unwrap();
        crate::marketplace::commit_staged_update_for_state(&state, "demo.frontend", &transaction)
            .unwrap();
        assert!(state
            .plugin_dir("demo.frontend")
            .join("dist/index.js")
            .is_file());
        assert!(!state
            .plugin_dir("demo.frontend")
            .join(crate::marketplace::VERIFICATION_RECEIPT_FILE)
            .exists());
        crate::marketplace::discard_staged_update_for_state(&state, "demo.frontend", &transaction)
            .unwrap();
    }

    #[test]
    fn local_bundle_size_is_refused_from_metadata_before_the_read() {
        // Checked from metadata FIRST on purpose: reading then measuring would
        // allocate the whole file before reporting that it was too large.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.zip");
        std::fs::write(&path, vec![0_u8; 4096]).unwrap();

        let error = read_bundle_file_limited(&path, 1024).unwrap_err();
        assert!(error.contains("4096"), "{error}");
        assert!(error.contains("limit is 1024"), "{error}");
    }

    #[test]
    fn local_bundle_path_must_name_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let error = read_bundle_file_limited(dir.path(), 1024).unwrap_err();
        assert!(error.contains("is not a file"), "{error}");

        let missing = dir.path().join("absent.zip");
        assert!(read_bundle_file_limited(&missing, 1024)
            .unwrap_err()
            .contains("stat"));
    }

    #[test]
    fn extract_zip_unpacks_manifest_and_wasm() {
        let manifest = r#"{"id":"demo.wasm","type":"wasm","wasmMain":"main.wasm","wasm":{"apiVersion":"0.1.0"}}"#;
        let zipped = make_test_zip(manifest, &[0, 1, 2, 3]);
        let tmp = tempfile::tempdir().unwrap();
        let manifest_path = extract_zip_bundle(&zipped, tmp.path()).unwrap();
        assert!(manifest_path.exists());
        assert!(tmp.path().join("main.wasm").exists());
        let (raw, parsed) = read_manifest(&manifest_path).unwrap();
        assert_wasm_manifest(&parsed).unwrap();
        assert_eq!(raw["id"], "demo.wasm");
    }

    #[test]
    fn root_manifest_wins_over_nested_plugin_resource_manifests() {
        use std::io::Write;
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default();
        for (name, content) in [
            ("plugin.json", "root"),
            ("assets/vendor/plugin.json", "nested"),
        ] {
            writer.start_file(name, options).unwrap();
            writer.write_all(content.as_bytes()).unwrap();
        }
        let bytes = writer.finish().unwrap().into_inner();
        let root = tempfile::tempdir().unwrap();
        assert_eq!(
            extract_zip_bundle(&bytes, root.path()).unwrap(),
            root.path().join("plugin.json")
        );
    }

    #[test]
    fn extract_zip_enforces_entry_and_cumulative_byte_limits() {
        let manifest = r#"{"id":"demo.wasm","type":"wasm","wasmMain":"main.wasm","wasm":{"apiVersion":"0.1.0"}}"#;
        let zipped = make_test_zip(manifest, &[0, 1, 2, 3]);
        let tmp = tempfile::tempdir().unwrap();
        assert!(extract_zip_bundle_with_limits(&zipped, tmp.path(), 1, 1024)
            .unwrap_err()
            .contains("2 entries"));

        let tmp = tempfile::tempdir().unwrap();
        let limit = manifest.len() as u64 + 3;
        assert!(
            extract_zip_bundle_with_limits(&zipped, tmp.path(), 2, limit)
                .unwrap_err()
                .contains("extraction limit")
        );
    }

    #[test]
    fn extract_zip_rejects_missing_plugin_json() {
        let mut buf = Vec::new();
        {
            let cursor = Cursor::new(&mut buf);
            let mut writer = zip::ZipWriter::new(cursor);
            writer
                .start_file("main.wasm", zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(b"x").unwrap();
            writer.finish().unwrap();
        }
        let tmp = tempfile::tempdir().unwrap();
        let err = extract_zip_bundle(&buf, tmp.path()).unwrap_err();
        assert!(err.contains("plugin.json"));
    }

    #[test]
    fn downloaded_install_rejects_empty_plugin_id_before_touching_install_root() {
        let manifest =
            r#"{"id":"","type":"wasm","wasmMain":"main.wasm","wasm":{"apiVersion":"0.1.0"}}"#;
        let zipped = make_test_zip(manifest, &[0, 1, 2, 3]);
        let install_root = tempfile::tempdir().unwrap();

        let error =
            install_downloaded_wasm_bundle(install_root.path(), &zipped, None, false, None, None)
                .expect_err("empty id must be rejected");

        assert!(error.contains("plugin id"), "{error}");
        assert_eq!(std::fs::read_dir(install_root.path()).unwrap().count(), 0);
    }

    #[test]
    fn extract_zip_rejects_symlink_entries() {
        let mut buf = Vec::new();
        {
            let cursor = Cursor::new(&mut buf);
            let mut writer = zip::ZipWriter::new(cursor);
            writer
                .add_symlink(
                    "link.wasm",
                    "../../outside.wasm",
                    zip::write::SimpleFileOptions::default(),
                )
                .unwrap();
            writer.finish().unwrap();
        }
        let tmp = tempfile::tempdir().unwrap();
        let error = extract_zip_bundle(&buf, tmp.path()).unwrap_err();
        assert!(error.contains("symbolic-link"));
    }

    #[test]
    fn assert_wasm_manifest_rejects_non_wasm() {
        let parsed = PartialManifest {
            id: "x".into(),
            plugin_type: Some("frontend".into()),
            wasm_main: None,
            author: None,
            wasm: None,
        };
        assert!(assert_wasm_manifest(&parsed).is_err());
    }

    #[test]
    fn assert_wasm_manifest_requires_wasm_main_and_api_version() {
        let parsed = PartialManifest {
            id: "x".into(),
            plugin_type: Some("wasm".into()),
            wasm_main: None,
            author: None,
            wasm: Some(PartialWasmBlock {
                api_version: "0.1.0".into(),
            }),
        };
        assert!(assert_wasm_manifest(&parsed)
            .unwrap_err()
            .contains("wasmMain"));
        let parsed = PartialManifest {
            id: "x".into(),
            plugin_type: Some("wasm".into()),
            wasm_main: Some("main.wasm".into()),
            author: None,
            wasm: None,
        };
        assert!(assert_wasm_manifest(&parsed)
            .unwrap_err()
            .contains("apiVersion"));

        let parsed = PartialManifest {
            id: "x".into(),
            plugin_type: Some("wasm".into()),
            wasm_main: Some("../outside.wasm".into()),
            author: None,
            wasm: Some(PartialWasmBlock {
                api_version: "0.1.0".into(),
            }),
        };
        assert!(assert_wasm_manifest(&parsed)
            .unwrap_err()
            .contains("unsafe wasmMain"));
    }

    #[test]
    fn verify_detached_round_trip() {
        let mut seed = [0u8; 32];
        for (i, b) in seed.iter_mut().enumerate() {
            *b = i as u8;
        }
        let sk = SigningKey::from_bytes(&seed);
        let vk: VerifyingKey = (&sk).into();
        let pk_b64 = b64().encode(vk.to_bytes());

        let payload = b"-- bundle --";
        let sig: Signature = sk.sign(payload);
        let sig_b64 = b64().encode(sig.to_bytes());

        verify_detached(payload, &sig_b64, &pk_b64).expect("verifies");
        let err = verify_detached(b"-- tampered --", &sig_b64, &pk_b64).unwrap_err();
        assert!(err.contains("signature verification failed"));
    }

    #[test]
    fn find_wasm_artifact_finds_release_output() {
        let tmp = tempfile::tempdir().unwrap();
        let release = tmp
            .path()
            .join("target")
            .join("wasm32-wasip2")
            .join("release");
        std::fs::create_dir_all(&release).unwrap();
        std::fs::write(release.join("demo.wasm"), b"fake").unwrap();
        let found = find_wasm_artifact(tmp.path(), "demo.wasm").unwrap();
        assert!(found.ends_with("demo.wasm"));
    }

    #[test]
    fn find_plugin_manifest_supports_root_and_nested() {
        let tmp = tempfile::tempdir().unwrap();
        // Root case.
        let root_manifest = tmp.path().join("plugin.json");
        std::fs::write(&root_manifest, "{}").unwrap();
        assert_eq!(find_plugin_manifest(tmp.path()), Some(root_manifest));

        // Nested case (remove root, add nested dir).
        std::fs::remove_file(tmp.path().join("plugin.json")).unwrap();
        let nested = tmp.path().join("manifest");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("plugin.json"), "{}").unwrap();
        let found = find_plugin_manifest(tmp.path()).unwrap();
        assert!(found.ends_with("plugin.json"));
        assert!(found.to_string_lossy().contains("manifest"));
    }

    #[test]
    fn atomic_install_copies_the_complete_validated_plugin_root() {
        let source = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(source.path().join("styles")).unwrap();
        std::fs::write(source.path().join("plugin.json"), "{}").unwrap();
        std::fs::write(source.path().join("main.wasm"), b"wasm").unwrap();
        std::fs::write(source.path().join("styles/theme.css"), "body{}").unwrap();
        let destination_parent = tempfile::tempdir().unwrap();
        let destination = destination_parent.path().join("demo");
        let manifest = serde_json::json!({
            "type": "wasm",
            "wasmMain": "main.wasm",
            "styles": "styles/theme.css"
        });

        atomically_install_tree(source.path(), &destination, &manifest).unwrap();

        assert_eq!(
            std::fs::read(destination.join("main.wasm")).unwrap(),
            b"wasm"
        );
        assert_eq!(
            std::fs::read_to_string(destination.join("styles/theme.css")).unwrap(),
            "body{}"
        );
    }

    #[test]
    fn failed_atomic_install_preserves_the_previous_version() {
        let source = tempfile::tempdir().unwrap();
        std::fs::write(source.path().join("plugin.json"), "{}").unwrap();
        let destination_parent = tempfile::tempdir().unwrap();
        let destination = destination_parent.path().join("demo");
        std::fs::create_dir(&destination).unwrap();
        std::fs::write(destination.join("version.txt"), "old").unwrap();
        let manifest = serde_json::json!({ "type": "wasm", "wasmMain": "missing.wasm" });

        assert!(atomically_install_tree(source.path(), &destination, &manifest).is_err());
        assert_eq!(
            std::fs::read_to_string(destination.join("version.txt")).unwrap(),
            "old"
        );
    }

    #[cfg(unix)]
    #[test]
    fn recursive_copy_rejects_source_symlinks() {
        let source = tempfile::tempdir().unwrap();
        let destination = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink("/etc/passwd", source.path().join("main.wasm")).unwrap();

        assert!(copy_dir_recursive(source.path(), destination.path(), &[])
            .unwrap_err()
            .contains("symbolic link"));
    }
}

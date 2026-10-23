//! Plugins a paired device carries to an always-on host (ADR-0224 §Moving an
//! item is a handoff, ADR-0209 cogpacks).
//!
//! The device exports the plugins an item needs as one signed cogpack and
//! uploads it in chunks small enough for the device plane's JSON body limit.
//! They are staged on disk here, under the plugin state directory, owned by the
//! device that opened the upload.
//!
//! Trust is decided in TypeScript on the host: it verifies the manifest's
//! signature and applies the host's own plugin policy and trusted-publisher
//! ledger, exactly as importing a cogpack by hand would. It then asks this
//! module to install members, naming the SHA-256 of the canonical manifest it
//! verified. Here the staged archive's `manifest.json` must hash to exactly
//! that, every embedded file must match the record the manifest declares for
//! it, and nothing undeclared may be in the archive. The files installed are
//! therefore the files the signature covers, and none other.

use std::{
    collections::HashMap,
    fs::{File, OpenOptions},
    io::{Cursor, Read, Seek, SeekFrom, Write},
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::Utc;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[cfg(feature = "tauri-host")]
use tauri::State;

use crate::{PluginRecord, PluginRuntimeSnapshot, PluginRuntimeState};

/// Matches `COGPACK_LIMITS.maxCompressedBytes` in `lib/plugin/cogpack/package.ts`.
pub const MAX_TRANSFER_BYTES: u64 = 100 * 1024 * 1024;
/// A chunk's base64 must fit the device plane's 64 KiB JSON body with room to spare.
pub const MAX_CHUNK_BYTES: usize = 32 * 1024;
/// Matches `COGPACK_LIMITS.maxExpandedBytes`.
const MAX_EXPANDED_BYTES: u64 = crate::plugin_tree::MAX_EXPORT_BYTES;
/// A canonical cogpack manifest is small; this bounds what is read before hashing.
const MAX_MANIFEST_BYTES: u64 = 4 * 1024 * 1024;
const MAX_ACTIVE_UPLOADS: usize = 8;
const UPLOAD_TTL: Duration = Duration::from_secs(30 * 60);
const UPLOAD_DIR: &str = ".cogpack-uploads";
const MANIFEST_PATH: &str = "manifest.json";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CogpackUploadHandle {
    pub upload_id: String,
    pub chunk_bytes: usize,
}

#[derive(Debug)]
struct Upload {
    path: PathBuf,
    owner: String,
    expected_size: u64,
    expected_hash: String,
    written: u64,
    created_at: Instant,
}

/// Staged cogpack uploads under one plugin state directory.
#[derive(Debug)]
pub struct CogpackUploadService {
    root: PathBuf,
    uploads: Mutex<HashMap<String, Upload>>,
}

impl CogpackUploadService {
    /// Open the staging directory, removing anything a previous process left.
    pub fn new(root: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&root)
            .map_err(|error| format!("create cogpack upload root {}: {error}", root.display()))?;
        for entry in std::fs::read_dir(&root)
            .map_err(|error| format!("read cogpack upload root {}: {error}", root.display()))?
            .flatten()
        {
            let path = entry.path();
            if path
                .extension()
                .is_some_and(|extension| extension == "upload")
            {
                let _ = std::fs::remove_file(path);
            }
        }
        Ok(Self {
            root,
            uploads: Mutex::new(HashMap::new()),
        })
    }

    pub fn open(
        &self,
        owner: &str,
        expected_size: u64,
        expected_hash: &str,
    ) -> Result<CogpackUploadHandle, String> {
        if expected_size == 0 || expected_size > MAX_TRANSFER_BYTES {
            return Err(format!(
                "cogpack_upload_invalid: size must be between 1 and {MAX_TRANSFER_BYTES} bytes"
            ));
        }
        validate_sha256(expected_hash)?;
        let mut uploads = self.uploads.lock();
        expire(&mut uploads);
        if uploads.len() >= MAX_ACTIVE_UPLOADS {
            return Err(format!(
                "cogpack_upload_busy: at most {MAX_ACTIVE_UPLOADS} uploads at once"
            ));
        }
        let upload_id = uuid::Uuid::new_v4().to_string();
        let path = self.root.join(format!("{upload_id}.upload"));
        File::create(&path)
            .map_err(|error| format!("create cogpack upload {}: {error}", path.display()))?;
        uploads.insert(
            upload_id.clone(),
            Upload {
                path,
                owner: owner.to_owned(),
                expected_size,
                expected_hash: expected_hash.to_ascii_lowercase(),
                written: 0,
                created_at: Instant::now(),
            },
        );
        Ok(CogpackUploadHandle {
            upload_id,
            chunk_bytes: MAX_CHUNK_BYTES,
        })
    }

    /// Append one chunk at `offset`, which must be where the last one ended.
    pub fn write_chunk(
        &self,
        owner: &str,
        upload_id: &str,
        offset: u64,
        data_base64: &str,
        chunk_hash: &str,
    ) -> Result<u64, String> {
        validate_sha256(chunk_hash)?;
        if data_base64.len() > MAX_CHUNK_BYTES.div_ceil(3) * 4 {
            return Err(format!(
                "cogpack_upload_invalid: a chunk carries at most {MAX_CHUNK_BYTES} bytes"
            ));
        }
        let data = BASE64
            .decode(data_base64)
            .map_err(|error| format!("cogpack_upload_invalid: chunk is not base64: {error}"))?;
        if data.is_empty() || data.len() > MAX_CHUNK_BYTES {
            return Err(format!(
                "cogpack_upload_invalid: a chunk carries 1 to {MAX_CHUNK_BYTES} bytes"
            ));
        }
        if sha256_hex(&data) != chunk_hash.to_ascii_lowercase() {
            return Err("cogpack_upload_invalid: chunk hash mismatch".into());
        }
        let mut uploads = self.uploads.lock();
        expire(&mut uploads);
        let upload = owned(&mut uploads, owner, upload_id)?;
        if upload.written != offset {
            return Err(format!(
                "cogpack_upload_invalid: expected offset {}, got {offset}",
                upload.written
            ));
        }
        let next = offset + data.len() as u64;
        if next > upload.expected_size {
            return Err("cogpack_upload_invalid: more bytes than declared".into());
        }
        OpenOptions::new()
            .write(true)
            .open(&upload.path)
            .and_then(|mut file| {
                file.seek(SeekFrom::Start(offset))?;
                file.write_all(&data)?;
                file.sync_data()
            })
            .map_err(|error| format!("write cogpack upload {}: {error}", upload.path.display()))?;
        upload.written = next;
        Ok(next)
    }

    /// Check `owner` uploaded every declared byte, without consuming it.
    pub fn require_complete(&self, owner: &str, upload_id: &str) -> Result<(), String> {
        let mut uploads = self.uploads.lock();
        expire(&mut uploads);
        let upload = owned(&mut uploads, owner, upload_id)?;
        if upload.written != upload.expected_size {
            return Err(format!(
                "cogpack_upload_incomplete: {} of {} bytes",
                upload.written, upload.expected_size
            ));
        }
        Ok(())
    }

    pub fn abort(&self, owner: &str, upload_id: &str) -> Result<(), String> {
        let mut uploads = self.uploads.lock();
        expire(&mut uploads);
        owned(&mut uploads, owner, upload_id)?;
        if let Some(upload) = uploads.remove(upload_id) {
            let _ = std::fs::remove_file(upload.path);
        }
        Ok(())
    }

    /// The complete upload's bytes, checked against the declared hash. The
    /// upload is gone afterwards whether or not the bytes are good.
    pub fn take(&self, upload_id: &str) -> Result<Vec<u8>, String> {
        let upload = {
            let mut uploads = self.uploads.lock();
            expire(&mut uploads);
            uploads
                .remove(upload_id)
                .ok_or_else(|| "cogpack_upload_unknown: no such upload".to_string())?
        };
        let bytes = std::fs::read(&upload.path);
        let _ = std::fs::remove_file(&upload.path);
        let bytes = bytes
            .map_err(|error| format!("read cogpack upload {}: {error}", upload.path.display()))?;
        if bytes.len() as u64 != upload.expected_size {
            return Err(format!(
                "cogpack_upload_incomplete: {} of {} bytes",
                bytes.len(),
                upload.expected_size
            ));
        }
        if sha256_hex(&bytes) != upload.expected_hash {
            return Err(
                "cogpack_upload_invalid: the upload does not match its declared hash".into(),
            );
        }
        Ok(bytes)
    }
}

fn owned<'a>(
    uploads: &'a mut HashMap<String, Upload>,
    owner: &str,
    upload_id: &str,
) -> Result<&'a mut Upload, String> {
    match uploads.get_mut(upload_id) {
        Some(upload) if upload.owner == owner => Ok(upload),
        Some(_) => Err("REMOTE_SCOPE_DENIED: the upload belongs to another device".into()),
        None => Err("cogpack_upload_unknown: no such upload".into()),
    }
}

fn expire(uploads: &mut HashMap<String, Upload>) {
    uploads.retain(|_, upload| {
        let live = upload.created_at.elapsed() <= UPLOAD_TTL;
        if !live {
            let _ = std::fs::remove_file(&upload.path);
        }
        live
    });
}

fn validate_sha256(value: &str) -> Result<(), String> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("cogpack_upload_invalid: expected a SHA-256 hex digest".into());
    }
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

static SERVICES: Lazy<Mutex<HashMap<PathBuf, Arc<CogpackUploadService>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// The upload service of one host's plugin state directory.
pub fn upload_service(state: &PluginRuntimeState) -> Result<Arc<CogpackUploadService>, String> {
    let root = state.plugin_state_dir.join(UPLOAD_DIR);
    let mut services = SERVICES.lock();
    if let Some(service) = services.get(&root) {
        return Ok(Arc::clone(service));
    }
    let service = Arc::new(CogpackUploadService::new(root.clone())?);
    services.insert(root, Arc::clone(&service));
    Ok(service)
}

/// One member the host's review accepted, pinned to the version it reviewed.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TransferMember {
    pub id: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstalledTransferMember {
    pub plugin_id: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FailedTransferMember {
    pub plugin_id: String,
    pub message: String,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TransferInstallOutcome {
    /// SHA-256 of the cogpack file, the fingerprint its install origins record.
    pub fingerprint: String,
    pub installed: Vec<InstalledTransferMember>,
    pub failed: Vec<FailedTransferMember>,
}

/// What the manifest declares for one embedded member.
struct DeclaredMember {
    version: String,
    root: String,
    files: Vec<(String, String)>,
}

fn manifest_error(message: impl Into<String>) -> String {
    format!("cogpack_manifest_invalid: {}", message.into())
}

/// Read the parts of a verified manifest the install relies on.
fn declared_members(
    manifest: &serde_json::Value,
) -> Result<HashMap<String, DeclaredMember>, String> {
    let members = manifest
        .get("members")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| manifest_error("members is missing"))?;
    let mut declared = HashMap::new();
    for member in members {
        let id = member
            .get("id")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| manifest_error("a member has no id"))?;
        let version = member
            .get("version")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| manifest_error(format!("{id} has no version")))?;
        let source = member
            .get("source")
            .ok_or_else(|| manifest_error(format!("{id} has no source")))?;
        if source.get("kind").and_then(serde_json::Value::as_str) != Some("embedded") {
            // Only embedded members carry files; the others are not installed here.
            continue;
        }
        let root = format!("plugins/{id}");
        if source.get("root").and_then(serde_json::Value::as_str) != Some(root.as_str()) {
            return Err(manifest_error(format!("{id} is not rooted at {root}")));
        }
        let mut files = Vec::new();
        for file in source
            .get("files")
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| manifest_error(format!("{id} lists no files")))?
        {
            let path = file
                .get("path")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| manifest_error(format!("{id} has a file with no path")))?;
            let sha256 = file
                .get("sha256")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| manifest_error(format!("{path} has no sha256")))?;
            if !path.starts_with(&format!("{root}/")) {
                return Err(manifest_error(format!("{path} is outside {root}")));
            }
            files.push((path.to_owned(), sha256.to_ascii_lowercase()));
        }
        declared.insert(
            id.to_owned(),
            DeclaredMember {
                version: version.to_owned(),
                root,
                files,
            },
        );
    }
    Ok(declared)
}

fn read_entry<R: Read + Seek>(
    archive: &mut zip::ZipArchive<R>,
    name: &str,
    limit: u64,
    total: &mut u64,
) -> Result<Vec<u8>, String> {
    let mut entry = archive
        .by_name(name)
        .map_err(|_| format!("cogpack_archive_invalid: {name} is declared but missing"))?;
    let mut bytes = Vec::new();
    crate::archive_limits::copy_with_budget(&mut entry, &mut bytes, total, limit, name)
        .map_err(|error| format!("cogpack_archive_invalid: {error}"))?;
    Ok(bytes)
}

/// Install `members` from a cogpack archive whose manifest the host verified.
///
/// Archive-level failures (wrong manifest, undeclared or tampered files)
/// install nothing. A member whose own install fails is reported and the
/// others still install, since each is an independent plugin directory.
pub fn install_transfer(
    state: &PluginRuntimeState,
    bytes: &[u8],
    manifest_sha256: &str,
    members: &[TransferMember],
) -> Result<TransferInstallOutcome, String> {
    validate_sha256(manifest_sha256)?;
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|error| format!("cogpack_archive_invalid: {error}"))?;
    if archive.len() > crate::plugin_tree::MAX_EXPORT_FILES + 1 {
        return Err("cogpack_archive_invalid: too many entries".into());
    }

    let mut manifest_budget = 0u64;
    let manifest_bytes = read_entry(
        &mut archive,
        MANIFEST_PATH,
        MAX_MANIFEST_BYTES,
        &mut manifest_budget,
    )?;
    if sha256_hex(&manifest_bytes) != manifest_sha256.to_ascii_lowercase() {
        return Err(
            "cogpack_manifest_mismatch: the archive's manifest is not the one the host verified"
                .into(),
        );
    }
    let manifest: serde_json::Value = serde_json::from_slice(&manifest_bytes)
        .map_err(|error| manifest_error(error.to_string()))?;
    let declared = declared_members(&manifest)?;

    // Nothing the signature does not cover may ride along.
    let mut known: std::collections::HashSet<&str> = std::collections::HashSet::new();
    known.insert(MANIFEST_PATH);
    for member in declared.values() {
        known.extend(member.files.iter().map(|(path, _)| path.as_str()));
    }
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| format!("cogpack_archive_invalid: {error}"))?;
        let entry_name = entry
            .name()
            .map_err(|error| format!("cogpack_archive_invalid: entry name: {error}"))?;
        if entry.enclosed_name().is_none()
            || entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(format!(
                "cogpack_archive_invalid: unsafe entry {}",
                entry_name
            ));
        }
        if entry.is_dir() {
            continue;
        }
        if !known.contains(entry_name.as_ref()) {
            return Err(format!(
                "cogpack_archive_invalid: {} is not declared by the manifest",
                entry_name
            ));
        }
    }

    // Read and check every requested member before any of them installs.
    let mut expanded = manifest_budget;
    let mut trees = Vec::with_capacity(members.len());
    for member in members {
        let entry = declared.get(&member.id).ok_or_else(|| {
            format!(
                "cogpack_member_missing: {} is not embedded in the cogpack",
                member.id
            )
        })?;
        if entry.version != member.version {
            return Err(format!(
                "cogpack_member_missing: the cogpack carries {} {}, not {}",
                member.id, entry.version, member.version
            ));
        }
        let mut files = Vec::with_capacity(entry.files.len());
        for (path, sha256) in &entry.files {
            let file = read_entry(&mut archive, path, MAX_EXPANDED_BYTES, &mut expanded)?;
            if &sha256_hex(&file) != sha256 {
                return Err(format!(
                    "cogpack_archive_invalid: {path} does not match its record"
                ));
            }
            files.push((path[entry.root.len() + 1..].to_owned(), file));
        }
        trees.push((member, files));
    }

    let mut outcome = TransferInstallOutcome {
        fingerprint: sha256_hex(bytes),
        ..TransferInstallOutcome::default()
    };
    for (member, files) in trees {
        match install_member(state, member, files) {
            Ok(()) => outcome.installed.push(InstalledTransferMember {
                plugin_id: member.id.clone(),
                version: member.version.clone(),
            }),
            Err(message) => outcome.failed.push(FailedTransferMember {
                plugin_id: member.id.clone(),
                message,
            }),
        }
    }
    Ok(outcome)
}

fn install_member(
    state: &PluginRuntimeState,
    member: &TransferMember,
    files: Vec<(String, Vec<u8>)>,
) -> Result<(), String> {
    crate::validate_plugin_id_path_component(&member.id).map_err(|error| error.to_string())?;
    let staging = tempfile::Builder::new()
        .prefix(".cognia-plugin-transfer-")
        .tempdir()
        .map_err(|error| format!("create staging: {error}"))?;
    crate::plugin_tree::materialize_plugin_bytes(files, staging.path())
        .map_err(|error| error.to_string())?;
    let manifest: serde_json::Value = serde_json::from_slice(
        &std::fs::read(staging.path().join("plugin.json"))
            .map_err(|error| format!("read plugin.json: {error}"))?,
    )
    .map_err(|error| format!("invalid plugin.json: {error}"))?;
    let named = |field: &str| manifest.get(field).and_then(serde_json::Value::as_str);
    if named("id") != Some(member.id.as_str()) || named("version") != Some(member.version.as_str())
    {
        return Err(format!(
            "plugin.json names {} {}, not {} {}",
            named("id").unwrap_or("?"),
            named("version").unwrap_or("?"),
            member.id,
            member.version
        ));
    }
    crate::contract::validate_manifest_contract(&manifest)?;
    // A receipt says how THIS host verified an install; one carried along is void.
    crate::marketplace::discard_supplied_receipt(staging.path())
        .map_err(|error| format!("discard supplied receipt: {error}"))?;
    let plugin_dir = state.plugin_dir(&member.id);
    crate::wasm::installer::atomically_install_tree(staging.path(), &plugin_dir, &manifest)?;
    state.plugins.write().insert(
        member.id.clone(),
        PluginRecord {
            snapshot: PluginRuntimeSnapshot {
                plugin_id: member.id.clone(),
                version: member.version.clone(),
                status: "installed".into(),
                last_error: None,
                loaded_at: Some(Utc::now().to_rfc3339()),
                install_path: plugin_dir.to_string_lossy().into_owned(),
            },
            runtime_state: serde_json::Value::Null,
        },
    );
    log::info!(
        "cogpack_transfer installed {} {} from a paired device",
        member.id,
        member.version
    );
    Ok(())
}

/// Host-neutral entry: take the staged upload and install `members` from it.
pub async fn install_staged_for_state(
    state: &PluginRuntimeState,
    upload_id: String,
    manifest_sha256: String,
    members: Vec<TransferMember>,
) -> Result<TransferInstallOutcome, String> {
    let service = upload_service(state)?;
    let bytes = tokio::task::spawn_blocking(move || service.take(&upload_id))
        .await
        .map_err(|error| format!("cogpack transfer task failed: {error}"))??;
    let state = state.clone();
    tokio::task::spawn_blocking(move || {
        install_transfer(&state, &bytes, &manifest_sha256, &members)
    })
    .await
    .map_err(|error| format!("cogpack transfer task failed: {error}"))?
}

/// The desktop host's renderer installs a transfer it accepted through this.
#[cfg(feature = "tauri-host")]
#[tauri::command]
pub async fn plugin_cogpack_install_staged(
    state: State<'_, PluginRuntimeState>,
    upload_id: String,
    manifest_sha256: String,
    members: Vec<TransferMember>,
) -> Result<TransferInstallOutcome, String> {
    install_staged_for_state(state.inner(), upload_id, manifest_sha256, members).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn digest(bytes: &[u8]) -> String {
        sha256_hex(bytes)
    }

    fn upload_all(service: &CogpackUploadService, owner: &str, bytes: &[u8]) -> String {
        let handle = service
            .open(owner, bytes.len() as u64, &digest(bytes))
            .unwrap();
        let mut offset = 0;
        for chunk in bytes.chunks(handle.chunk_bytes) {
            offset = service
                .write_chunk(
                    owner,
                    &handle.upload_id,
                    offset,
                    &BASE64.encode(chunk),
                    &digest(chunk),
                )
                .unwrap();
        }
        handle.upload_id
    }

    #[test]
    fn stages_a_cogpack_larger_than_one_device_plane_body_in_checked_chunks() {
        let temp = tempfile::tempdir().unwrap();
        let service = CogpackUploadService::new(temp.path().to_path_buf()).unwrap();
        let bytes: Vec<u8> = (0..(MAX_CHUNK_BYTES * 3 + 7))
            .map(|i| (i % 251) as u8)
            .collect();
        let id = upload_all(&service, "phone", &bytes);
        service.require_complete("phone", &id).unwrap();
        assert_eq!(service.take(&id).unwrap(), bytes);
        assert!(service
            .take(&id)
            .unwrap_err()
            .starts_with("cogpack_upload_unknown"));
    }

    #[test]
    fn refuses_another_device_out_of_order_and_corrupt_chunks() {
        let temp = tempfile::tempdir().unwrap();
        let service = CogpackUploadService::new(temp.path().to_path_buf()).unwrap();
        let bytes = vec![7u8; MAX_CHUNK_BYTES + 1];
        let handle = service
            .open("phone", bytes.len() as u64, &digest(&bytes))
            .unwrap();
        let chunk = &bytes[..MAX_CHUNK_BYTES];
        let write = |owner: &str, offset: u64, hash: &str| {
            service.write_chunk(
                owner,
                &handle.upload_id,
                offset,
                &BASE64.encode(chunk),
                hash,
            )
        };
        assert!(write("laptop", 0, &digest(chunk))
            .unwrap_err()
            .starts_with("REMOTE_SCOPE_DENIED"));
        assert!(write("phone", 1, &digest(chunk))
            .unwrap_err()
            .contains("offset"));
        assert!(write("phone", 0, &"0".repeat(64))
            .unwrap_err()
            .contains("hash mismatch"));
        assert!(service
            .require_complete("phone", &handle.upload_id)
            .unwrap_err()
            .starts_with("cogpack_upload_incomplete"));
        assert!(service.abort("laptop", &handle.upload_id).is_err());
        service.abort("phone", &handle.upload_id).unwrap();
        assert!(std::fs::read_dir(temp.path()).unwrap().next().is_none());
    }

    #[test]
    fn bounds_uploads_and_clears_what_a_previous_process_left() {
        let temp = tempfile::tempdir().unwrap();
        let orphan = temp.path().join("orphan.upload");
        std::fs::write(&orphan, b"partial").unwrap();
        let service = CogpackUploadService::new(temp.path().to_path_buf()).unwrap();
        assert!(!orphan.exists());
        assert!(service.open("phone", 0, &digest(b"")).is_err());
        assert!(service
            .open("phone", MAX_TRANSFER_BYTES + 1, &digest(b""))
            .is_err());
        for _ in 0..MAX_ACTIVE_UPLOADS {
            service.open("phone", 1, &digest(b"x")).unwrap();
        }
        assert!(service
            .open("phone", 1, &digest(b"x"))
            .unwrap_err()
            .starts_with("cogpack_upload_busy"));
    }

    fn plugin_json(id: &str, version: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "id": id,
            "name": "Demo",
            "version": version,
            "description": "demo",
            "type": "frontend",
            "capabilities": [],
            "main": "index.js",
        }))
        .unwrap()
    }

    /// A cogpack as `exportCogpack` writes it: canonical manifest plus files.
    fn cogpack(
        members: &[(&str, &str, Vec<(&str, Vec<u8>)>)],
        extra: &[(&str, &[u8])],
    ) -> (Vec<u8>, String) {
        let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
        let mut manifest_members = Vec::new();
        for (id, version, files) in members {
            let root = format!("plugins/{id}");
            let mut records = Vec::new();
            for (path, bytes) in files {
                let full = format!("{root}/{path}");
                records.push(serde_json::json!({ "path": full, "sha256": digest(bytes), "size": bytes.len() }));
                entries.push((full, bytes.clone()));
            }
            manifest_members.push(serde_json::json!({
                "id": id, "name": id, "version": version, "optional": false,
                "source": { "kind": "embedded", "root": root, "files": records },
            }));
        }
        let manifest = serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 1, "kind": "cognia.cogpack", "id": "transfer", "version": "1.0.0",
            "name": "Transfer", "compatibility": { "minHostVersion": "0.0.0" }, "members": manifest_members,
        }))
        .unwrap();
        let hash = digest(&manifest);
        entries.push((MANIFEST_PATH.into(), manifest));
        for (path, bytes) in extra {
            entries.push(((*path).into(), bytes.to_vec()));
        }
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default();
        for (path, bytes) in entries {
            writer.start_file(path, options).unwrap();
            writer.write_all(&bytes).unwrap();
        }
        (writer.finish().unwrap().into_inner(), hash)
    }

    fn state() -> (tempfile::TempDir, PluginRuntimeState) {
        let dir = tempfile::tempdir().unwrap();
        let state = PluginRuntimeState::new(dir.path().join("plugins"));
        (dir, state)
    }

    fn pin(id: &str, version: &str) -> TransferMember {
        TransferMember {
            id: id.into(),
            version: version.into(),
        }
    }

    #[test]
    fn installs_the_members_the_verified_manifest_declares() {
        let (_dir, state) = state();
        let (bytes, hash) = cogpack(
            &[(
                "acme-demo",
                "1.2.0",
                vec![
                    ("plugin.json", plugin_json("acme-demo", "1.2.0")),
                    ("index.js", b"x".to_vec()),
                ],
            )],
            &[],
        );
        let outcome =
            install_transfer(&state, &bytes, &hash, &[pin("acme-demo", "1.2.0")]).unwrap();
        assert_eq!(outcome.failed, vec![]);
        assert_eq!(outcome.installed[0].plugin_id, "acme-demo");
        assert_eq!(outcome.fingerprint, digest(&bytes));
        assert!(state.plugin_dir("acme-demo").join("index.js").is_file());
        assert_eq!(state.plugins.read()["acme-demo"].snapshot.version, "1.2.0");
    }

    #[test]
    fn installs_nothing_from_an_archive_that_is_not_what_the_host_verified() {
        let (_dir, state) = state();
        let members = [(
            "acme-demo",
            "1.2.0",
            vec![
                ("plugin.json", plugin_json("acme-demo", "1.2.0")),
                ("index.js", b"x".to_vec()),
            ],
        )];
        let (bytes, hash) = cogpack(&members, &[]);
        let wanted = [pin("acme-demo", "1.2.0")];

        let other = "0".repeat(64);
        assert!(install_transfer(&state, &bytes, &other, &wanted)
            .unwrap_err()
            .starts_with("cogpack_manifest_mismatch"));

        let (smuggled, smuggled_hash) = cogpack(&members, &[("plugins/acme-demo/evil.js", b"y")]);
        assert!(install_transfer(&state, &smuggled, &smuggled_hash, &wanted)
            .unwrap_err()
            .contains("not declared"));

        assert!(
            install_transfer(&state, &bytes, &hash, &[pin("acme-demo", "9.9.9")])
                .unwrap_err()
                .starts_with("cogpack_member_missing")
        );
        assert!(!state.plugin_dir("acme-demo").exists());
    }

    #[test]
    fn refuses_a_file_that_does_not_match_its_record() {
        let (_dir, state) = state();
        let (bytes, hash) = cogpack(
            &[(
                "acme-demo",
                "1.2.0",
                vec![("plugin.json", plugin_json("acme-demo", "1.2.0"))],
            )],
            &[],
        );
        // Rewrite the plugin file with different bytes, keeping the manifest.
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let mut manifest = Vec::new();
        archive
            .by_name(MANIFEST_PATH)
            .unwrap()
            .read_to_end(&mut manifest)
            .unwrap();
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default();
        writer.start_file(MANIFEST_PATH, options).unwrap();
        writer.write_all(&manifest).unwrap();
        writer
            .start_file("plugins/acme-demo/plugin.json", options)
            .unwrap();
        writer
            .write_all(&plugin_json("acme-demo", "6.6.6"))
            .unwrap();
        let tampered = writer.finish().unwrap().into_inner();
        assert!(
            install_transfer(&state, &tampered, &hash, &[pin("acme-demo", "1.2.0")])
                .unwrap_err()
                .contains("does not match its record")
        );
    }

    #[test]
    fn reports_a_member_whose_tree_names_another_plugin_and_installs_the_rest() {
        let (_dir, state) = state();
        let (bytes, hash) = cogpack(
            &[
                (
                    "acme-good",
                    "1.0.0",
                    vec![
                        ("plugin.json", plugin_json("acme-good", "1.0.0")),
                        ("index.js", b"x".to_vec()),
                    ],
                ),
                (
                    "acme-bad",
                    "1.0.0",
                    vec![
                        ("plugin.json", plugin_json("acme-other", "1.0.0")),
                        ("index.js", b"x".to_vec()),
                    ],
                ),
            ],
            &[],
        );
        let outcome = install_transfer(
            &state,
            &bytes,
            &hash,
            &[pin("acme-good", "1.0.0"), pin("acme-bad", "1.0.0")],
        )
        .unwrap();
        assert_eq!(outcome.installed.len(), 1);
        assert_eq!(outcome.failed[0].plugin_id, "acme-bad");
        assert!(!state.plugin_dir("acme-other").exists());
    }

    #[test]
    fn discards_a_receipt_the_device_carried_along() {
        let (_dir, state) = state();
        let (bytes, hash) = cogpack(
            &[(
                "acme-demo",
                "1.2.0",
                vec![
                    ("plugin.json", plugin_json("acme-demo", "1.2.0")),
                    (
                        crate::marketplace::VERIFICATION_RECEIPT_FILE,
                        br#"{"verifiedVia":"signature"}"#.to_vec(),
                    ),
                ],
            )],
            &[],
        );
        install_transfer(&state, &bytes, &hash, &[pin("acme-demo", "1.2.0")]).unwrap();
        assert!(!state
            .plugin_dir("acme-demo")
            .join(crate::marketplace::VERIFICATION_RECEIPT_FILE)
            .exists());
    }
}

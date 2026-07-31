use crate::resource::{is_sensitive_resource, media_type_for};
use base64::{engine::general_purpose::STANDARD, Engine};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    time::{Duration, Instant},
};
use uuid::Uuid;

pub const MAX_TRANSFER_CHUNK_BYTES: usize = 24 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadHandle {
    pub handle_id: String,
    pub path: String,
    pub size: u64,
    pub hash: String,
    pub media_type: String,
    pub sensitive: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadHandle {
    pub handle_id: String,
    pub path: String,
    pub expected_size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferChunk {
    pub offset: u64,
    pub next_offset: u64,
    pub data_base64: String,
    pub chunk_hash: String,
    pub eof: bool,
}

struct DownloadState {
    path: PathBuf,
    expires_at: Instant,
    size: u64,
}

struct UploadState {
    root: PathBuf,
    rel_path: String,
    temp_path: PathBuf,
    expected_size: u64,
    expected_hash: String,
    written: u64,
    expires_at: Instant,
}

#[derive(Default)]
struct RegistryState {
    downloads: HashMap<String, DownloadState>,
    uploads: HashMap<String, UploadState>,
}

pub struct TransferRegistry {
    ttl: Duration,
    state: Mutex<RegistryState>,
}

impl TransferRegistry {
    pub fn new(ttl: Duration) -> Self {
        Self {
            ttl: ttl.max(Duration::from_secs(1)),
            state: Mutex::new(RegistryState::default()),
        }
    }

    pub fn open_download(
        &self,
        root: &Path,
        rel_path: &str,
        allow_sensitive: bool,
    ) -> Result<DownloadHandle, String> {
        let sensitive = is_sensitive_resource(rel_path);
        if sensitive && !allow_sensitive {
            return Err(format!(
                "sensitive resource requires authorization: {rel_path}"
            ));
        }
        let path = resolve_existing(root, rel_path)?;
        if !path.is_file() {
            return Err(format!("not a file: {rel_path}"));
        }
        let size = path
            .metadata()
            .map_err(|error| format!("stat {rel_path}: {error}"))?
            .len();
        let hash = hash_file(&path)?;
        let handle_id = Uuid::now_v7().to_string();
        let mut state = self.state.lock();
        sweep(&mut state);
        state.downloads.insert(
            handle_id.clone(),
            DownloadState {
                path,
                expires_at: Instant::now() + self.ttl,
                size,
            },
        );
        Ok(DownloadHandle {
            handle_id,
            path: rel_path.to_string(),
            size,
            hash,
            media_type: media_type_for(rel_path, true).to_string(),
            sensitive,
        })
    }

    pub fn read_chunk(
        &self,
        handle_id: &str,
        offset: u64,
        length: Option<usize>,
    ) -> Result<TransferChunk, String> {
        let mut state = self.state.lock();
        sweep(&mut state);
        let download = state
            .downloads
            .get_mut(handle_id)
            .ok_or_else(|| format!("unknown or expired download handle: {handle_id}"))?;
        if offset > download.size {
            return Err(format!(
                "offset {offset} exceeds download size {}",
                download.size
            ));
        }
        let limit = length
            .unwrap_or(MAX_TRANSFER_CHUNK_BYTES)
            .clamp(1, MAX_TRANSFER_CHUNK_BYTES);
        let available = download.size.saturating_sub(offset).min(limit as u64) as usize;
        let mut file = File::open(&download.path)
            .map_err(|error| format!("open download {}: {error}", download.path.display()))?;
        file.seek(SeekFrom::Start(offset))
            .map_err(|error| format!("seek download: {error}"))?;
        let mut bytes = vec![0_u8; available];
        file.read_exact(&mut bytes)
            .map_err(|error| format!("read download: {error}"))?;
        let next_offset = offset + bytes.len() as u64;
        download.expires_at = Instant::now() + self.ttl;
        Ok(TransferChunk {
            offset,
            next_offset,
            data_base64: STANDARD.encode(&bytes),
            chunk_hash: hash_bytes(&bytes),
            eof: next_offset == download.size,
        })
    }

    pub fn close_download(&self, handle_id: &str) -> Result<(), String> {
        let removed = self.state.lock().downloads.remove(handle_id);
        if removed.is_none() {
            return Err(format!("unknown download handle: {handle_id}"));
        }
        Ok(())
    }

    pub fn open_upload(
        &self,
        root: &Path,
        rel_path: &str,
        expected_size: u64,
        expected_hash: &str,
        allow_sensitive: bool,
    ) -> Result<UploadHandle, String> {
        if is_sensitive_resource(rel_path) && !allow_sensitive {
            return Err(format!(
                "sensitive resource requires authorization: {rel_path}"
            ));
        }
        validate_hash(expected_hash)?;
        let canonical_root = root
            .canonicalize()
            .map_err(|error| format!("canonicalize root {}: {error}", root.display()))?;
        let target = resolve_new(&canonical_root, rel_path)?;
        if target.exists() {
            return Err(format!("upload target already exists: {rel_path}"));
        }
        let handle_id = Uuid::now_v7().to_string();
        let temp_path = canonical_root.join(format!(".cognia-upload-{handle_id}.tmp"));
        File::create(&temp_path)
            .map_err(|error| format!("create upload temp {}: {error}", temp_path.display()))?;
        let mut state = self.state.lock();
        sweep(&mut state);
        state.uploads.insert(
            handle_id.clone(),
            UploadState {
                root: canonical_root,
                rel_path: rel_path.to_string(),
                temp_path,
                expected_size,
                expected_hash: expected_hash.to_ascii_lowercase(),
                written: 0,
                expires_at: Instant::now() + self.ttl,
            },
        );
        Ok(UploadHandle {
            handle_id,
            path: rel_path.to_string(),
            expected_size,
        })
    }

    pub fn write_chunk(
        &self,
        handle_id: &str,
        offset: u64,
        data_base64: &str,
        chunk_hash: &str,
    ) -> Result<u64, String> {
        validate_hash(chunk_hash)?;
        let bytes = STANDARD
            .decode(data_base64)
            .map_err(|error| format!("decode upload chunk: {error}"))?;
        if bytes.len() > MAX_TRANSFER_CHUNK_BYTES {
            return Err(format!(
                "upload chunk exceeds {} bytes",
                MAX_TRANSFER_CHUNK_BYTES
            ));
        }
        if hash_bytes(&bytes) != chunk_hash.to_ascii_lowercase() {
            return Err("upload chunk hash mismatch".into());
        }
        let mut state = self.state.lock();
        sweep(&mut state);
        let upload = state
            .uploads
            .get_mut(handle_id)
            .ok_or_else(|| format!("unknown or expired upload handle: {handle_id}"))?;
        if offset != upload.written {
            return Err(format!(
                "upload offset mismatch: expected {}, received {offset}",
                upload.written
            ));
        }
        if upload.written.saturating_add(bytes.len() as u64) > upload.expected_size {
            return Err("upload exceeds declared size".into());
        }
        let mut file = OpenOptions::new()
            .append(true)
            .open(&upload.temp_path)
            .map_err(|error| format!("open upload temp: {error}"))?;
        file.write_all(&bytes)
            .map_err(|error| format!("write upload chunk: {error}"))?;
        upload.written += bytes.len() as u64;
        upload.expires_at = Instant::now() + self.ttl;
        Ok(upload.written)
    }

    pub fn commit_upload(&self, handle_id: &str) -> Result<String, String> {
        let mut state = self.state.lock();
        sweep(&mut state);
        let upload = state
            .uploads
            .remove(handle_id)
            .ok_or_else(|| format!("unknown or expired upload handle: {handle_id}"))?;
        let result = commit_upload(upload);
        if result.is_err() {
            // `commit_upload` owns the state and cleans its temp file on every failure.
        }
        result
    }

    pub fn abort_upload(&self, handle_id: &str) -> Result<(), String> {
        let upload = self
            .state
            .lock()
            .uploads
            .remove(handle_id)
            .ok_or_else(|| format!("unknown upload handle: {handle_id}"))?;
        fs::remove_file(&upload.temp_path).map_err(|error| format!("remove upload temp: {error}"))
    }
}

fn commit_upload(upload: UploadState) -> Result<String, String> {
    let fail = |message: String| {
        let _ = fs::remove_file(&upload.temp_path);
        Err(message)
    };
    if upload.written != upload.expected_size {
        return fail(format!(
            "upload size mismatch: expected {}, received {}",
            upload.expected_size, upload.written
        ));
    }
    let actual_hash = match hash_file(&upload.temp_path) {
        Ok(hash) => hash,
        Err(error) => return fail(error),
    };
    if actual_hash != upload.expected_hash {
        return fail("upload file hash mismatch".into());
    }
    let target = match resolve_new(&upload.root, &upload.rel_path) {
        Ok(target) => target,
        Err(error) => return fail(error),
    };
    if target.exists() {
        return fail(format!("upload target already exists: {}", upload.rel_path));
    }
    let parent = match target.parent() {
        Some(parent) => parent,
        None => return fail(format!("invalid upload path: {}", upload.rel_path)),
    };
    if let Err(error) = fs::create_dir_all(parent) {
        return fail(format!(
            "create upload parent {}: {error}",
            parent.display()
        ));
    }
    let canonical_parent = match parent.canonicalize() {
        Ok(parent) => parent,
        Err(error) => return fail(format!("canonicalize upload parent: {error}")),
    };
    if !canonical_parent.starts_with(&upload.root) {
        return fail(format!("path escapes workspace: {}", upload.rel_path));
    }
    if let Err(error) = File::open(&upload.temp_path).and_then(|file| file.sync_all()) {
        return fail(format!("sync upload temp: {error}"));
    }
    if let Err(error) = fs::rename(&upload.temp_path, &target) {
        return fail(format!("publish upload {}: {error}", target.display()));
    }
    Ok(actual_hash)
}

fn resolve_existing(root: &Path, rel_path: &str) -> Result<PathBuf, String> {
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("canonicalize root {}: {error}", root.display()))?;
    let target = resolve_new(&canonical_root, rel_path)?;
    let canonical_target = target
        .canonicalize()
        .map_err(|error| format!("canonicalize {}: {error}", target.display()))?;
    if !canonical_target.starts_with(&canonical_root) {
        return Err(format!("path escapes workspace: {rel_path}"));
    }
    Ok(canonical_target)
}

fn resolve_new(root: &Path, rel_path: &str) -> Result<PathBuf, String> {
    let relative = Path::new(rel_path);
    if relative.as_os_str().is_empty()
        || relative.is_absolute()
        || relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(format!("path escapes workspace: {rel_path}"));
    }
    Ok(root.join(relative))
}

fn hash_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| format!("open {}: {error}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("read {}: {error}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn hash_bytes(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn validate_hash(hash: &str) -> Result<(), String> {
    if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("invalid SHA-256 hash".into());
    }
    Ok(())
}

fn sweep(state: &mut RegistryState) {
    let now = Instant::now();
    state
        .downloads
        .retain(|_, download| download.expires_at > now);
    let expired = state
        .uploads
        .iter()
        .filter_map(|(id, upload)| (upload.expires_at <= now).then_some(id.clone()))
        .collect::<Vec<_>>();
    for id in expired {
        if let Some(upload) = state.uploads.remove(&id) {
            let _ = fs::remove_file(upload.temp_path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine};
    use sha2::{Digest, Sha256};
    use std::fs;
    use tempfile::TempDir;

    fn sha(bytes: &[u8]) -> String {
        hex::encode(Sha256::digest(bytes))
    }

    #[test]
    fn download_is_resumable_bounded_and_hash_verified() {
        let root = TempDir::new().unwrap();
        let bytes = vec![b'x'; MAX_TRANSFER_CHUNK_BYTES + 7];
        fs::write(root.path().join("large.bin"), &bytes).unwrap();
        let registry = TransferRegistry::new(Duration::from_secs(60));

        let handle = registry
            .open_download(root.path(), "large.bin", false)
            .unwrap();
        assert_eq!(handle.size, bytes.len() as u64);
        assert_eq!(handle.hash, sha(&bytes));

        let first = registry.read_chunk(&handle.handle_id, 0, None).unwrap();
        let first_bytes = STANDARD.decode(&first.data_base64).unwrap();
        assert_eq!(first_bytes.len(), MAX_TRANSFER_CHUNK_BYTES);
        assert_eq!(first.chunk_hash, sha(&first_bytes));
        assert!(!first.eof);

        let second = registry
            .read_chunk(&handle.handle_id, first.next_offset, None)
            .unwrap();
        assert_eq!(STANDARD.decode(&second.data_base64).unwrap(), vec![b'x'; 7]);
        assert!(second.eof);
        registry.close_download(&handle.handle_id).unwrap();
        assert!(registry.read_chunk(&handle.handle_id, 0, None).is_err());
    }

    #[test]
    fn sensitive_download_requires_explicit_authorization() {
        let root = TempDir::new().unwrap();
        fs::write(root.path().join(".env.local"), "TOKEN=secret").unwrap();
        let registry = TransferRegistry::new(Duration::from_secs(60));
        let denied = registry
            .open_download(root.path(), ".env.local", false)
            .unwrap_err();
        assert!(denied.contains("sensitive"));
        assert!(
            registry
                .open_download(root.path(), ".env.local", true)
                .unwrap()
                .sensitive
        );
    }

    #[test]
    fn upload_commits_atomically_after_sequential_verified_chunks() {
        let root = TempDir::new().unwrap();
        let registry = TransferRegistry::new(Duration::from_secs(60));
        let bytes = b"first chunk and second chunk";
        let handle = registry
            .open_upload(
                root.path(),
                "nested/result.txt",
                bytes.len() as u64,
                &sha(bytes),
                false,
            )
            .unwrap();
        let first = &bytes[..11];
        let second = &bytes[11..];
        let offset = registry
            .write_chunk(&handle.handle_id, 0, &STANDARD.encode(first), &sha(first))
            .unwrap();
        assert_eq!(offset, first.len() as u64);
        let bad = registry.write_chunk(
            &handle.handle_id,
            offset + 1,
            &STANDARD.encode(second),
            &sha(second),
        );
        assert!(bad.unwrap_err().contains("offset"));
        registry
            .write_chunk(
                &handle.handle_id,
                offset,
                &STANDARD.encode(second),
                &sha(second),
            )
            .unwrap();
        assert!(!root.path().join("nested/result.txt").exists());
        assert_eq!(
            registry.commit_upload(&handle.handle_id).unwrap(),
            sha(bytes)
        );
        assert_eq!(
            fs::read(root.path().join("nested/result.txt")).unwrap(),
            bytes
        );
    }

    #[test]
    fn aborted_upload_never_publishes_partial_content() {
        let root = TempDir::new().unwrap();
        let registry = TransferRegistry::new(Duration::from_secs(60));
        let bytes = b"partial";
        let handle = registry
            .open_upload(
                root.path(),
                "result.txt",
                bytes.len() as u64,
                &sha(bytes),
                false,
            )
            .unwrap();
        registry
            .write_chunk(&handle.handle_id, 0, &STANDARD.encode(bytes), &sha(bytes))
            .unwrap();
        registry.abort_upload(&handle.handle_id).unwrap();
        assert!(!root.path().join("result.txt").exists());
    }
}

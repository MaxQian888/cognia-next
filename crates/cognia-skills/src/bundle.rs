use std::{
    collections::HashMap,
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::install::InstallSkillMirroredRequest;

pub const MAX_BUNDLE_BYTES: u64 = 128 * 1024 * 1024;
pub const MAX_CHUNK_BYTES: usize = 32 * 1024;
const MAX_ACTIVE_UPLOADS: usize = 32;
const UPLOAD_TTL: Duration = Duration::from_secs(30 * 60);

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleUploadOpenRequest {
    pub expected_size: u64,
    pub expected_hash: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleUploadHandle {
    pub handle_id: String,
    pub chunk_bytes: usize,
}

#[derive(Debug)]
struct UploadState {
    path: PathBuf,
    expected_size: u64,
    expected_hash: String,
    written: u64,
    committed: bool,
    created_at: Instant,
}

#[derive(Debug)]
pub struct SkillBundleUploadService {
    root: PathBuf,
    uploads: Mutex<HashMap<String, UploadState>>,
}

impl SkillBundleUploadService {
    pub fn new(root: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&root)
            .map_err(|error| format!("create skill upload root {}: {error}", root.display()))?;
        for entry in std::fs::read_dir(&root)
            .map_err(|error| format!("read skill upload root {}: {error}", root.display()))?
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

    pub fn open(&self, request: BundleUploadOpenRequest) -> Result<BundleUploadHandle, String> {
        if request.expected_size == 0 || request.expected_size > MAX_BUNDLE_BYTES {
            return Err(format!(
                "skill bundle size must be between 1 and {MAX_BUNDLE_BYTES} bytes"
            ));
        }
        validate_sha256(&request.expected_hash)?;
        let mut uploads = self.uploads.lock();
        cleanup_expired_uploads(&mut uploads);
        if uploads.len() >= MAX_ACTIVE_UPLOADS {
            return Err(format!(
                "too many active Skill uploads: max {MAX_ACTIVE_UPLOADS}"
            ));
        }
        let handle_id = Uuid::new_v4().to_string();
        let path = self.root.join(format!("{handle_id}.upload"));
        File::create(&path)
            .map_err(|error| format!("create skill upload {}: {error}", path.display()))?;
        uploads.insert(
            handle_id.clone(),
            UploadState {
                path,
                expected_size: request.expected_size,
                expected_hash: request.expected_hash,
                written: 0,
                committed: false,
                created_at: Instant::now(),
            },
        );
        Ok(BundleUploadHandle {
            handle_id,
            chunk_bytes: MAX_CHUNK_BYTES,
        })
    }

    pub fn write_chunk(
        &self,
        handle_id: &str,
        offset: u64,
        data_base64: &str,
        chunk_hash: &str,
    ) -> Result<u64, String> {
        validate_sha256(chunk_hash)?;
        let data = BASE64
            .decode(data_base64)
            .map_err(|error| format!("decode skill bundle chunk: {error}"))?;
        if data.is_empty() || data.len() > MAX_CHUNK_BYTES {
            return Err(format!(
                "skill bundle chunk must be between 1 and {MAX_CHUNK_BYTES} bytes"
            ));
        }
        if sha256_hex(&data) != chunk_hash {
            return Err("skill bundle chunk hash mismatch".into());
        }

        let mut uploads = self.uploads.lock();
        cleanup_expired_uploads(&mut uploads);
        let upload = uploads
            .get_mut(handle_id)
            .ok_or_else(|| "unknown skill bundle upload handle".to_string())?;
        if upload.committed {
            return Err("skill bundle upload is already committed".into());
        }
        if upload.written != offset {
            return Err(format!(
                "skill bundle chunk offset mismatch: expected {}, got {offset}",
                upload.written
            ));
        }
        let next = upload
            .written
            .checked_add(data.len() as u64)
            .ok_or_else(|| "skill bundle size overflow".to_string())?;
        if next > upload.expected_size {
            return Err("skill bundle exceeds declared size".into());
        }

        let mut file = OpenOptions::new()
            .write(true)
            .open(&upload.path)
            .map_err(|error| format!("open skill upload {}: {error}", upload.path.display()))?;
        file.seek(SeekFrom::Start(offset))
            .and_then(|_| file.write_all(&data))
            .and_then(|_| file.sync_data())
            .map_err(|error| format!("write skill upload {}: {error}", upload.path.display()))?;
        upload.written = next;
        Ok(next)
    }

    pub fn commit(&self, handle_id: &str) -> Result<(), String> {
        let mut uploads = self.uploads.lock();
        cleanup_expired_uploads(&mut uploads);
        let upload = uploads
            .get_mut(handle_id)
            .ok_or_else(|| "unknown skill bundle upload handle".to_string())?;
        if upload.written != upload.expected_size {
            return Err(format!(
                "skill bundle incomplete: expected {}, got {} bytes",
                upload.expected_size, upload.written
            ));
        }
        let bytes = read_all(&upload.path)?;
        if sha256_hex(&bytes) != upload.expected_hash {
            return Err("skill bundle hash mismatch".into());
        }
        serde_json::from_slice::<InstallSkillMirroredRequest>(&bytes)
            .map_err(|error| format!("invalid skill bundle JSON: {error}"))?;
        upload.committed = true;
        Ok(())
    }

    pub fn take(&self, handle_id: &str) -> Result<InstallSkillMirroredRequest, String> {
        let mut uploads = self.uploads.lock();
        cleanup_expired_uploads(&mut uploads);
        let upload = uploads
            .remove(handle_id)
            .ok_or_else(|| "unknown skill bundle upload handle".to_string())?;
        if !upload.committed {
            let _ = std::fs::remove_file(upload.path);
            return Err("skill bundle upload is not committed".into());
        }
        let bytes = read_all(&upload.path)?;
        let _ = std::fs::remove_file(&upload.path);
        serde_json::from_slice(&bytes)
            .map_err(|error| format!("invalid skill bundle JSON: {error}"))
    }

    pub fn abort(&self, handle_id: &str) -> Result<(), String> {
        let mut uploads = self.uploads.lock();
        cleanup_expired_uploads(&mut uploads);
        let upload = uploads
            .remove(handle_id)
            .ok_or_else(|| "unknown skill bundle upload handle".to_string())?;
        std::fs::remove_file(&upload.path)
            .map_err(|error| format!("remove skill upload {}: {error}", upload.path.display()))
    }
}

fn cleanup_expired_uploads(uploads: &mut HashMap<String, UploadState>) {
    let expired = uploads
        .iter()
        .filter(|(_, upload)| upload.created_at.elapsed() > UPLOAD_TTL)
        .map(|(handle_id, upload)| (handle_id.clone(), upload.path.clone()))
        .collect::<Vec<_>>();
    for (handle_id, path) in expired {
        uploads.remove(&handle_id);
        let _ = std::fs::remove_file(path);
    }
}

fn validate_sha256(value: &str) -> Result<(), String> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("expected a 64-character SHA-256 hex digest".into());
    }
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn read_all(path: &Path) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    File::open(path)
        .and_then(|mut file| file.read_to_end(&mut bytes))
        .map_err(|error| format!("read skill upload {}: {error}", path.display()))?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::install::{InstallSkillMirroredRequest, SkillsTarget};
    use crate::types::NativeSkillResource;

    fn request_with_large_resource() -> InstallSkillMirroredRequest {
        InstallSkillMirroredRequest {
            dir_name: "remote-skill".into(),
            content: "---\nname: Remote\n---\nbody".into(),
            resources: vec![NativeSkillResource {
                kind: "reference".into(),
                path: "references/large.txt".into(),
                name: "large.txt".into(),
                content: "x".repeat(80 * 1024),
                encoding: "utf-8".into(),
                mime_type: Some("text/plain".into()),
                size: 80 * 1024,
            }],
            clean: true,
            targets: vec![SkillsTarget::Claude],
            trash_before_clean: false,
        }
    }

    #[test]
    fn uploads_a_bundle_larger_than_the_companion_json_limit_in_verified_chunks() {
        let temp = tempfile::tempdir().unwrap();
        let service = SkillBundleUploadService::new(temp.path().to_path_buf()).unwrap();
        let bytes = serde_json::to_vec(&request_with_large_resource()).unwrap();
        assert!(bytes.len() > 64 * 1024);
        let handle = service
            .open(BundleUploadOpenRequest {
                expected_size: bytes.len() as u64,
                expected_hash: sha256_hex(&bytes),
            })
            .unwrap();
        let mut offset = 0_u64;
        for chunk in bytes.chunks(MAX_CHUNK_BYTES) {
            offset = service
                .write_chunk(
                    &handle.handle_id,
                    offset,
                    &BASE64.encode(chunk),
                    &sha256_hex(chunk),
                )
                .unwrap();
        }
        service.commit(&handle.handle_id).unwrap();
        let request = service.take(&handle.handle_id).unwrap();
        assert_eq!(request.dir_name, "remote-skill");
        assert_eq!(request.resources[0].content.len(), 80 * 1024);
    }

    #[test]
    fn rejects_out_of_order_and_corrupt_chunks() {
        let temp = tempfile::tempdir().unwrap();
        let service = SkillBundleUploadService::new(temp.path().to_path_buf()).unwrap();
        let bytes = serde_json::to_vec(&request_with_large_resource()).unwrap();
        let handle = service
            .open(BundleUploadOpenRequest {
                expected_size: bytes.len() as u64,
                expected_hash: sha256_hex(&bytes),
            })
            .unwrap();
        let chunk = &bytes[..MAX_CHUNK_BYTES];
        assert!(service
            .write_chunk(
                &handle.handle_id,
                1,
                &BASE64.encode(chunk),
                &sha256_hex(chunk)
            )
            .unwrap_err()
            .contains("offset mismatch"));
        assert!(service
            .write_chunk(&handle.handle_id, 0, &BASE64.encode(chunk), &"0".repeat(64))
            .unwrap_err()
            .contains("hash mismatch"));
    }

    #[test]
    fn bounds_active_upload_handles_and_cleans_restart_orphans() {
        let temp = tempfile::tempdir().unwrap();
        let orphan = temp.path().join("orphan.upload");
        std::fs::write(&orphan, b"partial").unwrap();
        let service = SkillBundleUploadService::new(temp.path().to_path_buf()).unwrap();
        assert!(!orphan.exists());

        let request = BundleUploadOpenRequest {
            expected_size: 1,
            expected_hash: sha256_hex(b"x"),
        };
        let handles = (0..MAX_ACTIVE_UPLOADS)
            .map(|_| service.open(request.clone()).unwrap())
            .collect::<Vec<_>>();
        assert!(service
            .open(request)
            .unwrap_err()
            .contains("too many active"));
        for handle in handles {
            service.abort(&handle.handle_id).unwrap();
        }
    }
}

//! Single-active guard for one tenant-owned Headless data volume.
//!
//! The lock is advisory and held by the OS file descriptor, so a crash drops
//! it automatically. The small metadata file is intentionally retained: it is
//! diagnostic evidence, not the authority, and a stale file never blocks a
//! healthy restart.

use std::{
    fs::{File, OpenOptions},
    io::{Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

use serde::Serialize;

const LEASE_FILE_NAME: &str = "headless-active.lock";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LeaseMetadata<'a> {
    tenant_id: &'a str,
    pid: u32,
    acquired_at: String,
}

pub struct HeadlessTenantLease {
    file: File,
    path: PathBuf,
}

impl HeadlessTenantLease {
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for HeadlessTenantLease {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

pub fn acquire(data_dir: &Path, tenant_id: &str) -> Result<HeadlessTenantLease, String> {
    let tenant_id = tenant_id.trim();
    if tenant_id.is_empty() || tenant_id.len() > 256 {
        return Err("headless tenant id must contain 1 to 256 bytes".into());
    }
    let lease_dir = data_dir.join(".cognia");
    std::fs::create_dir_all(&lease_dir)
        .map_err(|error| format!("create headless lease directory: {error}"))?;
    let path = lease_dir.join(LEASE_FILE_NAME);
    let mut file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(&path)
        .map_err(|error| format!("open headless tenant lease {}: {error}", path.display()))?;
    file.try_lock().map_err(|error| {
        format!(
            "another cognia-server is already active for this tenant volume ({}): {error}",
            path.display()
        )
    })?;

    let metadata = serde_json::to_vec_pretty(&LeaseMetadata {
        tenant_id,
        pid: std::process::id(),
        acquired_at: chrono::Utc::now().to_rfc3339(),
    })
    .map_err(|error| format!("serialize headless tenant lease: {error}"))?;
    file.set_len(0)
        .and_then(|_| file.seek(SeekFrom::Start(0)))
        .and_then(|_| file.write_all(&metadata))
        .and_then(|_| file.sync_data())
        .map_err(|error| format!("persist headless tenant lease {}: {error}", path.display()))?;

    Ok(HeadlessTenantLease { file, path })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lease_is_single_active_and_recovers_after_owner_drop() {
        let dir = tempfile::tempdir().unwrap();
        let first = acquire(dir.path(), "tenant-a").unwrap();
        assert!(first.path().ends_with(LEASE_FILE_NAME));
        assert!(acquire(dir.path(), "tenant-a").is_err());
        assert!(acquire(dir.path(), "tenant-b").is_err());

        drop(first);
        let recovered = acquire(dir.path(), "tenant-a").unwrap();
        let metadata = std::fs::read_to_string(recovered.path()).unwrap();
        assert!(metadata.contains("tenant-a"));
        assert!(metadata.contains("acquiredAt"));
    }

    #[test]
    fn invalid_tenant_identity_fails_before_touching_the_volume() {
        let dir = tempfile::tempdir().unwrap();
        assert!(acquire(dir.path(), "   ").is_err());
        assert!(!dir.path().join(".cognia").exists());
    }
}

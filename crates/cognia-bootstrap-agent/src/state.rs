//! Locked, atomic reuse records contain only hashes, never transcripts or credentials.
use crate::config::Config;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tokio::sync::watch;

pub struct StateLock {
    path: PathBuf,
    _lock: File,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    version: u8,
    fingerprint: String,
}

fn confined(root: &Path, relative: &str) -> Result<PathBuf, &'static str> {
    let mut path = root.to_owned();
    for part in Path::new(relative).components() {
        path.push(part);
        if std::fs::symlink_metadata(&path)
            .map_err(|_| "reuse-input-unavailable")?
            .file_type()
            .is_symlink()
        {
            return Err("reuse-symlink-denied");
        }
    }
    Ok(path)
}

pub fn fingerprint(root: &Path, config: &Config) -> Result<String, &'static str> {
    let mut hash = Sha256::new();
    hash.update(root.to_string_lossy().as_bytes());
    hash.update(serde_json::to_vec(config).map_err(|_| "invalid-config")?);
    for relative in &config.reuse.inputs {
        let bytes = crate::tools::read_reuse_input(root, relative, 16 * 1024 * 1024)
            .map_err(|_| "reuse-input-unavailable")?;
        hash.update(relative.as_bytes());
        hash.update([0]);
        hash.update(Sha256::digest(bytes));
    }
    Ok(hex::encode(hash.finalize()))
}

pub fn outputs_exist(root: &Path, config: &Config) -> bool {
    config
        .reuse
        .outputs
        .iter()
        .all(|p| confined(root, p).is_ok())
}

impl StateLock {
    pub async fn acquire(
        path: &Path,
        cancel: &mut watch::Receiver<bool>,
    ) -> Result<Self, &'static str> {
        #[cfg(not(unix))]
        {
            let _ = (path, cancel);
            Err("unsupported-platform")
        }
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            use std::os::unix::fs::OpenOptionsExt;
            let parent = path
                .parent()
                .ok_or("invalid-state-path")?
                .canonicalize()
                .map_err(|_| "invalid-state-path")?;
            let name = path.file_name().ok_or("invalid-state-path")?;
            let path = parent.join(name);
            if std::fs::symlink_metadata(&path).is_ok_and(|m| !m.is_file()) {
                return Err("invalid-state-path");
            }
            let lock_path = path.with_file_name(format!("{}.lock", name.to_string_lossy()));
            let lock = OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
                .open(lock_path)
                .map_err(|_| "state-lock-failed")?;
            if !lock.metadata().map_err(|_| "state-lock-failed")?.is_file() {
                return Err("state-lock-failed");
            }
            loop {
                if *cancel.borrow() {
                    return Err("cancelled");
                }
                // SAFETY: flock acts on this owned file descriptor only.
                if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
                    return Ok(Self { path, _lock: lock });
                }
                let e = std::io::Error::last_os_error();
                if e.raw_os_error() != Some(libc::EWOULDBLOCK) {
                    return Err("state-lock-failed");
                }
                tokio::select! { _ = crate::model::cancellation(cancel) => return Err("cancelled"), _ = tokio::time::sleep(std::time::Duration::from_millis(50)) => {} }
            }
        }
    }
    pub fn has_record(&self) -> bool {
        self.path.try_exists().unwrap_or(true)
    }
    pub fn matches(&self, fingerprint: &str) -> bool {
        #[cfg(unix)]
        let opened = {
            use std::os::unix::fs::OpenOptionsExt;
            OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
                .open(&self.path)
        };
        #[cfg(not(unix))]
        let opened = File::open(&self.path);
        let Ok(file) = opened else { return false };
        if !file.metadata().is_ok_and(|m| m.is_file()) {
            return false;
        }
        let mut bytes = Vec::new();
        if file.take(4097).read_to_end(&mut bytes).is_err() || bytes.len() > 4096 {
            return false;
        }
        serde_json::from_slice::<Record>(&bytes)
            .is_ok_and(|r| r.version == 1 && r.fingerprint == fingerprint)
    }
    pub fn save(&self, fingerprint: String) -> Result<(), &'static str> {
        let parent = self.path.parent().ok_or("invalid-state-path")?;
        let mut temporary =
            tempfile::NamedTempFile::new_in(parent).map_err(|_| "state-write-failed")?;
        let bytes = serde_json::to_vec(&Record {
            version: 1,
            fingerprint,
        })
        .map_err(|_| "state-write-failed")?;
        temporary
            .write_all(&bytes)
            .map_err(|_| "state-write-failed")?;
        temporary
            .as_file()
            .sync_all()
            .map_err(|_| "state-write-failed")?;
        temporary
            .persist(&self.path)
            .map_err(|_| "state-write-failed")?;
        File::open(parent)
            .and_then(|f| f.sync_all())
            .map_err(|_| "state-write-failed")?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> Config {
        Config::parse(r#"{"version":1,"task":"prepare","model":{"baseUrl":"https://example.org/v1","model":"local"},"reuse":{"inputs":["input"],"outputs":["output"]}}"#).unwrap()
    }
    #[test]
    fn fingerprints_inputs_and_checks_outputs() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("input"), "first").unwrap();
        let a = fingerprint(dir.path(), &config()).unwrap();
        std::fs::write(dir.path().join("input"), "second").unwrap();
        assert_ne!(a, fingerprint(dir.path(), &config()).unwrap());
        assert!(!outputs_exist(dir.path(), &config()));
        std::fs::write(dir.path().join("output"), "ok").unwrap();
        assert!(outputs_exist(dir.path(), &config()));
    }
    #[cfg(unix)]
    #[test]
    fn input_fifos_and_parent_symlinks_cannot_block_or_escape() {
        use std::os::unix::ffi::OsStrExt;
        let dir = tempfile::tempdir().unwrap();
        let path = std::ffi::CString::new(dir.path().join("input").as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
        let started = std::time::Instant::now();
        assert!(fingerprint(dir.path(), &config()).is_err());
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("input"), "private").unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("outside")).unwrap();
        let mut config = config();
        config.reuse.inputs = vec!["outside/input".into()];
        assert!(fingerprint(dir.path(), &config).is_err());
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn non_regular_state_files_are_rejected_without_waiting() {
        use std::os::unix::ffi::OsStrExt;
        let dir = tempfile::tempdir().unwrap();
        let fifo = dir.path().join("fifo");
        let path = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
        let (_sender, mut cancel) = watch::channel(false);
        for path in [fifo, dir.path().to_owned()] {
            let result = tokio::time::timeout(
                std::time::Duration::from_secs(1),
                StateLock::acquire(&path, &mut cancel),
            )
            .await
            .unwrap();
            assert_eq!(result.err(), Some("invalid-state-path"));
        }
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn records_are_atomic_and_symlinks_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let (_sender, mut cancel) = watch::channel(false);
        let lock = StateLock::acquire(&dir.path().join("state.json"), &mut cancel)
            .await
            .unwrap();
        lock.save("abc".into()).unwrap();
        assert!(lock.matches("abc"));
        assert!(!lock.matches("def"));
        std::os::unix::fs::symlink("state.json", dir.path().join("link")).unwrap();
        assert!(StateLock::acquire(&dir.path().join("link"), &mut cancel)
            .await
            .is_err());
    }
}

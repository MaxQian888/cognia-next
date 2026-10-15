use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::OnceLock,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum IntegrationLockScope {
    Repository,
    Target,
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum IntegrationLockError {
    #[error("integration {scope:?} lock is busy")]
    Busy { scope: IntegrationLockScope },
    #[error("integration lock: {0}")]
    Io(#[from] io::Error),
}

/// Closing these handles releases the advisory locks, including on process exit.
#[derive(Debug)]
pub(crate) struct IntegrationLockGuard {
    _target: File,
    _repository: File,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LockDiagnostics<'a> {
    pid: u32,
    process_start_marker: &'a str,
    scope: IntegrationLockScope,
    repo_common_dir: &'a str,
    target_ref: &'a str,
}

pub(crate) fn try_acquire(
    integration_dir: &Path,
    repo_common_dir: &str,
    target_ref: &str,
) -> Result<IntegrationLockGuard, IntegrationLockError> {
    let directory = repository_lock_directory(integration_dir, repo_common_dir);
    fs::create_dir_all(&directory)?;
    let mut repository = lock_file(
        &directory.join("repository.lock"),
        IntegrationLockScope::Repository,
    )?;
    let mut target = lock_file(
        &target_lock_path(&directory, target_ref),
        IntegrationLockScope::Target,
    )?;
    for (file, scope) in [
        (&mut repository, IntegrationLockScope::Repository),
        (&mut target, IntegrationLockScope::Target),
    ] {
        let diagnostics = LockDiagnostics {
            pid: std::process::id(),
            process_start_marker: process_start_marker(),
            scope,
            repo_common_dir,
            target_ref,
        };
        let bytes = serde_json::to_vec(&diagnostics).map_err(io::Error::other)?;
        file.set_len(0)?;
        file.write_all(&bytes)?;
        file.write_all(b"\n")?;
    }
    Ok(IntegrationLockGuard {
        _repository: repository,
        _target: target,
    })
}

fn repository_lock_directory(integration_dir: &Path, repo_common_dir: &str) -> PathBuf {
    // Keep lock files after release; unlinking one would let a new inode bypass
    // another process that still holds the original file open.
    let digest = hex::encode(Sha256::digest(repo_common_dir.as_bytes()));
    integration_dir.join(".locks").join(&digest[..16])
}

fn target_lock_path(directory: &Path, target_ref: &str) -> PathBuf {
    let digest = hex::encode(Sha256::digest(target_ref.as_bytes()));
    directory.join(format!("target-{digest}.lock"))
}

fn process_start_marker() -> &'static str {
    static MARKER: OnceLock<String> = OnceLock::new();
    // A launch marker initialized on first use distinguishes PID reuse. It is
    // diagnostic only: the operating system lock determines ownership.
    MARKER.get_or_init(|| uuid::Uuid::now_v7().to_string())
}

fn lock_file(path: &Path, scope: IntegrationLockScope) -> Result<File, IntegrationLockError> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Allow competing opens to reach LockFileEx, but prevent replacement
        // of the lock file while any participant has it open.
        options.share_mode(1 | 2); // FILE_SHARE_READ | FILE_SHARE_WRITE
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(
            io::Error::new(io::ErrorKind::InvalidInput, "lock is not a regular file").into(),
        );
    }
    try_lock_file(&file, scope)?;
    Ok(file)
}

/// How long a contended `flock` is retried before it counts as held.
///
/// A child another thread is forking keeps a copy of every descriptor until
/// its `exec` closes the close-on-exec ones, so a lock this process has just
/// released can stay held for that instant. A real holder keeps the lock for
/// a whole integration step, far longer than this.
#[cfg(unix)]
const FORK_RELEASE_GRACE: std::time::Duration = std::time::Duration::from_millis(250);

#[cfg(unix)]
fn try_lock_file(file: &File, scope: IntegrationLockScope) -> Result<(), IntegrationLockError> {
    use std::os::fd::AsRawFd;
    let deadline = std::time::Instant::now() + FORK_RELEASE_GRACE;
    loop {
        // SAFETY: the descriptor remains owned by `file` throughout this call.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.kind() == io::ErrorKind::WouldBlock {
            if std::time::Instant::now() >= deadline {
                return Err(IntegrationLockError::Busy { scope });
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
            continue;
        }
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error.into());
        }
    }
}

#[cfg(windows)]
fn try_lock_file(file: &File, scope: IntegrationLockScope) -> Result<(), IntegrationLockError> {
    use std::{ffi::c_void, os::windows::io::AsRawHandle};

    #[repr(C)]
    struct Overlapped {
        internal: usize,
        internal_high: usize,
        offset: u32,
        offset_high: u32,
        event: *mut c_void,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn LockFileEx(
            file: *mut c_void,
            flags: u32,
            reserved: u32,
            length_low: u32,
            length_high: u32,
            overlapped: *mut Overlapped,
        ) -> i32;
    }

    let mut overlapped = Overlapped {
        internal: 0,
        internal_high: 0,
        offset: 0,
        offset_high: 0,
        event: std::ptr::null_mut(),
    };
    // SAFETY: `file` owns a synchronous handle and `overlapped` has the Windows
    // OVERLAPPED layout. FAIL_IMMEDIATELY (1) and EXCLUSIVE_LOCK (2) cannot pend.
    let result = unsafe { LockFileEx(file.as_raw_handle(), 1 | 2, 0, 1, 0, &mut overlapped) };
    if result != 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(33) {
        // ERROR_LOCK_VIOLATION is distinct from permission and filesystem errors.
        return Err(IntegrationLockError::Busy { scope });
    }
    Err(error.into())
}

#[cfg(not(any(unix, windows)))]
fn try_lock_file(_file: &File, _scope: IntegrationLockScope) -> Result<(), IntegrationLockError> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "integration advisory locks are unsupported on this platform",
    )
    .into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::Read,
        process::{Child, Command, Stdio},
        thread,
        time::{Duration, Instant},
    };

    const CHILD_DIRECTORY: &str = "COGNIA_INTEGRATION_LOCK_TEST_DIRECTORY";
    const CHILD_MODE: &str = "COGNIA_INTEGRATION_LOCK_TEST_MODE";
    const REPOSITORY: &str = "/test/repository/.git";
    const TARGET: &str = "refs/heads/main";

    fn child_command(directory: &Path, mode: &str) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "integration_lock::tests::integration_lock_child_process",
                "--nocapture",
            ])
            .env(CHILD_DIRECTORY, directory)
            .env(CHILD_MODE, mode);
        command
    }

    struct ChildOwner(Child);

    impl Drop for ChildOwner {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    #[test]
    fn integration_lock_contends_between_handles_and_releases_on_drop() {
        let temp = tempfile::tempdir().unwrap();
        let first = try_acquire(temp.path(), REPOSITORY, TARGET).unwrap();
        assert!(matches!(
            try_acquire(temp.path(), REPOSITORY, TARGET),
            Err(IntegrationLockError::Busy {
                scope: IntegrationLockScope::Repository
            })
        ));
        assert!(matches!(
            try_acquire(temp.path(), REPOSITORY, "refs/heads/other"),
            Err(IntegrationLockError::Busy {
                scope: IntegrationLockScope::Repository
            })
        ));
        let other = try_acquire(temp.path(), "/other/repository/.git", TARGET).unwrap();
        drop(other);
        drop(first);
        assert!(try_acquire(temp.path(), REPOSITORY, TARGET).is_ok());
    }

    #[test]
    fn integration_lock_target_contention_releases_the_repository_guard() {
        let temp = tempfile::tempdir().unwrap();
        let directory = repository_lock_directory(temp.path(), REPOSITORY);
        fs::create_dir_all(&directory).unwrap();
        let target_path = target_lock_path(&directory, TARGET);
        let target = lock_file(&target_path, IntegrationLockScope::Target).unwrap();
        assert!(matches!(
            try_acquire(temp.path(), REPOSITORY, TARGET),
            Err(IntegrationLockError::Busy {
                scope: IntegrationLockScope::Target
            })
        ));
        assert!(try_acquire(temp.path(), REPOSITORY, "refs/heads/other").is_ok());
        drop(target);
        assert!(try_acquire(temp.path(), REPOSITORY, TARGET).is_ok());
    }

    #[test]
    fn integration_lock_diagnostics_keep_one_process_marker_and_ignore_stale_contents() {
        let temp = tempfile::tempdir().unwrap();
        let directory = repository_lock_directory(temp.path(), REPOSITORY);
        fs::create_dir_all(&directory).unwrap();
        let repository_path = directory.join("repository.lock");
        fs::write(&repository_path, "stale diagnostics".repeat(100)).unwrap();
        let guard = try_acquire(temp.path(), REPOSITORY, TARGET).unwrap();
        drop(guard);
        let repository: serde_json::Value =
            serde_json::from_slice(&fs::read(&repository_path).unwrap()).unwrap();
        let target: serde_json::Value =
            serde_json::from_slice(&fs::read(target_lock_path(&directory, TARGET)).unwrap())
                .unwrap();
        assert_eq!(repository["pid"], std::process::id());
        assert_eq!(repository["scope"], "repository");
        assert_eq!(target["scope"], "target");
        assert_eq!(target["targetRef"], TARGET);
        assert_eq!(repository["repoCommonDir"], REPOSITORY);
        assert!(!repository["processStartMarker"]
            .as_str()
            .unwrap()
            .is_empty());
        assert_eq!(
            repository["processStartMarker"],
            target["processStartMarker"]
        );
        let next = try_acquire(temp.path(), REPOSITORY, TARGET).unwrap();
        drop(next);
        let reacquired: serde_json::Value =
            serde_json::from_slice(&fs::read(&repository_path).unwrap()).unwrap();
        assert_eq!(
            repository["processStartMarker"],
            reacquired["processStartMarker"]
        );
    }

    #[test]
    fn integration_lock_reports_io_failures_separately_from_contention() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("not-a-directory");
        fs::write(&file, "occupied").unwrap();
        assert!(matches!(
            try_acquire(&file, REPOSITORY, TARGET),
            Err(IntegrationLockError::Io(_))
        ));
        assert_eq!(fs::read_to_string(file).unwrap(), "occupied");
    }

    #[test]
    fn integration_lock_contends_across_processes_and_releases_after_exit() {
        let temp = tempfile::tempdir().unwrap();
        let guard = try_acquire(temp.path(), REPOSITORY, TARGET).unwrap();
        let output = child_command(temp.path(), "busy").output().unwrap();
        assert!(
            output.status.success(),
            "child failed: {} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        drop(guard);
        let output = child_command(temp.path(), "acquire").output().unwrap();
        assert!(
            output.status.success(),
            "child failed: {} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let diagnostics: serde_json::Value = serde_json::from_slice(
            &fs::read(repository_lock_directory(temp.path(), REPOSITORY).join("repository.lock"))
                .unwrap(),
        )
        .unwrap();
        assert_ne!(diagnostics["pid"], std::process::id());
        assert_ne!(diagnostics["processStartMarker"], process_start_marker());
        assert!(try_acquire(temp.path(), REPOSITORY, TARGET).is_ok());
    }

    #[test]
    fn integration_lock_is_released_when_the_owner_process_is_killed() {
        let temp = tempfile::tempdir().unwrap();
        let mut child = ChildOwner(
            child_command(temp.path(), "hold")
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let ready = temp.path().join("ready");
        let deadline = Instant::now() + Duration::from_secs(10);
        while !ready.exists() {
            assert!(child.0.try_wait().unwrap().is_none(), "child exited early");
            assert!(Instant::now() < deadline, "child did not acquire the lock");
            thread::sleep(Duration::from_millis(10));
        }
        assert!(matches!(
            try_acquire(temp.path(), REPOSITORY, TARGET),
            Err(IntegrationLockError::Busy { .. })
        ));
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        assert!(try_acquire(temp.path(), REPOSITORY, TARGET).is_ok());
    }

    #[test]
    fn integration_lock_child_process() {
        let Some(directory) = std::env::var_os(CHILD_DIRECTORY) else {
            return;
        };
        let directory = Path::new(&directory);
        match std::env::var(CHILD_MODE).unwrap().as_str() {
            "busy" => assert!(matches!(
                try_acquire(directory, REPOSITORY, TARGET),
                Err(IntegrationLockError::Busy { .. })
            )),
            "acquire" => {
                let _guard = try_acquire(directory, REPOSITORY, TARGET).unwrap();
            }
            "hold" => {
                let _guard = try_acquire(directory, REPOSITORY, TARGET).unwrap();
                fs::write(directory.join("ready"), "ready").unwrap();
                let _ = std::io::stdin().read_exact(&mut [0]);
            }
            other => panic!("unknown child mode: {other}"),
        }
    }
}

//! P6d persistent partition workspaces. Shared by admission, watchdog and purge.
use std::path::{Path, PathBuf};

/// Bind mounts have no kernel quota. A live run can overshoot the byte cap
/// during at most one measurement interval (30 seconds), plus kill latency.
pub const PERSON_WORKSPACE_MAX_BYTES_ENV: &str = "COGNIA_PERSON_WORKSPACE_MAX_BYTES";
pub const PERSON_WORKSPACE_DEFAULT_MAX_BYTES: u64 = 5 * 1024 * 1024 * 1024;
pub const PERSON_WORKSPACE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30);
pub const PERSON_WORKSPACE_ENTRY_LIMIT: usize = 100_000;

pub fn person_workspace_max_bytes_from(value: Option<&str>) -> Result<u64, String> {
    match value {
        None | Some("0") => Ok(PERSON_WORKSPACE_DEFAULT_MAX_BYTES),
        Some(value) => value.parse::<u64>().map(|n| if n == 0 { PERSON_WORKSPACE_DEFAULT_MAX_BYTES } else { n })
            .map_err(|_| format!("{PERSON_WORKSPACE_MAX_BYTES_ENV} must be an unsigned integer")),
    }
}
pub fn person_workspace_max_bytes() -> Result<u64, String> {
    match std::env::var(PERSON_WORKSPACE_MAX_BYTES_ENV) {
        Ok(value) => person_workspace_max_bytes_from(Some(&value)),
        Err(std::env::VarError::NotPresent) => person_workspace_max_bytes_from(None),
        Err(_) => Err(format!("{PERSON_WORKSPACE_MAX_BYTES_ENV} is not valid Unicode")),
    }
}

#[derive(Debug)]
pub enum PersonWorkspaceError { Mount, Unavailable, Quota { used_bytes: u64, max_bytes: u64 } }
impl PersonWorkspaceError {
    pub fn code(&self) -> &'static str { match self {
        Self::Mount => "workspace_mount_forbidden",
        Self::Unavailable => "person_workspace_unavailable",
        Self::Quota { .. } => "person_workspace_quota_exceeded",
    } }
}
fn person_account_valid(account: &str) -> bool {
    account.len() == 27 && account.starts_with("pb_")
        && account[3..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn person_workspace_path(policy: &crate::presets::SpawnPolicy, account: &str) -> Result<PathBuf, PersonWorkspaceError> {
    if !person_account_valid(account) { return Err(PersonWorkspaceError::Mount); }
    Ok(policy.workspaces_dir().join("persons").join(account))
}
fn person_private_directory(path: &Path) -> Result<(), PersonWorkspaceError> {
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)] {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    match builder.create(path) {
        Ok(()) => (),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
        Err(_) => return Err(PersonWorkspaceError::Unavailable),
    }
    let metadata = std::fs::symlink_metadata(path).map_err(|_| PersonWorkspaceError::Unavailable)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() { return Err(PersonWorkspaceError::Mount); }
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).map_err(|_| PersonWorkspaceError::Unavailable)?;
    }
    Ok(())
}

/// Only Host-owned parents are created. A tenant never mounts `persons/`, so
/// it cannot replace another partition's root or claim its parent directory.
pub fn person_workspace_prepare(policy: &crate::presets::SpawnPolicy, account: &str, cwd: Option<&str>, max: u64)
    -> Result<(PathBuf, PathBuf), PersonWorkspaceError> {
    let path = person_workspace_path(policy, account)?;
    std::fs::create_dir_all(policy.workspaces_dir()).map_err(|_| PersonWorkspaceError::Unavailable)?;
    let base = policy.workspaces_dir().canonicalize().map_err(|_| PersonWorkspaceError::Unavailable)?;
    person_private_directory(&base.join("persons"))?;
    person_private_directory(&path)?;
    let root = path.canonicalize().map_err(|_| PersonWorkspaceError::Unavailable)?;
    if root.parent() != Some(base.join("persons").as_path()) { return Err(PersonWorkspaceError::Mount); }
    let cwd = person_workspace_cwd(&root, cwd)?;
    let used = person_workspace_usage(&root, PERSON_WORKSPACE_ENTRY_LIMIT)?;
    if used >= max { return Err(PersonWorkspaceError::Quota { used_bytes: used, max_bytes: max }); }
    Ok((root, cwd))
}
pub fn person_workspace_cwd(root: &Path, cwd: Option<&str>) -> Result<PathBuf, PersonWorkspaceError> {
    let requested = cwd.map(PathBuf::from).unwrap_or_else(|| root.into());
    let requested = if requested.is_absolute() { requested } else { root.join(requested) };
    let canonical = requested.canonicalize().map_err(|_| PersonWorkspaceError::Mount)?;
    if !canonical.is_dir() || !canonical.starts_with(root) { return Err(PersonWorkspaceError::Mount); }
    Ok(canonical)
}

/// Never follows symlinks (including directory symlinks). Fail closed when
/// the entry budget is exhausted or a tree cannot be measured. The DFS holds
/// at most one open iterator per depth, capped by the same budget.
pub fn person_workspace_usage(root: &Path, limit: usize) -> Result<u64, PersonWorkspaceError> {
    #[cfg(unix)] { return person_workspace_usage_unix(root, limit); }
    #[cfg(not(unix))] { person_workspace_usage_portable(root, limit) }
}

#[cfg(unix)]
fn person_workspace_usage_unix(root: &Path, limit: usize) -> Result<u64, PersonWorkspaceError> {
    use std::os::{fd::{AsRawFd, FromRawFd, OwnedFd}, unix::fs::OpenOptionsExt};
    fn walk(fd: std::os::fd::RawFd, left: &mut usize, used: &mut u64, depth: usize) -> Result<(), PersonWorkspaceError> {
        if depth > 128 { return Err(PersonWorkspaceError::Unavailable); }
        let copy = unsafe { libc::dup(fd) };
        if copy < 0 { return Err(PersonWorkspaceError::Unavailable); }
        let stream = unsafe { libc::fdopendir(copy) };
        if stream.is_null() { unsafe { libc::close(copy); } return Err(PersonWorkspaceError::Unavailable); }
        struct PersonDir(*mut libc::DIR);
        impl Drop for PersonDir { fn drop(&mut self) { unsafe { libc::closedir(self.0); } } }
        let stream = PersonDir(stream);
        loop {
            // Distinguish end of stream from an IO error. No await/thread hop
            // occurs between readdir and reading this thread's errno.
            #[cfg(target_os = "linux")] unsafe { *libc::__errno_location() = 0; }
            #[cfg(target_os = "macos")] unsafe { *libc::__error() = 0; }
            let entry = unsafe { libc::readdir(stream.0) };
            if entry.is_null() {
                #[cfg(any(target_os = "linux", target_os = "macos"))]
                if std::io::Error::last_os_error().raw_os_error() != Some(0) { return Err(PersonWorkspaceError::Unavailable); }
                break;
            }
            let name = unsafe { std::ffi::CStr::from_ptr((*entry).d_name.as_ptr()) };
            if matches!(name.to_bytes(), b"." | b"..") { continue; }
            if *left == 0 { return Err(PersonWorkspaceError::Unavailable); }
            *left -= 1;
            let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
            if unsafe { libc::fstatat(fd, name.as_ptr(), metadata.as_mut_ptr(), libc::AT_SYMLINK_NOFOLLOW) } != 0 {
                if std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound { continue; }
                return Err(PersonWorkspaceError::Unavailable);
            }
            let metadata = unsafe { metadata.assume_init() };
            if metadata.st_mode & libc::S_IFMT == libc::S_IFDIR {
                let child = unsafe { libc::openat(fd, name.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
                if child < 0 { return Err(PersonWorkspaceError::Unavailable); }
                let child = unsafe { OwnedFd::from_raw_fd(child) };
                walk(child.as_raw_fd(), left, used, depth + 1)?;
            } else { *used = used.saturating_add(metadata.st_size.max(0) as u64); }
        }
        Ok(())
    }
    let directory = std::fs::OpenOptions::new().read(true).custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(root).map_err(|_| PersonWorkspaceError::Unavailable)?;
    let mut used = 0;
    walk(directory.as_raw_fd(), &mut { limit }, &mut used, 0)?;
    Ok(used)
}

#[cfg(not(unix))]
fn person_workspace_usage_portable(root: &Path, limit: usize) -> Result<u64, PersonWorkspaceError> {
    let metadata = std::fs::symlink_metadata(root).map_err(|_| PersonWorkspaceError::Unavailable)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() { return Err(PersonWorkspaceError::Mount); }
    let mut stack = vec![std::fs::read_dir(root).map_err(|_| PersonWorkspaceError::Unavailable)?];
    let mut entries = 0usize;
    let mut used = 0u64;
    while let Some(directory) = stack.last_mut() {
        match directory.next() {
            None => { stack.pop(); }
            Some(entry) => {
                entries += 1;
                if entries > limit { return Err(PersonWorkspaceError::Unavailable); }
                let entry = entry.map_err(|_| PersonWorkspaceError::Unavailable)?;
                let metadata = std::fs::symlink_metadata(entry.path()).map_err(|_| PersonWorkspaceError::Unavailable)?;
                if metadata.is_dir() {
                    stack.push(std::fs::read_dir(entry.path()).map_err(|_| PersonWorkspaceError::Unavailable)?);
                } else { used = used.saturating_add(metadata.len()); }
            }
        }
    }
    Ok(used)
}

pub fn person_workspace_remove(policy: &crate::presets::SpawnPolicy, account: &str) -> Result<(), PersonWorkspaceError> {
    let path = person_workspace_path(policy, account)?;
    match std::fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(PersonWorkspaceError::Unavailable),
        Ok(metadata) if metadata.file_type().is_symlink() => return Err(PersonWorkspaceError::Mount),
        _ => (),
    }
    let base = policy.workspaces_dir().canonicalize().map_err(|_| PersonWorkspaceError::Unavailable)?;
    let root = path.canonicalize().map_err(|_| PersonWorkspaceError::Unavailable)?;
    if root != base.join("persons").join(account) { return Err(PersonWorkspaceError::Mount); }
    std::fs::remove_dir_all(root).map_err(|_| PersonWorkspaceError::Unavailable)
}

#[cfg(test)]
mod tests {
    use super::*;
    const ACCOUNT: &str = "pb_0123456789abcdef01234567";
    #[test]
    fn p6d_workspace_owner_cwd_quota_and_bounded_walk() {
        let temp = tempfile::tempdir().unwrap();
        let policy = crate::presets::SpawnPolicy::new(temp.path().into(), false);
        let (root, cwd) = person_workspace_prepare(&policy, ACCOUNT, None, 100).unwrap();
        assert_eq!(cwd, root);
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; assert_eq!(std::fs::metadata(&root).unwrap().permissions().mode() & 0o777, 0o700); }
        std::fs::create_dir(root.join("child")).unwrap();
        assert_eq!(person_workspace_cwd(&root, Some("child")).unwrap(), root.join("child"));
        assert!(person_workspace_cwd(&root, Some(temp.path().to_str().unwrap())).is_err());
        #[cfg(unix)] {
            std::os::unix::fs::symlink(temp.path(), root.join("escape")).unwrap();
            assert!(person_workspace_cwd(&root, Some("escape")).is_err());
            std::fs::remove_file(root.join("escape")).unwrap();
        }
        std::fs::write(root.join("child/file"), [0u8;100]).unwrap();
        assert_eq!(person_workspace_usage(&root, 10).unwrap(), 100);
        assert!(matches!(person_workspace_prepare(&policy, ACCOUNT, None, 100), Err(PersonWorkspaceError::Quota { used_bytes:100, max_bytes:100 })));
        assert!(person_workspace_usage(&root, 1).is_err());
        assert!(person_workspace_path(&policy, "../other").is_err());
        person_workspace_remove(&policy, ACCOUNT).unwrap();
        assert!(!root.exists());
    }
    #[test]
    fn p6d_workspace_cap_env_validation() {
        for value in [None, Some("0")] { assert_eq!(person_workspace_max_bytes_from(value).unwrap(), PERSON_WORKSPACE_DEFAULT_MAX_BYTES); }
        assert_eq!(person_workspace_max_bytes_from(Some("12")).unwrap(), 12);
        for value in ["", "-1", "1.5", "bad", "18446744073709551616"] { assert!(person_workspace_max_bytes_from(Some(value)).is_err()); }
    }
}

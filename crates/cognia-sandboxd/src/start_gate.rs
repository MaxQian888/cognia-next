//! The start gate of a remote sandbox instance (ADR-0221).
//!
//! A Kubernetes pod cannot be created with its main process held back, and
//! the supervisor (`serve`) must not start before the driver has cloned the
//! workspace: it runs the devcontainer lifecycle hooks as it boots, and they
//! expect the repository to be there. So the pod's main container runs
//!
//! ```text
//! cognia-sandboxd await-start --marker /tmp/cognia-sandboxd/start -- <supervisor argv…>
//! ```
//!
//! which waits for the marker and then replaces itself with the supervisor
//! (so the supervisor is PID 1), and the driver, once the clone is done, runs
//! `cognia-sandboxd release-start --marker …` over exec.
//!
//! A Kubernetes `emptyDir` is created mode `0777` without the sticky bit,
//! where Docker's `/tmp` tmpfs is `1777`. The marker and the supervisor's
//! control socket live under `/tmp`, and a world-writable non-sticky `/tmp`
//! would let any user rename root's directory away and plant their own, so
//! `await-start --sticky /tmp` restores the sticky bit before anything else
//! runs ([`make_sticky`]).
//!
//! The marker is a capability, so it is checked rather than trusted: it must
//! be a regular file (not a symlink) owned by root with no group or other
//! write bit, in a directory owned by root that only root can enter. Anything
//! else is refused, never repaired: a marker someone else planted is evidence,
//! and removing it would hide it.

use std::ffi::CString;
use std::fs::{self, File, OpenOptions};
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::Path;
use std::time::{Duration, Instant};

/// How long `await-start` waits by default before giving up.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(3600);

/// How often `await-start` looks for the marker.
pub const POLL_INTERVAL: Duration = Duration::from_millis(200);

/// What one look at the marker found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MarkerState {
    /// Neither the marker nor (possibly) its directory exists yet.
    Absent,
    /// The marker exists and passes every check.
    Released,
}

/// What `release-start` did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReleaseOutcome {
    Created,
    /// A valid marker was already there: releasing twice is not an error.
    AlreadyReleased,
}

/// The directory and file name of an absolute marker path.
fn split_marker(marker: &Path) -> io::Result<(&Path, CString)> {
    if !marker.is_absolute() {
        return Err(invalid(format!(
            "start marker {} is not an absolute path",
            marker.display()
        )));
    }
    let name = marker.file_name().ok_or_else(|| {
        invalid(format!(
            "start marker {} has no file name",
            marker.display()
        ))
    })?;
    let parent = marker
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| {
            invalid(format!(
                "start marker {} has no directory",
                marker.display()
            ))
        })?;
    let name = CString::new(name.as_bytes())
        .map_err(|_| invalid("start marker name contains a NUL byte"))?;
    Ok((parent, name))
}

/// Open the marker directory without following a symlink and require it to
/// be owned by `owner` with no group or other access. `Ok(None)` when it does
/// not exist yet.
fn open_private_directory(path: &Path, owner: u32) -> io::Result<Option<File>> {
    let directory = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
    {
        Ok(directory) => directory,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        // O_NOFOLLOW on a symlink and O_DIRECTORY on a file both land here.
        Err(error) => {
            return Err(refused(format!(
                "start marker directory {} cannot be opened as a directory: {error}",
                path.display()
            )))
        }
    };
    let metadata = directory.metadata()?;
    if metadata.uid() != owner {
        return Err(refused(format!(
            "start marker directory {} is owned by uid {}, not {owner}",
            path.display(),
            metadata.uid()
        )));
    }
    if metadata.mode() & 0o077 != 0 {
        return Err(refused(format!(
            "start marker directory {} is accessible to group or others (mode {:o})",
            path.display(),
            metadata.mode() & 0o7777
        )));
    }
    Ok(Some(directory))
}

/// `fstatat(directory, name, AT_SYMLINK_NOFOLLOW)`; `Ok(None)` when absent.
fn stat_entry(directory: &File, name: &CString) -> io::Result<Option<libc::stat>> {
    // SAFETY: an all-zero `stat` is a valid value for the out parameter.
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    // SAFETY: the directory fd is open for the duration of the call, `name`
    // is a NUL-terminated string and `stat` is a valid out pointer.
    let result = unsafe {
        libc::fstatat(
            directory.as_raw_fd(),
            name.as_ptr(),
            &mut stat,
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if result == 0 {
        return Ok(Some(stat));
    }
    let error = io::Error::last_os_error();
    if error.kind() == io::ErrorKind::NotFound {
        Ok(None)
    } else {
        Err(error)
    }
}

/// The checks a present marker must pass.
fn check_marker_stat(stat: &libc::stat, owner: u32, marker: &Path) -> io::Result<()> {
    let kind = stat.st_mode & libc::S_IFMT;
    if kind != libc::S_IFREG {
        return Err(refused(format!(
            "start marker {} is not a regular file",
            marker.display()
        )));
    }
    if stat.st_uid != owner {
        return Err(refused(format!(
            "start marker {} is owned by uid {}, not {owner}",
            marker.display(),
            stat.st_uid
        )));
    }
    if u32::from(stat.st_mode) & 0o022 != 0 {
        return Err(refused(format!(
            "start marker {} is writable by group or others (mode {:o})",
            marker.display(),
            u32::from(stat.st_mode) & 0o7777
        )));
    }
    Ok(())
}

/// Look at the marker once. An `Err` is a marker (or directory) that exists
/// but fails the checks, or an I/O failure other than "not there yet".
pub fn inspect_marker(marker: &Path, owner: u32) -> io::Result<MarkerState> {
    let (parent, name) = split_marker(marker)?;
    let Some(directory) = open_private_directory(parent, owner)? else {
        return Ok(MarkerState::Absent);
    };
    match stat_entry(&directory, &name)? {
        None => Ok(MarkerState::Absent),
        Some(stat) => {
            check_marker_stat(&stat, owner, marker)?;
            Ok(MarkerState::Released)
        }
    }
}

/// Poll until the marker is released by `owner`, failing at once on a marker
/// that fails the checks and with `TimedOut` after `timeout`.
pub fn await_marker(
    marker: &Path,
    owner: u32,
    timeout: Duration,
    poll: Duration,
) -> io::Result<()> {
    let started = Instant::now();
    loop {
        if inspect_marker(marker, owner)? == MarkerState::Released {
            return Ok(());
        }
        let elapsed = started.elapsed();
        if elapsed >= timeout {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                format!(
                    "start marker {} was not released within {}s",
                    marker.display(),
                    timeout.as_secs()
                ),
            ));
        }
        std::thread::sleep(poll.min(timeout - elapsed));
    }
}

/// Create the marker as the calling user (root in a sandbox): the directory
/// `0700` if missing, then the file with `O_CREAT|O_EXCL`, mode `0600`.
pub fn release_marker(marker: &Path) -> io::Result<ReleaseOutcome> {
    let owner = effective_uid();
    let (parent, name) = split_marker(marker)?;
    match fs::create_dir(parent) {
        Ok(()) => fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    let directory = open_private_directory(parent, owner)?.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            format!(
                "start marker directory {} vanished while releasing",
                parent.display()
            ),
        )
    })?;
    // SAFETY: the directory fd is open for the call and `name` is a
    // NUL-terminated string; the returned fd is owned below.
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600 as libc::c_uint,
        )
    };
    if fd < 0 {
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::AlreadyExists {
            return Err(error);
        }
        let stat = stat_entry(&directory, &name)?.ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                format!("start marker {} vanished while releasing", marker.display()),
            )
        })?;
        check_marker_stat(&stat, owner, marker)?;
        return Ok(ReleaseOutcome::AlreadyReleased);
    }
    // SAFETY: `fd` is a freshly opened descriptor nothing else owns.
    let file = unsafe { <File as std::os::fd::FromRawFd>::from_raw_fd(fd) };
    // The umask may have narrowed the mode further; never widen past 0600.
    file.set_permissions(fs::Permissions::from_mode(0o600))?;
    file.sync_all()?;
    Ok(ReleaseOutcome::Created)
}

/// Set mode `1777` on `dir`: a real directory (not a symlink) owned by
/// `owner`. What a shared scratch directory needs so one user cannot remove
/// or rename another's entries.
pub fn make_sticky(dir: &Path, owner: u32) -> io::Result<()> {
    let directory = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(dir)
        .map_err(|error| {
            io::Error::new(
                error.kind(),
                format!("cannot open {} as a directory: {error}", dir.display()),
            )
        })?;
    let metadata = directory.metadata()?;
    if metadata.uid() != owner {
        return Err(refused(format!(
            "{} is owned by uid {}, not {owner}",
            dir.display(),
            metadata.uid()
        )));
    }
    directory.set_permissions(fs::Permissions::from_mode(0o1777))
}

/// Replace this process with `argv` once the marker is released by root,
/// after giving every `sticky` directory its sticky bit. Returns only on
/// failure.
pub fn await_then_exec(
    marker: &Path,
    timeout: Duration,
    sticky: &[std::path::PathBuf],
    argv: &[std::ffi::OsString],
) -> io::Error {
    let Some((program, args)) = argv.split_first() else {
        return invalid("await-start needs a command to run");
    };
    for dir in sticky {
        if let Err(error) = make_sticky(dir, 0) {
            return error;
        }
    }
    if let Err(error) = await_marker(marker, 0, timeout, POLL_INTERVAL) {
        return error;
    }
    use std::os::unix::process::CommandExt;
    std::process::Command::new(program).args(args).exec()
}

fn effective_uid() -> u32 {
    // SAFETY: geteuid has no preconditions and cannot fail.
    unsafe { libc::geteuid() }
}

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message.into())
}

fn refused(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, message.into())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn uid() -> u32 {
        effective_uid()
    }

    fn marker_in(root: &Path) -> PathBuf {
        root.join("gate").join("start")
    }

    #[test]
    fn relative_and_nameless_markers_are_refused() {
        assert_eq!(
            inspect_marker(Path::new("relative/start"), 0)
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidInput
        );
        assert_eq!(
            inspect_marker(Path::new("/"), 0).unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
        assert_eq!(
            release_marker(Path::new("start")).unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
    }

    #[test]
    fn a_missing_directory_or_marker_is_absent() {
        let root = tempfile::tempdir().unwrap();
        let marker = marker_in(root.path());
        assert_eq!(inspect_marker(&marker, uid()).unwrap(), MarkerState::Absent);
        fs::create_dir(marker.parent().unwrap()).unwrap();
        fs::set_permissions(marker.parent().unwrap(), fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(inspect_marker(&marker, uid()).unwrap(), MarkerState::Absent);
    }

    #[test]
    fn release_creates_a_private_marker_and_is_idempotent() {
        let root = tempfile::tempdir().unwrap();
        let marker = marker_in(root.path());
        assert_eq!(release_marker(&marker).unwrap(), ReleaseOutcome::Created);
        let directory = fs::metadata(marker.parent().unwrap()).unwrap();
        assert_eq!(directory.mode() & 0o777, 0o700);
        assert_eq!(directory.uid(), uid());
        let file = fs::symlink_metadata(&marker).unwrap();
        assert!(file.file_type().is_file());
        assert_eq!(file.mode() & 0o777, 0o600);
        assert_eq!(
            inspect_marker(&marker, uid()).unwrap(),
            MarkerState::Released
        );
        assert_eq!(
            release_marker(&marker).unwrap(),
            ReleaseOutcome::AlreadyReleased
        );
    }

    #[test]
    fn release_refuses_an_existing_marker_that_fails_the_checks() {
        let root = tempfile::tempdir().unwrap();
        let marker = marker_in(root.path());
        release_marker(&marker).unwrap();
        fs::set_permissions(&marker, fs::Permissions::from_mode(0o666)).unwrap();
        let error = release_marker(&marker).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied, "{error}");
        // Nothing was removed or repaired.
        assert_eq!(fs::metadata(&marker).unwrap().mode() & 0o777, 0o666);
    }

    #[test]
    fn release_refuses_a_shared_directory() {
        let root = tempfile::tempdir().unwrap();
        let marker = marker_in(root.path());
        fs::create_dir(marker.parent().unwrap()).unwrap();
        fs::set_permissions(marker.parent().unwrap(), fs::Permissions::from_mode(0o777)).unwrap();
        let error = release_marker(&marker).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied, "{error}");
        assert!(!marker.exists());
    }

    #[test]
    fn a_symlinked_marker_or_directory_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let marker = marker_in(root.path());
        release_marker(&marker).unwrap();
        let elsewhere = root.path().join("elsewhere");
        fs::write(&elsewhere, b"").unwrap();
        fs::set_permissions(&elsewhere, fs::Permissions::from_mode(0o600)).unwrap();
        let link = marker.parent().unwrap().join("linked");
        std::os::unix::fs::symlink(&elsewhere, &link).unwrap();
        let error = inspect_marker(&link, uid()).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied, "{error}");
        assert!(error.to_string().contains("not a regular file"), "{error}");

        let linked_dir = root.path().join("linked-dir");
        std::os::unix::fs::symlink(marker.parent().unwrap(), &linked_dir).unwrap();
        let error = inspect_marker(&linked_dir.join("start"), uid()).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied, "{error}");
    }

    #[test]
    fn a_marker_owned_by_someone_else_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let marker = marker_in(root.path());
        release_marker(&marker).unwrap();
        let other = uid().wrapping_add(1);
        let error = inspect_marker(&marker, other).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied, "{error}");
        assert!(error.to_string().contains("owned by uid"), "{error}");
    }

    #[test]
    fn a_group_writable_marker_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let marker = marker_in(root.path());
        release_marker(&marker).unwrap();
        fs::set_permissions(&marker, fs::Permissions::from_mode(0o620)).unwrap();
        let error = inspect_marker(&marker, uid()).unwrap_err();
        assert!(error.to_string().contains("writable"), "{error}");
        // A read bit for others is fine: the marker carries no secret.
        fs::set_permissions(&marker, fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(
            inspect_marker(&marker, uid()).unwrap(),
            MarkerState::Released
        );
    }

    #[test]
    fn a_directory_in_place_of_the_marker_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let marker = marker_in(root.path());
        release_marker(&root.path().join("gate").join("other")).unwrap();
        fs::create_dir(&marker).unwrap();
        fs::set_permissions(&marker, fs::Permissions::from_mode(0o700)).unwrap();
        let error = inspect_marker(&marker, uid()).unwrap_err();
        assert!(error.to_string().contains("not a regular file"), "{error}");
    }

    #[test]
    fn await_times_out_without_a_release() {
        let root = tempfile::tempdir().unwrap();
        let marker = marker_in(root.path());
        let started = Instant::now();
        let error = await_marker(
            &marker,
            uid(),
            Duration::from_millis(150),
            Duration::from_millis(20),
        )
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(started.elapsed() >= Duration::from_millis(150));
    }

    #[test]
    fn await_returns_once_another_thread_releases() {
        let root = tempfile::tempdir().unwrap();
        let marker = marker_in(root.path());
        let releaser = {
            let marker = marker.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(60));
                release_marker(&marker).unwrap();
            })
        };
        await_marker(
            &marker,
            uid(),
            Duration::from_secs(5),
            Duration::from_millis(10),
        )
        .unwrap();
        releaser.join().unwrap();
    }

    #[test]
    fn await_fails_at_once_on_a_planted_marker() {
        let root = tempfile::tempdir().unwrap();
        let marker = marker_in(root.path());
        release_marker(&marker).unwrap();
        fs::set_permissions(&marker, fs::Permissions::from_mode(0o666)).unwrap();
        let started = Instant::now();
        let error = await_marker(
            &marker,
            uid(),
            Duration::from_secs(30),
            Duration::from_millis(10),
        )
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(marker.exists(), "a refused marker is never removed");
    }

    #[test]
    fn exec_without_a_command_is_refused() {
        let error = await_then_exec(Path::new("/nonexistent/start"), Duration::ZERO, &[], &[]);
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    }

    #[test]
    fn a_shared_directory_gets_the_sticky_bit() {
        let root = tempfile::tempdir().unwrap();
        let scratch = root.path().join("tmp");
        fs::create_dir(&scratch).unwrap();
        fs::set_permissions(&scratch, fs::Permissions::from_mode(0o777)).unwrap();
        make_sticky(&scratch, uid()).unwrap();
        assert_eq!(fs::metadata(&scratch).unwrap().mode() & 0o7777, 0o1777);
    }

    #[test]
    fn sticky_refuses_symlinks_foreign_owners_and_files() {
        let root = tempfile::tempdir().unwrap();
        let scratch = root.path().join("tmp");
        fs::create_dir(&scratch).unwrap();
        fs::set_permissions(&scratch, fs::Permissions::from_mode(0o755)).unwrap();
        let link = root.path().join("link");
        std::os::unix::fs::symlink(&scratch, &link).unwrap();
        assert!(make_sticky(&link, uid()).is_err());
        let error = make_sticky(&scratch, uid().wrapping_add(1)).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        let file = root.path().join("file");
        fs::write(&file, b"").unwrap();
        assert!(make_sticky(&file, uid()).is_err());
        // Nothing was changed by a refusal.
        assert_eq!(fs::metadata(&scratch).unwrap().mode() & 0o7777, 0o755);
    }
}

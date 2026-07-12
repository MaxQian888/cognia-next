// Atomic-write helper used by every settings writer that overlaps with
// external tools that may also write the same file (CCSwitch ⇄ Claude Code,
// CCSwitch ⇄ Codex CLI, etc.).
//
// Two layers of safety:
//
//   1. Temp-file + rename atomic publish — the on-disk file is never partial.
//      A `.bak.<epoch_secs>` is left next to the original so the user can
//      recover if our merge logic mangles something.
//
//   2. Optional mtime check — the caller passes the `SystemTime` it observed
//      when it last *read* the file. If the current mtime differs, the file
//      has been modified by another writer since we loaded it, so our staged
//      contents are stale. We bail with `AtomicWriteError::DriftDetected`
//      and the caller re-reads + retries.
//
// The mtime check is voluntary — pass `expected_mtime: None` to disable it
// (callers that build the file from scratch can skip it).

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// Inputs for one atomic write. Built by callers after reading the existing
/// file (if any) so the `expected_mtime` reflects "what we saw on read".
pub struct AtomicWritePlan {
    /// Final destination path.
    pub path: PathBuf,
    /// The mtime the caller observed when it read the existing file. `None`
    /// disables the drift check entirely (useful when creating a brand-new
    /// file or when the caller explicitly wants last-writer-wins semantics).
    pub expected_mtime: Option<SystemTime>,
    /// Suffix appended after the file extension for the temp file —
    /// e.g. `"tmp"` becomes `path.with_extension("<ext>.tmp")`.
    pub tmp_suffix: String,
    /// Suffix for the pre-write backup file. A monotonic timestamp is appended.
    /// `"bak"` becomes `path.with_extension("<ext>.bak.<ts>")`.
    pub backup_suffix: String,
}

#[derive(Debug)]
pub enum AtomicWriteError {
    /// File was modified by another writer after we read it. Caller must
    /// re-read and reconcile before retrying.
    DriftDetected {
        expected: SystemTime,
        current: SystemTime,
    },
    /// All other underlying I/O / OS errors.
    Io(std::io::Error),
}

impl std::fmt::Display for AtomicWriteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AtomicWriteError::DriftDetected { expected, current } => {
                let exp = expected.duration_since(UNIX_EPOCH).ok();
                let cur = current.duration_since(UNIX_EPOCH).ok();
                write!(
                    f,
                    "drift_detected: file mtime changed since read (expected {exp:?}, current {cur:?})"
                )
            }
            AtomicWriteError::Io(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for AtomicWriteError {}

impl From<std::io::Error> for AtomicWriteError {
    fn from(e: std::io::Error) -> Self {
        AtomicWriteError::Io(e)
    }
}

/// Sentinel string the renderer matches on for the "another tool wrote
/// this file while we were preparing the patch" case. Keep the literal in
/// sync with the frontend's `provider-switch-dialog` drift handling.
pub const DRIFT_DETECTED_TAG: &str = "drift_detected";

/// Result of a successful atomic write.
#[derive(Debug)]
pub struct AtomicWriteResult {
    /// Destination path (echoed back).
    pub path: PathBuf,
    /// Backup path that was created, when the destination already existed.
    pub backup_path: Option<PathBuf>,
}

fn unique_backup_stamp() -> u64 {
    static LAST_BACKUP_STAMP: AtomicU64 = AtomicU64::new(0);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos().min(u64::MAX as u128) as u64)
        .unwrap_or(0);

    loop {
        let last = LAST_BACKUP_STAMP.load(Ordering::Relaxed);
        let next = if now > last {
            now
        } else {
            last.saturating_add(1)
        };
        if LAST_BACKUP_STAMP
            .compare_exchange(last, next, Ordering::Relaxed, Ordering::Relaxed)
            .is_ok()
        {
            return next;
        }
    }
}

/// Atomically write `contents` to `plan.path`, optionally checking that the
/// destination's mtime still matches what the caller observed on read.
///
/// Order of operations:
///   1. Compare mtime (if expected_mtime is Some).
///   2. Copy current file (if any) to `<path>.<ext>.bak.<epoch_secs>`.
///   3. Write contents to `<path>.<ext>.tmp` and fsync.
///   4. Rename tmp into place.
///
/// On failure at any step beyond (1), the tmp file is best-effort cleaned up.
pub fn atomic_write_with_mtime_check(
    plan: &AtomicWritePlan,
    contents: &[u8],
) -> Result<AtomicWriteResult, AtomicWriteError> {
    // 1. mtime drift check.
    if let Some(expected) = plan.expected_mtime {
        if plan.path.exists() {
            let meta = fs::metadata(&plan.path)?;
            let current = meta.modified()?;
            if !mtimes_equal(expected, current) {
                return Err(AtomicWriteError::DriftDetected { expected, current });
            }
        }
        // If the caller asserted a specific mtime and the file is now gone,
        // that's also drift: someone deleted it between read and write.
        else {
            return Err(AtomicWriteError::DriftDetected {
                expected,
                current: SystemTime::UNIX_EPOCH,
            });
        }
    }

    // Resolve the suffix-stamped backup / tmp paths.
    let ext = plan.path.extension().and_then(|s| s.to_str()).unwrap_or("");
    let backup_path = if plan.path.exists() {
        let ts = unique_backup_stamp();
        // Always prepend the original extension so "<file>.json.bak.<ts>" is
        // the canonical shape. Empty extensions degrade gracefully to
        // "<file>.bak.<ts>".
        let suffix = if ext.is_empty() {
            format!("{}.{}", plan.backup_suffix, ts)
        } else {
            format!("{}.{}.{}", ext, plan.backup_suffix, ts)
        };
        let bp = plan.path.with_extension(suffix);
        fs::copy(&plan.path, &bp)?;
        Some(bp)
    } else {
        None
    };

    // 3. Stage to tmp + fsync.
    let tmp_suffix = if ext.is_empty() {
        plan.tmp_suffix.clone()
    } else {
        format!("{}.{}", ext, plan.tmp_suffix)
    };
    let tmp_path = plan.path.with_extension(tmp_suffix);
    {
        let mut f = fs::File::create(&tmp_path)?;
        f.write_all(contents)?;
        f.sync_all().ok();
    }

    // 4. Rename atomically.
    if let Err(e) = fs::rename(&tmp_path, &plan.path) {
        // Best-effort cleanup.
        let _ = fs::remove_file(&tmp_path);
        return Err(AtomicWriteError::Io(e));
    }

    Ok(AtomicWriteResult {
        path: plan.path.clone(),
        backup_path,
    })
}

/// Prune `<file>.<ext>.bak.<timestamp>` backups left by
/// `atomic_write_with_mtime_check`, keeping the `keep` most-recent ones and
/// deleting the rest (oldest-first). The active file at `path` is never
/// touched. `keep == 0` removes every backup.
///
/// Matching is intentionally narrow: only sibling files whose name is
/// `<path file_name>.bak.<digits>` are considered backups. This is the exact
/// shape the atomic writer produces (`with_extension("<ext>.bak.<ts>")`),
/// so unrelated files in the directory are never deleted.
///
/// Best-effort: I/O errors enumerating or removing individual entries are
/// swallowed so a failed rotation never aborts the surrounding write. Returns
/// the list of paths that were removed (useful for tests / logging).
pub fn rotate_backups(path: &Path, keep: usize) -> Vec<PathBuf> {
    let dir = match path.parent() {
        Some(d) => d,
        None => return Vec::new(),
    };
    let file_name = match path.file_name().and_then(|s| s.to_str()) {
        Some(n) => n,
        None => return Vec::new(),
    };
    // Backups are "<file_name>.bak.<epoch_secs>". We capture the trailing
    // timestamp to sort by; the suffix after the last '.' must be all-digits.
    let prefix = format!("{file_name}.bak.");

    let mut backups: Vec<(u64, PathBuf)> = Vec::new();
    let read_dir = match fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) => return Vec::new(),
    };
    for entry in read_dir.flatten() {
        let name_os = entry.file_name();
        let name = match name_os.to_str() {
            Some(n) => n,
            None => continue,
        };
        let Some(ts_str) = name.strip_prefix(&prefix) else {
            continue;
        };
        // Guard against matching e.g. "<file>.bak.5.tmp" — require a pure
        // numeric tail so only canonical backups are candidates for deletion.
        let Ok(ts) = ts_str.parse::<u64>() else {
            continue;
        };
        backups.push((ts, entry.path()));
    }

    if backups.len() <= keep {
        return Vec::new();
    }

    // Sort newest-first by timestamp; tie-break on path for determinism on
    // filesystems that collapse multiple writes into the same second.
    backups.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));

    let mut removed = Vec::new();
    for (_, p) in backups.into_iter().skip(keep) {
        if fs::remove_file(&p).is_ok() {
            removed.push(p);
        }
    }
    removed
}

/// Read a file and return its raw bytes + the mtime observed at read time.
/// Returns `Ok((bytes, mtime))` if the file exists, `Ok((vec![], None))` if
/// it doesn't (callers building from scratch).
pub fn read_with_mtime(path: &Path) -> Result<(Vec<u8>, Option<SystemTime>), std::io::Error> {
    match fs::metadata(path) {
        Ok(meta) => {
            let mtime = meta.modified().ok();
            let bytes = fs::read(path)?;
            Ok((bytes, mtime))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok((Vec::new(), None)),
        Err(e) => Err(e),
    }
}

/// mtime comparison with a small tolerance — some filesystems only resolve
/// to seconds (FAT32, some NFS), so we treat differences < 1ms as equal.
/// This guards against false positives when a caller reads + writes in the
/// same millisecond.
fn mtimes_equal(a: SystemTime, b: SystemTime) -> bool {
    if a == b {
        return true;
    }
    let delta = a.duration_since(b).or_else(|_| b.duration_since(a));
    matches!(delta, Ok(d) if d.as_millis() < 1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::thread;
    use std::time::Duration;

    static TMPDIR_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn tmpdir() -> PathBuf {
        let base = std::env::temp_dir();
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let unique = TMPDIR_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = base.join(format!(
            "cognia-fs-atomic-{}-{nanos}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn writes_new_file_without_mtime_check() {
        let dir = tmpdir();
        let path = dir.join("config.json");
        let plan = AtomicWritePlan {
            path: path.clone(),
            expected_mtime: None,
            tmp_suffix: "tmp".into(),
            backup_suffix: "bak".into(),
        };
        let out = atomic_write_with_mtime_check(&plan, b"{}\n").unwrap();
        assert_eq!(out.path, path);
        assert!(out.backup_path.is_none());
        assert_eq!(fs::read_to_string(&path).unwrap(), "{}\n");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn overwrites_existing_and_creates_backup() {
        let dir = tmpdir();
        let path = dir.join("config.json");
        fs::write(&path, "old").unwrap();
        let (_bytes, mtime) = read_with_mtime(&path).unwrap();
        let plan = AtomicWritePlan {
            path: path.clone(),
            expected_mtime: mtime,
            tmp_suffix: "tmp".into(),
            backup_suffix: "bak".into(),
        };
        let out = atomic_write_with_mtime_check(&plan, b"new").unwrap();
        let bp = out.backup_path.expect("backup should be created");
        assert!(bp.exists(), "backup path must exist: {bp:?}");
        assert_eq!(fs::read_to_string(&path).unwrap(), "new");
        assert_eq!(fs::read_to_string(&bp).unwrap(), "old");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn drift_detected_when_mtime_changes() {
        let dir = tmpdir();
        let path = dir.join("config.json");
        fs::write(&path, "v1").unwrap();
        let (_bytes, mtime) = read_with_mtime(&path).unwrap();
        // Sleep long enough to guarantee a fresh mtime tick even on
        // second-resolution filesystems.
        thread::sleep(Duration::from_millis(1100));
        fs::write(&path, "v2-external").unwrap();
        let plan = AtomicWritePlan {
            path: path.clone(),
            expected_mtime: mtime,
            tmp_suffix: "tmp".into(),
            backup_suffix: "bak".into(),
        };
        let err = atomic_write_with_mtime_check(&plan, b"v3-ours").unwrap_err();
        match err {
            AtomicWriteError::DriftDetected { .. } => {
                assert_eq!(fs::read_to_string(&path).unwrap(), "v2-external");
            }
            other => panic!("expected DriftDetected, got {other:?}"),
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn drift_detected_when_file_deleted() {
        let dir = tmpdir();
        let path = dir.join("config.json");
        fs::write(&path, "v1").unwrap();
        let (_bytes, mtime) = read_with_mtime(&path).unwrap();
        fs::remove_file(&path).unwrap();
        let plan = AtomicWritePlan {
            path: path.clone(),
            expected_mtime: mtime,
            tmp_suffix: "tmp".into(),
            backup_suffix: "bak".into(),
        };
        let err = atomic_write_with_mtime_check(&plan, b"v2").unwrap_err();
        assert!(matches!(err, AtomicWriteError::DriftDetected { .. }));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn no_drift_when_mtime_matches() {
        let dir = tmpdir();
        let path = dir.join("config.json");
        fs::write(&path, "v1").unwrap();
        let (_bytes, mtime) = read_with_mtime(&path).unwrap();
        let plan = AtomicWritePlan {
            path: path.clone(),
            expected_mtime: mtime,
            tmp_suffix: "tmp".into(),
            backup_suffix: "bak".into(),
        };
        let out = atomic_write_with_mtime_check(&plan, b"v2-ours").unwrap();
        assert!(out.backup_path.is_some());
        assert_eq!(fs::read_to_string(&path).unwrap(), "v2-ours");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn backup_includes_extension_in_suffix() {
        let dir = tmpdir();
        let path = dir.join("settings.json");
        fs::write(&path, "x").unwrap();
        let plan = AtomicWritePlan {
            path: path.clone(),
            expected_mtime: None,
            tmp_suffix: "tmp".into(),
            backup_suffix: "bak".into(),
        };
        let out = atomic_write_with_mtime_check(&plan, b"y").unwrap();
        let bp_name = out
            .backup_path
            .as_ref()
            .unwrap()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert!(
            bp_name.starts_with("settings.json.bak."),
            "unexpected backup name: {bp_name}"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rapid_writes_create_distinct_backups() {
        let dir = tmpdir();
        let path = dir.join("settings.json");
        fs::write(&path, "v1").unwrap();
        let plan = AtomicWritePlan {
            path: path.clone(),
            expected_mtime: None,
            tmp_suffix: "tmp".into(),
            backup_suffix: "bak".into(),
        };

        let first = atomic_write_with_mtime_check(&plan, b"v2")
            .unwrap()
            .backup_path
            .expect("first write should back up v1");
        let second = atomic_write_with_mtime_check(&plan, b"v3")
            .unwrap()
            .backup_path
            .expect("second write should back up v2");

        assert_ne!(first, second, "rapid writes must not reuse backup paths");
        assert_eq!(fs::read_to_string(first).unwrap(), "v1");
        assert_eq!(fs::read_to_string(second).unwrap(), "v2");
        assert_eq!(fs::read_to_string(&path).unwrap(), "v3");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rotate_backups_keeps_newest_and_removes_oldest() {
        let dir = tmpdir();
        let path = dir.join("auth.json");
        fs::write(&path, "active").unwrap();
        // Create 5 backups with ascending timestamps.
        for ts in [100u64, 200, 300, 400, 500] {
            fs::write(dir.join(format!("auth.json.bak.{ts}")), "b").unwrap();
        }
        let removed = rotate_backups(&path, 2);
        assert_eq!(removed.len(), 3);
        // The two newest (400, 500) survive; 100/200/300 are gone.
        assert!(dir.join("auth.json.bak.500").exists());
        assert!(dir.join("auth.json.bak.400").exists());
        assert!(!dir.join("auth.json.bak.300").exists());
        assert!(!dir.join("auth.json.bak.200").exists());
        assert!(!dir.join("auth.json.bak.100").exists());
        // Active file is never touched.
        assert!(path.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rotate_backups_noop_when_under_keep() {
        let dir = tmpdir();
        let path = dir.join("settings.json");
        fs::write(&path, "x").unwrap();
        fs::write(dir.join("settings.json.bak.1"), "b").unwrap();
        let removed = rotate_backups(&path, 10);
        assert!(removed.is_empty());
        assert!(dir.join("settings.json.bak.1").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rotate_backups_ignores_non_backup_siblings() {
        let dir = tmpdir();
        let path = dir.join("auth.json");
        fs::write(&path, "x").unwrap();
        // These must never be deleted: a tmp file, an unrelated file, and a
        // backup with a non-numeric tail.
        fs::write(dir.join("auth.json.tmp"), "t").unwrap();
        fs::write(dir.join("auth.json.bak.notanumber"), "n").unwrap();
        fs::write(dir.join("other.json.bak.999"), "o").unwrap();
        fs::write(dir.join("auth.json.bak.1"), "b").unwrap();
        fs::write(dir.join("auth.json.bak.2"), "b").unwrap();
        let removed = rotate_backups(&path, 1);
        assert_eq!(removed.len(), 1);
        assert!(dir.join("auth.json.tmp").exists());
        assert!(dir.join("auth.json.bak.notanumber").exists());
        assert!(dir.join("other.json.bak.999").exists());
        assert!(dir.join("auth.json.bak.2").exists());
        assert!(!dir.join("auth.json.bak.1").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rotate_backups_keep_zero_removes_all() {
        let dir = tmpdir();
        let path = dir.join("auth.json");
        fs::write(&path, "x").unwrap();
        fs::write(dir.join("auth.json.bak.1"), "b").unwrap();
        fs::write(dir.join("auth.json.bak.2"), "b").unwrap();
        let removed = rotate_backups(&path, 0);
        assert_eq!(removed.len(), 2);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_with_mtime_returns_empty_for_missing_file() {
        let dir = tmpdir();
        let path = dir.join("missing.json");
        let (bytes, mtime) = read_with_mtime(&path).unwrap();
        assert!(bytes.is_empty());
        assert!(mtime.is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_with_mtime_returns_contents_and_mtime() {
        let dir = tmpdir();
        let path = dir.join("present.txt");
        fs::write(&path, "hello").unwrap();
        let (bytes, mtime) = read_with_mtime(&path).unwrap();
        assert_eq!(bytes, b"hello");
        assert!(mtime.is_some());
        let _ = fs::remove_dir_all(&dir);
    }
}

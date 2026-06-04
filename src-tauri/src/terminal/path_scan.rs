//! PATH-executable discovery for the terminal autocomplete engine
//! (ADR-0039 phase 2).
//!
//! `terminal_list_path_executables` prefix-matches executable names across
//! the `PATH` directories: Windows resolves via `PATHEXT` (returning the
//! file *stem*, case-insensitive matching), Unix checks the exec bit.
//!
//! Scanning every PATH dir per keystroke would be brutal on Windows
//! (dozens of dirs, cold NTFS metadata), so the full executable list is
//! cached process-wide with a short TTL keyed on the PATH value — the
//! per-call work is then a cheap in-memory prefix filter.

use std::collections::HashSet;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Hard ceiling regardless of the caller-requested limit.
const MAX_LIMIT: usize = 200;
/// How long a scan stays fresh.
const CACHE_TTL: Duration = Duration::from_secs(15);

struct ScanCache {
    /// The PATH value the scan was taken against.
    path_value: String,
    taken_at: Instant,
    /// Sorted, deduped executable names (stems on Windows).
    names: Vec<String>,
}

fn cache_slot() -> &'static Mutex<Option<ScanCache>> {
    static SLOT: OnceLock<Mutex<Option<ScanCache>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

/// The extensions Windows treats as executable, lowercased with the dot
/// (`.exe`, `.cmd`, …). Mirrors the `PATHEXT` default when unset.
#[cfg(windows)]
fn pathext_list() -> Vec<String> {
    std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD;.PS1".to_string())
        .split(';')
        .filter(|s| !s.is_empty())
        .map(|s| s.trim().to_lowercase())
        .collect()
}

/// Collect executable names from one directory into `out`.
fn scan_dir(dir: &Path, out: &mut HashSet<String>) {
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    #[cfg(windows)]
    let exts = pathext_list();
    for entry in read.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        #[cfg(windows)]
        {
            let lower = name.to_lowercase();
            if let Some(ext) = exts.iter().find(|e| lower.ends_with(e.as_str())) {
                let stem = &name[..name.len() - ext.len()];
                if !stem.is_empty() {
                    out.insert(stem.to_string());
                }
            }
        }
        #[cfg(not(windows))]
        {
            use std::os::unix::fs::PermissionsExt;
            let executable = entry
                .metadata()
                .map(|m| m.permissions().mode() & 0o111 != 0)
                .unwrap_or(false);
            if executable {
                out.insert(name);
            }
        }
    }
}

/// Scan every PATH dir (first occurrence wins via the set) — pure given
/// the PATH string, so tests can point it at a temp dir.
fn scan_path(path_value: &str) -> Vec<String> {
    let mut set: HashSet<String> = HashSet::new();
    for dir in std::env::split_paths(path_value) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        scan_dir(&dir, &mut set);
    }
    let mut names: Vec<String> = set.into_iter().collect();
    names.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    names
}

/// Prefix-filter (case-insensitive) the cached scan, refreshing it when
/// stale or when PATH changed. Pure core behind the Tauri command.
pub fn list_path_executables_inner(
    path_value: &str,
    prefix: &str,
    limit: usize,
) -> Vec<String> {
    if prefix.trim().is_empty() {
        // Never dump the whole PATH — completion needs a typed head.
        return Vec::new();
    }
    let limit = limit.clamp(1, MAX_LIMIT);

    let mut slot = cache_slot().lock().expect("path scan cache poisoned");
    let fresh = matches!(
        slot.as_ref(),
        Some(c) if c.path_value == path_value && c.taken_at.elapsed() < CACHE_TTL
    );
    if !fresh {
        *slot = Some(ScanCache {
            path_value: path_value.to_string(),
            taken_at: Instant::now(),
            names: scan_path(path_value),
        });
    }
    let cache = slot.as_ref().expect("just filled");

    let prefix_lower = prefix.to_lowercase();
    cache
        .names
        .iter()
        .filter(|n| n.to_lowercase().starts_with(&prefix_lower))
        .take(limit)
        .cloned()
        .collect()
}

/// Test-only: drop the cache between cases.
#[cfg(test)]
pub fn __clear_cache_for_testing() {
    *cache_slot().lock().expect("cache") = None;
}

/// Tauri command — prefix-match executables on the current PATH.
#[tauri::command]
pub fn terminal_list_path_executables(prefix: String, limit: Option<usize>) -> Vec<String> {
    let path_value = std::env::var("PATH").unwrap_or_default();
    list_path_executables_inner(&path_value, &prefix, limit.unwrap_or(50))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    /// The scan cache is a process-wide singleton; cargo runs tests in
    /// parallel, so every test that touches it serializes on this lock.
    fn test_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|p| p.into_inner())
    }

    struct TempBin {
        root: PathBuf,
    }

    impl TempBin {
        fn new(label: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "cognia-pathscan-test-{label}-{}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&root);
            fs::create_dir_all(&root).expect("mk temp bin");
            __clear_cache_for_testing();
            Self { root }
        }

        /// Create an executable-looking file appropriate for the platform.
        fn exe(&self, stem: &str) -> &Self {
            #[cfg(windows)]
            let name = format!("{stem}.exe");
            #[cfg(not(windows))]
            let name = stem.to_string();
            let path = self.root.join(&name);
            fs::write(&path, b"#!/bin/sh\n").expect("write exe");
            #[cfg(not(windows))]
            {
                use std::os::unix::fs::PermissionsExt;
                let mut perms = fs::metadata(&path).expect("meta").permissions();
                perms.set_mode(0o755);
                fs::set_permissions(&path, perms).expect("chmod");
            }
            self
        }

        fn plain_file(&self, name: &str) -> &Self {
            fs::write(self.root.join(name), b"data").expect("write file");
            self
        }

        fn path_value(&self) -> String {
            self.root.to_string_lossy().into_owned()
        }
    }

    impl Drop for TempBin {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn prefix_matches_case_insensitively() {
        let _guard = test_lock();
        let t = TempBin::new("prefix");
        t.exe("GitHubCli").exe("git-extras").exe("node");
        let out = list_path_executables_inner(&t.path_value(), "git", 50);
        assert_eq!(out.len(), 2);
        assert!(out.iter().any(|n| n == "git-extras"));
        assert!(out.iter().any(|n| n == "GitHubCli"));
    }

    #[test]
    fn empty_prefix_returns_nothing() {
        let _guard = test_lock();
        let t = TempBin::new("empty");
        t.exe("node");
        assert!(list_path_executables_inner(&t.path_value(), "  ", 50).is_empty());
    }

    #[test]
    fn non_executables_are_skipped() {
        let _guard = test_lock();
        let t = TempBin::new("nonexec");
        t.plain_file("readme.txt").exe("real");
        let out = list_path_executables_inner(&t.path_value(), "re", 50);
        assert_eq!(out, vec!["real".to_string()]);
    }

    #[cfg(windows)]
    #[test]
    fn windows_returns_stems_for_pathext_entries() {
        let _guard = test_lock();
        let t = TempBin::new("stems");
        t.exe("ripgrep"); // creates ripgrep.exe
        let out = list_path_executables_inner(&t.path_value(), "rip", 50);
        assert_eq!(out, vec!["ripgrep".to_string()]);
    }

    #[test]
    fn caps_results_to_limit() {
        let _guard = test_lock();
        let t = TempBin::new("cap");
        for i in 0..10 {
            t.exe(&format!("tool{i}"));
        }
        let out = list_path_executables_inner(&t.path_value(), "tool", 3);
        assert_eq!(out.len(), 3);
    }

    #[test]
    fn cache_serves_results_after_dir_removal_until_invalidated() {
        let _guard = test_lock();
        let t = TempBin::new("cache");
        t.exe("cachedtool");
        let first = list_path_executables_inner(&t.path_value(), "cached", 50);
        assert_eq!(first.len(), 1);
        // Remove the file behind the cache's back — same PATH, fresh TTL →
        // the cached name still serves.
        fs::remove_dir_all(&t.root).expect("rm");
        fs::create_dir_all(&t.root).expect("recreate");
        let second = list_path_executables_inner(&t.path_value(), "cached", 50);
        assert_eq!(second.len(), 1);
        // Clearing the cache forces a rescan that sees the empty dir.
        __clear_cache_for_testing();
        let third = list_path_executables_inner(&t.path_value(), "cached", 50);
        assert!(third.is_empty());
    }
}

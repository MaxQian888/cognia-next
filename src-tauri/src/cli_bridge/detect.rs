//! Binary detection — probe whether an external CLI (the `cognia` plugin
//! author CLI, `git`, `cargo-component`, …) is present on the host and,
//! when it is, what version it reports.
//!
//! Used by:
//!   - the DevTools "cognia CLI" status card (PR3.4)
//!   - the marketplace pre-install `requires.binaries` gate (PR3.5)
//!
//! Probing spawns a process, so results are cached with a short TTL to
//! keep a polling UI cheap. The cache is keyed by `(name, version_arg)`.

use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

/// How long a probe result stays warm before the next call re-spawns.
const CACHE_TTL: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinaryDetectionResult {
    pub available: bool,
    /// Trimmed first line of the version output, when the probe succeeded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// Resolved absolute path when discoverable, else None.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Human-readable failure reason when `available` is false.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

type CacheKey = (String, String);
struct CacheEntry {
    at: Instant,
    result: BinaryDetectionResult,
}

fn cache() -> &'static Mutex<HashMap<CacheKey, CacheEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<CacheKey, CacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Extra directories (beyond PATH) to search for managed binaries the app
/// itself downloaded — e.g. `<app_data>/cognia/cli/<version>/`. Registered
/// by the download command (PR3.3) so a freshly-downloaded `cognia` is
/// found without the user touching their PATH.
fn managed_dirs() -> &'static Mutex<Vec<PathBuf>> {
    static DIRS: OnceLock<Mutex<Vec<PathBuf>>> = OnceLock::new();
    DIRS.get_or_init(|| Mutex::new(Vec::new()))
}

/// Register an app-managed directory to prepend to the binary search. Called
/// after a successful download so subsequent `detect_binary` calls resolve
/// the managed copy. Idempotent.
pub fn register_managed_dir(dir: PathBuf) {
    let mut dirs = managed_dirs().lock();
    if !dirs.contains(&dir) {
        dirs.insert(0, dir);
    }
}

/// Drop a cached probe so the next call re-spawns. Used right after a
/// download so the status card reflects the new install immediately
/// instead of waiting out the TTL.
pub fn invalidate(name: &str) {
    cache().lock().retain(|(n, _), _| n != name);
}

/// Candidate executable file names for `name` on this OS. On Windows we
/// try both the bare name (PATH resolution handles `.exe`) and the
/// explicit `.exe` so a managed-dir lookup hits.
fn candidate_names(name: &str) -> Vec<String> {
    if cfg!(windows) {
        vec![name.to_string(), format!("{name}.exe")]
    } else {
        vec![name.to_string()]
    }
}

/// Look for `name` inside the registered managed dirs. Returns the first
/// existing path.
fn find_in_managed_dirs(name: &str) -> Option<PathBuf> {
    let dirs = managed_dirs().lock().clone();
    for dir in dirs {
        for candidate in candidate_names(name) {
            let p = dir.join(&candidate);
            if p.exists() {
                return Some(p);
            }
        }
    }
    None
}

/// Run `<program> <version_arg>` and capture the first stdout line. Returns
/// the trimmed version string on a zero exit, else an error string.
fn probe(program: &str, version_arg: &str) -> BinaryDetectionResult {
    match Command::new(program).arg(version_arg).output() {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let version = stdout
                .lines()
                .next()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty());
            BinaryDetectionResult {
                available: true,
                version,
                path: which_path(program),
                error: None,
            }
        }
        Ok(output) => {
            // Some CLIs print version to stderr or exit non-zero on
            // `--version`; treat a populated stderr/stdout as "present but
            // odd" rather than missing, but report the exit for debugging.
            let combined = format!(
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            let version = combined
                .lines()
                .next()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty());
            let has_version = version.is_some();
            BinaryDetectionResult {
                available: has_version,
                version,
                path: which_path(program),
                error: if has_version {
                    None
                } else {
                    Some(format!("exited with status {}", output.status))
                },
            }
        }
        Err(e) => BinaryDetectionResult {
            available: false,
            version: None,
            path: None,
            error: Some(e.to_string()),
        },
    }
}

/// Best-effort absolute-path resolution via the platform `which`/`where`.
/// Non-fatal — a None just means we couldn't resolve it, not that the
/// binary is absent.
fn which_path(program: &str) -> Option<String> {
    let finder = if cfg!(windows) { "where" } else { "which" };
    Command::new(finder)
        .arg(program)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .next()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
        })
}

/// Core detection used by the Tauri command and tests. Checks managed dirs
/// first (an app-downloaded copy), then falls back to PATH resolution.
pub fn detect(name: &str, version_arg: &str) -> BinaryDetectionResult {
    let key = (name.to_string(), version_arg.to_string());
    {
        let guard = cache().lock();
        if let Some(entry) = guard.get(&key) {
            if entry.at.elapsed() < CACHE_TTL {
                return entry.result.clone();
            }
        }
    }

    // Prefer an app-managed copy if one was downloaded.
    let result = if let Some(managed) = find_in_managed_dirs(name) {
        let mut r = probe(&managed.to_string_lossy(), version_arg);
        if r.available && r.path.is_none() {
            r.path = Some(managed.to_string_lossy().into_owned());
        }
        r
    } else {
        probe(name, version_arg)
    };

    cache().lock().insert(
        key,
        CacheEntry {
            at: Instant::now(),
            result: result.clone(),
        },
    );
    result
}

/// IPC surface — probe a binary by name. `version_arg` defaults to
/// `--version`. Always callable (even on mobile); on a sandboxed mobile
/// runtime the spawn simply fails and we return `available: false`.
#[tauri::command]
pub async fn detect_binary(
    name: String,
    version_arg: Option<String>,
) -> BinaryDetectionResult {
    let arg = version_arg.unwrap_or_else(|| "--version".to_string());
    detect(&name, &arg)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_a_present_binary() {
        // `cargo`/`rustc` are guaranteed present in a Rust test env.
        let result = detect("rustc", "--version");
        assert!(result.available, "rustc should be detected: {result:?}");
        assert!(result.version.is_some());
    }

    #[test]
    fn reports_absent_binary() {
        let result = detect("definitely-not-a-real-binary-xyz", "--version");
        assert!(!result.available);
        assert!(result.error.is_some());
    }

    #[test]
    fn cache_returns_same_result_within_ttl() {
        let a = detect("rustc", "--version");
        let b = detect("rustc", "--version");
        assert_eq!(a.available, b.available);
        assert_eq!(a.version, b.version);
    }

    #[test]
    fn candidate_names_adds_exe_on_windows() {
        let names = candidate_names("cognia");
        assert!(names.contains(&"cognia".to_string()));
        if cfg!(windows) {
            assert!(names.contains(&"cognia.exe".to_string()));
        }
    }

    #[test]
    fn register_managed_dir_is_idempotent() {
        let dir = std::env::temp_dir().join("cognia-test-managed");
        register_managed_dir(dir.clone());
        register_managed_dir(dir.clone());
        let count = managed_dirs().lock().iter().filter(|d| **d == dir).count();
        assert_eq!(count, 1);
    }

    #[test]
    fn invalidate_drops_cached_entry() {
        detect("rustc", "--version");
        invalidate("rustc");
        let guard = cache().lock();
        assert!(!guard.keys().any(|(n, _)| n == "rustc"));
    }
}

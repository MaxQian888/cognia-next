//! Cross-platform command resolution for spawned external-agent processes.
//!
//! `std::process::Command::new("npx")` / `tokio::process::Command::new("npx")`
//! on Windows only auto-appends `.exe`; it does **not** consult `PATHEXT`, so a
//! bare command that resolves to a `.cmd` / `.bat` shim (e.g. `npx`, `opencode`,
//! `cursor-agent`, most npm-installed CLIs) fails to spawn with "program not
//! found". Every external-agent preset launches through such a shim, so without
//! this resolver the readiness probe (`check_command_exists`, which *does* honor
//! `.cmd`) reports "executable" while the actual spawn fails — a full-chain
//! inconsistency.
//!
//! [`resolve_command`] turns a bare command name into a concrete executable
//! path on Windows (PATH × PATHEXT search). Rust ≥ 1.77.2 then runs the resolved
//! `.cmd` / `.bat` correctly (the BatBadBut hardening routes batch files through
//! the shell with proper escaping). On Unix the bare name is returned unchanged
//! — `Command::new` already performs the PATH search and there is no `PATHEXT`.
//!
//! [`check_command_exists`] (the readiness probe) is implemented on top of the
//! same search so readiness and spawnability can never disagree.
//!
//! The search is **not** limited to `PATH`. A macOS app bundle launched from
//! Finder/Dock inherits the launchd environment (`/usr/bin:/bin:/usr/sbin:/sbin`)
//! rather than the user's login-shell `PATH`, so every agent CLI installed by
//! Homebrew, npm/pnpm/bun or `cargo install` is invisible to a packaged Cognia
//! even though it is on `PATH` in a terminal. [`search_dirs`] therefore appends
//! the well-known per-user install roots after the real `PATH` entries — probing
//! directories directly instead of shelling out to a login shell, which keeps
//! the resolver synchronous, side-effect free and testable.

use std::path::{Path, PathBuf};

/// Executable extensions used when `PATHEXT` is unset. Mirrors the Windows
/// default and the historical `check_command_exists` list.
#[cfg(windows)]
const DEFAULT_PATHEXT: &str = ".COM;.EXE;.BAT;.CMD;.PS1";

/// Resolve `command` to a concrete executable path string.
///
/// Returns the input unchanged when it is already a usable path, when nothing
/// is found (so the subsequent spawn surfaces its own error), or on Unix.
pub fn resolve_command(command: &str) -> String {
    resolve_command_path(command)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| command.to_string())
}

/// Like [`resolve_command`] but returns `None` when the command cannot be found
/// on `PATH`. Used by the ecosystem-readiness probe so "is this preset
/// launchable?" uses the exact same resolution as the spawn.
pub fn resolve_command_path(command: &str) -> Option<PathBuf> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return None;
    }

    // An explicit path (absolute or containing a separator) is used as-is when
    // it points at a real file; on Windows we still try extensions so a path
    // like `.\tool` resolves to `.\tool.cmd`.
    if trimmed.contains('/') || trimmed.contains('\\') {
        let as_path = Path::new(trimmed);
        if as_path.is_file() {
            return Some(as_path.to_path_buf());
        }
        #[cfg(windows)]
        return find_with_extensions(as_path);
        #[cfg(not(windows))]
        return None;
    }

    resolve_in_dirs(trimmed, &search_dirs())
}

/// Whether `command` is reachable (readiness probe). Uses the exact same
/// resolution as the spawn, including the fallback install roots.
pub fn check_command_exists(command: &str) -> bool {
    resolve_command_path(command).is_some()
}

/// Every directory the resolver searches: the process `PATH`, then the
/// well-known install roots a GUI-launched app does not inherit. Duplicates are
/// dropped so the `PATH` ordering always wins.
pub fn search_dirs() -> Vec<PathBuf> {
    let path_dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect())
        .unwrap_or_default();
    let mut dirs: Vec<PathBuf> = Vec::with_capacity(path_dirs.len());
    // A real-world PATH repeats entries (shell profiles re-exporting Homebrew,
    // …); deduping keeps the probe from stat-ing the same directory twice per
    // command and makes the child's PATH we derive from this shorter.
    for dir in path_dirs.into_iter().chain(fallback_install_dirs()) {
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    dirs
}

/// Per-user / package-manager install roots that a Finder-launched macOS app
/// never sees. Ordered most-specific first; non-existent entries are harmless
/// because [`resolve_in_dirs`] only probes for a concrete file.
fn fallback_install_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut push_env = |var: &str, suffix: Option<&str>| {
        if let Some(value) = std::env::var_os(var) {
            if value.is_empty() {
                return;
            }
            let base = PathBuf::from(value);
            dirs.push(match suffix {
                Some(suffix) => base.join(suffix),
                None => base,
            });
        }
    };
    // Explicit package-manager roots win over the guessed home-relative ones.
    push_env("PNPM_HOME", None);
    push_env("BUN_INSTALL", Some("bin"));
    push_env("VOLTA_HOME", Some("bin"));
    push_env("NVM_BIN", None);
    push_env("CARGO_HOME", Some("bin"));

    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        for relative in [
            ".local/bin",
            ".bun/bin",
            ".cargo/bin",
            ".volta/bin",
            ".npm-global/bin",
            ".deno/bin",
            "Library/pnpm",
            ".nix-profile/bin",
        ] {
            dirs.push(home.join(relative));
        }
    }

    // System-wide roots that launchd omits from a GUI app's PATH.
    for absolute in ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"] {
        dirs.push(PathBuf::from(absolute));
    }
    dirs
}

/// Search `dirs` for `command`, honoring Windows executable extensions. Split
/// out from [`resolve_command_path`] so tests can supply explicit directories
/// instead of mutating the global `PATH` env (which races under `cargo test`).
fn resolve_in_dirs(command: &str, dirs: &[PathBuf]) -> Option<PathBuf> {
    for dir in dirs {
        let candidate = dir.join(command);
        if candidate.is_file() {
            return Some(candidate);
        }
        #[cfg(windows)]
        if let Some(found) = find_with_extensions(&candidate) {
            return Some(found);
        }
    }
    None
}

/// On Windows, try `base` with each `PATHEXT` extension appended.
#[cfg(windows)]
fn find_with_extensions(base: &Path) -> Option<PathBuf> {
    let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| DEFAULT_PATHEXT.to_string());
    for ext in pathext.split(';') {
        let ext = ext.trim().trim_start_matches('.');
        if ext.is_empty() {
            continue;
        }
        let with_ext = base.with_extension(ext.to_ascii_lowercase());
        if with_ext.is_file() {
            return Some(with_ext);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    /// Create a unique temp directory without `Math.random`/clock access (which
    /// the test harness forbids) — keyed by pid + a monotonic counter.
    fn unique_dir(tag: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "cognia_resolver_{}_{}_{}",
            tag,
            std::process::id(),
            n
        ));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn write_file(dir: &Path, name: &str) -> PathBuf {
        let p = dir.join(name);
        fs::write(&p, b"#!/bin/sh\n").expect("write probe file");
        p
    }

    #[test]
    fn empty_or_whitespace_resolves_to_none() {
        assert!(resolve_command_path("").is_none());
        assert!(resolve_command_path("   ").is_none());
        assert!(!check_command_exists(""));
        // resolve_command echoes the (untrimmed) input back when unresolved.
        assert_eq!(resolve_command(""), "");
    }

    #[test]
    fn search_dirs_starts_with_path_then_adds_fallback_roots() {
        let dirs = search_dirs();
        let path_dirs: Vec<PathBuf> = std::env::var_os("PATH")
            .map(|value| std::env::split_paths(&value).collect())
            .unwrap_or_default();
        // Every PATH entry is preserved, in PATH order, ahead of the fallbacks.
        let kept: Vec<&PathBuf> = dirs.iter().filter(|dir| path_dirs.contains(dir)).collect();
        let mut expected: Vec<&PathBuf> = Vec::new();
        for dir in &path_dirs {
            if !expected.contains(&dir) {
                expected.push(dir);
            }
        }
        assert_eq!(kept, expected);
        // No duplicates anywhere, PATH repeats included.
        let mut seen = std::collections::HashSet::new();
        assert!(dirs.iter().all(|dir| seen.insert(dir.clone())));
        // The launchd-invisible roots are searched even when PATH omits them.
        assert!(dirs.iter().any(|dir| dir == Path::new("/opt/homebrew/bin")));
        assert!(dirs.iter().any(|dir| dir == Path::new("/usr/local/bin")));
    }

    #[test]
    fn fallback_dirs_cover_per_user_package_manager_roots() {
        let dirs = fallback_install_dirs();
        if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
            assert!(dirs.contains(&home.join(".local/bin")));
            assert!(dirs.contains(&home.join(".bun/bin")));
            assert!(dirs.contains(&home.join("Library/pnpm")));
        }
        assert!(dirs.contains(&PathBuf::from("/opt/homebrew/bin")));
    }

    #[test]
    fn missing_command_returns_input_unchanged() {
        let name = "definitely-not-a-real-binary-xyz-123";
        assert!(resolve_command_path(name).is_none());
        assert_eq!(resolve_command(name), name);
        assert!(!check_command_exists(name));
    }

    #[test]
    fn explicit_existing_path_is_used_as_is() {
        let dir = unique_dir("explicit");
        let file = write_file(&dir, "tool.sh");
        let as_str = file.to_string_lossy().to_string();
        assert_eq!(resolve_command_path(&as_str), Some(file.clone()));
        assert_eq!(resolve_command(&as_str), as_str);
        assert!(check_command_exists(&as_str));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn bare_name_found_in_supplied_dir() {
        let dir = unique_dir("bare");
        // On Unix the spawnable name has no extension; on Windows use `.cmd`
        // so the PATHEXT branch is exercised.
        #[cfg(windows)]
        let (probe, lookup) = ("mytool.cmd", "mytool");
        #[cfg(not(windows))]
        let (probe, lookup) = ("mytool", "mytool");

        let file = write_file(&dir, probe);
        let found = resolve_in_dirs(lookup, std::slice::from_ref(&dir));
        assert_eq!(found.as_deref(), Some(file.as_path()));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_in_dirs_skips_missing_then_finds_later_dir() {
        let empty = unique_dir("empty");
        let real = unique_dir("real");
        #[cfg(windows)]
        let (probe, lookup) = ("late.cmd", "late");
        #[cfg(not(windows))]
        let (probe, lookup) = ("late", "late");
        let file = write_file(&real, probe);

        let found = resolve_in_dirs(lookup, &[empty.clone(), real.clone()]);
        assert_eq!(found.as_deref(), Some(file.as_path()));

        let none = resolve_in_dirs("nope", &[empty.clone(), real.clone()]);
        assert!(none.is_none());
        let _ = fs::remove_dir_all(&empty);
        let _ = fs::remove_dir_all(&real);
    }

    #[cfg(windows)]
    #[test]
    fn windows_resolves_cmd_shim_extension() {
        let dir = unique_dir("winext");
        let file = write_file(&dir, "npx.cmd");
        // The bare name (no extension) must resolve to the `.cmd` shim.
        let found = resolve_in_dirs("npx", std::slice::from_ref(&dir));
        assert_eq!(found.as_deref(), Some(file.as_path()));
        let _ = fs::remove_dir_all(&dir);
    }
}

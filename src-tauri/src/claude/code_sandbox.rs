//! Launcher argv for the Code tool presentation's sandbox (ADR-0117 Phase 4).
//!
//! The sidecar runs one untrusted program per `run_code` call in a child
//! process. That child must be OS-confined, and the sidecar cannot confine it
//! itself: the sidecar runs unconfined (it needs network egress to reach the
//! model), so anything it forks inherits nothing. The host therefore renders
//! the confinement wrapper here and hands it over as
//! `COGNIA_CODE_SANDBOX_LAUNCHER`, a JSON argv array the supervisor execs
//! through.
//!
//! Passing a *wrapper argv* rather than a boolean is deliberate. An earlier
//! design used a `COGNIA_STRICT_SANDBOX=1` flag, which was a claim anyone could
//! set with no confinement behind it. With an argv, "strict" is true exactly
//! when there is a real launcher to exec — the sidecar cannot fake it, and a
//! host that cannot render one simply does not set the variable, which makes
//! Code fail closed.
//!
//! Pure (no spawning, no policy evaluation) so every branch is unit-testable on
//! any OS, matching how `cognia_automation::sandbox::launcher` is tested.

use std::path::Path;

use cognia_automation::sandbox::launcher::LaunchScope;

/// Env var the sidecar's `run-code/supervisor.mjs` reads.
pub const CODE_SANDBOX_LAUNCHER_ENV: &str = "COGNIA_CODE_SANDBOX_LAUNCHER";

/// Build the filesystem/network scope for a `run_code` child.
///
/// `scratch` is the only writable path; `node_root` and `sidecar_root` are
/// read-only because the child has to load the Node runtime and the sandbox
/// child script. Network is off unconditionally — the SDK reaches tools by
/// re-entering the host over IPC, never over a socket, so a `run_code` child
/// has no legitimate reason to open one.
///
/// Every path is resolved through `safe_canonicalize` first, and that is not
/// cosmetic. Seatbelt matches `subpath` rules against the *real* path, while
/// `std::env::temp_dir()` on macOS hands back `/var/folders/…` — a symlink to
/// `/private/var/folders/…`. Emitting the unresolved form produces a profile
/// whose writable rule matches nothing, so the child cannot write to its own
/// scratch directory and every `run_code` call fails with EPERM. (Found by
/// running a real `sandbox-exec` child, not by inspection.)
pub fn code_sandbox_scope(scratch: &Path, node_root: &Path, sidecar_root: &Path) -> LaunchScope {
    let scratch = canonical_for_policy(scratch);
    LaunchScope {
        cwd: scratch.clone(),
        writable: vec![scratch],
        readable: vec![
            canonical_for_policy(node_root),
            canonical_for_policy(sidecar_root),
        ],
        network: false,
    }
}

/// Resolve symlinks for a path that is about to enter a sandbox policy.
///
/// Falls back to the lexical path when the input is rejected (control chars,
/// `..`, not absolute). That fallback is safe here because a policy built from
/// a bad path simply grants nothing that matches, which fails closed — whereas
/// panicking or dropping the entry silently would be worse.
fn canonical_for_policy(path: &Path) -> String {
    cognia_automation::sandbox::paths::safe_canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .to_string()
}

/// Serialize a launcher prefix as the JSON argv the sidecar parses.
///
/// Returns `None` for an empty prefix rather than emitting `[]`, because the
/// supervisor treats a malformed or empty value as "no launcher" — and an
/// explicit `None` here keeps that decision in one place instead of relying on
/// the parser to reject our own output.
pub fn encode_launcher(prefix: &[String]) -> Option<String> {
    if prefix.is_empty() {
        return None;
    }
    serde_json::to_string(prefix).ok()
}

/// Render the platform launcher prefix, or `None` when this host has no
/// confinement backend.
///
/// `None` is the fail-closed answer and is expected on Windows (no runner yet)
/// and on a Linux box without `bwrap`. The caller must NOT substitute anything;
/// leaving the env var unset is what disables Code.
#[cfg(target_os = "macos")]
pub fn render_code_sandbox_launcher(scope: &LaunchScope) -> Option<Vec<String>> {
    use cognia_automation::sandbox::launcher::sandbox_exec_prefix;
    if !Path::new("/usr/bin/sandbox-exec").is_file() {
        return None;
    }
    Some(sandbox_exec_prefix(scope))
}

#[cfg(target_os = "linux")]
pub fn render_code_sandbox_launcher(scope: &LaunchScope) -> Option<Vec<String>> {
    use cognia_automation::sandbox::launcher::bwrap_prefix;
    let bwrap = find_on_path("bwrap")?;
    // Shared with the other sandboxed surfaces; bound over secret stores so the
    // child can neither read nor create them.
    let empty = std::env::temp_dir().join("cognia-sandbox-empty");
    std::fs::create_dir_all(&empty).ok()?;
    Some(bwrap_prefix(&bwrap.to_string_lossy(), scope, &empty))
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn render_code_sandbox_launcher(_scope: &LaunchScope) -> Option<Vec<String>> {
    None
}

#[cfg(target_os = "linux")]
fn find_on_path(binary: &str) -> Option<std::path::PathBuf> {
    std::env::var_os("PATH").and_then(|value| {
        std::env::split_paths(&value)
            .map(|dir| dir.join(binary))
            .find(|candidate| candidate.is_file())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn scope() -> LaunchScope {
        code_sandbox_scope(
            &PathBuf::from("/tmp/cognia-code"),
            &PathBuf::from("/usr/local/bin"),
            &PathBuf::from("/Applications/Cognia.app/Contents/Resources"),
        )
    }

    #[test]
    fn scope_makes_only_the_scratch_dir_writable() {
        let scope = scope();
        assert_eq!(scope.writable.len(), 1);
        assert_eq!(scope.cwd, scope.writable[0]);
    }

    /// The bug a real `sandbox-exec` run surfaced: Seatbelt matches `subpath`
    /// rules against resolved paths, so an unresolved `/tmp/...` (a symlink to
    /// `/private/tmp/...` on macOS) yields a writable rule that matches
    /// nothing and every `run_code` call dies with EPERM on its own scratch dir.
    #[cfg(target_os = "macos")]
    #[test]
    fn scope_resolves_symlinked_paths_before_they_reach_the_policy() {
        let scratch = std::env::temp_dir();
        let scope = code_sandbox_scope(&scratch, Path::new("/usr/bin"), Path::new("/usr/share"));
        let resolved = std::fs::canonicalize(&scratch).unwrap();
        assert_eq!(scope.cwd, resolved.to_string_lossy());
        // `/var` and `/tmp` are both symlinks into `/private` on macOS.
        assert!(
            scope.cwd.starts_with("/private/"),
            "expected a resolved path, got {}",
            scope.cwd
        );
    }

    #[test]
    fn scope_keeps_an_unresolvable_path_rather_than_dropping_it() {
        // A rejected path (here: parent traversal) falls back to the lexical
        // form. It grants nothing that matches, which fails closed.
        let scope = code_sandbox_scope(
            Path::new("/tmp/../etc"),
            Path::new("/usr/bin"),
            Path::new("/usr/share"),
        );
        assert_eq!(scope.cwd, "/tmp/../etc");
    }

    #[test]
    fn scope_denies_network_unconditionally() {
        // Tools are reached over IPC, never a socket, so there is no
        // configuration in which a run_code child should have egress.
        assert!(!scope().network);
    }

    #[test]
    fn scope_makes_the_runtime_and_sidecar_readable() {
        // Real, existing directories so the assertion is about *which* roots
        // are granted rather than about how a missing path resolves.
        let scope = code_sandbox_scope(
            &std::env::temp_dir(),
            Path::new("/usr/bin"),
            Path::new("/usr/share"),
        );
        assert_eq!(scope.readable.len(), 2);
        assert!(scope.readable.iter().any(|p| p.ends_with("/usr/bin")));
        assert!(scope.readable.iter().any(|p| p.ends_with("/usr/share")));
    }

    #[test]
    fn encode_launcher_emits_a_json_argv_array() {
        let encoded = encode_launcher(&["/usr/bin/sandbox-exec".into(), "--".into()]).unwrap();
        assert_eq!(encoded, r#"["/usr/bin/sandbox-exec","--"]"#);
    }

    #[test]
    fn encode_launcher_refuses_an_empty_prefix() {
        // An empty array would parse as "no launcher" on the sidecar side; not
        // emitting it at all keeps that decision in one place.
        assert_eq!(encode_launcher(&[]), None);
    }

    #[test]
    fn encoded_launcher_round_trips_as_an_array_of_strings() {
        let prefix = vec![
            "/usr/bin/sandbox-exec".to_string(),
            "-p".into(),
            "(deny default)".into(),
        ];
        let encoded = encode_launcher(&prefix).unwrap();
        let decoded: Vec<String> = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded, prefix);
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    #[test]
    fn unsupported_platforms_render_no_launcher() {
        assert!(render_code_sandbox_launcher(&scope()).is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_prefix_ends_with_the_target_separator() {
        // Only meaningful where the launcher exists; skip otherwise so the test
        // is not a machine-dependent failure.
        if !Path::new("/usr/bin/sandbox-exec").is_file() {
            return;
        }
        let prefix = render_code_sandbox_launcher(&scope()).unwrap();
        assert_eq!(prefix.first().unwrap(), "/usr/bin/sandbox-exec");
        assert_eq!(prefix.last().unwrap(), "--");
    }
}

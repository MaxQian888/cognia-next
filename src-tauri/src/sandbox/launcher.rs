// ADR-0028 Phase 3 (P4.1 foundation) — reusable sandbox launch-prefix renderer.
//
// `SandboxedExec::run` captures stdout/stderr for one-shot model tool calls.
// Interactive surfaces — the integrated terminal's PTY — instead need to spawn
// the sandbox launcher AS the child program so the user keeps a live tty. This
// module renders the launcher argv PREFIX (program + flags, ending in `--`);
// the caller appends the real shell argv after it:
//
//     [bwrap, <flags...>, --]  ++  [bash, -i]
//     [/usr/bin/sandbox-exec, -p, <profile>, --]  ++  [zsh]
//
// Scope = filesystem + network only. Unlike the full backends, this layer
// does NOT install seccomp / rlimit hooks: `portable-pty::CommandBuilder`
// exposes no `pre_exec` seam and can't carry a seccomp fd, so the interactive
// terminal gets FS + network confinement (the primary escape surface) while
// one-shot `sandbox_*` tool calls still receive the full hardening through
// `SandboxedExec::run`. Pure (no I/O) so every branch is host-unit-testable on
// any OS even though the launchers themselves only exist on Linux / macOS.
#![allow(dead_code)]

use std::path::Path;

use crate::sandbox::protected::{protected_entries_under, ProtKind};

/// Filesystem + network scope for a sandboxed interactive launch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchScope {
    /// Directory the child starts in (bound writable + `--chdir`).
    pub cwd: String,
    /// Directories the child may write (always includes `cwd`).
    pub writable: Vec<String>,
    /// Extra read-only directories beyond the standard system paths
    /// (e.g. the user's home for `~/.gitconfig`, `~/.npmrc`).
    pub readable: Vec<String>,
    /// Allow network egress. Interactive dev shells usually need it
    /// (`git`, `npm`); the caller decides.
    pub network: bool,
}

/// Read-only system paths every program needs to dynamically link. Kept in
/// sync with `LinuxSandboxBackend::render_bwrap_args` so a sandboxed terminal
/// behaves like a sandboxed `sandbox_bash`.
const LINUX_RO_SYSTEM: &[&str] = &[
    "/usr",
    "/lib",
    "/lib64",
    "/bin",
    "/sbin",
    "/etc",
    "/opt",
];

/// macOS read-only subpaths the dyld loader + base toolchain need.
const MACOS_RO_SYSTEM: &[&str] = &[
    "/usr/lib",
    "/usr/bin",
    "/usr/share",
    "/bin",
    "/sbin",
    "/System",
    "/Library/Frameworks",
    "/private/etc",
    "/private/var/select",
];

/// Render the Linux `bwrap` launch prefix. `bwrap` is the resolved binary
/// path (bundled or `which bwrap`). `empty_dir` is an empty read-only directory
/// the caller created (shared `temp/cognia-sandbox-empty`) that is bound over
/// SECRET stores so they can't be read or created — see [`push_protected_binds`].
/// Returns argv up to and including `--`.
pub fn bwrap_prefix(bwrap: &str, scope: &LaunchScope, empty_dir: &Path) -> Vec<String> {
    let mut args: Vec<String> = vec![bwrap.to_string()];

    // Isolation baseline — mirrors the one-shot Bash backend.
    for flag in [
        "--unshare-user",
        "--unshare-pid",
        "--unshare-ipc",
        "--unshare-uts",
        "--die-with-parent",
        "--new-session",
    ] {
        args.push(flag.to_string());
    }
    // Drop every capability inside the namespace too (defense in depth beyond
    // the empty cap set a fresh user namespace already grants) — Codex /
    // bubblewrap default. Value is a separate argv element.
    args.push("--cap-drop".to_string());
    args.push("ALL".to_string());

    // System paths (read-only). Existence is checked by the caller's binary
    // resolver at runtime; we emit them unconditionally and let bwrap skip
    // missing ones is NOT safe (bwrap errors on missing source), so the
    // backend integration filters by `Path::exists` before calling — the
    // pure renderer lists the canonical set and a `filter_existing` helper
    // prunes it.
    for p in LINUX_RO_SYSTEM {
        args.push("--ro-bind-try".to_string());
        args.push((*p).to_string());
        args.push((*p).to_string());
    }

    // Virtual mounts.
    args.push("--proc".to_string());
    args.push("/proc".to_string());
    args.push("--dev".to_string());
    args.push("/dev".to_string());
    args.push("--tmpfs".to_string());
    args.push("/tmp".to_string());

    // Read-only extras (home, etc.).
    for p in &scope.readable {
        args.push("--ro-bind-try".to_string());
        args.push(p.clone());
        args.push(p.clone());
    }

    // Writable binds — cwd is always writable.
    let writable = writable_set(scope);
    for p in &writable {
        args.push("--bind".to_string());
        args.push(p.clone());
        args.push(p.clone());
    }

    // Re-deny credential / VCS-control paths nested under the writable AND
    // readable roots — mirrors the one-shot Linux backend so a sandboxed
    // terminal / Python host can't rewrite `.git/hooks` / shell rc files for
    // persistence NOR read `.ssh` / `.aws` / cognia's own credential store for
    // exfiltration (read is the exfil threat; the previous lossy `ro-bind-try`
    // left secrets readable and never looked at the readable roots — the bug
    // this closes). A later bwrap bind wins.
    push_protected_binds(&mut args, &writable, &scope.readable, empty_dir);

    if !scope.cwd.is_empty() {
        args.push("--chdir".to_string());
        args.push(scope.cwd.clone());
    }

    if scope.network {
        args.push("--share-net".to_string());
    } else {
        args.push("--unshare-net".to_string());
    }

    args.push("--".to_string());
    args
}

/// Render the macOS `sandbox-exec` launch prefix:
/// `["/usr/bin/sandbox-exec", "-p", <profile>, "--"]`.
pub fn sandbox_exec_prefix(scope: &LaunchScope) -> Vec<String> {
    vec![
        "/usr/bin/sandbox-exec".to_string(),
        "-p".to_string(),
        render_sbpl(scope),
        "--".to_string(),
    ]
}

/// SBPL profile for an interactive launch — mirrors `MacOsSandboxBackend`'s
/// one-shot profile (deny-by-default + system reads + scoped read/write +
/// network gate).
pub fn render_sbpl(scope: &LaunchScope) -> String {
    let mut out = String::from("(version 1)\n(deny default)\n");
    out.push_str("(allow process-fork)\n(allow process-exec)\n");
    out.push_str("(allow mach-lookup)\n(allow sysctl-read)\n");
    out.push_str("(allow file-read*\n");
    for p in MACOS_RO_SYSTEM {
        out.push_str(&format!("  (subpath \"{}\")\n", escape_sbpl(p)));
    }
    for p in &scope.readable {
        out.push_str(&format!("  (subpath \"{}\")\n", escape_sbpl(p)));
    }
    out.push_str(")\n");
    let writable = writable_set(scope);
    if !writable.is_empty() {
        out.push_str("(allow file-write*\n");
        for p in &writable {
            out.push_str(&format!("  (subpath \"{}\")\n", escape_sbpl(p)));
        }
        out.push_str(")\n(allow file-read*\n");
        for p in &writable {
            out.push_str(&format!("  (subpath \"{}\")\n", escape_sbpl(p)));
        }
        out.push_str(")\n");
    }
    // Re-deny credential / VCS-control paths under the writable roots (SBPL
    // last-match-wins) — mirrors the one-shot macOS backend: every protected
    // path is write-denied, and SECRET stores are additionally READ-denied
    // (read of an SSH key / credential is the exfiltration threat). Secrets
    // reachable through a readable-only root (e.g. `$HOME`) are read-denied too
    // — the previous profile emitted write denies only and ignored `readable`,
    // leaving `~/.ssh` / cognia's credential store readable (the bug this
    // closes).
    push_protected_denies(&mut out, &writable);
    push_secret_read_denies(&mut out, &scope.readable);
    if scope.network {
        out.push_str("(allow network*)\n");
    } else {
        out.push_str("(deny network*)\n");
    }
    out
}

/// The full writable set with `cwd` guaranteed present and de-duplicated.
fn writable_set(scope: &LaunchScope) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    let mut push = |p: &str| {
        if !p.is_empty() && !seen.iter().any(|s| s == p) {
            seen.push(p.to_string());
        }
    };
    push(&scope.cwd);
    for p in &scope.writable {
        push(p);
    }
    seen
}

fn escape_sbpl(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Bind an EMPTY read-only source over `dest` (a directory shadowed by
/// `empty_dir`, a file by `/dev/null`) so a secret store is neither readable,
/// writable, nor creatable — mirrors `LinuxSandboxBackend::push_empty_bind`.
fn push_empty_bind(args: &mut Vec<String>, kind: ProtKind, empty_dir: &Path, dest: &str) {
    args.push("--ro-bind".to_string());
    match kind {
        ProtKind::Dir => args.push(empty_dir.to_string_lossy().into_owned()),
        ProtKind::File => args.push("/dev/null".to_string()),
    }
    args.push(dest.to_string());
}

/// Re-bind protected paths over the writable + readable roots, mirroring
/// `LinuxSandboxBackend::push_protected_binds`:
///   * Under a WRITABLE root — SECRET stores are shadowed by an empty read-only
///     source (no read / write / create, exist or not); WRITE-PROTECTED control
///     files are re-bound read-only when present (`-try` skips absent ones so a
///     fresh `git init` / new rc file still works).
///   * Under a READABLE-only root — SECRET stores are still hidden (read is the
///     exfiltration threat); write-protected files are already read-only there.
fn push_protected_binds(
    args: &mut Vec<String>,
    writable: &[String],
    readable: &[String],
    empty_dir: &Path,
) {
    for root in writable {
        for (protected, kind, secret) in protected_entries_under(Path::new(root)) {
            let dest = protected.to_string_lossy().into_owned();
            if secret {
                push_empty_bind(args, kind, empty_dir, &dest);
            } else {
                args.push("--ro-bind-try".to_string());
                args.push(dest.clone());
                args.push(dest);
            }
        }
    }
    for root in readable {
        for (protected, kind, secret) in protected_entries_under(Path::new(root)) {
            if secret {
                let dest = protected.to_string_lossy().into_owned();
                push_empty_bind(args, kind, empty_dir, &dest);
            }
        }
    }
}

/// Emit SBPL deny rules for every protected path under each writable root —
/// mirrors `MacOsSandboxBackend::push_protected_denies`. ALL protected paths get
/// write + unlink denies; SECRET stores additionally get read denies.
fn push_protected_denies(out: &mut String, writable: &[String]) {
    for root in writable {
        for (protected, _kind, secret) in protected_entries_under(Path::new(root)) {
            let p = escape_sbpl(&protected.to_string_lossy());
            out.push_str(&format!("(deny file-write* (subpath \"{p}\"))\n"));
            out.push_str(&format!("(deny file-write* (literal \"{p}\"))\n"));
            out.push_str(&format!("(deny file-write-unlink (literal \"{p}\"))\n"));
            if secret {
                out.push_str(&format!("(deny file-read* (subpath \"{p}\"))\n"));
                out.push_str(&format!("(deny file-read* (literal \"{p}\"))\n"));
            }
        }
    }
}

/// Emit `(deny file-read* …)` for SECRET stores reachable through the readable
/// roots — mirrors `MacOsSandboxBackend::push_secret_read_denies`. Comes after
/// the readable allow so the deny wins (SBPL last-match).
fn push_secret_read_denies(out: &mut String, readable: &[String]) {
    for root in readable {
        for (protected, _kind, secret) in protected_entries_under(Path::new(root)) {
            if secret {
                let p = escape_sbpl(&protected.to_string_lossy());
                out.push_str(&format!("(deny file-read* (subpath \"{p}\"))\n"));
                out.push_str(&format!("(deny file-read* (literal \"{p}\"))\n"));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn scope() -> LaunchScope {
        LaunchScope {
            cwd: "/work/project".to_string(),
            writable: vec!["/work/project".to_string()],
            readable: vec!["/home/u".to_string()],
            network: true,
        }
    }

    /// Stable empty-dir path used to assert secret binds deterministically.
    fn empty() -> PathBuf {
        PathBuf::from("/run/cognia-empty")
    }

    /// Find `--ro-bind <src> <dest>` triples and return the matching `src`.
    fn ro_bind_src_for(args: &[String], dest: &str) -> Option<String> {
        args.windows(3)
            .find(|w| w[0] == "--ro-bind" && w[2] == dest)
            .map(|w| w[1].clone())
    }

    #[test]
    fn bwrap_prefix_has_isolation_baseline_and_terminates_with_dashdash() {
        let p = bwrap_prefix("/usr/bin/bwrap", &scope(), &empty());
        assert_eq!(p.first().unwrap(), "/usr/bin/bwrap");
        assert!(p.iter().any(|s| s == "--unshare-pid"));
        assert!(p.iter().any(|s| s == "--new-session"));
        assert!(p.iter().any(|s| s == "--die-with-parent"));
        // --cap-drop ALL is emitted as two adjacent argv elements.
        assert!(p.windows(2).any(|w| w[0] == "--cap-drop" && w[1] == "ALL"));
        assert_eq!(p.last().unwrap(), "--");
    }

    #[test]
    fn bwrap_prefix_binds_cwd_writable_and_chdirs() {
        let p = bwrap_prefix("bwrap", &scope(), &empty());
        let bind = p.windows(3).any(|w| w[0] == "--bind" && w[1] == "/work/project");
        assert!(bind, "cwd not bound writable");
        let chdir = p
            .iter()
            .position(|s| s == "--chdir")
            .map(|i| p[i + 1].as_str());
        assert_eq!(chdir, Some("/work/project"));
    }

    #[test]
    fn bwrap_prefix_network_toggle() {
        let on = bwrap_prefix("bwrap", &scope(), &empty());
        assert!(on.iter().any(|s| s == "--share-net"));
        let off_scope = LaunchScope {
            network: false,
            ..scope()
        };
        let off = bwrap_prefix("bwrap", &off_scope, &empty());
        assert!(off.iter().any(|s| s == "--unshare-net"));
        assert!(!off.iter().any(|s| s == "--share-net"));
    }

    #[test]
    fn bwrap_prefix_ro_binds_home() {
        let p = bwrap_prefix("bwrap", &scope(), &empty());
        let ro = p
            .windows(3)
            .any(|w| w[0] == "--ro-bind-try" && w[1] == "/home/u" && w[2] == "/home/u");
        assert!(ro, "home not ro-bound");
    }

    #[test]
    fn sandbox_exec_prefix_wraps_profile() {
        let p = sandbox_exec_prefix(&scope());
        assert_eq!(p[0], "/usr/bin/sandbox-exec");
        assert_eq!(p[1], "-p");
        assert!(p[2].starts_with("(version 1)\n(deny default)"));
        assert_eq!(p[3], "--");
    }

    #[test]
    fn sbpl_scopes_writes_and_gates_network() {
        let prof = render_sbpl(&scope());
        assert!(prof.contains("(subpath \"/work/project\")"));
        assert!(prof.contains("(subpath \"/home/u\")"));
        assert!(prof.contains("(allow network*)"));
        let off = render_sbpl(&LaunchScope {
            network: false,
            ..scope()
        });
        assert!(off.contains("(deny network*)"));
    }

    #[test]
    fn writable_set_dedups_and_forces_cwd() {
        let s = LaunchScope {
            cwd: "/a".to_string(),
            writable: vec!["/a".to_string(), "/b".to_string(), "/b".to_string()],
            readable: vec![],
            network: false,
        };
        assert_eq!(writable_set(&s), vec!["/a".to_string(), "/b".to_string()]);
    }

    #[test]
    fn escape_sbpl_handles_quotes_and_backslashes() {
        assert_eq!(escape_sbpl("a\"b"), "a\\\"b");
        assert_eq!(escape_sbpl("a\\b"), "a\\\\b");
    }

    /// Join a protected name onto the cwd the same way the renderer does, so
    /// the expectation matches on every host's path-separator convention.
    fn protected_under_cwd(name: &str) -> String {
        std::path::Path::new("/work/project")
            .join(name)
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn bwrap_prefix_re_denies_protected_paths_under_writable() {
        let p = bwrap_prefix("bwrap", &scope(), &empty());
        // `.git` (write-protected) under the writable cwd is re-bound read-only
        // (`-try`, so an absent one still allows `git init`) — mirrors the
        // one-shot backend.
        let git = protected_under_cwd(".git");
        let git_redenied = p
            .windows(3)
            .any(|w| w[0] == "--ro-bind-try" && w[1] == git);
        assert!(git_redenied, "protected .git not re-denied in terminal launcher");
        // `.ssh` (SECRET dir) is shadowed by the EMPTY dir — read-only AND
        // unreadable, regardless of existence. The old code left it readable.
        let ssh = protected_under_cwd(".ssh");
        assert_eq!(
            ro_bind_src_for(&p, &ssh).as_deref(),
            Some("/run/cognia-empty"),
            "secret .ssh must be shadowed by the empty source, not left readable"
        );
        // `.git-credentials` (SECRET file) is shadowed by /dev/null.
        let creds = protected_under_cwd(".git-credentials");
        assert_eq!(ro_bind_src_for(&p, &creds).as_deref(), Some("/dev/null"));
    }

    #[test]
    fn bwrap_prefix_hides_secrets_reachable_through_readable_home() {
        // Regression: the launcher used to iterate writable roots ONLY, so a
        // secret under the readable `$HOME` (`~/.ssh`, `~/.aws`, cognia's own
        // `~/.config/cognia` credential store) was fully readable.
        let p = bwrap_prefix("bwrap", &scope(), &empty());
        let home_ssh = std::path::Path::new("/home/u")
            .join(".ssh")
            .to_string_lossy()
            .into_owned();
        assert_eq!(
            ro_bind_src_for(&p, &home_ssh).as_deref(),
            Some("/run/cognia-empty"),
            "secret under readable $HOME must be hidden"
        );
        // Join the multi-segment rel the same way `protected_entries_under`
        // does (a single `join`) so the expected string matches on every host's
        // separator convention.
        let home_cognia = std::path::Path::new("/home/u")
            .join(".config/cognia")
            .to_string_lossy()
            .into_owned();
        assert_eq!(
            ro_bind_src_for(&p, &home_cognia).as_deref(),
            Some("/run/cognia-empty"),
            "cognia's own credential store under $HOME must be hidden"
        );
    }

    #[test]
    fn render_sbpl_re_denies_protected_paths_under_writable() {
        let prof = render_sbpl(&scope());
        let git = escape_sbpl(&protected_under_cwd(".git"));
        let ssh = escape_sbpl(&protected_under_cwd(".ssh"));
        assert!(prof.contains(&format!("(deny file-write* (subpath \"{git}\"))")));
        assert!(prof.contains(&format!("(deny file-write-unlink (literal \"{ssh}\"))")));
        // SECRET stores under a writable root are ALSO read-denied (the old
        // profile emitted write denies only).
        assert!(prof.contains(&format!("(deny file-read* (subpath \"{ssh}\"))")));
        // Deny comes after the writable allow (last-match-wins).
        let allow_idx = prof.find("(allow file-write*").unwrap();
        let deny_idx = prof
            .find(&format!("(deny file-write* (subpath \"{git}\")"))
            .unwrap();
        assert!(deny_idx > allow_idx);
    }

    #[test]
    fn render_sbpl_read_denies_secrets_reachable_through_readable_home() {
        // Regression: secrets reachable through the readable `$HOME` were never
        // read-denied, so a sandboxed macOS terminal could `cat ~/.ssh/id_rsa`.
        let prof = render_sbpl(&scope());
        let home_ssh = escape_sbpl(
            &std::path::Path::new("/home/u")
                .join(".ssh")
                .to_string_lossy(),
        );
        assert!(
            prof.contains(&format!("(deny file-read* (subpath \"{home_ssh}\"))")),
            "secret under readable $HOME must be read-denied"
        );
        // The read-deny wins over the readable allow (last-match).
        let allow_idx = prof.find("(allow file-read*").unwrap();
        let deny_idx = prof
            .find(&format!("(deny file-read* (subpath \"{home_ssh}\")"))
            .unwrap();
        assert!(deny_idx > allow_idx);
    }
}

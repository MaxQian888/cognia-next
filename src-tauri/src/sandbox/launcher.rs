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
/// path (bundled or `which bwrap`). Returns argv up to and including `--`.
pub fn bwrap_prefix(bwrap: &str, scope: &LaunchScope) -> Vec<String> {
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
    for p in writable_set(scope) {
        args.push("--bind".to_string());
        args.push(p.clone());
        args.push(p);
    }

    // Re-deny credential / VCS-control paths nested under each writable root by
    // binding them read-only on top (a later bwrap bind wins) — mirrors the
    // one-shot Linux backend so a sandboxed terminal can't rewrite `.git/hooks`,
    // `.ssh`, or shell rc files for persistence. `-try` tolerates absent paths.
    for root in writable_set(scope) {
        for protected in crate::sandbox::protected::protected_paths_under(std::path::Path::new(&root)) {
            let s = protected.to_string_lossy().into_owned();
            args.push("--ro-bind-try".to_string());
            args.push(s.clone());
            args.push(s);
        }
    }

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
    // Re-deny credential / VCS-control paths nested under each writable root
    // (SBPL last-match-wins) — mirrors the one-shot macOS backend so a
    // sandboxed terminal can't rewrite `.git/hooks`, `.ssh`, shell rc files.
    for root in &writable {
        for protected in crate::sandbox::protected::protected_paths_under(std::path::Path::new(root)) {
            let p = escape_sbpl(&protected.to_string_lossy());
            out.push_str(&format!("(deny file-write* (subpath \"{p}\"))\n"));
            out.push_str(&format!("(deny file-write* (literal \"{p}\"))\n"));
            out.push_str(&format!("(deny file-write-unlink (literal \"{p}\"))\n"));
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn scope() -> LaunchScope {
        LaunchScope {
            cwd: "/work/project".to_string(),
            writable: vec!["/work/project".to_string()],
            readable: vec!["/home/u".to_string()],
            network: true,
        }
    }

    #[test]
    fn bwrap_prefix_has_isolation_baseline_and_terminates_with_dashdash() {
        let p = bwrap_prefix("/usr/bin/bwrap", &scope());
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
        let p = bwrap_prefix("bwrap", &scope());
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
        let on = bwrap_prefix("bwrap", &scope());
        assert!(on.iter().any(|s| s == "--share-net"));
        let off_scope = LaunchScope {
            network: false,
            ..scope()
        };
        let off = bwrap_prefix("bwrap", &off_scope);
        assert!(off.iter().any(|s| s == "--unshare-net"));
        assert!(!off.iter().any(|s| s == "--share-net"));
    }

    #[test]
    fn bwrap_prefix_ro_binds_home() {
        let p = bwrap_prefix("bwrap", &scope());
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
        let p = bwrap_prefix("bwrap", &scope());
        // `.git` under the writable cwd is re-bound read-only (so it stays
        // non-writable) — mirrors the one-shot backend.
        let git = protected_under_cwd(".git");
        let git_redenied = p
            .windows(3)
            .any(|w| w[0] == "--ro-bind-try" && w[1] == git);
        assert!(git_redenied, "protected .git not re-denied in terminal launcher");
        let ssh = protected_under_cwd(".ssh");
        let ssh_redenied = p
            .windows(3)
            .any(|w| w[0] == "--ro-bind-try" && w[1] == ssh);
        assert!(ssh_redenied, "protected .ssh not re-denied in terminal launcher");
    }

    #[test]
    fn render_sbpl_re_denies_protected_paths_under_writable() {
        let prof = render_sbpl(&scope());
        let git = escape_sbpl(&protected_under_cwd(".git"));
        let ssh = escape_sbpl(&protected_under_cwd(".ssh"));
        assert!(prof.contains(&format!("(deny file-write* (subpath \"{git}\"))")));
        assert!(prof.contains(&format!("(deny file-write-unlink (literal \"{ssh}\"))")));
        // Deny comes after the writable allow (last-match-wins).
        let allow_idx = prof.find("(allow file-write*").unwrap();
        let deny_idx = prof
            .find(&format!("(deny file-write* (subpath \"{git}\")"))
            .unwrap();
        assert!(deny_idx > allow_idx);
    }
}

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

use std::path::{Path, PathBuf};

use crate::protected::{protected_entries_under, ProtKind};
use crate::sbpl;
use crate::types::NetworkPolicy;

/// Host-owned paths for a Linux allowlist launch. Never constructed from target
/// env or argv. The backend retains all three sources until the child is reaped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinuxBridgeLaunchSpec {
    pub helper: PathBuf,
    pub proxy_socket: PathBuf,
    pub control_socket: PathBuf,
    pub as_pid_1: bool,
}

pub const LINUX_EGRESS_DIR: &str = "/run/cognia-egress";

/// Pure validation, shared by the host backend and macOS unit tests. Reject
/// ancestors as well as descendants so no user mount can shadow reserved IPC.
pub fn reject_linux_bridge_collisions(
    command: &crate::types::SandboxCommand,
    policy: &crate::types::SandboxPolicy,
) -> Result<(), crate::types::SandboxError> {
    use crate::types::{SandboxError, SandboxPolicy};
    let (readable, writable) = match policy {
        SandboxPolicy::Bash {
            readable, writable, ..
        } => (readable, writable),
        SandboxPolicy::Edit {
            readable,
            target_files,
        }
        | SandboxPolicy::Write {
            readable,
            target_files,
        }
        | SandboxPolicy::TextEditor {
            readable,
            target_files,
        } => (readable, target_files),
    };
    let reserved = Path::new(LINUX_EGRESS_DIR);
    for path in std::iter::once(&command.cwd)
        .chain(readable)
        .chain(writable)
    {
        if !path.is_absolute()
            || path
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
            || path.starts_with(reserved)
            || reserved.starts_with(path)
        {
            return Err(SandboxError::InvalidPolicy {
                reason: format!(
                    "'{}' collides with reserved Linux bridge path {LINUX_EGRESS_DIR}",
                    path.display()
                ),
            });
        }
    }
    Ok(())
}

/// Render the network flags and final command. Append AFTER all user binds and
/// protection mounts. With no backend-owned bridge an allowlist cannot render.
pub fn render_linux_network_launch(
    network: &crate::types::NetworkPolicy,
    bridge: Option<&LinuxBridgeLaunchSpec>,
    target: &[String],
) -> Result<Vec<String>, crate::types::SandboxError> {
    use crate::types::{NetworkPolicy, SandboxError};
    let mut args = Vec::new();
    match network {
        NetworkPolicy::On => args.push("--share-net".into()),
        NetworkPolicy::Off => args.push("--unshare-net".into()),
        NetworkPolicy::Allowlist { hosts } => {
            if hosts.is_empty() {
                return Err(SandboxError::InvalidPolicy {
                    reason: "network allowlist must not be empty".into(),
                });
            }
            let spec = bridge.ok_or_else(|| SandboxError::SetupRequired {
                reason: "Linux allowlist requires a backend-owned Unix bridge".into(),
            })?;
            if [&spec.helper, &spec.proxy_socket, &spec.control_socket]
                .iter()
                .any(|p| !p.is_absolute())
            {
                return Err(SandboxError::InvalidPolicy {
                    reason: "bridge source paths must be absolute".into(),
                });
            }
            args.extend(["--unshare-net".into(), "--cap-drop".into(), "ALL".into()]);
            if spec.as_pid_1 {
                args.push("--as-pid-1".into());
            }
            // A mount point is required for the final read-only remount.
            args.extend(["--tmpfs".into(), LINUX_EGRESS_DIR.into()]);
            for (source, name) in [
                (&spec.proxy_socket, "proxy.sock"),
                (&spec.control_socket, "control.sock"),
                (&spec.helper, "helper"),
            ] {
                args.extend([
                    "--ro-bind".into(),
                    source.to_string_lossy().into_owned(),
                    format!("{LINUX_EGRESS_DIR}/{name}"),
                ]);
            }
            args.extend([
                "--remount-ro".into(),
                LINUX_EGRESS_DIR.into(),
                "--".into(),
                format!("{LINUX_EGRESS_DIR}/helper"),
                "--linux-netns-bridge".into(),
            ]);
        }
    }
    args.push("--".into());
    args.extend_from_slice(target);
    Ok(args)
}

/// Filesystem + network scope for a sandboxed interactive launch.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LaunchScope {
    /// Directory the child starts in (bound writable + `--chdir`).
    pub cwd: String,
    /// Directories the child may write (always includes `cwd`).
    pub writable: Vec<String>,
    /// Extra read-only directories beyond the standard system paths
    /// (e.g. the user's home for `~/.gitconfig`, `~/.npmrc`).
    pub readable: Vec<String>,
    /// Host-selected credential/state roots hidden from this task. Explicit
    /// writable descendants (the task's own home) remain accessible.
    pub denied_readable: Vec<String>,
    /// Require the declared read roots instead of the legacy global read base.
    pub restrict_readable: bool,
    /// Allowlist launches require a host-owned proxy and supervisor.
    pub network: NetworkPolicy,
}

/// Validate configuration using the same hostname grammar and wildcard semantics
/// as the shared proxy. IP literals are accepted for exact entries only; the
/// proxy still rejects private, metadata, and otherwise non-public destinations.
pub fn validate_network_allowlist(hosts: &[String]) -> Result<(), String> {
    for pattern in hosts {
        let trimmed = pattern.trim();
        let (host, wildcard) = match trimmed.strip_prefix("*.") {
            Some(host) => (host, true),
            None => (trimmed, false),
        };
        if !cognia_net::egress::is_valid_hostname(host)
            || host.ends_with('.')
            || (wildcard && host.parse::<std::net::IpAddr>().is_ok())
        {
            return Err(format!("invalid network allowlist host: {pattern:?}"));
        }
    }
    Ok(())
}

/// Filesystem confinement plus exactly one host-owned filtering proxy port.
/// Unlike the network-only prefix, this retains all credential deny floors.
pub fn sandbox_exec_proxy_prefix(scope: &LaunchScope, proxy_port: u16) -> Vec<String> {
    let mut confined = scope.clone();
    confined.network = NetworkPolicy::Off;
    let mut launch = sandbox_exec_prefix(&confined);
    push_loopback_proxy_network_rule(&mut launch[2], proxy_port);
    launch
}

/// Read-only system paths every program needs to dynamically link. Kept in
/// sync with `LinuxSandboxBackend::render_bwrap_args` so a sandboxed terminal
/// behaves like a sandboxed `sandbox_bash`.
const LINUX_RO_SYSTEM: &[&str] = &["/usr", "/lib", "/lib64", "/bin", "/sbin", "/etc", "/opt"];

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
    reopen_roots_under_shadowed_secrets(&mut args, &writable, &scope.readable);
    for denied in &scope.denied_readable {
        if Path::new(denied).exists() {
            let kind = if Path::new(denied).is_file() {
                ProtKind::File
            } else {
                ProtKind::Dir
            };
            push_empty_bind(&mut args, kind, empty_dir, denied);
            for allowed in scope
                .readable
                .iter()
                .filter(|allowed| Path::new(allowed).starts_with(denied) && *allowed != denied)
            {
                args.extend(["--ro-bind-try".into(), allowed.clone(), allowed.clone()]);
            }
            for allowed in writable
                .iter()
                .filter(|allowed| Path::new(allowed).starts_with(denied) && *allowed != denied)
            {
                args.extend(["--bind".into(), allowed.clone(), allowed.clone()]);
            }
        }
    }

    if !scope.cwd.is_empty() {
        args.push("--chdir".to_string());
        args.push(scope.cwd.clone());
    }

    if matches!(scope.network, NetworkPolicy::On) {
        args.push("--share-net".to_string());
    } else {
        args.push("--unshare-net".to_string());
    }

    args.push("--".to_string());
    args
}

/// Compose the interactive filesystem prefix with the existing S5 network
/// bridge. User binds cannot shadow its reserved helper or IPC mounts.
pub fn bwrap_bridge_launch(
    bwrap: &str,
    scope: &LaunchScope,
    empty_dir: &Path,
    bridge: &LinuxBridgeLaunchSpec,
    target: &[String],
) -> Result<Vec<String>, String> {
    if !matches!(scope.network, NetworkPolicy::Allowlist { .. }) {
        return Err("Linux bridge requires an allowlist policy".into());
    }
    let reserved = Path::new(LINUX_EGRESS_DIR);
    for path in std::iter::once(&scope.cwd)
        .chain(&scope.readable)
        .chain(&scope.writable)
        .chain(&scope.denied_readable)
    {
        let path = Path::new(path);
        if !path.is_absolute()
            || path
                .components()
                .any(|part| matches!(part, std::path::Component::ParentDir))
            || path.starts_with(reserved)
            || reserved.starts_with(path)
        {
            return Err(format!(
                "scope path '{}' collides with reserved Linux bridge IPC",
                path.display()
            ));
        }
    }
    let mut launch = bwrap_prefix(bwrap, scope, empty_dir);
    // Replace the ordinary network flag and final separator, after every user
    // bind and protection mount. This renderer never emits --share-net here.
    launch.truncate(launch.len() - 2);
    launch.extend(
        render_linux_network_launch(&scope.network, Some(bridge), target)
            .map_err(|error| error.to_string())?,
    );
    Ok(launch)
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

/// Render a macOS sandbox that changes only network behavior. Filesystem,
/// process, and IPC access keep the caller's ordinary permissions, while all
/// outbound network access is denied except one loopback proxy port.
pub fn sandbox_exec_network_proxy_prefix(proxy_port: u16) -> Vec<String> {
    let mut profile = String::from("(version 1)\n(allow default)\n(deny network*)\n");
    push_loopback_proxy_network_rule(&mut profile, proxy_port);
    vec![
        "/usr/bin/sandbox-exec".to_string(),
        "-p".to_string(),
        profile,
        "--".to_string(),
    ]
}

/// Append the shared macOS SBPL rule that permits exactly one loopback proxy
/// port. Both one-shot allowlist sandboxes and the generic agent proxy launcher
/// use this renderer so the kernel-enforced boundary cannot drift.
pub(crate) fn push_loopback_proxy_network_rule(out: &mut String, proxy_port: u16) {
    sbpl::push_loopback_proxy_network_rule(out, proxy_port)
}

/// SBPL profile for an interactive launch — mirrors `MacOsSandboxBackend`'s
/// one-shot profile (deny-by-default + system reads + scoped read/write +
/// network gate).
pub fn render_sbpl(scope: &LaunchScope) -> String {
    let mut out = String::from("(version 1)\n(deny default)\n");
    // Process metadata, service lookup and the global read allow, shared with
    // `macos.rs` so the one-shot and interactive profiles cannot disagree about
    // whether a confined binary can load. Writes and network stay scoped below.
    if scope.restrict_readable {
        sbpl::push_scoped_loadability_base(&mut out);
    } else {
        sbpl::push_loadability_base(&mut out);
    }
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
    for denied in &scope.denied_readable {
        out.push_str(&format!(
            "(deny file-read* file-write* (subpath \"{}\"))\n",
            escape_sbpl(denied)
        ));
        // A root re-opened beneath the denied subtree is only reachable when
        // its ancestors can be stat'ed: realpath(3), which Node's `fs.realpath`
        // and `fs.watch` use, lstat()s every component. Grant exactly that
        // metadata on the denied root and the directories between it and each
        // re-opened root. Listing and reading stay denied, so sibling entries
        // (another task's home) remain hidden.
        let mut metadata = std::collections::BTreeSet::new();
        for allowed in scope.readable.iter().chain(writable.iter()) {
            let allowed = Path::new(allowed);
            if !allowed.starts_with(denied) || allowed == Path::new(denied) {
                continue;
            }
            for ancestor in allowed.ancestors().skip(1) {
                if !ancestor.starts_with(denied) {
                    break;
                }
                metadata.insert(ancestor.to_string_lossy().into_owned());
            }
        }
        for ancestor in &metadata {
            out.push_str(&format!(
                "(allow file-read-metadata (literal \"{}\"))\n",
                escape_sbpl(ancestor)
            ));
        }
        for allowed in scope
            .readable
            .iter()
            .filter(|allowed| Path::new(allowed).starts_with(denied) && *allowed != denied)
        {
            out.push_str(&format!(
                "(allow file-read* (subpath \"{}\"))\n",
                escape_sbpl(allowed)
            ));
        }
        for allowed in writable
            .iter()
            .filter(|allowed| Path::new(allowed).starts_with(denied) && *allowed != denied)
        {
            out.push_str(&format!(
                "(allow file-read* file-write* (subpath \"{}\"))\n",
                escape_sbpl(allowed)
            ));
        }
    }
    push_secret_read_denies(&mut out, &scope.readable);
    // Anchored at $HOME and the app data directory rather than at whatever the
    // caller declared readable. With reads open globally, a scope that does not
    // name home left `~/.ssh` and cognia's own vault readable to the launched
    // agent, which is the same hole the one-shot backend had.
    sbpl::push_baseline_secret_read_denies(&mut out);
    // Managed executions are placed inside the denied app store
    // (`<data>/cognia/task-workspaces/…`) and declared writable — but the
    // baseline deny lands later and wins, so the agent's own cwd was
    // unreadable and `getcwd()` killed the process before main() ran.
    // Re-open exactly the declared roots that nest there; every other child
    // of the store stays denied.
    {
        let declared: Vec<PathBuf> = scope
            .readable
            .iter()
            .chain(writable.iter())
            .map(PathBuf::from)
            .collect();
        sbpl::push_app_store_carveouts(&mut out, &declared);
    }
    if matches!(scope.network, NetworkPolicy::On) {
        out.push_str("(allow network*)\n");
    } else {
        out.push_str("(deny network*)\n");
        // Preserve the existing tool-host IPC channel without opening arbitrary
        // host Unix sockets (SSH agents, Docker, or sibling agent state).
        for root in &writable {
            if Path::new(root)
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|name| name.starts_with("cognia-toolhost-"))
            {
                out.push_str(&format!(
                    "(allow network-outbound (remote unix-socket (subpath \"{}\")))\n",
                    escape_sbpl(root)
                ));
            }
        }
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
    sbpl::escape(s)
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

/// Re-open a declared root that sits INSIDE a secret store the binds above
/// just shadowed.
///
/// Cognia's own app-data dir is a secret store, and it is also where the
/// Host keeps roots an agent is meant to use: managed execution workspaces
/// and each isolated configuration's private state root (ADR-0216,
/// `cognia/external-agents/<id>`). With `$HOME` readable, the empty bind over
/// the store lands after the writable binds and shadows the agent's own root,
/// so the agent could neither find its cwd nor its login. Bound again here,
/// after the shadow (a later bwrap bind wins), exactly the declared roots come
/// back and every sibling stays hidden — the same carve-out `render_sbpl` makes
/// on macOS and the `denied_readable` loop below makes for a denied subtree.
fn reopen_roots_under_shadowed_secrets(
    args: &mut Vec<String>,
    writable: &[String],
    readable: &[String],
) {
    let shadowed: Vec<PathBuf> = writable
        .iter()
        .chain(readable.iter())
        .flat_map(|root| protected_entries_under(Path::new(root)))
        .filter(|(_, kind, secret)| *secret && *kind == ProtKind::Dir)
        .map(|(path, _, _)| path)
        .collect();
    let nested = |root: &String| {
        let root = Path::new(root);
        shadowed
            .iter()
            .any(|store| root.starts_with(store) && root != store.as_path())
    };
    for root in readable.iter().filter(|root| nested(root)) {
        args.extend(["--ro-bind-try".into(), root.clone(), root.clone()]);
    }
    for root in writable.iter().filter(|root| nested(root)) {
        args.extend(["--bind".into(), root.clone(), root.clone()]);
    }
}

/// Emit SBPL deny rules for every protected path under each writable root —
/// mirrors `MacOsSandboxBackend::push_protected_denies`. ALL protected paths get
/// write + unlink denies; SECRET stores additionally get read denies.
fn push_protected_denies(out: &mut String, writable: &[String]) {
    sbpl::push_protected_denies(out, writable)
}

/// Emit `(deny file-read* …)` for SECRET stores reachable through the readable
/// roots — mirrors `MacOsSandboxBackend::push_secret_read_denies`. Comes after
/// the readable allow so the deny wins (SBPL last-match).
fn push_secret_read_denies(out: &mut String, readable: &[String]) {
    sbpl::push_secret_read_denies(out, readable)
}

#[cfg(test)]
mod tests {
    #[test]
    fn scoped_loader_grants_root_directory_without_global_content_reads() {
        let profile = render_sbpl(&LaunchScope { restrict_readable: true, ..scope() });
        assert!(profile.contains("(allow file-read-data (literal \"/\"))"));
        assert!(!profile.contains("(allow file-read*)\n"));
        assert!(!profile.contains("(subpath \"/\")"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn scoped_loader_runs_native_binary_but_cannot_read_an_ungranted_file() {
        use std::process::Command;
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let private = root.path().join("ungranted.txt");
        std::fs::write(&private, "not-for-the-child").unwrap();
        let profile = render_sbpl(&LaunchScope { cwd: workspace.to_string_lossy().into_owned(), writable: vec![workspace.to_string_lossy().into_owned()], readable: vec![], network: NetworkPolicy::Off, restrict_readable: true, ..scope() });
        let echo = Command::new("/usr/bin/sandbox-exec").args(["-p", &profile, "/bin/echo", "native-loader-ready"]).output().unwrap();
        assert!(echo.status.success(), "{:?}", echo);
        assert_eq!(echo.stdout, b"native-loader-ready\n");
        let read = Command::new("/usr/bin/sandbox-exec").args(["-p", &profile, "/bin/cat"]).arg(private).output().unwrap();
        assert!(!read.status.success());
        assert!(read.stdout.is_empty());
    }

    #[test]
    fn network_host_validation_uses_the_shared_matcher_grammar() {
        for host in [
            "api.example.com",
            "*.example.com",
            "API.EXAMPLE.COM",
            "8.8.8.8",
            "2606:4700:4700::1111",
        ] {
            assert!(
                super::validate_network_allowlist(&[host.into()]).is_ok(),
                "{host}"
            );
        }
        for host in [
            "",
            "*",
            "*.",
            "*.8.8.8.8",
            "example.com.",
            "https://example.com",
            "example.com/path",
            "example.com:443",
            "bad_host",
            "a..b",
            "evil\n.com",
        ] {
            assert!(
                super::validate_network_allowlist(&[host.into()]).is_err(),
                "{host}"
            );
        }
    }

    #[test]
    fn workspace_reads_and_allowlist_proxy_keep_credential_floors() {
        let scope = super::LaunchScope {
            cwd: "/work".into(),
            readable: vec!["/opt/toolchain".into()],
            restrict_readable: true,
            network: crate::types::NetworkPolicy::Allowlist {
                hosts: vec!["example.com".into()],
            },
            ..Default::default()
        };
        let profile = super::sandbox_exec_proxy_prefix(&scope, 32123)[2].clone();
        assert!(!profile.contains("(allow file-read*)\n"));
        assert!(profile.contains("(allow file-read-metadata)"));
        assert!(profile.contains("(subpath \"/opt/toolchain\")"));
        assert!(profile.contains("localhost:32123"));
        assert!(!profile.contains("(allow network*)"));
        assert!(profile.contains("(deny file-read* (subpath \"/work/.ssh\"))"));
    }

    #[test]
    fn bridge_launch_is_unshared_and_rejects_reserved_scope_roots() {
        let mut scope = super::LaunchScope {
            cwd: "/workspace".into(),
            network: crate::types::NetworkPolicy::Allowlist {
                hosts: vec!["example.com".into()],
            },
            ..Default::default()
        };
        let bridge = super::LinuxBridgeLaunchSpec {
            helper: "/host/helper".into(),
            proxy_socket: "/host/proxy.sock".into(),
            control_socket: "/host/control.sock".into(),
            as_pid_1: true,
        };
        let launch = super::bwrap_bridge_launch(
            "/bin/bwrap",
            &scope,
            std::path::Path::new("/empty"),
            &bridge,
            &["agent".into()],
        )
        .unwrap();
        assert!(launch.contains(&"--unshare-net".into()));
        assert!(!launch.contains(&"--share-net".into()));
        assert!(launch.ends_with(&["--linux-netns-bridge".into(), "--".into(), "agent".into()]));
        scope.readable.push("/run".into());
        assert!(super::bwrap_bridge_launch(
            "bwrap",
            &scope,
            std::path::Path::new("/empty"),
            &bridge,
            &["agent".into()]
        )
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn linux_allowlist_requires_owned_bridge_and_never_shares_network() {
        use crate::types::NetworkPolicy;
        let policy = NetworkPolicy::Allowlist {
            hosts: vec!["example.com".into()],
        };
        assert!(render_linux_network_launch(&policy, None, &["true".into()]).is_err());
        let spec = LinuxBridgeLaunchSpec {
            helper: "/trusted/helper".into(),
            proxy_socket: "/private/proxy.sock".into(),
            control_socket: "/private/control.sock".into(),
            as_pid_1: true,
        };
        let args = render_linux_network_launch(
            &policy,
            Some(&spec),
            &["echo".into(), "--share-net".into()],
        )
        .unwrap();
        assert_eq!(
            args.iter().filter(|a| a.as_str() == "--share-net").count(),
            1
        ); // only target argv
        assert!(args.contains(&"--unshare-net".into()));
        assert!(args.contains(&"--as-pid-1".into()));
        assert!(args.windows(2).any(|w| w == ["--cap-drop", "ALL"]));
        assert!(args.windows(3).any(|w| w
            == [
                "--ro-bind",
                "/private/proxy.sock",
                "/run/cognia-egress/proxy.sock"
            ]));
        assert_eq!(
            &args[args.len() - 5..],
            &[
                "/run/cognia-egress/helper",
                "--linux-netns-bridge",
                "--",
                "echo",
                "--share-net"
            ]
        );
        assert!(render_linux_network_launch(
            &NetworkPolicy::Allowlist { hosts: vec![] },
            Some(&spec),
            &[]
        )
        .is_err());
        assert_eq!(
            render_linux_network_launch(&NetworkPolicy::Off, None, &[]).unwrap(),
            ["--unshare-net", "--"]
        );
        assert_eq!(
            render_linux_network_launch(&NetworkPolicy::On, None, &[]).unwrap(),
            ["--share-net", "--"]
        );
    }

    #[cfg(unix)]
    #[test]
    fn linux_bridge_reserved_path_rejects_ancestors_descendants_and_traversal() {
        use crate::types::*;
        let mut command = SandboxCommand {
            argv: vec!["true".into()],
            cwd: "/workspace".into(),
            env: Default::default(),
            stdin: None,
            timeout: std::time::Duration::ZERO,
        };
        for path in [
            "/",
            "/run",
            "/run/cognia-egress",
            "/run/cognia-egress/proxy.sock",
            "/work/../run/cognia-egress",
        ] {
            let policy = SandboxPolicy::Bash {
                writable: vec![path.into()],
                readable: vec![],
                network: NetworkPolicy::On,
                max_cpu_seconds: 0,
                max_memory_mb: 0,
                max_processes: 0,
            };
            assert!(
                reject_linux_bridge_collisions(&command, &policy).is_err(),
                "{path}"
            );
        }
        let policy = SandboxPolicy::Edit {
            target_files: vec!["/run/cognia-egress-other".into()],
            readable: vec![],
        };
        assert!(reject_linux_bridge_collisions(&command, &policy).is_ok());
        command.cwd = "/run/cognia-egress".into();
        assert!(reject_linux_bridge_collisions(&command, &policy).is_err());
    }

    #[test]
    fn managed_task_hides_credentials_and_siblings_but_keeps_its_own_home() {
        let root = tempfile::tempdir().unwrap();
        let tasks = root.path().join("tasks");
        let own = tasks.join("one");
        std::fs::create_dir_all(&own).unwrap();
        let mut managed = scope();
        managed.writable.push(own.to_string_lossy().into_owned());
        managed.denied_readable = vec![
            tasks.to_string_lossy().into_owned(),
            "/home/u/.codex".into(),
        ];
        let profile = render_sbpl(&managed);
        let deny = format!(
            "(deny file-read* file-write* (subpath \"{}\"))",
            tasks.display()
        );
        let own_allow = format!(
            "(allow file-read* file-write* (subpath \"{}\"))",
            own.display()
        );
        assert!(profile.contains("(deny file-read* file-write* (subpath \"/home/u/.codex\"))"));
        assert!(profile.find(&deny).unwrap() < profile.find(&own_allow).unwrap());
        // The task can resolve its own home (realpath stats every ancestor),
        // but the denied root grants metadata only: no listing, no reads.
        let metadata = format!(
            "(allow file-read-metadata (literal \"{}\"))",
            tasks.display()
        );
        assert!(profile.find(&deny).unwrap() < profile.find(&metadata).unwrap());
        assert!(!profile.contains(&format!(
            "(allow file-read* (subpath \"{}\"))",
            tasks.display()
        )));
        assert!(!profile.contains("(allow file-read-metadata (literal \"/home/u/.codex\"))"));
        let args = bwrap_prefix("/usr/bin/bwrap", &managed, root.path());
        assert!(args.windows(3).any(|w| w
            == [
                "--ro-bind",
                root.path().to_str().unwrap(),
                tasks.to_str().unwrap()
            ]));
        assert!(args
            .windows(3)
            .any(|w| w == ["--bind", own.to_str().unwrap(), own.to_str().unwrap()]));
    }

    #[test]
    fn a_root_inside_the_shadowed_app_store_is_reopened_after_the_shadow() {
        // `$HOME` readable shadows `.local/share/cognia`; an isolated agent's
        // state root lives inside it and must come back, siblings must not.
        let mut isolated = scope();
        let own = "/home/u/.local/share/cognia/external-agents/agent_1".to_string();
        isolated.writable.push(own.clone());
        let args = bwrap_prefix("/usr/bin/bwrap", &isolated, Path::new("/run/cognia-empty"));
        let shadow_at = args
            .windows(3)
            .position(|w| {
                w == [
                    "--ro-bind",
                    "/run/cognia-empty",
                    "/home/u/.local/share/cognia",
                ]
            })
            .expect("the app store is shadowed");
        let reopen_at = args
            .windows(3)
            .rposition(|w| w == ["--bind", own.as_str(), own.as_str()])
            .expect("the agent's own root is bound again");
        assert!(reopen_at > shadow_at, "{args:?}");
        assert!(!args
            .windows(3)
            .any(|w| w[0] == "--bind" && w[1] == "/home/u/.local/share/cognia/external-agents"));
    }

    use std::path::PathBuf;

    use super::*;

    fn scope() -> LaunchScope {
        LaunchScope {
            cwd: "/work/project".to_string(),
            writable: vec!["/work/project".to_string()],
            denied_readable: vec![],
            readable: vec!["/home/u".to_string()],
            network: NetworkPolicy::On,
            restrict_readable: false,
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
        let bind = p
            .windows(3)
            .any(|w| w[0] == "--bind" && w[1] == "/work/project");
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
            network: NetworkPolicy::Off,
            restrict_readable: false,
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
    fn interactive_profile_allows_only_the_null_sink_device_write() {
        let profile = render_sbpl(&scope());
        assert!(profile.contains("(allow file-write-data (literal \"/dev/null\"))"));
        assert!(!profile.contains("(allow file-write-data (subpath \"/dev\"))"));
    }

    /// A managed execution cwd sits under `<data>/cognia/task-workspaces` —
    /// inside the store the baseline deny seals. Without the carve-out the
    /// profile hides the agent's own cwd and `getcwd()` fails before main().
    /// The declared root must be re-allowed AFTER the deny (last-match-wins)
    /// while the store's other children stay denied.
    #[test]
    fn a_workspace_inside_the_denied_app_store_stays_reachable() {
        let Some(store) = dirs::data_dir().map(|d| d.join("cognia")) else {
            return; // no per-user data dir on this host — nothing to assert
        };
        let ws = store
            .join("task-workspaces")
            .join("executions")
            .join("probe");
        let profile = render_sbpl(&LaunchScope {
            cwd: ws.to_string_lossy().into_owned(),
            writable: vec![ws.to_string_lossy().into_owned()],
            readable: vec![],
            denied_readable: vec![],
            network: NetworkPolicy::On,
            restrict_readable: false,
        });
        let deny = format!("(deny file-read* (literal \"{}\"))", store.display());
        // Emitted rules carry the canonical spelling (`Cognia` on disk), not
        // the deny's lowercase `cognia` — rebuild it the way the renderer does.
        let canon_store = std::fs::canonicalize(&store).unwrap_or_else(|_| store.clone());
        let emitted_ws = canon_store.join(ws.strip_prefix(&store).expect("ws under store"));
        // Match the final carve-out rule, not the earlier writable-root
        // clause, which has the same spelling on case-sensitive filesystems.
        let allow = format!("(allow file-read* (subpath \"{}\"))", emitted_ws.display());
        let deny_at = profile
            .find(&deny)
            .unwrap_or_else(|| panic!("store deny missing\n{profile}"));
        let allow_at = profile
            .find(&allow)
            .unwrap_or_else(|| panic!("workspace carve-out missing\n{profile}"));
        assert!(
            allow_at > deny_at,
            "carve-out must follow the deny\n{profile}"
        );
        // The store itself is re-opened for traversal only, never as a subpath.
        for spelling in [
            store.display().to_string(),
            canon_store.display().to_string(),
        ] {
            assert!(
                !profile.contains(&format!("(allow file-read* (subpath \"{spelling}\"))")),
                "{profile}"
            );
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn interactive_profile_runs_git_with_closed_stdin_and_keeps_writes_scoped() {
        let profile = render_sbpl(&scope());
        let output = std::process::Command::new("/usr/bin/sandbox-exec")
            .args([
                "-p",
                &profile,
                "/bin/sh",
                "-c",
                "printf ok >/dev/null; exec 0<&-; exec /usr/bin/git --version",
            ])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("git version"));
        let outside = tempfile::tempdir().unwrap();
        let denied = outside.path().join("must-not-exist");
        let output = std::process::Command::new("/usr/bin/sandbox-exec")
            .args(["-p", &profile, "/usr/bin/touch"])
            .arg(&denied)
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(!denied.exists());
    }

    #[test]
    fn network_only_proxy_profile_does_not_change_filesystem_access() {
        let p = sandbox_exec_network_proxy_prefix(7890);
        assert!(p[2].contains("(allow default)"));
        assert!(p[2].contains("(deny network*)"));
        assert!(p[2].contains("(allow network-outbound (remote tcp \"localhost:7890\"))"));
        assert!(!p[2].contains("file-read"));
        assert!(!p[2].contains("file-write"));
    }

    #[test]
    fn sbpl_scopes_writes_and_gates_network() {
        let prof = render_sbpl(&scope());
        assert!(prof.contains("(subpath \"/work/project\")"));
        assert!(prof.contains("(subpath \"/home/u\")"));
        assert!(prof.contains("(allow network*)"));
        let off = render_sbpl(&LaunchScope {
            network: NetworkPolicy::Off,
            restrict_readable: false,
            ..scope()
        });
        assert!(off.contains("(deny network*)"));
    }

    #[test]
    fn writable_set_dedups_and_forces_cwd() {
        let s = LaunchScope {
            cwd: "/a".to_string(),
            writable: vec!["/a".to_string(), "/b".to_string(), "/b".to_string()],
            denied_readable: vec![],
            readable: vec![],
            network: NetworkPolicy::Off,
            restrict_readable: false,
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
        let git_redenied = p.windows(3).any(|w| w[0] == "--ro-bind-try" && w[1] == git);
        assert!(
            git_redenied,
            "protected .git not re-denied in terminal launcher"
        );
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
        // `~/.cognia` CLI credential store) was fully readable.
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
        let cli_home = std::path::Path::new("/home/u")
            .join(".cognia")
            .to_string_lossy()
            .into_owned();
        assert_eq!(
            ro_bind_src_for(&p, &cli_home).as_deref(),
            Some("/run/cognia-empty"),
            "cognia-agent credentials under $HOME must be hidden"
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

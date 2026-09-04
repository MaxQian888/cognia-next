// ADR-0028, the one macOS Seatbelt rule renderer.
//
// Two callers render SBPL for the same threat model: `macos.rs` for one-shot
// `sandbox_*` tool calls, and `launcher.rs` for interactive PTY / external-agent
// launches. Each used to carry its own copy of the base rules and both deny
// emitters, with comments claiming to mirror the other. They had drifted, and
// the drift was load-bearing: `launcher.rs` learned that a scoped read list
// aborts every confined binary on modern macOS and switched to a global read
// allow, while `macos.rs` kept the narrow list. The result was that every
// one-shot sandbox call on macOS died with SIGABRT and `sandbox_health_check`
// reported `confined: false` while the cheap probe still showed "Active".
//
// The rules that decide whether a confined program can load at all, and the
// rules that decide whether it can read a credential store, now live here once.
// Each caller keeps its own scoped allows (writable roots, target files,
// network shape) because those genuinely differ.
//
// Pure except for `baseline_secret_roots`, which reads the user's home and app
// data directory. Compiled on every platform so the renderers stay unit-testable
// off macOS.

use std::path::{Path, PathBuf};

use crate::sandbox::protected::protected_entries_under;

/// Escape a path for an SBPL string literal.
pub(crate) fn escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// The rules a confined program needs before it can load, independent of what
/// the policy scopes.
///
/// `(allow process*)` covers the process-metadata operations dyld performs
/// beyond fork/exec. The bare `(allow file-read*)` is the one that is not
/// negotiable: modern macOS consults runtime files whose locations move across
/// releases, so no enumerable prefix set loads a binary. `/bin/echo` under a
/// profile carrying the full system prefix list and nothing else dies with
/// SIGABRT before it ever execs.
///
/// Reads being open is compensated by [`push_baseline_secret_read_denies`],
/// which every caller must emit as its LAST rules. Writes and network stay
/// scoped by the caller.
pub(crate) fn push_loadability_base(out: &mut String) {
    out.push_str("(allow process*)\n");
    out.push_str("(allow mach-lookup)\n");
    out.push_str("(allow sysctl-read)\n");
    out.push_str("(allow file-read*)\n");
}

/// Write-deny every protected path under each writable root, and read-deny the
/// SECRET ones as well.
///
/// Protected paths are write-denied so a confined command cannot rewrite a
/// repo's `.git/hooks` or a shell rc for persistence, and `file-write-unlink` is
/// denied on the literal so a `mv` cannot relocate a denied file out of the way.
/// Secret stores are additionally read-denied, because reading an SSH key is
/// itself the exfiltration threat the carve-out exists to stop.
///
/// SBPL is last-match-wins, so the caller must emit this AFTER its writable
/// allows.
pub(crate) fn push_protected_denies(out: &mut String, writable: &[impl AsRef<Path>]) {
    for root in writable {
        for (protected, _kind, secret) in protected_entries_under(root.as_ref()) {
            let p = escape(&protected.to_string_lossy());
            out.push_str(&format!("(deny file-write* (subpath \"{p}\"))\n"));
            out.push_str(&format!("(deny file-write* (literal \"{p}\"))\n"));
            out.push_str(&format!("(deny file-write-unlink (literal \"{p}\"))\n"));
            if secret {
                push_read_deny(out, &p);
            }
        }
    }
}

/// Read-deny the SECRET stores reachable through each of `roots`. A readable
/// root grants read only, so the write-protected tier needs no rule here.
pub(crate) fn push_secret_read_denies(out: &mut String, roots: &[impl AsRef<Path>]) {
    for root in roots {
        for (protected, _kind, secret) in protected_entries_under(root.as_ref()) {
            if secret {
                push_read_deny(out, &escape(&protected.to_string_lossy()));
            }
        }
    }
}

/// The roots whose credential stores must be denied no matter what the caller
/// declared: the user's home, and cognia's own app data directory (keyring
/// material, the vault, the native vector store).
///
/// With reads open by default the caller's `readable` list no longer bounds what
/// can be read, so anchoring the deny set at a root the caller passed is not
/// enough. A session whose workspace sits outside home would otherwise read
/// `~/.ssh` freely.
pub(crate) fn baseline_secret_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(home) = dirs::home_dir() {
        roots.push(home);
    }
    roots
}

/// Emit the unconditional credential denies. Every caller emits this LAST, so
/// the rules win over every allow above them.
pub(crate) fn push_baseline_secret_read_denies(out: &mut String) {
    push_secret_read_denies(out, &baseline_secret_roots());
    // The app's own store is already refused as a WRITE target by the
    // dispatcher's forbidden-root floor. With reads open it has to be refused as
    // a read target too, and it is not covered by the `PROTECTED` list because
    // that one is relative to a root rather than absolute.
    if let Some(data) = dirs::data_dir() {
        push_read_deny(out, &escape(&data.join("cognia").to_string_lossy()));
    }
}

/// The shared rule permitting exactly one loopback proxy port. Both the one-shot
/// allowlist sandbox and the generic agent proxy launcher use it so the
/// kernel-enforced egress boundary cannot drift.
pub(crate) fn push_loopback_proxy_network_rule(out: &mut String, proxy_port: u16) {
    out.push_str(&format!(
        "(allow network-outbound (remote tcp \"localhost:{proxy_port}\"))\n"
    ));
}

/// Deny both spellings of a path. `subpath` covers a directory's contents,
/// `literal` covers the entry itself, and a secret store has to be denied
/// whether or not it exists yet (creating `~/.ssh/...` is always hostile).
fn push_read_deny(out: &mut String, escaped: &str) {
    out.push_str(&format!("(deny file-read* (subpath \"{escaped}\"))\n"));
    out.push_str(&format!("(deny file-read* (literal \"{escaped}\"))\n"));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escape_handles_quotes_and_backslashes() {
        assert_eq!(escape(r#"/a "b"\c"#), r#"/a \"b\"\\c"#);
    }

    #[test]
    fn loadability_base_allows_reads_globally() {
        // The rule whose absence killed every macOS sandbox call. Pinning the
        // bare form keeps a future narrowing from silently re-breaking it.
        let mut out = String::new();
        push_loadability_base(&mut out);
        assert!(out.contains("(allow file-read*)\n"), "{out}");
        assert!(out.contains("(allow process*)\n"), "{out}");
    }

    #[test]
    fn protected_denies_cover_write_unlink_and_secret_reads() {
        let mut out = String::new();
        push_protected_denies(&mut out, &[PathBuf::from("/workspace")]);
        assert!(out.contains("(deny file-write* (subpath \"/workspace/.git\"))"));
        assert!(out.contains("(deny file-write-unlink (literal \"/workspace/.git\"))"));
        // `.ssh` is a secret, so it is read-denied as well as write-denied.
        assert!(out.contains("(deny file-read* (subpath \"/workspace/.ssh\"))"));
        // `.gitconfig` is write-protected but not secret, so reads stay open.
        assert!(!out.contains("(deny file-read* (literal \"/workspace/.gitconfig\"))"));
    }

    #[test]
    fn secret_read_denies_skip_the_write_protected_tier() {
        let mut out = String::new();
        push_secret_read_denies(&mut out, &[PathBuf::from("/home/u")]);
        assert!(out.contains("(deny file-read* (subpath \"/home/u/.ssh\"))"));
        assert!(out.contains("(deny file-read* (subpath \"/home/u/.aws\"))"));
        assert!(!out.contains("/home/u/.git\""), "{out}");
    }

    #[test]
    fn baseline_denies_anchor_at_home_and_the_app_store() {
        let mut out = String::new();
        push_baseline_secret_read_denies(&mut out);
        if let Some(home) = dirs::home_dir() {
            let ssh = escape(&home.join(".ssh").to_string_lossy());
            assert!(
                out.contains(&format!("(deny file-read* (subpath \"{ssh}\"))")),
                "{out}"
            );
        }
        if let Some(data) = dirs::data_dir() {
            let store = escape(&data.join("cognia").to_string_lossy());
            assert!(
                out.contains(&format!("(deny file-read* (subpath \"{store}\"))")),
                "{out}"
            );
        }
    }

    #[test]
    fn the_proxy_rule_names_exactly_one_loopback_port() {
        let mut out = String::new();
        push_loopback_proxy_network_rule(&mut out, 7890);
        assert_eq!(
            out,
            "(allow network-outbound (remote tcp \"localhost:7890\"))\n"
        );
    }

    #[test]
    fn accepts_both_path_and_string_roots() {
        // `macos.rs` holds `PathBuf` roots and `launcher.rs` holds `String`
        // ones. Taking `AsRef<Path>` is what lets one emitter serve both
        // instead of the two copies this module replaced.
        let mut from_paths = String::new();
        push_secret_read_denies(&mut from_paths, &[PathBuf::from("/home/u")]);
        let mut from_strings = String::new();
        push_secret_read_denies(&mut from_strings, &["/home/u".to_string()]);
        assert_eq!(from_paths, from_strings);
    }
}

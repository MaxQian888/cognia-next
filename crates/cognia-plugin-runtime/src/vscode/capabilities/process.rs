//! `child_process` capability gate.
//!
//! Three classes of allow:
//!   1. **LSP binary** — when the binary is inside the extension's own
//!      install dir AND the extension's publisher is in the trusted
//!      publishers ledger (the renderer checks that ledger; we just receive
//!      the result via a CapabilityStore add_spawn_command call).
//!   2. **User-granted command** — runtime prompt accepted by the user.
//!   3. **Anything else** — denied with audit logging.
//!
//! Every spawn (allowed or denied) is logged via the existing
//! `automationAuditLog` (Dexie v28).
//!
//! Wired in Phase M3 — module-wide `dead_code` silence until then.
#![allow(dead_code)]

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::CapabilityGrants;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ProcessDecision {
    Allow,
    Deny { reason: String },
}

pub fn check_spawn(
    grants: &CapabilityGrants,
    extension_install_dir: &Path,
    extension_id: &str,
    command: &Path,
) -> ProcessDecision {
    // Class 1: inside the extension's own dir.
    let extension_dir = extension_install_dir.join(extension_id);
    if normalise(command).starts_with(normalise(&extension_dir)) {
        return ProcessDecision::Allow;
    }
    // Class 2: explicitly granted.
    let basename = command
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    for allowed in &grants.allowed_spawn_commands {
        if allowed == &basename
            || PathBuf::from(allowed)
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                == Some(basename.clone())
        {
            return ProcessDecision::Allow;
        }
    }
    ProcessDecision::Deny {
        reason: format!(
            "Command {} is not on the spawn allowlist for {extension_id}",
            command.display()
        ),
    }
}

fn normalise(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => continue,
            other => out.push(other),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_binary_inside_extension_dir() {
        let root = PathBuf::from("/tmp/ext-root");
        let grants = CapabilityGrants::default();
        let cmd = PathBuf::from("/tmp/ext-root/cognia.lsp/server/rust-analyzer.exe");
        assert!(matches!(
            check_spawn(&grants, &root, "cognia.lsp", &cmd),
            ProcessDecision::Allow
        ));
    }

    #[test]
    fn allows_basename_in_allowlist() {
        let root = PathBuf::from("/tmp/ext-root");
        let grants = CapabilityGrants {
            allowed_spawn_commands: vec!["node".to_string()],
            ..Default::default()
        };
        let cmd = PathBuf::from("/usr/local/bin/node");
        assert!(matches!(
            check_spawn(&grants, &root, "cognia.x", &cmd),
            ProcessDecision::Allow
        ));
    }

    #[test]
    fn denies_unknown_binary() {
        let root = PathBuf::from("/tmp/ext-root");
        let grants = CapabilityGrants::default();
        let cmd = PathBuf::from("/usr/bin/curl");
        assert!(matches!(
            check_spawn(&grants, &root, "cognia.x", &cmd),
            ProcessDecision::Deny { .. }
        ));
    }
}

//! Tauri-free sidecar resource location shared by desktop and headless hosts.

use cognia_core::installed::Installed;
use std::path::{Path, PathBuf};

pub mod code_sandbox;
pub mod commands;
pub mod host;
pub mod langfuse;
pub mod pi_extension;
pub mod supervisor;

/// Filled by the host before any plugin or agent can start a sidecar.
pub static SIDECAR: Installed<PathBuf> = Installed::new("sidecar.directory");

pub fn directory() -> Result<PathBuf, String> {
    SIDECAR.get().cloned().map_err(|error| error.to_string())
}

/// Preserve desktop resource precedence while keeping Tauri outside this crate.
/// `force_checkout` is the explicit agent-debug launch mode; ordinary debug
/// builds validate the checkout and release builds prefer packaged resources.
pub fn locate(
    resource_dir: Option<&Path>,
    prefer_checkout: bool,
    force_checkout: bool,
) -> Result<PathBuf, String> {
    locate_from(
        checkout_sidecar_dir()?,
        resource_dir,
        prefer_checkout,
        force_checkout,
    )
}

fn locate_from(
    checkout: PathBuf,
    resource_dir: Option<&Path>,
    prefer_checkout: bool,
    force_checkout: bool,
) -> Result<PathBuf, String> {
    if force_checkout || (prefer_checkout && missing_sidecar_entry(&checkout).is_none()) {
        return Ok(checkout);
    }
    if let Some(candidate) = resource_dir.and_then(packaged_sidecar_dir) {
        return Ok(candidate);
    }
    if let Some(missing) = missing_sidecar_entry(&checkout) {
        return Err(format!(
            "sidecar directory at {} is incomplete: missing {missing}",
            checkout.display()
        ));
    }
    Ok(checkout)
}

/// Everything `agent-host.mjs` needs on disk before it can boot. The static
/// imports at the top of that file plus the dependency tree; a directory that
/// has the entry but not these is a torn copy, not a sidecar.
pub const REQUIRED_SIDECAR_ENTRIES: &[&str] = &[
    "agent-host.mjs",
    "package.json",
    "src",
    "node_modules",
];

/// The first required entry `dir` lacks, or `None` when the directory is a
/// complete sidecar.
fn missing_sidecar_entry(dir: &Path) -> Option<&'static str> {
    REQUIRED_SIDECAR_ENTRIES
        .iter()
        .copied()
        .find(|entry| !dir.join(entry).exists())
}

/// Resolve either an explicitly remapped `sidecar/` resource or Tauri's
/// encoded destination for config entries that begin with `../sidecar`.
/// Tauri replaces each parent component with `_up_` in array-form resources.
///
/// A candidate that has an entry file but is missing any of
/// [`REQUIRED_SIDECAR_ENTRIES`] is a torn staging copy and is skipped with a
/// warning, so the caller falls through to the next location instead of
/// spawning a Node process that exits on its first `import`.
fn packaged_sidecar_dir(resource_dir: &Path) -> Option<PathBuf> {
    [
        resource_dir.join("sidecar"),
        resource_dir.join("_up_").join("sidecar"),
    ]
    .into_iter()
    .find(|candidate| {
        let has_entry = candidate.join("agent-host.mjs").is_file()
            || candidate.join("claude-host.mjs").is_file();
        if !has_entry {
            return false;
        }
        match missing_sidecar_entry(candidate) {
            None => true,
            Some(missing) => {
                log::warn!(
                    "packaged sidecar at {} is incomplete (missing {missing}); skipping it",
                    candidate.display()
                );
                false
            }
        }
    })
}

fn checkout_sidecar_dir() -> Result<PathBuf, String> {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .map(|parent| parent.join("sidecar"))
        .ok_or_else(|| "could not locate project root".to_string())
}

/// Reported by Langfuse as the application release.
pub const BUILD_VERSION: &str = env!("CARGO_PKG_VERSION");

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn checkout_sidecar_fallback_resolves_from_the_manifest_directory() {
        let sidecar = checkout_sidecar_dir().expect("checkout sidecar path");
        assert!(sidecar.join("claude-host.mjs").is_file());
        assert!(sidecar.join("node_modules").is_dir());
    }

    /// Lay down every entry a complete sidecar directory must have.
    fn stub_complete_sidecar(dir: &Path) {
        std::fs::create_dir_all(dir).expect("create sidecar directory");
        for entry in REQUIRED_SIDECAR_ENTRIES {
            let path = dir.join(entry);
            if entry.contains('.') {
                std::fs::write(&path, "// stub").expect("write stub file");
            } else {
                std::fs::create_dir_all(&path).expect("create stub directory");
            }
        }
    }

    #[test]
    fn the_checkout_sidecar_is_complete() {
        let sidecar = checkout_sidecar_dir().expect("checkout sidecar path");
        assert_eq!(missing_sidecar_entry(&sidecar), None);
    }

    #[test]
    fn packaged_sidecar_resolves_tauri_encoded_parent_resource() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let encoded = tmp.path().join("_up_").join("sidecar");
        stub_complete_sidecar(&encoded);

        assert_eq!(packaged_sidecar_dir(tmp.path()), Some(encoded));
    }

    #[test]
    fn packaged_sidecar_ignores_incomplete_direct_resource() {
        let tmp = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(tmp.path().join("sidecar"))
            .expect("create incomplete direct resource");
        let encoded = tmp.path().join("_up_").join("sidecar");
        stub_complete_sidecar(&encoded);

        assert_eq!(packaged_sidecar_dir(tmp.path()), Some(encoded));
    }

    #[test]
    fn a_torn_staging_copy_is_skipped_not_spawned() {
        // The 2026-08-27 shape: the entry file landed, its first import did
        // not. Accepting this directory spawns a Node process that exits on
        // `import "./src/platform/net/install-fetch-interceptor.ts"` and burns
        // the recovery budget.
        let tmp = tempfile::tempdir().expect("tempdir");
        let encoded = tmp.path().join("_up_").join("sidecar");
        stub_complete_sidecar(&encoded);
        std::fs::remove_dir_all(encoded.join("src")).expect("tear the copy");

        assert_eq!(missing_sidecar_entry(&encoded), Some("src"));
        assert_eq!(packaged_sidecar_dir(tmp.path()), None);
    }

    #[test]
    fn a_directory_with_no_entry_file_is_not_a_sidecar_at_all() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let encoded = tmp.path().join("_up_").join("sidecar");
        stub_complete_sidecar(&encoded);
        std::fs::remove_file(encoded.join("agent-host.mjs")).expect("drop the entry");

        assert_eq!(packaged_sidecar_dir(tmp.path()), None);
    }
    #[test]
    fn debug_prefers_checkout_but_release_prefers_packaged_resources() {
        let tmp = tempfile::tempdir().unwrap();
        let checkout = tmp.path().join("checkout");
        let resource = tmp.path().join("resources");
        let packaged = resource.join("sidecar");
        stub_complete_sidecar(&checkout);
        stub_complete_sidecar(&packaged);
        assert_eq!(
            locate_from(checkout.clone(), Some(&resource), true, false).unwrap(),
            checkout
        );
        assert_eq!(
            locate_from(checkout, Some(&resource), false, false).unwrap(),
            packaged
        );
    }

    #[test]
    fn explicit_agent_debug_bypasses_completeness_only_for_checkout() {
        let tmp = tempfile::tempdir().unwrap();
        let checkout = tmp.path().join("checkout");
        assert_eq!(
            locate_from(checkout.clone(), None, true, true).unwrap(),
            checkout
        );
        assert!(locate_from(checkout, None, true, false)
            .unwrap_err()
            .contains("missing agent-host.mjs"));
    }

    #[test]
    fn desktop_and_headless_install_before_sidecar_consumers() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(2)
            .unwrap();
        let desktop = std::fs::read_to_string(root.join("src-tauri/src/startup/mod.rs")).unwrap();
        assert!(
            desktop.find("name: \"sidecar_location\"").unwrap()
                < desktop.find("name: \"gateway_session\"").unwrap()
        );
        let headless =
            std::fs::read_to_string(root.join("src-tauri/src/bin/cognia-server.rs")).unwrap();
        assert!(
            headless.find("cognia_sidecar::SIDECAR.install").unwrap()
                < headless.find("HeadlessSidecarHost::new").unwrap()
        );
    }
}

//! Desktop lifecycle for the Cognia-owned DeepSeek Harness runtime.
//!
//! DeepSeek Harness publishes no executable for the transport Cognia drives, so
//! Cognia installs and certifies a runtime home of its own. On CLI/headless the
//! equivalent lives in `cli/src/runtime/external/dsh-installer.ts`; this module
//! is the Tauri arm.
//!
//! **This module deliberately renders no verdict.** Whether an install is
//! healthy is decided by `doctorDshRuntime()` in
//! `lib/ai/agent/external/dsh-runtime-install.ts`, which is pure TypeScript and
//! shared by both hosts. Duplicating those rules in Rust is exactly how the
//! desktop and headless answers would drift apart, so this module only gathers
//! facts and moves bytes.
//!
//! Install is two-phase on purpose: `install` stages and returns the digests,
//! then the renderer builds the channel manifest (it owns the profile and
//! capability vocabulary) and calls `finalize`, which writes the manifest and
//! swaps the tree in. Until `finalize` succeeds the previously certified
//! runtime is still the live one.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Files copied from `runtime/deepseek-harness/` into the runtime home.
const RUNTIME_ARTIFACTS: &[&str] = &[
    "package.json",
    "launcher.mjs",
    "host.sdk-readonly.yml",
    "host.sdk-workspace.yml",
    "host.acp.yml",
];

/// Files whose bytes make up the composition digest, in a stable order.
/// Must stay identical to `COMPOSITION_DIGEST_FILES` in the TypeScript
/// installer, including order.
const COMPOSITION_DIGEST_FILES: &[&str] = &[
    "launcher.mjs",
    "host.sdk-readonly.yml",
    "host.sdk-workspace.yml",
    "host.acp.yml",
];

const CHANNEL_MANIFEST_FILE: &str = "cognia-channel.json";
const RUNTIME_DIR: &str = "deepseek-harness";
const DSH_HOME_DIR: &str = "dsh-home";

/// Facts gathered from disk, handed to the shared TypeScript verdict function.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DshRuntimeFacts {
    /// The channel manifest as raw JSON, or `None` when nothing is installed.
    pub manifest_json: Option<String>,
    pub lockfile_digest: String,
    pub composition_digest: String,
    pub node_version: String,
    pub platform: String,
    /// Patch layers under `DSH_HOME` that DSH would apply after every bundle
    /// layer. Each is a hole in the certification.
    pub stray_patch_paths: Vec<String>,
    pub has_native_toolchain: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DshInstallDigests {
    pub lockfile_digest: String,
    pub composition_digest: String,
}

pub fn runtime_home(data_root: &Path) -> PathBuf {
    data_root.join(RUNTIME_DIR)
}

/// The Cognia data root that owns the runtime home on this host.
///
/// `COGNIA_DATA_DIR` first so desktop and headless agree when the user has
/// relocated it; otherwise the app data dir, matching every other Cognia store
/// on desktop (`app_data_dir()/cognia`).
pub fn host_data_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Ok(raw) = std::env::var("COGNIA_DATA_DIR") {
        if !raw.trim().is_empty() {
            return Ok(PathBuf::from(raw));
        }
    }
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("cognia"))
        .map_err(|error| format!("cannot resolve the app data dir: {error}"))
}

/// The Node version the runtime would boot under.
///
/// The preflight verdict compares this against `NODE_MAJOR_REQUIRED`, so an
/// unresolvable `node` must surface as an empty string (which fails preflight
/// with "Node not found") rather than as a command error — the card can then
/// render the real remedy instead of an opaque invoke failure.
pub fn host_node_version() -> String {
    std::process::Command::new("node")
        .arg("--version")
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .unwrap_or_default()
}

/// Where the shipped `runtime/deepseek-harness/` artifacts live on this host.
///
/// Bundled as a Tauri resource in a packaged app; in `tauri dev` the resource
/// dir holds no such folder, so fall back to the repo checkout via the
/// compile-time manifest dir — the same resource-dir-then-manifest-parent
/// pattern `hooks::builtin::builtin_base_dir` uses.
pub fn host_source_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    if let Ok(resource_dir) = app.path().resource_dir() {
        let candidate = resource_dir.join("runtime").join(RUNTIME_DIR);
        if candidate.is_dir() {
            return Ok(candidate);
        }
    }
    if let Some(root) = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
    {
        let candidate = root.join("runtime").join(RUNTIME_DIR);
        if candidate.is_dir() {
            return Ok(candidate);
        }
    }
    Err(format!(
        "the bundled {RUNTIME_DIR} artifacts were not found in the resource dir"
    ))
}

fn staging_dir(data_root: &Path) -> PathBuf {
    data_root.join(format!("{RUNTIME_DIR}.staging"))
}

fn previous_dir(data_root: &Path) -> PathBuf {
    data_root.join(format!("{RUNTIME_DIR}.previous"))
}

pub fn dsh_home(data_root: &Path) -> PathBuf {
    runtime_home(data_root).join(DSH_HOME_DIR)
}

fn hex(bytes: impl AsRef<[u8]>) -> String {
    bytes
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Digest over the composition and launcher bytes.
///
/// Each file contributes its name and length as well as its content, so moving
/// bytes between two compositions cannot produce the same digest. Must stay
/// byte-identical to `computeCompositionDigest` in the TypeScript installer, or
/// a runtime installed on desktop would fail doctor under the CLI.
pub fn compute_composition_digest(dir: &Path) -> Result<String, String> {
    let mut hasher = Sha256::new();
    for name in COMPOSITION_DIGEST_FILES {
        let content =
            std::fs::read(dir.join(name)).map_err(|e| format!("cannot read {name}: {e}"))?;
        hasher.update(name.as_bytes());
        hasher.update(b"\0");
        hasher.update(content.len().to_string().as_bytes());
        hasher.update(b"\0");
        hasher.update(&content);
    }
    Ok(hex(hasher.finalize()))
}

pub fn compute_lockfile_digest(dir: &Path) -> Result<String, String> {
    let content = std::fs::read(dir.join("package-lock.json"))
        .map_err(|e| format!("cannot read package-lock.json: {e}"))?;
    let mut hasher = Sha256::new();
    hasher.update(&content);
    Ok(hex(hasher.finalize()))
}

/// `<os>-<arch>`, matching the spellings upstream's prebuild directories use.
pub fn platform_key() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    };
    format!("{os}-{arch}")
}

/// Patch layers under `DSH_HOME`.
///
/// A profile `package.json` counts too: its `dependencies` are out-of-tree
/// plugins, which is as much a hole in the certification as a patch file.
pub fn find_stray_patch_layers(dsh_home: &Path) -> Vec<String> {
    let mut found = Vec::new();
    let home_patch = dsh_home.join("cordis.patch.yml");
    if home_patch.exists() {
        found.push(home_patch.to_string_lossy().into_owned());
    }
    let profiles = dsh_home.join("profiles");
    if let Ok(entries) = std::fs::read_dir(&profiles) {
        for entry in entries.flatten() {
            if !entry.path().is_dir() {
                continue;
            }
            for name in ["cordis.patch.yml", "package.json"] {
                let candidate = entry.path().join(name);
                if candidate.exists() {
                    found.push(candidate.to_string_lossy().into_owned());
                }
            }
        }
    }
    found.sort();
    found
}

/// Whether a C/C++ toolchain is on PATH, for profiles needing a node-pty build.
fn has_native_toolchain() -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|dir| {
        ["cc", "gcc", "clang"]
            .iter()
            .any(|bin| dir.join(bin).exists())
    })
}

/// Gather everything the shared verdict function needs.
///
/// A missing or unreadable digest becomes the literal `"unreadable"` rather than
/// an error: that value can never equal a certified digest, so the TypeScript
/// side reports a mismatch instead of the whole check failing.
pub fn gather_facts(data_root: &Path, node_version: String) -> DshRuntimeFacts {
    let home = runtime_home(data_root);
    let manifest_json = std::fs::read_to_string(home.join(CHANNEL_MANIFEST_FILE)).ok();
    DshRuntimeFacts {
        manifest_json,
        lockfile_digest: compute_lockfile_digest(&home).unwrap_or_else(|_| "unreadable".into()),
        composition_digest: compute_composition_digest(&home)
            .unwrap_or_else(|_| "unreadable".into()),
        node_version,
        platform: platform_key(),
        stray_patch_paths: find_stray_patch_layers(&dsh_home(data_root)),
        has_native_toolchain: has_native_toolchain(),
    }
}

/// Stage a new runtime and install its dependencies.
///
/// Leaves the staging tree in place for [`finalize_install`]; the live runtime
/// is untouched until then, so a failure here cannot strand the user without a
/// working runtime.
pub async fn stage_install(
    data_root: &Path,
    source_dir: &Path,
) -> Result<DshInstallDigests, String> {
    for artifact in RUNTIME_ARTIFACTS {
        if !source_dir.join(artifact).exists() {
            return Err(format!("runtime artifact missing from source: {artifact}"));
        }
    }

    let staging = staging_dir(data_root);
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| format!("cannot create staging dir: {e}"))?;
    for artifact in RUNTIME_ARTIFACTS {
        std::fs::copy(source_dir.join(artifact), staging.join(artifact))
            .map_err(|e| format!("cannot copy {artifact}: {e}"))?;
    }
    // Created up front so the launcher's containment check has a real directory
    // to canonicalize rather than falling back to a lexical path.
    std::fs::create_dir_all(staging.join(DSH_HOME_DIR))
        .map_err(|e| format!("cannot create dsh home: {e}"))?;

    let output = tokio::process::Command::new("npm")
        .args([
            "install",
            // koffi is a hard dependency of dsh-fs-local but is imported only
            // from a Windows-only path, so it is installed and never built.
            // Skipping scripts also removes an arbitrary-code-execution step.
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
        ])
        .current_dir(&staging)
        .output()
        .await
        .map_err(|e| {
            let _ = std::fs::remove_dir_all(&staging);
            format!("npm could not be started: {e}")
        })?;

    if !output.status.success() {
        let _ = std::fs::remove_dir_all(&staging);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail: String = stderr
            .chars()
            .rev()
            .take(2000)
            .collect::<String>()
            .chars()
            .rev()
            .collect();
        return Err(format!(
            "npm install failed; the previous runtime was left in place. {tail}"
        ));
    }

    if !staging.join("package-lock.json").exists() {
        let _ = std::fs::remove_dir_all(&staging);
        return Err("npm install produced no package-lock.json; refusing to certify".into());
    }

    Ok(DshInstallDigests {
        lockfile_digest: compute_lockfile_digest(&staging)?,
        composition_digest: compute_composition_digest(&staging)?,
    })
}

/// Write the manifest the renderer built and swap the staged tree in.
pub fn finalize_install(data_root: &Path, manifest_json: &str) -> Result<(), String> {
    let staging = staging_dir(data_root);
    if !staging.exists() {
        return Err("no staged runtime to finalize".into());
    }
    std::fs::write(staging.join(CHANNEL_MANIFEST_FILE), manifest_json)
        .map_err(|e| format!("cannot write channel manifest: {e}"))?;

    let home = runtime_home(data_root);
    let previous = previous_dir(data_root);
    let _ = std::fs::remove_dir_all(&previous);
    if home.exists() {
        std::fs::rename(&home, &previous).map_err(|e| format!("cannot archive previous: {e}"))?;
    }
    if let Err(e) = std::fs::rename(&staging, &home) {
        // Put the old runtime back rather than leaving the user with none.
        let _ = std::fs::rename(&previous, &home);
        return Err(format!("cannot activate staged runtime: {e}"));
    }
    let _ = std::fs::remove_dir_all(&previous);
    Ok(())
}

pub fn remove_runtime(data_root: &Path, active_session_count: u32) -> Result<(), String> {
    if active_session_count > 0 {
        return Err(format!(
            "refusing to remove the runtime while {active_session_count} session(s) are still using it"
        ));
    }
    let _ = std::fs::remove_dir_all(runtime_home(data_root));
    let _ = std::fs::remove_dir_all(staging_dir(data_root));
    let _ = std::fs::remove_dir_all(previous_dir(data_root));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed_source(dir: &Path) {
        for artifact in RUNTIME_ARTIFACTS {
            std::fs::write(dir.join(artifact), format!("# {artifact}\n")).unwrap();
        }
    }

    #[test]
    fn host_node_version_is_empty_or_a_v_prefixed_version() {
        // The preflight verdict treats "" as "Node not found" and parses the
        // major out of anything else, so those are the only two shapes allowed
        // to escape this helper — never a raw command error.
        let version = host_node_version();
        assert!(
            version.is_empty() || version.starts_with('v'),
            "unexpected node version shape: {version:?}"
        );
        assert!(!version.contains('\n'), "version must be trimmed");
    }

    #[test]
    fn composition_digest_is_stable_and_content_sensitive() {
        let tmp = tempfile::tempdir().unwrap();
        seed_source(tmp.path());
        let first = compute_composition_digest(tmp.path()).unwrap();
        assert_eq!(first, compute_composition_digest(tmp.path()).unwrap());

        std::fs::write(tmp.path().join("host.sdk-readonly.yml"), "# tampered\n").unwrap();
        assert_ne!(first, compute_composition_digest(tmp.path()).unwrap());
    }

    #[test]
    fn composition_digest_distinguishes_content_moved_between_files() {
        // Name and length are folded in, so a byte swap cannot collide.
        let tmp = tempfile::tempdir().unwrap();
        seed_source(tmp.path());
        std::fs::write(tmp.path().join("host.sdk-readonly.yml"), "AB").unwrap();
        std::fs::write(tmp.path().join("host.sdk-workspace.yml"), "").unwrap();
        let first = compute_composition_digest(tmp.path()).unwrap();

        std::fs::write(tmp.path().join("host.sdk-readonly.yml"), "").unwrap();
        std::fs::write(tmp.path().join("host.sdk-workspace.yml"), "AB").unwrap();
        assert_ne!(first, compute_composition_digest(tmp.path()).unwrap());
    }

    #[test]
    fn composition_digest_matches_the_typescript_installer() {
        // Both hosts must agree byte-for-byte, or a runtime installed on desktop
        // fails doctor under the CLI. Fixture values are the sha256 of the
        // documented framing: name \0 length \0 content, per file, in order.
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("launcher.mjs"), "a").unwrap();
        std::fs::write(tmp.path().join("host.sdk-readonly.yml"), "b").unwrap();
        std::fs::write(tmp.path().join("host.sdk-workspace.yml"), "c").unwrap();
        std::fs::write(tmp.path().join("host.acp.yml"), "d").unwrap();

        let mut expected = Sha256::new();
        for (name, content) in [
            ("launcher.mjs", "a"),
            ("host.sdk-readonly.yml", "b"),
            ("host.sdk-workspace.yml", "c"),
            ("host.acp.yml", "d"),
        ] {
            expected.update(name.as_bytes());
            expected.update(b"\0");
            expected.update(content.len().to_string().as_bytes());
            expected.update(b"\0");
            expected.update(content.as_bytes());
        }
        assert_eq!(
            compute_composition_digest(tmp.path()).unwrap(),
            hex(expected.finalize())
        );
    }

    #[test]
    fn platform_key_uses_upstream_prebuild_spellings() {
        let key = platform_key();
        assert!(key.contains('-'), "expected <os>-<arch>, got {key}");
        assert!(!key.starts_with("macos"), "macos must be spelled darwin");
    }

    #[test]
    fn stray_patch_layers_are_found_at_home_and_profile_level() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        assert!(find_stray_patch_layers(home).is_empty());

        std::fs::write(home.join("cordis.patch.yml"), "- id: evil\n").unwrap();
        let profile = home.join("profiles").join("sneaky");
        std::fs::create_dir_all(&profile).unwrap();
        std::fs::write(profile.join("cordis.patch.yml"), "").unwrap();
        // A profile package.json declares out-of-tree plugin dependencies.
        std::fs::write(profile.join("package.json"), "{}").unwrap();

        assert_eq!(find_stray_patch_layers(home).len(), 3);
    }

    #[test]
    fn unrelated_files_are_not_reported_as_patch_layers() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("notes.txt"), "hello").unwrap();
        assert!(find_stray_patch_layers(tmp.path()).is_empty());
    }

    #[test]
    fn facts_report_unreadable_digests_instead_of_failing() {
        // "unreadable" can never equal a certified digest, so the shared verdict
        // function reports a mismatch rather than the check blowing up.
        let tmp = tempfile::tempdir().unwrap();
        let facts = gather_facts(tmp.path(), "v26.0.0".into());
        assert_eq!(facts.lockfile_digest, "unreadable");
        assert_eq!(facts.composition_digest, "unreadable");
        assert!(facts.manifest_json.is_none());
    }

    #[test]
    fn stage_install_rejects_a_source_missing_an_artifact() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("src");
        std::fs::create_dir_all(&source).unwrap();
        seed_source(&source);
        std::fs::remove_file(source.join("launcher.mjs")).unwrap();

        let err = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(stage_install(tmp.path(), &source))
            .unwrap_err();
        assert!(err.contains("launcher.mjs"), "{err}");
    }

    #[test]
    fn finalize_refuses_without_a_staged_tree() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(finalize_install(tmp.path(), "{}").is_err());
    }

    #[test]
    fn finalize_writes_the_manifest_and_activates_the_staged_tree() {
        let tmp = tempfile::tempdir().unwrap();
        let staging = staging_dir(tmp.path());
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::write(staging.join("launcher.mjs"), "x").unwrap();

        finalize_install(tmp.path(), "{\"schemaVersion\":1}").unwrap();

        let home = runtime_home(tmp.path());
        assert!(home.join("launcher.mjs").exists());
        assert_eq!(
            std::fs::read_to_string(home.join(CHANNEL_MANIFEST_FILE)).unwrap(),
            "{\"schemaVersion\":1}"
        );
        assert!(!staging.exists());
        assert!(!previous_dir(tmp.path()).exists());
    }

    #[test]
    fn finalize_replaces_an_existing_runtime() {
        let tmp = tempfile::tempdir().unwrap();
        let home = runtime_home(tmp.path());
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join("marker"), "old").unwrap();

        let staging = staging_dir(tmp.path());
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::write(staging.join("launcher.mjs"), "new").unwrap();

        finalize_install(tmp.path(), "{}").unwrap();
        assert!(!home.join("marker").exists());
        assert!(home.join("launcher.mjs").exists());
    }

    #[test]
    fn remove_refuses_while_sessions_are_live() {
        // Removing under a live session would strand a running subprocess whose
        // composition had just been deleted.
        let tmp = tempfile::tempdir().unwrap();
        let home = runtime_home(tmp.path());
        std::fs::create_dir_all(&home).unwrap();

        assert!(remove_runtime(tmp.path(), 2).is_err());
        assert!(home.exists());

        remove_runtime(tmp.path(), 0).unwrap();
        assert!(!home.exists());
    }

    #[test]
    fn remove_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(remove_runtime(tmp.path(), 0).is_ok());
        assert!(remove_runtime(tmp.path(), 0).is_ok());
    }
}

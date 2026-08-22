//! Reading the installed version of an external-Agent runtime.
//!
//! The renderer decides *which* runtime to probe and nothing else. It passes a
//! catalog id; this module looks the command, the argument vector and the
//! timeout up in the compiled-in copy of
//! `protocol/external-agent-runtimes.json` and runs it. That is deliberate and
//! matches how the DeepSeek Harness commands work (see `dsh_runtime`): a
//! renderer-supplied command line would be an arbitrary-exec surface reachable
//! from any page the webview loads, and there is no version of that which is
//! worth the convenience.
//!
//! The catalog is `include_str!`-ed rather than mirrored in Rust, so there is
//! no twin to drift: the file the gate validates is the file that runs here.
//!
//! This module renders **no verdict**. Whether a version is certified,
//! supported or unreadable is decided by `assessRuntimeVersion()` in
//! `lib/ai/agent/external/runtime-version.ts`, shared by every host — the same
//! split `dsh_runtime` uses, and for the same reason.

use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// The catalog the app ships. Parsed once, on first probe.
const CATALOG_JSON: &str = include_str!("../../../protocol/external-agent-runtimes.json");

/// Commands that run *another* package rather than being the runtime itself.
/// Kept in sync with `PACKAGE_RUNNERS` in the gate and `isUnpinnedLaunch()`.
const PACKAGE_RUNNERS: &[&str] = &["npx", "pnpx", "bunx", "uvx"];

/// A probe may print a lot when it fails (a stack trace, an npm install log).
/// The renderer only needs enough to find a version in, or to show the user.
const MAX_OUTPUT_BYTES: usize = 8 * 1024;

#[derive(Debug, Deserialize)]
struct Catalog {
    runtimes: Vec<CatalogEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogEntry {
    runtime_id: String,
    #[serde(default)]
    system_command: Option<String>,
    #[serde(default)]
    version_probe: Option<ProbeSpec>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProbeSpec {
    /// The COMPLETE argument vector, not an addition to `launchArgs`.
    args: Vec<String>,
    timeout_ms: u64,
}

/// What the host observed. Facts only — the verdict is TypeScript's.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeVersionProbe {
    /// Combined stdout and stderr, truncated. `None` means the runtime could
    /// not be found at all, which is the one observation that reads as
    /// "missing" rather than "unreadable".
    pub output: Option<String>,
    /// The executable that was actually run, after PATH resolution.
    pub executable_path: Option<String>,
    /// SHA-256 of that executable. Absent for package runners, where the
    /// resolved file is `npx`, not the runtime — recording npx's digest as the
    /// runtime's identity would make every unpinned runtime look stable while
    /// the package under it changed on every launch.
    pub executable_digest: Option<String>,
    pub exit_code: Option<i32>,
    /// Non-localized note for logs when the probe could not produce a version.
    pub detail: Option<String>,
}

fn catalog() -> &'static Catalog {
    static CATALOG: OnceLock<Catalog> = OnceLock::new();
    CATALOG.get_or_init(|| {
        serde_json::from_str(CATALOG_JSON).expect("the shipped runtime catalog must parse")
    })
}

fn entry(runtime_id: &str) -> Option<&'static CatalogEntry> {
    catalog()
        .runtimes
        .iter()
        .find(|entry| entry.runtime_id == runtime_id)
}

/// Is this command a package runner rather than the runtime's own executable?
fn is_package_runner(command: &str) -> bool {
    let base = command
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(command)
        .to_ascii_lowercase();
    let stem = base
        .strip_suffix(".exe")
        .or_else(|| base.strip_suffix(".cmd"))
        .or_else(|| base.strip_suffix(".bat"))
        .unwrap_or(&base);
    PACKAGE_RUNNERS.contains(&stem)
}

fn truncate_output(mut text: String) -> String {
    if text.len() <= MAX_OUTPUT_BYTES {
        return text;
    }
    // Cut on a char boundary; probe output is not guaranteed to be ASCII.
    let mut end = MAX_OUTPUT_BYTES;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    text
}

fn digest_of(path: &PathBuf) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    Some(format!("{:x}", Sha256::digest(bytes)))
}

/// Run one runtime's catalogued version probe.
///
/// Timeouts and non-zero exits still return `output`, so they read as
/// "unreadable version" rather than "runtime missing" — those are different
/// facts and the certification policy treats them differently.
pub async fn probe_runtime_version(runtime_id: &str) -> Result<RuntimeVersionProbe, String> {
    let entry = entry(runtime_id).ok_or_else(|| format!("unknown runtime: {runtime_id}"))?;

    let Some(spec) = entry.version_probe.as_ref() else {
        // A remote runtime has nothing local to read. Not an error: it was
        // never meant to be installed here.
        return Ok(RuntimeVersionProbe {
            detail: Some(format!("{runtime_id} declares no version probe")),
            ..RuntimeVersionProbe::default()
        });
    };

    let Some(command) = entry.system_command.as_deref() else {
        // A managed runtime is certified through its own install receipt, not
        // by shelling out to something on PATH.
        return Ok(RuntimeVersionProbe {
            detail: Some(format!("{runtime_id} has no system command to probe")),
            ..RuntimeVersionProbe::default()
        });
    };

    let Some(resolved) = super::command_resolver::resolve_command_path(command) else {
        return Ok(RuntimeVersionProbe {
            detail: Some(format!("{command} is not on PATH or any known install root")),
            ..RuntimeVersionProbe::default()
        });
    };

    let executable_path = resolved.to_string_lossy().into_owned();
    let executable_digest = if is_package_runner(command) {
        None
    } else {
        digest_of(&resolved)
    };

    let mut cmd = tokio::process::Command::new(&resolved);
    cmd.args(&spec.args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    // Same reason the spawn path does it: a Finder-launched macOS app inherits
    // launchd's PATH, so `npx` would resolve but then fail to find `node`.
    if let Ok(path) = std::env::join_paths(super::command_resolver::search_dirs()) {
        cmd.env("PATH", path);
    }
    // Own process group, so the kill on timeout takes the whole tree — `npx`
    // forks `node`, and killing only the parent leaves it running.
    super::proc_group::apply_process_group(&mut cmd);

    let child = cmd
        .spawn()
        .map_err(|error| format!("cannot run {executable_path}: {error}"))?;
    let pid = child.id();

    let waited = tokio::time::timeout(
        Duration::from_millis(spec.timeout_ms),
        child.wait_with_output(),
    )
    .await;

    match waited {
        Ok(Ok(output)) => {
            let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
            if !output.stderr.is_empty() {
                // Several of these CLIs print their version on stderr.
                if !text.is_empty() && !text.ends_with('\n') {
                    text.push('\n');
                }
                text.push_str(&String::from_utf8_lossy(&output.stderr));
            }
            Ok(RuntimeVersionProbe {
                output: Some(truncate_output(text)),
                executable_path: Some(executable_path),
                executable_digest,
                exit_code: output.status.code(),
                detail: None,
            })
        }
        Ok(Err(error)) => Ok(RuntimeVersionProbe {
            // The command started, so it is not missing; it just told us nothing.
            output: Some(String::new()),
            executable_path: Some(executable_path),
            executable_digest,
            exit_code: None,
            detail: Some(format!("probe failed: {error}")),
        }),
        Err(_) => {
            super::proc_group::kill_process_group(pid);
            Ok(RuntimeVersionProbe {
                output: Some(String::new()),
                executable_path: Some(executable_path),
                executable_digest,
                exit_code: None,
                detail: Some(format!("probe timed out after {}ms", spec.timeout_ms)),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shipped_catalog_parses() {
        let catalog = catalog();
        assert!(
            catalog.runtimes.len() >= 15,
            "expected the shipped runtimes, got {}",
            catalog.runtimes.len()
        );
    }

    #[test]
    fn every_locally_launched_runtime_has_a_runnable_probe() {
        // The Rust side must be able to run every probe the catalog declares;
        // an entry the gate accepts but this cannot execute is a governed
        // runtime with no way to read its version on desktop.
        let mut unrunnable: Vec<&str> = Vec::new();
        for entry in &catalog().runtimes {
            let Some(spec) = entry.version_probe.as_ref() else {
                continue;
            };
            if entry.system_command.is_none() {
                continue;
            }
            if spec.args.is_empty() || spec.timeout_ms == 0 {
                unrunnable.push(&entry.runtime_id);
            }
        }
        assert_eq!(unrunnable, Vec::<&str>::new());
    }

    #[test]
    fn package_runners_are_recognized_across_platform_spellings() {
        assert!(is_package_runner("npx"));
        assert!(is_package_runner("npx.cmd"));
        assert!(is_package_runner("/usr/local/bin/npx"));
        assert!(is_package_runner("C:\\Program Files\\nodejs\\NPX.CMD"));
        assert!(is_package_runner("uvx"));
        assert!(!is_package_runner("codex"));
        assert!(!is_package_runner("cursor-agent"));
    }

    #[test]
    fn output_truncation_keeps_char_boundaries() {
        let text = "✅".repeat(MAX_OUTPUT_BYTES);
        let truncated = truncate_output(text);
        assert!(truncated.len() <= MAX_OUTPUT_BYTES);
        // Would have panicked on a bad boundary; assert it is still valid text.
        assert!(truncated.chars().all(|c| c == '✅'));
    }

    #[test]
    fn short_output_is_returned_unchanged() {
        assert_eq!(truncate_output("1.2.3".to_string()), "1.2.3");
    }

    #[tokio::test]
    async fn an_unknown_runtime_is_an_error_not_a_silent_miss() {
        let error = probe_runtime_version("not-a-runtime").await.unwrap_err();
        assert!(error.contains("unknown runtime"), "{error}");
    }

    #[tokio::test]
    async fn a_remote_runtime_reports_no_probe_rather_than_missing() {
        // `output: None` would read as "missing" to the certification policy;
        // a remote runtime was never meant to exist locally.
        let probe = probe_runtime_version("opencode-remote").await.unwrap();
        assert_eq!(probe.output, None);
        assert!(probe.detail.unwrap().contains("declares no version probe"));
    }

    #[tokio::test]
    async fn a_managed_runtime_reports_that_it_has_no_command() {
        let probe = probe_runtime_version("deepseek-harness").await.unwrap();
        assert_eq!(probe.output, None);
        assert!(probe.detail.unwrap().contains("no system command"));
    }

    #[tokio::test]
    async fn a_missing_command_reports_where_it_was_looked_for() {
        // `kiro-cli` is not installed in CI; if it ever is, this still holds
        // because a found command returns `output: Some(_)`.
        let probe = probe_runtime_version("kiro-cli").await.unwrap();
        if probe.output.is_none() {
            assert!(probe.detail.unwrap().contains("not on PATH"));
            assert_eq!(probe.executable_path, None);
        } else {
            assert!(probe.executable_path.is_some());
        }
    }
}

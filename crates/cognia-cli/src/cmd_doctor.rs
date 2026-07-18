//! `cognia plugin doctor [--fix] [--json]` — one-shot environment + project
//! health check.
//!
//! No plugin CLI in the surveyed set ships a doctor except Tauri
//! (`tauri info --interactive`). The pieces already existed in this crate —
//! `preflight_wasm_toolchain` (build) and `probe_bridge_status` (status) — but
//! only fired deep inside `build`, after you'd already written code. `doctor`
//! composes them up front and adds project checks: the W1.1 signing-key
//! gitignore invariant (checked in the author's real project) and a manifest
//! lint. Toolchain gaps are advisory *unless* the current project actually
//! needs them (a wasm plugin missing `cargo-component` is a hard failure);
//! a leaked signing key or a manifest with lint errors always fails.

use anyhow::{bail, Result};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::cmd_status::probe_bridge_status;
use crate::ui::{style, RuntimeUi};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum CheckStatus {
    Ok,
    Warn,
    Fail,
}

#[derive(Debug, Clone, Serialize)]
struct Check {
    name: &'static str,
    status: CheckStatus,
    detail: String,
    /// A remediation command/string, surfaced in output and (when
    /// `auto_fixable`) run by `--fix`.
    #[serde(skip_serializing_if = "Option::is_none")]
    fix: Option<String>,
    #[serde(rename = "autoFixable")]
    auto_fixable: bool,
}

impl Check {
    fn ok(name: &'static str, detail: impl Into<String>) -> Self {
        Self {
            name,
            status: CheckStatus::Ok,
            detail: detail.into(),
            fix: None,
            auto_fixable: false,
        }
    }
}

#[derive(Debug, Serialize)]
struct DoctorReport {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    ok: bool,
    action: &'static str,
    checks: Vec<Check>,
}

/// A toolchain need, derived from what kind of project (if any) the author is
/// standing in. `Required` gaps fail; `Optional` gaps warn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Need {
    Required,
    Optional,
}

impl Need {
    fn missing_status(self) -> CheckStatus {
        match self {
            Need::Required => CheckStatus::Fail,
            Need::Optional => CheckStatus::Warn,
        }
    }
}

pub fn run(fix: bool, as_json: bool, ui: &mut RuntimeUi) -> Result<()> {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let project_kind = read_project_kind(&cwd);

    let mut checks = collect_checks(&cwd, project_kind.as_deref());
    if fix {
        apply_fixes(&cwd, &mut checks);
    }

    let ok = report_is_ok(&checks);
    let report = DoctorReport {
        schema_version: 1,
        ok,
        action: "doctor",
        checks,
    };

    if as_json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else if !ui.flags.quiet || !ok {
        print_human(&report);
    }

    if ok {
        Ok(())
    } else if as_json {
        Err(crate::JsonFailureExit.into())
    } else {
        let fails = report
            .checks
            .iter()
            .filter(|c| c.status == CheckStatus::Fail)
            .count();
        bail!("cognia plugin doctor found {fails} problem(s) — see above");
    }
}

/// The exit gate: any `Fail` fails the run; warnings never do.
fn report_is_ok(checks: &[Check]) -> bool {
    checks.iter().all(|c| c.status != CheckStatus::Fail)
}

/// Read `plugin.json`'s `type` from `dir`, if this is a plugin project.
fn read_project_kind(dir: &Path) -> Option<String> {
    let bytes = std::fs::read(dir.join("plugin.json")).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    value
        .get("type")
        .and_then(|v| v.as_str())
        .map(str::to_owned)
}

fn collect_checks(cwd: &Path, project_kind: Option<&str>) -> Vec<Check> {
    // Which toolchains does *this* project need?
    let wasm_need = if project_kind == Some("wasm") {
        Need::Required
    } else {
        Need::Optional
    };
    let node_need = match project_kind {
        Some("frontend" | "hybrid" | "vscode-extension") => Need::Required,
        _ => Need::Optional,
    };

    let mut checks = vec![
        cargo_component_check(probe_cargo_component(), wasm_need),
        wasm_target_check(probe_rustup_targets().as_deref(), wasm_need),
        node_check(probe_node(), node_need),
        bridge_check(probe_bridge_status().running),
    ];

    // Project checks only apply inside a plugin directory.
    if cwd.join("plugin.json").exists() {
        checks.push(signing_key_check(
            cwd.join(".cognia/plugin.private.b64").exists(),
            std::fs::read_to_string(cwd.join(".gitignore"))
                .ok()
                .as_deref(),
        ));
        checks.push(manifest_check(cwd));
    }

    checks
}

// ── Probes (thin shell-outs) ────────────────────────────────────────────────

fn probe_cargo_component() -> bool {
    Command::new("cargo")
        .args(["component", "--version"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn probe_rustup_targets() -> Option<String> {
    Command::new("rustup")
        .args(["target", "list", "--installed"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
}

fn probe_node() -> bool {
    Command::new("node")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

// ── Pure decision cores (unit-tested) ───────────────────────────────────────

fn cargo_component_check(present: bool, need: Need) -> Check {
    if present {
        Check::ok("cargo-component", "installed")
    } else {
        Check {
            name: "cargo-component",
            status: need.missing_status(),
            detail: "not found — required to build wasm plugins".into(),
            fix: Some("cargo install --locked cargo-component".into()),
            auto_fixable: false, // a multi-minute global install; surfaced, not auto-run
        }
    }
}

fn wasm_target_check(rustup_targets: Option<&str>, need: Need) -> Check {
    match rustup_targets {
        None => Check {
            name: "wasm32-wasip2 target",
            status: CheckStatus::Warn,
            detail: "rustup not detected; wasm target unverified (cargo-component may manage it)"
                .into(),
            fix: None,
            auto_fixable: false,
        },
        Some(list) => {
            if list.lines().any(|l| l.trim() == "wasm32-wasip2") {
                Check::ok("wasm32-wasip2 target", "installed")
            } else {
                Check {
                    name: "wasm32-wasip2 target",
                    status: need.missing_status(),
                    detail: "not installed — required to build wasm plugins".into(),
                    fix: Some("rustup target add wasm32-wasip2".into()),
                    auto_fixable: true,
                }
            }
        }
    }
}

fn node_check(present: bool, need: Need) -> Check {
    if present {
        Check::ok("node", "installed")
    } else {
        Check {
            name: "node",
            status: need.missing_status(),
            detail: "not found — required to build ts/hybrid/vscode plugins".into(),
            fix: Some("install Node.js 18+ (https://nodejs.org)".into()),
            auto_fixable: false,
        }
    }
}

fn bridge_check(running: bool) -> Check {
    if running {
        Check::ok("desktop bridge", "reachable")
    } else {
        Check {
            name: "desktop bridge",
            status: CheckStatus::Warn,
            detail: "not reachable — needed only for install/reload/dev against a running app"
                .into(),
            fix: Some("launch the cognia desktop app".into()),
            auto_fixable: false,
        }
    }
}

/// The W1.1 invariant, checked in the author's *real* project: if the private
/// signing key exists, `.cognia/` must be gitignored or the next `git add`
/// stages it. A leaked key is total, so this is a hard failure.
fn signing_key_check(key_exists: bool, gitignore: Option<&str>) -> Check {
    if !key_exists {
        return Check::ok("signing key", "no private key in this project");
    }
    let ignored = gitignore
        .map(|g| g.lines().any(|l| l.trim() == ".cognia/"))
        .unwrap_or(false);
    if ignored {
        Check::ok("signing key", "present and gitignored")
    } else {
        Check {
            name: "signing key",
            status: CheckStatus::Fail,
            detail: ".cognia/plugin.private.b64 exists but .cognia/ is NOT gitignored — \
                     your Ed25519 private key will be committed"
                .into(),
            fix: Some("add `.cognia/` to .gitignore".into()),
            auto_fixable: true,
        }
    }
}

fn manifest_check(dir: &Path) -> Check {
    match crate::cmd_lint::validate_at(dir) {
        Ok(report) => {
            let errors = report.error_count();
            let warnings = report.warning_count();
            if errors > 0 {
                Check {
                    name: "manifest lint",
                    status: CheckStatus::Fail,
                    detail: format!("{errors} error(s), {warnings} warning(s)"),
                    fix: Some("cognia plugin lint".into()),
                    auto_fixable: false,
                }
            } else if warnings > 0 {
                Check {
                    name: "manifest lint",
                    status: CheckStatus::Warn,
                    detail: format!("{warnings} warning(s)"),
                    fix: Some("cognia plugin lint".into()),
                    auto_fixable: false,
                }
            } else {
                Check::ok("manifest lint", "clean")
            }
        }
        Err(err) => Check {
            name: "manifest lint",
            status: CheckStatus::Fail,
            detail: format!("could not read plugin.json: {err}"),
            fix: None,
            auto_fixable: false,
        },
    }
}

// ── Fixes ────────────────────────────────────────────────────────────────────

fn apply_fixes(cwd: &Path, checks: &mut [Check]) {
    for check in checks.iter_mut() {
        if check.status == CheckStatus::Ok || !check.auto_fixable {
            continue;
        }
        match check.name {
            "wasm32-wasip2 target" => {
                let ok = Command::new("rustup")
                    .args(["target", "add", "wasm32-wasip2"])
                    .status()
                    .map(|s| s.success())
                    .unwrap_or(false);
                if ok {
                    *check = Check::ok(check.name, "installed (fixed by --fix)");
                }
            }
            "signing key" => {
                if append_gitignore_entry(cwd, ".cognia/").is_ok() {
                    *check = Check::ok(check.name, "present and gitignored (fixed by --fix)");
                }
            }
            _ => {}
        }
    }
}

/// Append `entry` on its own line to `<dir>/.gitignore`, creating the file if
/// absent and not duplicating an existing entry.
fn append_gitignore_entry(dir: &Path, entry: &str) -> std::io::Result<()> {
    let path = dir.join(".gitignore");
    let current = std::fs::read_to_string(&path).unwrap_or_default();
    if current.lines().any(|l| l.trim() == entry) {
        return Ok(());
    }
    let mut next = current;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str(entry);
    next.push('\n');
    std::fs::write(&path, next)
}

// ── Human output ─────────────────────────────────────────────────────────────

fn print_human(report: &DoctorReport) {
    println!("{}", style::bold("cognia plugin doctor"));
    for check in &report.checks {
        let tag = match check.status {
            CheckStatus::Ok => style::ok("ok  "),
            CheckStatus::Warn => style::warn("warn"),
            CheckStatus::Fail => style::error("FAIL"),
        };
        println!("  [{tag}] {}: {}", style::bold(check.name), check.detail);
        if check.status != CheckStatus::Ok {
            if let Some(fix) = &check.fix {
                let how = if check.auto_fixable {
                    format!("{fix}  (or re-run with --fix)")
                } else {
                    fix.clone()
                };
                println!("         {}{how}", style::hint_prefix());
            }
        }
    }
    println!();
    let fails = report
        .checks
        .iter()
        .filter(|c| c.status == CheckStatus::Fail)
        .count();
    let warns = report
        .checks
        .iter()
        .filter(|c| c.status == CheckStatus::Warn)
        .count();
    let summary = format!("{fails} problem(s), {warns} warning(s)");
    if report.ok {
        println!("{}{summary}", style::success_prefix());
    } else {
        println!("{}", style::error(&summary));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cargo_component_present_is_ok() {
        assert_eq!(
            cargo_component_check(true, Need::Required).status,
            CheckStatus::Ok
        );
    }

    #[test]
    fn missing_toolchain_fails_only_when_required() {
        assert_eq!(
            cargo_component_check(false, Need::Required).status,
            CheckStatus::Fail
        );
        assert_eq!(
            cargo_component_check(false, Need::Optional).status,
            CheckStatus::Warn
        );
    }

    #[test]
    fn wasm_target_check_reads_rustup_list() {
        assert_eq!(
            wasm_target_check(Some("x86_64-apple-darwin\nwasm32-wasip2\n"), Need::Required).status,
            CheckStatus::Ok
        );
        let missing = wasm_target_check(Some("x86_64-apple-darwin\n"), Need::Required);
        assert_eq!(missing.status, CheckStatus::Fail);
        assert!(missing.auto_fixable, "rustup target add is auto-fixable");
        // No rustup → can't assert → advisory warn, never a hard fail.
        assert_eq!(
            wasm_target_check(None, Need::Required).status,
            CheckStatus::Warn
        );
    }

    #[test]
    fn signing_key_absent_or_gitignored_is_ok() {
        assert_eq!(signing_key_check(false, None).status, CheckStatus::Ok);
        assert_eq!(
            signing_key_check(true, Some("target/\n.cognia/\n")).status,
            CheckStatus::Ok
        );
    }

    #[test]
    fn exposed_signing_key_is_a_hard_fail() {
        let check = signing_key_check(true, Some("target/\nnode_modules/\n"));
        assert_eq!(check.status, CheckStatus::Fail);
        assert!(check.auto_fixable);
        // Missing .gitignore entirely is also exposed.
        assert_eq!(signing_key_check(true, None).status, CheckStatus::Fail);
    }

    #[test]
    fn report_is_ok_ignores_warnings_but_not_fails() {
        assert!(report_is_ok(&[
            Check::ok("a", "fine"),
            node_check(false, Need::Optional), // warn
        ]));
        assert!(!report_is_ok(&[signing_key_check(true, None)])); // fail
    }

    #[test]
    fn append_gitignore_entry_is_idempotent_and_creates() {
        let tmp = tempfile::tempdir().unwrap();
        // Creates the file when absent.
        append_gitignore_entry(tmp.path(), ".cognia/").unwrap();
        let after_first = std::fs::read_to_string(tmp.path().join(".gitignore")).unwrap();
        assert!(after_first.lines().any(|l| l == ".cognia/"));
        // Second call does not duplicate.
        append_gitignore_entry(tmp.path(), ".cognia/").unwrap();
        let after_second = std::fs::read_to_string(tmp.path().join(".gitignore")).unwrap();
        assert_eq!(after_first, after_second);
    }

    #[test]
    fn fix_gitignores_an_exposed_key() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join(".cognia")).unwrap();
        std::fs::write(tmp.path().join(".cognia/plugin.private.b64"), "secret").unwrap();
        std::fs::write(tmp.path().join(".gitignore"), "target/\n").unwrap();
        let mut checks = vec![signing_key_check(true, Some("target/\n"))];
        assert_eq!(checks[0].status, CheckStatus::Fail);
        apply_fixes(tmp.path(), &mut checks);
        assert_eq!(
            checks[0].status,
            CheckStatus::Ok,
            "--fix must gitignore the key"
        );
        let gi = std::fs::read_to_string(tmp.path().join(".gitignore")).unwrap();
        assert!(gi.lines().any(|l| l.trim() == ".cognia/"));
    }

    #[test]
    fn manifest_check_flags_lint_errors_and_passes_clean() {
        let tmp = tempfile::tempdir().unwrap();
        // Broken manifest → fail.
        std::fs::write(tmp.path().join("plugin.json"), r#"{"id":"x"}"#).unwrap();
        assert_eq!(manifest_check(tmp.path()).status, CheckStatus::Fail);
        // Clean manifest → ok.
        std::fs::write(
            tmp.path().join("plugin.json"),
            r#"{"id":"clean","name":"C","version":"0.1.0","description":"d","type":"frontend","capabilities":[],"main":"dist/i.js"}"#,
        )
        .unwrap();
        assert_eq!(manifest_check(tmp.path()).status, CheckStatus::Ok);
    }

    #[test]
    fn collect_checks_adds_project_checks_only_in_a_plugin_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let non_project = collect_checks(tmp.path(), None);
        assert!(!non_project.iter().any(|c| c.name == "manifest lint"));
        std::fs::write(
            tmp.path().join("plugin.json"),
            r#"{"id":"p","name":"P","version":"0.1.0","description":"d","type":"frontend","capabilities":[],"main":"dist/i.js"}"#,
        )
        .unwrap();
        let project = collect_checks(tmp.path(), Some("frontend"));
        assert!(project.iter().any(|c| c.name == "manifest lint"));
        assert!(project.iter().any(|c| c.name == "signing key"));
    }
}

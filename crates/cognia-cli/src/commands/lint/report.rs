//! Lint diagnostic data types (`Severity`, `Diagnostic`, `LintReport`,
//! `LintError`) plus the human-readable and `--json` failure rendering. The
//! validation logic that produces these types lives in [`super::rules`]; the
//! orchestration that calls them (`run` / `validate_at`) lives in [`super`].

use anyhow::Result;
use serde::Serialize;
use std::fmt;
use std::path::{Path, PathBuf};

// ─────────────────────────────────────────────────────────────────────────────
// Diagnostic types
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
    /// Informational tier: surfaced, but never gates — not even under
    /// `--warnings-as-errors`. Reserved for advisory rules (e.g. the
    /// version-compatibility notices in W3.4). No production rule emits one
    /// yet; tests construct it to pin the non-gating behavior.
    #[allow(dead_code)]
    Notice,
}

#[derive(Debug, Clone, Serialize)]
pub struct Diagnostic {
    pub severity: Severity,
    pub field: String,
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LintReport {
    /// Bumped for breaking changes to the JSON shape so consumers can
    /// version-pin without parsing the whole payload speculatively.
    #[serde(rename = "schemaVersion")]
    pub schema_version: u32,
    pub ok: bool,
    pub action: &'static str,
    /// Which stage produced this payload. `"validate"` for a real lint result;
    /// the input-failure payload carries `"input"`. Always present so a `--json`
    /// consumer can bucket on `.stage` uniformly across success and failure.
    pub stage: &'static str,
    #[serde(rename = "manifestPath")]
    pub manifest_path: PathBuf,
    pub valid: bool,
    pub diagnostics: Vec<Diagnostic>,
}

impl LintReport {
    pub fn error_count(&self) -> usize {
        self.diagnostics
            .iter()
            .filter(|d| d.severity == Severity::Error)
            .count()
    }

    pub fn warning_count(&self) -> usize {
        self.diagnostics
            .iter()
            .filter(|d| d.severity == Severity::Warning)
            .count()
    }

    pub fn notice_count(&self) -> usize {
        self.diagnostics
            .iter()
            .filter(|d| d.severity == Severity::Notice)
            .count()
    }
}

#[derive(Debug, Clone)]
pub struct LintError {
    pub report: LintReport,
}

impl LintError {
    pub fn error_count(&self) -> usize {
        self.report.error_count()
    }

    pub fn warning_count(&self) -> usize {
        self.report.warning_count()
    }
}

impl fmt::Display for LintError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "manifest lint failed: {} error(s), {} warning(s)",
            self.error_count(),
            self.warning_count()
        )
    }
}

impl std::error::Error for LintError {}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering (human + --json input failure)
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
struct LintFailureReport {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    ok: bool,
    action: &'static str,
    stage: &'static str,
    /// Same key as the success payload's `manifestPath`, so a `--json` consumer
    /// reads one field for "the manifest this run was about" on both shapes.
    #[serde(rename = "manifestPath")]
    path: PathBuf,
    valid: bool,
    diagnostics: Vec<Diagnostic>,
}

pub(super) fn emit_json_input_failure(
    path: &Path,
    error: String,
    code: &'static str,
) -> Result<()> {
    let report = LintFailureReport {
        schema_version: 2,
        ok: false,
        action: "lint",
        stage: "input",
        path: path.to_path_buf(),
        valid: false,
        diagnostics: vec![Diagnostic {
            severity: Severity::Error,
            field: "path".into(),
            code: code.into(),
            message: error,
            hint: Some("Pass --path pointing at a plugin directory containing plugin.json.".into()),
        }],
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Err(crate::shared::JsonFailureExit.into())
}

pub(super) fn print_human(report: &LintReport) {
    use crate::ui::style;
    println!(
        "Validating {}",
        style::bold(report.manifest_path.display().to_string())
    );
    if report.diagnostics.is_empty() {
        println!("{}no problems found", style::success_prefix());
        return;
    }
    for d in &report.diagnostics {
        let tag = match d.severity {
            Severity::Error => style::error("ERROR"),
            Severity::Warning => style::warn("WARN "),
            Severity::Notice => style::dim("NOTE "),
        };
        println!("  [{tag}] {}: {}", style::bold(&d.field), d.message);
        if let Some(hint) = &d.hint {
            println!("         {}{hint}", style::hint_prefix());
        }
        println!("         code: {}", style::dim(&d.code));
    }
    println!();
    let mut summary = format!(
        "{} error(s), {} warning(s)",
        report.error_count(),
        report.warning_count()
    );
    if report.notice_count() > 0 {
        summary.push_str(&format!(", {} notice(s)", report.notice_count()));
    }
    if !report.valid {
        println!("{}", style::error(&summary));
    } else if !report.ok {
        // No errors, but `--warnings-as-errors` escalated the warnings.
        println!("{} (--warnings-as-errors)", style::error(&summary));
    } else if report.warning_count() > 0 {
        println!("{}", style::warn(&summary));
    } else {
        // Notices only — passes cleanly.
        println!("{}{summary}", style::success_prefix());
    }
}

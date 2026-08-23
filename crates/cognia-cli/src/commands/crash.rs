use std::{collections::BTreeMap, path::PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use chrono::Utc;
use cognia_observability::{
    create_diagnostic_package, delete_incident, exchange_installation_grant, fetch_receipt,
    submit_package, validate_diagnostic_package, withdraw_consent, AttachmentInput,
    DiagnosticPackageInput, SubmissionRequest, SubmissionTarget,
};
use serde::Serialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    cli::{CrashCommand, OutputFormat},
    commands::diagnostic_common::{
        emit, installation_identity, load_or_create_signing_key, resolve_crash_dir, validate_stem,
    },
    commands::diagnostic_transport::UreqTransport,
    ui::RuntimeUi,
};

pub fn run(command: CrashCommand, ui: &mut RuntimeUi) -> Result<()> {
    match command {
        CrashCommand::List { format, crash_dir } => list(resolve_crash_dir(crash_dir)?, format),
        CrashCommand::Show {
            stem,
            format,
            crash_dir,
        } => show(resolve_crash_dir(crash_dir)?, &stem, format),
        CrashCommand::Package {
            stem,
            out,
            include_minidump,
            screenshot,
            description,
            crash_dir,
            signing_key,
            format,
        } => package(
            PackageArgs {
                dir: resolve_crash_dir(crash_dir)?,
                stem,
                out,
                include_minidump,
                screenshot,
                description,
                signing_key,
            },
            format,
        ),
        CrashCommand::Submit {
            package,
            server,
            grant,
            tenant_id,
            project_id,
            format,
        } => submit(
            package,
            &server,
            grant.as_deref(),
            tenant_id.as_deref(),
            project_id.as_deref(),
            format,
            ui,
        ),
        CrashCommand::Status {
            incident_id,
            server,
            grant,
            tenant_id,
            project_id,
            format,
        } => status(
            &incident_id,
            &server,
            grant.as_deref(),
            tenant_id.as_deref(),
            project_id.as_deref(),
            format,
        ),
        CrashCommand::Withdraw {
            incident_id,
            server,
            grant,
            tenant_id,
            project_id,
            format,
        } => withdraw_remote(
            &incident_id,
            &server,
            grant.as_deref(),
            tenant_id.as_deref(),
            project_id.as_deref(),
            format,
        ),
        CrashCommand::Delete {
            target,
            remote,
            server,
            grant,
            tenant_id,
            project_id,
            crash_dir,
            format,
        } => {
            if remote {
                delete_remote(
                    &target,
                    server.as_deref().expect("clap requires server"),
                    grant.as_deref(),
                    tenant_id.as_deref(),
                    project_id.as_deref(),
                    format,
                )
            } else {
                delete_local(resolve_crash_dir(crash_dir)?, &target, format)
            }
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CrashSummary {
    stem: String,
    captured_at: Option<String>,
    kind: Option<String>,
    has_text: bool,
    has_json: bool,
    has_minidump: bool,
    size_bytes: u64,
}

fn collect_reports(dir: &std::path::Path) -> Vec<CrashSummary> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut reports = BTreeMap::<String, CrashSummary>::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(extension) = path.extension().and_then(|value| value.to_str()) else {
            continue;
        };
        if !matches!(extension, "txt" | "json" | "dmp") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        let report = reports.entry(stem.to_owned()).or_insert(CrashSummary {
            stem: stem.to_owned(),
            captured_at: None,
            kind: None,
            has_text: false,
            has_json: false,
            has_minidump: false,
            size_bytes: 0,
        });
        report.size_bytes += entry.metadata().map(|metadata| metadata.len()).unwrap_or(0);
        match extension {
            "txt" => report.has_text = true,
            "dmp" => report.has_minidump = true,
            "json" => {
                report.has_json = true;
                if let Ok(value) = std::fs::read(&path)
                    .ok()
                    .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                    .ok_or(())
                {
                    report.captured_at = value
                        .get("capturedAt")
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                    report.kind = value.get("kind").and_then(Value::as_str).map(str::to_owned);
                }
            }
            _ => unreachable!(),
        }
    }
    let mut reports = reports.into_values().collect::<Vec<_>>();
    reports.sort_by(|left, right| right.stem.cmp(&left.stem));
    reports
}

fn list(dir: PathBuf, format: OutputFormat) -> Result<()> {
    let reports = collect_reports(&dir);
    let human = reports
        .iter()
        .map(|report| {
            format!(
                "{}  {:<12} {:>10} bytes{}",
                report.stem,
                report.kind.as_deref().unwrap_or("unknown"),
                report.size_bytes,
                if report.has_minidump {
                    "  minidump"
                } else {
                    ""
                }
            )
        })
        .collect::<Vec<_>>();
    emit(format, &reports, &human)
}

fn show(dir: PathBuf, stem: &str, format: OutputFormat) -> Result<()> {
    validate_stem(stem)?;
    let path = ["json", "txt"]
        .into_iter()
        .map(|extension| dir.join(format!("{stem}.{extension}")))
        .find(|path| path.exists())
        .ok_or_else(|| anyhow!("crash report not found: {stem}"))?;
    let text = std::fs::read_to_string(&path)
        .with_context(|| format!("read crash report {}", path.display()))?;
    let value = serde_json::from_str::<Value>(&text).unwrap_or_else(|_| json!({"report": text}));
    emit(format, &value, &[text])
}

struct PackageArgs {
    dir: PathBuf,
    stem: String,
    out: PathBuf,
    include_minidump: bool,
    screenshot: Option<PathBuf>,
    description: Option<PathBuf>,
    signing_key: Option<PathBuf>,
}

fn package(args: PackageArgs, format: OutputFormat) -> Result<()> {
    validate_stem(&args.stem)?;
    let mut attachments = Vec::new();
    let mut metadata = Value::Null;
    for extension in ["json", "txt"] {
        let path = args.dir.join(format!("{}.{}", args.stem, extension));
        if path.exists() {
            if extension == "json" {
                metadata = serde_json::from_slice(&std::fs::read(&path)?).unwrap_or(Value::Null);
            }
            attachments.push(AttachmentInput {
                name: format!("{}.{}", args.stem, extension),
                path,
                media_type: if extension == "json" {
                    "application/json"
                } else {
                    "text/plain"
                }
                .to_owned(),
                kind: cognia_observability::diagnostic_package::AttachmentKind::Metadata,
            });
        }
    }
    if attachments.is_empty() {
        bail!("crash report not found: {}", args.stem);
    }
    if args.include_minidump {
        let path = args.dir.join(format!("{}.dmp", args.stem));
        if !path.exists() {
            bail!("selected minidump is unavailable");
        }
        attachments.push(AttachmentInput {
            name: format!("{}.dmp", args.stem),
            path,
            media_type: "application/vnd.microsoft.portable-executable".to_owned(),
            kind: cognia_observability::diagnostic_package::AttachmentKind::Minidump,
        });
    }
    if let Some(path) = args.screenshot {
        attachments.push(AttachmentInput {
            name: selected_name(&path, "screenshot.png")?,
            path,
            media_type: "image/png".to_owned(),
            kind: cognia_observability::diagnostic_package::AttachmentKind::Screenshot,
        });
    }
    if let Some(path) = args.description {
        attachments.push(AttachmentInput {
            name: selected_name(&path, "description.txt")?,
            path,
            media_type: "text/plain".to_owned(),
            kind: cognia_observability::diagnostic_package::AttachmentKind::UserDescription,
        });
    }
    let manifest = create_diagnostic_package(
        &args.out,
        DiagnosticPackageInput {
            incident_id: Uuid::new_v4(),
            created_at: Utc::now(),
            build_id: metadata
                .get("buildId")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_owned(),
            app_version: metadata
                .get("version")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_owned(),
            platform: std::env::consts::OS.to_owned(),
            events: Vec::new(),
            attachments,
            source_watermarks: BTreeMap::new(),
            missing_sources: Default::default(),
            redaction_version: "client-v1".to_owned(),
        },
        &load_or_create_signing_key(args.signing_key)?,
    )?;
    emit(
        format,
        &manifest,
        &[
            format!("Packaged {}", args.out.display()),
            "Minidumps, screenshots, and descriptions are included only when explicitly selected."
                .to_owned(),
        ],
    )
}

fn selected_name(path: &std::path::Path, fallback: &str) -> Result<String> {
    if !path.is_file() {
        bail!("selected attachment is not a file: {}", path.display());
    }
    Ok(path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(fallback)
        .to_owned())
}

/// Resolve an upload grant.
///
/// An explicit `--grant` wins. Otherwise the installation mints one from its
/// own Ed25519 proof — the same key that signed the package — which is what
/// makes `cognia crash submit` usable without first obtaining a token from
/// somewhere else. That path needs the tenant and project the service scopes
/// it to, so it says so plainly rather than failing at the exchange.
fn resolve_grant(
    server: &str,
    grant: Option<&str>,
    tenant_id: Option<&str>,
    project_id: Option<&str>,
) -> Result<String> {
    if let Some(grant) = grant {
        return Ok(grant.to_owned());
    }
    let (Some(tenant_id), Some(project_id)) = (tenant_id, project_id) else {
        bail!(
            "pass --grant, or --tenant-id and --project-id to mint one from this installation's key"
        );
    };
    let identity = installation_identity(None)?;
    let target = SubmissionTarget::new(server, tenant_id, project_id);
    exchange_installation_grant(&UreqTransport, &target, &identity, Utc::now().timestamp())
        .map_err(|error| anyhow!("could not obtain an upload grant: {error}"))
}

/// The tenant and project a grant is scoped to, for the routes that need a
/// target rather than just a bearer token.
fn submission_target(
    server: &str,
    tenant_id: Option<&str>,
    project_id: Option<&str>,
) -> SubmissionTarget {
    SubmissionTarget::new(
        server,
        tenant_id.unwrap_or_default(),
        project_id.unwrap_or_default(),
    )
}

fn submit(
    package: PathBuf,
    server: &str,
    grant: Option<&str>,
    tenant_id: Option<&str>,
    project_id: Option<&str>,
    format: OutputFormat,
    ui: &mut RuntimeUi,
) -> Result<()> {
    let validation = validate_diagnostic_package(&package)?;
    let selected = validation
        .manifest
        .inventory()
        .iter()
        .map(|entry| format!("{} ({} bytes, {:?})", entry.path, entry.bytes, entry.kind))
        .collect::<Vec<_>>();
    if !ui.flags.yes {
        let prompt = format!(
            "Submit incident {} with {} files ({} bytes)?\n{}",
            validation.manifest.incident_id(),
            validation.verified_files,
            validation.verified_bytes,
            selected.join("\n")
        );
        if !ui
            .prompter()
            .confirm(&prompt, false, "pass --yes after reviewing the package")?
        {
            bail!("submission cancelled; package remains local");
        }
    }

    let grant = resolve_grant(server, grant, tenant_id, project_id)?;
    let target = submission_target(server, tenant_id, project_id);
    // The shared sequence uploads one part per package entry with the artifact
    // kind the service dispatches processing on. The previous single-blob
    // upload produced no stack frames at all, so every submission grouped on
    // module and exception alone.
    let receipt = submit_package(
        &UreqTransport,
        &target,
        &grant,
        SubmissionRequest {
            package: &package,
            module: "cognia-cli",
            exception: "offline_diagnostic_bundle",
        },
    )
    .map_err(|error| anyhow!("submission failed: {error}"))?;

    emit(
        format,
        &receipt,
        &[
            format!("Submitted incident {}", receipt.incident_id),
            format!(
                "Support code: {}",
                if receipt.support_code.is_empty() {
                    "pending"
                } else {
                    &receipt.support_code
                }
            ),
            format!(
                "{} part(s) uploaded, {} already stored",
                receipt.uploaded_parts, receipt.resumed_parts
            ),
        ],
    )
}

fn status(
    incident_id: &str,
    server: &str,
    grant: Option<&str>,
    tenant_id: Option<&str>,
    project_id: Option<&str>,
    format: OutputFormat,
) -> Result<()> {
    let grant = resolve_grant(server, grant, tenant_id, project_id)?;
    let receipt = fetch_receipt(
        &UreqTransport,
        &submission_target(server, tenant_id, project_id),
        &grant,
        incident_id,
    )
    .map_err(|error| anyhow!("could not read the receipt: {error}"))?;
    emit(format, &receipt, &[serde_json::to_string_pretty(&receipt)?])
}

fn delete_remote(
    incident_id: &str,
    server: &str,
    grant: Option<&str>,
    tenant_id: Option<&str>,
    project_id: Option<&str>,
    format: OutputFormat,
) -> Result<()> {
    let grant = resolve_grant(server, grant, tenant_id, project_id)?;
    delete_incident(
        &UreqTransport,
        &submission_target(server, tenant_id, project_id),
        &grant,
        incident_id,
    )
    .map_err(|error| anyhow!("could not delete the incident: {error}"))?;
    emit(
        format,
        &json!({"incidentId": incident_id, "state": "deleted"}),
        &[format!("Deleted remote incident {incident_id}")],
    )
}

/// Withdraw consent for a submitted incident.
///
/// Distinct from deletion: it blocks processing *and* schedules removal, and
/// it is the route that stays reachable while the service has stopped
/// accepting new reports — the moment a withdrawal matters most. The CLI had
/// no way to reach it at all.
fn withdraw_remote(
    incident_id: &str,
    server: &str,
    grant: Option<&str>,
    tenant_id: Option<&str>,
    project_id: Option<&str>,
    format: OutputFormat,
) -> Result<()> {
    let grant = resolve_grant(server, grant, tenant_id, project_id)?;
    withdraw_consent(
        &UreqTransport,
        &submission_target(server, tenant_id, project_id),
        &grant,
        incident_id,
    )
    .map_err(|error| anyhow!("could not withdraw consent: {error}"))?;
    emit(
        format,
        &json!({"incidentId": incident_id, "state": "withdrawn"}),
        &[format!("Withdrew consent for incident {incident_id}")],
    )
}

fn delete_local(dir: PathBuf, stem: &str, format: OutputFormat) -> Result<()> {
    validate_stem(stem)?;
    let mut removed = 0;
    for extension in ["txt", "json", "dmp"] {
        let path = dir.join(format!("{stem}.{extension}"));
        if path.exists() {
            std::fs::remove_file(&path)?;
            removed += 1;
        }
    }
    if removed == 0 {
        bail!("crash report not found: {stem}");
    }
    emit(
        format,
        &json!({"stem": stem, "removedFiles": removed}),
        &[format!("Deleted {removed} local files for {stem}")],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collects_related_report_files_and_ignores_other_content() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("crash-a.json"),
            r#"{"capturedAt":"2026-08-01T00:00:00Z","kind":"panic"}"#,
        )
        .unwrap();
        std::fs::write(dir.path().join("crash-a.dmp"), "dump").unwrap();
        std::fs::write(dir.path().join("ignore.md"), "x").unwrap();
        let reports = collect_reports(dir.path());
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].kind.as_deref(), Some("panic"));
        assert!(reports[0].has_minidump);
    }

    #[test]
    fn local_delete_removes_only_valid_report_extensions() {
        let dir = tempfile::tempdir().unwrap();
        for extension in ["json", "txt", "dmp", "keep"] {
            std::fs::write(dir.path().join(format!("crash-a.{extension}")), "x").unwrap();
        }
        delete_local(dir.path().to_owned(), "crash-a", OutputFormat::Json).unwrap();
        assert!(dir.path().join("crash-a.keep").exists());
        assert!(!dir.path().join("crash-a.json").exists());
    }

    #[test]
    fn selected_attachments_must_be_files() {
        let dir = tempfile::tempdir().unwrap();
        assert!(selected_name(dir.path(), "fallback").is_err());
    }
}

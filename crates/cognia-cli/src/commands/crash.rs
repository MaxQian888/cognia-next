use std::{collections::BTreeMap, path::PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use chrono::Utc;
use cognia_observability::{
    create_diagnostic_package, validate_diagnostic_package, AttachmentInput, DiagnosticPackageInput,
};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    cli::{CrashCommand, OutputFormat},
    commands::diagnostic_common::{
        emit, load_or_create_signing_key, resolve_crash_dir, validate_stem,
    },
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
            format,
        } => submit(package, &server, &grant, format, ui),
        CrashCommand::Status {
            incident_id,
            server,
            grant,
            format,
        } => status(&incident_id, &server, &grant, format),
        CrashCommand::Delete {
            target,
            remote,
            server,
            grant,
            crash_dir,
            format,
        } => {
            if remote {
                delete_remote(
                    &target,
                    server.as_deref().expect("clap requires server"),
                    grant.as_deref().expect("clap requires grant"),
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

fn submit(
    package: PathBuf,
    server: &str,
    grant: &str,
    format: OutputFormat,
    ui: &mut RuntimeUi,
) -> Result<()> {
    let validation = validate_diagnostic_package(&package)?;
    let package_bytes = std::fs::read(&package)?;
    let package_hash = hex::encode(Sha256::digest(&package_bytes));
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
    let base = server.trim_end_matches('/');
    let create: Value = request_json(
        ureq::post(&format!("{base}/v1/incidents")),
        grant,
        Some(json!({
            "artifactHash": package_hash,
            "buildId": validation.manifest.build_id(),
            "platform": validation.manifest.platform(),
            "module": "cognia-cli",
            "exception": "offline_diagnostic_bundle",
            "attachmentCount": validation.manifest.inventory().len(),
            "eventCount": 0,
            "totalBytes": package_bytes.len(),
            "largestAttachmentBytes": package_bytes.len(),
            "largestMinidumpBytes": 0,
            "consent": true
        })),
    )?;
    let incident_id = create
        .pointer("/incident/id")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("diagnostic service omitted incident id"))?;
    request_bytes(
        ureq::put(&format!("{base}/v1/incidents/{incident_id}/parts/1"))
            .set("x-part-sha256", &package_hash)
            .set("x-artifact-kind", "attachment"),
        grant,
        &package_bytes,
    )?;
    let receipt = request_json(
        ureq::post(&format!("{base}/v1/incidents/{incident_id}/complete")),
        grant,
        Some(json!({"symbolizedFrames": []})),
    )?;
    emit(
        format,
        &receipt,
        &[
            format!("Submitted incident {incident_id}"),
            format!(
                "Support code: {}",
                receipt
                    .get("supportCode")
                    .and_then(Value::as_str)
                    .unwrap_or("pending")
            ),
        ],
    )
}

fn status(incident_id: &str, server: &str, grant: &str, format: OutputFormat) -> Result<()> {
    let receipt = request_json(
        ureq::get(&format!(
            "{}/v1/incidents/{incident_id}",
            server.trim_end_matches('/')
        )),
        grant,
        None,
    )?;
    emit(format, &receipt, &[serde_json::to_string_pretty(&receipt)?])
}

fn delete_remote(incident_id: &str, server: &str, grant: &str, format: OutputFormat) -> Result<()> {
    request_empty(
        ureq::delete(&format!(
            "{}/v1/incidents/{incident_id}",
            server.trim_end_matches('/')
        )),
        grant,
    )?;
    emit(
        format,
        &json!({"incidentId": incident_id, "state": "deleted"}),
        &[format!("Deleted remote incident {incident_id}")],
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

fn request_json(request: ureq::Request, grant: &str, body: Option<Value>) -> Result<Value> {
    let request = request
        .set("Authorization", &format!("Bearer {grant}"))
        .set("Content-Type", "application/json");
    let response = match body {
        Some(body) => request.send_json(body),
        None => request.call(),
    };
    decode_response(response)
}

fn request_bytes(request: ureq::Request, grant: &str, body: &[u8]) -> Result<()> {
    decode_response(
        request
            .set("Authorization", &format!("Bearer {grant}"))
            .set("Content-Type", "application/octet-stream")
            .send_bytes(body),
    )?;
    Ok(())
}

fn request_empty(request: ureq::Request, grant: &str) -> Result<()> {
    match request
        .set("Authorization", &format!("Bearer {grant}"))
        .call()
    {
        Ok(_) => Ok(()),
        Err(error) => Err(http_error(error)),
    }
}

fn decode_response(response: std::result::Result<ureq::Response, ureq::Error>) -> Result<Value> {
    match response {
        Ok(response) => response
            .into_json()
            .context("decode diagnostic service response"),
        Err(error) => Err(http_error(error)),
    }
}

fn http_error(error: ureq::Error) -> anyhow::Error {
    match error {
        ureq::Error::Status(status, response) => anyhow!(
            "diagnostic service returned HTTP {status}: {}",
            response.into_string().unwrap_or_default()
        ),
        error => anyhow!("diagnostic service request failed: {error}"),
    }
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

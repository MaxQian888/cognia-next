use std::{collections::BTreeMap, path::PathBuf, thread, time::Duration};

use anyhow::{Context, Result};
use chrono::Utc;
use cognia_observability::{
    create_diagnostic_package, list_log_dir, query_log_dir, DiagnosticPackageInput, NativeLogEntry,
    NativeLogQuery,
};
use serde::Serialize;
use uuid::Uuid;

use crate::{
    cli::{LogsCommand, OutputFormat},
    commands::diagnostic_common::{emit, load_or_create_signing_key, resolve_log_dir},
    ui::RuntimeUi,
};

pub fn run(command: LogsCommand, ui: &mut RuntimeUi) -> Result<()> {
    match command {
        LogsCommand::Tail {
            follow,
            limit,
            format,
            log_dir,
        } => tail(resolve_log_dir(log_dir)?, limit, follow, format, ui),
        LogsCommand::Query {
            min_level,
            target,
            contains,
            since_ms,
            limit,
            format,
            log_dir,
        } => query(
            resolve_log_dir(log_dir)?,
            NativeLogQuery {
                min_level,
                target,
                contains,
                since_ms,
                limit: Some(limit),
                ..Default::default()
            },
            format,
        ),
        LogsCommand::Doctor { format, log_dir } => doctor(resolve_log_dir(log_dir)?, format),
        LogsCommand::Export {
            out,
            limit,
            log_dir,
            signing_key,
            format,
        } => export(resolve_log_dir(log_dir)?, out, limit, signing_key, format),
    }
}

fn tail(
    dir: PathBuf,
    limit: usize,
    follow: bool,
    format: OutputFormat,
    ui: &RuntimeUi,
) -> Result<()> {
    let mut last_seen: Option<(String, String)> = None;
    loop {
        let result = query_log_dir(
            &dir,
            &NativeLogQuery {
                limit: Some(limit),
                ..Default::default()
            },
        )
        .map_err(anyhow::Error::msg)?;
        let mut entries = result.entries;
        entries.reverse();
        let unseen = entries
            .into_iter()
            .skip_while(|entry| {
                last_seen.as_ref().is_some_and(|(timestamp, message)| {
                    entry.timestamp != *timestamp || entry.message != *message
                })
            })
            .skip(if last_seen.is_some() { 1 } else { 0 })
            .collect::<Vec<_>>();
        if let Some(entry) = unseen.last() {
            last_seen = Some((entry.timestamp.clone(), entry.message.clone()));
        }
        emit_entries(format, &unseen)?;
        if !follow {
            return Ok(());
        }
        if !ui.flags.quiet && ui.flags.verbose > 1 {
            ui.verbose(format!("following {}", dir.display()));
        }
        thread::sleep(Duration::from_millis(500));
    }
}

fn query(dir: PathBuf, query: NativeLogQuery, format: OutputFormat) -> Result<()> {
    let result = query_log_dir(&dir, &query).map_err(anyhow::Error::msg)?;
    emit_entries(format, &result.entries)
}

fn emit_entries(format: OutputFormat, entries: &[NativeLogEntry]) -> Result<()> {
    let human = entries
        .iter()
        .map(|entry| {
            format!(
                "{} {:<5} {:<28} {}",
                entry.timestamp,
                entry.level.to_ascii_uppercase(),
                entry.target,
                entry.message
            )
        })
        .collect::<Vec<_>>();
    emit(format, entries, &human)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DoctorReport {
    status: &'static str,
    log_dir: String,
    file_count: usize,
    total_bytes: u64,
    parseable_entries: usize,
    scan_truncated: bool,
}

fn doctor(dir: PathBuf, format: OutputFormat) -> Result<()> {
    let files = list_log_dir(&dir);
    let query = query_log_dir(&dir, &NativeLogQuery::default()).map_err(anyhow::Error::msg)?;
    let report = DoctorReport {
        status: if dir.exists() {
            "healthy"
        } else {
            "unavailable"
        },
        log_dir: dir.display().to_string(),
        file_count: files.len(),
        total_bytes: files.iter().map(|file| file.size).sum(),
        parseable_entries: query.entries.len(),
        scan_truncated: query.truncated,
    };
    emit(
        format,
        &report,
        &[
            format!("Status: {}", report.status),
            format!("Directory: {}", report.log_dir),
            format!(
                "Files: {} ({} bytes)",
                report.file_count, report.total_bytes
            ),
            format!("Parseable recent entries: {}", report.parseable_entries),
        ],
    )
}

fn export(
    dir: PathBuf,
    out: PathBuf,
    limit: usize,
    signing_key: Option<PathBuf>,
    format: OutputFormat,
) -> Result<()> {
    let result = query_log_dir(
        &dir,
        &NativeLogQuery {
            limit: Some(limit),
            ..Default::default()
        },
    )
    .map_err(anyhow::Error::msg)?;
    let events = result
        .entries
        .iter()
        .map(serde_json::to_value)
        .collect::<Result<Vec<_>, _>>()?;
    let manifest = create_diagnostic_package(
        &out,
        DiagnosticPackageInput {
            incident_id: Uuid::new_v4(),
            created_at: Utc::now(),
            build_id: option_env!("COGNIA_BUILD_ID")
                .unwrap_or("cli-local")
                .to_owned(),
            app_version: env!("CARGO_PKG_VERSION").to_owned(),
            platform: std::env::consts::OS.to_owned(),
            events,
            attachments: Vec::new(),
            source_watermarks: BTreeMap::new(),
            missing_sources: Default::default(),
            redaction_version: "client-v1".to_owned(),
        },
        &load_or_create_signing_key(signing_key)?,
    )
    .with_context(|| format!("create diagnostic package {}", out.display()))?;
    emit(
        format,
        &manifest,
        &[format!("Exported signed diagnostics to {}", out.display())],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn doctor_reports_missing_directory_without_failing() {
        let dir = tempfile::tempdir().unwrap().path().join("missing");
        doctor(dir, OutputFormat::Json).unwrap();
    }

    #[test]
    fn query_supports_human_json_and_ndjson() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("cognia-structured.log"),
            r#"{"timestamp":"2026-08-01T00:00:00Z","level":"INFO","target":"test","fields":{"message":"ok"}}"#,
        )
        .unwrap();
        for format in [
            OutputFormat::Human,
            OutputFormat::Json,
            OutputFormat::Ndjson,
        ] {
            query(dir.path().to_owned(), NativeLogQuery::default(), format).unwrap();
        }
    }
}

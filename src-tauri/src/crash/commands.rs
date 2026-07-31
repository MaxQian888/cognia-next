//! Tauri commands for the crash subsystem — context ingestion from the
//! renderer plus listing/reading/opening/deleting reports and consuming the
//! pending-crash signal for the next-launch dialog.

use crate::crash::context::{self, Breadcrumb};
use crate::crash::sentinel::PendingCrash;
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;
use tauri_plugin_opener::OpenerExt;

/// Managed state holding the previous run's crash info (set once during
/// `setup`). `crash_take_pending` consumes it so the dialog fires only once.
#[derive(Default)]
pub struct PendingCrashState(pub Mutex<Option<PendingCrash>>);

impl PendingCrashState {
    pub fn new(pending: Option<PendingCrash>) -> Self {
        Self(Mutex::new(pending))
    }
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CrashReportSummary {
    pub stem: String,
    pub captured_at: Option<String>,
    pub kind: Option<String>,
    pub has_txt: bool,
    pub has_json: bool,
    pub has_dmp: bool,
    pub size_bytes: u64,
}

/// Reject anything that isn't a bare report stem — guards the read/delete
/// commands against path traversal.
fn validate_stem(stem: &str) -> Result<(), String> {
    if stem.is_empty()
        || stem.contains("..")
        || stem.contains('/')
        || stem.contains('\\')
        || stem.contains(':')
    {
        return Err("invalid_report_stem".to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn crash_set_context(config: serde_json::Value) -> Result<(), String> {
    context::set_config(config);
    Ok(())
}

#[tauri::command]
pub async fn crash_push_breadcrumb(message: String, level: Option<String>) -> Result<(), String> {
    context::push_breadcrumb(Breadcrumb {
        at: chrono::Utc::now().to_rfc3339(),
        level: level.unwrap_or_else(|| "info".to_string()),
        message,
    });
    Ok(())
}

#[tauri::command]
pub async fn crash_list_reports() -> Result<Vec<CrashReportSummary>, String> {
    Ok(collect_reports())
}

#[tauri::command]
pub async fn crash_read_report(stem: String) -> Result<String, String> {
    validate_stem(&stem)?;
    let dir = crate::crash::crash_reports_dir().ok_or("crash_dir_unavailable")?;
    let txt = dir.join(format!("{stem}.txt"));
    if txt.exists() {
        return std::fs::read_to_string(&txt).map_err(|e| format!("read_failed:{e}"));
    }
    let json = dir.join(format!("{stem}.json"));
    if json.exists() {
        return std::fs::read_to_string(&json).map_err(|e| format!("read_failed:{e}"));
    }
    Err("report_not_found".to_string())
}

#[tauri::command]
pub async fn crash_open_report_dir(app: tauri::AppHandle) -> Result<(), String> {
    let dir = crate::crash::crash_reports_dir().ok_or("crash_dir_unavailable")?;
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| format!("open_failed:{e}"))
}

#[tauri::command]
pub async fn crash_delete_report(stem: String) -> Result<(), String> {
    validate_stem(&stem)?;
    let dir = crate::crash::crash_reports_dir().ok_or("crash_dir_unavailable")?;
    for ext in ["txt", "json", "dmp"] {
        let path = dir.join(format!("{stem}.{ext}"));
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| format!("delete_failed:{e}"))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn crash_take_pending(
    state: State<'_, PendingCrashState>,
) -> Result<Option<PendingCrash>, String> {
    let mut guard = state.0.lock().map_err(|_| "state_poisoned")?;
    Ok(guard.take())
}

/// Aggregated crash + log health for the diagnostics surfaces (Settings →
/// About card and `/doctor`). Composes the existing report scan with the
/// retention policy/outcome and the on-disk log footprint.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CrashLoggingDiagnostics {
    pub crash_report_count: usize,
    pub latest_crash_at: Option<String>,
    pub latest_crash_kind: Option<String>,
    pub log_dir_bytes: u64,
    pub retention_max_age_days: u64,
    pub retention_max_reports: usize,
    pub rotated_log_keep: usize,
    pub last_prune_pruned: Option<usize>,
    pub last_prune_remaining: Option<usize>,
}

#[tauri::command]
pub async fn crash_logging_diagnostics() -> Result<CrashLoggingDiagnostics, String> {
    let reports = collect_reports();
    let latest = reports.first();
    let policy = crate::crash::retention::RetentionPolicy::default();
    let last_prune = crate::crash::retention::last_prune();

    Ok(CrashLoggingDiagnostics {
        crash_report_count: reports.len(),
        latest_crash_at: latest.and_then(|r| r.captured_at.clone()),
        latest_crash_kind: latest.and_then(|r| r.kind.clone()),
        log_dir_bytes: log_dir_bytes(),
        retention_max_age_days: policy.max_age_days,
        retention_max_reports: policy.max_reports,
        rotated_log_keep: crate::crash::retention::ROTATED_LOG_KEEP,
        last_prune_pruned: last_prune.map(|o| o.pruned),
        last_prune_remaining: last_prune.map(|o| o.remaining),
    })
}

/// Sum the bytes of every `*.log` file in the persistent log directory.
fn log_dir_bytes() -> u64 {
    let Some(dir) = crate::logging::native_bootstrap::log_dir() else {
        return 0;
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return 0;
    };
    entries
        .flatten()
        .filter(|e| {
            e.path()
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext == "log")
                .unwrap_or(false)
        })
        .filter_map(|e| e.metadata().ok().map(|m| m.len()))
        .sum()
}

/// Scan the crash-reports dir, grouping files by stem.
fn collect_reports() -> Vec<CrashReportSummary> {
    let Some(dir) = crate::crash::crash_reports_dir() else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };

    let mut by_stem: BTreeMap<String, CrashReportSummary> = BTreeMap::new();
    let mut json_paths: Vec<(String, PathBuf)> = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
            continue;
        };
        if !matches!(ext, "txt" | "json" | "dmp") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()).map(String::from) else {
            continue;
        };
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        let summary = by_stem
            .entry(stem.clone())
            .or_insert_with(|| CrashReportSummary {
                stem: stem.clone(),
                ..Default::default()
            });
        summary.size_bytes += size;
        match ext {
            "txt" => summary.has_txt = true,
            "json" => {
                summary.has_json = true;
                json_paths.push((stem.clone(), path.clone()));
            }
            "dmp" => summary.has_dmp = true,
            _ => {}
        }
    }

    // Enrich with capturedAt + kind from the JSON sidecar when present.
    for (stem, path) in json_paths {
        if let Ok(raw) = std::fs::read_to_string(&path) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(summary) = by_stem.get_mut(&stem) {
                    summary.captured_at = value
                        .get("capturedAt")
                        .and_then(|v| v.as_str())
                        .map(String::from);
                    summary.kind = value.get("kind").and_then(|v| v.as_str()).map(String::from);
                }
            }
        }
    }

    let mut reports: Vec<CrashReportSummary> = by_stem.into_values().collect();
    // Newest first — stems embed a sortable timestamp, so reverse-lexicographic
    // on the stem is a good ordering.
    reports.sort_by(|a, b| b.stem.cmp(&a.stem));
    reports
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_stem_rejects_traversal() {
        assert!(validate_stem("crash-2026-05-25_00-00-00-panic").is_ok());
        assert!(validate_stem("").is_err());
        assert!(validate_stem("../etc/passwd").is_err());
        assert!(validate_stem("a/b").is_err());
        assert!(validate_stem("a\\b").is_err());
        assert!(validate_stem("C:evil").is_err());
    }

    #[test]
    fn pending_state_take_consumes_value() {
        let state = PendingCrashState::new(Some(PendingCrash {
            started_at: "2026-05-25T00:00:00Z".to_string(),
            version: "0.1.0".to_string(),
            latest_report_stem: Some("crash-x-panic".to_string()),
            report_count: 1,
        }));
        let first = state.0.lock().unwrap().take();
        assert!(first.is_some());
        let second = state.0.lock().unwrap().take();
        assert!(second.is_none());
    }
}

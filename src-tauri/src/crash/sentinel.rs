//! Clean-exit sentinel — the single source of truth for "did the previous run
//! crash?". A marker file is written at startup and deleted on graceful
//! shutdown. If it survives into the next launch, the previous session ended
//! abnormally (crash, OOM-kill, power loss) and we surface the most recent
//! report. Presence of a *report* alone is not enough — recoverable worker
//! panics write reports yet exit cleanly.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

const SENTINEL_NAME: &str = ".session-running";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SessionMarker {
    pid: u32,
    version: String,
    started_at: String,
}

/// Info about an abnormal previous exit, surfaced to the renderer once.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingCrash {
    /// When the crashed session started (from its marker).
    pub started_at: String,
    pub version: String,
    /// Stem of the most recent report from after the session began, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_report_stem: Option<String>,
    /// Total report files (any extension) currently on disk.
    pub report_count: usize,
}

fn sentinel_path() -> Option<PathBuf> {
    crate::crash::crash_reports_dir().map(|d| d.join(SENTINEL_NAME))
}

/// Write the marker for the current session. Best-effort.
pub fn mark_start() {
    let Some(path) = sentinel_path() else {
        return;
    };
    let marker = SessionMarker {
        pid: std::process::id(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        started_at: chrono::Utc::now().to_rfc3339(),
    };
    if let Ok(json) = serde_json::to_string_pretty(&marker) {
        let _ = fs::write(&path, json);
    }
}

/// Delete the marker on graceful shutdown.
pub fn mark_clean_exit() {
    if let Some(path) = sentinel_path() {
        let _ = fs::remove_file(path);
    }
}

/// Read + consume any stale marker. Must run BEFORE [`mark_start`]. Returns the
/// previous-session crash info when the marker was present (abnormal exit).
pub fn take_pending() -> Option<PendingCrash> {
    let path = sentinel_path()?;
    let raw = fs::read_to_string(&path).ok()?;
    // Consume the stale marker regardless of parse outcome.
    let _ = fs::remove_file(&path);

    let marker: SessionMarker = serde_json::from_str(&raw).ok()?;
    let (latest_report_stem, report_count) = scan_reports();

    Some(PendingCrash {
        started_at: marker.started_at,
        version: marker.version,
        latest_report_stem,
        report_count,
    })
}

/// Most-recently-modified report stem + total report-file count.
fn scan_reports() -> (Option<String>, usize) {
    let Some(dir) = crate::crash::crash_reports_dir() else {
        return (None, 0);
    };
    let Ok(entries) = fs::read_dir(&dir) else {
        return (None, 0);
    };

    let mut count = 0usize;
    let mut newest: Option<(std::time::SystemTime, String)> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        let is_report = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| matches!(e, "txt" | "json" | "dmp"))
            .unwrap_or(false);
        if !is_report {
            continue;
        }
        count += 1;
        let modified = entry.metadata().and_then(|m| m.modified()).ok();
        if let (Some(modified), Some(stem)) = (
            modified,
            path.file_stem().and_then(|s| s.to_str()).map(String::from),
        ) {
            if newest.as_ref().map(|(t, _)| modified > *t).unwrap_or(true) {
                newest = Some((modified, stem));
            }
        }
    }
    (newest.map(|(_, stem)| stem), count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marker_serializes_with_expected_fields() {
        let marker = SessionMarker {
            pid: 1234,
            version: "0.1.0".to_string(),
            started_at: "2026-05-25T00:00:00+00:00".to_string(),
        };
        let json = serde_json::to_string(&marker).unwrap();
        assert!(json.contains("\"pid\":1234"));
        assert!(json.contains("\"startedAt\""));
        let back: SessionMarker = serde_json::from_str(&json).unwrap();
        assert_eq!(back, marker);
    }

    #[test]
    fn take_pending_is_none_without_marker() {
        // With no marker file freshly written, and after consuming any leftover
        // from a prior run, the result must be None.
        let _ = take_pending();
        assert!(take_pending().is_none());
    }

    #[test]
    fn mark_start_then_take_pending_reports_abnormal_exit() {
        if sentinel_path().is_none() {
            return; // no data dir in this sandbox
        }
        mark_start();
        let pending = take_pending();
        assert!(pending.is_some());
        let pending = pending.unwrap();
        assert_eq!(pending.version, env!("CARGO_PKG_VERSION"));
        // Marker consumed — a second take is None.
        assert!(take_pending().is_none());
    }

    #[test]
    fn mark_clean_exit_clears_marker() {
        if sentinel_path().is_none() {
            return;
        }
        mark_start();
        mark_clean_exit();
        assert!(take_pending().is_none());
    }
}

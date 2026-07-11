//! Native log read-back.
//!
//! Queries the on-disk log files produced by the native side — the structured
//! JSON stream (`cognia-structured.log`, written by `tracing_setup`) and the
//! plain `tauri-plugin-log` file (`cognia.log`) — so the frontend, the
//! companion API (mobile), and diagnostics tooling can read logs back without
//! shelling into the log directory.
//!
//! Queries are bounded: only the tail of the file (at most [`MAX_SCAN_BYTES`])
//! is scanned per call, and the result set is capped at [`MAX_LIMIT`] entries.
//! Parsing is best-effort — unparseable lines are skipped, never fatal.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::logging::native_bootstrap;

/// Default number of entries returned when the caller does not specify one.
pub const DEFAULT_LIMIT: usize = 200;
/// Hard cap on the number of entries a single query may return.
pub const MAX_LIMIT: usize = 1000;
/// Hard cap on how many bytes of file tail a single query scans.
pub const MAX_SCAN_BYTES: u64 = 4 * 1024 * 1024;

const STRUCTURED_LOG_FILE: &str = "cognia-structured.log";
const PLAIN_LOG_FILE: &str = "cognia.log";

/// Which on-disk log file to query.
#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum NativeLogFile {
    /// `cognia-structured.log` — JSON lines from the tracing subscriber.
    #[default]
    Structured,
    /// `cognia.log` — plain text lines from `tauri-plugin-log`.
    Plain,
}

/// Filterable query over a native log file. All fields optional; camelCase
/// to match the frontend/companion JSON convention.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NativeLogQuery {
    pub file: NativeLogFile,
    /// Minimum severity (`trace` < `debug` < `info` < `warn` < `error`).
    pub min_level: Option<String>,
    /// Hierarchy prefix match on the record target (same semantics as
    /// `tracing_setup::resolve_level`).
    pub target: Option<String>,
    /// Case-insensitive substring match on the message.
    pub contains: Option<String>,
    /// Only entries at or after this Unix-epoch timestamp (milliseconds).
    /// Entries whose timestamp can't be parsed are retained.
    pub since_ms: Option<i64>,
    /// Result cap; clamped to `1..=MAX_LIMIT`, defaults to `DEFAULT_LIMIT`.
    pub limit: Option<usize>,
}

/// One parsed log record, normalized across the two file formats.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeLogEntry {
    /// Raw timestamp text as it appears in the file.
    pub timestamp: String,
    /// Parsed Unix-epoch milliseconds, when the timestamp was parseable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub epoch_ms: Option<i64>,
    /// Lowercase level name (`trace`..`error`).
    pub level: String,
    pub target: String,
    pub message: String,
    /// Structured fields beyond the message (structured file only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fields: Option<Value>,
}

/// Query result: newest-first entries plus scan metadata so callers can tell
/// whether the window covered the whole file.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeLogQueryResult {
    pub entries: Vec<NativeLogEntry>,
    pub file_size: u64,
    pub scanned_bytes: u64,
    /// True when the file was larger than the scan window (older entries
    /// exist beyond `entries`).
    pub truncated: bool,
    pub path: String,
}

/// Metadata for one file in the log directory.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeLogFileInfo {
    pub name: String,
    pub size: u64,
    /// Last-modified time as Unix-epoch milliseconds, when available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_ms: Option<i64>,
}

fn level_rank(level: &str) -> u8 {
    match level.trim().to_ascii_lowercase().as_str() {
        "trace" => 0,
        "debug" => 1,
        "warn" | "warning" => 3,
        "error" | "fatal" => 4,
        _ => 2, // info + unknown
    }
}

fn parse_epoch_ms(timestamp: &str) -> Option<i64> {
    // RFC3339 (structured file): 2026-07-11T02:33:44.123456Z
    if let Ok(dt) = DateTime::parse_from_rfc3339(timestamp) {
        return Some(dt.with_timezone(&Utc).timestamp_millis());
    }
    // Plain file bracket form recombined as "YYYY-MM-DD HH:MM:SS" (local time,
    // treated as UTC — good enough for range filtering on one machine).
    if let Ok(dt) = NaiveDateTime::parse_from_str(timestamp, "%Y-%m-%d %H:%M:%S") {
        return Some(Utc.from_utc_datetime(&dt).timestamp_millis());
    }
    None
}

/// Parse one JSON line from the structured file. The tracing JSON layer emits
/// `{"timestamp": "...", "level": "INFO", "target": "...", "fields": {"message": "...", ...}}`.
fn parse_structured_line(line: &str) -> Option<NativeLogEntry> {
    let value: Value = serde_json::from_str(line.trim()).ok()?;
    let obj = value.as_object()?;
    let timestamp = obj.get("timestamp")?.as_str()?.to_string();
    let level = obj.get("level")?.as_str()?.to_ascii_lowercase();
    let target = obj
        .get("target")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let fields = obj.get("fields").and_then(Value::as_object);
    let message = fields
        .and_then(|f| f.get("message"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let extra_fields = fields.and_then(|f| {
        let rest: serde_json::Map<String, Value> = f
            .iter()
            .filter(|(key, _)| key.as_str() != "message")
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        if rest.is_empty() {
            None
        } else {
            Some(Value::Object(rest))
        }
    });
    let epoch_ms = parse_epoch_ms(&timestamp);
    Some(NativeLogEntry {
        timestamp,
        epoch_ms,
        level,
        target,
        message,
        fields: extra_fields,
    })
}

const LEVEL_NAMES: [&str; 6] = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"];

/// Parse one plain `tauri-plugin-log` line. The default format is a run of
/// leading `[...]` groups (date, time, level, target) followed by the message,
/// e.g. `[2026-07-11][02:33:44][INFO][cognia_lib::x] message`. Token order is
/// detected rather than assumed: the level token is the first group matching a
/// level name, the target is the group after it, and every group before the
/// level that looks like a date/time contributes to the timestamp.
fn parse_plain_line(line: &str) -> Option<NativeLogEntry> {
    let trimmed = line.trim_end();
    if !trimmed.starts_with('[') {
        return None;
    }
    let mut rest = trimmed;
    let mut groups: Vec<&str> = Vec::new();
    while rest.starts_with('[') {
        let close = rest.find(']')?;
        groups.push(&rest[1..close]);
        rest = rest[close + 1..].trim_start_matches(' ');
        if groups.len() > 6 {
            break;
        }
    }
    let level_index = groups
        .iter()
        .position(|group| LEVEL_NAMES.contains(&group.trim().to_ascii_uppercase().as_str()))?;
    let level = groups[level_index].trim().to_ascii_lowercase();
    let target = groups
        .get(level_index + 1)
        .map(|group| group.trim().to_string())
        .unwrap_or_default();
    let timestamp = groups[..level_index].join(" ").trim().to_string();
    let epoch_ms = parse_epoch_ms(&timestamp);
    Some(NativeLogEntry {
        timestamp,
        epoch_ms,
        level,
        target,
        message: rest.to_string(),
        fields: None,
    })
}

fn target_matches(entry_target: &str, prefix: &str) -> bool {
    entry_target == prefix
        || entry_target.starts_with(&format!("{prefix}::"))
        || entry_target.starts_with(&format!("{prefix}:"))
}

fn entry_passes(entry: &NativeLogEntry, query: &NativeLogQuery) -> bool {
    if let Some(min_level) = &query.min_level {
        if level_rank(&entry.level) < level_rank(min_level) {
            return false;
        }
    }
    if let Some(prefix) = &query.target {
        let prefix = prefix.trim();
        if !prefix.is_empty() && !target_matches(&entry.target, prefix) {
            return false;
        }
    }
    if let Some(needle) = &query.contains {
        let needle = needle.trim().to_lowercase();
        if !needle.is_empty() && !entry.message.to_lowercase().contains(&needle) {
            return false;
        }
    }
    if let Some(since_ms) = query.since_ms {
        // Entries with unparseable timestamps are retained (over-include
        // rather than silently hide records from a range query).
        if let Some(epoch_ms) = entry.epoch_ms {
            if epoch_ms < since_ms {
                return false;
            }
        }
    }
    true
}

/// Read at most `MAX_SCAN_BYTES` from the end of `path`. Returns the text
/// (lossy UTF-8, first partial line dropped when the window is truncated),
/// the file size, and the number of bytes actually scanned.
fn read_tail(path: &Path) -> std::io::Result<(String, u64, u64)> {
    let mut file = File::open(path)?;
    let file_size = file.metadata()?.len();
    let scan = file_size.min(MAX_SCAN_BYTES);
    file.seek(SeekFrom::End(-(scan as i64)))?;
    let mut buffer = Vec::with_capacity(scan as usize);
    file.read_to_end(&mut buffer)?;
    let mut text = String::from_utf8_lossy(&buffer).into_owned();
    if scan < file_size {
        // Drop the first (probably partial) line of a truncated window.
        if let Some(newline) = text.find('\n') {
            text.drain(..=newline);
        }
    }
    Ok((text, file_size, scan))
}

fn log_file_path(file: NativeLogFile, dir: &Path) -> PathBuf {
    match file {
        NativeLogFile::Structured => dir.join(STRUCTURED_LOG_FILE),
        NativeLogFile::Plain => dir.join(PLAIN_LOG_FILE),
    }
}

/// Run `query` against the given log directory. Pure over the directory so
/// tests can point it at a tempdir; the command wrapper resolves the real dir.
pub fn query_log_dir(dir: &Path, query: &NativeLogQuery) -> Result<NativeLogQueryResult, String> {
    let path = log_file_path(query.file, dir);
    if !path.exists() {
        return Ok(NativeLogQueryResult {
            entries: Vec::new(),
            file_size: 0,
            scanned_bytes: 0,
            truncated: false,
            path: path.to_string_lossy().to_string(),
        });
    }
    let (text, file_size, scanned_bytes) =
        read_tail(&path).map_err(|error| format!("log_read_failed:{error}"))?;
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);

    // Newest entries live at the end of the file — walk lines in reverse and
    // stop as soon as the limit is reached.
    let mut entries: Vec<NativeLogEntry> = Vec::new();
    for line in text.lines().rev() {
        if line.trim().is_empty() {
            continue;
        }
        let parsed = match query.file {
            NativeLogFile::Structured => parse_structured_line(line),
            NativeLogFile::Plain => parse_plain_line(line),
        };
        let Some(entry) = parsed else { continue };
        if !entry_passes(&entry, query) {
            continue;
        }
        entries.push(entry);
        if entries.len() >= limit {
            break;
        }
    }

    Ok(NativeLogQueryResult {
        entries,
        file_size,
        scanned_bytes,
        truncated: scanned_bytes < file_size,
        path: path.to_string_lossy().to_string(),
    })
}

/// List `.log` files (live + rotated + structured) in the given directory,
/// newest-modified first.
pub fn list_log_dir(dir: &Path) -> Vec<NativeLogFileInfo> {
    let Ok(read_dir) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<NativeLogFileInfo> = read_dir
        .flatten()
        .filter_map(|dir_entry| {
            let name = dir_entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(".log") {
                return None;
            }
            let meta = dir_entry.metadata().ok()?;
            if !meta.is_file() {
                return None;
            }
            let modified_ms = meta
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as i64);
            Some(NativeLogFileInfo {
                name,
                size: meta.len(),
                modified_ms,
            })
        })
        .collect();
    files.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    files
}

/// Query the app's real log directory (companion API + Tauri command entry).
pub fn query_native_logs(query: &NativeLogQuery) -> Result<NativeLogQueryResult, String> {
    let dir = native_bootstrap::log_dir().ok_or_else(|| "log_directory_unavailable".to_string())?;
    query_log_dir(&dir, query)
}

/// List the app's real log directory (companion API + Tauri command entry).
pub fn list_native_log_files() -> Result<Vec<NativeLogFileInfo>, String> {
    let dir = native_bootstrap::log_dir().ok_or_else(|| "log_directory_unavailable".to_string())?;
    Ok(list_log_dir(&dir))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::write;

    fn structured_lines() -> String {
        [
            r#"{"timestamp":"2026-07-11T01:00:00.000000Z","level":"INFO","target":"boot","fields":{"message":"app started"}}"#,
            r#"{"timestamp":"2026-07-11T01:00:01.000000Z","level":"DEBUG","target":"network::lark","fields":{"message":"ws ping","seq":7}}"#,
            r#"{"timestamp":"2026-07-11T01:00:02.000000Z","level":"WARN","target":"network","fields":{"message":"slow response"}}"#,
            r#"{"timestamp":"2026-07-11T01:00:03.000000Z","level":"ERROR","target":"connectors","fields":{"message":"send failed"}}"#,
            "not json at all",
        ]
        .join("\n")
    }

    #[test]
    fn structured_query_returns_newest_first_with_fields() {
        let dir = tempfile::tempdir().expect("tempdir");
        write(dir.path().join(STRUCTURED_LOG_FILE), structured_lines()).unwrap();

        let result = query_log_dir(dir.path(), &NativeLogQuery::default()).unwrap();

        assert_eq!(result.entries.len(), 4);
        assert_eq!(result.entries[0].message, "send failed");
        assert_eq!(result.entries[3].message, "app started");
        assert!(!result.truncated);
        // Non-message fields survive as `fields`.
        let ping = result
            .entries
            .iter()
            .find(|entry| entry.message == "ws ping")
            .unwrap();
        assert_eq!(ping.fields.as_ref().unwrap()["seq"], 7);
        assert!(ping.epoch_ms.is_some());
    }

    #[test]
    fn min_level_target_contains_and_since_filters_apply() {
        let dir = tempfile::tempdir().expect("tempdir");
        write(dir.path().join(STRUCTURED_LOG_FILE), structured_lines()).unwrap();

        let warn_up = query_log_dir(
            dir.path(),
            &NativeLogQuery {
                min_level: Some("warn".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(warn_up.entries.len(), 2);

        let network_only = query_log_dir(
            dir.path(),
            &NativeLogQuery {
                target: Some("network".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(network_only.entries.len(), 2); // network + network::lark

        let contains = query_log_dir(
            dir.path(),
            &NativeLogQuery {
                contains: Some("SEND".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(contains.entries.len(), 1);

        let since = query_log_dir(
            dir.path(),
            &NativeLogQuery {
                since_ms: parse_epoch_ms("2026-07-11T01:00:02.000000Z"),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(since.entries.len(), 2);
    }

    #[test]
    fn limit_is_clamped_and_applied() {
        let dir = tempfile::tempdir().expect("tempdir");
        write(dir.path().join(STRUCTURED_LOG_FILE), structured_lines()).unwrap();

        let limited = query_log_dir(
            dir.path(),
            &NativeLogQuery {
                limit: Some(2),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(limited.entries.len(), 2);
        assert_eq!(limited.entries[0].message, "send failed");

        let zero = query_log_dir(
            dir.path(),
            &NativeLogQuery {
                limit: Some(0),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(zero.entries.len(), 1); // clamped to 1
    }

    #[test]
    fn plain_lines_parse_levels_targets_and_timestamps() {
        let dir = tempfile::tempdir().expect("tempdir");
        let lines = [
            "[2026-07-11][01:00:00][INFO][cognia_lib::boot] plain start",
            "[2026-07-11][01:00:01][WARN][fontdb] bad font",
            "no brackets here",
        ]
        .join("\n");
        write(dir.path().join(PLAIN_LOG_FILE), lines).unwrap();

        let result = query_log_dir(
            dir.path(),
            &NativeLogQuery {
                file: NativeLogFile::Plain,
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(result.entries.len(), 2);
        assert_eq!(result.entries[0].level, "warn");
        assert_eq!(result.entries[0].target, "fontdb");
        assert_eq!(result.entries[0].message, "bad font");
        assert_eq!(result.entries[1].message, "plain start");
        assert!(result.entries[0].epoch_ms.is_some());
    }

    #[test]
    fn missing_file_yields_empty_result_not_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let result = query_log_dir(dir.path(), &NativeLogQuery::default()).unwrap();
        assert!(result.entries.is_empty());
        assert_eq!(result.file_size, 0);
    }

    #[test]
    fn entries_with_unparseable_timestamps_survive_since_filter() {
        let entry = NativeLogEntry {
            timestamp: "garbage".into(),
            epoch_ms: None,
            level: "info".into(),
            target: "x".into(),
            message: "m".into(),
            fields: None,
        };
        let query = NativeLogQuery {
            since_ms: Some(i64::MAX),
            ..Default::default()
        };
        assert!(entry_passes(&entry, &query));
    }

    #[test]
    fn list_log_dir_returns_only_log_files() {
        let dir = tempfile::tempdir().expect("tempdir");
        write(dir.path().join("cognia.log"), "a").unwrap();
        write(dir.path().join("cognia_2026-07-10.log"), "b").unwrap();
        write(dir.path().join("notes.txt"), "c").unwrap();

        let files = list_log_dir(dir.path());
        let names: Vec<&str> = files.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(files.len(), 2);
        assert!(names.contains(&"cognia.log"));
        assert!(names.contains(&"cognia_2026-07-10.log"));
    }

    #[test]
    fn level_rank_orders_severities() {
        assert!(level_rank("trace") < level_rank("debug"));
        assert!(level_rank("debug") < level_rank("info"));
        assert!(level_rank("info") < level_rank("warn"));
        assert!(level_rank("warn") < level_rank("error"));
        assert_eq!(level_rank("fatal"), level_rank("error"));
        assert_eq!(level_rank("unknown"), level_rank("info"));
    }
}

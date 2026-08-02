use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

use chrono::{DateTime, NaiveDateTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const DEFAULT_LIMIT: usize = 200;
pub const MAX_LIMIT: usize = 1000;
pub const MAX_SCAN_BYTES: u64 = 4 * 1024 * 1024;
pub const STRUCTURED_LOG_FILE: &str = "cognia-structured.log";
pub const PLAIN_LOG_FILE: &str = "cognia.log";

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum NativeLogFile {
    #[default]
    Structured,
    Plain,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NativeLogQuery {
    pub file: NativeLogFile,
    pub min_level: Option<String>,
    pub target: Option<String>,
    pub contains: Option<String>,
    pub since_ms: Option<i64>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeLogEntry {
    pub timestamp: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub epoch_ms: Option<i64>,
    pub level: String,
    pub target: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fields: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeLogQueryResult {
    pub entries: Vec<NativeLogEntry>,
    pub file_size: u64,
    pub scanned_bytes: u64,
    pub truncated: bool,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeLogFileInfo {
    pub name: String,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_ms: Option<i64>,
}

pub fn query_log_dir(dir: &Path, query: &NativeLogQuery) -> Result<NativeLogQueryResult, String> {
    let path = log_file_path(query.file, dir);
    if !path.exists() {
        return Ok(NativeLogQueryResult {
            entries: Vec::new(),
            file_size: 0,
            scanned_bytes: 0,
            truncated: false,
            path: path.to_string_lossy().into_owned(),
        });
    }
    let (text, file_size, scanned_bytes) =
        read_tail(&path).map_err(|error| format!("log_read_failed:{error}"))?;
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let entries = text
        .lines()
        .rev()
        .filter_map(|line| match query.file {
            NativeLogFile::Structured => parse_structured_line(line),
            NativeLogFile::Plain => parse_plain_line(line),
        })
        .filter(|entry| entry_passes(entry, query))
        .take(limit)
        .collect();
    Ok(NativeLogQueryResult {
        entries,
        file_size,
        scanned_bytes,
        truncated: scanned_bytes < file_size,
        path: path.to_string_lossy().into_owned(),
    })
}

pub fn list_log_dir(dir: &Path) -> Vec<NativeLogFileInfo> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".log") {
                return None;
            }
            let metadata = entry.metadata().ok()?;
            metadata.is_file().then(|| NativeLogFileInfo {
                name,
                size: metadata.len(),
                modified_ms: metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|duration| duration.as_millis() as i64),
            })
        })
        .collect::<Vec<_>>();
    files.sort_by(|left, right| right.modified_ms.cmp(&left.modified_ms));
    files
}

fn log_file_path(file: NativeLogFile, dir: &Path) -> PathBuf {
    dir.join(match file {
        NativeLogFile::Structured => STRUCTURED_LOG_FILE,
        NativeLogFile::Plain => PLAIN_LOG_FILE,
    })
}

fn read_tail(path: &Path) -> std::io::Result<(String, u64, u64)> {
    let mut file = File::open(path)?;
    let file_size = file.metadata()?.len();
    let scanned_bytes = file_size.min(MAX_SCAN_BYTES);
    file.seek(SeekFrom::End(-(scanned_bytes as i64)))?;
    let mut bytes = Vec::with_capacity(scanned_bytes as usize);
    file.read_to_end(&mut bytes)?;
    let mut text = String::from_utf8_lossy(&bytes).into_owned();
    if scanned_bytes < file_size {
        if let Some(newline) = text.find('\n') {
            text.drain(..=newline);
        }
    }
    Ok((text, file_size, scanned_bytes))
}

fn parse_epoch_ms(timestamp: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(timestamp)
        .ok()
        .map(|time| time.timestamp_millis())
        .or_else(|| {
            NaiveDateTime::parse_from_str(timestamp, "%Y-%m-%d %H:%M:%S")
                .ok()
                .map(|time| Utc.from_utc_datetime(&time).timestamp_millis())
        })
}

fn parse_structured_line(line: &str) -> Option<NativeLogEntry> {
    let value: Value = serde_json::from_str(line.trim()).ok()?;
    let object = value.as_object()?;
    let timestamp = object.get("timestamp")?.as_str()?.to_owned();
    let fields = object.get("fields").and_then(Value::as_object);
    let extra_fields = fields.and_then(|fields| {
        let extras = fields
            .iter()
            .filter(|(key, _)| key.as_str() != "message")
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect::<serde_json::Map<_, _>>();
        (!extras.is_empty()).then_some(Value::Object(extras))
    });
    Some(NativeLogEntry {
        epoch_ms: parse_epoch_ms(&timestamp),
        timestamp,
        level: object.get("level")?.as_str()?.to_ascii_lowercase(),
        target: object
            .get("target")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        message: fields
            .and_then(|fields| fields.get("message"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        fields: extra_fields,
    })
}

fn parse_plain_line(line: &str) -> Option<NativeLogEntry> {
    let mut rest = line.trim_end();
    let mut groups = Vec::new();
    while rest.starts_with('[') && groups.len() <= 6 {
        let close = rest.find(']')?;
        groups.push(&rest[1..close]);
        rest = rest[close + 1..].trim_start();
    }
    let level_index = groups.iter().position(|group| {
        matches!(
            group.trim().to_ascii_uppercase().as_str(),
            "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL"
        )
    })?;
    let timestamp = groups[..level_index].join(" ").trim().to_owned();
    Some(NativeLogEntry {
        epoch_ms: parse_epoch_ms(&timestamp),
        timestamp,
        level: groups[level_index].trim().to_ascii_lowercase(),
        target: groups
            .get(level_index + 1)
            .map(|value| value.trim().to_owned())
            .unwrap_or_default(),
        message: rest.to_owned(),
        fields: None,
    })
}

fn entry_passes(entry: &NativeLogEntry, query: &NativeLogQuery) -> bool {
    if query
        .min_level
        .as_deref()
        .is_some_and(|minimum| level_rank(&entry.level) < level_rank(minimum))
    {
        return false;
    }
    if query.target.as_deref().is_some_and(|prefix| {
        let prefix = prefix.trim();
        !prefix.is_empty()
            && entry.target != prefix
            && !entry.target.starts_with(&format!("{prefix}::"))
            && !entry.target.starts_with(&format!("{prefix}:"))
    }) {
        return false;
    }
    if query.contains.as_deref().is_some_and(|needle| {
        let needle = needle.trim().to_lowercase();
        !needle.is_empty() && !entry.message.to_lowercase().contains(&needle)
    }) {
        return false;
    }
    query
        .since_ms
        .zip(entry.epoch_ms)
        .is_none_or(|(since, occurred)| occurred >= since)
}

fn level_rank(level: &str) -> u8 {
    match level.trim().to_ascii_lowercase().as_str() {
        "trace" => 0,
        "debug" => 1,
        "warn" | "warning" => 3,
        "error" | "fatal" => 4,
        _ => 2,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn structured_lines() -> String {
        [
            r#"{"timestamp":"2026-07-11T01:00:00Z","level":"INFO","target":"boot","fields":{"message":"started"}}"#,
            r#"{"timestamp":"2026-07-11T01:00:01Z","level":"DEBUG","target":"network::lark","fields":{"message":"ping","seq":7}}"#,
            r#"{"timestamp":"2026-07-11T01:00:02Z","level":"WARN","target":"network","fields":{"message":"slow response"}}"#,
            "not-json",
        ]
        .join("\n")
    }

    #[test]
    fn structured_query_filters_and_returns_newest_first() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(STRUCTURED_LOG_FILE), structured_lines()).unwrap();
        let result = query_log_dir(
            dir.path(),
            &NativeLogQuery {
                min_level: Some("info".to_owned()),
                target: Some("network".to_owned()),
                contains: Some("SLOW".to_owned()),
                limit: Some(10),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(result.entries.len(), 1);
        assert_eq!(result.entries[0].message, "slow response");
        assert!(!result.truncated);
    }

    #[test]
    fn retains_structured_fields_and_clamps_zero_limit() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(STRUCTURED_LOG_FILE), structured_lines()).unwrap();
        let result = query_log_dir(
            dir.path(),
            &NativeLogQuery {
                limit: Some(0),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(result.entries.len(), 1);
        assert_eq!(result.entries[0].message, "slow response");
    }

    #[test]
    fn parses_plain_logs_and_lists_only_log_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(PLAIN_LOG_FILE),
            "[2026-07-11][01:00:00][INFO][boot] ready\ninvalid",
        )
        .unwrap();
        std::fs::write(dir.path().join("ignore.txt"), "x").unwrap();
        let result = query_log_dir(
            dir.path(),
            &NativeLogQuery {
                file: NativeLogFile::Plain,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(result.entries[0].target, "boot");
        assert_eq!(result.entries[0].message, "ready");
        assert_eq!(list_log_dir(dir.path()).len(), 1);
    }

    #[test]
    fn missing_directory_or_file_is_an_empty_result() {
        let dir = tempfile::tempdir().unwrap();
        assert!(query_log_dir(dir.path(), &NativeLogQuery::default())
            .unwrap()
            .entries
            .is_empty());
        assert!(list_log_dir(&dir.path().join("missing")).is_empty());
    }
}

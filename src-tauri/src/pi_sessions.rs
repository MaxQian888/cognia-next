//! Desktop half of the `list_pi_sessions` host command (ADR-0119).
//!
//! Pi's RPC protocol has no session listing (`switch_session` takes a path
//! the caller must already know), and the renderer cannot read the disk. So
//! the host reads Pi's own store the way Pi's `SessionManager.list` does:
//! `$PI_CODING_AGENT_DIR` (default `~/.pi/agent`) `/sessions/<encoded cwd>/*.jsonl`,
//! header line first, last `session_info` entry for the display name. Nothing
//! is written, and message bodies never leave this module. The CLI's answer is
//! `cli/src/agent/tool-host/pi-sessions.ts`, and both emit the same record shape.

use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiSessionRecord {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

/// Files larger than this keep their header but skip the name scan.
const NAME_SCAN_LIMIT: u64 = 16 * 1024 * 1024;

pub fn pi_agent_dir() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("PI_CODING_AGENT_DIR") {
        let trimmed = dir.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }
    dirs::home_dir().map(|home| home.join(".pi").join("agent"))
}

/// Pi's session directory name for a working directory (`session-manager.js`).
pub fn pi_session_dir_name(cwd: &str) -> String {
    let trimmed = cwd
        .strip_prefix('/')
        .or_else(|| cwd.strip_prefix('\\'))
        .unwrap_or(cwd);
    let encoded: String = trimmed
        .chars()
        .map(|c| {
            if c == '/' || c == '\\' || c == ':' {
                '-'
            } else {
                c
            }
        })
        .collect();
    format!("--{encoded}--")
}

fn parse_header(line: &str) -> Option<(String, Option<String>, Option<String>)> {
    let value: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    if value.get("type")?.as_str()? != "session" {
        return None;
    }
    let id = value.get("id")?.as_str()?.to_string();
    if id.is_empty() {
        return None;
    }
    let cwd = value.get("cwd").and_then(|v| v.as_str()).map(str::to_string);
    let created = value
        .get("timestamp")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    Some((id, cwd, created))
}

fn read_records(dir: &Path, cwd_filter: Option<&str>) -> Vec<PiSessionRecord> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let mut lines = text.lines().filter(|l| !l.trim().is_empty());
        let Some(first) = lines.next() else { continue };
        let Some((id, cwd, created)) = parse_header(first) else {
            continue;
        };
        if let Some(filter) = cwd_filter {
            match cwd.as_deref() {
                Some(c) if c == filter => {}
                _ => continue,
            }
        }
        let name = if meta.len() > NAME_SCAN_LIMIT {
            None
        } else {
            lines
                .filter(|l| l.contains("\"session_info\""))
                .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
                .filter(|v| v.get("type").and_then(|t| t.as_str()) == Some("session_info"))
                .filter_map(|v| v.get("name").and_then(|n| n.as_str()).map(str::to_string))
                .filter(|n| !n.is_empty())
                .last()
        };
        let updated = meta.modified().ok().map(|t| {
            chrono::DateTime::<chrono::Utc>::from(t)
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        });
        out.push(PiSessionRecord {
            id,
            cwd,
            name,
            created_at: created,
            updated_at: updated,
        });
    }
    out
}

/// Sessions for one working directory, or for every directory when `cwd` is
/// absent. Newest activity first.
pub fn list_in_agent_dir(agent_dir: &Path, cwd: Option<&str>) -> Vec<PiSessionRecord> {
    let root = agent_dir.join("sessions");
    let mut records = match cwd {
        Some(cwd) => read_records(&root.join(pi_session_dir_name(cwd)), Some(cwd)),
        None => std::fs::read_dir(&root)
            .map(|entries| {
                entries
                    .flatten()
                    .filter(|e| e.path().is_dir())
                    .flat_map(|e| read_records(&e.path(), None))
                    .collect()
            })
            .unwrap_or_default(),
    };
    records.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    records
}

#[tauri::command]
pub fn list_pi_sessions(cwd: Option<String>) -> Result<Vec<PiSessionRecord>, String> {
    let agent_dir = pi_agent_dir().ok_or_else(|| "no home directory".to_string())?;
    let cwd = cwd.map(|c| c.trim().to_string()).filter(|c| !c.is_empty());
    Ok(list_in_agent_dir(&agent_dir, cwd.as_deref()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(agent_dir: &Path, cwd: &str, file: &str, lines: &[&str]) {
        let dir = agent_dir.join("sessions").join(pi_session_dir_name(cwd));
        std::fs::create_dir_all(&dir).expect("mkdir");
        std::fs::write(dir.join(file), format!("{}\n", lines.join("\n"))).expect("write");
    }

    #[test]
    fn encodes_like_pi() {
        assert_eq!(
            pi_session_dir_name("/Users/me/Project/app"),
            "--Users-me-Project-app--"
        );
        assert_eq!(pi_session_dir_name("C:\\work\\x"), "--C--work-x--");
    }

    #[test]
    fn reads_header_and_last_name_scoped_to_cwd() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let cwd = "/w/one";
        write(
            tmp.path(),
            cwd,
            "a.jsonl",
            &[
                r#"{"type":"session","version":3,"id":"id-a","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/w/one"}"#,
                r#"{"type":"session_info","id":"x","parentId":null,"name":"first"}"#,
                r#"{"type":"message","id":"y","parentId":"x","message":{"role":"user","content":"hi"}}"#,
                r#"{"type":"session_info","id":"z","parentId":"y","name":"final"}"#,
            ],
        );
        write(
            tmp.path(),
            cwd,
            "moved.jsonl",
            &[r#"{"type":"session","id":"id-m","cwd":"/w/other"}"#],
        );
        write(tmp.path(), cwd, "junk.jsonl", &[r#"{"type":"message","id":"n"}"#]);
        write(
            tmp.path(),
            "/w/other",
            "b.jsonl",
            &[r#"{"type":"session","id":"id-b","cwd":"/w/other"}"#],
        );

        let scoped = list_in_agent_dir(tmp.path(), Some(cwd));
        assert_eq!(scoped.len(), 1);
        assert_eq!(scoped[0].id, "id-a");
        assert_eq!(scoped[0].name.as_deref(), Some("final"));
        assert_eq!(
            scoped[0].created_at.as_deref(),
            Some("2026-01-01T00:00:00.000Z")
        );
        assert!(scoped[0].updated_at.is_some());

        let mut all: Vec<String> = list_in_agent_dir(tmp.path(), None)
            .into_iter()
            .map(|r| r.id)
            .collect();
        all.sort();
        assert_eq!(all, vec!["id-a", "id-b", "id-m"]);
    }

    #[test]
    fn a_missing_store_is_empty_not_an_error() {
        let tmp = tempfile::tempdir().expect("tempdir");
        assert!(list_in_agent_dir(&tmp.path().join("absent"), Some("/x")).is_empty());
    }
}

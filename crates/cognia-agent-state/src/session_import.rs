//! OpenCode session-history reader.
//!
//! Reads OpenCode's local SQLite store (`~/.local/share/opencode/opencode.db`)
//! read-only and returns sessions normalized to the shape the TS `opencode`
//! session-import adapter expects (see
//! `lib/session-import/adapters/opencode-db.ts`). Desktop-only; the frontend
//! calls this through `readOpencodeSessions`.
//!
//! The upstream schema (session / message / part tables, with a polymorphic
//! `data` JSON column) has shifted across OpenCode versions, so the reader is
//! deliberately schema-tolerant: it reads every column of each table, folds any
//! `data` JSON blob into the row map, and looks up fields under several possible
//! key spellings (`sessionID` / `session_id`, `messageID` / `message_id`).

use rusqlite::{types::ValueRef, Connection, OpenFlags};
use serde_json::{json, Map, Value};
use std::path::Path;
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionHistoryFsOperation {
    ReadText,
    ReadDir,
    Stat,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHistoryDirEntry {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_file: Option<bool>,
}

fn history_dir_entry(
    name: std::ffi::OsString,
    kind: Option<std::fs::FileType>,
) -> Option<SessionHistoryDirEntry> {
    Some(SessionHistoryDirEntry {
        name: name.into_string().ok()?,
        is_file: kind
            .filter(|kind| !kind.is_symlink())
            .map(|kind| kind.is_file()),
    })
}

#[derive(Debug, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SessionHistoryFsResult {
    Text {
        content: String,
    },
    Directory {
        entries: Vec<SessionHistoryDirEntry>,
    },
    Stat {
        exists: bool,
        size: u64,
        #[serde(rename = "isFile")]
        is_file: bool,
    },
}

/// Choose the lexical vendor history root before filesystem work. Both roots
/// and path must be absolute; roots are supplied by native code, never IPC.
fn confined_history_path(path: &Path, roots: &[PathBuf]) -> Result<Option<PathBuf>, String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err("history path must be absolute and contain no parent traversal".into());
    }
    let root = roots
        .iter()
        .filter(|root| root.is_absolute() && path.starts_with(root))
        .max_by_key(|root| root.components().count())
        .ok_or_else(|| "path is outside the native session-history roots".to_string())?;
    let canonical_root = match root.canonicalize() {
        Ok(root) => root,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("resolve history root: {error}")),
    };
    let mut existing = path;
    loop {
        match existing.canonicalize() {
            Ok(canonical) => {
                if !canonical.starts_with(&canonical_root) {
                    return Err("history path escapes its native root through a symlink".into());
                }
                return Ok((existing == path).then_some(canonical));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                existing = existing
                    .parent()
                    .ok_or_else(|| "history path has no existing ancestor".to_string())?;
            }
            Err(error) => return Err(format!("resolve history path: {error}")),
        }
    }
}

/// Read-only filesystem surface for history adapters. Unlike global plugin-fs
/// scope grants, this does not authorize writes or unrelated credential trees.
pub fn session_history_fs(
    operation: SessionHistoryFsOperation,
    path: &Path,
    trusted_roots: &[PathBuf],
) -> Result<SessionHistoryFsResult, String> {
    let resolved = confined_history_path(path, trusted_roots)?;
    if matches!(operation, SessionHistoryFsOperation::Stat) && resolved.is_none() {
        return Ok(SessionHistoryFsResult::Stat {
            exists: false,
            size: 0,
            is_file: false,
        });
    }
    let resolved = resolved.ok_or_else(|| "history path does not exist".to_string())?;
    match operation {
        SessionHistoryFsOperation::ReadText => {
            let extension = path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or_default();
            if !["json", "jsonl", "md"]
                .iter()
                .any(|allowed| extension.eq_ignore_ascii_case(allowed))
            {
                return Err("unsupported history text extension".into());
            }
            if !std::fs::metadata(&resolved)
                .map_err(|error| format!("stat history text: {error}"))?
                .is_file()
            {
                return Err("history text must be a regular file".into());
            }
            std::fs::read_to_string(resolved)
                .map(|content| SessionHistoryFsResult::Text { content })
                .map_err(|error| format!("read history text: {error}"))
        }
        SessionHistoryFsOperation::ReadDir => {
            let mut entries = Vec::new();
            for entry in std::fs::read_dir(resolved)
                .map_err(|error| format!("read history directory: {error}"))?
            {
                let Ok(entry) = entry else { continue };
                if let Some(entry) = history_dir_entry(entry.file_name(), entry.file_type().ok()) {
                    entries.push(entry);
                }
            }
            Ok(SessionHistoryFsResult::Directory { entries })
        }
        SessionHistoryFsOperation::Stat => match std::fs::metadata(resolved) {
            Ok(metadata) => Ok(SessionHistoryFsResult::Stat {
                exists: true,
                size: metadata.len(),
                is_file: metadata.is_file(),
            }),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(SessionHistoryFsResult::Stat {
                    exists: false,
                    size: 0,
                    is_file: false,
                })
            }
            Err(error) => Err(format!("stat history path: {error}")),
        },
    }
}

/// Candidate on-disk locations for `opencode.db`, most-specific first, with
/// duplicates removed (the platform data dir often *is* one of the others).
///
/// Order: `$XDG_DATA_HOME` → the XDG-style home path OpenCode currently uses
/// on every OS → the platform data dir (`%APPDATA%` on Windows,
/// `~/Library/Application Support` on macOS) → the historic Roaming probe.
fn candidate_db_paths(home: &str) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut push = |p: PathBuf| {
        if !out.contains(&p) {
            out.push(p);
        }
    };
    if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
        if !xdg.is_empty() {
            push(PathBuf::from(xdg).join("opencode").join("opencode.db"));
        }
    }
    let home_path = PathBuf::from(home);
    // OpenCode currently uses this XDG-style path on every observed platform,
    // including macOS. Keep it ahead of the generic platform data directory so
    // a stale fallback database cannot shadow the active store.
    push(
        home_path
            .join(".local")
            .join("share")
            .join("opencode")
            .join("opencode.db"),
    );
    // Platform data dir — this is what makes the Windows probe correct rather
    // than a guess: `dirs::data_dir()` resolves `%APPDATA%` from the real
    // environment instead of assuming `<home>\AppData\Roaming`.
    if let Some(data) = dirs::data_dir() {
        push(data.join("opencode").join("opencode.db"));
    }
    // Historic Roaming probe, kept for hosts where `dirs::data_dir()` is
    // unavailable. The opencode CLI (Bun) has been observed using the
    // XDG-style `~/.local/share/opencode/` even on Windows (see
    // subscription/opencode/discovery.rs).
    push(
        home_path
            .join("AppData")
            .join("Roaming")
            .join("opencode")
            .join("opencode.db"),
    );
    out
}

fn value_ref_to_json(v: ValueRef<'_>) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => json!(i),
        ValueRef::Real(f) => json!(f),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).to_string()),
        ValueRef::Blob(_) => Value::Null,
    }
}

fn first_str<'a>(map: &'a Map<String, Value>, keys: &[&str]) -> Option<&'a str> {
    for k in keys {
        if let Some(Value::String(s)) = map.get(*k) {
            return Some(s.as_str());
        }
    }
    None
}

fn nested_num(map: &Map<String, Value>, obj: &str, key: &str, flat: &[&str]) -> i64 {
    if let Some(Value::Object(o)) = map.get(obj) {
        if let Some(v) = o.get(key).and_then(|v| v.as_i64()) {
            return v;
        }
    }
    for k in flat {
        if let Some(v) = map.get(*k).and_then(|v| v.as_i64()) {
            return v;
        }
    }
    0
}

/// Project an assistant message's `tokens` block into the normalized shape the
/// TS `OpencodeTokens` expects. Returns `None` when the turn carries no counts.
fn message_tokens(map: &Map<String, Value>) -> Option<Value> {
    let obj = map.get("tokens").and_then(|t| t.as_object())?;
    let cache = obj.get("cache").and_then(|c| c.as_object());
    let input = obj.get("input").and_then(|v| v.as_i64()).unwrap_or(0);
    let output = obj.get("output").and_then(|v| v.as_i64()).unwrap_or(0);
    // Reasoning tokens are billed as output-side usage; dropping them
    // undercounts thinking-heavy models (the live adapter counts them too).
    let reasoning = obj.get("reasoning").and_then(|v| v.as_i64()).unwrap_or(0);
    let cache_read = cache
        .and_then(|c| c.get("read"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let cache_write = cache
        .and_then(|c| c.get("write"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    if input == 0 && output == 0 && reasoning == 0 && cache_read == 0 && cache_write == 0 {
        return None;
    }
    Some(json!({
        "input": input,
        "output": output,
        "reasoning": reasoning,
        "cacheRead": cache_read,
        "cacheWrite": cache_write,
    }))
}

fn find_table(tables: &[String], want: &str) -> Option<String> {
    // Exact, then singular/plural, then contains.
    tables
        .iter()
        .find(|t| t.eq_ignore_ascii_case(want))
        .or_else(|| {
            tables
                .iter()
                .find(|t| t.eq_ignore_ascii_case(&format!("{want}s")))
        })
        .or_else(|| {
            tables.iter().find(|t| {
                let l = t.to_lowercase();
                l.contains(want) && !l.contains("message") && !l.contains("part") || l == want
            })
        })
        .cloned()
}

fn build_sessions(conn: &Connection) -> Result<Vec<Value>, String> {
    let tables = table_names_checked(conn)
        .map_err(|error| format!("opencode table discovery failed: {error}"))?;
    let session_tbl = find_table(&tables, "session");
    let message_tbl = tables
        .iter()
        .find(|t| t.to_lowercase().contains("message"))
        .cloned();
    let part_tbl = tables
        .iter()
        .find(|t| t.to_lowercase() == "part" || t.to_lowercase().contains("part"))
        .cloned();
    let job_tbl = tables
        .iter()
        .find(|t| {
            let name = t.to_lowercase();
            name == "job" || name == "jobs" || name.contains("background_job")
        })
        .cloned();

    // Missing optional tables are valid across upstream schema generations;
    // an existing table that cannot be read must never masquerade as empty.
    let read_table = |table: Option<&str>| -> Result<Vec<Map<String, Value>>, String> {
        match table {
            Some(table) => rows_as_maps_checked(conn, table)
                .map_err(|error| format!("opencode table {table} read failed: {error}")),
            None => Ok(Vec::new()),
        }
    };
    let sessions = read_table(session_tbl.as_deref())?;
    let messages = read_table(message_tbl.as_deref())?;
    let parts = read_table(part_tbl.as_deref())?;
    let jobs = read_table(job_tbl.as_deref())?;

    let mut jobs_by_session: std::collections::HashMap<String, Vec<Value>> =
        std::collections::HashMap::new();
    for job in &jobs {
        let Some(session_id) = first_str(job, &["sessionID", "session_id", "sessionId"]) else {
            continue;
        };
        let Some(id) = first_str(job, &["id", "jobID", "job_id"]) else {
            continue;
        };
        let created = nested_num(job, "time", "created", &["created", "time_created"]);
        let updated = nested_num(job, "time", "updated", &["updated", "time_updated"]);
        jobs_by_session
            .entry(session_id.to_string())
            .or_default()
            .push(json!({
                "id": id,
                "status": first_str(job, &["status", "state"]),
                "description": first_str(job, &["description", "title", "name"]),
                "parentId": first_str(job, &["parentID", "parent_id", "parentId"]),
                "dependencies": job.get("dependencies").or_else(|| job.get("blockedBy")),
                "createdAt": created,
                "updatedAt": updated,
                "error": first_str(job, &["error", "errorText"]),
            }));
    }

    // Group parts by message id. `SELECT *` gives table-scan order, which is
    // not guaranteed to match creation order — sort by part id (OpenCode ids
    // are lexicographically ordered ULIDs) for a deterministic transcript.
    let mut parts_by_msg: std::collections::HashMap<String, Vec<(String, Value)>> =
        std::collections::HashMap::new();
    for p in parts {
        let mid = match first_str(&p, &["messageID", "message_id", "messageId"]) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let pid = first_str(&p, &["id"]).unwrap_or("").to_string();
        parts_by_msg
            .entry(mid)
            .or_default()
            .push((pid, Value::Object(p)));
    }
    for list in parts_by_msg.values_mut() {
        list.sort_by(|a, b| a.0.cmp(&b.0));
    }

    // Group messages by session id, carrying their parts.
    let mut msgs_by_session: std::collections::HashMap<String, Vec<Value>> =
        std::collections::HashMap::new();
    // Most stores have unique IDs. Move each group on its final use instead
    // of cloning every payload; older schemas may contain duplicate IDs, so
    // earlier occurrences still receive the same complete group as before.
    let last_message_use: std::collections::HashMap<&str, usize> = messages
        .iter()
        .enumerate()
        .filter_map(|(index, message)| {
            first_str(message, &["sessionID", "session_id", "sessionId"])?;
            Some((first_str(message, &["id"]).unwrap_or(""), index))
        })
        .collect();
    for (index, m) in messages.iter().enumerate() {
        let sid = match first_str(m, &["sessionID", "session_id", "sessionId"]) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let mid = first_str(m, &["id"]).unwrap_or("").to_string();
        let role = first_str(m, &["role"]).unwrap_or("user").to_string();
        let created = nested_num(m, "time", "created", &["created", "time_created"]);
        let part_values: Vec<Value> = if last_message_use.get(mid.as_str()) == Some(&index) {
            parts_by_msg
                .remove(&mid)
                .map(|list| list.into_iter().map(|(_, value)| value).collect())
                .unwrap_or_default()
        } else {
            parts_by_msg
                .get(&mid)
                .map(|list| list.iter().map(|(_, value)| value.clone()).collect())
                .unwrap_or_default()
        };
        let mut msg = json!({
            "role": role,
            "createdAt": created,
            "parts": [],
        });
        msg["parts"] = Value::Array(part_values);
        // Project the per-turn usage the assistant `data` carries so the TS
        // adapter can reconstruct token/cost stats (see opencode.ts).
        if let Some(model) = first_str(m, &["modelID", "model"]) {
            msg["model"] = json!(model);
        }
        if let Some(cost) = m.get("cost").and_then(|v| v.as_f64()) {
            msg["cost"] = json!(cost);
        }
        if let Some(tokens) = message_tokens(m) {
            msg["tokens"] = tokens;
        }
        msgs_by_session.entry(sid).or_default().push(msg);
    }
    // Deterministic in-session order: creation time, independent of table-scan
    // order (serde_json arena preserves push order, so the sort is stable).
    for msgs in msgs_by_session.values_mut() {
        msgs.sort_by_key(|m| m["createdAt"].as_i64().unwrap_or(0));
    }

    let last_session_use: std::collections::HashMap<&str, usize> = sessions
        .iter()
        .enumerate()
        .filter_map(|(index, session)| first_str(session, &["id"]).map(|id| (id, index)))
        .collect();
    let mut out = Vec::with_capacity(sessions.len());
    for (index, s) in sessions.iter().enumerate() {
        let id = match first_str(s, &["id"]) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let title = first_str(s, &["title"])
            .unwrap_or("OpenCode session")
            .to_string();
        let cwd = first_str(s, &["directory", "cwd"]).map(|s| s.to_string());
        let model = first_str(s, &["model"]).map(|s| s.to_string());
        // Subagent (child) sessions carry their parent's id; the TS adapter
        // nests them under the parent instead of listing them as orphans.
        let parent_id = first_str(s, &["parentID", "parent_id", "parentId"]).map(|s| s.to_string());
        let created = nested_num(s, "time", "created", &["created", "time_created"]);
        let updated = nested_num(s, "time", "updated", &["updated", "time_updated"]);
        let (msgs, jobs) = if last_session_use.get(id.as_str()) == Some(&index) {
            (
                msgs_by_session.remove(&id).unwrap_or_default(),
                jobs_by_session.remove(&id).unwrap_or_default(),
            )
        } else {
            (
                msgs_by_session.get(&id).cloned().unwrap_or_default(),
                jobs_by_session.get(&id).cloned().unwrap_or_default(),
            )
        };
        let mut session = json!({
            "id": id,
            "title": title,
            "cwd": cwd,
            "model": model,
            "parentId": parent_id,
            "createdAt": created,
            "updatedAt": if updated != 0 { updated } else { created },
            "messages": [],
            "jobs": [],
        });
        session["messages"] = Value::Array(msgs);
        session["jobs"] = Value::Array(jobs);
        out.push(session);
    }
    Ok(out)
}

/// Read every OpenCode session from the local SQLite store. Returns [] when the
/// DB is absent. Existing unreadable/corrupt databases return an error.
/// The `#[tauri::command]` shell lives in `app_lib` (ADR-0067 Tier C) so this
/// crate stays tauri-free for the headless server; it forwards straight here.
pub fn read_opencode_sessions(home: String) -> Result<Vec<Value>, String> {
    let path = candidate_db_paths(&home).into_iter().find(|p| p.exists());
    let Some(path) = path else {
        return Ok(Vec::new());
    };
    // Read-only so a running OpenCode instance is never disturbed.
    let conn = match Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY) {
        Ok(c) => c,
        Err(e) => return Err(format!("opencode db open failed: {e}")),
    };
    build_sessions(&conn)
        .map_err(|error| format!("opencode db read failed at {}: {error}", path.display()))
}

fn find_named_files(root: &Path, name: &str, max_depth: usize, out: &mut Vec<PathBuf>) {
    if max_depth == 0 || !root.exists() {
        return;
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() && path.file_name().and_then(|value| value.to_str()) == Some(name) {
            out.push(path);
        } else if path.is_dir() {
            find_named_files(&path, name, max_depth - 1, out);
        }
    }
}

fn json_string(value: &Value) -> Option<Value> {
    match value {
        Value::String(raw) => serde_json::from_str(raw).ok(),
        _ => None,
    }
}

fn collect_cursor_sessions(value: &Value, out: &mut Vec<Value>) {
    match value {
        Value::Array(items) => {
            for item in items {
                collect_cursor_sessions(item, out);
            }
        }
        Value::Object(map) => {
            let messages = map
                .get("messages")
                .or_else(|| map.get("conversation"))
                .or_else(|| map.get("bubbles"));
            if let Some(Value::Array(items)) = messages {
                let id = first_str(map, &["sessionId", "conversationId", "composerId", "id"])
                    .unwrap_or("cursor-session");
                let normalized_messages: Vec<Value> = items
                    .iter()
                    .map(|item| {
                        let item_map = item.as_object();
                        let numeric_type = item_map
                            .and_then(|entry| entry.get("type"))
                            .and_then(Value::as_i64);
                        let role = item_map
                            .and_then(|entry| first_str(entry, &["role", "speaker"]))
                            .map(str::to_string)
                            .unwrap_or_else(|| {
                                if numeric_type == Some(1) {
                                    "user".into()
                                } else {
                                    "assistant".into()
                                }
                            });
                        let content = item_map
                            .and_then(|entry| {
                                entry
                                    .get("content")
                                    .or_else(|| entry.get("text"))
                                    .or_else(|| entry.get("message"))
                            })
                            .cloned()
                            .unwrap_or(Value::Null);
                        json!({
                            "id": item_map.and_then(|entry| first_str(entry, &["id", "bubbleId"])),
                            "role": role,
                            "content": content,
                            "toolCalls": item_map.and_then(|entry| entry.get("toolCalls")).cloned(),
                            "timestamp": item_map.and_then(|entry| entry.get("timestamp")).cloned(),
                        })
                    })
                    .collect();
                out.push(json!({
                    "sessionId": id,
                    "title": first_str(map, &["title", "name"]),
                    "cwd": first_str(map, &["cwd", "workspace", "workspaceRoot"]),
                    "parentSessionId": first_str(map, &["parentSessionId", "parentId"]),
                    "kind": first_str(map, &["kind"]),
                    "messages": normalized_messages,
                }));
                return;
            }
            for child in map.values() {
                collect_cursor_sessions(child, out);
            }
        }
        Value::String(_) => {
            if let Some(parsed) = json_string(value) {
                collect_cursor_sessions(&parsed, out);
            }
        }
        _ => {}
    }
}

fn read_cursor_sessions(home: &str) -> Result<Vec<Value>, String> {
    let base = PathBuf::from(home);
    let roots = [
        base.join(".cursor"),
        base.join("Library/Application Support/Cursor/User/workspaceStorage"),
        base.join(".config/Cursor/User/workspaceStorage"),
        base.join("AppData/Roaming/Cursor/User/workspaceStorage"),
    ];
    let mut databases = Vec::new();
    for root in roots {
        find_named_files(&root, "state.vscdb", 4, &mut databases);
    }
    let mut out = Vec::new();
    for path in databases {
        let conn = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|error| format!("cursor db open failed at {}: {error}", path.display()))?;
        let mut stmt = conn
            .prepare(
                "SELECT key, value FROM ItemTable WHERE lower(key) LIKE '%composer%' OR lower(key) LIKE '%chat%'",
            )
            .map_err(|error| {
                format!("cursor db query prepare failed at {}: {error}", path.display())
            })?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|error| format!("cursor db query failed at {}: {error}", path.display()))?;
        for raw in rows {
            let raw = raw.map_err(|error| {
                format!("cursor db row decode failed at {}: {error}", path.display())
            })?;
            if let Ok(value) = serde_json::from_str::<Value>(&raw) {
                collect_cursor_sessions(&value, &mut out);
            }
        }
    }
    Ok(out)
}

fn parse_json_column(map: &mut Map<String, Value>, key: &str) {
    let Some(Value::String(raw)) = map.get(key).cloned() else {
        return;
    };
    if let Ok(value) = serde_json::from_str::<Value>(&raw) {
        map.insert(key.to_string(), value);
    }
}

fn rows_as_maps_checked(
    conn: &Connection,
    table: &str,
) -> Result<Vec<Map<String, Value>>, rusqlite::Error> {
    let sql = format!("SELECT * FROM \"{}\"", table.replace('"', "\"\""));
    let mut stmt = conn.prepare(&sql)?;
    let col_names: Vec<String> = stmt
        .column_names()
        .iter()
        .map(|name| name.to_string())
        .collect();
    let rows = stmt.query_map([], |row| {
        let mut map = Map::new();
        for (index, name) in col_names.iter().enumerate() {
            map.insert(name.clone(), value_ref_to_json(row.get_ref(index)?));
        }
        Ok(map)
    })?;
    let mut out = Vec::new();
    for row in rows {
        let mut map = row?;
        if let Some(Value::String(data)) = map.get("data") {
            if let Ok(Value::Object(inner)) = serde_json::from_str::<Value>(data) {
                for (key, value) in inner {
                    map.entry(key).or_insert(value);
                }
            }
        }
        out.push(map);
    }
    Ok(out)
}

fn table_names_checked(conn: &Connection) -> Result<Vec<String>, rusqlite::Error> {
    let mut stmt = conn.prepare("SELECT name FROM sqlite_master WHERE type='table'")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    rows.collect()
}

fn build_generic_sessions(conn: &Connection, base_dir: &Path) -> Result<Vec<Value>, String> {
    let tables =
        table_names_checked(conn).map_err(|error| format!("table discovery failed: {error}"))?;
    let Some(session_table) = tables
        .iter()
        .find(|name| name.to_lowercase() == "sessions" || name.to_lowercase() == "session")
    else {
        return Err("sessions table not found".into());
    };
    let message_table = tables
        .iter()
        .find(|name| name.to_lowercase().contains("message"));
    let mut messages_by_session: std::collections::HashMap<String, Vec<Value>> =
        std::collections::HashMap::new();
    if let Some(table) = message_table {
        for mut message in rows_as_maps_checked(conn, table)
            .map_err(|error| format!("messages table read failed: {error}"))?
        {
            parse_json_column(&mut message, "content_json");
            parse_json_column(&mut message, "metadata_json");
            let Some(session_id) = first_str(
                &message,
                &[
                    "session_id",
                    "sessionId",
                    "conversation_id",
                    "conversationId",
                ],
            ) else {
                continue;
            };
            messages_by_session
                .entry(session_id.to_string())
                .or_default()
                .push(Value::Object(message));
        }
    }

    let mut out = Vec::new();
    for mut session in rows_as_maps_checked(conn, session_table)
        .map_err(|error| format!("sessions table read failed: {error}"))?
    {
        parse_json_column(&mut session, "metadata_json");
        let id = first_str(
            &session,
            &[
                "session_id",
                "sessionId",
                "conversation_id",
                "conversationId",
                "id",
            ],
        )
        .unwrap_or("")
        .to_string();
        if id.is_empty() {
            continue;
        }
        let mut messages = messages_by_session.remove(&id).unwrap_or_default();
        if messages.is_empty() {
            if let Some(path) = first_str(&session, &["messages_path", "messagesPath"]) {
                let path = PathBuf::from(path);
                let path = if path.is_absolute() {
                    path
                } else {
                    base_dir.join(path)
                };
                if let Ok(raw) = std::fs::read_to_string(path) {
                    if let Ok(Value::Array(items)) = serde_json::from_str::<Value>(&raw) {
                        messages = items;
                    }
                }
            }
        }
        out.push(json!({
            "sessionId": id,
            "title": first_str(&session, &["title", "name"]),
            "cwd": first_str(&session, &["cwd", "workspace_root", "workspaceRoot"]),
            "model": first_str(&session, &["model"]),
            "parentSessionId": first_str(&session, &["parent_session_id", "parentSessionId"]),
            "kind": if session.get("is_subagent").and_then(Value::as_i64) == Some(1) { "subagent" } else { "main" },
            "status": first_str(&session, &["status"]),
            "startedAt": first_str(&session, &["started_at", "startedAt"]),
            "endedAt": first_str(&session, &["ended_at", "endedAt"]),
            "messages": messages,
            "metadata": session,
        }));
    }
    Ok(out)
}

fn read_generic_database(path: &Path) -> Result<Vec<Value>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("database open failed at {}: {error}", path.display()))?;
    build_generic_sessions(&conn, path.parent().unwrap_or_else(|| Path::new("")))
        .map_err(|error| format!("database read failed at {}: {error}", path.display()))
}

fn read_cline_sessions(home: &str) -> Result<Vec<Value>, String> {
    let base = PathBuf::from(home);
    let roots = [
        base.join(".cline"),
        base.join("Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev"),
        base.join(".config/Code/User/globalStorage/saoudrizwan.claude-dev"),
        base.join("AppData/Roaming/Code/User/globalStorage/saoudrizwan.claude-dev"),
    ];
    let mut databases = Vec::new();
    for root in roots {
        find_named_files(&root, "sessions.db", 5, &mut databases);
    }
    let mut out = Vec::new();
    for path in databases {
        out.extend(read_generic_database(&path)?);
    }
    Ok(out)
}

fn read_copilot_sessions(home: &str) -> Result<Vec<Value>, String> {
    read_generic_database(&PathBuf::from(home).join(".copilot/session-store.db"))
}

/// Read a supported external agent's local SQLite store without mutating it.
/// Full file artifacts remain authoritative; this supplies database-only rows.
pub fn read_external_agent_sessions(source: String, home: String) -> Result<Vec<Value>, String> {
    match source.as_str() {
        "cursor" => read_cursor_sessions(&home),
        "cline" => read_cline_sessions(&home),
        "copilot-cli" => read_copilot_sessions(&home),
        _ => Err(format!("unsupported external session source: {source}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn history_fs_reads_complete_text_and_preserves_wire_shapes() {
        let root = TestRoot::new("history-fs");
        let file = root.0.join("long.JSONL");
        let content = "{\"text\":\"long conversation 世界\"}\n".repeat(40_000);
        std::fs::write(&file, &content).unwrap();
        let roots = [root.0.clone()];
        let text = session_history_fs(SessionHistoryFsOperation::ReadText, &file, &roots).unwrap();
        assert_eq!(
            serde_json::to_value(text).unwrap(),
            json!({ "kind": "text", "content": content })
        );
        let stat = session_history_fs(SessionHistoryFsOperation::Stat, &file, &roots).unwrap();
        assert_eq!(
            serde_json::to_value(stat).unwrap(),
            json!({ "kind": "stat", "exists": true, "size": content.len(), "isFile": true })
        );
        let directory =
            session_history_fs(SessionHistoryFsOperation::ReadDir, &root.0, &roots).unwrap();
        assert_eq!(
            serde_json::to_value(directory).unwrap(),
            json!({ "kind": "directory", "entries": [{"name":"long.JSONL", "isFile": true}] })
        );
        assert!(serde_json::from_value::<SessionHistoryFsOperation>(json!("readText")).is_ok());
        assert!(serde_json::from_value::<SessionHistoryFsOperation>(json!("readDir")).is_ok());
        assert!(serde_json::from_value::<SessionHistoryFsOperation>(json!("writeText")).is_err());
    }

    #[test]
    fn history_fs_rejects_outside_paths_traversal_and_unsupported_text() {
        let root = TestRoot::new("history-gate");
        let sessions = root.0.join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        std::fs::write(sessions.join("auth.toml"), "secret").unwrap();
        let roots = [sessions.clone()];
        for path in [
            PathBuf::from("relative.json"),
            root.0.join("auth.json"),
            root.0.join("sessions-backup/a.json"),
            sessions.join("../auth.json"),
        ] {
            assert!(session_history_fs(SessionHistoryFsOperation::Stat, &path, &roots).is_err());
        }
        assert!(session_history_fs(
            SessionHistoryFsOperation::ReadText,
            &sessions.join("auth.toml"),
            &roots
        )
        .is_err());
        assert!(session_history_fs(SessionHistoryFsOperation::Stat, &sessions, &[]).is_err());
    }

    #[test]
    fn history_fs_missing_is_distinct_from_io_errors() {
        let root = TestRoot::new("history-missing");
        let roots = [root.0.clone()];
        let missing = root.0.join("not-installed/deep/file.jsonl");
        assert_eq!(
            serde_json::to_value(
                session_history_fs(SessionHistoryFsOperation::Stat, &missing, &roots).unwrap()
            )
            .unwrap(),
            json!({"kind":"stat", "exists":false, "size":0, "isFile":false})
        );
        assert!(session_history_fs(SessionHistoryFsOperation::ReadText, &missing, &roots).is_err());
        let invalid = root.0.join("invalid.json");
        std::fs::write(&invalid, [0xff, 0xfe]).unwrap();
        assert!(session_history_fs(SessionHistoryFsOperation::ReadText, &invalid, &roots).is_err());
        assert!(session_history_fs(
            SessionHistoryFsOperation::Stat,
            &invalid.join("child"),
            &roots
        )
        .is_err());
        let absent_root = root.0.join("uninstalled");
        assert!(matches!(
            session_history_fs(
                SessionHistoryFsOperation::Stat,
                &absent_root,
                &[absent_root.clone()]
            ),
            Ok(SessionHistoryFsResult::Stat { exists: false, .. })
        ));
    }

    #[cfg(unix)]
    #[test]
    fn history_fs_follows_only_confined_symlinks_and_keeps_directory_type_hints() {
        use std::os::unix::fs::symlink;
        let root = TestRoot::new("history-links");
        let sessions = root.0.join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        std::fs::write(sessions.join("a.json"), "history").unwrap();
        std::fs::write(root.0.join("secret.json"), "private").unwrap();
        symlink(sessions.join("a.json"), sessions.join("inside.json")).unwrap();
        symlink(root.0.join("secret.json"), sessions.join("outside.json")).unwrap();
        symlink(&root.0, sessions.join("outside-dir")).unwrap();
        let roots = [sessions.clone()];
        assert!(matches!(
            session_history_fs(
                SessionHistoryFsOperation::Stat,
                &sessions.join("inside.json"),
                &roots
            ),
            Ok(SessionHistoryFsResult::Stat { is_file: true, .. })
        ));
        assert!(session_history_fs(
            SessionHistoryFsOperation::ReadText,
            &sessions.join("outside.json"),
            &roots
        )
        .is_err());
        assert!(session_history_fs(
            SessionHistoryFsOperation::Stat,
            &sessions.join("outside-dir/missing.json"),
            &roots
        )
        .is_err());
        let listed = serde_json::to_value(
            session_history_fs(SessionHistoryFsOperation::ReadDir, &sessions, &roots).unwrap(),
        )
        .unwrap();
        let link = listed["entries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["name"] == "inside.json")
            .unwrap();
        assert!(link.get("isFile").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn history_directory_entry_conversion_filters_invalid_names_and_unknown_types() {
        use std::os::unix::ffi::OsStringExt;
        let invalid = std::ffi::OsString::from_vec(vec![0xff, b'.', b'j', b's', b'o', b'n']);
        assert!(history_dir_entry(invalid, None).is_none());
        let unknown = history_dir_entry("unknown.jsonl".into(), None).unwrap();
        assert_eq!(unknown.name, "unknown.jsonl");
        assert!(unknown.is_file.is_none());
    }

    // APFS rejects invalid UTF-8 names at creation. The converter is tested
    // above on all Unix hosts; this actual filesystem fixture requires Linux.
    #[cfg(target_os = "linux")]
    #[test]
    fn history_directory_keeps_valid_siblings_of_unrepresentable_names() {
        use std::os::unix::ffi::OsStringExt;
        let root = TestRoot::new("history-invalid-name");
        std::fs::write(root.0.join("valid.jsonl"), "{}").unwrap();
        let invalid = std::ffi::OsString::from_vec(vec![0xff, b'.', b'j', b's', b'o', b'n']);
        std::fs::write(root.0.join(invalid), "{}").unwrap();
        let result = session_history_fs(
            SessionHistoryFsOperation::ReadDir,
            &root.0,
            &[root.0.clone()],
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            json!({ "kind": "directory", "entries": [{"name":"valid.jsonl", "isFile": true}] })
        );
    }

    #[test]
    fn history_text_rejects_directories_before_reading() {
        let root = TestRoot::new("history-nonfile");
        let directory = root.0.join("directory.json");
        std::fs::create_dir(&directory).unwrap();
        let error = session_history_fs(
            SessionHistoryFsOperation::ReadText,
            &directory,
            &[root.0.clone()],
        )
        .unwrap_err();
        assert!(error.contains("regular file"));
    }

    #[cfg(unix)]
    #[test]
    fn history_text_rejects_sockets_before_reading() {
        // macOS's default temp directory plus fixture name exceeds sockaddr_un.
        let path = PathBuf::from("/tmp").join(format!(
            "cognia-hfs-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&path).unwrap();
        let root = TestRoot(path);
        let socket = root.0.join("s.json");
        let _listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
        let error = session_history_fs(
            SessionHistoryFsOperation::ReadText,
            &socket,
            &[root.0.clone()],
        )
        .unwrap_err();
        assert!(error.contains("regular file"));
    }

    struct TestRoot(PathBuf);

    impl TestRoot {
        fn new(label: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "cognia-session-import-{label}-{}-{nonce}",
                std::process::id()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn seed(conn: &Connection) {
        conn.execute_batch(
            r#"
            CREATE TABLE session (id TEXT, title TEXT, data TEXT);
            CREATE TABLE message (id TEXT, session_id TEXT, role TEXT, data TEXT);
            CREATE TABLE part (id TEXT, message_id TEXT, type TEXT, data TEXT);
            CREATE TABLE job (id TEXT, session_id TEXT, status TEXT, data TEXT);
            INSERT INTO session VALUES ('s1', 'Fix bug', '{"directory":"/repo","time":{"created":10,"updated":20}}');
            INSERT INTO session VALUES ('s2', 'Subagent run', '{"parentID":"s1","time":{"created":12,"updated":13}}');
            -- Inserted assistant-first to prove the createdAt sort reorders them.
            INSERT INTO message VALUES ('m2', 's1', 'assistant', '{"time":{"created":15},"modelID":"claude-sonnet","cost":0.02,"tokens":{"input":100,"output":50,"reasoning":30,"cache":{"read":200,"write":10}}}');
            INSERT INTO message VALUES ('m1', 's1', 'user', '{"time":{"created":10}}');
            -- Parts inserted out of id order to prove the id sort reorders them.
            INSERT INTO part VALUES ('p3', 'm2', 'text', '{"type":"text","text":"done"}');
            INSERT INTO part VALUES ('p1', 'm1', 'text', '{"type":"text","text":"hello"}');
            INSERT INTO part VALUES ('p2', 'm2', 'tool', '{"type":"tool","tool":"edit","callID":"c1","state":{"status":"completed","output":"ok"}}');
            INSERT INTO job VALUES ('j1', 's1', 'failed', '{"description":"index repository","blockedBy":["j0"],"error":"process exited"}');
            "#,
        )
        .unwrap();
    }

    /// Manual fixed-workload performance evidence; never a wall-clock CI gate.
    #[test]
    #[ignore]
    fn benchmark_native_opencode_import() {
        let root = TestRoot::new("opencode-benchmark");
        let path = root.0.join("opencode.db");
        let mut writer = Connection::open(&path).unwrap();
        writer
            .execute_batch(
                "CREATE TABLE session (id TEXT, title TEXT, data TEXT);
             CREATE TABLE message (id TEXT, session_id TEXT, role TEXT, data TEXT);
             CREATE TABLE part (id TEXT, message_id TEXT, type TEXT, data TEXT);
             CREATE TABLE job (id TEXT, session_id TEXT, status TEXT, data TEXT);",
            )
            .unwrap();
        let tx = writer.transaction().unwrap();
        let payload = "x".repeat(4096);
        for session in 0..30 {
            let sid = format!("s{session:04}");
            tx.execute("INSERT INTO session VALUES (?1, ?2, ?3)", rusqlite::params![
                sid, format!("History {session}"),
                json!({"time":{"created":session,"updated":session+1},"parentID": if session == 0 { Value::Null } else { json!("s0000") }}).to_string()
            ]).unwrap();
            tx.execute(
                "INSERT INTO job VALUES (?1, ?2, 'failed', ?3)",
                rusqlite::params![
                    format!("j{session}"),
                    sid,
                    json!({"description":"index","error":"interrupted","blockedBy":["j0"]})
                        .to_string()
                ],
            )
            .unwrap();
            for message in (0..80).rev() {
                let mid = format!("m{session:04}-{message:04}");
                tx.execute("INSERT INTO message VALUES (?1, ?2, 'assistant', ?3)", rusqlite::params![
                    mid,sid,json!({"time":{"created":message},"modelID":"fixture-model","cost":0.02,"tokens":{"input":100,"output":50,"reasoning":30,"cache":{"read":200,"write":10}}}).to_string()
                ]).unwrap();
                for part in (0..3).rev() {
                    tx.execute("INSERT INTO part VALUES (?1, ?2, 'tool', ?3)", rusqlite::params![
                        format!("p{session:04}-{message:04}-{part}"),mid,
                        json!({"tool":"read","callID":format!("call-{message}-{part}"),"state":{"status":"completed","input":{"path":"fixture.rs"},"output":payload}}).to_string()
                    ]).unwrap();
                }
            }
        }
        tx.commit().unwrap();
        drop(writer);
        let mut expected = None;
        for sample in 0..13 {
            let started = std::time::Instant::now();
            let reader =
                Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
            let sessions = build_sessions(&reader).unwrap();
            let materialize_ms = started.elapsed().as_secs_f64() * 1000.0;
            let encoded = serde_json::to_vec(&sessions).unwrap();
            let total_ms = started.elapsed().as_secs_f64() * 1000.0;
            let hash = encoded.iter().fold(0xcbf29ce484222325u64, |hash, byte| {
                (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
            });
            let identity = (encoded.len(), hash);
            if let Some(expected) = expected {
                assert_eq!(identity, expected);
            } else {
                expected = Some(identity);
            }
            assert_eq!(sessions.len(), 30);
            assert_eq!(sessions[0]["messages"].as_array().unwrap().len(), 80);
            println!(
                "NATIVE_BENCH {}",
                json!({"sample":sample,"warmup":sample==0,"materialize_ms":materialize_ms,"total_ms":total_ms,"output_bytes":encoded.len(),"fnv1a64":format!("{hash:016x}"),"fixture_bytes":std::fs::metadata(&path).unwrap().len()})
            );
        }
    }

    #[test]
    fn builds_sessions_with_grouped_messages_and_parts() {
        let conn = Connection::open_in_memory().unwrap();
        seed(&conn);
        let sessions = build_sessions(&conn).unwrap();
        assert_eq!(sessions.len(), 2);
        let s = sessions.iter().find(|s| s["id"] == "s1").unwrap();
        assert_eq!(s["title"], "Fix bug");
        assert_eq!(s["cwd"], "/repo");
        assert_eq!(s["createdAt"], 10);
        assert_eq!(s["updatedAt"], 20);
        assert_eq!(s["parentId"], Value::Null);
        let msgs = s["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 2);
        // Messages come back in createdAt order despite reversed insert order.
        assert_eq!(msgs[0]["role"], "user");
        assert_eq!(msgs[1]["role"], "assistant");
        let user = &msgs[0];
        assert_eq!(user["parts"][0]["text"], "hello");
        let asst = &msgs[1];
        // Parts come back in id order (p2 before p3) despite insert order.
        assert_eq!(asst["parts"][0]["tool"], "edit");
        assert_eq!(asst["parts"][1]["text"], "done");
        // The assistant turn's usage is projected in the normalized shape.
        assert_eq!(asst["model"], "claude-sonnet");
        assert_eq!(asst["cost"], 0.02);
        assert_eq!(asst["tokens"]["input"], 100);
        assert_eq!(asst["tokens"]["output"], 50);
        assert_eq!(asst["tokens"]["reasoning"], 30);
        assert_eq!(asst["tokens"]["cacheRead"], 200);
        assert_eq!(asst["tokens"]["cacheWrite"], 10);
        assert_eq!(s["jobs"][0]["id"], "j1");
        assert_eq!(s["jobs"][0]["status"], "failed");
        assert_eq!(s["jobs"][0]["dependencies"][0], "j0");
        // Child (subagent) sessions surface their parent id for nesting.
        let child = sessions.iter().find(|s| s["id"] == "s2").unwrap();
        assert_eq!(child["parentId"], "s1");
    }

    #[test]
    fn duplicate_ids_preserve_complete_groups_and_stable_order() {
        let conn = Connection::open_in_memory().unwrap();
        seed(&conn);
        conn.execute_batch(
            r#"
            INSERT INTO message VALUES ('m2', 's2', 'assistant', '{"time":{"created":15}}');
            INSERT INTO message VALUES ('m2', 's1', 'system', '{"time":{"created":15}}');
            INSERT INTO session SELECT * FROM session WHERE id = 's1';
            -- A row without a session cannot consume the group of an earlier valid row.
            INSERT INTO message VALUES ('m2', NULL, 'assistant', '{}');
            INSERT INTO part VALUES ('p4', 'm2', 'text', '{"type":"ignored-collision","text":"retained","unknown":{"deep":[1,2,3]}}');
            "#,
        ).unwrap();
        let sessions = build_sessions(&conn).unwrap();
        assert_eq!(sessions.len(), 3);
        assert_eq!(sessions[0], sessions[2]);
        let messages = sessions[0]["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[1]["role"], "assistant");
        assert_eq!(messages[2]["role"], "system");
        assert_eq!(messages[1]["parts"], messages[2]["parts"]);
        assert_eq!(messages[1]["parts"], sessions[1]["messages"][0]["parts"]);
        let part = &messages[1]["parts"][2];
        assert_eq!(part["type"], "text");
        assert_eq!(part["unknown"]["deep"], json!([1, 2, 3]));
        assert!(part["data"].as_str().unwrap().contains("ignored-collision"));
        assert_eq!(sessions[0]["jobs"][0]["id"], "j1");
    }

    #[test]
    fn missing_message_ids_retain_shared_parts_for_every_valid_row() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE session (id TEXT);
            CREATE TABLE message (session_id TEXT, role TEXT);
            CREATE TABLE part (message_id TEXT, data TEXT);
            INSERT INTO session VALUES ('s');
            INSERT INTO message VALUES ('s', 'user'), ('s', 'assistant');
            INSERT INTO part VALUES ('', '{"text":"shared fallback"}');
            "#,
        )
        .unwrap();
        let sessions = build_sessions(&conn).unwrap();
        assert_eq!(
            sessions[0]["messages"][0]["parts"],
            sessions[0]["messages"][1]["parts"]
        );
        assert_eq!(
            sessions[0]["messages"][1]["parts"][0]["text"],
            "shared fallback"
        );
    }

    #[test]
    fn readonly_file_import_observes_later_commits_without_modifying_source() {
        let root = TestRoot::new("opencode-freshness");
        let path = root.0.join("opencode.db");
        let writer = Connection::open(&path).unwrap();
        seed(&writer);
        let reader = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let before = std::fs::read(&path).unwrap();
        let first = build_sessions(&reader).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), before);
        writer
            .execute(
                "UPDATE part SET data = ?1 WHERE id = 'p3'",
                [r#"{"text":"new committed content"}"#],
            )
            .unwrap();
        let second = build_sessions(&reader).unwrap();
        assert_eq!(first[0]["messages"][1]["parts"][1]["text"], "done");
        assert_eq!(
            second[0]["messages"][1]["parts"][1]["text"],
            "new committed content"
        );
    }

    #[test]
    fn missing_tables_yield_no_sessions() {
        let conn = Connection::open_in_memory().unwrap();
        assert!(build_sessions(&conn).unwrap().is_empty());
    }

    #[test]
    fn missing_db_returns_empty_not_error() {
        let out = read_opencode_sessions("/nonexistent-home-xyz".into()).unwrap();
        assert!(out.is_empty());
    }

    #[test]
    fn candidate_db_paths_prefer_xdg_then_known_store_then_platform_fallback() {
        let paths = candidate_db_paths("/home/u");
        assert!(!paths.is_empty());
        // The XDG-style home path OpenCode actually uses is always a candidate.
        let known_index = paths
            .iter()
            .position(|p| {
                p.ends_with("opencode/opencode.db") && p.starts_with("/home/u/.local/share")
            })
            .expect("known OpenCode store path");
        // The platform data dir is probed too, so Windows no longer relies on a
        // hand-assembled Roaming path, but it cannot shadow the known store.
        if let Some(data) = dirs::data_dir() {
            let platform_path = data.join("opencode").join("opencode.db");
            let platform_index = paths
                .iter()
                .position(|path| path == &platform_path)
                .expect("platform data store path");
            let explicit_xdg = std::env::var("XDG_DATA_HOME")
                .ok()
                .filter(|path| !path.is_empty())
                .map(|path| PathBuf::from(path).join("opencode").join("opencode.db"));
            if explicit_xdg.as_ref() != Some(&platform_path) {
                assert!(known_index <= platform_index);
            }
        }
    }

    #[test]
    fn opencode_missing_optional_tables_remain_compatible() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE session(id TEXT, title TEXT); INSERT INTO session VALUES ('s', 'Kept');",
        )
        .unwrap();
        let sessions = build_sessions(&conn).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0]["messages"], json!([]));
        assert_eq!(sessions[0]["jobs"], json!([]));
    }

    #[test]
    fn opencode_reports_schema_read_failure_instead_of_empty_history() {
        let root = TestRoot::new("opencode-corrupt-schema");
        let path = root.0.join("opencode.db");
        std::fs::write(&path, b"not a sqlite database").unwrap();
        let reader = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let error = build_sessions(&reader).unwrap_err();
        assert!(error.contains("table discovery failed"), "{error}");
    }

    #[test]
    fn opencode_reports_existing_table_read_failure_instead_of_partial_history() {
        use std::io::{Seek, SeekFrom, Write};
        let root = TestRoot::new("opencode-corrupt-message");
        let path = root.0.join("opencode.db");
        let writer = Connection::open(&path).unwrap();
        seed(&writer);
        drop(writer);
        let reader = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let page: u64 = reader
            .query_row(
                "SELECT rootpage FROM sqlite_master WHERE name='message'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let page_size: u64 = reader
            .query_row("PRAGMA page_size", [], |row| row.get(0))
            .unwrap();
        // Damage only this private fixture's message B-tree after schema discovery.
        // Schema listing still works, but reading the existing table must fail.
        let mut file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.seek(SeekFrom::Start((page - 1) * page_size)).unwrap();
        file.write_all(&[0]).unwrap();
        file.flush().unwrap();
        drop(file);
        let error = build_sessions(&reader).unwrap_err();
        assert!(error.contains("table message read failed"), "{error}");
    }

    #[test]
    fn candidate_db_paths_are_deduped() {
        let paths = candidate_db_paths("/home/u");
        let mut seen = std::collections::HashSet::new();
        for p in &paths {
            assert!(seen.insert(p.clone()), "duplicate candidate: {:?}", p);
        }
    }

    #[test]
    fn generic_session_store_preserves_parent_lifecycle_and_messages() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE sessions (
                session_id TEXT, title TEXT, cwd TEXT, parent_session_id TEXT,
                is_subagent INTEGER, status TEXT, started_at TEXT, ended_at TEXT
            );
            CREATE TABLE messages (id TEXT, session_id TEXT, role TEXT, content TEXT);
            INSERT INTO sessions VALUES ('child', 'Research', '/repo', 'root', 1, 'failed', '2026-08-29T00:00:00Z', '2026-08-29T00:01:00Z');
            INSERT INTO messages VALUES ('m1', 'child', 'user', 'inspect');
            "#,
        )
        .unwrap();
        let sessions = build_generic_sessions(&conn, Path::new("/tmp")).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0]["sessionId"], "child");
        assert_eq!(sessions[0]["parentSessionId"], "root");
        assert_eq!(sessions[0]["kind"], "subagent");
        assert_eq!(sessions[0]["status"], "failed");
        assert_eq!(sessions[0]["messages"][0]["content"], "inspect");
    }

    #[test]
    fn cursor_projection_finds_nested_composer_conversations() {
        let value = json!({
            "composerData": {
                "composerId": "cursor-1",
                "name": "Fix parser",
                "bubbles": [
                    { "bubbleId": "u1", "type": 1, "text": "fix it" },
                    { "bubbleId": "a1", "type": 2, "text": "done" }
                ]
            }
        });
        let mut sessions = Vec::new();
        collect_cursor_sessions(&value, &mut sessions);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0]["sessionId"], "cursor-1");
        assert_eq!(sessions[0]["messages"][0]["role"], "user");
        assert_eq!(sessions[0]["messages"][1]["role"], "assistant");
    }

    #[test]
    fn cursor_projection_traverses_encoded_json_once() {
        let conversation = json!({
            "composerId": "cursor-encoded",
            "bubbles": [{ "bubbleId": "u1", "type": 1, "text": "inspect" }]
        });
        let value = json!({ "encoded": serde_json::to_string(&conversation).unwrap() });
        let mut sessions = Vec::new();
        collect_cursor_sessions(&value, &mut sessions);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0]["sessionId"], "cursor-encoded");
    }

    #[test]
    fn public_cursor_reader_reads_sqlite_fixture() {
        let root = TestRoot::new("cursor");
        let db_path = root.0.join(".cursor/workspace/state.vscdb");
        std::fs::create_dir_all(db_path.parent().unwrap()).unwrap();
        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE ItemTable (key TEXT, value TEXT);
            INSERT INTO ItemTable VALUES (
                'composer.chat',
                '{"composerId":"cursor-db","bubbles":[{"bubbleId":"u1","type":1,"text":"hello"}]}'
            );
            "#,
        )
        .unwrap();
        drop(conn);

        let sessions =
            read_external_agent_sessions("cursor".into(), root.0.to_string_lossy().into_owned())
                .unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0]["sessionId"], "cursor-db");
    }

    #[test]
    fn cursor_reader_keeps_rows_beyond_the_former_2000_row_limit() {
        let root = TestRoot::new("cursor-many-rows");
        let path = root.0.join(".cursor/state.vscdb");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut writer = Connection::open(&path).unwrap();
        writer
            .execute_batch("CREATE TABLE ItemTable (key TEXT, value TEXT);")
            .unwrap();
        let tx = writer.transaction().unwrap();
        for index in 0..2_005 {
            let data = json!({"composerId": format!("conversation-{index}"), "bubbles": [{"bubbleId":"u", "type":1, "text":"retained"}]});
            tx.execute(
                "INSERT INTO ItemTable VALUES (?1, ?2)",
                rusqlite::params![format!("composer-{index}"), data.to_string()],
            )
            .unwrap();
        }
        tx.commit().unwrap();
        drop(writer);
        let sessions = read_cursor_sessions(&root.0.to_string_lossy()).unwrap();
        assert_eq!(sessions.len(), 2_005);
        assert!(sessions
            .iter()
            .any(|session| session["sessionId"] == "conversation-2004"));
    }

    #[test]
    fn cursor_reader_keeps_databases_beyond_the_former_200_database_limit() {
        let root = TestRoot::new("cursor-many-databases");
        let template = root.0.join("template.db");
        let writer = Connection::open(&template).unwrap();
        writer.execute_batch(r#"CREATE TABLE ItemTable (key TEXT, value TEXT);
            INSERT INTO ItemTable VALUES ('composer', '{"composerId":"retained","bubbles":[{"type":1,"text":"retained"}]}');"#).unwrap();
        drop(writer);
        for index in 0..201 {
            let path = root
                .0
                .join(format!(".cursor/workspace-{index:03}/state.vscdb"));
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::copy(&template, path).unwrap();
        }
        let sessions = read_cursor_sessions(&root.0.to_string_lossy()).unwrap();
        assert_eq!(sessions.len(), 201);
    }

    #[test]
    fn public_cline_reader_reads_sqlite_fixture() {
        let root = TestRoot::new("cline");
        let db_path = root.0.join(".cline/storage/sessions.db");
        std::fs::create_dir_all(db_path.parent().unwrap()).unwrap();
        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE sessions (session_id TEXT, title TEXT, cwd TEXT);
            CREATE TABLE messages (id TEXT, session_id TEXT, role TEXT, content TEXT);
            INSERT INTO sessions VALUES ('cline-db', 'Cline task', '/repo');
            INSERT INTO messages VALUES ('m1', 'cline-db', 'user', 'hello');
            "#,
        )
        .unwrap();
        drop(conn);

        let sessions =
            read_external_agent_sessions("cline".into(), root.0.to_string_lossy().into_owned())
                .unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0]["sessionId"], "cline-db");
    }

    #[test]
    fn public_copilot_reader_reads_sqlite_fixture() {
        let root = TestRoot::new("copilot");
        let db_path = root.0.join(".copilot/session-store.db");
        std::fs::create_dir_all(db_path.parent().unwrap()).unwrap();
        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE sessions (session_id TEXT, title TEXT, status TEXT);
            INSERT INTO sessions VALUES ('copilot-db', 'Copilot task', 'completed');
            "#,
        )
        .unwrap();
        drop(conn);

        let sessions = read_external_agent_sessions(
            "copilot-cli".into(),
            root.0.to_string_lossy().into_owned(),
        )
        .unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0]["sessionId"], "copilot-db");
    }

    #[test]
    fn public_readers_report_corrupt_and_changed_schema_databases() {
        let cursor_root = TestRoot::new("cursor-corrupt");
        let cursor_db = cursor_root.0.join(".cursor/state.vscdb");
        std::fs::create_dir_all(cursor_db.parent().unwrap()).unwrap();
        std::fs::write(&cursor_db, b"not sqlite").unwrap();
        let cursor_error = read_external_agent_sessions(
            "cursor".into(),
            cursor_root.0.to_string_lossy().into_owned(),
        )
        .unwrap_err();
        assert!(cursor_error.contains("state.vscdb"));

        let cline_root = TestRoot::new("cline-schema");
        let cline_db = cline_root.0.join(".cline/sessions.db");
        std::fs::create_dir_all(cline_db.parent().unwrap()).unwrap();
        let conn = Connection::open(&cline_db).unwrap();
        conn.execute_batch("CREATE TABLE unexpected (id TEXT);")
            .unwrap();
        drop(conn);
        let cline_error = read_external_agent_sessions(
            "cline".into(),
            cline_root.0.to_string_lossy().into_owned(),
        )
        .unwrap_err();
        assert!(cline_error.contains("sessions table not found"));
    }

    #[test]
    fn external_store_reader_rejects_unregistered_sources() {
        let result = read_external_agent_sessions("unknown".into(), "/tmp".into());
        assert!(result.is_err());
    }
}

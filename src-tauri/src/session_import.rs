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
use std::path::PathBuf;

/// Candidate on-disk locations for `opencode.db`, most-specific first.
fn candidate_db_paths(home: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
        if !xdg.is_empty() {
            out.push(PathBuf::from(xdg).join("opencode").join("opencode.db"));
        }
    }
    let home_path = PathBuf::from(home);
    out.push(
        home_path
            .join(".local")
            .join("share")
            .join("opencode")
            .join("opencode.db"),
    );
    // Windows-style location as a fallback.
    out.push(
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

/// Read every row of `table` as a flat JSON map, folding a `data` JSON column
/// (if present) into the top-level keys. Returns [] when the table is absent.
fn rows_as_maps(conn: &Connection, table: &str) -> Vec<Map<String, Value>> {
    let sql = format!("SELECT * FROM \"{table}\"");
    let mut stmt = match conn.prepare(&sql) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let col_names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let rows = stmt.query_map([], |row| {
        let mut map = Map::new();
        for (i, name) in col_names.iter().enumerate() {
            let val = row.get_ref(i).map(value_ref_to_json).unwrap_or(Value::Null);
            map.insert(name.clone(), val);
        }
        Ok(map)
    });
    let mut out = Vec::new();
    if let Ok(iter) = rows {
        for row in iter.flatten() {
            let mut map = row;
            // Fold the polymorphic `data` JSON blob into the row.
            if let Some(Value::String(data)) = map.get("data").cloned() {
                if let Ok(Value::Object(inner)) = serde_json::from_str::<Value>(&data) {
                    for (k, v) in inner {
                        map.entry(k).or_insert(v);
                    }
                }
            }
            out.push(map);
        }
    }
    out
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
    let cache_read = cache
        .and_then(|c| c.get("read"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let cache_write = cache
        .and_then(|c| c.get("write"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    if input == 0 && output == 0 && cache_read == 0 && cache_write == 0 {
        return None;
    }
    Some(json!({
        "input": input,
        "output": output,
        "cacheRead": cache_read,
        "cacheWrite": cache_write,
    }))
}

/// The list of table names in the DB (lowercased), for name-tolerant lookup.
fn table_names(conn: &Connection) -> Vec<String> {
    let mut stmt = match conn.prepare("SELECT name FROM sqlite_master WHERE type='table'") {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map([], |r| r.get::<_, String>(0));
    rows.map(|it| it.flatten().collect()).unwrap_or_default()
}

fn find_table(tables: &[String], want: &str) -> Option<String> {
    // Exact, then singular/plural, then contains.
    tables
        .iter()
        .find(|t| t.eq_ignore_ascii_case(want))
        .or_else(|| tables.iter().find(|t| t.eq_ignore_ascii_case(&format!("{want}s"))))
        .or_else(|| {
            tables.iter().find(|t| {
                let l = t.to_lowercase();
                l.contains(want) && !l.contains("message") && !l.contains("part") || l == want
            })
        })
        .cloned()
}

fn build_sessions(conn: &Connection) -> Vec<Value> {
    let tables = table_names(conn);
    let session_tbl = find_table(&tables, "session").unwrap_or_else(|| "session".into());
    let message_tbl = tables
        .iter()
        .find(|t| t.to_lowercase().contains("message"))
        .cloned()
        .unwrap_or_else(|| "message".into());
    let part_tbl = tables
        .iter()
        .find(|t| t.to_lowercase() == "part" || t.to_lowercase().contains("part"))
        .cloned()
        .unwrap_or_else(|| "part".into());

    let sessions = rows_as_maps(conn, &session_tbl);
    let messages = rows_as_maps(conn, &message_tbl);
    let parts = rows_as_maps(conn, &part_tbl);

    // Group parts by message id.
    let mut parts_by_msg: std::collections::HashMap<String, Vec<Value>> =
        std::collections::HashMap::new();
    for p in &parts {
        let mid = match first_str(p, &["messageID", "message_id", "messageId"]) {
            Some(s) => s.to_string(),
            None => continue,
        };
        parts_by_msg
            .entry(mid)
            .or_default()
            .push(Value::Object(p.clone()));
    }

    // Group messages by session id, carrying their parts.
    let mut msgs_by_session: std::collections::HashMap<String, Vec<Value>> =
        std::collections::HashMap::new();
    for m in &messages {
        let sid = match first_str(m, &["sessionID", "session_id", "sessionId"]) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let mid = first_str(m, &["id"]).unwrap_or("").to_string();
        let role = first_str(m, &["role"]).unwrap_or("user").to_string();
        let created = nested_num(m, "time", "created", &["created", "time_created"]);
        let part_values = parts_by_msg.get(&mid).cloned().unwrap_or_default();
        let mut msg = json!({
            "role": role,
            "createdAt": created,
            "parts": part_values,
        });
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

    let mut out = Vec::new();
    for s in &sessions {
        let id = match first_str(s, &["id"]) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let title = first_str(s, &["title"]).unwrap_or("OpenCode session").to_string();
        let cwd = first_str(s, &["directory", "cwd"]).map(|s| s.to_string());
        let model = first_str(s, &["model"]).map(|s| s.to_string());
        let created = nested_num(s, "time", "created", &["created", "time_created"]);
        let updated = nested_num(s, "time", "updated", &["updated", "time_updated"]);
        let msgs = msgs_by_session.get(&id).cloned().unwrap_or_default();
        out.push(json!({
            "id": id,
            "title": title,
            "cwd": cwd,
            "model": model,
            "createdAt": created,
            "updatedAt": if updated != 0 { updated } else { created },
            "messages": msgs,
        }));
    }
    out
}

/// Read every OpenCode session from the local SQLite store. Returns [] when the
/// DB is absent or unreadable (never errors on a missing install).
#[tauri::command]
pub fn opencode_sessions_read(home: String) -> Result<Vec<Value>, String> {
    let path = candidate_db_paths(&home).into_iter().find(|p| p.exists());
    let Some(path) = path else {
        return Ok(Vec::new());
    };
    // Read-only so a running OpenCode instance is never disturbed.
    let conn = match Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY) {
        Ok(c) => c,
        Err(e) => return Err(format!("opencode db open failed: {e}")),
    };
    Ok(build_sessions(&conn))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn seed(conn: &Connection) {
        conn.execute_batch(
            r#"
            CREATE TABLE session (id TEXT, title TEXT, data TEXT);
            CREATE TABLE message (id TEXT, session_id TEXT, role TEXT, data TEXT);
            CREATE TABLE part (id TEXT, message_id TEXT, type TEXT, data TEXT);
            INSERT INTO session VALUES ('s1', 'Fix bug', '{"directory":"/repo","time":{"created":10,"updated":20}}');
            INSERT INTO message VALUES ('m1', 's1', 'user', '{"time":{"created":10}}');
            INSERT INTO message VALUES ('m2', 's1', 'assistant', '{"time":{"created":15},"modelID":"claude-sonnet","cost":0.02,"tokens":{"input":100,"output":50,"cache":{"read":200,"write":10}}}');
            INSERT INTO part VALUES ('p1', 'm1', 'text', '{"type":"text","text":"hello"}');
            INSERT INTO part VALUES ('p2', 'm2', 'tool', '{"type":"tool","tool":"edit","callID":"c1","state":{"status":"completed","output":"ok"}}');
            "#,
        )
        .unwrap();
    }

    #[test]
    fn builds_sessions_with_grouped_messages_and_parts() {
        let conn = Connection::open_in_memory().unwrap();
        seed(&conn);
        let sessions = build_sessions(&conn);
        assert_eq!(sessions.len(), 1);
        let s = &sessions[0];
        assert_eq!(s["id"], "s1");
        assert_eq!(s["title"], "Fix bug");
        assert_eq!(s["cwd"], "/repo");
        assert_eq!(s["createdAt"], 10);
        assert_eq!(s["updatedAt"], 20);
        let msgs = s["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 2);
        // The user message carries its text part.
        let user = msgs.iter().find(|m| m["role"] == "user").unwrap();
        assert_eq!(user["parts"][0]["text"], "hello");
        let asst = msgs.iter().find(|m| m["role"] == "assistant").unwrap();
        assert_eq!(asst["parts"][0]["tool"], "edit");
        // The assistant turn's usage is projected in the normalized shape.
        assert_eq!(asst["model"], "claude-sonnet");
        assert_eq!(asst["cost"], 0.02);
        assert_eq!(asst["tokens"]["input"], 100);
        assert_eq!(asst["tokens"]["output"], 50);
        assert_eq!(asst["tokens"]["cacheRead"], 200);
        assert_eq!(asst["tokens"]["cacheWrite"], 10);
    }

    #[test]
    fn missing_tables_yield_no_sessions() {
        let conn = Connection::open_in_memory().unwrap();
        assert!(build_sessions(&conn).is_empty());
    }

    #[test]
    fn missing_db_returns_empty_not_error() {
        let out = opencode_sessions_read("/nonexistent-home-xyz".into()).unwrap();
        assert!(out.is_empty());
    }
}

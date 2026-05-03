// Read-only access to CCSwitch's SQLite database.
//
// CCSwitch's schema is not pinned by us — we run alongside whichever
// version the user has installed. The functions here are deliberately
// **tolerant**:
//   - missing tables  → empty result, never an error
//   - missing columns → the corresponding field on the returned struct is
//     `None` / empty string
//   - extra columns   → ignored
//
// All connections open with `SQLITE_OPEN_READ_ONLY | SQLITE_OPEN_NO_MUTEX`.
// CCSwitch is the sole writer of this database; cognia-next never writes.

use std::collections::HashSet;
use std::path::Path;

use rusqlite::{Connection, OpenFlags, Row};
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum CcswitchError {
    #[error("database not found at {0}")]
    NotFound(String),
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
}

/// Counts of each table CCSwitch is known to populate. Used by the status
/// banner; missing tables count as `0`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CcswitchCounts {
    pub providers: u64,
    #[serde(rename = "mcpServers")]
    pub mcp_servers: u64,
    pub prompts: u64,
    pub skills: u64,
}

/// One row from the `providers` (or equivalent) table. We map a generous
/// superset of columns CCSwitch is known to use; whichever are present win.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CcswitchProvider {
    pub id: String,
    pub name: String,
    /// "claude" | "codex" | "gemini" | "opencode" | "openclaw" | other
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(rename = "apiKey", skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(rename = "baseUrl", skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Free-form JSON — `sharedConfig` / `extra` / `meta`. Preserved verbatim.
    #[serde(rename = "sharedConfig", skip_serializing_if = "Option::is_none")]
    pub shared_config: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CcswitchMcpServer {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transport: Option<String>,
    /// Full config JSON exactly as CCSwitch stores it. Frontend maps this to
    /// cognia-next's `McpServerDraft` shape.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CcswitchPrompt {
    pub id: String,
    pub name: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CcswitchSkill {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Body of the skill (markdown). Some CCSwitch versions store a path
    /// instead — when both are absent we still emit the row with an empty
    /// content string so the frontend can show "external file" placeholder.
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
}

/// Open the CCSwitch database in read-only mode. Returns `NotFound` if the
/// file does not exist yet (CCSwitch hasn't been launched, or the user
/// hasn't installed it).
pub fn open_readonly(path: &Path) -> Result<Connection, CcswitchError> {
    if !path.exists() {
        return Err(CcswitchError::NotFound(path.to_string_lossy().into_owned()));
    }
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    Ok(Connection::open_with_flags(path, flags)?)
}

/// Return all column names for `table`. Empty when the table does not exist.
fn columns(conn: &Connection, table: &str) -> Result<HashSet<String>, CcswitchError> {
    let sql = format!("PRAGMA table_info({})", quote_ident(table));
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
    let mut out = HashSet::new();
    for r in rows {
        out.insert(r?);
    }
    Ok(out)
}

/// Naive identifier quoting for `PRAGMA table_info(...)`. CCSwitch's table
/// names are simple ASCII identifiers, but we still strip anything weird.
fn quote_ident(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        if ch == '"' {
            out.push('"'); // double-up to escape
            out.push('"');
        } else {
            out.push(ch);
        }
    }
    out.push('"');
    out
}

fn count_table(conn: &Connection, table: &str) -> Result<u64, CcswitchError> {
    let cols = columns(conn, table)?;
    if cols.is_empty() {
        return Ok(0);
    }
    let sql = format!("SELECT COUNT(*) FROM {}", quote_ident(table));
    let n: i64 = conn.query_row(&sql, [], |row| row.get(0))?;
    Ok(n.max(0) as u64)
}

/// Aggregate counts for the status banner. Tables that don't exist contribute 0.
pub fn counts(conn: &Connection) -> Result<CcswitchCounts, CcswitchError> {
    Ok(CcswitchCounts {
        providers: count_first_existing(conn, &["providers", "provider"])?,
        mcp_servers: count_first_existing(conn, &["mcp_servers", "mcpServers"])?,
        prompts: count_first_existing(conn, &["prompts", "prompt"])?,
        skills: count_first_existing(conn, &["skills", "skill"])?,
    })
}

fn count_first_existing(conn: &Connection, candidates: &[&str]) -> Result<u64, CcswitchError> {
    for table in candidates {
        let cols = columns(conn, table)?;
        if !cols.is_empty() {
            return count_table(conn, table);
        }
    }
    Ok(0)
}

/// Fetch a column by any of the given aliases. Returns `None` when none of
/// the aliases are present in the row's column set.
fn pick_str(row: &Row, available: &HashSet<String>, names: &[&str]) -> Option<String> {
    for n in names {
        if available.contains(*n) {
            if let Ok(v) = row.get::<_, Option<String>>(*n) {
                if let Some(s) = v {
                    if !s.is_empty() {
                        return Some(s);
                    }
                }
            }
        }
    }
    None
}

fn pick_json(row: &Row, available: &HashSet<String>, names: &[&str]) -> Option<serde_json::Value> {
    let raw = pick_str(row, available, names)?;
    serde_json::from_str(&raw).ok()
}

/// List providers from whichever table CCSwitch is using. Tolerant: missing
/// table → empty Vec; partial columns → the absent fields are `None`.
pub fn list_providers(conn: &Connection) -> Result<Vec<CcswitchProvider>, CcswitchError> {
    let table = first_existing_table(conn, &["providers", "provider"])?;
    let Some(table) = table else {
        return Ok(Vec::new());
    };
    let cols = columns(conn, &table)?;
    let sql = format!("SELECT * FROM {}", quote_ident(&table));
    let mut stmt = conn.prepare(&sql)?;
    let mapped = stmt.query_map([], |row| {
        let id = pick_str(row, &cols, &["id", "uuid", "key", "name"])
            .unwrap_or_else(|| String::from(""));
        let name = pick_str(row, &cols, &["name", "title", "label", "id"])
            .unwrap_or_else(|| String::from(""));
        Ok(CcswitchProvider {
            id,
            name,
            kind: pick_str(row, &cols, &["kind", "provider", "type", "providerType"]),
            api_key: pick_str(row, &cols, &["api_key", "apiKey", "key"]),
            base_url: pick_str(row, &cols, &["base_url", "baseUrl", "endpoint", "url"]),
            model: pick_str(row, &cols, &["model", "default_model", "defaultModel"]),
            shared_config: pick_json(
                row,
                &cols,
                &["shared_config", "sharedConfig", "config", "extra", "meta"],
            ),
            notes: pick_str(row, &cols, &["notes", "note", "description"]),
        })
    })?;
    let mut out = Vec::new();
    for row in mapped {
        let p = row?;
        // Drop empty rows the schema sniffer happens to produce when no
        // identifier columns exist.
        if p.id.is_empty() && p.name.is_empty() {
            continue;
        }
        out.push(p);
    }
    Ok(out)
}

pub fn list_mcp_servers(conn: &Connection) -> Result<Vec<CcswitchMcpServer>, CcswitchError> {
    let table = first_existing_table(conn, &["mcp_servers", "mcpServers"])?;
    let Some(table) = table else {
        return Ok(Vec::new());
    };
    let cols = columns(conn, &table)?;
    let sql = format!("SELECT * FROM {}", quote_ident(&table));
    let mut stmt = conn.prepare(&sql)?;
    let mapped = stmt.query_map([], |row| {
        let id = pick_str(row, &cols, &["id", "uuid", "key", "name"])
            .unwrap_or_else(|| String::from(""));
        let name = pick_str(row, &cols, &["name", "title", "label", "id"])
            .unwrap_or_else(|| String::from(""));
        Ok(CcswitchMcpServer {
            id,
            name,
            transport: pick_str(row, &cols, &["transport", "type", "kind"]),
            config: pick_json(row, &cols, &["config", "json", "value", "data"]),
            notes: pick_str(row, &cols, &["notes", "description", "note"]),
        })
    })?;
    let mut out = Vec::new();
    for row in mapped {
        let p = row?;
        if p.id.is_empty() && p.name.is_empty() {
            continue;
        }
        out.push(p);
    }
    Ok(out)
}

pub fn list_prompts(conn: &Connection) -> Result<Vec<CcswitchPrompt>, CcswitchError> {
    let table = first_existing_table(conn, &["prompts", "prompt"])?;
    let Some(table) = table else {
        return Ok(Vec::new());
    };
    let cols = columns(conn, &table)?;
    let sql = format!("SELECT * FROM {}", quote_ident(&table));
    let mut stmt = conn.prepare(&sql)?;
    let mapped = stmt.query_map([], |row| {
        let id = pick_str(row, &cols, &["id", "uuid", "key", "name"])
            .unwrap_or_else(|| String::from(""));
        let name = pick_str(row, &cols, &["name", "title", "label", "id"])
            .unwrap_or_else(|| String::from(""));
        let content = pick_str(row, &cols, &["content", "body", "text", "value"])
            .unwrap_or_else(|| String::from(""));
        let tags = pick_str(row, &cols, &["tags", "labels"]).map(|s| {
            // Try JSON first, fall back to comma-split.
            serde_json::from_str::<Vec<String>>(&s)
                .unwrap_or_else(|_| s.split(',').map(|t| t.trim().to_string()).collect())
        });
        Ok(CcswitchPrompt {
            id,
            name,
            content,
            description: pick_str(row, &cols, &["description", "summary", "notes"]),
            tags,
        })
    })?;
    let mut out = Vec::new();
    for row in mapped {
        let p = row?;
        if p.id.is_empty() && p.name.is_empty() {
            continue;
        }
        out.push(p);
    }
    Ok(out)
}

pub fn list_skills(conn: &Connection) -> Result<Vec<CcswitchSkill>, CcswitchError> {
    let table = first_existing_table(conn, &["skills", "skill"])?;
    let Some(table) = table else {
        return Ok(Vec::new());
    };
    let cols = columns(conn, &table)?;
    let sql = format!("SELECT * FROM {}", quote_ident(&table));
    let mut stmt = conn.prepare(&sql)?;
    let mapped = stmt.query_map([], |row| {
        let id = pick_str(row, &cols, &["id", "uuid", "key", "name"])
            .unwrap_or_else(|| String::from(""));
        let name = pick_str(row, &cols, &["name", "title", "label", "id"])
            .unwrap_or_else(|| String::from(""));
        let content = pick_str(row, &cols, &["content", "body", "markdown", "value"])
            .unwrap_or_else(|| String::from(""));
        Ok(CcswitchSkill {
            id,
            name,
            description: pick_str(row, &cols, &["description", "summary", "notes"]),
            content,
            source_path: pick_str(row, &cols, &["source_path", "sourcePath", "path", "file"]),
        })
    })?;
    let mut out = Vec::new();
    for row in mapped {
        let p = row?;
        if p.id.is_empty() && p.name.is_empty() {
            continue;
        }
        out.push(p);
    }
    Ok(out)
}

fn first_existing_table(
    conn: &Connection,
    candidates: &[&str],
) -> Result<Option<String>, CcswitchError> {
    for t in candidates {
        if !columns(conn, t)?.is_empty() {
            return Ok(Some((*t).to_string()));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_inmem() -> Connection {
        Connection::open_in_memory().unwrap()
    }

    fn seed_full(conn: &Connection) {
        conn.execute_batch(
            r#"
            CREATE TABLE providers (
                id TEXT PRIMARY KEY,
                name TEXT,
                kind TEXT,
                apiKey TEXT,
                baseUrl TEXT,
                model TEXT,
                sharedConfig TEXT,
                notes TEXT
            );
            INSERT INTO providers VALUES
                ('p1', 'Anthropic Official', 'claude', 'sk-ant-x', 'https://api.anthropic.com', 'claude-3-opus', '{"x":1}', 'prod'),
                ('p2', 'Kimi K2',           'claude', 'sk-moon',  'https://api.moonshot.cn/anthropic', NULL, NULL, NULL);

            CREATE TABLE mcp_servers (
                id TEXT PRIMARY KEY,
                name TEXT,
                transport TEXT,
                config TEXT,
                notes TEXT
            );
            INSERT INTO mcp_servers VALUES
                ('m1', 'fetch', 'stdio', '{"command":"uvx","args":["mcp-server-fetch"]}', 'web fetch');

            CREATE TABLE prompts (
                id TEXT PRIMARY KEY,
                name TEXT,
                content TEXT,
                description TEXT,
                tags TEXT
            );
            INSERT INTO prompts VALUES
                ('q1', 'Code review',  'review this code', 'gentle review', '["review","code"]'),
                ('q2', 'Quick answer', 'answer briefly',   NULL,             'short, terse');

            CREATE TABLE skills (
                id TEXT PRIMARY KEY,
                name TEXT,
                description TEXT,
                content TEXT,
                source_path TEXT
            );
            INSERT INTO skills VALUES
                ('s1', 'review',       'reviewer skill', '# review\n...', NULL),
                ('s2', 'external-skill', NULL,           '',               '/tmp/external.md');
            "#,
        )
        .unwrap();
    }

    #[test]
    fn open_readonly_rejects_missing_path() {
        let err = open_readonly(Path::new("/no/such/file.db")).unwrap_err();
        assert!(matches!(err, CcswitchError::NotFound(_)));
    }

    #[test]
    fn empty_db_returns_zeros() {
        let conn = open_inmem();
        let c = counts(&conn).unwrap();
        assert_eq!(c.providers, 0);
        assert_eq!(c.mcp_servers, 0);
        assert_eq!(c.prompts, 0);
        assert_eq!(c.skills, 0);
        assert!(list_providers(&conn).unwrap().is_empty());
        assert!(list_mcp_servers(&conn).unwrap().is_empty());
        assert!(list_prompts(&conn).unwrap().is_empty());
        assert!(list_skills(&conn).unwrap().is_empty());
    }

    #[test]
    fn full_db_round_trip() {
        let conn = open_inmem();
        seed_full(&conn);

        let c = counts(&conn).unwrap();
        assert_eq!(c.providers, 2);
        assert_eq!(c.mcp_servers, 1);
        assert_eq!(c.prompts, 2);
        assert_eq!(c.skills, 2);

        let providers = list_providers(&conn).unwrap();
        assert_eq!(providers.len(), 2);
        let p1 = providers.iter().find(|p| p.id == "p1").unwrap();
        assert_eq!(p1.name, "Anthropic Official");
        assert_eq!(p1.kind.as_deref(), Some("claude"));
        assert_eq!(p1.api_key.as_deref(), Some("sk-ant-x"));
        assert_eq!(
            p1.base_url.as_deref(),
            Some("https://api.anthropic.com")
        );
        assert_eq!(p1.model.as_deref(), Some("claude-3-opus"));
        assert_eq!(
            p1.shared_config.as_ref().unwrap()["x"].as_i64(),
            Some(1)
        );
        assert_eq!(p1.notes.as_deref(), Some("prod"));
        let p2 = providers.iter().find(|p| p.id == "p2").unwrap();
        assert!(p2.shared_config.is_none());
        assert!(p2.notes.is_none());

        let mcp = list_mcp_servers(&conn).unwrap();
        assert_eq!(mcp.len(), 1);
        assert_eq!(mcp[0].name, "fetch");
        assert_eq!(mcp[0].transport.as_deref(), Some("stdio"));
        assert_eq!(
            mcp[0].config.as_ref().unwrap()["command"].as_str(),
            Some("uvx")
        );

        let prompts = list_prompts(&conn).unwrap();
        assert_eq!(prompts.len(), 2);
        let q1 = prompts.iter().find(|p| p.id == "q1").unwrap();
        assert_eq!(q1.tags.as_ref().unwrap(), &vec!["review".to_string(), "code".to_string()]);
        let q2 = prompts.iter().find(|p| p.id == "q2").unwrap();
        // Comma-fallback when tags isn't valid JSON.
        assert_eq!(
            q2.tags.as_ref().unwrap(),
            &vec!["short".to_string(), "terse".to_string()]
        );

        let skills = list_skills(&conn).unwrap();
        assert_eq!(skills.len(), 2);
        let s1 = skills.iter().find(|s| s.id == "s1").unwrap();
        assert!(s1.content.starts_with("# review"));
        let s2 = skills.iter().find(|s| s.id == "s2").unwrap();
        assert!(s2.content.is_empty());
        assert_eq!(s2.source_path.as_deref(), Some("/tmp/external.md"));
    }

    #[test]
    fn partial_schema_is_tolerated() {
        let conn = open_inmem();
        // Only `providers` exists, with a minimal column set.
        conn.execute_batch(
            r#"
            CREATE TABLE providers (id TEXT, name TEXT, baseUrl TEXT);
            INSERT INTO providers VALUES ('only', 'Solo', 'https://example.test');
            "#,
        )
        .unwrap();

        let c = counts(&conn).unwrap();
        assert_eq!(c.providers, 1);
        assert_eq!(c.mcp_servers, 0);
        assert_eq!(c.prompts, 0);
        assert_eq!(c.skills, 0);

        let provs = list_providers(&conn).unwrap();
        assert_eq!(provs.len(), 1);
        let only = &provs[0];
        assert_eq!(only.name, "Solo");
        assert_eq!(only.base_url.as_deref(), Some("https://example.test"));
        assert!(only.api_key.is_none());
        assert!(only.kind.is_none());
        assert!(only.model.is_none());
    }

    #[test]
    fn alternate_table_names_are_recognized() {
        let conn = open_inmem();
        // CCSwitch could conceivably use the singular form on some build —
        // the resolver tries each candidate.
        conn.execute_batch(
            r#"
            CREATE TABLE provider (id TEXT, name TEXT);
            INSERT INTO provider VALUES ('a', 'Alpha');
            CREATE TABLE mcpServers (id TEXT, name TEXT);
            INSERT INTO mcpServers VALUES ('b', 'Bravo');
            "#,
        )
        .unwrap();

        let c = counts(&conn).unwrap();
        assert_eq!(c.providers, 1);
        assert_eq!(c.mcp_servers, 1);

        let provs = list_providers(&conn).unwrap();
        assert_eq!(provs.len(), 1);
        assert_eq!(provs[0].name, "Alpha");

        let mcp = list_mcp_servers(&conn).unwrap();
        assert_eq!(mcp.len(), 1);
        assert_eq!(mcp[0].name, "Bravo");
    }

    #[test]
    fn rows_without_identifiers_are_dropped() {
        let conn = open_inmem();
        conn.execute_batch(
            r#"
            CREATE TABLE providers (id TEXT, name TEXT);
            INSERT INTO providers VALUES ('', '');
            INSERT INTO providers VALUES ('valid', 'Valid');
            "#,
        )
        .unwrap();
        let provs = list_providers(&conn).unwrap();
        assert_eq!(provs.len(), 1);
        assert_eq!(provs[0].id, "valid");
    }

    #[test]
    fn quote_ident_escapes_double_quote() {
        // Defense-in-depth on the quoter, even though CCSwitch table names
        // are simple ASCII.
        assert_eq!(quote_ident("plain"), "\"plain\"");
        assert_eq!(quote_ident("a\"b"), "\"a\"\"b\"");
    }
}

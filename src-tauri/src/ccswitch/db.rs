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

const IDENTITY_COLUMNS: &[&str] = &["id", "uuid", "key", "name", "title", "label"];

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
    /// App the prompt belongs to ("claude" | "codex" | …). CCSwitch keys
    /// prompts by (id, app_type), so `id` alone is not unique.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
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
    let Some(table) = first_existing_table(conn, candidates)? else {
        return Ok(0);
    };
    count_table(conn, &table)
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

/// Read a non-empty string field off a JSON object, trying `keys` in order.
fn json_pick(obj: &serde_json::Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|k| {
        obj.get(*k)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
    })
}

/// Extract apiKey/baseUrl/model out of CCSwitch v3's per-app `settings_config`
/// JSON. Shape-driven (not app_type-driven) so unknown app types degrade
/// gracefully; the known shapes are:
///   - `{"env": {...}}`                  → claude / claude-desktop / gemini env vars
///   - `{"auth": {...}, "config": "…"}`  → codex auth.json + config.toml string
///   - `{"options": {...}}`              → opencode provider options
/// Flat columns win — only fields still `None` are filled. Invalid JSON is
/// tolerated and leaves the provider untouched.
fn enrich_from_settings_config(p: &mut CcswitchProvider, raw: &str) {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) else {
        return;
    };

    if let Some(env) = v.get("env").filter(|e| e.is_object()) {
        if p.api_key.is_none() {
            p.api_key = json_pick(
                env,
                &[
                    "ANTHROPIC_AUTH_TOKEN",
                    "ANTHROPIC_API_KEY",
                    "GEMINI_API_KEY",
                    "GOOGLE_API_KEY",
                    "OPENROUTER_API_KEY",
                ],
            );
        }
        if p.base_url.is_none() {
            p.base_url = json_pick(env, &["ANTHROPIC_BASE_URL", "GOOGLE_GEMINI_BASE_URL"]);
        }
        if p.model.is_none() {
            p.model = json_pick(env, &["ANTHROPIC_MODEL", "GEMINI_MODEL"]);
        }
    }

    if let Some(auth) = v.get("auth").filter(|a| a.is_object()) {
        if p.api_key.is_none() {
            p.api_key = json_pick(auth, &["OPENAI_API_KEY"]);
        }
    }
    // Codex stores model/base_url in a config.toml string next to `auth`.
    if let Some(config) = v.get("config").and_then(serde_json::Value::as_str) {
        enrich_from_codex_toml(p, config);
    }

    if let Some(options) = v.get("options").filter(|o| o.is_object()) {
        if p.api_key.is_none() {
            p.api_key = json_pick(options, &["apiKey"]);
        }
        if p.base_url.is_none() {
            p.base_url = json_pick(options, &["baseURL", "baseUrl"]);
        }
    }
}

/// Pull `model` (top-level) and `base_url` (from the `[model_providers.<id>]`
/// table named by `model_provider`, falling back to the first entry) out of a
/// codex config.toml string.
fn enrich_from_codex_toml(p: &mut CcswitchProvider, raw: &str) {
    if p.model.is_some() && p.base_url.is_some() {
        return;
    }
    let Ok(doc) = raw.parse::<toml_edit::DocumentMut>() else {
        return;
    };

    let non_empty = |s: &str| {
        let t = s.trim();
        (!t.is_empty()).then(|| t.to_string())
    };

    if p.model.is_none() {
        p.model = doc
            .get("model")
            .and_then(|i| i.as_str())
            .and_then(non_empty);
    }
    if p.base_url.is_none() {
        let active = doc.get("model_provider").and_then(|i| i.as_str());
        if let Some(providers) = doc.get("model_providers").and_then(|i| i.as_table_like()) {
            let entry = active
                .and_then(|id| providers.get(id))
                .or_else(|| providers.iter().next().map(|(_, item)| item));
            p.base_url = entry
                .and_then(|e| e.as_table_like())
                .and_then(|t| t.get("base_url"))
                .and_then(|i| i.as_str())
                .and_then(non_empty);
        }
    }
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
        let mut provider = CcswitchProvider {
            id,
            name,
            // `app_type` is CCSwitch v3's app column — part of the table's
            // (id, app_type) primary key, so it must surface for consumers
            // to disambiguate duplicate ids.
            kind: pick_str(
                row,
                &cols,
                &[
                    "kind",
                    "app_type",
                    "appType",
                    "app",
                    "provider",
                    "type",
                    "providerType",
                ],
            ),
            api_key: pick_str(row, &cols, &["api_key", "apiKey", "key"]),
            base_url: pick_str(row, &cols, &["base_url", "baseUrl", "endpoint", "url"]),
            model: pick_str(row, &cols, &["model", "default_model", "defaultModel"]),
            shared_config: pick_json(
                row,
                &cols,
                &["shared_config", "sharedConfig", "config", "extra", "meta"],
            ),
            notes: pick_str(row, &cols, &["notes", "note", "description"]),
        };
        // CCSwitch v3 keeps credentials inside the per-app `settings_config`
        // JSON rather than flat columns — fill whatever is still missing.
        if let Some(raw) = pick_str(row, &cols, &["settings_config", "settingsConfig"]) {
            enrich_from_settings_config(&mut provider, &raw);
        }
        Ok(provider)
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
            kind: pick_str(row, &cols, &["kind", "app_type", "appType", "app"]),
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
        let cols = columns(conn, t)?;
        if !cols.is_empty() && has_any_column(&cols, IDENTITY_COLUMNS) {
            return Ok(Some((*t).to_string()));
        }
    }
    Ok(None)
}

fn has_any_column(cols: &HashSet<String>, names: &[&str]) -> bool {
    names.iter().any(|name| cols.contains(*name))
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
        assert_eq!(p1.base_url.as_deref(), Some("https://api.anthropic.com"));
        assert_eq!(p1.model.as_deref(), Some("claude-3-opus"));
        assert_eq!(p1.shared_config.as_ref().unwrap()["x"].as_i64(), Some(1));
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
        assert_eq!(
            q1.tags.as_ref().unwrap(),
            &vec!["review".to_string(), "code".to_string()]
        );
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
    fn unusable_preferred_table_falls_back_to_alias() {
        let conn = open_inmem();
        conn.execute_batch(
            r#"
            CREATE TABLE providers (legacy_payload TEXT);
            INSERT INTO providers VALUES ('noise-1'), ('noise-2');
            CREATE TABLE provider (id TEXT, name TEXT);
            INSERT INTO provider VALUES ('active', 'Active Provider');

            CREATE TABLE mcp_servers (legacy_payload TEXT);
            INSERT INTO mcp_servers VALUES ('noise-1'), ('noise-2');
            CREATE TABLE mcpServers (id TEXT, name TEXT);
            INSERT INTO mcpServers VALUES ('mcp-active', 'Active MCP');

            CREATE TABLE prompts (legacy_payload TEXT);
            INSERT INTO prompts VALUES ('noise-1'), ('noise-2');
            CREATE TABLE prompt (id TEXT, name TEXT, content TEXT);
            INSERT INTO prompt VALUES ('prompt-active', 'Active Prompt', 'body');

            CREATE TABLE skills (legacy_payload TEXT);
            INSERT INTO skills VALUES ('noise-1'), ('noise-2');
            CREATE TABLE skill (id TEXT, name TEXT, content TEXT);
            INSERT INTO skill VALUES ('skill-active', 'Active Skill', '# body');
            "#,
        )
        .unwrap();

        let c = counts(&conn).unwrap();
        assert_eq!(c.providers, 1);
        assert_eq!(c.mcp_servers, 1);
        assert_eq!(c.prompts, 1);
        assert_eq!(c.skills, 1);

        assert_eq!(list_providers(&conn).unwrap()[0].id, "active");
        assert_eq!(list_mcp_servers(&conn).unwrap()[0].id, "mcp-active");
        assert_eq!(list_prompts(&conn).unwrap()[0].id, "prompt-active");
        assert_eq!(list_skills(&conn).unwrap()[0].id, "skill-active");
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
    fn modern_schema_maps_app_type_to_kind() {
        // CCSwitch v3 keys providers/prompts by (id, app_type) — the same id
        // (e.g. "default") repeats across apps. The app column must surface
        // as `kind` so consumers can disambiguate duplicate ids.
        let conn = open_inmem();
        conn.execute_batch(
            r#"
            CREATE TABLE providers (
                id TEXT NOT NULL, app_type TEXT NOT NULL, name TEXT NOT NULL,
                settings_config TEXT NOT NULL,
                PRIMARY KEY (id, app_type)
            );
            INSERT INTO providers VALUES
                ('default', 'claude', 'default', '{}'),
                ('default', 'codex',  'default', '{}');
            CREATE TABLE prompts (
                id TEXT NOT NULL, app_type TEXT NOT NULL, name TEXT NOT NULL, content TEXT NOT NULL,
                PRIMARY KEY (id, app_type)
            );
            INSERT INTO prompts VALUES
                ('default', 'claude', 'Claude Prompt', 'c1'),
                ('default', 'codex',  'Codex Prompt',  'c2');
            "#,
        )
        .unwrap();

        let provs = list_providers(&conn).unwrap();
        assert_eq!(provs.len(), 2);
        let kinds: Vec<_> = provs.iter().filter_map(|p| p.kind.as_deref()).collect();
        assert!(kinds.contains(&"claude"));
        assert!(kinds.contains(&"codex"));

        let prompts = list_prompts(&conn).unwrap();
        assert_eq!(prompts.len(), 2);
        let prompt_kinds: Vec<_> = prompts.iter().filter_map(|p| p.kind.as_deref()).collect();
        assert!(prompt_kinds.contains(&"claude"));
        assert!(prompt_kinds.contains(&"codex"));
    }

    #[test]
    fn settings_config_json_is_extracted_per_app_shape() {
        // CCSwitch v3 stores credentials inside the per-app `settings_config`
        // JSON column instead of flat apiKey/baseUrl/model columns:
        //   claude / claude-desktop / gemini → {"env": {...}}
        //   codex                            → {"auth": {...}, "config": "<TOML>"}
        //   opencode                         → {"options": {...}}
        let conn = open_inmem();
        conn.execute_batch(
            r#"
            CREATE TABLE providers (
                id TEXT NOT NULL, app_type TEXT NOT NULL, name TEXT NOT NULL,
                settings_config TEXT NOT NULL,
                PRIMARY KEY (id, app_type)
            );
            INSERT INTO providers VALUES
                ('c1', 'claude', 'Claude Relay',
                 '{"env":{"ANTHROPIC_AUTH_TOKEN":"sk-ant-relay","ANTHROPIC_BASE_URL":"https://relay.example/anthropic","ANTHROPIC_MODEL":"claude-opus-4-8"}}'),
                ('x1', 'codex', 'Codex Relay',
                 '{"auth":{"OPENAI_API_KEY":"sk-codex"},"config":"model_provider = \"custom\"\nmodel = \"gpt-5.5\"\n\n[model_providers.custom]\nname = \"custom\"\nbase_url = \"https://relay.example/v1\"\n"}'),
                ('g1', 'gemini', 'Gemini Relay',
                 '{"env":{"GEMINI_API_KEY":"sk-gem","GOOGLE_GEMINI_BASE_URL":"https://relay.example/gemini","GEMINI_MODEL":"gemini-3-pro"},"config":{}}'),
                ('o1', 'opencode', 'OpenCode Relay',
                 '{"npm":"@ai-sdk/openai-compatible","options":{"baseURL":"https://relay.example/oc","apiKey":"sk-oc","setCacheKey":true}}'),
                ('e1', 'claude', 'Empty Official', '{"env":{}}'),
                ('b1', 'claude', 'Broken', 'not json');
            "#,
        )
        .unwrap();

        let provs = list_providers(&conn).unwrap();
        assert_eq!(provs.len(), 6);
        let by_id = |id: &str| provs.iter().find(|p| p.id == id).unwrap();

        let c1 = by_id("c1");
        assert_eq!(c1.api_key.as_deref(), Some("sk-ant-relay"));
        assert_eq!(
            c1.base_url.as_deref(),
            Some("https://relay.example/anthropic")
        );
        assert_eq!(c1.model.as_deref(), Some("claude-opus-4-8"));

        let x1 = by_id("x1");
        assert_eq!(x1.api_key.as_deref(), Some("sk-codex"));
        assert_eq!(x1.base_url.as_deref(), Some("https://relay.example/v1"));
        assert_eq!(x1.model.as_deref(), Some("gpt-5.5"));

        let g1 = by_id("g1");
        assert_eq!(g1.api_key.as_deref(), Some("sk-gem"));
        assert_eq!(g1.base_url.as_deref(), Some("https://relay.example/gemini"));
        assert_eq!(g1.model.as_deref(), Some("gemini-3-pro"));

        let o1 = by_id("o1");
        assert_eq!(o1.api_key.as_deref(), Some("sk-oc"));
        assert_eq!(o1.base_url.as_deref(), Some("https://relay.example/oc"));
        assert!(o1.model.is_none());

        // Empty env and invalid JSON degrade to None — never an error.
        let e1 = by_id("e1");
        assert!(e1.api_key.is_none() && e1.base_url.is_none() && e1.model.is_none());
        let b1 = by_id("b1");
        assert!(b1.api_key.is_none() && b1.base_url.is_none() && b1.model.is_none());
    }

    #[test]
    fn flat_columns_take_precedence_over_settings_config() {
        let conn = open_inmem();
        conn.execute_batch(
            r#"
            CREATE TABLE providers (id TEXT, name TEXT, apiKey TEXT, settings_config TEXT);
            INSERT INTO providers VALUES
                ('p1', 'Mixed', 'flat-key',
                 '{"env":{"ANTHROPIC_API_KEY":"json-key","ANTHROPIC_BASE_URL":"https://json.example"}}');
            "#,
        )
        .unwrap();

        let provs = list_providers(&conn).unwrap();
        assert_eq!(provs.len(), 1);
        // Flat column wins; fields the flat schema lacks still fill from JSON.
        assert_eq!(provs[0].api_key.as_deref(), Some("flat-key"));
        assert_eq!(provs[0].base_url.as_deref(), Some("https://json.example"));
    }

    #[test]
    fn quote_ident_escapes_double_quote() {
        // Defense-in-depth on the quoter, even though CCSwitch table names
        // are simple ASCII.
        assert_eq!(quote_ident("plain"), "\"plain\"");
        assert_eq!(quote_ident("a\"b"), "\"a\"\"b\"");
    }
}

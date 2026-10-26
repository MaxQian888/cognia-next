// Read-only CC Switch v4.0.18 interop (SQLite schema 21).
// Exact upstream tables/columns; obsolete schemas fail explicitly.

use std::path::Path;

use rusqlite::{Connection, OpenFlags, Row};
use thiserror::Error;

use crate::provider_config::{enrich_from_settings_config, json_pick};
use crate::skill_files::read_installed_skill;
pub use crate::types::{
    CcswitchCounts, CcswitchMcpServer, CcswitchPrompt, CcswitchProvider, CcswitchSkill,
};

#[derive(Debug, Error)]
pub enum CcswitchError {
    #[error("database not found at {0}")]
    NotFound(String),
    #[error("unsupported CC Switch schema {0}; Cognia requires CC Switch v4.0.18 (schema 21). Upgrade CC Switch before importing.")]
    UnsupportedSchema(i64),
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
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

pub const SUPPORTED_SCHEMA_VERSION: i64 = 21;

fn validate_schema(conn: &Connection) -> Result<(), CcswitchError> {
    let version = conn.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))?;
    if version != SUPPORTED_SCHEMA_VERSION {
        return Err(CcswitchError::UnsupportedSchema(version));
    }
    Ok(())
}

pub fn counts(conn: &Connection) -> Result<CcswitchCounts, CcswitchError> {
    validate_schema(conn)?;
    Ok(conn.query_row("SELECT (SELECT COUNT(*) FROM providers), (SELECT COUNT(*) FROM mcp_servers), (SELECT COUNT(*) FROM prompts), (SELECT COUNT(*) FROM skills)", [], |row| Ok(CcswitchCounts {
        providers: row.get(0)?, mcp_servers: row.get(1)?, prompts: row.get(2)?, skills: row.get(3)?,
    }))?)
}

fn json_column(row: &Row, name: &str) -> rusqlite::Result<serde_json::Value> {
    let raw: String = row.get(name)?;
    serde_json::from_str(&raw).map_err(|err| {
        rusqlite::Error::FromSqlConversionFailure(
            row.as_ref().column_index(name).unwrap_or(0),
            rusqlite::types::Type::Text,
            Box::new(err),
        )
    })
}

/// Read the current upstream schema. Invalid JSON/schema is surfaced, never
/// disguised as an empty installation.
pub fn list_providers(conn: &Connection) -> Result<Vec<CcswitchProvider>, CcswitchError> {
    validate_schema(conn)?;
    let mut stmt = conn.prepare("SELECT id, app_type, name, settings_config, meta, category, notes FROM providers ORDER BY app_type, sort_index, name, id")?;
    let rows = stmt.query_map([], |row| {
        let meta = json_column(row, "meta")?;
        let config = json_column(row, "settings_config")?;
        let mut provider = CcswitchProvider {
            id: row.get("id")?,
            name: row.get("name")?,
            kind: Some(row.get("app_type")?),
            api_key: None,
            base_url: None,
            model: None,
            models: Vec::new(),
            credential_env: None,
            opus_model: None,
            sonnet_model: None,
            haiku_model: None,
            small_fast_model: None,
            custom_headers: None,
            category: row.get("category")?,
            provider_type: json_pick(&meta, &["providerType"]),
            shared_config: Some(meta.clone()),
            usage_script: meta.get("usage_script").cloned(),
            notes: row.get("notes")?,
        };
        enrich_from_settings_config(&mut provider, &config);
        if provider.models.is_empty() {
            provider.models = config
                .get("models")
                .and_then(|models| models.as_array())
                .map(|models| {
                    models
                        .iter()
                        .filter_map(|model| json_pick(model, &["id"]))
                        .collect()
                })
                .unwrap_or_default();
        }
        Ok(provider)
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn list_mcp_servers(conn: &Connection) -> Result<Vec<CcswitchMcpServer>, CcswitchError> {
    validate_schema(conn)?;
    let mut stmt = conn.prepare(
        "SELECT id, name, server_config, description FROM mcp_servers ORDER BY name, id",
    )?;
    let rows = stmt.query_map([], |row| {
        let config = json_column(row, "server_config")?;
        Ok(CcswitchMcpServer {
            id: row.get("id")?,
            name: row.get("name")?,
            transport: json_pick(&config, &["type"]),
            config: Some(config),
            notes: row.get("description")?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn list_prompts(conn: &Connection) -> Result<Vec<CcswitchPrompt>, CcswitchError> {
    validate_schema(conn)?;
    let mut stmt = conn.prepare(
        "SELECT id, app_type, name, content, description FROM prompts ORDER BY app_type, name, id",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(CcswitchPrompt {
            id: row.get("id")?,
            name: row.get("name")?,
            kind: Some(row.get("app_type")?),
            content: row.get("content")?,
            description: row.get("description")?,
            tags: None,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn list_skills(conn: &Connection) -> Result<Vec<CcswitchSkill>, CcswitchError> {
    validate_schema(conn)?;
    let data_dir = conn.path().and_then(|path| Path::new(path).parent());
    let root = crate::paths::ccswitch_skills_root(data_dir);
    list_skills_at_root(conn, root.as_deref())
}

fn list_skills_at_root(
    conn: &Connection,
    root: Option<&Path>,
) -> Result<Vec<CcswitchSkill>, CcswitchError> {
    let mut stmt =
        conn.prepare("SELECT id, name, description, directory FROM skills ORDER BY name, id")?;
    let rows = stmt.query_map([], |row| {
        let mut skill = CcswitchSkill {
            id: row.get("id")?,
            name: row.get("name")?,
            description: row.get("description")?,
            content: String::new(),
            source_path: None,
            resources: Vec::new(),
            openai_yaml: None,
        };
        let directory: String = row.get("directory")?;
        if let Some(files) = root.and_then(|root| read_installed_skill(root, &directory)) {
            skill.content = files.native.content;
            skill.source_path = Some(files.native.file_path);
            skill.resources = files.native.resources;
            skill.openai_yaml = files.openai_yaml;
        }
        Ok(skill)
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

#[cfg(test)]
mod tests {

    use super::*;

    fn current_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("schema-v21.sql")).unwrap();
        conn
    }

    fn provider(conn: &Connection, kind: &str, config: serde_json::Value) {
        conn.execute("INSERT INTO providers (id, app_type, name, settings_config) VALUES ('same', ?1, ?1, ?2)", rusqlite::params![kind, config.to_string()]).unwrap();
    }

    #[test]
    fn current_schema_mcp_reads_server_config() {
        let conn = current_db();
        conn.execute("INSERT INTO mcp_servers (id, name, server_config) VALUES ('m', 'remote', ?1)", [r#"{"type":"http","url":"https://mcp.example.test","headers":{"Authorization":"fixture"}}"#]).unwrap();
        let rows = list_mcp_servers(&conn).unwrap();
        assert_eq!(
            rows[0].config.as_ref().unwrap()["url"],
            "https://mcp.example.test"
        );
        assert_eq!(rows[0].transport.as_deref(), Some("http"));
        assert_eq!(counts(&conn).unwrap().mcp_servers, 1);
    }

    #[test]
    fn current_schema_preserves_composite_provider_and_prompt_ids() {
        let conn = current_db();
        for kind in [
            "claude",
            "claude-desktop",
            "codex",
            "gemini",
            "grokbuild",
            "opencode",
            "openclaw",
            "hermes",
            "pi",
            "mcode",
            "agy",
        ] {
            provider(&conn, kind, serde_json::json!({}));
            conn.execute(
                "INSERT INTO prompts (id, app_type, name, content) VALUES ('same', ?1, ?1, 'body')",
                [kind],
            )
            .unwrap();
        }
        assert_eq!(list_providers(&conn).unwrap().len(), 11);
        assert_eq!(list_prompts(&conn).unwrap().len(), 11);
        assert_eq!(counts(&conn).unwrap().providers, 11);
    }

    #[test]
    fn rejects_obsolete_schema_instead_of_silent_empty_success() {
        let conn = current_db();
        conn.pragma_update(None, "user_version", 20).unwrap();
        assert!(counts(&conn).is_err());
        assert!(list_providers(&conn).is_err());
    }

    #[test]
    fn malformed_current_json_is_an_error() {
        let conn = current_db();
        conn.execute(
            "INSERT INTO mcp_servers (id, name, server_config) VALUES ('m','bad','not-json')",
            [],
        )
        .unwrap();
        assert!(list_mcp_servers(&conn).is_err());
    }

    #[test]
    fn readonly_connection_never_changes_upstream() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cc-switch.db");
        Connection::open(&path)
            .unwrap()
            .execute_batch(include_str!("schema-v21.sql"))
            .unwrap();
        let before = std::fs::read(&path).unwrap();
        let conn = open_readonly(&path).unwrap();
        assert_eq!(counts(&conn).unwrap().providers, 0);
        assert!(conn.execute("DELETE FROM providers", []).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[test]
    fn future_schema_and_missing_tables_are_errors() {
        let conn = current_db();
        conn.pragma_update(None, "user_version", 22).unwrap();
        assert!(matches!(
            counts(&conn),
            Err(CcswitchError::UnsupportedSchema(22))
        ));
        conn.pragma_update(None, "user_version", 21).unwrap();
        conn.execute("DROP TABLE skills", []).unwrap();
        assert!(counts(&conn).is_err());
    }

    #[test]
    #[ignore = "explicit read-only local acceptance; COGNIA_CCSWITCH_AUDIT_DB must name a schema21 snapshot"]
    fn local_snapshot_acceptance() {
        let path = std::env::var("COGNIA_CCSWITCH_AUDIT_DB").expect("explicit fixture path");
        let conn = open_readonly(Path::new(&path)).unwrap();
        let count = counts(&conn).unwrap();
        let providers = list_providers(&conn).unwrap();
        let mcp = list_mcp_servers(&conn).unwrap();
        let prompts = list_prompts(&conn).unwrap();
        let skills = list_skills(&conn).unwrap();
        assert_eq!(providers.len() as u64, count.providers);
        assert_eq!(mcp.len() as u64, count.mcp_servers);
        assert_eq!(prompts.len() as u64, count.prompts);
        assert_eq!(skills.len() as u64, count.skills);
        assert!(mcp.iter().all(|row| row
            .config
            .as_ref()
            .is_some_and(|c| c.get("command").is_some() || c.get("url").is_some())));
        println!(
            "providers={} mcp={} prompts={} skills={} readable_skills={}",
            count.providers,
            count.mcp_servers,
            count.prompts,
            count.skills,
            skills.iter().filter(|s| !s.content.is_empty()).count()
        );
    }
}

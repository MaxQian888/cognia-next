// Tauri commands the frontend uses to read CCSwitch's database.
//
//   ccswitch_status()              -> { dbPath, exists, counts }
//   ccswitch_list_providers()      -> [CcswitchProvider]
//   ccswitch_list_mcp_servers()    -> [CcswitchMcpServer]
//   ccswitch_list_prompts()        -> [CcswitchPrompt]
//   ccswitch_list_skills()         -> [CcswitchSkill]
//
// `status` always returns successfully — it's the probe used by the UI to
// decide whether to render the rest of the section. The list commands fail
// only if the database exists but cannot be opened (corruption, permissions).

use serde::{Deserialize, Serialize};

use super::db::{
    counts, list_mcp_servers as db_list_mcp_servers, list_prompts as db_list_prompts,
    list_providers as db_list_providers, list_skills as db_list_skills, open_readonly,
    CcswitchCounts, CcswitchError, CcswitchMcpServer, CcswitchPrompt, CcswitchProvider,
    CcswitchSkill,
};
use super::paths::ccswitch_db_path;

#[derive(Debug, Serialize, Deserialize)]
pub struct CcswitchStatus {
    /// Resolved DB path on this OS, or null when the home dir can't be found.
    #[serde(rename = "dbPath")]
    pub db_path: Option<String>,
    pub exists: bool,
    /// Counts per known table. Zero when the DB doesn't exist.
    pub counts: CcswitchCounts,
    /// Filled in if the file was present but couldn't be read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[tauri::command]
pub fn ccswitch_status() -> CcswitchStatus {
    let path = ccswitch_db_path();
    let db_path = path.as_ref().map(|p| p.to_string_lossy().into_owned());
    let Some(path) = path else {
        return CcswitchStatus {
            db_path: None,
            exists: false,
            counts: CcswitchCounts::default(),
            error: None,
        };
    };
    if !path.exists() {
        return CcswitchStatus {
            db_path,
            exists: false,
            counts: CcswitchCounts::default(),
            error: None,
        };
    }
    match open_readonly(&path).and_then(|c| counts(&c)) {
        Ok(counts) => CcswitchStatus {
            db_path,
            exists: true,
            counts,
            error: None,
        },
        Err(err) => CcswitchStatus {
            db_path,
            exists: true,
            counts: CcswitchCounts::default(),
            error: Some(format_err(err)),
        },
    }
}

#[tauri::command]
pub fn ccswitch_list_providers() -> Result<Vec<CcswitchProvider>, String> {
    with_conn(|c| db_list_providers(c))
}

#[tauri::command]
pub fn ccswitch_list_mcp_servers() -> Result<Vec<CcswitchMcpServer>, String> {
    with_conn(|c| db_list_mcp_servers(c))
}

#[tauri::command]
pub fn ccswitch_list_prompts() -> Result<Vec<CcswitchPrompt>, String> {
    with_conn(|c| db_list_prompts(c))
}

#[tauri::command]
pub fn ccswitch_list_skills() -> Result<Vec<CcswitchSkill>, String> {
    with_conn(|c| db_list_skills(c))
}

fn with_conn<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce(&rusqlite::Connection) -> Result<T, CcswitchError>,
    T: Default,
{
    let Some(path) = ccswitch_db_path() else {
        return Err("could not resolve home directory".to_string());
    };
    if !path.exists() {
        // The DB hasn't been created yet — return the type's default rather
        // than an error so the UI can render an empty list cleanly. This
        // mirrors the agent commands' "missing file" semantics in agents/io.rs.
        return Ok(T::default());
    }
    let conn = open_readonly(&path).map_err(format_err)?;
    f(&conn).map_err(format_err)
}

fn format_err(err: CcswitchError) -> String {
    err.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_reports_path_even_when_missing() {
        let status = ccswitch_status();
        assert!(status.db_path.is_some());
        // On a CI host without CCSwitch installed this is the expected branch.
        if !status.exists {
            assert_eq!(status.counts.providers, 0);
            assert!(status.error.is_none());
        }
    }
}

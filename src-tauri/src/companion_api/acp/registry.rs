//! ACP session bookkeeping.
//!
//! Two layers:
//!
//! - [`ConnectionSessions`] — owned by one WebSocket connection loop. Tracks
//!   the sessions minted (or loaded) on that connection, each with its cwd,
//!   the parked `session/prompt` JSON-RPC id awaiting turn completion, and
//!   pending permission round-trips.
//! - A process-wide resume index ([`record_resume_info`] /
//!   [`lookup_resume_info`]) mapping ACP session id → the sidecar's own SDK
//!   session id + cwd, so `session/load` works across reconnects (the same
//!   pattern as `ws_terminal::WS_TERMINAL_REGISTRY`).

use std::collections::HashMap;
use std::sync::Mutex;

use serde_json::Value;

use super::translate::TurnState;

// ---------------------------------------------------------------------------
// Per-connection session state
// ---------------------------------------------------------------------------

/// A `session/prompt` request parked until the turn finishes.
#[derive(Debug)]
pub struct PendingPrompt {
    /// JSON-RPC id of the parked `session/prompt` request.
    pub rpc_id: Value,
    /// Set by `session/cancel`; the eventual `result` resolves as `cancelled`.
    pub cancelled: bool,
}

/// One ACP session owned by the current connection.
#[derive(Debug, Default)]
pub struct SessionEntry {
    /// Working directory from `session/new` / `session/load`.
    pub cwd: Option<String>,
    /// Ordered additional workspace roots negotiated for the session.
    pub additional_directories: Vec<String>,
    /// Parked prompt awaiting turn completion (at most one per session).
    pub pending_prompt: Option<PendingPrompt>,
    /// Sidecar SDK session id once observed (drives resume).
    pub sdk_session_id: Option<String>,
    /// Resume target for the *next* prompt (set by `session/load`).
    pub resume_session_id: Option<String>,
    /// Mode id selected via `session/set_mode`, injected as
    /// `SendOptions.permission_mode` on each subsequent prompt.
    pub selected_mode_id: Option<String>,
    /// Model id selected via `session/set_model`, injected as
    /// `SendOptions.model` on each subsequent prompt (the `default` pseudo-id
    /// injects nothing — the account default stands).
    pub selected_model_id: Option<String>,
    /// Per-turn translation dedup state.
    pub turn: TurnState,
    /// True once a prompt has been dispatched on this session (used to decide
    /// whether disconnect cleanup should interrupt the sidecar session).
    pub prompted: bool,
}

/// Sessions owned by one connection, keyed by ACP session id.
#[derive(Debug, Default)]
pub struct ConnectionSessions {
    sessions: HashMap<String, SessionEntry>,
}

impl ConnectionSessions {
    pub fn new() -> Self {
        Self::default()
    }

    /// Mint a new session entry. Returns `false` when the id already exists.
    pub fn insert(&mut self, session_id: &str, entry: SessionEntry) -> bool {
        if self.sessions.contains_key(session_id) {
            return false;
        }
        self.sessions.insert(session_id.to_string(), entry);
        true
    }

    pub fn get_mut(&mut self, session_id: &str) -> Option<&mut SessionEntry> {
        self.sessions.get_mut(session_id)
    }

    pub fn contains(&self, session_id: &str) -> bool {
        self.sessions.contains_key(session_id)
    }

    pub fn remove(&mut self, session_id: &str) -> Option<SessionEntry> {
        self.sessions.remove(session_id)
    }

    /// Session ids that have dispatched at least one prompt (candidates for
    /// interrupt + close on disconnect).
    pub fn prompted_session_ids(&self) -> Vec<String> {
        self.sessions
            .iter()
            .filter(|(_, e)| e.prompted)
            .map(|(id, _)| id.clone())
            .collect()
    }

    /// Iterate all sessions mutably (used to fail pending prompts on close).
    pub fn iter_mut(&mut self) -> impl Iterator<Item = (&String, &mut SessionEntry)> {
        self.sessions.iter_mut()
    }
}

// ---------------------------------------------------------------------------
// Process-wide resume index
// ---------------------------------------------------------------------------

/// Resume metadata surviving a connection drop.
#[derive(Debug, Clone, PartialEq)]
pub struct ResumeInfo {
    pub cwd: Option<String>,
    pub sdk_session_id: Option<String>,
}

/// Cap the resume index so abandoned sessions can't grow it unboundedly.
/// Oldest-insertion eviction is fine at this size — resumes target recent
/// sessions.
const RESUME_INDEX_CAP: usize = 512;

static RESUME_INDEX: once_cell::sync::Lazy<Mutex<Vec<(String, ResumeInfo)>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(Vec::new()));

/// Record (or update) resume info for an ACP session id.
pub fn record_resume_info(session_id: &str, info: ResumeInfo) {
    let mut index = RESUME_INDEX.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(slot) = index.iter_mut().find(|(id, _)| id == session_id) {
        slot.1 = info;
        return;
    }
    if index.len() >= RESUME_INDEX_CAP {
        index.remove(0);
    }
    index.push((session_id.to_string(), info));
}

/// Look up resume info recorded for `session_id`.
pub fn lookup_resume_info(session_id: &str) -> Option<ResumeInfo> {
    let index = RESUME_INDEX.lock().unwrap_or_else(|p| p.into_inner());
    index
        .iter()
        .find(|(id, _)| id == session_id)
        .map(|(_, info)| info.clone())
}

#[derive(Debug, Clone, PartialEq)]
pub struct AcpCatalogEntry {
    pub session_id: String,
    pub sdk_session_id: Option<String>,
    pub cwd: String,
    pub additional_directories: Vec<String>,
    pub title: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub selected_mode_id: Option<String>,
    pub selected_model_id: Option<String>,
    pub lifecycle: String,
    pub account_id: Option<String>,
    pub workspace_scope: Option<String>,
}

fn store_scope(
    account_id: Option<&str>,
    workspace_scope: Option<&str>,
) -> crate::agent_session_store::StoreScope {
    crate::agent_session_store::StoreScope {
        tenant: account_id.unwrap_or("default").to_string(),
        workspace: workspace_scope.unwrap_or("default").to_string(),
    }
}

fn to_store_row(entry: &AcpCatalogEntry) -> crate::agent_session_store::AcpSessionRow {
    crate::agent_session_store::AcpSessionRow {
        acp_session_id: entry.session_id.clone(),
        sdk_session_id: entry.sdk_session_id.clone(),
        cwd: entry.cwd.clone(),
        additional_directories: entry.additional_directories.clone(),
        title: entry.title.clone(),
        created_at: entry.created_at.clone(),
        updated_at: entry.updated_at.clone(),
        config_values: serde_json::json!({
            "mode": entry.selected_mode_id,
            "model": entry.selected_model_id,
        }),
        lifecycle: entry.lifecycle.clone(),
    }
}

fn from_store_row(
    row: crate::agent_session_store::AcpSessionRow,
    account_id: Option<&str>,
    workspace_scope: Option<&str>,
) -> AcpCatalogEntry {
    AcpCatalogEntry {
        session_id: row.acp_session_id,
        sdk_session_id: row.sdk_session_id,
        cwd: row.cwd,
        additional_directories: row.additional_directories,
        title: row.title,
        created_at: row.created_at,
        updated_at: row.updated_at,
        selected_mode_id: row
            .config_values
            .get("mode")
            .and_then(Value::as_str)
            .map(str::to_string),
        selected_model_id: row
            .config_values
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_string),
        lifecycle: row.lifecycle,
        account_id: account_id.map(str::to_string),
        workspace_scope: workspace_scope.map(str::to_string),
    }
}

static ACP_CATALOG: once_cell::sync::Lazy<Mutex<Vec<AcpCatalogEntry>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(Vec::new()));

fn configured_catalog_store(
) -> Result<Option<std::sync::Arc<crate::agent_session_store::SessionStore>>, String> {
    match crate::agent_session_store::configured_store() {
        Ok(store) => Ok(Some(store)),
        #[cfg(test)]
        Err(error) if error.contains("no database path configured") => Ok(None),
        Err(error) => Err(format!("ACP catalog store unavailable: {error}")),
    }
}

fn upsert_catalog_sync(entry: AcpCatalogEntry) -> Result<(), String> {
    if let Some(store) = configured_catalog_store()? {
        let scope = store_scope(
            entry.account_id.as_deref(),
            entry.workspace_scope.as_deref(),
        );
        store
            .upsert_acp_session(&scope, &to_store_row(&entry))
            .map_err(|error| format!("ACP catalog persistence failed: {error}"))?;
    }
    let mut catalog = ACP_CATALOG.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(existing) = catalog
        .iter_mut()
        .find(|item| item.session_id == entry.session_id)
    {
        *existing = entry;
    } else {
        catalog.push(entry);
    }
    Ok(())
}

fn lookup_catalog_sync(
    session_id: &str,
    account_id: Option<&str>,
    workspace_scope: Option<&str>,
) -> Result<Option<AcpCatalogEntry>, String> {
    let cached = ACP_CATALOG
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .iter()
        .find(|entry| {
            entry.session_id == session_id
                && entry.account_id.as_deref() == account_id
                && entry.workspace_scope.as_deref() == workspace_scope
        })
        .cloned();
    if cached.is_some() {
        return Ok(cached);
    }
    let Some(store) = configured_catalog_store()? else {
        return Ok(None);
    };
    let scope = store_scope(account_id, workspace_scope);
    store
        .get_acp_session(&scope, session_id)
        .map(|row| row.map(|row| from_store_row(row, account_id, workspace_scope)))
        .map_err(|error| format!("ACP catalog lookup failed: {error}"))
}

fn list_catalog_sync(
    account_id: Option<&str>,
    workspace_scope: Option<&str>,
    cwd: Option<&str>,
    cursor: usize,
    limit: usize,
) -> Result<(Vec<AcpCatalogEntry>, Option<usize>), String> {
    if let Some(store) = configured_catalog_store()? {
        let scope = store_scope(account_id, workspace_scope);
        let rows = store
            .list_acp_sessions(&scope, cwd, cursor, limit.saturating_add(1))
            .map_err(|error| format!("ACP catalog list failed: {error}"))?;
        let has_next = rows.len() > limit;
        let page = rows
            .into_iter()
            .take(limit)
            .map(|row| from_store_row(row, account_id, workspace_scope))
            .collect();
        return Ok((page, has_next.then_some(cursor.saturating_add(limit))));
    }
    let catalog = ACP_CATALOG.lock().unwrap_or_else(|p| p.into_inner());
    let visible: Vec<_> = catalog
        .iter()
        .filter(|entry| {
            entry.account_id.as_deref() == account_id
                && entry.workspace_scope.as_deref() == workspace_scope
                && cwd.is_none_or(|cwd| entry.cwd == cwd)
        })
        .cloned()
        .collect();
    let end = cursor.saturating_add(limit).min(visible.len());
    let page = visible.get(cursor..end).unwrap_or(&[]).to_vec();
    let next = (end < visible.len()).then_some(end);
    Ok((page, next))
}

fn update_catalog_sync(
    session_id: &str,
    account_id: Option<&str>,
    workspace_scope: Option<&str>,
    update: impl FnOnce(&mut AcpCatalogEntry),
) -> Result<bool, String> {
    let cached = ACP_CATALOG
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .iter()
        .find(|entry| {
            entry.session_id == session_id
                && entry.account_id.as_deref() == account_id
                && entry.workspace_scope.as_deref() == workspace_scope
        })
        .cloned();

    // A process restart leaves the durable catalog populated but the cache
    // empty. Load the scoped row before applying a mutation so the first
    // set-mode/config/title update after resume is not silently discarded.
    let Some(mut entry) = cached.or(lookup_catalog_sync(
        session_id,
        account_id,
        workspace_scope,
    )?) else {
        return Ok(false);
    };
    update(&mut entry);
    entry.updated_at = chrono::Utc::now().to_rfc3339();
    upsert_catalog_sync(entry)?;
    Ok(true)
}

fn remove_catalog_sync(
    session_id: &str,
    account_id: Option<&str>,
    workspace_scope: Option<&str>,
) -> Result<bool, String> {
    if let Some(store) = configured_catalog_store()? {
        let scope = store_scope(account_id, workspace_scope);
        store
            .delete_acp_session(&scope, session_id)
            .map_err(|error| format!("ACP catalog delete failed: {error}"))?;
    }
    let mut catalog = ACP_CATALOG.lock().unwrap_or_else(|p| p.into_inner());
    let before = catalog.len();
    catalog.retain(|entry| {
        !(entry.session_id == session_id
            && entry.account_id.as_deref() == account_id
            && entry.workspace_scope.as_deref() == workspace_scope)
    });
    Ok(before != catalog.len())
}

pub async fn upsert_catalog(entry: AcpCatalogEntry) -> Result<(), String> {
    tokio::task::spawn_blocking(move || upsert_catalog_sync(entry))
        .await
        .map_err(|error| format!("ACP catalog worker panicked: {error}"))?
}

pub async fn lookup_catalog(
    session_id: String,
    account_id: Option<String>,
    workspace_scope: Option<String>,
) -> Result<Option<AcpCatalogEntry>, String> {
    tokio::task::spawn_blocking(move || {
        lookup_catalog_sync(
            &session_id,
            account_id.as_deref(),
            workspace_scope.as_deref(),
        )
    })
    .await
    .map_err(|error| format!("ACP catalog worker panicked: {error}"))?
}

pub async fn list_catalog(
    account_id: Option<String>,
    workspace_scope: Option<String>,
    cwd: Option<String>,
    cursor: usize,
    limit: usize,
) -> Result<(Vec<AcpCatalogEntry>, Option<usize>), String> {
    tokio::task::spawn_blocking(move || {
        list_catalog_sync(
            account_id.as_deref(),
            workspace_scope.as_deref(),
            cwd.as_deref(),
            cursor,
            limit,
        )
    })
    .await
    .map_err(|error| format!("ACP catalog worker panicked: {error}"))?
}

pub async fn update_catalog<F>(
    session_id: String,
    account_id: Option<String>,
    workspace_scope: Option<String>,
    update: F,
) -> Result<bool, String>
where
    F: FnOnce(&mut AcpCatalogEntry) + Send + 'static,
{
    tokio::task::spawn_blocking(move || {
        update_catalog_sync(
            &session_id,
            account_id.as_deref(),
            workspace_scope.as_deref(),
            update,
        )
    })
    .await
    .map_err(|error| format!("ACP catalog worker panicked: {error}"))?
}

pub async fn remove_catalog(
    session_id: String,
    account_id: Option<String>,
    workspace_scope: Option<String>,
) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || {
        remove_catalog_sync(
            &session_id,
            account_id.as_deref(),
            workspace_scope.as_deref(),
        )
    })
    .await
    .map_err(|error| format!("ACP catalog worker panicked: {error}"))?
}

#[cfg(test)]
pub fn reset_resume_index_for_tests() {
    RESUME_INDEX
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clear();
}

#[cfg(test)]
static RESUME_TEST_LOCK: once_cell::sync::Lazy<Mutex<()>> =
    once_cell::sync::Lazy::new(|| Mutex::new(()));

#[cfg(test)]
pub fn resume_test_lock() -> std::sync::MutexGuard<'static, ()> {
    RESUME_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner())
}

#[cfg(test)]
pub fn reset_catalog_for_tests() {
    ACP_CATALOG
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clear();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn insert_rejects_duplicates() {
        let mut sessions = ConnectionSessions::new();
        assert!(sessions.insert("s1", SessionEntry::default()));
        assert!(!sessions.insert("s1", SessionEntry::default()));
        assert!(sessions.contains("s1"));
        assert!(!sessions.contains("s2"));
    }

    #[test]
    fn pending_prompt_lifecycle() {
        let mut sessions = ConnectionSessions::new();
        sessions.insert("s1", SessionEntry::default());
        let entry = sessions.get_mut("s1").unwrap();
        assert!(entry.pending_prompt.is_none());

        entry.pending_prompt = Some(PendingPrompt {
            rpc_id: json!(42),
            cancelled: false,
        });
        entry.prompted = true;

        let entry = sessions.get_mut("s1").unwrap();
        let pending = entry.pending_prompt.as_ref().unwrap();
        assert_eq!(pending.rpc_id, json!(42));
        assert!(!pending.cancelled);
    }

    #[test]
    fn prompted_session_ids_filters() {
        let mut sessions = ConnectionSessions::new();
        sessions.insert("idle", SessionEntry::default());
        sessions.insert(
            "active",
            SessionEntry {
                prompted: true,
                ..Default::default()
            },
        );
        assert_eq!(sessions.prompted_session_ids(), vec!["active".to_string()]);
    }

    #[test]
    fn resume_index_roundtrip_and_update() {
        let _guard = resume_test_lock();
        reset_resume_index_for_tests();
        assert!(lookup_resume_info("nope").is_none());

        record_resume_info(
            "s1",
            ResumeInfo {
                cwd: Some("/repo".into()),
                sdk_session_id: None,
            },
        );
        assert_eq!(
            lookup_resume_info("s1"),
            Some(ResumeInfo {
                cwd: Some("/repo".into()),
                sdk_session_id: None,
            })
        );

        // Update in place — no duplicate entry.
        record_resume_info(
            "s1",
            ResumeInfo {
                cwd: Some("/repo".into()),
                sdk_session_id: Some("sdk-1".into()),
            },
        );
        assert_eq!(
            lookup_resume_info("s1").unwrap().sdk_session_id,
            Some("sdk-1".to_string())
        );
        reset_resume_index_for_tests();
    }

    #[test]
    fn resume_index_evicts_oldest_at_cap() {
        let _guard = resume_test_lock();
        reset_resume_index_for_tests();
        for i in 0..(RESUME_INDEX_CAP + 10) {
            record_resume_info(
                &format!("s{i}"),
                ResumeInfo {
                    cwd: None,
                    sdk_session_id: Some(format!("sdk-{i}")),
                },
            );
        }
        // Oldest entries evicted, newest retained.
        assert!(lookup_resume_info("s0").is_none());
        assert!(lookup_resume_info(&format!("s{}", RESUME_INDEX_CAP + 9)).is_some());
        reset_resume_index_for_tests();
    }
}

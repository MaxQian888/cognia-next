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

#[cfg(test)]
pub fn reset_resume_index_for_tests() {
    RESUME_INDEX
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

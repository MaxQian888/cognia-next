//! Local code-adoption tracking (Phase 1).
//!
//! Quantifies how much code the in-app coding agent writes into the user's git
//! workspace per turn, entirely on-device. Reverse-infers the per-turn delta
//! from workspace fingerprints (`fingerprint`), reconciles it into per-file
//! metrics + hunk line-ranges reusing `crate::git` diffs (`attribution`), and
//! serializes the turn's window state in a process-global engine (`engine`).
//! No diff body is ever persisted, and nothing leaves the device.
//!
//! See `docs/superpowers/specs/2026-07-13-code-adoption-tracking-design.md`.

pub mod attribution;
pub mod commands;
pub mod engine;
pub mod fingerprint;

use serde::Serialize;

/// Metadata the renderer supplies when a turn starts. The `(session_id, run_id)`
/// pair is the true turn key — `run_id` is a per-session monotonic counter.
#[derive(Debug, Clone)]
pub struct TurnMeta {
    pub session_id: String,
    pub run_id: u32,
    pub model: Option<String>,
    pub agent_kind: String,
}

impl TurnMeta {
    pub fn turn_key(&self) -> String {
        format!("{}:{}", self.session_id, self.run_id)
    }
}

/// One attributed file — metrics + hunk line ranges only, never the diff body.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileAttribution {
    pub path: String,
    pub added: u32,
    pub removed: u32,
    pub is_new: bool,
    /// Inclusive `[start_line, end_line]` ranges on the new side, one per hunk.
    pub hunks: Vec<[u32; 2]>,
}

/// One turn's attribution record — the row persisted to the `codeAdoptionTurns`
/// Dexie table. `#[serde(rename_all = "camelCase")]` mirrors the TS row type.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeAdoptionTurn {
    /// `"${sessionId}:${runId}"` — the Dexie primary key.
    pub id: String,
    pub run_id: u32,
    pub session_id: String,
    /// Canonicalized workspace root (== resolved cwd).
    pub workspace_root: String,
    pub agent_kind: String,
    pub model: Option<String>,
    /// Epoch milliseconds at reconcile time.
    pub ts: i64,
    pub total_files: u32,
    pub total_added: u32,
    pub total_removed: u32,
    pub files: Vec<FileAttribution>,
    /// `true` when the per-turn file cap clamped the record.
    pub truncated: bool,
}

/// Why a turn was not attributed.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SkipReason {
    NotGitRepo,
    Concurrent,
}

/// Result of `turn_begin`. Serializes as `{ "status": "started" }` or
/// `{ "status": "skipped", "reason": "concurrent" }`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum BeginOutcome {
    Started,
    Skipped { reason: SkipReason },
}

impl BeginOutcome {
    pub fn skipped(reason: SkipReason) -> Self {
        BeginOutcome::Skipped { reason }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn turn_key_joins_session_and_run() {
        let meta = TurnMeta {
            session_id: "s1".to_string(),
            run_id: 7,
            model: None,
            agent_kind: "in-app".to_string(),
        };
        assert_eq!(meta.turn_key(), "s1:7");
    }

    #[test]
    fn begin_outcome_serializes_with_status_tag() {
        assert_eq!(
            serde_json::to_value(BeginOutcome::Started).unwrap(),
            serde_json::json!({ "status": "started" })
        );
        assert_eq!(
            serde_json::to_value(BeginOutcome::skipped(SkipReason::NotGitRepo)).unwrap(),
            serde_json::json!({ "status": "skipped", "reason": "notGitRepo" })
        );
        assert_eq!(
            serde_json::to_value(BeginOutcome::skipped(SkipReason::Concurrent)).unwrap(),
            serde_json::json!({ "status": "skipped", "reason": "concurrent" })
        );
    }

    #[test]
    fn turn_row_serializes_camel_case() {
        let turn = CodeAdoptionTurn {
            id: "s1:1".to_string(),
            run_id: 1,
            session_id: "s1".to_string(),
            workspace_root: "/repo".to_string(),
            agent_kind: "in-app".to_string(),
            model: Some("opus".to_string()),
            ts: 100,
            total_files: 1,
            total_added: 3,
            total_removed: 0,
            files: vec![FileAttribution {
                path: "a.ts".to_string(),
                added: 3,
                removed: 0,
                is_new: true,
                hunks: vec![[1, 3]],
            }],
            truncated: false,
        };
        let v = serde_json::to_value(&turn).unwrap();
        assert_eq!(v["runId"], 1);
        assert_eq!(v["workspaceRoot"], "/repo");
        assert_eq!(v["agentKind"], "in-app");
        assert_eq!(v["totalAdded"], 3);
        assert_eq!(v["files"][0]["isNew"], true);
        assert_eq!(v["files"][0]["hunks"][0][0], 1);
        assert_eq!(v["files"][0]["hunks"][0][1], 3);
    }
}

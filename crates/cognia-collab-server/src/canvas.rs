//! Canvas documents on the collaboration plane (ADR-0158, amended).
//!
//! # One membership ladder, not a second one
//!
//! Shared chat gives every session its own member table, because a session is
//! something you are invited to individually. A Canvas document is not: it
//! lives in a workspace, and the question "may this person edit it" is already
//! answered by [`WorkspaceRole`]. This module maps Canvas actions onto that
//! existing ladder and adds nothing to it.
//!
//! ```text
//!   viewer      read
//!   member      read + edit + comment
//!   maintainer  read + edit + comment + manage (delete, share, compact)
//! ```
//!
//! An org owner or admin traverses into the workspace as a maintainer, which
//! `resolve_workspace_access` decides. Not this module.
//!
//! # Why the actions are named at all
//!
//! [`CanvasAction`] could have been three [`WorkspaceCapability`] values passed
//! inline at each route. Naming the action keeps the audit line and the refusal
//! reason specific ("canvas.compact" rather than "manage"), and it puts the
//! whole mapping in one table a test can walk, so a new route cannot quietly
//! pick the wrong bar.

use serde::{Deserialize, Serialize};

use cognia_tenant_auth::WorkspaceCapability;

/// What a caller is trying to do to a Canvas document.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CanvasAction {
    /// List documents, read metadata, pull updates, read comments and versions.
    Read,
    /// Create a document in the workspace.
    Create,
    /// Append a document update, or save a named version.
    Edit,
    /// Post, edit or resolve a comment.
    Comment,
    /// Rename, or change the language.
    Rename,
    /// Replace the baseline snapshot and retire the updates it covers.
    Compact,
    /// Destroy the document and everything hanging off it.
    Delete,
}

impl CanvasAction {
    pub const ALL: [Self; 7] = [
        Self::Read,
        Self::Create,
        Self::Edit,
        Self::Comment,
        Self::Rename,
        Self::Compact,
        Self::Delete,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Read => "canvas.read",
            Self::Create => "canvas.create",
            Self::Edit => "canvas.edit",
            Self::Comment => "canvas.comment",
            Self::Rename => "canvas.rename",
            Self::Compact => "canvas.compact",
            Self::Delete => "canvas.delete",
        }
    }

    /// The bar this action has to clear.
    ///
    /// `Compact` is a manage-level act even though it writes no new content.
    /// It declares that a range of the update log is redundant, so a peer
    /// posting a truncated snapshot would silently drop everyone else's recent
    /// edits. Requiring a maintainer keeps that out of a plain member's reach.
    pub fn required_capability(self) -> WorkspaceCapability {
        match self {
            Self::Read => WorkspaceCapability::Read,
            Self::Create | Self::Edit | Self::Comment | Self::Rename => WorkspaceCapability::Write,
            Self::Compact | Self::Delete => WorkspaceCapability::Manage,
        }
    }
}

/// A Canvas document as the collaboration plane reports it.
///
/// The Yjs bytes are deliberately absent: metadata is small and listed often,
/// the state is large and pulled deliberately. Sending them together would put
/// every document's full history into every list response.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasDocumentRecord {
    pub id: String,
    pub org_id: String,
    pub workspace_id: String,
    pub title: String,
    pub language: String,
    pub created_by_user_id: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub revision: i64,
    /// Highest update sequence the server has accepted. A client that holds
    /// this number is caught up.
    pub latest_sequence: i64,
    /// Updates at or below this are folded into the stored snapshot.
    pub snapshot_sequence: i64,
}

/// One opaque Yjs update, as stored and relayed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasUpdateRecord {
    pub document_id: String,
    pub sequence: i64,
    /// Base64, and opaque here. Only a Yjs client decodes it.
    pub payload: String,
    pub author_user_id: String,
    pub created_at: i64,
    pub operation_id: String,
}

/// A comment anchored into the document's CRDT rather than to a line number.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasCommentRecord {
    pub id: String,
    pub document_id: String,
    /// Base64 Yjs relative position, which survives edits made above it. A
    /// line number does not.
    pub anchor: String,
    pub head: Option<String>,
    pub body: String,
    pub author_user_id: String,
    pub resolved: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A named point in the document's history.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasVersionRecord {
    pub id: String,
    pub document_id: String,
    pub label: String,
    pub content: String,
    pub author_user_id: String,
    pub created_at: i64,
}

/// Who is in a document right now. Never persisted, because presence that
/// outlives the socket is a lie about who is looking.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasPresence {
    pub participant_id: String,
    pub user_id: String,
    pub name: String,
    pub color: String,
    pub last_active: i64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use cognia_tenant_auth::{membership::resolve_workspace_access, WorkspaceRole};

    fn permits(role: WorkspaceRole, action: CanvasAction) -> bool {
        resolve_workspace_access(None, Some(role))
            .expect("a workspace role always resolves to access")
            .allows(action.required_capability())
    }

    #[test]
    fn a_viewer_reads_and_nothing_else() {
        assert!(permits(WorkspaceRole::Viewer, CanvasAction::Read));
        for action in CanvasAction::ALL {
            if action == CanvasAction::Read {
                continue;
            }
            assert!(
                !permits(WorkspaceRole::Viewer, action),
                "a viewer must not be able to {}",
                action.as_str()
            );
        }
    }

    #[test]
    fn a_member_edits_and_comments_but_does_not_manage() {
        for action in [
            CanvasAction::Read,
            CanvasAction::Create,
            CanvasAction::Edit,
            CanvasAction::Comment,
            CanvasAction::Rename,
        ] {
            assert!(
                permits(WorkspaceRole::Member, action),
                "{}",
                action.as_str()
            );
        }
        assert!(!permits(WorkspaceRole::Member, CanvasAction::Delete));
        // A member posting a snapshot could retire updates they never saw.
        assert!(!permits(WorkspaceRole::Member, CanvasAction::Compact));
    }

    #[test]
    fn a_maintainer_may_do_all_of_it() {
        for action in CanvasAction::ALL {
            assert!(
                permits(WorkspaceRole::Maintainer, action),
                "{}",
                action.as_str()
            );
        }
    }

    #[test]
    fn every_action_has_a_distinct_audit_name() {
        let mut names: Vec<&str> = CanvasAction::ALL.iter().map(|a| a.as_str()).collect();
        names.sort_unstable();
        let count = names.len();
        names.dedup();
        assert_eq!(names.len(), count, "two actions share an audit name");
    }
}

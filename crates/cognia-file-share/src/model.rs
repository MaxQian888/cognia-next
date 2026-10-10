//! Wire and storage types (camelCase on the wire, matching
//! `types/filespace/live.ts`).

use serde::{Deserialize, Serialize};
use schemars::JsonSchema;

use crate::error::{FileShareError, FileShareResult};

/// What a live grant allows on its paths.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Permission {
    /// List directories and read metadata.
    Read,
    /// Read file bytes.
    Download,
    /// Create, overwrite, rename, delete and make directories.
    Write,
}

impl Permission {
    pub fn as_str(self) -> &'static str {
        match self {
            Permission::Read => "read",
            Permission::Download => "download",
            Permission::Write => "write",
        }
    }

    pub fn parse(value: &str) -> FileShareResult<Self> {
        match value {
            "read" => Ok(Permission::Read),
            "download" => Ok(Permission::Download),
            "write" => Ok(Permission::Write),
            other => Err(FileShareError::invalid(format!("unknown permission {other}"))),
        }
    }
}

/// A network protocol a credential speaks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Protocol {
    Webdav,
    Sftp,
}

impl Protocol {
    pub fn as_str(self) -> &'static str {
        match self {
            Protocol::Webdav => "webdav",
            Protocol::Sftp => "sftp",
        }
    }

    pub fn parse(value: &str) -> FileShareResult<Self> {
        match value {
            "webdav" => Ok(Protocol::Webdav),
            "sftp" => Ok(Protocol::Sftp),
            other => Err(FileShareError::invalid(format!("unknown protocol {other}"))),
        }
    }
}

/// Who serves a credential's protocol.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind {
    /// The in-process WebDAV/SFTP listeners.
    Builtin,
    /// An external SFTPGo deployment that sees the same volume.
    Sftpgo,
}

impl ProviderKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ProviderKind::Builtin => "builtin",
            ProviderKind::Sftpgo => "sftpgo",
        }
    }

    pub fn parse(value: &str) -> FileShareResult<Self> {
        match value {
            "builtin" => Ok(ProviderKind::Builtin),
            "sftpgo" => Ok(ProviderKind::Sftpgo),
            other => Err(FileShareError::invalid(format!("unknown provider {other}"))),
        }
    }
}

/// A grant's lifecycle state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum GrantStatus {
    /// Served.
    Active,
    /// Paused by its owner, by the policy, or because its conversation was
    /// archived; resumable while unexpired.
    Suspended,
    /// A mount it covers now points elsewhere (fingerprint changed); the owner
    /// re-shares to reconfirm.
    Stale,
    /// Past its expiry.
    Expired,
    /// Withdrawn for good.
    Revoked,
}

impl GrantStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            GrantStatus::Active => "active",
            GrantStatus::Suspended => "suspended",
            GrantStatus::Stale => "stale",
            GrantStatus::Expired => "expired",
            GrantStatus::Revoked => "revoked",
        }
    }

    pub fn parse(value: &str) -> FileShareResult<Self> {
        match value {
            "active" => Ok(GrantStatus::Active),
            "suspended" => Ok(GrantStatus::Suspended),
            "stale" => Ok(GrantStatus::Stale),
            "expired" => Ok(GrantStatus::Expired),
            "revoked" => Ok(GrantStatus::Revoked),
            other => Err(FileShareError::store(format!("unknown grant status {other}"))),
        }
    }

    /// A terminal state is never left.
    pub fn is_terminal(self) -> bool {
        matches!(self, GrantStatus::Expired | GrantStatus::Revoked)
    }
}

/// Why a grant is not active. Stored as text; rendered by the UI.
pub mod status_reason {
    /// The owner paused it.
    pub const OWNER: &str = "owner";
    /// The effective policy no longer allows it.
    pub const POLICY: &str = "policy";
    /// Its conversation was archived.
    pub const SESSION_ARCHIVED: &str = "session_archived";
    /// Its conversation was deleted.
    pub const SESSION_DELETED: &str = "session_deleted";
    /// A mount it covers was retargeted.
    pub const MOUNT_CHANGED: &str = "mount_changed";
    /// Its expiry passed.
    pub const EXPIRED: &str = "expired";
    /// The owner revoked it.
    pub const REVOKED: &str = "revoked";
    /// A collaboration audience's host registration ended: replaced,
    /// removed, or refused by the server (the registrant lost `files.share`).
    pub const COLLAB_HOST_REMOVED: &str = "collab_host_removed";
    /// The collaboration server's org policy refused to publish it.
    pub const ORG_POLICY: &str = "org_policy";
}

/// The conversation's state as the mount table last reported it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionState {
    Active,
    Archived,
    Deleted,
}

impl SessionState {
    pub fn as_str(self) -> &'static str {
        match self {
            SessionState::Active => "active",
            SessionState::Archived => "archived",
            SessionState::Deleted => "deleted",
        }
    }

    pub fn parse(value: &str) -> FileShareResult<Self> {
        match value {
            "active" => Ok(SessionState::Active),
            "archived" => Ok(SessionState::Archived),
            "deleted" => Ok(SessionState::Deleted),
            other => Err(FileShareError::invalid(format!("unknown session state {other}"))),
        }
    }
}

/// Where a mount's bytes live.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Backing {
    Disk,
    Dexie,
}

impl Backing {
    pub fn as_str(self) -> &'static str {
        match self {
            Backing::Disk => "disk",
            Backing::Dexie => "dexie",
        }
    }

    pub fn parse(value: &str) -> FileShareResult<Self> {
        match value {
            "disk" => Ok(Backing::Disk),
            "dexie" => Ok(Backing::Dexie),
            other => Err(FileShareError::invalid(format!("unknown backing {other}"))),
        }
    }
}

/// One mount of a conversation, as the host stores it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MountRecord {
    pub session_id: String,
    pub mount_id: String,
    pub virtual_path: String,
    pub backing: Backing,
    /// Canonical host directory for a disk mount.
    pub host_path: Option<String>,
    pub writable: bool,
    /// `available` or the FileSpace status (`offline`, `missing`, `deleted`).
    pub status: String,
    pub fingerprint: String,
    pub session_state: SessionState,
    pub updated_at: i64,
}

impl MountRecord {
    pub fn is_available(&self) -> bool {
        self.status == "available" && self.session_state == SessionState::Active
    }
}

/// One file of a Dexie-backed mount (`/uploads`, `/artifacts`), pushed with
/// the mount table so the host can list it without a bridge round trip.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetEntry {
    pub mount_id: String,
    /// File name inside the mount (unique per mount; the resolver
    /// disambiguates).
    pub name: String,
    pub size: u64,
    pub media_type: String,
    pub modified_at: i64,
    /// Opaque id the renderer reads the bytes by.
    pub source_id: String,
}

/// One path a grant covers, inside one mount.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GrantPath {
    pub mount_id: String,
    /// Normalized path inside the mount; `""` is the whole mount.
    pub rel_path: String,
    pub is_dir: bool,
    pub mount_fingerprint: String,
    /// The FileSpace path this entry was granted as (`/workspace/src`).
    pub virtual_path: String,
}

/// Who created a grant. `Agent` is an agent's `filespace_share` /
/// `filespace_enable_webdav` call the person approved (ADR-0222 §9): the
/// policy's `allow_agent_sharing` gates it at creation and while it lives.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum CreatedBy {
    #[default]
    User,
    Agent,
}

impl CreatedBy {
    pub fn as_str(self) -> &'static str {
        match self {
            CreatedBy::User => "user",
            CreatedBy::Agent => "agent",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "user" => Some(CreatedBy::User),
            "agent" => Some(CreatedBy::Agent),
            _ => None,
        }
    }
}

/// A member's role in a shared conversation, as the collaboration server
/// names it (`SessionRole` there).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum CollabRole {
    Viewer,
    Member,
    Maintainer,
    Owner,
}

impl CollabRole {
    pub fn as_str(self) -> &'static str {
        match self {
            CollabRole::Viewer => "viewer",
            CollabRole::Member => "member",
            CollabRole::Maintainer => "maintainer",
            CollabRole::Owner => "owner",
        }
    }

    pub fn rank(self) -> u8 {
        match self {
            CollabRole::Viewer => 0,
            CollabRole::Member => 1,
            CollabRole::Maintainer => 2,
            CollabRole::Owner => 3,
        }
    }

    /// A viewer reads; changing files takes at least a member, as the
    /// server's `files.writeLive` says.
    pub fn may_write(self) -> bool {
        self.rank() >= CollabRole::Member.rank()
    }
}

/// Most members one collaboration grant may name.
pub const MAX_AUDIENCE_USERS: usize = 200;

/// Who a grant is for.
///
/// - `credentials`: whoever holds one of its WebDAV/SFTP credentials (P2).
/// - `collab`: members of the shared conversation the host is registered
///   for on the collaboration server (P3). They reach the files through
///   requests the server relays and this host answers; no credential exists.
///   `org_id` and `collab_session_id` are the registration the grant was made
///   under: a later registration does not inherit it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "lowercase", rename_all_fields = "camelCase")]
pub enum Audience {
    Credentials,
    Collab {
        org_id: String,
        collab_session_id: String,
        /// `None`: every member whose role is at least `min_role`.
        user_ids: Option<Vec<String>>,
        min_role: CollabRole,
    },
}

impl Audience {
    pub fn kind(&self) -> &'static str {
        match self {
            Audience::Credentials => "credentials",
            Audience::Collab { .. } => "collab",
        }
    }

    pub fn is_collab(&self) -> bool {
        matches!(self, Audience::Collab { .. })
    }
}

/// The audience a create request asks for. A collaboration audience takes its
/// org and conversation from the host's current registration.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "lowercase", rename_all_fields = "camelCase")]
pub enum AudienceRequest {
    #[default]
    Credentials,
    Collab {
        #[serde(default)]
        user_ids: Option<Vec<String>>,
        min_role: CollabRole,
    },
}

/// A live grant.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Grant {
    pub id: String,
    pub session_id: String,
    pub label: Option<String>,
    pub created_by: CreatedBy,
    pub creator_principal: String,
    pub audience: Audience,
    /// The protocols its credentials speak; empty for a collaboration grant.
    pub protocols: Vec<Protocol>,
    pub provider: ProviderKind,
    pub permissions: Vec<Permission>,
    pub status: GrantStatus,
    pub status_reason: Option<String>,
    pub expires_at: i64,
    pub policy_revision: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub revoked_at: Option<i64>,
    pub paths: Vec<GrantPath>,
}

impl Grant {
    pub fn allows(&self, permission: Permission) -> bool {
        self.permissions.contains(&permission)
    }
}

/// A credential as listed: never the secret.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CredentialView {
    pub id: String,
    pub grant_id: String,
    pub protocol: Protocol,
    pub provider: ProviderKind,
    pub username: String,
    /// SHA-256 fingerprint of the SFTP public key, when one was registered.
    pub ssh_key_fingerprint: Option<String>,
    pub created_at: i64,
    pub rotated_at: Option<i64>,
    pub revoked_at: Option<i64>,
}

/// A credential at issue or rotation: the one time its password is shown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct IssuedCredential {
    pub credential: CredentialView,
    pub password: String,
}

/// A grant with its credentials, as listed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GrantView {
    pub grant: Grant,
    pub credentials: Vec<CredentialView>,
}

/// The result of creating a grant.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreatedGrant {
    pub grant: Grant,
    pub credentials: Vec<IssuedCredential>,
    pub endpoints: crate::listener::Endpoints,
}

/// What to create.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateGrantRequest {
    pub session_id: String,
    /// FileSpace paths (`/workspace/src`, `/uploads/report.pdf`).
    pub paths: Vec<String>,
    pub permissions: Vec<Permission>,
    /// Required for a credential audience; must be empty for a collaboration
    /// one.
    #[serde(default)]
    pub protocols: Vec<Protocol>,
    #[serde(default = "default_provider")]
    pub provider: ProviderKind,
    pub expires_in_seconds: i64,
    #[serde(default)]
    pub label: Option<String>,
    /// OpenSSH public key accepted for SFTP in addition to the password.
    #[serde(default)]
    pub ssh_public_key: Option<String>,
    /// `agent` for a grant an agent's tool call made; refused unless the
    /// policy allows agent sharing.
    #[serde(default)]
    pub created_by: CreatedBy,
    #[serde(default)]
    pub audience: AudienceRequest,
}

fn default_provider() -> ProviderKind {
    ProviderKind::Builtin
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enums_round_trip_their_wire_spelling() {
        for permission in [Permission::Read, Permission::Download, Permission::Write] {
            assert_eq!(Permission::parse(permission.as_str()).unwrap(), permission);
            assert_eq!(
                serde_json::to_value(permission).unwrap(),
                serde_json::json!(permission.as_str())
            );
        }
        for status in [
            GrantStatus::Active,
            GrantStatus::Suspended,
            GrantStatus::Stale,
            GrantStatus::Expired,
            GrantStatus::Revoked,
        ] {
            assert_eq!(GrantStatus::parse(status.as_str()).unwrap(), status);
        }
        assert!(GrantStatus::Revoked.is_terminal());
        assert!(!GrantStatus::Suspended.is_terminal());
        assert_eq!(Protocol::parse("sftp").unwrap(), Protocol::Sftp);
        assert!(Protocol::parse("ftp").is_err());
        assert_eq!(ProviderKind::parse("sftpgo").unwrap(), ProviderKind::Sftpgo);
        assert_eq!(SessionState::parse("archived").unwrap(), SessionState::Archived);
        assert_eq!(Backing::parse("dexie").unwrap(), Backing::Dexie);
    }

    #[test]
    fn a_create_request_defaults_to_the_builtin_provider() {
        let request: CreateGrantRequest = serde_json::from_value(serde_json::json!({
            "sessionId": "s1",
            "paths": ["/workspace"],
            "permissions": ["read", "download"],
            "protocols": ["webdav"],
            "expiresInSeconds": 3600
        }))
        .unwrap();
        assert_eq!(request.provider, ProviderKind::Builtin);
        assert_eq!(request.label, None);
        assert_eq!(request.audience, AudienceRequest::Credentials);
    }

    #[test]
    fn audiences_are_tagged_by_kind() {
        let request: CreateGrantRequest = serde_json::from_value(serde_json::json!({
            "sessionId": "s1",
            "paths": ["/workspace"],
            "permissions": ["read"],
            "expiresInSeconds": 3600,
            "audience": { "kind": "collab", "minRole": "member", "userIds": ["usr_a"] }
        }))
        .unwrap();
        assert!(request.protocols.is_empty());
        assert_eq!(
            request.audience,
            AudienceRequest::Collab {
                user_ids: Some(vec!["usr_a".into()]),
                min_role: CollabRole::Member,
            }
        );
        let audience = Audience::Collab {
            org_id: "org_1".into(),
            collab_session_id: "ses_1".into(),
            user_ids: None,
            min_role: CollabRole::Viewer,
        };
        assert_eq!(
            serde_json::to_value(&audience).unwrap(),
            serde_json::json!({
                "kind": "collab",
                "orgId": "org_1",
                "collabSessionId": "ses_1",
                "userIds": null,
                "minRole": "viewer"
            })
        );
        assert_eq!(
            serde_json::to_value(Audience::Credentials).unwrap(),
            serde_json::json!({ "kind": "credentials" })
        );
        assert_eq!(audience.kind(), "collab");
        assert!(!Audience::Credentials.is_collab());
    }

    #[test]
    fn roles_rank_and_only_members_and_up_write() {
        assert!(CollabRole::Owner.rank() > CollabRole::Maintainer.rank());
        assert!(CollabRole::Maintainer.rank() > CollabRole::Member.rank());
        assert!(CollabRole::Member.rank() > CollabRole::Viewer.rank());
        assert!(!CollabRole::Viewer.may_write());
        assert!(CollabRole::Member.may_write());
        assert_eq!(
            serde_json::to_value(CollabRole::Maintainer).unwrap(),
            serde_json::json!("maintainer")
        );
    }
}

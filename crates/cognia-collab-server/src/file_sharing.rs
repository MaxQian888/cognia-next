//! An organization's file-sharing policy (ADR-0222 §6.4).
//!
//! # What it governs
//!
//! Whether people in the org may publish conversation files as public
//! snapshot links, hand out live access, issue network-drive credentials,
//! allow writes through them, or let an agent share on their behalf — and the
//! longest each may last. A client never applies it alone: it intersects this
//! with the person's own local policy field by field, the most restrictive
//! value winning, so neither side can widen the other.
//!
//! # Where it is enforced
//!
//! The client greys out what the effective policy forbids, and the server
//! re-checks the parts it can see: authorizing a file share from a shared
//! conversation (`export-authorization?scope=files`) is refused here when the
//! org forbids public snapshots, whatever the client believed.
//!
//! # Revisions
//!
//! Absent until an owner or admin first saves one, which reads as revision 0
//! with the defaults below. Every save names the revision it read and bumps
//! it; a save from a stale read is a conflict carrying the current policy,
//! not a silent overwrite. Clients cache by revision.

use std::collections::HashMap;

use async_trait::async_trait;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::routing::get;
use axum::{Json, Router};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::api::{authorization, AppState, Failure};
use crate::auth::{readable_scope, verify_grant};
use crate::store::{AuthorizationAuditEvent, PgStore, StoreError};

/// Thirty days: the share service's own default ceiling.
pub const DEFAULT_MAX_SNAPSHOT_TTL_SECONDS: i64 = 30 * 24 * 60 * 60;
/// Seven days.
pub const DEFAULT_MAX_LIVE_TTL_SECONDS: i64 = 7 * 24 * 60 * 60;
/// No ceiling may be set below an hour — the shortest link the client offers.
pub const MIN_TTL_SECONDS: i64 = 60 * 60;
/// Nor above a year.
pub const MAX_TTL_SECONDS: i64 = 365 * 24 * 60 * 60;

/// The adjustable part of a policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSharingSettings {
    pub allow_public_snapshots: bool,
    pub allow_live_grants: bool,
    pub allow_protocol_credentials: bool,
    pub allow_live_write: bool,
    pub allow_agent_sharing: bool,
    pub max_snapshot_ttl_seconds: i64,
    pub max_live_ttl_seconds: i64,
}

impl Default for FileSharingSettings {
    /// Conservative where a mistake is hard to take back: credentials, writes
    /// and agent sharing start off.
    fn default() -> Self {
        Self {
            allow_public_snapshots: true,
            allow_live_grants: true,
            allow_protocol_credentials: false,
            allow_live_write: false,
            allow_agent_sharing: false,
            max_snapshot_ttl_seconds: DEFAULT_MAX_SNAPSHOT_TTL_SECONDS,
            max_live_ttl_seconds: DEFAULT_MAX_LIVE_TTL_SECONDS,
        }
    }
}

impl FileSharingSettings {
    /// Why these settings cannot be saved, or `None`.
    pub fn validate(&self) -> Option<String> {
        for (name, value) in [
            ("maxSnapshotTtlSeconds", self.max_snapshot_ttl_seconds),
            ("maxLiveTtlSeconds", self.max_live_ttl_seconds),
        ] {
            if !(MIN_TTL_SECONDS..=MAX_TTL_SECONDS).contains(&value) {
                return Some(format!(
                    "{name} must be between {MIN_TTL_SECONDS} and {MAX_TTL_SECONDS} seconds"
                ));
            }
        }
        if self.allow_live_write && !self.allow_live_grants {
            return Some("allowLiveWrite needs allowLiveGrants".into());
        }
        if self.allow_protocol_credentials && !self.allow_live_grants {
            return Some("allowProtocolCredentials needs allowLiveGrants".into());
        }
        None
    }
}

/// The policy as stored and as served.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSharingPolicy {
    #[serde(flatten)]
    pub settings: FileSharingSettings,
    /// 0 until first saved.
    pub revision: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<i64>,
}

impl FileSharingPolicy {
    /// What an org that never saved a policy gets.
    pub fn unset() -> Self {
        Self {
            settings: FileSharingSettings::default(),
            revision: 0,
            updated_by: None,
            updated_at: None,
        }
    }
}

#[async_trait]
pub trait FileSharingPolicyStore: Send + Sync {
    /// The org's saved policy, `None` when it never saved one.
    async fn get_file_sharing_policy(
        &self,
        org_id: &str,
    ) -> Result<Option<FileSharingPolicy>, StoreError>;

    /// Save `settings` over the policy at `base_revision` (0 for the first
    /// save). Fails with [`StoreError::Conflict`] carrying the current policy
    /// when someone saved in between.
    async fn put_file_sharing_policy(
        &self,
        org_id: &str,
        settings: FileSharingSettings,
        base_revision: i64,
        actor_user_id: &str,
        now: i64,
    ) -> Result<FileSharingPolicy, StoreError>;
}

/// The policy that applies to `org_id` right now.
pub async fn effective_policy(
    store: &dyn FileSharingPolicyStore,
    org_id: &str,
) -> Result<FileSharingPolicy, StoreError> {
    Ok(store
        .get_file_sharing_policy(org_id)
        .await?
        .unwrap_or_else(FileSharingPolicy::unset))
}

fn conflict(current: &FileSharingPolicy) -> StoreError {
    StoreError::Conflict(serde_json::to_value(current).unwrap_or(serde_json::Value::Null))
}

// ── In-memory ────────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct InMemoryFileSharingPolicyStore {
    policies: RwLock<HashMap<String, FileSharingPolicy>>,
}

impl InMemoryFileSharingPolicyStore {
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait]
impl FileSharingPolicyStore for InMemoryFileSharingPolicyStore {
    async fn get_file_sharing_policy(
        &self,
        org_id: &str,
    ) -> Result<Option<FileSharingPolicy>, StoreError> {
        Ok(self.policies.read().get(org_id).cloned())
    }

    async fn put_file_sharing_policy(
        &self,
        org_id: &str,
        settings: FileSharingSettings,
        base_revision: i64,
        actor_user_id: &str,
        now: i64,
    ) -> Result<FileSharingPolicy, StoreError> {
        let mut policies = self.policies.write();
        let current = policies
            .get(org_id)
            .cloned()
            .unwrap_or_else(FileSharingPolicy::unset);
        if current.revision != base_revision {
            return Err(conflict(&current));
        }
        let saved = FileSharingPolicy {
            settings,
            revision: current.revision + 1,
            updated_by: Some(actor_user_id.to_owned()),
            updated_at: Some(now),
        };
        policies.insert(org_id.to_owned(), saved.clone());
        Ok(saved)
    }
}

// ── Postgres ─────────────────────────────────────────────────────────────────

const COLUMNS: &str = "allow_public_snapshots, allow_live_grants, allow_protocol_credentials, \
                       allow_live_write, allow_agent_sharing, max_snapshot_ttl_seconds, \
                       max_live_ttl_seconds, revision, updated_by, updated_at";

fn db(error: impl std::fmt::Display) -> StoreError {
    StoreError::Database(error.to_string())
}

fn from_row(row: &tokio_postgres::Row) -> FileSharingPolicy {
    FileSharingPolicy {
        settings: FileSharingSettings {
            allow_public_snapshots: row.get("allow_public_snapshots"),
            allow_live_grants: row.get("allow_live_grants"),
            allow_protocol_credentials: row.get("allow_protocol_credentials"),
            allow_live_write: row.get("allow_live_write"),
            allow_agent_sharing: row.get("allow_agent_sharing"),
            max_snapshot_ttl_seconds: row.get("max_snapshot_ttl_seconds"),
            max_live_ttl_seconds: row.get("max_live_ttl_seconds"),
        },
        revision: row.get("revision"),
        updated_by: Some(row.get("updated_by")),
        updated_at: Some(row.get("updated_at")),
    }
}

#[async_trait]
impl FileSharingPolicyStore for PgStore {
    async fn get_file_sharing_policy(
        &self,
        org_id: &str,
    ) -> Result<Option<FileSharingPolicy>, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        let row = tx
            .query_opt(
                &format!("SELECT {COLUMNS} FROM org_file_sharing_policies WHERE org_id = $1"),
                &[&org_id],
            )
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(row.as_ref().map(from_row))
    }

    async fn put_file_sharing_policy(
        &self,
        org_id: &str,
        settings: FileSharingSettings,
        base_revision: i64,
        actor_user_id: &str,
        now: i64,
    ) -> Result<FileSharingPolicy, StoreError> {
        let mut client = self.client().await?;
        let tx = self.scoped(&mut client, org_id).await?;
        let current = tx
            .query_opt(
                &format!(
                    "SELECT {COLUMNS} FROM org_file_sharing_policies \
                     WHERE org_id = $1 FOR UPDATE"
                ),
                &[&org_id],
            )
            .await
            .map_err(db)?
            .as_ref()
            .map(from_row)
            .unwrap_or_else(FileSharingPolicy::unset);
        if current.revision != base_revision {
            tx.commit().await.map_err(db)?;
            return Err(conflict(&current));
        }
        // Two first saves race on the primary key: the loser inserts nothing
        // and reads as a conflict below rather than overwriting the winner.
        let row = tx
            .query_opt(
                &format!(
                    "INSERT INTO org_file_sharing_policies \
                     (org_id, allow_public_snapshots, allow_live_grants, \
                      allow_protocol_credentials, allow_live_write, allow_agent_sharing, \
                      max_snapshot_ttl_seconds, max_live_ttl_seconds, revision, updated_by, \
                      updated_at) \
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) \
                     ON CONFLICT (org_id) DO UPDATE SET \
                       allow_public_snapshots = EXCLUDED.allow_public_snapshots, \
                       allow_live_grants = EXCLUDED.allow_live_grants, \
                       allow_protocol_credentials = EXCLUDED.allow_protocol_credentials, \
                       allow_live_write = EXCLUDED.allow_live_write, \
                       allow_agent_sharing = EXCLUDED.allow_agent_sharing, \
                       max_snapshot_ttl_seconds = EXCLUDED.max_snapshot_ttl_seconds, \
                       max_live_ttl_seconds = EXCLUDED.max_live_ttl_seconds, \
                       revision = EXCLUDED.revision, \
                       updated_by = EXCLUDED.updated_by, \
                       updated_at = EXCLUDED.updated_at \
                     WHERE org_file_sharing_policies.revision = $12 \
                     RETURNING {COLUMNS}"
                ),
                &[
                    &org_id,
                    &settings.allow_public_snapshots,
                    &settings.allow_live_grants,
                    &settings.allow_protocol_credentials,
                    &settings.allow_live_write,
                    &settings.allow_agent_sharing,
                    &settings.max_snapshot_ttl_seconds,
                    &settings.max_live_ttl_seconds,
                    &(base_revision + 1),
                    &actor_user_id,
                    &now,
                    &base_revision,
                ],
            )
            .await
            .map_err(db)?;
        let Some(row) = row else {
            let winner = tx
                .query_one(
                    &format!("SELECT {COLUMNS} FROM org_file_sharing_policies WHERE org_id = $1"),
                    &[&org_id],
                )
                .await
                .map_err(db)?;
            tx.commit().await.map_err(db)?;
            return Err(conflict(&from_row(&winner)));
        };
        tx.commit().await.map_err(db)?;
        Ok(from_row(&row))
    }
}

// ── Routes ───────────────────────────────────────────────────────────────────

pub fn routes() -> Router<AppState> {
    Router::new().route(
        "/v1/orgs/{org_id}/file-sharing-policy",
        get(get_policy).put(put_policy),
    )
}

/// Any member of the org may read it: the client needs it to know what to offer.
async fn get_policy(
    State(state): State<AppState>,
    Path(org_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<FileSharingPolicy>, Failure> {
    let claims = verify_grant(&state.signer, authorization(&headers), &org_id).await?;
    readable_scope(state.store.as_ref(), &claims).await?;
    Ok(Json(
        effective_policy(state.file_sharing_store.as_ref(), &org_id).await?,
    ))
}

/// Every field is required: a save states the whole policy, so a client that
/// does not know about a newer switch cannot silently reset it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PutPolicyBody {
    allow_public_snapshots: bool,
    allow_live_grants: bool,
    allow_protocol_credentials: bool,
    allow_live_write: bool,
    allow_agent_sharing: bool,
    max_snapshot_ttl_seconds: i64,
    max_live_ttl_seconds: i64,
    base_revision: i64,
}

impl PutPolicyBody {
    fn settings(&self) -> FileSharingSettings {
        FileSharingSettings {
            allow_public_snapshots: self.allow_public_snapshots,
            allow_live_grants: self.allow_live_grants,
            allow_protocol_credentials: self.allow_protocol_credentials,
            allow_live_write: self.allow_live_write,
            allow_agent_sharing: self.allow_agent_sharing,
            max_snapshot_ttl_seconds: self.max_snapshot_ttl_seconds,
            max_live_ttl_seconds: self.max_live_ttl_seconds,
        }
    }
}

/// Owners and admins save it; the save and its before/after are audited.
async fn put_policy(
    State(state): State<AppState>,
    Path(org_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<PutPolicyBody>,
) -> Result<Json<FileSharingPolicy>, Failure> {
    let (claims, _role) = crate::api::authorize_org_management(&state, &org_id, &headers).await?;
    let settings = body.settings();
    if let Some(reason) = settings.validate() {
        return Err(Failure::BadRequest(reason));
    }
    if body.base_revision < 0 {
        return Err(Failure::BadRequest(
            "baseRevision must not be negative".into(),
        ));
    }
    let before = effective_policy(state.file_sharing_store.as_ref(), &org_id).await?;
    let saved = state
        .file_sharing_store
        .put_file_sharing_policy(
            &org_id,
            settings,
            body.base_revision,
            claims.user_id.as_str(),
            (state.now)(),
        )
        .await?;
    state
        .store
        .append_authorization_audit(AuthorizationAuditEvent {
            id: format!("aud_{}", Uuid::new_v4().simple()),
            org_id: org_id.clone(),
            workspace_id: None,
            actor_user_id: claims.user_id.to_string(),
            target_user_id: None,
            invitation_id: None,
            action: "org.fileSharingPolicy.update".into(),
            old_role: None,
            new_role: None,
            reason: "org_management".into(),
            request_id: headers
                .get("x-request-id")
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned)
                .unwrap_or_else(|| format!("req_{}", Uuid::new_v4().simple())),
            grant_id: Some(claims.grant_id.to_string()),
            source: serde_json::json!({
                "resourceType": "file_sharing_policy",
                "resourceId": org_id,
                "policyRevision": saved.revision,
                "allowed": true,
                "before": before.settings,
                "after": saved.settings,
            }),
            created_at: (state.now)(),
        })
        .await?;
    Ok(Json(saved))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use cognia_tenant_auth::grant::{GrantClaims, GrantSigner};
    use cognia_tenant_auth::{OrgId, OrgRole, UserId};
    use std::sync::Arc;
    use std::time::Duration;
    use tower::ServiceExt;

    const ORG: &str = "org_acme00000000000000000";
    const OWNER: &str = "usr_aaaaaaaaaaaaaaaaaaaaaaaa";
    const MEMBER: &str = "usr_bbbbbbbbbbbbbbbbbbbbbbbb";
    const STRANGER: &str = "usr_cccccccccccccccccccccccc";

    fn settings() -> FileSharingSettings {
        FileSharingSettings {
            allow_public_snapshots: false,
            max_snapshot_ttl_seconds: 86_400,
            ..FileSharingSettings::default()
        }
    }

    #[test]
    fn defaults_keep_the_hard_to_undo_capabilities_off() {
        let policy = FileSharingPolicy::unset();
        assert_eq!(policy.revision, 0);
        assert!(policy.settings.allow_public_snapshots);
        assert!(!policy.settings.allow_protocol_credentials);
        assert!(!policy.settings.allow_live_write);
        assert!(!policy.settings.allow_agent_sharing);
        assert_eq!(policy.settings.validate(), None);
    }

    #[test]
    fn validation_bounds_ceilings_and_dependent_switches() {
        let mut too_short = settings();
        too_short.max_snapshot_ttl_seconds = 59;
        assert!(too_short
            .validate()
            .unwrap()
            .contains("maxSnapshotTtlSeconds"));
        let mut too_long = settings();
        too_long.max_live_ttl_seconds = MAX_TTL_SECONDS + 1;
        assert!(too_long.validate().unwrap().contains("maxLiveTtlSeconds"));
        let mut write_without_live = settings();
        write_without_live.allow_live_grants = false;
        write_without_live.allow_live_write = true;
        assert!(write_without_live.validate().is_some());
        let mut credentials_without_live = settings();
        credentials_without_live.allow_live_grants = false;
        credentials_without_live.allow_protocol_credentials = true;
        assert!(credentials_without_live.validate().is_some());
    }

    #[test]
    fn the_wire_shape_is_flat_camel_case() {
        let value = serde_json::to_value(FileSharingPolicy::unset()).unwrap();
        assert_eq!(value["allowPublicSnapshots"], true);
        assert_eq!(value["maxLiveTtlSeconds"], DEFAULT_MAX_LIVE_TTL_SECONDS);
        assert_eq!(value["revision"], 0);
        assert!(value.get("updatedBy").is_none());
        assert!(value.get("settings").is_none());
    }

    #[tokio::test]
    async fn saves_bump_the_revision_and_a_stale_save_conflicts() {
        let store = InMemoryFileSharingPolicyStore::new();
        assert_eq!(store.get_file_sharing_policy(ORG).await.unwrap(), None);
        let first = store
            .put_file_sharing_policy(ORG, settings(), 0, OWNER, 10)
            .await
            .unwrap();
        assert_eq!(first.revision, 1);
        assert_eq!(first.updated_by.as_deref(), Some(OWNER));
        let Err(StoreError::Conflict(current)) = store
            .put_file_sharing_policy(ORG, FileSharingSettings::default(), 0, OWNER, 11)
            .await
        else {
            panic!("a save from revision 0 after revision 1 must conflict");
        };
        assert_eq!(current["revision"], 1);
        assert_eq!(current["allowPublicSnapshots"], false);
        assert_eq!(
            effective_policy(&store, "org_other0000000000000000")
                .await
                .unwrap(),
            FileSharingPolicy::unset()
        );
    }

    fn app() -> (AppState, impl Fn(&str) -> String) {
        let store = crate::store::InMemoryStore::new();
        store.add_user(OWNER, "Owner");
        store.add_user(MEMBER, "Member");
        store.add_user(STRANGER, "Stranger");
        store.add_org_member(ORG, OWNER, OrgRole::Owner);
        store.add_org_member(ORG, MEMBER, OrgRole::Member);
        let signer = GrantSigner::new(&[5; 32]).unwrap();
        let mut state = AppState::new(
            Arc::new(store),
            signer.clone(),
            Arc::new(cognia_tenant_auth::oidc::TestAuthenticator),
        );
        state.now = Arc::new(|| 1_000);
        let grant = move |user: &str| {
            let claims = GrantClaims::issue(
                UserId::parse(user).unwrap(),
                OrgId::parse(ORG).unwrap(),
                None,
                None,
                Duration::from_secs(300),
            )
            .unwrap();
            format!("Bearer {}", signer.sign(&claims).unwrap())
        };
        (state, grant)
    }

    async fn call(
        state: &AppState,
        method: &str,
        auth: &str,
        body: Option<serde_json::Value>,
    ) -> (StatusCode, serde_json::Value) {
        let mut request = Request::builder()
            .method(method)
            .uri(format!("/v1/orgs/{ORG}/file-sharing-policy"))
            .header("authorization", auth);
        if body.is_some() {
            request = request.header("content-type", "application/json");
        }
        let response = routes()
            .with_state(state.clone())
            .oneshot(
                request
                    .body(body.map_or_else(Body::empty, |body| Body::from(body.to_string())))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null),
        )
    }

    fn put_body(base_revision: i64) -> serde_json::Value {
        let mut body = serde_json::to_value(settings()).unwrap();
        body["baseRevision"] = base_revision.into();
        body
    }

    #[tokio::test]
    async fn any_member_reads_the_defaults_until_one_is_saved() {
        let (state, grant) = app();
        let (status, body) = call(&state, "GET", &grant(MEMBER), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["revision"], 0);
        assert_eq!(body["allowPublicSnapshots"], true);
        let (status, _) = call(&state, "GET", &grant(STRANGER), None).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _) = call(&state, "GET", "Bearer nonsense", None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn only_owners_and_admins_save_and_every_save_is_audited() {
        let (state, grant) = app();
        let (status, _) = call(&state, "PUT", &grant(MEMBER), Some(put_body(0))).await;
        assert_eq!(status, StatusCode::FORBIDDEN);

        let (status, body) = call(&state, "PUT", &grant(OWNER), Some(put_body(0))).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["revision"], 1);
        assert_eq!(body["allowPublicSnapshots"], false);
        assert_eq!(body["updatedBy"], OWNER);

        let (status, read) = call(&state, "GET", &grant(MEMBER), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(read["maxSnapshotTtlSeconds"], 86_400);

        let audit = state.store.list_authorization_audit(ORG, 10).await.unwrap();
        let event = audit
            .iter()
            .find(|event| event.action == "org.fileSharingPolicy.update")
            .expect("the save is audited");
        assert_eq!(event.source["policyRevision"], 1);
        assert_eq!(event.source["before"]["allowPublicSnapshots"], true);
        assert_eq!(event.source["after"]["allowPublicSnapshots"], false);
    }

    #[tokio::test]
    async fn a_stale_or_invalid_save_is_refused() {
        let (state, grant) = app();
        call(&state, "PUT", &grant(OWNER), Some(put_body(0))).await;
        let (status, body) = call(&state, "PUT", &grant(OWNER), Some(put_body(0))).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["authoritative"]["revision"], 1);

        let mut invalid = put_body(1);
        invalid["maxLiveTtlSeconds"] = 5.into();
        let (status, _) = call(&state, "PUT", &grant(OWNER), Some(invalid)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);

        let mut unknown = put_body(1);
        unknown["allowEverything"] = true.into();
        let (status, _) = call(&state, "PUT", &grant(OWNER), Some(unknown)).await;
        assert!(status.is_client_error());
    }
}

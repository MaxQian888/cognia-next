//! Transaction-local feature admission. The request context carries only protocol
//! and deployment switches; policy and pinned contracts are always read by the
//! owning store under its lock, never cached in middleware.
use axum::{extract::{Request, State}, middleware::Next, response::{IntoResponse, Response}, http::{HeaderMap, StatusCode}, Json};
use crate::{api::AppState, rollout::{self, FeatureDecision, FeatureKey, FeaturePolicy, FeatureReason, FeatureState}, store::{PgStore, StoreError, Tables}};

pub const COLLAB_PROTOCOL_VERSION: u32 = 2;

#[derive(Clone, Copy, Debug)]
pub(crate) struct Context {
    pub client_contract: Option<u32>,
    chat: bool,
    canvas: bool,
}
impl Default for Context {
    fn default() -> Self { Self { client_contract: None, chat: true, canvas: true } }
}
tokio::task_local! { static CONTEXT: Context; }
pub(crate) fn context() -> Context { CONTEXT.try_with(|c| *c).unwrap_or_default() }
pub(crate) async fn scope<T>(context: Context, future: impl std::future::Future<Output = T>) -> T {
    CONTEXT.scope(context, future).await
}
pub(crate) async fn middleware(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let context = Context {
        client_contract: protocol(request.headers()), chat: state.shared_chat_enabled, canvas: state.canvas_enabled,
    };
    scope(context, next.run(request)).await
}
pub(crate) fn protocol(headers: &HeaderMap) -> Option<u32> {
    headers.get("x-cognia-collab-protocol").and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok())
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum Requirement { New, Write, ContractOnly }

pub(crate) fn refusal(key: FeatureKey, state: FeatureState, reason: FeatureReason) -> StoreError {
    StoreError::FeatureUnavailable(FeatureDecision { key, state, reason: Some(reason), policy_revision: 0 })
}
pub(crate) fn response(decision: FeatureDecision) -> Response {
    let retry = decision.reason == Some(FeatureReason::PolicyUnavailable);
    let mut response = (if retry { StatusCode::SERVICE_UNAVAILABLE } else { StatusCode::FORBIDDEN }, Json(serde_json::json!({
        "error": "feature_unavailable", "feature": decision.key, "state": decision.state, "reason": decision.reason,
    }))).into_response();
    if retry { response.headers_mut().insert("retry-after", "1".parse().expect("static header")); }
    response
}
fn evaluate(policies: &[FeaturePolicy], key: FeatureKey, org: &str, workspace: &str, visiting: &[FeatureKey]) -> FeatureDecision {
    if visiting.contains(&key) {
        return FeatureDecision { key, state: FeatureState::ExistingOnly, reason: Some(FeatureReason::PrerequisiteUnavailable), policy_revision: 0 };
    }
    let mut visiting = visiting.to_vec();
    visiting.push(key);
    let c = context();
    // Governance is client presentation only. Environment binding has no
    // collab-server route; its enforcement belongs to the Host (P1).
    let master = match key {
        FeatureKey::SharedChat | FeatureKey::SharedChatExecution => c.chat,
        FeatureKey::CanvasCollaboration => c.canvas,
        FeatureKey::OrgGovernance | FeatureKey::EnvironmentBinding => true,
    };
    rollout::evaluate(key, policies.iter().find(|p| p.feature_key == key), master, org, Some(workspace), c.client_contract,
        |dependency| evaluate(policies, dependency, org, workspace, &visiting).state)
}
fn check(policies: Result<&[FeaturePolicy], StoreError>, key: FeatureKey, org: &str, workspace: &str, contract: i32, requirement: Requirement) -> Result<(), StoreError> {
    if context().client_contract.is_some_and(|v| i64::from(v) < i64::from(contract)) {
        let feature = if key == FeatureKey::SharedChatExecution { FeatureKey::SharedChat } else { key };
        return Err(refusal(feature, FeatureState::ExistingOnly, FeatureReason::ClientContractUnsupported));
    }
    if matches!(requirement, Requirement::ContractOnly) { return Ok(()); }
    let decision = match policies {
        Ok(policies) => evaluate(policies, key, org, workspace, &[]),
        Err(_) => return Err(refusal(key, FeatureState::ExistingOnly, FeatureReason::PolicyUnavailable)),
    };
    let allowed = match requirement {
        Requirement::New => decision.state == FeatureState::Available,
        Requirement::Write => matches!(decision.state, FeatureState::Available | FeatureState::ExistingOnly),
        Requirement::ContractOnly => true,
    };
    if allowed { Ok(()) } else { Err(StoreError::FeatureUnavailable(decision)) }
}
pub(crate) fn memory(tables: &Tables, key: FeatureKey, org: &str, workspace: &str, contract: i32, requirement: Requirement) -> Result<(), StoreError> {
    let policies: Vec<_> = tables.feature_policies.values().cloned().collect();
    check(Ok(&policies), key, org, workspace, contract, requirement)
}
pub(crate) fn memory_chat(tables: &Tables, org: &str, session: &str, key: FeatureKey, requirement: Requirement) -> Result<(), StoreError> {
    let session = tables.chat.sessions.get(session).filter(|s| s.org_id == org).ok_or(StoreError::NotFound)?;
    memory(tables, key, org, &session.workspace_id, session.contract_version, requirement)
}
pub(crate) fn memory_canvas(tables: &Tables, org: &str, document: &str, requirement: Requirement) -> Result<(), StoreError> {
    let doc = tables.canvas.get(document).filter(|d| d.record.org_id == org).ok_or(StoreError::NotFound)?;
    memory(tables, FeatureKey::CanvasCollaboration, org, &doc.record.workspace_id, doc.record.contract_version, requirement)
}

impl PgStore {
    /// Reads policies on the caller's transaction, AFTER any resource-row lock.
    /// Policy SELECT errors become retryable refusals; the caller then drops
    /// the transaction. Recovery operations never read policy.
    pub(crate) async fn admit(&self, tx: &tokio_postgres::Transaction<'_>, key: FeatureKey, org: &str, workspace: &str, contract: i32, requirement: Requirement) -> Result<(), StoreError> {
        if matches!(requirement, Requirement::ContractOnly) { return check(Ok(&[]), key, org, workspace, contract, requirement); }
        // All deployment features and their transitive prerequisites come
        // from one statement snapshot, taken after the resource-row lock.
        match Self::feature_policies_in(tx).await {
            Ok(policies) => check(Ok(&policies), key, org, workspace, contract, requirement),
            Err(error) => check(Err(error), key, org, workspace, contract, requirement),
        }
    }
    pub(crate) async fn admit_chat(&self, tx: &tokio_postgres::Transaction<'_>, org: &str, session: &str, key: FeatureKey, requirement: Requirement) -> Result<(), StoreError> {
        let row = tx.query_opt("SELECT workspace_id, contract_version FROM chat_sessions WHERE org_id=$1 AND id=$2 FOR UPDATE", &[&org, &session]).await.map_err(|e| StoreError::Database(e.to_string()))?.ok_or(StoreError::NotFound)?;
        self.admit(tx, key, org, row.get("workspace_id"), row.get("contract_version"), requirement).await
    }
    pub(crate) async fn admit_canvas(&self, tx: &tokio_postgres::Transaction<'_>, org: &str, document: &str, requirement: Requirement) -> Result<(), StoreError> {
        let row = tx.query_opt("SELECT workspace_id, contract_version FROM canvas_documents WHERE org_id=$1 AND id=$2 FOR UPDATE", &[&org, &document]).await.map_err(|e| StoreError::Database(e.to_string()))?.ok_or(StoreError::NotFound)?;
        self.admit(tx, FeatureKey::CanvasCollaboration, org, row.get("workspace_id"), row.get("contract_version"), requirement).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn policy_failure_is_retryable_and_contract_pinning_precedes_policy() {
        let error = check(Err(StoreError::Database("private".into())), FeatureKey::SharedChat, "o", "w", 2, Requirement::New).unwrap_err();
        let StoreError::FeatureUnavailable(decision) = error else { panic!() };
        let response = response(decision);
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(response.headers()["retry-after"], "1");
        let body: serde_json::Value = serde_json::from_slice(&axum::body::to_bytes(response.into_body(), 1024).await.unwrap()).unwrap();
        assert_eq!(body, serde_json::json!({"error":"feature_unavailable", "feature":"shared-chat", "state":"existing-only", "reason":"policy_unavailable"}));
        scope(Context { client_contract: Some(2), ..Context::default() }, async {
            assert!(matches!(check(Ok(&[]), FeatureKey::SharedChatExecution, "o", "w", 3, Requirement::ContractOnly), Err(StoreError::FeatureUnavailable(d)) if d.key == FeatureKey::SharedChat && d.reason == Some(FeatureReason::ClientContractUnsupported)));
        }).await;
    }
    use std::{sync::Arc, time::Duration};
    use axum::{body::{Body, to_bytes}, http::Request};
    use tower::ServiceExt;
    use serde_json::{json, Value};
    use sha2::Digest;
    use cognia_tenant_auth::{grant::{GrantSigner, GrantClaims}, oidc::TestAuthenticator, OrgRole, WorkspaceRole, OrgId, UserId};
    use crate::{store::{InMemoryStore, Store}, chat::{SessionStatus, SessionRole}, chat_store::{NewSharedSession, NewChatRunLease, NewChatRunQueueItem, NewChatApprovalRequest, NewSessionEvent}, canvas_store::NewCanvasDocument};

    const ORG: &str = "org_acme00000000000000000";
    const OWNER: &str = "usr_aaaaaaaaaaaaaaaaaaaaaaaa";
    const MEMBER: &str = "usr_bbbbbbbbbbbbbbbbbbbbbbbb";
    const OUTSIDER: &str = "usr_cccccccccccccccccccccccc";
    struct Fixture { store: Arc<InMemoryStore>, state: AppState }
    impl Fixture {
        async fn new() -> Self {
            let store = Arc::new(InMemoryStore::new());
            store.add_workspace(ORG, "w", "Workspace");
            for user in [OWNER, MEMBER, OUTSIDER] {
                store.add_user(user, user);
                store.add_org_member(ORG, user, OrgRole::Member);
                store.add_workspace_member(ORG, "w", user, WorkspaceRole::Maintainer);
            }
            let mut state = AppState::new(store.clone(), GrantSigner::new(&[9;32]).unwrap(), Arc::new(TestAuthenticator));
            state.now = Arc::new(|| 10);
            state.chat_store.create_session(NewSharedSession {
                id: "s".into(), org_id: ORG.into(), workspace_id: "w".into(), title: "Shared".into(),
                status: SessionStatus::Active, created_by_user_id: OWNER.into(), now: 1, operation_id: "create".into(),
            }).await.unwrap();
            state.chat_store.put_member(ORG, "s", "w", MEMBER, SessionRole::Member, false, false, OWNER, 2).await.unwrap();
            state.chat_store.append_session_event(NewSessionEvent {
                tool_detail_revision: None,
                id: "message".into(), org_id: ORG.into(), workspace_id: "w".into(), session_id: "s".into(),
                kind: "message.created".into(), actor_kind: "human".into(), actor_id: OWNER.into(), actor_label: None,
                payload: json!({"messageId":"message", "role":"user", "parts":[]}), now: 3, operation_id: "message".into(),
            }).await.unwrap();
            state.canvas_store.create_document(NewCanvasDocument {
                id: "d".into(), org_id: ORG.into(), workspace_id: "w".into(), title: "Canvas".into(), language: "text".into(),
                created_by_user_id: OWNER.into(), created_at: 1, operation_id: "canvas".into(),
            }).await.unwrap();
            Self { store, state }
        }
        async fn policy(&self, key: FeatureKey, phase: rollout::Phase, kill: bool) {
            let mut policy = rollout::tests::policy();
            policy.feature_key = key; policy.phase = phase; policy.kill = kill;
            self.store.apply_feature_policy(policy, 0, key.as_str(), "test", "operator").await.unwrap();
        }
        async fn call(&self, method: &str, path: &str, user: &str, body: Value, protocol: Option<u32>) -> (StatusCode, Value) {
            let grant = GrantClaims::issue(UserId::parse(user).unwrap(), OrgId::parse(ORG).unwrap(), None, None, Duration::from_secs(300)).unwrap();
            let mut request = Request::builder().method(method).uri(format!("/v1/orgs/{ORG}/{path}"))
                .header("authorization", format!("Bearer {}", self.state.signer.sign(&grant).unwrap())).header("content-type", "application/json");
            if let Some(protocol) = protocol { request = request.header("x-cognia-collab-protocol", protocol); }
            if path.contains("runs/") { request = request.header("x-cognia-run-token", "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"); }
            let response = crate::router(self.state.clone()).oneshot(request.body(Body::from(body.to_string())).unwrap()).await.unwrap();
            let status = response.status();
            let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
        }
        async fn chat(&self, method: &str, suffix: &str, user: &str, body: Value) -> (StatusCode, Value) {
            self.call(method, &format!("chat-sessions/s{suffix}"), user, body, Some(2)).await
        }
        async fn execution(&self) {
            self.state.chat_store.enqueue_run_input(NewChatRunQueueItem {
                id:"q".into(), org_id:ORG.into(), workspace_id:"w".into(), session_id:"s".into(), requested_by_user_id:OWNER.into(),
                payload:json!({"messageId":"message"}), now:4, operation_id:"q".into(),
            }).await.unwrap();
            self.state.chat_store.acquire_run_lease(NewChatRunLease {
                id:"lease".into(), org_id:ORG.into(), workspace_id:"w".into(), session_id:"s".into(), run_id:"run".into(),
                holder_user_id:OWNER.into(), holder_device_id:"device".into(), token_hash:crate::chat_api::token_hash("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"),
                token_expires_at:1000, heartbeat_expires_at:1000, now:4, operation_id:"lease".into(),
            }).await.unwrap();
            self.state.chat_store.create_approval(NewChatApprovalRequest {
                id:"approval".into(), org_id:ORG.into(), workspace_id:"w".into(), session_id:"s".into(), run_id:"run".into(),
                action:"tool".into(), risk:"high".into(), requested_by_user_id:OWNER.into(), expires_at:1000, now:5, operation_id:"approval".into(),
            }).await.unwrap();
        }
    }
    #[tokio::test]
    async fn live_write_stops_when_deployment_is_off_but_terminal_can_drain() {
        use crate::chat_store::RunWrite;
        let f = Fixture::new().await;
        f.execution().await;
        scope(Context {chat:false,..Default::default()},async {
            assert!(matches!(f.state.chat_store.admit_live_frame(RunWrite {
                org_id:ORG,session_id:"s",run_id:"run",token_hash:&crate::chat_api::token_hash("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"),now:10,
            },"message",0).await,Err(StoreError::FeatureUnavailable(d)) if d.state==FeatureState::Off));
            f.state.chat_store.append_session_run_event(NewSessionEvent {
                tool_detail_revision:None,id:"terminal".into(),org_id:ORG.into(),workspace_id:"w".into(),session_id:"s".into(),
                kind:"run.completed".into(),actor_kind:"agent".into(),actor_id:"run:run".into(),actor_label:None,
                payload:json!({}),now:10,operation_id:"terminal".into(),
            },"run",&crate::chat_api::token_hash("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")).await.unwrap();
        }).await;
    }

    fn refused(result: &(StatusCode, Value), key: FeatureKey, reason: FeatureReason) {
        assert_eq!(result.0, StatusCode::FORBIDDEN, "{result:?}");
        assert_eq!(result.1["error"], "feature_unavailable");
        assert_eq!(result.1["feature"], json!(key));
        assert_eq!(result.1["reason"], json!(reason));
    }

    #[tokio::test]
    async fn router_shared_chat_admission_and_existing_writes_matrix() {
        for phase in [rollout::Phase::General, rollout::Phase::Paused] {
            for target in [Value::Null, json!(OUTSIDER)] {
                let f = Fixture::new().await;
                f.policy(FeatureKey::SharedChat, phase, false).await;
                let create = f.call("POST", "workspaces/w/chat-sessions", OWNER, json!({"title":"New", "operationId":"new"}), Some(2)).await;
                let invite = f.chat("POST", "/invites", OWNER, json!({"role":"member", "guest":true, "targetUserId":target, "expiresAt":1000}),).await;
                if phase == rollout::Phase::General { assert_eq!(create.0, StatusCode::CREATED); assert_eq!(invite.0, StatusCode::CREATED, "{invite:?}"); }
                else { refused(&create, FeatureKey::SharedChat, FeatureReason::FeaturePaused); refused(&invite, FeatureKey::SharedChat, FeatureReason::FeaturePaused); }
            }
        }
        let writes = [
            ("PATCH", "".to_owned(), json!({"title":"Edited", "operationId":"edit", "baseRevision":1})),
            ("POST", "/events".into(), json!({"kind":"message.created", "operationId":"post", "payload":{"messageId":"new", "role":"user", "parts":[]}})),
            ("POST", "/events".into(), json!({"kind":"message.corrected", "operationId":"edit-message", "payload":{"targetMessageId":"message", "role":"user", "parts":[]}})),
            ("POST", "/members".into(), json!({"userId":OUTSIDER,"role":"member","guest":true})),
            ("PATCH", format!("/members/{MEMBER}"), json!({"role":"viewer"})),
            ("POST", "/attachments".into(), json!({"fileName":"a.txt","mediaType":"text/plain","byteLength":1,"sha256":"0".repeat(64)})),
            ("PUT", "/file-host".into(), json!({"hostLabel":"Host"})),
        ];
        for (method, path, body) in writes {
            for kill in [false, true] {
                let f = Fixture::new().await;
                f.policy(FeatureKey::SharedChat, rollout::Phase::Paused, kill).await;
                let result = f.chat(method, &path, OWNER, body.clone()).await;
                if kill { refused(&result, FeatureKey::SharedChat, FeatureReason::FeatureKilled); }
                else { assert!(result.0.is_success(), "{method} {path}: {result:?}"); }
                let hidden = f.chat(method, &path, "usr_dddddddddddddddddddddddd", body.clone()).await;
                assert_eq!(hidden.0, StatusCode::NOT_FOUND, "{hidden:?}");
            }
        }
        let f = Fixture::new().await;
        // Conversion is the activation of an importing session.
        f.store.tables.write().chat.sessions.get_mut("s").unwrap().status = SessionStatus::Importing;
        f.policy(FeatureKey::SharedChat, rollout::Phase::Paused, false).await;
        refused(&f.chat("PATCH", "", OWNER, json!({"status":"active", "operationId":"convert", "baseRevision":1})).await, FeatureKey::SharedChat, FeatureReason::FeaturePaused);
    }

    #[tokio::test]
    async fn router_execution_admission_heartbeat_and_recovery_matrix() {
        for (method, path, body, admission) in [
            ("POST", "/runs/run/events", json!({"kind":"run.started", "operationId":"run-start", "payload":{}}), true),
            ("POST", "/runs/run/events", json!({"kind":"run.paused", "operationId":"run-pause", "payload":{}}), false),
            ("POST", "/queue", json!({"payload":{"messageId":"message"}, "operationId":"enqueue"}), true),
            ("POST", "/queue/claim", json!({"queueItemId":"q", "runId":"next", "deviceId":"device", "operationId":"claim", "token":"y".repeat(32), "takeover":true}), true),
            ("POST", "/run-leases", json!({"runId":"next", "deviceId":"device", "operationId":"start", "token":"y".repeat(32)}), true),
            ("PATCH", "/approvals/approval", json!({"status":"approved", "baseRevision":1}), true),
            ("POST", "/run-leases/lease/heartbeat", json!({"deviceId":"device", "token":"x".repeat(32)}), false),
            ("POST", "/approvals", json!({"runId":"run", "action":"tool", "risk":"ordinary", "expiresAt":1000, "operationId":"tool"}), false),
        ] {
            for (phase, kill) in [(rollout::Phase::General, false), (rollout::Phase::Paused, false), (rollout::Phase::General, true)] {
                let f = Fixture::new().await;
                f.execution().await;
                // Start/claim must not conflict with the fixture's active lease.
                if path == "/run-leases" || path == "/queue/claim" {
                    f.state.chat_store.release_run_lease(ORG,"s","lease",OWNER,"device",&crate::chat_api::token_hash(&"x".repeat(32)),6,"completed").await.unwrap();
                }
                f.policy(FeatureKey::SharedChatExecution, phase, kill).await;
                let result = f.chat(method,path,OWNER,body.clone()).await;
                if kill || (admission && phase == rollout::Phase::Paused) {
                    refused(&result,FeatureKey::SharedChatExecution,if kill { FeatureReason::FeatureKilled } else { FeatureReason::FeaturePaused });
                } else { assert!(result.0.is_success(), "{method} {path}: {result:?}"); }
                if !path.starts_with("/runs/") { assert_eq!(f.chat(method,path,OUTSIDER,body.clone()).await.0, StatusCode::NOT_FOUND); }
            }
        }
        let f = Fixture::new().await;
        f.execution().await;
        f.policy(FeatureKey::SharedChat, rollout::Phase::General, true).await;
        f.policy(FeatureKey::SharedChatExecution, rollout::Phase::General, true).await;
        for path in ["", "/events", "/members", "/queue", "/run-leases", "/export-authorization"] {
            assert!(f.chat("GET",path,OWNER,Value::Null).await.0.is_success(), "{path}");
        }
        assert!(f.chat("DELETE","/queue/q",OWNER,Value::Null).await.0.is_success());
        assert!(f.chat("POST","/runs/run/events",OWNER,json!({"kind":"run.completed", "operationId":"done", "payload":{}})).await.0.is_success());
        assert!(f.chat("PATCH","/approvals/approval",OWNER,json!({"status":"denied", "baseRevision":1})).await.0.is_success());
        assert!(f.chat("DELETE","/run-leases/lease?status=released",OWNER,json!({"deviceId":"device","token":"x".repeat(32)})).await.0.is_success());
        assert!(f.chat("DELETE",&format!("/members/{MEMBER}"),MEMBER,Value::Null).await.0.is_success());
        assert!(f.chat("DELETE","?operationId=delete&baseRevision=1",OWNER,Value::Null).await.0.is_success());
    }

    #[tokio::test]
    async fn router_canvas_admission_write_and_read_matrix_and_pinned_contracts() {
        let writes = [
            ("PATCH","",json!({"title":"Edited","baseRevision":1,"operationId":"rename"})),
            ("POST","/updates",json!({"update":"AQ==","operationId":"update"})),
            ("POST","/snapshots",json!({"snapshot":"AQ==","coversSequence":0})),
            ("POST","/comments",json!({"id":"comment", "anchor":"a","body":"comment","operationId":"comment"})),
            ("POST","/versions",json!({"id":"version", "label":"v1","content":"text","operationId":"version"})),
        ];
        for (phase,kill) in [(rollout::Phase::General,false),(rollout::Phase::Paused,false),(rollout::Phase::General,true)] {
            let f=Fixture::new().await;
            f.policy(FeatureKey::CanvasCollaboration,phase,kill).await;
            let result=f.call("POST","workspaces/w/canvas-documents",OWNER,json!({"id":"new", "title":"New","language":"text","operationId":"new"}),Some(2)).await;
            if kill || phase==rollout::Phase::Paused { refused(&result,FeatureKey::CanvasCollaboration,if kill {FeatureReason::FeatureKilled} else {FeatureReason::FeaturePaused}); }
            else {assert_eq!(result.0,StatusCode::CREATED,"{result:?}");}
            for (method,path,body) in &writes {
                let result=f.call(method,&format!("canvas-documents/d{path}"),OWNER,body.clone(),Some(2)).await;
                if kill {refused(&result,FeatureKey::CanvasCollaboration,FeatureReason::FeatureKilled);} else {assert!(result.0.is_success(),"{path}: {result:?}");}
            }
            f.store.tables.write().workspace_memberships.remove(&(ORG.into(), "w".into(), OUTSIDER.into()));
            let hidden = f.call("PATCH", "canvas-documents/d", OUTSIDER, json!({"title":"Hidden", "baseRevision":1,"operationId":"hidden"}), Some(2)).await;
            assert_eq!(hidden.0,StatusCode::NOT_FOUND,"{hidden:?}");
            for path in ["", "/updates", "/comments", "/versions", "/presence"] {
                assert!(f.call("GET",&format!("canvas-documents/d{path}"),OWNER,Value::Null,Some(2)).await.0.is_success());
            }
        }
        let f=Fixture::new().await;
        {
            let mut tables=f.store.tables.write();
            assert_eq!(tables.chat.sessions["s"].contract_version,2);
            assert_eq!(tables.canvas["d"].record.contract_version,2);
            tables.chat.sessions.get_mut("s").unwrap().contract_version=3;
            tables.canvas.get_mut("d").unwrap().record.contract_version=3;
        }
        for (path,feature) in [("chat-sessions/s",FeatureKey::SharedChat),("canvas-documents/d",FeatureKey::CanvasCollaboration)] {
            assert!(f.call("GET",path,OWNER,Value::Null,Some(2)).await.0.is_success());
            refused(&f.call("PATCH",path,OWNER,json!({"title":"Old","baseRevision":1,"operationId":"old"}),Some(2)).await,feature,FeatureReason::ClientContractUnsupported);
        }
        assert_eq!(f.call("GET","chat-sessions/s",OWNER,Value::Null,None).await.0,StatusCode::UPGRADE_REQUIRED);
        assert!(f.call("PATCH","canvas-documents/d",OWNER,json!({"title":"Legacy","baseRevision":1,"operationId":"legacy"}),None).await.0.is_success());
        assert!(f.call("PATCH","chat-sessions/s",OWNER,json!({"title":"Current","baseRevision":1,"operationId":"current"}),Some(3)).await.0.is_success());
    }

    #[tokio::test]
    async fn router_attachment_commit_and_tickets_enforce_shared_chat_writes() {
        use crate::chat_store::NewChatAttachment;
        for kill in [false, true] {
            let f = Fixture::new().await;
            f.state.chat_store.create_attachment(NewChatAttachment {
                id:"attachment".into(), org_id:ORG.into(), workspace_id:"w".into(), session_id:"s".into(), object_key:"object".into(),
                file_name:"a.txt".into(), media_type:"text/plain".into(), byte_length:1, sha256:hex::encode(sha2::Sha256::digest(b"a")),
                created_by_user_id:OWNER.into(), now:4,
            }).await.unwrap();
            f.state.chat_attachments.put("object", axum::body::Bytes::from_static(b"a")).await.unwrap();
            f.policy(FeatureKey::SharedChat, rollout::Phase::Paused, kill).await;
            for path in ["/attachments/attachment/upload-ticket", "/attachments/attachment/commit"] {
                let result=f.chat("POST",path,OWNER,json!({})).await;
                if kill {refused(&result,FeatureKey::SharedChat,FeatureReason::FeatureKilled);}
                else {assert!(result.0.is_success(),"{path}: {result:?}");}
            }
        }
    }

    #[tokio::test]
    async fn evaluation_consumes_one_owned_snapshot_for_transitive_prerequisites() {
        let store = InMemoryStore::new();
        let mut root = rollout::tests::policy();
        root.feature_key = FeatureKey::SharedChatExecution;
        root.requires = vec![FeatureKey::SharedChat];
        let mut middle = rollout::tests::policy();
        middle.requires = vec![FeatureKey::CanvasCollaboration];
        let mut leaf = rollout::tests::policy();
        leaf.feature_key = FeatureKey::CanvasCollaboration;
        leaf.phase = rollout::Phase::Paused;
        for policy in [&root, &middle, &leaf] {
            store.apply_feature_policy(policy.clone(),0,policy.feature_key.as_str(),"test","operator").await.unwrap();
        }
        let before = store.feature_policies().await.unwrap();
        // Neither committed snapshot allows admission; mixing the old root
        // with the new leaf would manufacture an available state.
        root.phase = rollout::Phase::Paused;
        leaf.phase = rollout::Phase::General;
        {
            let mut tables = store.tables.write();
            tables.feature_policies.insert(root.feature_key, root);
            tables.feature_policies.insert(leaf.feature_key, leaf.clone());
        }
        let after = store.feature_policies().await.unwrap();
        assert_eq!(evaluate(&before,FeatureKey::SharedChatExecution,"org","ws",&[]).reason,Some(FeatureReason::PrerequisiteUnavailable));
        assert_eq!(evaluate(&after,FeatureKey::SharedChatExecution,"org","ws",&[]).reason,Some(FeatureReason::FeaturePaused));
        let mut hybrid = before.clone();
        let leaf_key = leaf.feature_key;
        *hybrid.iter_mut().find(|p| p.feature_key == leaf_key).unwrap() = leaf;
        assert_eq!(evaluate(&hybrid,FeatureKey::SharedChatExecution,"org","ws",&[]).state,FeatureState::Available);
        assert!(check(Ok(&before),FeatureKey::SharedChatExecution,"org","ws",2,Requirement::New).is_err());
    }

}

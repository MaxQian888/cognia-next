//! Request-scoped capability projection shared by public and Host routes.

use axum::{extract::{Path, Query, State}, http::{header::CACHE_CONTROL, HeaderMap}, response::{IntoResponse, Response}, Json};
use cognia_tenant_auth::{actions::{actions_for, org_actions_for, Action}, membership::{resolve_workspace_access, WorkspaceAccessVia}, OrgRole, WorkspaceRole};
use serde::{Deserialize, Serialize};

use crate::{api::{authorization, AppState, Failure}, auth::{readable_scope, verify_grant, WorkspaceScope}, rollout::{self, FeatureDecision, FeatureKey, FeaturePolicy, FeatureReason, FeatureState}, store::{Membership, StoreError}};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Standing {
    pub org_role: Option<OrgRole>,
    pub workspace_role: Option<WorkspaceRole>,
    pub via: Option<WorkspaceAccessVia>,
    pub guest: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilitiesResponse {
    pub schema_version: u32,
    pub org_id: String,
    pub workspace_id: Option<String>,
    pub standing: Standing,
    pub actions: Vec<Action>,
    pub features: Vec<FeatureDecision>,
    pub evaluated_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CapabilitiesQuery {
    workspace_id: Option<String>,
}

/// A hidden workspace response must never be retained by shared or private caches.
pub(crate) fn no_store(response: impl IntoResponse) -> Response {
    let mut response = response.into_response();
    response.headers_mut().insert(CACHE_CONTROL, "private, no-store".parse().expect("static header"));
    response
}

pub(crate) async fn capabilities(
    State(state): State<AppState>, Path(org_id): Path<String>,
    headers: HeaderMap, Query(query): Query<CapabilitiesQuery>,
) -> Response {
    no_store(public_capabilities(&state, org_id, headers, query).await)
}

async fn public_capabilities(
    state: &AppState, org_id: String, headers: HeaderMap, query: CapabilitiesQuery,
) -> Result<Json<CapabilitiesResponse>, Failure> {
    let claims = verify_grant(&state.signer, authorization(&headers), &org_id).await?;
    let scope = readable_scope(state.store.as_ref(), &claims).await?;
    if let Some(workspace_id) = &query.workspace_id {
        let visible = match &scope { WorkspaceScope::All => None, WorkspaceScope::Only(ids) => Some(ids.as_slice()) };
        if !state.store.list_workspaces(&org_id, visible).await?.iter().any(|w| w.id == *workspace_id) {
            return Err(StoreError::NotFound.into());
        }
    }
    let membership = state.store.membership(&org_id, claims.user_id.as_str(), query.workspace_id.as_deref()).await?;
    let access = resolve_workspace_access(membership.org_role, membership.workspace_role);
    let client_contract = headers.get("x-cognia-collab-protocol").and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok());
    Ok(Json(CapabilitiesResponse {
        schema_version: 1,
        features: feature_decisions(state, &org_id, query.workspace_id.as_deref(), client_contract).await,
        actions: actions_for(membership.org_role, membership.workspace_role),
        standing: Standing {
            org_role: membership.org_role,
            workspace_role: access.map(|a| a.role),
            via: access.map(|a| a.via),
            guest: access.is_some_and(|a| a.guest),
        },
        org_id, workspace_id: query.workspace_id, evaluated_at: (state.now)(),
    }))
}

pub(crate) fn scoped_actions(membership: &Membership, workspace: bool) -> Vec<Action> {
    if workspace { actions_for(membership.org_role, membership.workspace_role) }
    else { org_actions_for(membership.org_role) }
}

pub(crate) async fn feature_decisions(
    state: &AppState, org_id: &str, workspace_id: Option<&str>, client_contract: Option<u32>,
) -> Vec<FeatureDecision> {
    let policies = state.store.feature_policies().await;
    project_features(state, policies.as_deref(), org_id, workspace_id, client_contract)
}

fn project_features(
    state: &AppState, policies: Result<&[FeaturePolicy], &StoreError>,
    org_id: &str, workspace_id: Option<&str>, client_contract: Option<u32>,
) -> Vec<FeatureDecision> {
    FeatureKey::ALL.into_iter().map(|key| match &policies {
        Ok(policies) => evaluate_feature(state, policies, key, org_id, workspace_id, client_contract, &[]),
        Err(_) => FeatureDecision { key, state: FeatureState::ExistingOnly, reason: Some(FeatureReason::PolicyUnavailable), policy_revision: 0 },
    }).collect()
}

fn evaluate_feature(
    state: &AppState, policies: &[FeaturePolicy], key: FeatureKey,
    org_id: &str, workspace_id: Option<&str>, client_contract: Option<u32>, visiting: &[FeatureKey],
) -> FeatureDecision {
    let policy = policies.iter().find(|p| p.feature_key == key);
    if visiting.contains(&key) {
        return FeatureDecision { key, state: FeatureState::ExistingOnly, reason: Some(FeatureReason::PrerequisiteUnavailable), policy_revision: policy.map_or(0, |p| p.revision) };
    }
    let mut visiting = visiting.to_vec();
    visiting.push(key);
    let master = match key {
        FeatureKey::SharedChat | FeatureKey::SharedChatExecution => state.shared_chat_enabled,
        FeatureKey::CanvasCollaboration => state.canvas_enabled,
        FeatureKey::OrgGovernance | FeatureKey::EnvironmentBinding => true,
    };
    rollout::evaluate(key, policy, master, org_id, workspace_id, client_contract, |dependency| {
        evaluate_feature(state, policies, dependency, org_id, workspace_id, client_contract, &visiting).state
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use crate::{rollout::tests::policy, store::InMemoryStore};
    use cognia_tenant_auth::{grant::GrantSigner, oidc::TestAuthenticator};

    fn state() -> AppState {
        AppState::new(Arc::new(InMemoryStore::new()), GrantSigner::new(&[9;32]).unwrap(), Arc::new(TestAuthenticator))
    }

    #[test]
    fn policy_failure_is_a_per_feature_closed_decision() {
        let state = state();
        let error = StoreError::Database("private database failure".into());
        let decisions = project_features(&state, Err(&error), "org_alpha", None, None);
        assert_eq!(decisions.len(), FeatureKey::ALL.len());
        for (decision, key) in decisions.iter().zip(FeatureKey::ALL) {
            assert_eq!(decision.key, key);
            assert_eq!(decision.state, FeatureState::ExistingOnly);
            assert_eq!(decision.reason, Some(FeatureReason::PolicyUnavailable));
            assert_eq!(decision.policy_revision, 0);
        }
        assert!(!serde_json::to_string(&decisions).unwrap().contains("private database"));
    }

    #[test]
    fn process_master_switches_and_recursive_dependencies_and_cycles() {
        let mut state = state();
        state.shared_chat_enabled = false;
        state.canvas_enabled = false;
        let decisions = project_features(&state, Ok(&[]), "org_alpha", None, None);
        for (index, decision) in decisions.iter().enumerate() {
            assert_eq!(decision.state, if index < 3 { FeatureState::Off } else { FeatureState::Available });
            assert_eq!(decision.reason, if index < 3 { Some(FeatureReason::DeploymentDisabled) } else { None });
        }
        let mut a = policy();
        a.feature_key = FeatureKey::OrgGovernance;
        a.requires = vec![FeatureKey::EnvironmentBinding];
        let mut b = policy();
        b.feature_key = FeatureKey::EnvironmentBinding;
        b.requires = vec![FeatureKey::SharedChat];
        let decisions = project_features(&state, Ok(&[a.clone(), b.clone()]), "org_alpha", None, None);
        assert_eq!(decisions[3].reason, Some(FeatureReason::PrerequisiteUnavailable));
        assert_eq!(decisions[4].reason, Some(FeatureReason::PrerequisiteUnavailable));
        b.requires = vec![FeatureKey::OrgGovernance];
        let decisions = project_features(&state, Ok(&[a, b]), "org_alpha", None, None);
        assert_eq!(decisions[3].reason, Some(FeatureReason::PrerequisiteUnavailable));
        assert_eq!(decisions[4].reason, Some(FeatureReason::PrerequisiteUnavailable));
    }

    #[test]
    fn contract_example_round_trips_exactly() {
        let contract: serde_json::Value = serde_json::from_str(include_str!("../../../protocol/collab-capabilities-v1.json")).unwrap();
        let response: CapabilitiesResponse = serde_json::from_value(contract["exampleResponse"].clone()).unwrap();
        assert_eq!(serde_json::to_value(response).unwrap(), contract["exampleResponse"]);
    }
}

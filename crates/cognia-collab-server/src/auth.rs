//! The request authorization chain — ADR-0149 §8.
//!
//! Decision 11 of ADR-0149 says a new service adopts the grant pattern
//! `services/diagnostic-server` proved rather than inventing another one. This
//! is that chain, with the one thing that service could not have: a person.
//!
//! ```text
//!   bearer grant  →  GrantClaims (user, org, workspace, role)
//!                 →  membership lookup, scoped to the org
//!                 →  resolve_workspace_access  (org-admin traversal, guest)
//!                 →  capability check
//! ```
//!
//! # Why the grant's role is not trusted on its own
//!
//! `GrantClaims` carries the role resolved at mint time, and the grant's short
//! TTL bounds how stale that can be. It is still re-derived from storage here
//! rather than read off the token, because a grant minted for one workspace
//! must not authorize another: the claim says what the bearer was granted, the
//! lookup says what they may do *on this request's target*. Trusting the claim
//! alone would make a workspace id in the path a suggestion.

use cognia_tenant_auth::{
    grant::{GrantClaims, GrantError, GrantSigner},
    membership::{resolve_workspace_access, EffectiveWorkspaceAccess},
    WorkspaceCapability,
};

use crate::store::{Store, StoreError};

#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("missing bearer credentials")]
    MissingCredentials,
    #[error("grant rejected: {0}")]
    Grant(#[from] GrantError),
    #[error("the grant is scoped to org `{granted}`, not `{requested}`")]
    WrongOrg { granted: String, requested: String },
    #[error("no access to this workspace")]
    Forbidden,
    #[error("storage unavailable: {0}")]
    Store(#[from] StoreError),
}

/// Who is making this request, and what they may do on its target.
#[derive(Debug, Clone)]
pub struct Caller {
    pub user_id: String,
    pub org_id: String,
    pub access: EffectiveWorkspaceAccess,
}

/// Pull the token out of an `Authorization: Bearer …` header.
///
/// Case-insensitive on the scheme, because HTTP says the scheme is, and a
/// client sending `bearer` is not the failure worth being strict about.
pub fn bearer_token(header: Option<&str>) -> Result<&str, AuthError> {
    let header = header.ok_or(AuthError::MissingCredentials)?;
    let (scheme, token) = header
        .split_once(' ')
        .ok_or(AuthError::MissingCredentials)?;
    if !scheme.eq_ignore_ascii_case("bearer") || token.trim().is_empty() {
        return Err(AuthError::MissingCredentials);
    }
    Ok(token.trim())
}

/// Step one: prove who is calling, and that their grant is for this org.
///
/// Deliberately separate from the workspace check. A route that must read a row
/// before it knows which workspace to check against needs "this is a valid
/// caller for this org" as its own answer — folding the two together is how
/// `patch` ends up asking whether the caller is an *org admin* and refusing
/// every ordinary workspace member who was about to edit their own issue.
pub async fn verify_grant(
    signer: &GrantSigner,
    header: Option<&str>,
    org_id: &str,
) -> Result<GrantClaims, AuthError> {
    let claims: GrantClaims = signer.verify(bearer_token(header)?)?;
    if claims.org_id.as_str() != org_id {
        return Err(AuthError::WrongOrg {
            granted: claims.org_id.to_string(),
            requested: org_id.to_owned(),
        });
    }
    Ok(claims)
}

/// Step two: resolve what this caller may do in `workspace_id`.
pub async fn authorize_workspace(
    store: &dyn Store,
    claims: &GrantClaims,
    workspace_id: &str,
    required: WorkspaceCapability,
) -> Result<Caller, AuthError> {
    let membership = store
        .membership(
            claims.org_id.as_str(),
            claims.user_id.as_str(),
            Some(workspace_id),
        )
        .await?;
    let access = resolve_workspace_access(membership.org_role, membership.workspace_role)
        .ok_or(AuthError::Forbidden)?;
    if !access.allows(required) {
        return Err(AuthError::Forbidden);
    }
    Ok(Caller {
        user_id: claims.user_id.to_string(),
        org_id: claims.org_id.to_string(),
        access,
    })
}

/// Which workspaces in this org the caller may read.
///
/// An org owner or admin traverses everything ([`OrgRole::can_traverse_workspaces`]);
/// everyone else sees exactly the workspaces they were recruited into, which
/// for a guest is a non-empty set with no org membership behind it.
pub async fn readable_scope(
    store: &dyn Store,
    claims: &GrantClaims,
) -> Result<WorkspaceScope, AuthError> {
    let org_id = claims.org_id.as_str();
    let user_id = claims.user_id.as_str();
    let membership = store.membership(org_id, user_id, None).await?;

    if membership
        .org_role
        .is_some_and(cognia_tenant_auth::OrgRole::can_traverse_workspaces)
    {
        return Ok(WorkspaceScope::All);
    }

    let workspaces = store.list_workspace_memberships(org_id, user_id).await?;
    if workspaces.is_empty() && membership.org_role.is_none() {
        // Neither in the org nor in any of its workspaces: an outsider holding
        // a grant for an org they have since been removed from.
        return Err(AuthError::Forbidden);
    }
    Ok(WorkspaceScope::Only(workspaces))
}

/// The set of workspaces a listing may draw from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkspaceScope {
    /// Org owner or admin — traversal, per ADR-0149 §4.
    All,
    /// Exactly these. Empty is a legitimate answer: an org member who has not
    /// been recruited into anything sees an empty board, not an error.
    Only(Vec<String>),
}

/// Verify a grant and resolve workspace access in one step, for the routes that
/// know their target workspace up front.
pub async fn authorize(
    signer: &GrantSigner,
    store: &dyn Store,
    header: Option<&str>,
    org_id: &str,
    workspace_id: &str,
    required: WorkspaceCapability,
) -> Result<Caller, AuthError> {
    let claims = verify_grant(signer, header, org_id).await?;
    authorize_workspace(store, &claims, workspace_id, required).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    use cognia_tenant_auth::membership::WorkspaceAccessVia;
    use cognia_tenant_auth::{OrgId, OrgRole, UserId, WorkspaceRole};

    use crate::store::InMemoryStore;

    fn ada() -> UserId {
        UserId::parse("usr_aaaaaaaaaaaaaaaaaaaaaaaa").unwrap()
    }

    fn org() -> OrgId {
        OrgId::parse("org_acme00000000000000000").unwrap()
    }

    fn signer() -> GrantSigner {
        GrantSigner::new(&[3; 32]).unwrap()
    }

    fn grant_for(workspace: Option<&str>) -> String {
        let claims = GrantClaims::issue(
            ada(),
            org(),
            workspace.map(str::to_owned),
            Some(WorkspaceRole::Member),
            Duration::from_secs(300),
        )
        .unwrap();
        signer().sign(&claims).unwrap()
    }

    fn header(token: &str) -> String {
        format!("Bearer {token}")
    }

    #[test]
    fn bearer_parsing_refuses_everything_that_is_not_a_bearer_token() {
        assert!(bearer_token(None).is_err());
        assert!(bearer_token(Some("token-without-scheme")).is_err());
        assert!(bearer_token(Some("Basic abc")).is_err());
        assert!(bearer_token(Some("Bearer   ")).is_err());
        assert_eq!(bearer_token(Some("Bearer abc")).unwrap(), "abc");
        // HTTP says the scheme is case-insensitive.
        assert_eq!(bearer_token(Some("bearer abc")).unwrap(), "abc");
    }

    #[tokio::test]
    async fn a_workspace_member_clears_the_write_bar() {
        let store = InMemoryStore::new();
        store.add_org_member(org().as_str(), ada().as_str(), OrgRole::Member);
        store.add_workspace_member(
            org().as_str(),
            "proj-1",
            ada().as_str(),
            WorkspaceRole::Member,
        );

        let caller = authorize(
            &signer(),
            &store,
            Some(&header(&grant_for(Some("proj-1")))),
            org().as_str(),
            "proj-1",
            WorkspaceCapability::Write,
        )
        .await
        .unwrap();
        assert_eq!(caller.user_id, ada().as_str());
        assert_eq!(caller.access.via, WorkspaceAccessVia::Membership);
        assert!(!caller.access.guest);
    }

    #[tokio::test]
    async fn a_valid_grant_for_another_workspace_is_still_forbidden_here() {
        // The reason the role is re-derived rather than read off the claim: a
        // path segment must not be a suggestion.
        let store = InMemoryStore::new();
        store.add_org_member(org().as_str(), ada().as_str(), OrgRole::Member);
        store.add_workspace_member(
            org().as_str(),
            "proj-1",
            ada().as_str(),
            WorkspaceRole::Maintainer,
        );

        let error = authorize(
            &signer(),
            &store,
            Some(&header(&grant_for(Some("proj-1")))),
            org().as_str(),
            "proj-other",
            WorkspaceCapability::Read,
        )
        .await
        .unwrap_err();
        assert!(matches!(error, AuthError::Forbidden));
    }

    #[tokio::test]
    async fn a_grant_for_another_org_is_refused_before_any_lookup() {
        let store = InMemoryStore::new();
        let error = authorize(
            &signer(),
            &store,
            Some(&header(&grant_for(Some("proj-1")))),
            "org_somebodyelse00000000",
            "proj-1",
            WorkspaceCapability::Read,
        )
        .await
        .unwrap_err();
        assert!(matches!(error, AuthError::WrongOrg { .. }));
    }

    #[tokio::test]
    async fn an_org_admin_traverses_but_a_plain_member_does_not() {
        let store = InMemoryStore::new();
        store.add_org_member(org().as_str(), ada().as_str(), OrgRole::Admin);

        let caller = authorize(
            &signer(),
            &store,
            Some(&header(&grant_for(Some("proj-never-joined")))),
            org().as_str(),
            "proj-never-joined",
            WorkspaceCapability::Manage,
        )
        .await
        .unwrap();
        assert_eq!(caller.access.via, WorkspaceAccessVia::OrgAdmin);

        let demoted = InMemoryStore::new();
        demoted.add_org_member(org().as_str(), ada().as_str(), OrgRole::Member);
        assert!(matches!(
            authorize(
                &signer(),
                &demoted,
                Some(&header(&grant_for(Some("proj-never-joined")))),
                org().as_str(),
                "proj-never-joined",
                WorkspaceCapability::Read,
            )
            .await
            .unwrap_err(),
            AuthError::Forbidden
        ));
    }

    #[tokio::test]
    async fn a_viewer_may_read_but_not_write() {
        let store = InMemoryStore::new();
        store.add_org_member(org().as_str(), ada().as_str(), OrgRole::Member);
        store.add_workspace_member(
            org().as_str(),
            "proj-1",
            ada().as_str(),
            WorkspaceRole::Viewer,
        );

        let token = grant_for(Some("proj-1"));
        assert!(authorize(
            &signer(),
            &store,
            Some(&header(&token)),
            org().as_str(),
            "proj-1",
            WorkspaceCapability::Read,
        )
        .await
        .is_ok());
        assert!(matches!(
            authorize(
                &signer(),
                &store,
                Some(&header(&token)),
                org().as_str(),
                "proj-1",
                WorkspaceCapability::Write,
            )
            .await
            .unwrap_err(),
            AuthError::Forbidden
        ));
    }

    #[tokio::test]
    async fn a_grant_the_claim_says_is_a_maintainer_is_still_only_a_viewer_in_storage() {
        // The claim is not the authority. Storage is.
        let store = InMemoryStore::new();
        store.add_org_member(org().as_str(), ada().as_str(), OrgRole::Member);
        store.add_workspace_member(
            org().as_str(),
            "proj-1",
            ada().as_str(),
            WorkspaceRole::Viewer,
        );

        let inflated = GrantClaims::issue(
            ada(),
            org(),
            Some("proj-1".into()),
            Some(WorkspaceRole::Maintainer),
            Duration::from_secs(300),
        )
        .unwrap();
        let token = signer().sign(&inflated).unwrap();

        assert!(matches!(
            authorize(
                &signer(),
                &store,
                Some(&header(&token)),
                org().as_str(),
                "proj-1",
                WorkspaceCapability::Manage,
            )
            .await
            .unwrap_err(),
            AuthError::Forbidden
        ));
    }

    #[tokio::test]
    async fn a_guest_holds_workspace_access_without_org_membership() {
        let store = InMemoryStore::new();
        store.add_workspace_member(
            org().as_str(),
            "proj-1",
            ada().as_str(),
            WorkspaceRole::Member,
        );

        let caller = authorize(
            &signer(),
            &store,
            Some(&header(&grant_for(Some("proj-1")))),
            org().as_str(),
            "proj-1",
            WorkspaceCapability::Write,
        )
        .await
        .unwrap();
        assert!(caller.access.guest);
    }

    #[tokio::test]
    async fn a_forged_or_absent_grant_never_reaches_storage() {
        let store = InMemoryStore::new();
        store.add_org_member(org().as_str(), ada().as_str(), OrgRole::Owner);

        for header_value in [None, Some("Bearer forged.token")] {
            let error = authorize(
                &signer(),
                &store,
                header_value,
                org().as_str(),
                "proj-1",
                WorkspaceCapability::Read,
            )
            .await
            .unwrap_err();
            assert!(
                matches!(error, AuthError::MissingCredentials | AuthError::Grant(_)),
                "{error}"
            );
        }
    }
}

//! Collapsing two membership layers into one answer — ADR-0149 §4.
//!
//! # This is the authorization decision
//!
//! `lib/db/identity.ts` carries a deliberate warning on its TypeScript
//! counterpart: `resolveWorkspaceAccessFor` is a **UI affordance**, used to
//! decide whether to grey a button out, and it reads a Dexie projection the
//! renderer itself writes. It is not, and must never become, the gate.
//!
//! This function is the gate. It runs on the side of the wire that owns the
//! membership rows, and a caller who has one of these values has an answer
//! that a compromised renderer cannot manufacture.
//!
//! # The resolution order is load-bearing
//!
//! Org owner/admin is an organization-wide management floor. A direct
//! Workspace role can add context but cannot remove the audit/offboarding
//! authority the organization assigned. Plain Org membership alone grants
//! nothing.

use serde::{Deserialize, Serialize};

use crate::roles::{OrgRole, WorkspaceCapability, WorkspaceRole};

/// How someone came to have access. The difference matters in an audit log:
/// "was recruited" and "is an org admin" are very different sentences.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkspaceAccessVia {
    Membership,
    OrgAdmin,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveWorkspaceAccess {
    pub role: WorkspaceRole,
    pub capability: WorkspaceCapability,
    pub via: WorkspaceAccessVia,
    /// A guest holds Workspace membership **without** Org membership.
    ///
    /// Derived on every read, never stored. A stored flag would be a second
    /// source of truth that goes stale the moment somebody is promoted into
    /// the Org, and the stale value would be the one guarding the door.
    pub guest: bool,
}

impl EffectiveWorkspaceAccess {
    pub fn allows(&self, required: WorkspaceCapability) -> bool {
        self.capability.permits(required)
    }
}

/// Resolve the effective access one person has in one workspace.
///
/// `None` means no access at all — which is also what an absent workspace
/// membership plus a plain Org `member` produces.
pub fn resolve_workspace_access(
    org_membership: Option<OrgRole>,
    workspace_membership: Option<WorkspaceRole>,
) -> Option<EffectiveWorkspaceAccess> {
    if org_membership.is_some_and(OrgRole::can_traverse_workspaces) {
        return Some(EffectiveWorkspaceAccess {
            role: WorkspaceRole::Maintainer,
            capability: WorkspaceCapability::Manage,
            via: WorkspaceAccessVia::OrgAdmin,
            guest: false,
        });
    }

    if let Some(role) = workspace_membership {
        return Some(EffectiveWorkspaceAccess {
            role,
            capability: role.capability(),
            via: WorkspaceAccessVia::Membership,
            guest: org_membership.is_none(),
        });
    }

    None
}

/// Does this access clear the bar? Absent access never does.
///
/// Prefer this over reaching into the struct: it is the one place the
/// `None`-means-denied rule lives, and a call site that writes
/// `access.map(...).unwrap_or(true)` by accident is a hole.
pub fn allows_capability(
    access: Option<&EffectiveWorkspaceAccess>,
    required: WorkspaceCapability,
) -> bool {
    access.is_some_and(|access| access.allows(required))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn org_membership_alone_grants_nothing() {
        assert!(resolve_workspace_access(Some(OrgRole::Member), None).is_none());
        assert!(resolve_workspace_access(None, None).is_none());
    }

    #[test]
    fn an_org_admin_traverses_into_a_workspace_they_were_never_recruited_into() {
        for role in [OrgRole::Owner, OrgRole::Admin] {
            let access = resolve_workspace_access(Some(role), None).unwrap();
            assert_eq!(access.role, WorkspaceRole::Maintainer);
            assert_eq!(access.capability, WorkspaceCapability::Manage);
            assert_eq!(access.via, WorkspaceAccessVia::OrgAdmin);
            assert!(!access.guest);
        }
    }

    #[test]
    fn org_admin_management_is_never_downgraded_by_a_workspace_role() {
        let access =
            resolve_workspace_access(Some(OrgRole::Admin), Some(WorkspaceRole::Viewer)).unwrap();
        assert_eq!(access.role, WorkspaceRole::Maintainer);
        assert_eq!(access.capability, WorkspaceCapability::Manage);
        assert_eq!(access.via, WorkspaceAccessVia::OrgAdmin);
        assert!(access.allows(WorkspaceCapability::Manage));
    }

    #[test]
    fn a_guest_is_workspace_membership_without_org_membership() {
        let guest = resolve_workspace_access(None, Some(WorkspaceRole::Member)).unwrap();
        assert!(guest.guest);
        assert_eq!(guest.via, WorkspaceAccessVia::Membership);
        assert!(guest.allows(WorkspaceCapability::Write));

        // The same workspace role held by an org member is not a guest.
        let member =
            resolve_workspace_access(Some(OrgRole::Member), Some(WorkspaceRole::Member)).unwrap();
        assert!(!member.guest);
        assert_eq!(member.role, guest.role);
    }

    #[test]
    fn promotion_into_the_org_stops_someone_being_a_guest_with_no_second_write() {
        // Guest is derived, so the only thing that changed is the org row.
        let before = resolve_workspace_access(None, Some(WorkspaceRole::Maintainer)).unwrap();
        let after =
            resolve_workspace_access(Some(OrgRole::Member), Some(WorkspaceRole::Maintainer))
                .unwrap();
        assert!(before.guest);
        assert!(!after.guest);
        assert_eq!(before.role, after.role);
    }

    #[test]
    fn absent_access_is_denied_rather_than_permitted() {
        assert!(!allows_capability(None, WorkspaceCapability::Read));
        let viewer = resolve_workspace_access(None, Some(WorkspaceRole::Viewer)).unwrap();
        assert!(allows_capability(Some(&viewer), WorkspaceCapability::Read));
        assert!(!allows_capability(
            Some(&viewer),
            WorkspaceCapability::Manage
        ));
    }

    #[test]
    fn every_combination_of_the_two_ladders_resolves_the_same_way_twice() {
        // Cheap total-coverage sweep: 4 org states x 4 workspace states.
        let org_states = [
            None,
            Some(OrgRole::Owner),
            Some(OrgRole::Admin),
            Some(OrgRole::Member),
        ];
        let workspace_states = [
            None,
            Some(WorkspaceRole::Maintainer),
            Some(WorkspaceRole::Member),
            Some(WorkspaceRole::Viewer),
        ];
        let mut granted = 0;
        for org in org_states {
            for workspace in workspace_states {
                let first = resolve_workspace_access(org, workspace);
                assert_eq!(first, resolve_workspace_access(org, workspace));
                if first.is_some() {
                    granted += 1;
                }
            }
        }
        // 12 workspace memberships + owner/admin traversal on the empty column.
        assert_eq!(granted, 14);
    }

    /// Parity guard: the TypeScript resolver is the same decision rendered for
    /// the UI, and the two disagreeing means a button is enabled that the
    /// server will refuse (or worse, greyed out when the server would allow).
    #[test]
    fn stays_in_step_with_the_typescript_resolver() {
        let source = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../types/identity/index.ts"),
        )
        .expect("types/identity/index.ts is the specification for this module");
        // The three rules this module implements, as they appear there.
        assert!(
            source.contains("guest: !orgMembership"),
            "guest is no longer derived from the absence of org membership"
        );
        assert!(
            source.contains("via: \"org-admin\""),
            "the org-admin traversal branch changed"
        );
        assert!(
            source.contains("return role === \"owner\" || role === \"admin\""),
            "canTraverseWorkspaces changed which org roles may traverse"
        );
    }
}

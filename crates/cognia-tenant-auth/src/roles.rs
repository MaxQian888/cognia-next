//! The two role ladders ADR-0149 §4 froze, and the capability they grant.
//!
//! There are deliberately **two** ladders rather than one. An Org role and a
//! Workspace role are not points on a shared scale: an Org `member` has no
//! workspace access whatsoever, while a Workspace `viewer` has read access to
//! one workspace and nothing else. Collapsing them into a single enum would
//! force one of those two facts to be expressed as an exception.
//!
//! Ranking is by declaration order, most privileged first, so a permission
//! check is a comparison instead of a lookup table someone has to keep in sync.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("`{value}` is not a valid {ladder} role")]
pub struct RoleParseError {
    pub ladder: &'static str,
    pub value: String,
}

/// Roles inside an Org, most privileged first.
///
/// `Admin` may traverse into any Workspace in the Org. ADR-0149 §4 rejected
/// hiding a Workspace from its own Org's admin: off-boarding, audit and
/// compliance all need a way in, and a product that forbids it grows a
/// back door instead.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OrgRole {
    Owner,
    Admin,
    Member,
}

/// Roles inside a Workspace, most privileged first.
///
/// Recruited independently of the Org — the Linear model. ADR-0149 §4 rejected
/// the Notion model where an Org role cascades down into every workspace,
/// because a cascade can only ever over-grant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceRole {
    Maintainer,
    Member,
    Viewer,
}

/// What a Workspace role lets you do, ranked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceCapability {
    Read,
    Write,
    Manage,
}

impl OrgRole {
    pub const ALL: [Self; 3] = [Self::Owner, Self::Admin, Self::Member];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Owner => "owner",
            Self::Admin => "admin",
            Self::Member => "member",
        }
    }

    pub fn parse(value: &str) -> Result<Self, RoleParseError> {
        Self::ALL
            .into_iter()
            .find(|role| role.as_str() == value)
            .ok_or_else(|| RoleParseError {
                ladder: "org",
                value: value.to_owned(),
            })
    }

    /// True when the role may enter a Workspace it was never recruited into.
    pub fn can_traverse_workspaces(self) -> bool {
        matches!(self, Self::Owner | Self::Admin)
    }

    /// True when `self` is at least as privileged as `required`.
    pub fn permits(self, required: Self) -> bool {
        self <= required
    }
}

impl WorkspaceRole {
    pub const ALL: [Self; 3] = [Self::Maintainer, Self::Member, Self::Viewer];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Maintainer => "maintainer",
            Self::Member => "member",
            Self::Viewer => "viewer",
        }
    }

    pub fn parse(value: &str) -> Result<Self, RoleParseError> {
        Self::ALL
            .into_iter()
            .find(|role| role.as_str() == value)
            .ok_or_else(|| RoleParseError {
                ladder: "workspace",
                value: value.to_owned(),
            })
    }

    pub fn capability(self) -> WorkspaceCapability {
        match self {
            Self::Maintainer => WorkspaceCapability::Manage,
            Self::Member => WorkspaceCapability::Write,
            Self::Viewer => WorkspaceCapability::Read,
        }
    }

    /// True when `self` is at least as privileged as `required`.
    pub fn permits(self, required: Self) -> bool {
        self <= required
    }
}

impl WorkspaceCapability {
    pub const ALL: [Self; 3] = [Self::Read, Self::Write, Self::Manage];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Write => "write",
            Self::Manage => "manage",
        }
    }

    /// True when this capability clears the bar `required` sets.
    pub fn permits(self, required: Self) -> bool {
        self >= required
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn org_membership_alone_never_reaches_a_workspace() {
        // The single most load-bearing fact in the model: being in the Org is
        // not being in a Workspace.
        assert!(!OrgRole::Member.can_traverse_workspaces());
        assert!(OrgRole::Admin.can_traverse_workspaces());
        assert!(OrgRole::Owner.can_traverse_workspaces());
    }

    #[test]
    fn ladders_rank_by_declaration_order() {
        assert!(OrgRole::Owner.permits(OrgRole::Admin));
        assert!(!OrgRole::Member.permits(OrgRole::Admin));
        assert!(WorkspaceRole::Maintainer.permits(WorkspaceRole::Viewer));
        assert!(!WorkspaceRole::Viewer.permits(WorkspaceRole::Member));
        // Reflexive: a role always permits itself.
        for role in WorkspaceRole::ALL {
            assert!(role.permits(role));
        }
    }

    #[test]
    fn capabilities_rank_the_other_way_and_still_compare_correctly() {
        assert!(WorkspaceCapability::Manage.permits(WorkspaceCapability::Read));
        assert!(!WorkspaceCapability::Read.permits(WorkspaceCapability::Write));
        for capability in WorkspaceCapability::ALL {
            assert!(capability.permits(capability));
        }
    }

    #[test]
    fn every_workspace_role_maps_to_a_capability() {
        assert_eq!(
            WorkspaceRole::Maintainer.capability(),
            WorkspaceCapability::Manage
        );
        assert_eq!(
            WorkspaceRole::Member.capability(),
            WorkspaceCapability::Write
        );
        assert_eq!(
            WorkspaceRole::Viewer.capability(),
            WorkspaceCapability::Read
        );
    }

    #[test]
    fn wire_form_round_trips_through_the_typescript_spelling() {
        for role in OrgRole::ALL {
            let json = serde_json::to_string(&role).unwrap();
            assert_eq!(json, format!("\"{}\"", role.as_str()));
            assert_eq!(OrgRole::parse(role.as_str()).unwrap(), role);
            assert_eq!(serde_json::from_str::<OrgRole>(&json).unwrap(), role);
        }
        for role in WorkspaceRole::ALL {
            let json = serde_json::to_string(&role).unwrap();
            assert_eq!(json, format!("\"{}\"", role.as_str()));
            assert_eq!(WorkspaceRole::parse(role.as_str()).unwrap(), role);
        }
        for capability in WorkspaceCapability::ALL {
            assert_eq!(
                serde_json::to_string(&capability).unwrap(),
                format!("\"{}\"", capability.as_str())
            );
        }
    }

    #[test]
    fn parsing_names_the_ladder_it_rejected_from() {
        // "member" is valid in both ladders, so an error that does not say
        // which ladder it came from is unactionable.
        assert_eq!(OrgRole::parse("maintainer").unwrap_err().ladder, "org");
        assert_eq!(
            WorkspaceRole::parse("owner").unwrap_err().ladder,
            "workspace"
        );
        assert!(OrgRole::parse("member").is_ok());
        assert!(WorkspaceRole::parse("member").is_ok());
    }

    /// Parity guard against `types/identity/index.ts`, which is the frozen
    /// specification. A peer reordering or renaming a rung there must reorder
    /// or rename it here.
    #[test]
    fn stays_in_step_with_the_typescript_ladders() {
        let source = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../types/identity/index.ts"),
        )
        .expect("types/identity/index.ts is the specification for this module");
        let expected_org = format!(
            "ORG_ROLES = [{}] as const",
            OrgRole::ALL
                .map(|role| format!("\"{}\"", role.as_str()))
                .join(", ")
        );
        let expected_workspace = format!(
            "WORKSPACE_ROLES = [{}] as const",
            WorkspaceRole::ALL
                .map(|role| format!("\"{}\"", role.as_str()))
                .join(", ")
        );
        let expected_capabilities = format!(
            "WORKSPACE_CAPABILITIES = [{}] as const",
            WorkspaceCapability::ALL
                .map(|capability| format!("\"{}\"", capability.as_str()))
                .join(", ")
        );
        for expected in [expected_org, expected_workspace, expected_capabilities] {
            assert!(
                source.contains(&expected),
                "the TypeScript ladders changed; expected to find `{expected}`"
            );
        }
    }
}

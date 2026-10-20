//! Fixed action presets derived from effective workspace standing.

use serde::{Deserialize, Serialize};
use crate::{resolve_workspace_access, OrgRole, WorkspaceCapability, WorkspaceRole};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Action {
    #[serde(rename = "org.members.manage")]
    OrgMembersManage,
    #[serde(rename = "org.admins.manage")]
    OrgAdminsManage,
    #[serde(rename = "org.ownership.transfer")]
    OrgOwnershipTransfer,
    #[serde(rename = "org.policy.manage")]
    OrgPolicyManage,
    #[serde(rename = "host.global-surfaces")]
    HostGlobalSurfaces,
    #[serde(rename = "workspace.read")]
    WorkspaceRead,
    #[serde(rename = "workspace.write")]
    WorkspaceWrite,
    #[serde(rename = "workspace.members.manage")]
    WorkspaceMembersManage,
    #[serde(rename = "workspace.settings.manage")]
    WorkspaceSettingsManage,
    #[serde(rename = "execution.request")]
    ExecutionRequest,
    #[serde(rename = "environment.use")]
    EnvironmentUse,
    #[serde(rename = "environment.manage")]
    EnvironmentManage,
    #[serde(rename = "credential.use")]
    CredentialUse,
    #[serde(rename = "credential.manage")]
    CredentialManage,
    #[serde(rename = "publish")]
    Publish,
    #[serde(rename = "host.workspace-surfaces")]
    HostWorkspaceSurfaces,
}

impl Action {
    pub const ALL: [Self; 16] = [
        Self::OrgMembersManage,
        Self::OrgAdminsManage,
        Self::OrgOwnershipTransfer,
        Self::OrgPolicyManage,
        Self::HostGlobalSurfaces,
        Self::WorkspaceRead,
        Self::WorkspaceWrite,
        Self::WorkspaceMembersManage,
        Self::WorkspaceSettingsManage,
        Self::ExecutionRequest,
        Self::EnvironmentUse,
        Self::EnvironmentManage,
        Self::CredentialUse,
        Self::CredentialManage,
        Self::Publish,
        Self::HostWorkspaceSurfaces,
    ];
}

/// Contract order, with traversal resolved before capability and guest checks.
pub fn actions_for(org_role: Option<OrgRole>, workspace_role: Option<WorkspaceRole>) -> Vec<Action> {
    let access = resolve_workspace_access(org_role, workspace_role);
    Action::ALL.into_iter().filter(|action| {
        use Action::*;
        use WorkspaceCapability::*;
        let (minimum, guest_allowed) = match action {
            OrgMembersManage | OrgPolicyManage | HostGlobalSurfaces => {
                return org_role.is_some_and(OrgRole::can_traverse_workspaces);
            }
            OrgAdminsManage | OrgOwnershipTransfer => return org_role == Some(OrgRole::Owner),
            WorkspaceRead => (Read, true),
            WorkspaceWrite | ExecutionRequest | EnvironmentUse => (Write, true),
            CredentialUse | Publish => (Write, false),
            WorkspaceMembersManage | WorkspaceSettingsManage | EnvironmentManage
                | CredentialManage | HostWorkspaceSurfaces => (Manage, false),
        };
        access.is_some_and(|access| access.allows(minimum) && (!access.guest || guest_allowed))
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    #[test]
    fn contract_actions_and_every_preset_are_pinned() {
        let contract: Value = serde_json::from_str(include_str!("../../../protocol/collab-capabilities-v1.json")).unwrap();
        let actions: Vec<_> = contract["actions"].as_array().unwrap().iter().map(|a| a["action"].clone()).collect();
        assert_eq!(json!(Action::ALL), json!(actions));
        for action in Action::ALL {
            assert_eq!(serde_json::from_value::<Action>(json!(action)).unwrap(), action);
        }
        for vector in contract["presetVectors"].as_array().unwrap() {
            let org = serde_json::from_value(vector["orgRole"].clone()).unwrap();
            let workspace = serde_json::from_value(vector["workspaceRole"].clone()).unwrap();
            assert_eq!(json!(actions_for(org, workspace)), vector["actions"], "{vector}");
        }
        // Pin the rule metadata too, across all 16 combinations of standing.
        for org in [None, Some(OrgRole::Owner), Some(OrgRole::Admin), Some(OrgRole::Member)] {
            for workspace in [None, Some(WorkspaceRole::Maintainer), Some(WorkspaceRole::Member), Some(WorkspaceRole::Viewer)] {
                let access = resolve_workspace_access(org, workspace);
                let expected: Vec<_> = contract["actions"].as_array().unwrap().iter().filter(|a| {
                    if a["scope"] == "org" {
                        org.is_some_and(|role| a["orgRoles"].as_array().unwrap().contains(&json!(role)))
                    } else {
                        let minimum = serde_json::from_value(a["minimumCapability"].clone()).unwrap();
                        access.is_some_and(|access| access.allows(minimum) && (!access.guest || a["guestAllowed"] == true))
                    }
                }).map(|a| a["action"].clone()).collect();
                assert_eq!(json!(actions_for(org, workspace)), json!(expected));
            }
        }
    }
}

//! Multi-tenant Host admission policy. The protocol file is the authority.
//! Workspace actions intentionally use their org fallback until P4 provides
//! a Host-owned root-to-workspace resolver; a client workspace id is not one.

use std::collections::BTreeMap;

use once_cell::sync::Lazy;
use serde::{Deserialize, Deserializer};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Ord, PartialOrd)]
#[serde(rename_all = "kebab-case")]
pub enum SurfaceClass {
    Client,
    OperatorOnly,
    OrgAction,
    WorkspaceAction,
    SandboxedExecution,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurfacePolicy {
    pub class: SurfaceClass,
    pub action: Option<String>,
    pub fallback_org_action: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NonExecutionCommand {
    pub arm: String,
    pub reason: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostSurfacePolicy {
    #[serde(rename = "$comment")]
    pub comment: String,
    pub schema_version: u32,
    /// Intentionally dormant: workspace-action always uses fallbackOrgAction
    /// in P1. This wire label also makes the limitation visible to consumers.
    pub workspace_resolution: String,
    /// Only homogeneous execution capabilities; mixed capabilities are
    /// classified by descriptor arm so control-plane reads remain available.
    pub execution_capabilities: Vec<String>,
    pub execution_commands: Vec<String>,
    pub non_execution_commands: Vec<NonExecutionCommand>,
    /// Host-global arms hidden behind mixed client capabilities. Applied only
    /// in multi-tenant mode, before the capability's standing classification.
    #[serde(deserialize_with = "unique_map")]
    pub command_overrides: BTreeMap<String, SurfacePolicy>,
    #[serde(deserialize_with = "unique_map")]
    pub classes: BTreeMap<SurfaceClass, String>,
    #[serde(deserialize_with = "unique_map")]
    pub capabilities: BTreeMap<String, SurfacePolicy>,
    #[serde(deserialize_with = "unique_map")]
    pub socket_channels: BTreeMap<String, SurfacePolicy>,
}

fn unique_map<'de, D, K, V>(deserializer: D) -> Result<BTreeMap<K, V>, D::Error>
where
    D: Deserializer<'de>,
    K: Deserialize<'de> + Ord,
    V: Deserialize<'de>,
{
    struct Visitor<K, V>(std::marker::PhantomData<(K, V)>);
    impl<'de, K: Deserialize<'de> + Ord, V: Deserialize<'de>> serde::de::Visitor<'de>
        for Visitor<K, V>
    {
        type Value = BTreeMap<K, V>;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("a map with unique keys")
        }
        fn visit_map<M: serde::de::MapAccess<'de>>(self, mut map: M) -> Result<Self::Value, M::Error> {
            let mut result = BTreeMap::new();
            while let Some((key, value)) = map.next_entry()? {
                if result.insert(key, value).is_some() {
                    return Err(serde::de::Error::custom("duplicate policy entry"));
                }
            }
            Ok(result)
        }
    }
    deserializer.deserialize_map(Visitor(std::marker::PhantomData))
}

impl HostSurfacePolicy {
    pub fn executes(&self, capability: &str) -> bool {
        self.execution_capabilities.iter().any(|value| value == capability)
    }

    pub fn command_executes(&self, capability: &str, arm: Option<&str>) -> bool {
        self.executes(capability)
            || arm.is_some_and(|arm| self.execution_commands.iter().any(|entry| entry == arm))
    }

    pub fn get(&self, capability: &str) -> Option<&SurfacePolicy> {
        self.capabilities.get(capability).or_else(|| self.socket_channels.get(capability))
    }
}

pub const POLICY_JSON: &str = include_str!("../../../protocol/host-surface-policy.json");
pub static POLICY: Lazy<Result<HostSurfacePolicy, serde_json::Error>> =
    Lazy::new(|| serde_json::from_str(POLICY_JSON));

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn every_manifest_capability_has_exactly_one_policy() {
        let policy = POLICY.as_ref().unwrap();
        let manifest: serde_json::Value = serde_json::from_str(include_str!(
            "../../../protocol/companion-commands.json"
        )).unwrap();
        let capabilities: BTreeSet<_> = manifest["commands"].as_array().unwrap().iter()
            .map(|command| command["capability"].as_str().unwrap()).collect();
        assert_eq!(capabilities, policy.capabilities.keys().map(String::as_str).collect());
        assert_eq!(policy.schema_version, 1);
        assert_eq!(policy.classes.len(), 5);
        for entry in policy.capabilities.values().chain(policy.socket_channels.values()) {
            assert!(policy.classes.contains_key(&entry.class));
            match entry.class {
                SurfaceClass::OrgAction | SurfaceClass::SandboxedExecution => {
                    assert!(entry.action.as_ref().is_some_and(|action| !action.is_empty()));
                }
                SurfaceClass::WorkspaceAction => {
                    assert_eq!(entry.fallback_org_action.as_deref(), Some("host.global-surfaces"));
                }
                _ => {}
            }
        }
        assert!(policy.socket_channels.keys().all(|key| !policy.capabilities.contains_key(key)));
    }

    #[test]
    fn workspace_resolution_is_explicitly_dormant_until_p4() {
        assert_eq!(POLICY.as_ref().unwrap().workspace_resolution, "fallback-only-until-P4");
    }

    fn manifest() -> serde_json::Value {
        serde_json::from_str(include_str!("../../../protocol/companion-commands.json")).unwrap()
    }

    #[test]
    fn execution_inventory_is_real_unique_disjoint_and_exhaustive_for_suspicious_arms() {
        let policy = POLICY.as_ref().unwrap();
        let manifest = manifest();
        let commands = manifest["commands"].as_array().unwrap();
        let arms: BTreeSet<_> = commands.iter().map(|command| command["arm"].as_str().unwrap()).collect();
        let execution: BTreeSet<_> = policy.execution_commands.iter().map(String::as_str).collect();
        let exceptions: BTreeSet<_> = policy.non_execution_commands.iter().map(|entry| entry.arm.as_str()).collect();
        assert_eq!(execution.len(), policy.execution_commands.len());
        assert_eq!(exceptions.len(), policy.non_execution_commands.len());
        assert!(execution.is_subset(&arms));
        assert!(exceptions.is_subset(&arms));
        assert!(execution.is_disjoint(&exceptions));
        assert!(policy.non_execution_commands.iter().all(|entry| !entry.reason.trim().is_empty()));
        let capabilities: BTreeSet<_> = policy.execution_capabilities.iter().map(String::as_str).collect();
        assert_eq!(capabilities.len(), policy.execution_capabilities.len());
        // All five proposed manifest capabilities mix execution with reads or
        // cleanup. Only the worker-only stream capability remains homogeneous.
        assert_eq!(capabilities, BTreeSet::from(["agent.worker"]));
        for capability in &capabilities { assert!(policy.get(capability).is_some()); }
        let patterns = ["spawn", "exec", "run", "terminal", "pty", "shell", "process", "install", "activate", "launch", "start", "hook", "python", "script"];
        for command in commands {
            let arm = command["arm"].as_str().unwrap();
            let capability = command["capability"].as_str().unwrap();
            if capabilities.contains(capability) {
                assert!(!exceptions.contains(arm), "mixed execution capability {capability}: {arm}");
            }
            if patterns.iter().any(|pattern| arm.contains(pattern)) {
                assert!(policy.command_executes(capability, Some(arm)) || exceptions.contains(arm),
                    "unreviewed execution candidate {arm}");
            }
        }
        for arm in ["shell_exec", "sandbox_exec", "canvas_run_python", "acp_terminal_create", "ssh_terminal_spawn", "plugin_cli_exec", "run_agent_hook", "scheduled_task_run_now", "scheduler_run_task_now", "git_commit", "remote_desktop_session_open", "siwc_spawn_app_server", "browser_local_start", "plugin_set_enabled", "plugin_cogset_activate"] {
            assert!(execution.contains(arm), "{arm}");
        }
        for arm in ["terminal_host_status", "terminal_complete_paths", "plugin_list", "workflow_run_list", "execution_run_get", "host_runtime_status", "plugin_install_origin_record"] {
            assert!(!execution.contains(arm), "control-plane command {arm}");
        }
    }

    #[test]
    fn command_overrides_reference_real_arms_and_never_weaken_standing() {
        let policy = POLICY.as_ref().unwrap();
        let manifest = manifest();
        for (arm, entry) in &policy.command_overrides {
            let command = manifest["commands"].as_array().unwrap().iter()
                .find(|command| command["arm"].as_str() == Some(arm.as_str())).expect("real override arm");
            let base = policy.get(command["capability"].as_str().unwrap()).unwrap();
            // Client has no standing constraint. For every other base, only
            // an identical constraint is accepted here; changing authority
            // domains needs an explicit review, not an invented total order.
            assert!(base.class == SurfaceClass::Client || (base.class == entry.class
                && base.action == entry.action && base.fallback_org_action == entry.fallback_org_action), "{arm} weakens standing");
            assert_eq!(entry.class, SurfaceClass::OrgAction);
            assert_eq!(entry.action.as_deref(), Some("host.global-surfaces"));
        }
        assert_eq!(policy.command_overrides.keys().map(String::as_str).collect::<BTreeSet<_>>(),
            BTreeSet::from(["plugin_set_enabled", "plugin_cogset_activate", "plugin_install_origin_record", "mcp_set_enabled", "mcp_set_tool_rules", "skill_set_enabled", "adapter_update_policy", "app_settings_update"]));
    }

    #[test]
    fn unknown_fields_classes_and_duplicate_entries_are_refused() {
        for json in [
            POLICY_JSON.replace("\"schemaVersion\"", "\"unknown\""),
            POLICY_JSON.replace("\"client\"", "\"unknown-class\""),
            POLICY_JSON.replace("\"client.local\":", "\"client.read\":"),
        ] {
            assert!(serde_json::from_str::<HostSurfacePolicy>(&json).is_err());
        }
    }
}

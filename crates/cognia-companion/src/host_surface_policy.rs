//! Multi-tenant Host admission policy. The protocol file is the authority.
//! Workspace actions retain their org fallback. Container execution resolves
//! explicit creation scopes and immutable Host-owned records; Host-brain
//! execution remains intentionally unavailable in multi-tenant mode.

use std::collections::BTreeMap;

use once_cell::sync::Lazy;
use serde::{Deserialize, Deserializer};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Ord, PartialOrd)]
#[serde(rename_all = "kebab-case")]
pub enum SurfaceClass {
    Client,
    /// Host-side per-user stores require a server-installed person fleet (P5).
    /// Bound multi-tenant people route only to their own partition; without
    /// a fleet they are refused. The operator service retains existing access
    /// after command override resolution.
    HostData,
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
#[serde(deny_unknown_fields)]
pub struct PersonHostStateCommand {
    pub arm: String,
    pub capability: String,
    pub reason: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostSurfacePolicy {
    #[serde(rename = "$comment")]
    pub comment: String,
    pub schema_version: u32,
    /// Container execution uses Host-owned bindings. Raw workspace-action
    /// roots still use fallbackOrgAction; Host-brain execution is dormant.
    pub workspace_resolution: String,
    /// Only homogeneous execution capabilities; mixed capabilities are
    /// classified by descriptor arm so control-plane reads remain available.
    pub execution_capabilities: Vec<String>,
    pub execution_commands: Vec<String>,
    pub non_execution_commands: Vec<NonExecutionCommand>,
    /// P6c keeps this empty: pet arms route to the headless person brain.
    pub person_model_commands: Vec<NonExecutionCommand>,
    /// P6c closed loopback channel, separate from service authority.
    pub person_brain_commands: Vec<NonExecutionCommand>,
    /// P5d tenant-only data arms, enabled only with an installed person fleet.
    pub person_host_state_commands: Vec<PersonHostStateCommand>,
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
    pub fn person_brain_admits(&self, arm: &str) -> bool {
        self.person_brain_commands.iter().any(|entry| entry.arm == arm)
    }

    pub fn person_host_state_capability(&self, arm: &str) -> Option<&str> {
        self.person_host_state_commands.iter().find(|entry| entry.arm == arm)
            .map(|entry| entry.capability.as_str())
    }

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
    fn p5d_host_state_inventory_is_real_unique_and_partition_only() {
        let policy = POLICY.as_ref().unwrap();
        let manifest = manifest();
        let expected = BTreeMap::from([
            ("host_state_status", "client.read"), ("host_state_snapshot", "client.read"),
            ("host_state_submit", "client.write"), ("host_feature_manifest", "client.read"),
            ("session_attach", "client.read"), ("session_detach", "client.read"),
            ("session_mark_read", "client.write"), ("session_mark_unread", "client.write"),
        ]);
        assert_eq!(policy.person_host_state_commands.len(), expected.len());
        for entry in &policy.person_host_state_commands {
            assert_eq!(expected.get(entry.arm.as_str()).copied(), Some(entry.capability.as_str()));
            assert!(!entry.reason.trim().is_empty());
            assert!(!policy.command_overrides.contains_key(&entry.arm));
            let command = manifest["commands"].as_array().unwrap().iter()
                .find(|command| command["arm"].as_str() == Some(entry.arm.as_str())).unwrap();
            assert_eq!(policy.get(command["capability"].as_str().unwrap()).unwrap().class, SurfaceClass::WorkspaceAction);
        }
        assert_eq!(policy.person_host_state_commands.iter().map(|entry| entry.arm.as_str()).collect::<BTreeSet<_>>(), expected.keys().copied().collect());
    }

    #[test]
    fn p6c_pet_routes_to_headless_person_without_changing_global_overrides() {
        let policy = POLICY.as_ref().unwrap();
        assert!(policy.person_model_commands.is_empty());
        assert!(policy.comment.contains("P6c emptied personModelCommands"));
        assert_eq!(policy.person_brain_commands.iter().map(|entry| entry.arm.as_str()).collect::<BTreeSet<_>>(),
            BTreeSet::from(["person_model_ticket_mint", "agent_send", "agent_interrupt", "agent_close_session",
                "person_agent_lease_prepare", "person_agent_policy_get", "spawn_external_agent", "send_to_external_agent", "get_external_agent_status", "kill_external_agent"]));
        assert!(policy.person_brain_commands.iter().all(|entry| !entry.reason.is_empty()));
        assert_eq!(policy.command_overrides.len(), 8);
        assert!(policy.command_overrides.values().all(|entry| entry.action.as_deref() == Some("host.global-surfaces")));
    }

    #[test]
    fn p6e_person_allowlist_is_exact() {
        p6c_pet_routes_to_headless_person_without_changing_global_overrides();
        let policy = POLICY.as_ref().unwrap();
        for arm in ["spawn_external_agent", "get_external_agent_status", "kill_external_agent", "person_agent_lease_prepare", "person_agent_policy_get", "send_to_external_agent"] {
            assert!(policy.person_brain_admits(arm));
        }
        assert!(!policy.person_brain_admits("agent_approve"));
    }

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
        assert_eq!(policy.classes.len(), 6);
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
    fn workspace_resolution_labels_container_binding_and_host_brain_dormancy() {
        assert_eq!(POLICY.as_ref().unwrap().workspace_resolution, "container-record-bindings;workspace-actions-fallback;host-brain-execution-unavailable");
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
            // The pinned Host-global exceptions are configuration rather than
            // per-user data. Other bases must retain identical constraints;
            // there is no total ordering between these authority domains.
            assert!(base.class == SurfaceClass::HostData || (base.class == entry.class
                && base.action == entry.action && base.fallback_org_action == entry.fallback_org_action), "{arm} changes standing");
            assert_eq!(entry.class, SurfaceClass::OrgAction);
            assert_eq!(entry.action.as_deref(), Some("host.global-surfaces"));
        }
        assert_eq!(policy.command_overrides.keys().map(String::as_str).collect::<BTreeSet<_>>(),
            BTreeSet::from(["plugin_set_enabled", "plugin_cogset_activate", "plugin_install_origin_record", "mcp_set_enabled", "mcp_set_tool_rules", "skill_set_enabled", "adapter_update_policy", "app_settings_update"]));
    }

    #[test]
    fn host_data_policy_pins_dormant_capabilities_and_loads_the_new_class() {
        let policy: HostSurfacePolicy = serde_json::from_str(POLICY_JSON).unwrap();
        assert_eq!(policy.classes.len(), 6);
        // P5: served from the caller's own partition; without a fleet (desktop,
        // or a server that failed to install one) the class stays inert.
        let description = &policy.classes[&SurfaceClass::HostData];
        assert!(description.contains("Person-partitioned"));
        assert!(description.contains("403 host_data_unpartitioned"));
        assert!(description.contains("execution_isolation_unavailable"));
        assert_eq!(policy.capabilities.iter().filter(|(_, entry)| entry.class == SurfaceClass::HostData)
            .map(|(name, _)| name.as_str()).collect::<BTreeSet<_>>(),
            BTreeSet::from(["client.read", "client.write"]));
        assert_eq!(policy.get("client.local").unwrap().class, SurfaceClass::Client);
        assert!(serde_json::from_str::<HostSurfacePolicy>(
            &POLICY_JSON.replace("\"host-data\"", "\"unknown-host-data\"")).is_err());
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

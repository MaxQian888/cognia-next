//! Sealed org agent policy and provider prerequisites. Existing gateway task
//! traits map runtimes to wire ingress, not provider ids (gateway translation
//! deliberately permits many providers). This table maps bundled runtime ids
//! to that existing brokered launch contract; all accept an org provider through
//! gateway translation. Runtimes without a brokered launch remain unavailable.
//! Availability
//! is credential coverage only, never permission to execute (P6d/P6e).
use cognia_secrets::secret_store;
use serde::{Deserialize, Serialize};
use crate::org_credentials::{validate_org, OrgCredentials};

pub(crate) const SERVICE: &str = "com.cognia.host-org-agent-policy/v1";

/// Broker task family from lib/ai/agent/external/config/gateway-task.ts.
/// None means the shipped runtime has no reviewed brokered launch contract.
/// The providers returned to callers are alternatives, not an all-of list.
const AGENT_PROVIDERS: &[(&str, Option<&str>)] = &[
    ("claude-agent-acp", Some("claude")),
    ("codex-acp", Some("codex")),
    ("codex-app-server", Some("codex")),
    ("gemini-cli", None),
    ("copilot-cli", Some("copilot")),
    ("qwen-code", Some("qwen")),
    ("pi", Some("pi")),
    ("opencode", Some("opencode")),
    ("opencode-acp", Some("opencode")),
    ("kiro-cli", None),
    ("droid", None),
];

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentPolicy {
    pub allowed_agents: Vec<String>,
    pub default_agent: Option<String>,
    pub updated_at: Option<i64>,
    pub updated_by: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAvailability {
    pub runtime_id: String,
    pub providers: Vec<String>,
    pub available: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyView {
    pub allowed_agents: Vec<AgentAvailability>,
    pub bundled_agents: Vec<AgentAvailability>,
    pub default_agent: Option<String>,
    pub updated_at: Option<i64>,
    pub updated_by: Option<String>,
}

fn validate(allowed: &[String], default: Option<&str>) -> Result<(), String> {
    let mut seen = std::collections::HashSet::new();
    for id in allowed {
        if !AGENT_PROVIDERS.iter().any(|(runtime, _)| runtime == id) || !seen.insert(id) {
            return Err("allowedAgents must contain unique bundled runtime ids".into());
        }
    }
    if default.is_some_and(|id| !allowed.iter().any(|allowed| allowed == id)) {
        return Err("defaultAgent must belong to allowedAgents".into());
    }
    Ok(())
}

pub fn set(org: &str, allowed: Vec<String>, default: Option<String>, user: &str, now: i64) -> Result<PolicyView, String> {
    validate_org(org)?;
    validate(&allowed, default.as_deref())?;
    let policy = AgentPolicy { allowed_agents: allowed, default_agent: default, updated_at: Some(now), updated_by: Some(user.into()) };
    let output = view(org, policy.clone())?;
    let raw = serde_json::to_string(&policy).map_err(|_| "cannot encode organization agent policy")?;
    secret_store::set(SERVICE, org, &raw).map_err(|_| "organization agent policy store unavailable")?;
    Ok(output)
}

pub fn get(org: &str) -> Result<PolicyView, String> {
    validate_org(org)?;
    let policy = match secret_store::get(SERVICE, org)? {
        Some(raw) => serde_json::from_str(&raw).map_err(|_| "invalid organization agent policy")?,
        None => AgentPolicy::default(),
    };
    view(org, policy)
}

fn view(org: &str, policy: AgentPolicy) -> Result<PolicyView, String> {
    validate(&policy.allowed_agents, policy.default_agent.as_deref())?;
    let credentials = OrgCredentials::list(org)?;
    let present: Vec<String> = credentials.into_iter().map(|entry| entry.provider).collect();
    let availability = |runtime_id: String| {
        let requirement = AGENT_PROVIDERS.iter().find(|(id, _)| *id == runtime_id).expect("validated runtime").1;
        // Coverage only: P6c still validates the provider profile/model and
        // mints a ticket. Holding an arbitrary slug never authorizes execution.
        let providers = if requirement.is_some() { present.clone() } else { vec![] };
        let available = !providers.is_empty();
        AgentAvailability { runtime_id, providers, available }
    };
    let bundled_agents = AGENT_PROVIDERS.iter().map(|(runtime, _)| availability((*runtime).into())).collect();
    let allowed_agents = policy.allowed_agents.into_iter().map(availability).collect();
    Ok(PolicyView { allowed_agents, bundled_agents, default_agent: policy.default_agent, updated_at: policy.updated_at, updated_by: policy.updated_by })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn p6b_bundled_agents_include_disallowed_runtimes_in_table_order() {
        let org = "org_p6b_bundled_agents";
        let empty = serde_json::to_value(get(org).unwrap()).unwrap();
        assert_eq!(empty["bundledAgents"].as_array().unwrap().len(), AGENT_PROVIDERS.len());
        assert!(empty["allowedAgents"].as_array().unwrap().is_empty());
        OrgCredentials::set(org, "openai", "p6b-bundle-secret", "operator", 1).unwrap();
        let policy = set(org, vec!["pi".into()], Some("pi".into()), "operator", 2).unwrap();
        let output = serde_json::to_value(policy).unwrap();
        for (agent, (id, family)) in output["bundledAgents"].as_array().unwrap().iter().zip(AGENT_PROVIDERS) {
            assert_eq!(agent["runtimeId"], *id);
            assert_eq!(agent["available"], family.is_some());
            assert_eq!(agent["providers"], if family.is_some() { serde_json::json!(["openai"]) } else { serde_json::json!([]) });
            if *id == "pi" { assert_eq!(*agent, output["allowedAgents"][0]); }
        }
        OrgCredentials::delete(org, "openai").unwrap();
        assert!(serde_json::to_value(get(org).unwrap()).unwrap()["bundledAgents"].as_array().unwrap().iter().all(|agent| agent["available"] == false));
    }

    #[test]
    fn p6a_provider_table_covers_exactly_the_shipped_bundle() {
        let bundle: serde_json::Value = serde_json::from_str(include_str!("../../../deploy/bundle/agent-versions.json")).unwrap();
        let catalog: serde_json::Value = serde_json::from_str(include_str!("../../../protocol/external-agent-runtimes.json")).unwrap();
        let shipped: std::collections::BTreeSet<_> = bundle["runtimes"].as_array().unwrap().iter()
            .filter(|row| row.get("unavailable").is_none()).map(|row| row["id"].as_str().unwrap()).collect();
        assert_eq!(shipped, AGENT_PROVIDERS.iter().map(|(id, _)| *id).collect());
        for (id, _) in AGENT_PROVIDERS {
            assert!(catalog["runtimes"].as_array().unwrap().iter().any(|row| row["runtimeId"] == *id));
        }
        let gateway = include_str!("../../cognia-sandboxd/src/gateway_task.rs");
        for (_, family) in AGENT_PROVIDERS {
            if let Some(family) = family { assert!(gateway.contains(&format!("\"{family}\""))); }
        }
    }

    #[test]
    fn p6a_policy_validation_coverage_and_org_isolation() {
        let org = "org_p6a_policy";
        assert!(set(org, vec!["not-bundled".into()], None, "operator", 1).is_err());
        assert!(set(org, vec!["pi".into()], Some("codex-acp".into()), "operator", 1).is_err());
        assert!(set(org, vec!["pi".into(), "pi".into()], None, "operator", 1).is_err());
        let policy = set(org, vec!["codex-acp".into(), "pi".into(), "claude-agent-acp".into(), "gemini-cli".into(), "kiro-cli".into(), "droid".into()], Some("pi".into()), "operator", 2).unwrap();
        assert!(policy.allowed_agents.iter().all(|agent| !agent.available));
        OrgCredentials::set(org, "openai", "p6a-policy-secret", "operator", 3).unwrap();
        let covered = get(org).unwrap();
        for agent in covered.allowed_agents {
            assert_eq!(agent.available, matches!(agent.runtime_id.as_str(), "codex-acp" | "pi" | "claude-agent-acp"));
            if agent.available { assert_eq!(agent.providers, ["openai"]); }
        }
        assert!(get("org_p6a_other_policy").unwrap().allowed_agents.is_empty());
        OrgCredentials::delete(org, "openai").unwrap();
        assert!(get(org).unwrap().allowed_agents.iter().all(|agent| !agent.available));
    }
}

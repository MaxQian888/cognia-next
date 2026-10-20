//! Deployment policy evaluation. Documents are validated before persistence;
//! evaluation is pure and never widens a deployment master switch.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FeatureKey {
    SharedChat,
    SharedChatExecution,
    CanvasCollaboration,
    OrgGovernance,
    EnvironmentBinding,
}

impl FeatureKey {
    // OrgGovernance is client presentation only; EnvironmentBinding is
    // enforced by the Host (P1), which owns its routes and placements.
    pub const ALL: [Self; 5] = [Self::SharedChat, Self::SharedChatExecution,
        Self::CanvasCollaboration, Self::OrgGovernance, Self::EnvironmentBinding];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::SharedChat => "shared-chat",
            Self::SharedChatExecution => "shared-chat-execution",
            Self::CanvasCollaboration => "canvas-collaboration",
            Self::OrgGovernance => "org-governance",
            Self::EnvironmentBinding => "environment-binding",
        }
    }
}

impl std::str::FromStr for FeatureKey {
    type Err = serde_json::Error;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        serde_json::from_value(serde_json::Value::String(value.to_owned()))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FeatureState { Available, ExistingOnly, ReadOnly, Off }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FeatureReason {
    DeploymentDisabled,
    FeatureNotOffered,
    FeaturePaused,
    FeatureKilled,
    OrgDenied,
    WorkspaceDenied,
    PrerequisiteUnavailable,
    ClientContractUnsupported,
    PolicyUnavailable,
    ExecutionIsolationUnavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase { Off, Internal, Canary, General, Paused }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FeaturePolicy {
    pub feature_key: FeatureKey,
    pub schema_version: u32,
    pub revision: i64,
    pub phase: Phase,
    pub kill: bool,
    pub allow_org_ids: Vec<String>,
    pub deny_org_ids: Vec<String>,
    pub deny_workspace_ids: Vec<String>,
    pub percentage_basis_points: u16,
    #[serde(default)]
    pub cohort_key: Option<String>,
    pub cohort_salt: String,
    pub hash_version: u32,
    pub minimum_contract_version: u32,
    pub requires: Vec<FeatureKey>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("invalid feature policy: {0}")]
pub struct PolicyValidationError(pub String);

impl FeaturePolicy {
    pub fn validate(&self) -> Result<(), PolicyValidationError> {
        let error = if self.schema_version != 1 { Some("schema_version must be 1") }
        else if self.hash_version != 1 { Some("hash_version must be 1") }
        else if self.percentage_basis_points > 10000 { Some("percentage_basis_points must be 0..=10000") }
        else if self.phase == Phase::Canary && self.cohort_salt.is_empty() { Some("canary requires a non-empty cohort_salt") }
        else if self.requires.contains(&self.feature_key) { Some("requires must not contain the feature itself") }
        else if self.revision < 0 { Some("revision must be non-negative") }
        else { None };
        match error {
            Some(error) => Err(PolicyValidationError(error.into())),
            None => Ok(()),
        }
    }
}

/// Unknown keys, phases and fields are rejected by serde at the apply boundary.
pub fn validate_document(json: &str) -> Result<FeaturePolicy, PolicyValidationError> {
    let document: FeaturePolicy = serde_json::from_str(json)
        .map_err(|error| PolicyValidationError(error.to_string()))?;
    document.validate()?;
    Ok(document)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureDecision {
    pub key: FeatureKey,
    pub state: FeatureState,
    pub reason: Option<FeatureReason>,
    pub policy_revision: i64,
}

pub fn bucket(cohort_key: &str, cohort_salt: &str, org_id: &str) -> u16 {
    let mut hash = Sha256::new();
    for value in ["cognia.rollout.v1", cohort_key, cohort_salt, org_id] {
        // Policy documents and org identifiers cannot reach 4 GiB in memory.
        let length = u32::try_from(value.len()).expect("rollout hash input exceeds u32 length");
        hash.update(length.to_be_bytes());
        hash.update(value.as_bytes());
    }
    let digest = hash.finalize();
    let mut first = [0; 8];
    first.copy_from_slice(&digest[..8]);
    (u64::from_be_bytes(first) % 10000) as u16
}

/// `key` is needed even for an absent row, whose default is general/revision 0.
#[allow(clippy::too_many_arguments)]
pub fn evaluate(
    key: FeatureKey,
    policy: Option<&FeaturePolicy>,
    master_enabled: bool,
    org_id: &str,
    workspace_id: Option<&str>,
    client_contract: Option<u32>,
    prerequisite: impl Fn(FeatureKey) -> FeatureState,
) -> FeatureDecision {
    use FeatureReason::*;
    use FeatureState::*;
    let decision = |state, reason| FeatureDecision {
        key, state, reason, policy_revision: policy.map_or(0, |p| p.revision),
    };
    if !master_enabled { return decision(Off, Some(DeploymentDisabled)); }
    let Some(policy) = policy else { return decision(Available, None); };
    let reason = if policy.kill { Some(FeatureKilled) }
        else if policy.deny_org_ids.iter().any(|id| id == org_id) { Some(OrgDenied) }
        else if workspace_id.is_some_and(|id| policy.deny_workspace_ids.iter().any(|denied| denied == id)) { Some(WorkspaceDenied) }
        else if client_contract.is_some_and(|version| version < policy.minimum_contract_version) { Some(ClientContractUnsupported) }
        else if policy.requires.iter().any(|key| prerequisite(*key) != Available) { Some(PrerequisiteUnavailable) }
        else {
            let allowlisted = policy.allow_org_ids.iter().any(|id| id == org_id);
            match policy.phase {
                Phase::Off => Some(FeatureNotOffered),
                Phase::Paused => Some(FeaturePaused),
                Phase::Internal if !allowlisted => Some(FeatureNotOffered),
                Phase::Canary if !allowlisted && bucket(
                    policy.cohort_key.as_deref().unwrap_or(policy.feature_key.as_str()),
                    &policy.cohort_salt, org_id,
                ) >= policy.percentage_basis_points => Some(FeatureNotOffered),
                _ => None,
            }
        };
    decision(match reason { Some(FeatureKilled) => ReadOnly, Some(_) => ExistingOnly, None => Available }, reason)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::{json, Value};

    pub(crate) fn policy() -> FeaturePolicy {
        FeaturePolicy {
            feature_key: FeatureKey::SharedChat, schema_version: 1, revision: 0,
            phase: Phase::General, kill: false, allow_org_ids: vec![], deny_org_ids: vec![],
            deny_workspace_ids: vec![], percentage_basis_points: 0, cohort_key: None,
            cohort_salt: "s1".into(), hash_version: 1, minimum_contract_version: 2, requires: vec![],
        }
    }

    #[test]
    fn pins_capabilities_contract_enums() {
        let contract: Value = serde_json::from_str(include_str!("../../../protocol/collab-capabilities-v1.json")).unwrap();
        assert_eq!(json!(FeatureKey::ALL), contract["featureKeys"]);
        for key in FeatureKey::ALL {
            assert_eq!(key.as_str().parse::<FeatureKey>().unwrap(), key);
            assert_eq!(json!(key), key.as_str());
        }
        let states = [FeatureState::Available, FeatureState::ExistingOnly, FeatureState::ReadOnly, FeatureState::Off];
        let mut names: Vec<_> = states.into_iter().map(|state| json!(state)).collect();
        names.sort_by_key(Value::to_string);
        assert_eq!(names, contract["featureStates"].as_object().unwrap().keys().map(|key| json!(key)).collect::<Vec<_>>());
        assert_eq!(json!([FeatureReason::DeploymentDisabled, FeatureReason::FeatureNotOffered,
            FeatureReason::FeaturePaused, FeatureReason::FeatureKilled, FeatureReason::OrgDenied,
            FeatureReason::WorkspaceDenied, FeatureReason::PrerequisiteUnavailable,
            FeatureReason::ClientContractUnsupported, FeatureReason::PolicyUnavailable,
            FeatureReason::ExecutionIsolationUnavailable]), contract["reasons"]);
    }

    #[test]
    fn golden_buckets_canary_boundaries_and_monotonicity() {
        let contract: Value = serde_json::from_str(include_str!("../../../protocol/collab-rollout-buckets-v1.json")).unwrap();
        assert_eq!(contract["domain"], "cognia.rollout.v1");
        assert_eq!(contract["hashVersion"], 1);
        assert_eq!(contract["bucketCount"], 10000);
        for vector in contract["vectors"].as_array().unwrap() {
            let cohort = vector["cohortKey"].as_str().unwrap();
            let salt = vector["cohortSalt"].as_str().unwrap();
            let org = vector["orgId"].as_str().unwrap();
            let expected = vector["bucket"].as_u64().unwrap() as u16;
            assert_eq!(bucket(cohort, salt, org), expected, "{vector}");
            let mut p = policy();
            p.phase = Phase::Canary;
            p.cohort_key = Some(cohort.into());
            p.cohort_salt = salt.into();
            for threshold in [0, 5000, expected, expected + 1, 10000] {
                p.percentage_basis_points = threshold;
                let result = evaluate(p.feature_key, Some(&p), true, org, None, None, |_| FeatureState::Available);
                assert_eq!(result.state == FeatureState::Available, expected < threshold);
            }
            let mut admitted = false;
            for threshold in (0..=10000).step_by(100) {
                p.percentage_basis_points = threshold;
                let available = evaluate(p.feature_key, Some(&p), true, org, None, None, |_| FeatureState::Available).state == FeatureState::Available;
                assert!(!admitted || available);
                admitted = available;
            }
        }
        // Omitted cohort_key is the feature key, including for grouped features.
        let mut p = policy();
        p.phase = Phase::Canary;
        p.percentage_basis_points = 8433;
        assert_eq!(evaluate(p.feature_key, Some(&p), true, "org_01J9ZK8Y2V5QW3E7RT6MNPXA4B", None, None, |_| unreachable!()).state, FeatureState::Available);
    }

    #[test]
    fn exhaustive_first_matching_rule_and_phase_table() {
        use FeatureReason::*;
        use FeatureState::*;
        for phase in [Phase::Off, Phase::Internal, Phase::Canary, Phase::General, Phase::Paused] {
            // Every combination proves each rule wins over all later rules.
            for mask in 0..128 {
                let master = mask & 1 == 0;
                let kill = mask & 2 != 0;
                let deny_org = mask & 4 != 0;
                let deny_workspace = mask & 8 != 0;
                let old_client = mask & 16 != 0;
                let unmet = mask & 32 != 0;
                let allowed = mask & 64 != 0;
                let mut p = policy();
                p.revision = 7;
                p.phase = phase;
                p.kill = kill;
                if deny_org { p.deny_org_ids.push("org".into()); }
                if deny_workspace { p.deny_workspace_ids.push("ws".into()); }
                if allowed { p.allow_org_ids.push("org".into()); }
                p.requires = vec![FeatureKey::EnvironmentBinding];
                let expected = if !master { (Off, Some(DeploymentDisabled)) }
                    else if kill { (ReadOnly, Some(FeatureKilled)) }
                    else if deny_org { (ExistingOnly, Some(OrgDenied)) }
                    else if deny_workspace { (ExistingOnly, Some(WorkspaceDenied)) }
                    else if old_client { (ExistingOnly, Some(ClientContractUnsupported)) }
                    else if unmet { (ExistingOnly, Some(PrerequisiteUnavailable)) }
                    else if phase == Phase::Paused { (ExistingOnly, Some(FeaturePaused)) }
                    else if phase == Phase::Off || (!allowed && matches!(phase, Phase::Internal | Phase::Canary)) { (ExistingOnly, Some(FeatureNotOffered)) }
                    else { (Available, None) };
                let result = evaluate(p.feature_key, Some(&p), master, "org", Some("ws"), Some(if old_client { 1 } else { 2 }), |_| if unmet { ReadOnly } else { Available });
                assert_eq!((result.state, result.reason), expected, "phase={phase:?} mask={mask}");
                assert_eq!(result.policy_revision, 7);
            }
        }
        for key in FeatureKey::ALL {
            for master in [true, false] {
                let result = evaluate(key, None, master, "org", None, None, |_| panic!("missing policy has no prerequisites"));
                assert_eq!(result.key, key);
                assert_eq!(result.policy_revision, 0);
                assert_eq!(result.state, if master { Available } else { Off });
            }
        }
        let mut p = policy();
        p.deny_workspace_ids.push("ws".into());
        // A missing contract header does not fail the contract gate; no ws does
        // not match its denylist. Every non-available prerequisite fails closed.
        assert_eq!(evaluate(p.feature_key, Some(&p), true, "org", None, None, |_| unreachable!()).state, Available);
        for state in [ExistingOnly, ReadOnly, Off] {
            p.requires = vec![FeatureKey::EnvironmentBinding];
            assert_eq!(evaluate(p.feature_key, Some(&p), true, "org", None, None, |_| state).reason, Some(PrerequisiteUnavailable));
        }
    }

    #[test]
    fn rejects_invalid_documents_at_apply_boundary() {
        let valid = json!(policy());
        assert_eq!(validate_document(&valid.to_string()).unwrap(), policy());
        for (field, value) in [
            ("schema_version", json!(2)), ("hash_version", json!(2)),
            ("feature_key", json!("unknown")), ("percentage_basis_points", json!(10001)),
            ("percentage_basis_points", json!(-1)), ("requires", json!(["unknown"])),
            ("requires", json!(["shared-chat"])), ("phase", json!("unknown")),
            ("revision", json!(-1)), ("unexpected", json!(true)),
        ] {
            let mut invalid = valid.clone();
            invalid[field] = value;
            assert!(validate_document(&invalid.to_string()).is_err(), "{invalid}");
        }
        let mut p = policy();
        p.phase = Phase::Canary;
        p.cohort_salt.clear();
        assert!(p.validate().is_err());
        p.cohort_salt = "salt".into();
        p.percentage_basis_points = 10000;
        assert!(p.validate().is_ok());
        let mut omitted = valid;
        omitted.as_object_mut().unwrap().remove("cohort_key");
        assert!(validate_document(&omitted.to_string()).unwrap().cohort_key.is_none());
    }
}

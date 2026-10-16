pub use cognia_environment::spec::{EgressTier, IsolationTier};
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const MAX_CONCURRENT: u32 = 2;
pub const MAX_LIFETIME_SECONDS: u64 = 3_600;
pub const MAX_IDLE_SECONDS: u64 = 600;
pub const QUOTE_TTL_MS: i64 = 5 * 60 * 1_000;
pub const BINDING_MAX_AGE_MS: i64 = 30 * 24 * 60 * 60 * 1_000;

/// Stable codes only: provider response bodies, URLs, secrets and paths never
/// cross the Host boundary in an error.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, thiserror::Error)]
#[error("{code}")]
#[serde(rename_all = "camelCase")]
pub struct ManagedDesktopError {
    pub code: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allowed: Option<u64>,
}
pub type Result<T> = std::result::Result<T, ManagedDesktopError>;
pub fn refused(code: &str) -> ManagedDesktopError {
    ManagedDesktopError {
        code: code.into(),
        retryable: false,
        requested: None,
        allowed: None,
    }
}
pub fn retryable(code: &str) -> ManagedDesktopError {
    ManagedDesktopError {
        retryable: true,
        ..refused(code)
    }
}
fn limit(code: &str, requested: u64, allowed: u64) -> ManagedDesktopError {
    ManagedDesktopError {
        requested: Some(requested),
        allowed: Some(allowed),
        ..refused(code)
    }
}

/// Constructed by the authenticated Host dispatcher, never deserialized from
/// RPC input. A service/agent cannot turn a request flag into a human gesture.
#[derive(Clone, Debug)]
pub struct ManagedDesktopPrincipal {
    pub owner_principal_id: String,
    pub principal_id: String,
    pub host_id: String,
    pub authority: ManagedDesktopAuthority,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ManagedDesktopAuthority {
    Observer,
    Human,
    Administrator,
    Agent,
}
impl ManagedDesktopPrincipal {
    pub fn require_human(&self) -> Result<()> {
        match self.authority {
            ManagedDesktopAuthority::Human | ManagedDesktopAuthority::Administrator => Ok(()),
            _ => Err(refused("managed_desktop_human_authorization_required")),
        }
    }
    pub fn require_admin(&self) -> Result<()> {
        if self.authority == ManagedDesktopAuthority::Administrator {
            Ok(())
        } else {
            Err(refused("managed_desktop_admin_required"))
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopLimits {
    pub max_concurrent: u32,
    pub max_lifetime_seconds: u64,
    pub idle_timeout_seconds: u64,
}
impl Default for DesktopLimits {
    fn default() -> Self {
        Self {
            max_concurrent: MAX_CONCURRENT,
            max_lifetime_seconds: MAX_LIFETIME_SECONDS,
            idle_timeout_seconds: MAX_IDLE_SECONDS,
        }
    }
}
impl DesktopLimits {
    pub fn validate(&self) -> Result<()> {
        for (value, max) in [
            (u64::from(self.max_concurrent), u64::from(MAX_CONCURRENT)),
            (self.max_lifetime_seconds, MAX_LIFETIME_SECONDS),
            (self.idle_timeout_seconds, MAX_IDLE_SECONDS),
        ] {
            if value == 0 || value > max {
                return Err(limit("managed_desktop_policy_limit", value, max));
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopShape {
    pub cpu_count: u32,
    pub memory_mb: u32,
}

/// A trusted release channel supplies this document; a browser cannot invent
/// the digest whose template it is about to qualify.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopRelease {
    pub image: String,
    pub image_digest: String,
    pub architecture: String,
    pub recipe_revision: String,
    pub protocol: String,
    pub server_version: String,
    pub start_command: String,
    pub ready_command: String,
}
impl DesktopRelease {
    pub fn validate(&self) -> Result<()> {
        let digest = self
            .image_digest
            .strip_prefix("sha256:")
            .ok_or_else(|| refused("managed_desktop_release_invalid"))?;
        if digest.len() != 64
            || !digest
                .bytes()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
            || !self.image.ends_with(&format!("@{}", self.image_digest))
            || !matches!(self.architecture.as_str(), "linux/amd64" | "linux/arm64")
            || [
                &self.recipe_revision,
                &self.protocol,
                &self.server_version,
                &self.start_command,
                &self.ready_command,
            ]
            .iter()
            .any(|s| s.is_empty() || s.len() > 4096)
        {
            return Err(refused("managed_desktop_release_invalid"));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountPlanBinding {
    pub max_lifetime_seconds: u64,
    pub observed_at: i64,
    pub expires_at: i64,
    pub source: String,
    pub namespace: String,
}
impl AccountPlanBinding {
    pub fn validate_lifetime(&self, seconds: u64, now: i64) -> Result<()> {
        if self.observed_at > now
            || self.expires_at <= now
            || self
                .expires_at
                .checked_sub(self.observed_at)
                .is_none_or(|age| age > BINDING_MAX_AGE_MS)
            || self.source.is_empty()
            || self.namespace.is_empty()
            || self.max_lifetime_seconds == 0
            || self.max_lifetime_seconds > 86_400
        {
            return Err(refused("managed_desktop_entitlement_unknown"));
        }
        if seconds > self.max_lifetime_seconds {
            return Err(limit(
                "managed_desktop_entitlement_limit",
                seconds,
                self.max_lifetime_seconds,
            ));
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopPrice {
    pub currency: String,
    pub hourly_rate_micros: u64,
    pub observed_at: i64,
    pub expires_at: i64,
    pub source: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "mode", content = "rules", rename_all = "camelCase")]
pub enum DesktopEgress {
    Off,
    On,
    Allowlist(Vec<String>),
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedDesktopConfig {
    pub id: String,
    pub owner_principal_id: String,
    pub host_id: String,
    pub revision: u64,
    pub enabled: bool,
    pub credential_generation: u64,
    pub region: Option<String>,
    pub shape: DesktopShape,
    pub limits: DesktopLimits,
    pub plan: AccountPlanBinding,
    pub price: DesktopPrice,
    pub release: DesktopRelease,
    pub egress: DesktopEgress,
    pub isolation_minimum: IsolationTier,
}
impl ManagedDesktopConfig {
    pub fn validate(&self, now: i64) -> Result<()> {
        for id in [&self.id, &self.owner_principal_id, &self.host_id] {
            validate_id(id)?;
        }
        self.limits.validate()?;
        self.release.validate()?;
        self.plan.validate_lifetime(1, now)?;
        if self.shape.cpu_count == 0
            || self.shape.cpu_count > 64
            || self.shape.memory_mb < 128
            || self.shape.memory_mb > 262_144
            || self.credential_generation == 0
            || self.revision == 0
        {
            return Err(refused("managed_desktop_config_invalid"));
        }
        if self.price.hourly_rate_micros == 0
            || self.price.currency.len() != 3
            || !self.price.currency.bytes().all(|c| c.is_ascii_uppercase())
            || self.price.source.is_empty()
            || self.price.observed_at > now
            || self.price.expires_at <= now
            || self
                .price
                .expires_at
                .checked_sub(self.price.observed_at)
                .is_none_or(|age| age > BINDING_MAX_AGE_MS)
        {
            return Err(refused("managed_desktop_price_unknown"));
        }
        if let Some(region) = &self.region {
            validate_id(region)?;
        }
        if let DesktopEgress::Allowlist(rules) = &self.egress {
            if rules.is_empty()
                || rules.len() > 100
                || rules
                    .iter()
                    .any(|r| r.is_empty() || r.len() > 256 || r.contains(['\r', '\n']))
            {
                return Err(refused("managed_desktop_egress_invalid"));
            }
        }
        Ok(())
    }
    pub fn binding_digest(&self) -> String {
        // Includes policy, account generation, price, region and release. A
        // config change invalidates existing quotes/qualification receipts.
        hex::encode(Sha256::digest(
            serde_json::to_vec(self).expect("config JSON"),
        ))
    }
    pub fn secret_ref(&self) -> String {
        format!(
            "managed-desktop:{}:{}:{}",
            self.owner_principal_id, self.id, self.credential_generation
        )
    }
    pub fn authorize(&self, principal: &ManagedDesktopPrincipal) -> Result<()> {
        if self.owner_principal_id != principal.owner_principal_id
            || self.host_id != principal.host_id
        {
            Err(refused("managed_desktop_forbidden"))
        } else {
            Ok(())
        }
    }
}
pub fn validate_id(id: &str) -> Result<()> {
    if id.is_empty()
        || id.len() > 256
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.' | b':'))
    {
        Err(refused("managed_desktop_invalid_id"))
    } else {
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TemplateIdentity {
    pub template_id: String,
    pub build_id: String,
    pub image_digest: String,
    pub recipe_revision: String,
    pub protocol: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TemplateState {
    Registering,
    Registered,
    Building,
    Ready,
    Unknown,
    Failed,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateRecord {
    pub id: String,
    pub authorization_id: String,
    pub quote_id: String,
    pub config: ManagedDesktopConfig,
    pub binding_digest: String,
    pub state: TemplateState,
    pub identity: Option<TemplateIdentity>,
    pub created_at: i64,
    pub updated_at: i64,
    pub error_code: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QualificationReceipt {
    pub binding_digest: String,
    pub template: TemplateIdentity,
    pub observed_at: i64,
    pub smoke_desktop_ids: Vec<String>,
    pub native_expiry_killed: bool,
    pub no_auto_resume: bool,
    pub ingress_denied: bool,
    pub guest_auth_denied: bool,
    pub decoded_frame_verified: bool,
    pub protocol_verified: bool,
    pub restart_deadline_verified: bool,
    pub delete_retry_verified: bool,
    pub private_egress_probe_no_response: bool,
    pub egress_policy_verified: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedDesktopQuote {
    pub id: String,
    pub provider_config_id: String,
    pub config_revision: u64,
    /// Maximum billed/session duration. Provisioning consumes part of this
    /// budget; it is not a guarantee of this many interactive seconds.
    pub lifetime_seconds: u64,
    pub expires_at: i64,
    pub currency: String,
    pub hourly_rate_micros: u64,
    pub maximum_compute_cost_micros: u64,
    pub price_observed_at: i64,
    pub region: Option<String>,
    pub cpu_count: u32,
    pub memory_mb: u32,
    pub binding_digest: String,
    pub owner_principal_id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AuthorizationPurpose {
    Create,
    PrepareTemplate,
    Smoke,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAuthorization {
    pub id: String,
    pub provider_config_id: String,
    pub owner_principal_id: String,
    pub principal_id: String,
    pub binding_digest: String,
    pub purpose: AuthorizationPurpose,
    pub quote_id: Option<String>,
    pub source_id: Option<String>,
    pub expires_at: i64,
    pub consumed_by: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateManagedDesktop {
    pub provider_config_id: String,
    pub quote_id: String,
    pub authorization_id: String,
    pub idempotency_key: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ManagedDesktopState {
    Creating,
    Running,
    Deleting,
    DestroyRetrying,
    Destroyed,
    Error,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedDesktop {
    pub id: String,
    pub provider_config_id: String,
    pub generation: u64,
    pub state: ManagedDesktopState,
    pub deadline_at: i64,
    pub idle_timeout_seconds: u64,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_error_code: Option<String>,
    pub cleanup_attempts: u32,
    pub qualification: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRecord {
    pub desktop: ManagedDesktop,
    pub config: ManagedDesktopConfig,
    pub template: TemplateIdentity,
    pub operation_id: String,
    pub authorization_id: String,
    pub quote_id: String,
    pub principal_id: String,
    pub source_id: Option<String>,
    pub resource_id: Option<String>,
    pub last_activity_at: i64,
    pub next_retry_at: i64,
    pub delete_requested: bool,
    pub smoke: bool,
    #[serde(default)]
    pub bootstrap_started: bool,
    #[serde(default)]
    pub bootstrap_completed: bool,
}
impl DesktopRecord {
    pub fn metadata(&self) -> BTreeMap<String, String> {
        BTreeMap::from([
            ("cognia.kind".into(), "managed-desktop-v1".into()),
            (
                "cognia.owner".into(),
                self.config.owner_principal_id.clone(),
            ),
            ("cognia.host".into(), self.config.host_id.clone()),
            ("cognia.desktop".into(), self.desktop.id.clone()),
            (
                "cognia.generation".into(),
                self.desktop.generation.to_string(),
            ),
            ("cognia.operation".into(), self.operation_id.clone()),
            (
                "cognia.deadline".into(),
                self.desktop.deadline_at.to_string(),
            ),
            ("cognia.build".into(), self.template.build_id.clone()),
        ])
    }
    pub fn expired(&self, now: i64) -> bool {
        now >= self.desktop.deadline_at
            || now.saturating_sub(self.last_activity_at)
                >= self.desktop.idle_timeout_seconds as i64 * 1_000
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedDesktopHealth {
    pub reachable: bool,
    pub state: ManagedDesktopState,
    pub desktop: ManagedDesktop,
    pub error_code: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedDesktopConfigSummary {
    pub id: String,
    pub owner_principal_id: String,
    pub host_id: String,
    pub enabled: bool,
    pub qualification: String,
    pub reason: Option<String>,
    pub max_concurrent: u32,
    pub max_lifetime_seconds: u64,
    pub idle_timeout_seconds: u64,
    pub region: Option<String>,
    pub cpu_count: u32,
    pub memory_mb: u32,
    pub template: Option<TemplateIdentity>,
    pub template_state: Option<TemplateState>,
    pub can_prepare_template: bool,
    pub can_create: bool,
    pub gui_qualified: bool,
    pub isolation_tier: IsolationTier,
    pub egress_tier: EgressTier,
    pub egress_enforcement: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn policy_only_tightens_and_entitlement_never_clips() {
        assert!(DesktopLimits::default().validate().is_ok());
        for limits in [
            DesktopLimits {
                max_concurrent: 3,
                ..Default::default()
            },
            DesktopLimits {
                max_lifetime_seconds: 3601,
                ..Default::default()
            },
            DesktopLimits {
                idle_timeout_seconds: 601,
                ..Default::default()
            },
        ] {
            assert_eq!(
                limits.validate().unwrap_err().code,
                "managed_desktop_policy_limit"
            );
        }
        for (max, requested) in [(3600, 3601), (86400, 86401)] {
            let plan = AccountPlanBinding {
                max_lifetime_seconds: max,
                observed_at: 0,
                expires_at: 100,
                source: "operator-confirmed".into(),
                namespace: "team".into(),
            };
            let error = plan.validate_lifetime(requested, 1).unwrap_err();
            assert_eq!(error.requested, Some(requested));
            assert_eq!(error.allowed, Some(max));
        }
    }
    #[test]
    fn agent_is_not_a_human_and_ids_cannot_escape_storage() {
        let p = ManagedDesktopPrincipal {
            owner_principal_id: "o".into(),
            principal_id: "a".into(),
            host_id: "h".into(),
            authority: ManagedDesktopAuthority::Agent,
        };
        assert!(p.require_human().is_err());
        for id in ["../x", "", "x/y", "x\n"] {
            assert!(validate_id(id).is_err());
        }
    }
}

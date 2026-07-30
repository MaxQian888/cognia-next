//! Explicit deployment-mode boundary for the remote API surface.
//!
//! Single-user deployments use the host OS user as their recovery trust root.
//! Multi-tenant deployments use OIDC and must not expose local pairing routes.

/// Environment variable selecting the companion deployment trust model.
pub const DEPLOYMENT_MODE_ENV: &str = "COGNIA_DEPLOYMENT_MODE";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DeploymentMode {
    SingleUser,
    MultiTenant,
}

impl DeploymentMode {
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "single-user" | "single_user" | "singleuser" => Some(Self::SingleUser),
            "multi-tenant" | "multi_tenant" | "multitenant" | "cloud" => Some(Self::MultiTenant),
            _ => None,
        }
    }
}

/// Resolve the process deployment mode.
///
/// Missing configuration preserves the existing desktop/headless single-user
/// behavior. An invalid explicit value fails toward the stricter multi-tenant
/// surface: pairing stays unmounted and HS256 device auth is disabled.
pub fn deployment_mode() -> DeploymentMode {
    match std::env::var(DEPLOYMENT_MODE_ENV) {
        Ok(value) => DeploymentMode::parse(&value).unwrap_or_else(|| {
            log::error!("invalid {DEPLOYMENT_MODE_ENV} value; using fail-closed multi-tenant mode");
            DeploymentMode::MultiTenant
        }),
        Err(_) => DeploymentMode::SingleUser,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_documented_modes_and_cloud_alias() {
        assert_eq!(
            DeploymentMode::parse("single-user"),
            Some(DeploymentMode::SingleUser)
        );
        assert_eq!(
            DeploymentMode::parse("multi-tenant"),
            Some(DeploymentMode::MultiTenant)
        );
        assert_eq!(
            DeploymentMode::parse("cloud"),
            Some(DeploymentMode::MultiTenant)
        );
    }

    #[test]
    fn rejects_ambiguous_values() {
        assert_eq!(DeploymentMode::parse("auto"), None);
        assert_eq!(DeploymentMode::parse(""), None);
    }
}

//! Network capability gate.
//!
//! Domain allowlist. The renderer's permission-request RPC asks the user
//! to grant access to specific hosts; the granted list is mirrored into
//! the `CapabilityGrants.allowed_network_hosts` slice.
//!
//! Wired in Phase M3 — module-wide `dead_code` silence until then.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};

use super::CapabilityGrants;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum NetworkDecision {
    Allow,
    Deny { reason: String },
}

pub fn check_host(grants: &CapabilityGrants, host: &str) -> NetworkDecision {
    let lowercase = host.to_ascii_lowercase();
    for allowed in &grants.allowed_network_hosts {
        let allowed = allowed.to_ascii_lowercase();
        if lowercase == allowed {
            return NetworkDecision::Allow;
        }
        if let Some(suffix) = allowed.strip_prefix("*.") {
            if lowercase.ends_with(suffix) {
                return NetworkDecision::Allow;
            }
        }
    }
    NetworkDecision::Deny {
        reason: format!("Host {host} is not in the network allowlist"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_match_allows() {
        let grants = CapabilityGrants {
            allowed_network_hosts: vec!["api.example.com".to_string()],
            ..Default::default()
        };
        assert!(matches!(check_host(&grants, "api.example.com"), NetworkDecision::Allow));
    }

    #[test]
    fn wildcard_subdomain_allowed() {
        let grants = CapabilityGrants {
            allowed_network_hosts: vec!["*.example.com".to_string()],
            ..Default::default()
        };
        assert!(matches!(check_host(&grants, "api.example.com"), NetworkDecision::Allow));
        assert!(matches!(check_host(&grants, "other.example.com"), NetworkDecision::Allow));
    }

    #[test]
    fn unrelated_host_denied() {
        let grants = CapabilityGrants {
            allowed_network_hosts: vec!["api.example.com".to_string()],
            ..Default::default()
        };
        assert!(matches!(check_host(&grants, "evil.invalid"), NetworkDecision::Deny { .. }));
    }
}

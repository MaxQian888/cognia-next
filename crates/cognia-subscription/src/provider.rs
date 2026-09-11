// `SubscriptionProvider` trait — provider-agnostic operations the vault and
// active-resolver layers call into. Intentionally pure-data and **sync**: all
// I/O (keyring, HTTP, file-system discovery) lives outside the trait, so the
// trait is easy to unit-test and easy to extend with new providers.

use serde::{Deserialize, Serialize};

use crate::preset::ProviderPreset;
use crate::vault::{Account, ProviderCredential};

/// Stable provider identity. Builtin OAuth providers retain their specialized
/// lifecycle; every other canonical id uses the generic API-key provider.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderId {
    Anthropic,
    Codex,
    Opencode,
    Commandcode,
    Registered(String),
}

impl ProviderId {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Anthropic => "anthropic",
            Self::Codex => "codex",
            Self::Opencode => "opencode",
            Self::Commandcode => "commandcode",
            Self::Registered(id) => id,
        }
    }

    pub fn parse(value: &str) -> Result<Self, String> {
        let value = value.trim();
        if value.is_empty()
            || value.len() > 128
            || !value.as_bytes()[0].is_ascii_lowercase()
            || !value.bytes().all(|byte| {
                byte.is_ascii_lowercase()
                    || byte.is_ascii_digit()
                    || matches!(byte, b'-' | b'_' | b'.' | b':')
            })
        {
            return Err(
                "subscription provider id must be 1-128 canonical lowercase ASCII characters"
                    .into(),
            );
        }
        Ok(match value {
            "anthropic" => Self::Anthropic,
            "codex" => Self::Codex,
            "opencode" => Self::Opencode,
            "commandcode" => Self::Commandcode,
            other => Self::Registered(other.to_owned()),
        })
    }

    pub fn builtin_ids() -> Vec<Self> {
        vec![
            Self::Anthropic,
            Self::Codex,
            Self::Opencode,
            Self::Commandcode,
        ]
    }
}

impl Serialize for ProviderId {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ProviderId {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Self::parse(&value).map_err(serde::de::Error::custom)
    }
}

/// Provider-specific behavior the vault and active-resolver layers depend on.
///
/// All methods are sync — credential I/O is in `vault.rs`, OAuth I/O lives in
/// each provider's `oauth.rs` (async), and file-system discovery lives in each
/// provider's `discovery.rs`. The trait itself is pure-data.
pub trait SubscriptionProvider: Send + Sync {
    /// Stable id. Used as the keyring `account` field. Today's call sites
    /// dispatch through the concrete provider type, so this method is
    /// reserved for future introspection paths (audit logs, CC-Switch sync).
    #[allow(dead_code)]
    fn id(&self) -> ProviderId;

    /// Validate-and-normalize an inbound credential before persisting.
    ///
    /// Implementations reject empty / structurally invalid credentials and
    /// surface a user-readable error. They MUST also enforce that the
    /// credential variant matches the provider — passing an
    /// `AnthropicCredentialData` to the Codex provider is a contract bug, not
    /// a runtime fallback.
    fn validate(&self, credential: &ProviderCredential) -> Result<(), String>;

    /// Derive a default human-readable label from a freshly-acquired
    /// credential (email, plan, etc.). May return `None`; callers fall back
    /// to the provider id + creation timestamp.
    fn default_label(&self, credential: &ProviderCredential) -> Option<String>;

    /// Build the environment-variable pairs the sidecar / external-agent
    /// runner should set when THIS account is active. Returns `Vec` instead
    /// of `HashMap` so callers can preserve insertion order when merging
    /// with proxy / global env.
    ///
    /// `preset` is the optional third-party endpoint override. Managed API-key
    /// providers and OAuth providers apply it when building their environment.
    fn env_for_sidecar(
        &self,
        account: &Account,
        preset: Option<&ProviderPreset>,
    ) -> Vec<(String, String)>;

    /// Whether assigning a new active account for this provider must trigger
    /// a sidecar restart. True only for Anthropic today — the Claude SDK
    /// reads `CLAUDE_CODE_OAUTH_TOKEN` at process init.
    fn requires_sidecar_restart_on_active_switch(&self) -> bool {
        false
    }

    /// Whether this provider supports `ProviderPreset` (third-party relay
    /// endpoints). All managed providers currently support relay presets.
    fn supports_preset(&self) -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_ids_round_trip_through_parse() {
        for id in [
            ProviderId::Anthropic,
            ProviderId::Codex,
            ProviderId::Opencode,
            ProviderId::Commandcode,
        ] {
            assert_eq!(ProviderId::parse(id.as_str()), Ok(id));
        }
    }

    #[test]
    fn parse_accepts_boundary_whitespace() {
        assert_eq!(ProviderId::parse("  codex\r\n"), Ok(ProviderId::Codex));
    }

    #[test]
    fn dynamic_ids_roundtrip_and_reject_unsafe_identifiers() {
        let id = ProviderId::parse("plugin:example.my-provider").unwrap();
        assert_eq!(id.as_str(), "plugin:example.my-provider");
        let json = serde_json::to_string(&id).unwrap();
        assert_eq!(serde_json::from_str::<ProviderId>(&json).unwrap(), id);
        for invalid in ["", "Bad", "../secret", "a/b", "a\nsecret", "1bad"] {
            assert!(ProviderId::parse(invalid).is_err());
        }
        assert!(ProviderId::parse(&"x".repeat(129)).is_err());
        assert_eq!(
            ProviderId::parse("anthropic").unwrap(),
            ProviderId::Anthropic
        );
    }
}

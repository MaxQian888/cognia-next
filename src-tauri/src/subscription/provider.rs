// `SubscriptionProvider` trait — provider-agnostic operations the vault and
// active-resolver layers call into. Intentionally pure-data and **sync**: all
// I/O (keyring, HTTP, file-system discovery) lives outside the trait, so the
// trait is easy to unit-test and easy to extend with new providers.

use serde::{Deserialize, Serialize};

use crate::subscription::preset::ProviderPreset;
use crate::subscription::vault::{Account, ProviderCredential};

/// Stable provider identifier. Used as the keyring `account` field for the
/// per-provider vault entry and as the discriminator in IPC.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderId {
    Anthropic,
    Codex,
    Opencode,
}

impl ProviderId {
    pub fn as_str(self) -> &'static str {
        match self {
            ProviderId::Anthropic => "anthropic",
            ProviderId::Codex => "codex",
            ProviderId::Opencode => "opencode",
        }
    }

    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "anthropic" => Ok(ProviderId::Anthropic),
            "codex" => Ok(ProviderId::Codex),
            "opencode" => Ok(ProviderId::Opencode),
            other => Err(format!("unknown subscription provider: {other:?}")),
        }
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
    /// `preset` is the optional third-party endpoint override. Implementations
    /// that don't honor a preset (currently OpenCode) ignore the argument;
    /// the vault enforces `preset.is_none()` for those providers.
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
    /// endpoints). Anthropic + Codex return true; OpenCode returns false.
    fn supports_preset(&self) -> bool {
        true
    }
}

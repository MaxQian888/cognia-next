//! Generic API-key subscriptions. Registry metadata controls connections in the
//! renderer; this module never manufactures arbitrary process environment.
use crate::preset::ProviderPreset;
use crate::provider::{ProviderId, SubscriptionProvider};
use crate::vault::{Account, ApiKeyCredentialData, ProviderCredential};

pub struct ApiKeyProvider(pub ProviderId);

pub fn validate(value: &ApiKeyCredentialData) -> Result<(), String> {
    if !matches!(
        value.provider_id,
        ProviderId::Registered(_) | ProviderId::Commandcode
    ) {
        return Err(
            "generic API keys cannot replace reserved OAuth/discovery provider identities".into(),
        );
    }
    if ProviderId::parse(value.provider_id.as_str())? != value.provider_id {
        return Err("noncanonical API-key provider identity".into());
    }
    if value.access_token.trim().is_empty() || value.access_token.chars().any(char::is_control) {
        return Err("API key must not be empty or contain control characters".into());
    }
    if let Some(base) = value
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        let url = url::Url::parse(base).map_err(|_| "baseUrl must be a valid HTTP(S) URL")?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("baseUrl must be HTTP(S) without credentials, query, or fragment".into());
        }
    }
    Ok(())
}

impl SubscriptionProvider for ApiKeyProvider {
    fn id(&self) -> ProviderId {
        self.0.clone()
    }
    fn validate(&self, credential: &ProviderCredential) -> Result<(), String> {
        let ProviderCredential::ApiKey(value) = credential else {
            return Err("registered provider requires generic API-key credentials".into());
        };
        if value.provider_id != self.0 {
            return Err("API-key credential provider mismatch".into());
        }
        validate(value)
    }
    fn default_label(&self, _: &ProviderCredential) -> Option<String> {
        None
    }
    fn env_for_sidecar(&self, _: &Account, _: Option<&ProviderPreset>) -> Vec<(String, String)> {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::{self, AccountSummary, ProviderVault};
    fn account() -> Account {
        Account {
            id: "generic-account".into(),
            label: None,
            credential: ProviderCredential::ApiKey(ApiKeyCredentialData {
                provider_id: ProviderId::parse("custom:demo").unwrap(),
                access_token: "test-key".into(),
                stored_at_ms: 1,
                base_url: None,
            }),
            created_at_ms: 1,
            last_used_at_ms: 0,
            preset_id: None,
            auth_metadata: None,
        }
    }
    #[test]
    fn validates_identity_and_projects_without_secret_or_environment() {
        let a = account();
        let provider = ApiKeyProvider(ProviderId::parse("custom:demo").unwrap());
        assert!(provider.validate(&a.credential).is_ok());
        assert!(ApiKeyProvider(ProviderId::parse("custom:other").unwrap())
            .validate(&a.credential)
            .is_err());
        let summary = AccountSummary::from_account(&a);
        assert_eq!(summary.provider, "custom:demo");
        assert_eq!(summary.variant, "api-key");
        assert!(!serde_json::to_string(&summary)
            .unwrap()
            .contains("test-key"));
        assert!(provider.env_for_sidecar(&a, None).is_empty());
        let mut value = match a.credential {
            ProviderCredential::ApiKey(v) => v,
            _ => unreachable!(),
        };
        value.provider_id = ProviderId::Anthropic;
        assert!(validate(&value).is_err());
        value.provider_id = ProviderId::Registered("anthropic".into());
        assert!(validate(&value).is_err());
        value.provider_id = ProviderId::Commandcode;
        assert!(validate(&value).is_ok());
    }
    #[test]
    fn persisted_dynamic_vault_inventory_is_scoped_and_roundtrips() {
        let a = account();
        let provider = a.credential.provider();
        let mut v = ProviderVault::empty();
        v.accounts.push(a);
        v.active_account_id = Some("generic-account".into());
        vault::save_for_account("generic-inventory", provider.clone(), &v).unwrap();
        assert!(vault::list_provider_ids("generic-inventory")
            .unwrap()
            .contains(&provider));
        assert!(!vault::list_provider_ids("generic-other")
            .unwrap()
            .contains(&provider));
        assert_eq!(
            vault::load_for_account("generic-inventory", provider.clone())
                .unwrap()
                .unwrap(),
            v
        );
        assert!(vault::save_for_account("generic-inventory", ProviderId::Commandcode, &v).is_err());
        vault::clear_for_account("generic-inventory", provider.clone()).unwrap();
        assert!(!vault::list_provider_ids("generic-inventory")
            .unwrap()
            .contains(&provider));
    }
}

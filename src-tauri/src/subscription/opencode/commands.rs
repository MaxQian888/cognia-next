// OpenCode-specific Tauri commands.
//
// Two commands:
//
//   * opencode_oauth_discover — read-only probe of the OpenCode CLI's
//     auth.json, filtered to the whitelisted sub-providers.
//   * opencode_save_zen_key — persist a pasted OpenCode managed-plan API key
//     (Zen pay-per-request or Go flat-rate; `plan` param, default "zen") into
//     the vault as a new `OpencodeZen` account. The full OAuth flow into
//     opencode.ai is deferred (endpoints unverified); this is the bridge that
//     lets users with a Zen/Go subscription start using cognia today.

use super::discovery::{self, DiscoveredOpencodeAuth};
use super::OpencodeProvider;
use crate::subscription::provider::{ProviderId, SubscriptionProvider};
use crate::subscription::vault::{
    self, Account, OpencodeZenData, ProviderCredential, ProviderVault,
};

#[tauri::command]
pub async fn opencode_oauth_discover() -> Result<Option<DiscoveredOpencodeAuth>, String> {
    discovery::discover_opencode_auth()
}

#[tauri::command]
pub async fn opencode_save_zen_key(
    access_token: String,
    base_url: Option<String>,
    label: Option<String>,
    plan: Option<String>,
) -> Result<Account, String> {
    let provider = OpencodeProvider;
    let normalised_base_url = base_url
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let normalised_plan = plan
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty());
    let credential = ProviderCredential::OpencodeZen(OpencodeZenData {
        access_token,
        base_url: normalised_base_url,
        plan: normalised_plan,
        stored_at_ms: current_unix_ms(),
    });
    provider.validate(&credential)?;

    let resolved_label = label
        .filter(|s| !s.trim().is_empty())
        .or_else(|| provider.default_label(&credential));

    let now_ms = current_unix_ms();
    let account = Account {
        id: uuid::Uuid::now_v7().to_string(),
        label: resolved_label,
        credential,
        created_at_ms: now_ms,
        last_used_at_ms: now_ms,
        preset_id: None,
    };

    let mut vault = vault::load(ProviderId::Opencode)?.unwrap_or_else(ProviderVault::empty);
    vault.upsert_account(account.clone());
    vault::save(ProviderId::Opencode, &vault)?;
    Ok(account)
}

fn current_unix_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keyring_available() -> bool {
        std::env::var("COGNIA_TEST_KEYRING").ok().as_deref() == Some("1")
    }

    #[tokio::test]
    async fn save_zen_rejects_empty_token() {
        let result = opencode_save_zen_key(String::new(), None, None, None).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn save_zen_rejects_malformed_url() {
        let result =
            opencode_save_zen_key("ozk-x".into(), Some("not a url".into()), None, None).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn save_rejects_unknown_plan() {
        let result =
            opencode_save_zen_key("sk-x".into(), None, None, Some("pro".into())).await;
        assert!(result.unwrap_err().contains("plan"));
    }

    #[tokio::test]
    async fn save_go_plan_defaults_label_and_persists_plan() {
        if !keyring_available() {
            return;
        }
        let _ = vault::clear(ProviderId::Opencode);
        let account = opencode_save_zen_key("sk-go".into(), None, None, Some(" GO ".into()))
            .await
            .unwrap();
        assert_eq!(account.label.as_deref(), Some("OpenCode Go"));
        match &account.credential {
            ProviderCredential::OpencodeZen(z) => assert_eq!(z.effective_plan(), "go"),
            _ => panic!("wrong variant"),
        }
        vault::clear(ProviderId::Opencode).unwrap();
    }

    #[tokio::test]
    async fn save_zen_trims_blank_base_url_to_none() {
        if !keyring_available() {
            return;
        }
        let _ = vault::clear(ProviderId::Opencode);
        let account = opencode_save_zen_key("ozk-1".into(), Some("   ".into()), None, None)
            .await
            .unwrap();
        match &account.credential {
            ProviderCredential::OpencodeZen(z) => assert!(z.base_url.is_none()),
            _ => panic!("wrong variant"),
        }
        vault::clear(ProviderId::Opencode).unwrap();
    }

    #[tokio::test]
    async fn save_zen_persists_into_vault() {
        if !keyring_available() {
            return;
        }
        let _ = vault::clear(ProviderId::Opencode);
        let account = opencode_save_zen_key(
            "ozk-vault".into(),
            Some("https://zen.opencode.ai".into()),
            Some("Personal Zen".into()),
            None,
        )
        .await
        .unwrap();
        assert_eq!(account.label.as_deref(), Some("Personal Zen"));

        let v = vault::load(ProviderId::Opencode).unwrap().unwrap();
        assert_eq!(v.accounts.len(), 1);
        assert_eq!(v.accounts[0].id, account.id);

        vault::clear(ProviderId::Opencode).unwrap();
    }
}

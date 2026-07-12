// OpenCode-specific Tauri commands.
//
// Three commands:
//
//   * opencode_oauth_discover — read-only probe of the OpenCode CLI's
//     auth.json, filtered to the whitelisted sub-providers.
//   * opencode_save_zen_key — persist a pasted OpenCode managed-plan API key
//     (Zen pay-per-request or Go flat-rate; `plan` param, default "zen") into
//     the vault as a new `OpencodeZen` account. The full OAuth flow into
//     opencode.ai is deferred (endpoints unverified); this is the bridge that
//     lets users with a Zen/Go subscription start using cognia today.
//   * opencode_adopt_discovered — one-click adoption of a discovered auth.json
//     entry. Managed-plan API keys (opencode / opencode-go / opencode-zen)
//     become usable `OpencodeZen` accounts; everything else (anthropic /
//     openai, or OAuth-shaped entries) is snapshotted as an
//     `OpencodeDiscovered` account so the decision is recorded in the vault
//     without re-reading auth.json. The key is re-read HOST-side so the secret
//     never rides through the renderer.

use super::discovery::{self, DiscoveredOpencodeAuth};
use super::OpencodeProvider;
use crate::subscription::provider::{ProviderId, SubscriptionProvider};
use crate::subscription::vault::{
    self, Account, OpencodeDiscoveredData, OpencodeZenData, ProviderCredential, ProviderVault,
};

#[tauri::command]
pub async fn opencode_oauth_discover() -> Result<Option<DiscoveredOpencodeAuth>, String> {
    discovery::discover_opencode_auth()
}

#[tauri::command]
pub async fn opencode_save_zen_key(
    local_account_id: String,
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

    let mut vault = vault::load_for_account(&local_account_id, ProviderId::Opencode)?
        .unwrap_or_else(ProviderVault::empty);
    vault.upsert_account(account.clone());
    vault::save_for_account(&local_account_id, ProviderId::Opencode, &vault)?;
    Ok(account)
}

/// Extract the literal API key from a discovered auth.json payload. Covers the
/// managed-plan shape (`{"type":"api","key":"sk-..."}`) plus the bare
/// `apiKey` / `api_key` / `key` spellings `classify_entry` recognizes.
fn extract_api_key(payload_json: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(payload_json).ok()?;
    let obj = value.as_object()?;
    for field in ["key", "apiKey", "api_key"] {
        if let Some(serde_json::Value::String(s)) = obj.get(field) {
            if !s.trim().is_empty() {
                return Some(s.clone());
            }
        }
    }
    None
}

/// Map a discovered entry to the credential it adopts into (pure — unit
/// tested without env vars or the keyring). Managed-plan API keys become
/// `OpencodeZen`; everything else snapshots as `OpencodeDiscovered`.
fn credential_for_adoption(
    discovered: &DiscoveredOpencodeAuth,
    sub_provider: &str,
    now_ms: i64,
) -> Result<ProviderCredential, String> {
    let entry = discovered
        .entries
        .iter()
        .find(|e| e.sub_provider == sub_provider)
        .ok_or_else(|| format!("no discovered entry for \"{sub_provider}\" in auth.json"))?;

    let is_managed_plan = matches!(sub_provider, "opencode" | "opencode-go" | "opencode-zen");

    Ok(match extract_api_key(&entry.payload_json) {
        // A managed-plan key adopts into a fully usable Zen/Go account.
        Some(key) if is_managed_plan => {
            let plan = if sub_provider == "opencode-go" {
                "go"
            } else {
                "zen"
            };
            ProviderCredential::OpencodeZen(OpencodeZenData {
                access_token: key,
                base_url: None,
                plan: Some(plan.to_string()),
                stored_at_ms: now_ms,
            })
        }
        // Anthropic/OpenAI keys and OAuth-shaped entries: snapshot the verbatim
        // payload as an OpencodeDiscovered account. It records the adoption and
        // keeps the original bytes for the resolver without inventing a
        // credential shape we can't validate.
        _ => ProviderCredential::OpencodeDiscovered(OpencodeDiscoveredData {
            sub_provider: sub_provider.to_string(),
            auth_json_path: discovered.auth_json_path.clone(),
            original_payload_json: entry.payload_json.clone(),
            last_seen_at_ms: now_ms,
        }),
    })
}

/// Adopt one discovered auth.json entry into the vault (see module docs).
#[tauri::command]
pub async fn opencode_adopt_discovered(
    local_account_id: String,
    sub_provider: String,
) -> Result<Account, String> {
    let discovered = discovery::discover_opencode_auth()?
        .ok_or_else(|| "OpenCode auth.json path could not be resolved".to_string())?;
    let now_ms = current_unix_ms();
    let credential = credential_for_adoption(&discovered, &sub_provider, now_ms)?;

    let provider = OpencodeProvider;
    provider.validate(&credential)?;
    let label = provider.default_label(&credential);

    let account = Account {
        id: uuid::Uuid::now_v7().to_string(),
        label,
        credential,
        created_at_ms: now_ms,
        last_used_at_ms: now_ms,
        preset_id: None,
    };

    let mut vault = vault::load_for_account(&local_account_id, ProviderId::Opencode)?
        .unwrap_or_else(ProviderVault::empty);
    vault.upsert_account(account.clone());
    vault::save_for_account(&local_account_id, ProviderId::Opencode, &vault)?;
    Ok(account)
}

#[cfg(test)]
mod adoption_tests {
    use super::*;
    use crate::subscription::opencode::discovery::DiscoveredOpencodeEntry;

    fn discovered(entries: Vec<(&str, &str, &str)>) -> DiscoveredOpencodeAuth {
        DiscoveredOpencodeAuth {
            auth_json_path: "/home/u/.local/share/opencode/auth.json".into(),
            entries: entries
                .into_iter()
                .map(|(sub, kind, payload)| DiscoveredOpencodeEntry {
                    sub_provider: sub.into(),
                    kind: kind.into(),
                    payload_json: payload.into(),
                })
                .collect(),
        }
    }

    #[test]
    fn extract_api_key_reads_all_spellings() {
        assert_eq!(
            extract_api_key(r#"{"type":"api","key":"sk-1"}"#).as_deref(),
            Some("sk-1")
        );
        assert_eq!(
            extract_api_key(r#"{"apiKey":"sk-2"}"#).as_deref(),
            Some("sk-2")
        );
        assert_eq!(
            extract_api_key(r#"{"api_key":"sk-3"}"#).as_deref(),
            Some("sk-3")
        );
        assert_eq!(extract_api_key(r#"{"type":"oauth","access":"t"}"#), None);
        assert_eq!(extract_api_key("not json"), None);
    }

    #[test]
    fn managed_plan_keys_adopt_into_zen_accounts() {
        let d = discovered(vec![
            ("opencode", "api-key", r#"{"type":"api","key":"sk-zen"}"#),
            ("opencode-go", "api-key", r#"{"type":"api","key":"sk-go"}"#),
        ]);
        match credential_for_adoption(&d, "opencode", 1).unwrap() {
            ProviderCredential::OpencodeZen(z) => {
                assert_eq!(z.access_token, "sk-zen");
                assert_eq!(z.effective_plan(), "zen");
            }
            other => panic!("expected OpencodeZen, got {other:?}"),
        }
        match credential_for_adoption(&d, "opencode-go", 1).unwrap() {
            ProviderCredential::OpencodeZen(z) => {
                assert_eq!(z.access_token, "sk-go");
                assert_eq!(z.effective_plan(), "go");
            }
            other => panic!("expected OpencodeZen, got {other:?}"),
        }
    }

    #[test]
    fn non_managed_entries_snapshot_as_discovered() {
        let d = discovered(vec![
            ("anthropic", "api-key", r#"{"apiKey":"sk-ant"}"#),
            ("opencode-zen", "oauth", r#"{"type":"oauth","access":"t"}"#),
        ]);
        // anthropic key: NOT a managed plan → snapshot, key stays in payload.
        match credential_for_adoption(&d, "anthropic", 7).unwrap() {
            ProviderCredential::OpencodeDiscovered(s) => {
                assert_eq!(s.sub_provider, "anthropic");
                assert!(s.original_payload_json.contains("sk-ant"));
                assert_eq!(s.last_seen_at_ms, 7);
            }
            other => panic!("expected OpencodeDiscovered, got {other:?}"),
        }
        // Managed plan but OAuth-shaped (no literal key) → snapshot too.
        match credential_for_adoption(&d, "opencode-zen", 7).unwrap() {
            ProviderCredential::OpencodeDiscovered(s) => {
                assert_eq!(s.sub_provider, "opencode-zen");
            }
            other => panic!("expected OpencodeDiscovered, got {other:?}"),
        }
        // Both variants pass provider validation (adopt persists them as-is).
        for sub in ["anthropic", "opencode-zen"] {
            let c = credential_for_adoption(&d, sub, 7).unwrap();
            OpencodeProvider.validate(&c).unwrap();
        }
    }

    #[test]
    fn missing_entry_is_an_error() {
        let d = discovered(vec![]);
        assert!(credential_for_adoption(&d, "openai", 1)
            .unwrap_err()
            .contains("openai"));
    }
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

    const LOCAL_ACCOUNT_ID: &str = "local-test";

    fn keyring_available() -> bool {
        std::env::var("COGNIA_TEST_KEYRING").ok().as_deref() == Some("1")
    }

    #[tokio::test]
    async fn save_zen_rejects_empty_token() {
        let result =
            opencode_save_zen_key(LOCAL_ACCOUNT_ID.into(), String::new(), None, None, None).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn save_zen_rejects_malformed_url() {
        let result = opencode_save_zen_key(
            LOCAL_ACCOUNT_ID.into(),
            "ozk-x".into(),
            Some("not a url".into()),
            None,
            None,
        )
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn save_rejects_unknown_plan() {
        let result = opencode_save_zen_key(
            LOCAL_ACCOUNT_ID.into(),
            "sk-x".into(),
            None,
            None,
            Some("pro".into()),
        )
        .await;
        assert!(result.unwrap_err().contains("plan"));
    }

    #[tokio::test]
    async fn save_go_plan_defaults_label_and_persists_plan() {
        if !keyring_available() {
            return;
        }
        let _ = vault::clear_for_account(LOCAL_ACCOUNT_ID, ProviderId::Opencode);
        let account = opencode_save_zen_key(
            LOCAL_ACCOUNT_ID.into(),
            "sk-go".into(),
            None,
            None,
            Some(" GO ".into()),
        )
        .await
        .unwrap();
        assert_eq!(account.label.as_deref(), Some("OpenCode Go"));
        match &account.credential {
            ProviderCredential::OpencodeZen(z) => assert_eq!(z.effective_plan(), "go"),
            _ => panic!("wrong variant"),
        }
        vault::clear_for_account(LOCAL_ACCOUNT_ID, ProviderId::Opencode).unwrap();
    }

    #[tokio::test]
    async fn save_zen_trims_blank_base_url_to_none() {
        if !keyring_available() {
            return;
        }
        let _ = vault::clear_for_account(LOCAL_ACCOUNT_ID, ProviderId::Opencode);
        let account = opencode_save_zen_key(
            LOCAL_ACCOUNT_ID.into(),
            "ozk-1".into(),
            Some("   ".into()),
            None,
            None,
        )
        .await
        .unwrap();
        match &account.credential {
            ProviderCredential::OpencodeZen(z) => assert!(z.base_url.is_none()),
            _ => panic!("wrong variant"),
        }
        vault::clear_for_account(LOCAL_ACCOUNT_ID, ProviderId::Opencode).unwrap();
    }

    #[tokio::test]
    async fn save_zen_persists_into_vault() {
        if !keyring_available() {
            return;
        }
        let _ = vault::clear_for_account(LOCAL_ACCOUNT_ID, ProviderId::Opencode);
        let account = opencode_save_zen_key(
            LOCAL_ACCOUNT_ID.into(),
            "ozk-vault".into(),
            Some("https://zen.opencode.ai".into()),
            Some("Personal Zen".into()),
            None,
        )
        .await
        .unwrap();
        assert_eq!(account.label.as_deref(), Some("Personal Zen"));

        let v = vault::load_for_account(LOCAL_ACCOUNT_ID, ProviderId::Opencode)
            .unwrap()
            .unwrap();
        assert_eq!(v.accounts.len(), 1);
        assert_eq!(v.accounts[0].id, account.id);

        vault::clear_for_account(LOCAL_ACCOUNT_ID, ProviderId::Opencode).unwrap();
    }
}

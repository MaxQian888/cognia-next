// v1 → v2 migration.
//
// On app boot we check whether the user has a legacy single-account credential
// stored under the v1 keyring service names:
//
//   * "com.cognia.claude-subscription/v1" / "default"  → AnthropicCredentialData
//   * "com.cognia.codex-subscription/v1"  / "default"  → CodexCredentialData
//
// For each that exists, we wrap it as one `Account { id: uuidv7(), label:
// Some("Default"), credential: ProviderCredential::<...>, ... }`, write to the
// v2 vault with `active_account_id = Some(id)`, and leave the v1 entry alone
// (90-day rollback window — actual purge is the renderer's responsibility via
// a Dexie-tracked timer).
//
// The migration is idempotent: a second call after the v2 vault has the
// migrated account returns `AlreadyMigrated` instead of duplicating.

use keyring::Entry;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::subscription::provider::ProviderId;
use crate::subscription::vault::{
    self, Account, AnthropicCredentialData, CodexCredentialData, ProviderCredential, ProviderVault,
};

const V1_ANTHROPIC_SERVICE: &str = "com.cognia.claude-subscription/v1";
const V1_CODEX_SERVICE: &str = "com.cognia.codex-subscription/v1";
const V1_ACCOUNT: &str = "default";
#[allow(dead_code)]
const V2_ACCOUNT_MIGRATION_SERVICE: &str = "com.cognia.subscription/v2/account-migration";

/// One provider's outcome from a single migration run.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum MigrationOutcome {
    /// No legacy entry existed; nothing to do.
    NoLegacyData { provider: String },
    /// Legacy entry existed and was wrapped into a v2 account.
    Migrated {
        provider: String,
        #[serde(rename = "accountId")]
        account_id: String,
    },
    /// V2 vault already contains an account whose body matches the legacy
    /// payload (idempotent re-run).
    AlreadyMigrated { provider: String },
}

/// Migrate every provider that has a v1 schema in one shot. Returns one entry
/// per provider — three entries total today (anthropic, codex, opencode).
/// OpenCode has no v1 schema so it always returns `NoLegacyData`.
#[allow(dead_code)]
pub fn migrate_all() -> Vec<MigrationOutcome> {
    vec![
        migrate_v1_to_v2(ProviderId::Anthropic).unwrap_or(MigrationOutcome::NoLegacyData {
            provider: "anthropic".into(),
        }),
        migrate_v1_to_v2(ProviderId::Codex).unwrap_or(MigrationOutcome::NoLegacyData {
            provider: "codex".into(),
        }),
        MigrationOutcome::NoLegacyData {
            provider: "opencode".into(),
        },
    ]
}

/// Account-scoped legacy migration for the multi-local-account app. The
/// legacy v1 entries are device-global, so a provider-level marker records
/// which local account adopted them first. Later accounts must not see or copy
/// those same credentials.
#[allow(dead_code)]
pub fn migrate_all_for_account(local_account_id: &str) -> Vec<MigrationOutcome> {
    vec![
        migrate_v1_to_v2_for_account(local_account_id, ProviderId::Anthropic).unwrap_or(
            MigrationOutcome::NoLegacyData {
                provider: "anthropic".into(),
            },
        ),
        migrate_v1_to_v2_for_account(local_account_id, ProviderId::Codex).unwrap_or(
            MigrationOutcome::NoLegacyData {
                provider: "codex".into(),
            },
        ),
        MigrationOutcome::NoLegacyData {
            provider: "opencode".into(),
        },
    ]
}

/// Migrate one provider. Returns the outcome; `Err` is reserved for genuine
/// I/O / parse failures (rather than "nothing to migrate").
#[allow(dead_code)]
pub fn migrate_v1_to_v2(provider: ProviderId) -> Result<MigrationOutcome, String> {
    match provider {
        ProviderId::Anthropic => migrate_anthropic(),
        ProviderId::Codex => migrate_codex(),
        ProviderId::Opencode => Ok(MigrationOutcome::NoLegacyData {
            provider: "opencode".into(),
        }),
    }
}

#[allow(dead_code)]
pub fn migrate_v1_to_v2_for_account(
    local_account_id: &str,
    provider: ProviderId,
) -> Result<MigrationOutcome, String> {
    match provider {
        ProviderId::Anthropic => migrate_anthropic_for_account(local_account_id),
        ProviderId::Codex => migrate_codex_for_account(local_account_id),
        ProviderId::Opencode => Ok(MigrationOutcome::NoLegacyData {
            provider: "opencode".into(),
        }),
    }
}

#[allow(dead_code)]
fn migrate_anthropic() -> Result<MigrationOutcome, String> {
    let provider_id = "anthropic".to_string();
    let Some(blob) = read_v1_blob(V1_ANTHROPIC_SERVICE, V1_ACCOUNT)? else {
        return Ok(MigrationOutcome::NoLegacyData {
            provider: provider_id,
        });
    };
    let parsed: AnthropicCredentialData = serde_json::from_str(&blob)
        .map_err(|e| format!("legacy anthropic credential parse failed: {e}"))?;

    let mut vault = vault::load(ProviderId::Anthropic)?.unwrap_or_else(ProviderVault::empty);

    // Idempotence: if the v2 vault already has the same access_token in an
    // Anthropic account, treat the migration as already-done. This guards
    // against re-running migration after a user has manually re-imported the
    // same credential.
    let already = vault.accounts.iter().any(|a| match &a.credential {
        ProviderCredential::Anthropic(c) => c.access_token == parsed.access_token,
        _ => false,
    });
    if already {
        return Ok(MigrationOutcome::AlreadyMigrated {
            provider: provider_id,
        });
    }

    let now_ms = current_unix_ms();
    let account = Account {
        id: new_uuid_v7(),
        label: Some("Default".into()),
        credential: ProviderCredential::Anthropic(parsed),
        created_at_ms: now_ms,
        last_used_at_ms: now_ms,
        preset_id: None,
    };
    let account_id = account.id.clone();
    vault.upsert_account(account);
    if vault.active_account_id.is_none() {
        vault.active_account_id = Some(account_id.clone());
    }
    vault::save(ProviderId::Anthropic, &vault)?;

    Ok(MigrationOutcome::Migrated {
        provider: provider_id,
        account_id,
    })
}

#[allow(dead_code)]
fn migrate_codex() -> Result<MigrationOutcome, String> {
    let provider_id = "codex".to_string();
    let Some(blob) = read_v1_blob(V1_CODEX_SERVICE, V1_ACCOUNT)? else {
        return Ok(MigrationOutcome::NoLegacyData {
            provider: provider_id,
        });
    };
    let parsed: CodexCredentialData = serde_json::from_str(&blob)
        .map_err(|e| format!("legacy codex credential parse failed: {e}"))?;

    let mut vault = vault::load(ProviderId::Codex)?.unwrap_or_else(ProviderVault::empty);

    // Idempotence: match on (access_token, auth_mode). The access_token alone
    // would collide between chatgpt and api_key modes if both use the same
    // bearer (rare in practice but possible).
    let already = vault.accounts.iter().any(|a| match &a.credential {
        ProviderCredential::Codex(c) => {
            c.access_token == parsed.access_token && c.auth_mode == parsed.auth_mode
        }
        _ => false,
    });
    if already {
        return Ok(MigrationOutcome::AlreadyMigrated {
            provider: provider_id,
        });
    }

    let now_ms = current_unix_ms();
    let account = Account {
        id: new_uuid_v7(),
        label: Some("Default".into()),
        credential: ProviderCredential::Codex(parsed),
        created_at_ms: now_ms,
        last_used_at_ms: now_ms,
        preset_id: None,
    };
    let account_id = account.id.clone();
    vault.upsert_account(account);
    if vault.active_account_id.is_none() {
        vault.active_account_id = Some(account_id.clone());
    }
    vault::save(ProviderId::Codex, &vault)?;

    Ok(MigrationOutcome::Migrated {
        provider: provider_id,
        account_id,
    })
}

#[allow(dead_code)]
fn migrate_anthropic_for_account(local_account_id: &str) -> Result<MigrationOutcome, String> {
    let provider_id = "anthropic".to_string();
    let Some(blob) = read_v1_blob(V1_ANTHROPIC_SERVICE, V1_ACCOUNT)? else {
        return Ok(MigrationOutcome::NoLegacyData {
            provider: provider_id,
        });
    };
    if read_account_migration_marker(ProviderId::Anthropic)?.is_some() {
        return Ok(MigrationOutcome::AlreadyMigrated {
            provider: provider_id,
        });
    }
    let parsed: AnthropicCredentialData = serde_json::from_str(&blob)
        .map_err(|e| format!("legacy anthropic credential parse failed: {e}"))?;
    let mut vault = vault::load_for_account(local_account_id, ProviderId::Anthropic)?
        .unwrap_or_else(ProviderVault::empty);
    let already = vault.accounts.iter().any(|a| match &a.credential {
        ProviderCredential::Anthropic(c) => c.access_token == parsed.access_token,
        _ => false,
    });
    if already {
        write_account_migration_marker(ProviderId::Anthropic, local_account_id)?;
        return Ok(MigrationOutcome::AlreadyMigrated {
            provider: provider_id,
        });
    }

    let now_ms = current_unix_ms();
    let account = Account {
        id: new_uuid_v7(),
        label: Some("Default".into()),
        credential: ProviderCredential::Anthropic(parsed),
        created_at_ms: now_ms,
        last_used_at_ms: now_ms,
        preset_id: None,
    };
    let account_id = account.id.clone();
    vault.upsert_account(account);
    if vault.active_account_id.is_none() {
        vault.active_account_id = Some(account_id.clone());
    }
    vault::save_for_account(local_account_id, ProviderId::Anthropic, &vault)?;
    write_account_migration_marker(ProviderId::Anthropic, local_account_id)?;
    Ok(MigrationOutcome::Migrated {
        provider: provider_id,
        account_id,
    })
}

#[allow(dead_code)]
fn migrate_codex_for_account(local_account_id: &str) -> Result<MigrationOutcome, String> {
    let provider_id = "codex".to_string();
    let Some(blob) = read_v1_blob(V1_CODEX_SERVICE, V1_ACCOUNT)? else {
        return Ok(MigrationOutcome::NoLegacyData {
            provider: provider_id,
        });
    };
    if read_account_migration_marker(ProviderId::Codex)?.is_some() {
        return Ok(MigrationOutcome::AlreadyMigrated {
            provider: provider_id,
        });
    }
    let parsed: CodexCredentialData = serde_json::from_str(&blob)
        .map_err(|e| format!("legacy codex credential parse failed: {e}"))?;
    let mut vault = vault::load_for_account(local_account_id, ProviderId::Codex)?
        .unwrap_or_else(ProviderVault::empty);
    let already = vault.accounts.iter().any(|a| match &a.credential {
        ProviderCredential::Codex(c) => {
            c.access_token == parsed.access_token && c.auth_mode == parsed.auth_mode
        }
        _ => false,
    });
    if already {
        write_account_migration_marker(ProviderId::Codex, local_account_id)?;
        return Ok(MigrationOutcome::AlreadyMigrated {
            provider: provider_id,
        });
    }

    let now_ms = current_unix_ms();
    let account = Account {
        id: new_uuid_v7(),
        label: Some("Default".into()),
        credential: ProviderCredential::Codex(parsed),
        created_at_ms: now_ms,
        last_used_at_ms: now_ms,
        preset_id: None,
    };
    let account_id = account.id.clone();
    vault.upsert_account(account);
    if vault.active_account_id.is_none() {
        vault.active_account_id = Some(account_id.clone());
    }
    vault::save_for_account(local_account_id, ProviderId::Codex, &vault)?;
    write_account_migration_marker(ProviderId::Codex, local_account_id)?;
    Ok(MigrationOutcome::Migrated {
        provider: provider_id,
        account_id,
    })
}

fn read_v1_blob(service: &str, account: &str) -> Result<Option<String>, String> {
    let entry =
        Entry::new(service, account).map_err(|e| format!("legacy keyring init failed: {e}"))?;
    match entry.get_password() {
        Ok(blob) => Ok(Some(blob)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("legacy keyring read failed: {e}")),
    }
}

#[allow(dead_code)]
fn read_account_migration_marker(provider: ProviderId) -> Result<Option<String>, String> {
    let entry = Entry::new(V2_ACCOUNT_MIGRATION_SERVICE, provider.as_str())
        .map_err(|e| format!("account migration marker init failed: {e}"))?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("account migration marker read failed: {e}")),
    }
}

#[allow(dead_code)]
fn write_account_migration_marker(
    provider: ProviderId,
    local_account_id: &str,
) -> Result<(), String> {
    let entry = Entry::new(V2_ACCOUNT_MIGRATION_SERVICE, provider.as_str())
        .map_err(|e| format!("account migration marker init failed: {e}"))?;
    entry
        .set_password(local_account_id)
        .map_err(|e| format!("account migration marker write failed: {e}"))
}

fn new_uuid_v7() -> String {
    // `uuid::Uuid::now_v7()` uses the current time + random — gives both
    // monotonic ordering and uniqueness across processes.
    Uuid::now_v7().to_string()
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

    fn clear_v1(service: &str) {
        if let Ok(e) = Entry::new(service, V1_ACCOUNT) {
            let _ = e.delete_credential();
        }
    }

    fn write_v1_anthropic() -> String {
        let cred = AnthropicCredentialData {
            access_token: "oat01-v1".into(),
            refresh_token: "rt-v1".into(),
            expires_at_ms: 1_800_000_000_000,
            mode: "subscription".into(),
            scope: Some("user:profile".into()),
            email: Some("legacy@example.com".into()),
            plan: Some("pro".into()),
            stored_at_ms: 1_700_000_000_000,
        };
        let blob = serde_json::to_string(&cred).unwrap();
        let entry = Entry::new(V1_ANTHROPIC_SERVICE, V1_ACCOUNT).unwrap();
        entry.set_password(&blob).unwrap();
        blob
    }

    fn write_v1_codex() -> String {
        let cred = CodexCredentialData {
            access_token: "oat-codex-v1".into(),
            refresh_token: "rt-codex-v1".into(),
            id_token_raw: "eyJ.fake.jwt".into(),
            expires_at_ms: 1_800_000_000_000,
            auth_mode: "chatgpt".into(),
            email: Some("codex@example.com".into()),
            chatgpt_plan_type: Some("plus".into()),
            chatgpt_user_id: Some("u1".into()),
            account_id: Some("acct_1".into()),
            original_source: Some("oauth".into()),
            stored_at_ms: 1_700_000_000_000,
        };
        let blob = serde_json::to_string(&cred).unwrap();
        let entry = Entry::new(V1_CODEX_SERVICE, V1_ACCOUNT).unwrap();
        entry.set_password(&blob).unwrap();
        blob
    }

    #[test]
    fn uuid_v7_is_unique_and_well_formed() {
        let a = new_uuid_v7();
        let b = new_uuid_v7();
        assert_ne!(a, b);
        // RFC 9562 UUID format: 8-4-4-4-12 hex digits + dashes = 36 chars.
        assert_eq!(a.len(), 36);
        assert_eq!(a.chars().filter(|c| *c == '-').count(), 4);
    }

    #[test]
    fn no_legacy_data_returns_marker_when_nothing_stored() {
        if !keyring_available() {
            return;
        }
        clear_v1(V1_ANTHROPIC_SERVICE);
        // Clear v2 as well to make sure we don't trip the "already" branch.
        let _ = vault::clear(ProviderId::Anthropic);

        let outcome = migrate_v1_to_v2(ProviderId::Anthropic).unwrap();
        assert!(matches!(outcome, MigrationOutcome::NoLegacyData { .. }));
    }

    #[test]
    fn opencode_has_no_legacy() {
        let outcome = migrate_v1_to_v2(ProviderId::Opencode).unwrap();
        match outcome {
            MigrationOutcome::NoLegacyData { provider } => assert_eq!(provider, "opencode"),
            other => panic!("unexpected outcome: {other:?}"),
        }
    }

    #[test]
    fn migrate_anthropic_wraps_v1_into_v2() {
        if !keyring_available() {
            return;
        }
        let _ = vault::clear(ProviderId::Anthropic);
        clear_v1(V1_ANTHROPIC_SERVICE);
        write_v1_anthropic();

        let outcome = migrate_v1_to_v2(ProviderId::Anthropic).unwrap();
        let account_id = match outcome {
            MigrationOutcome::Migrated {
                provider,
                account_id,
            } => {
                assert_eq!(provider, "anthropic");
                account_id
            }
            other => panic!("expected Migrated, got {other:?}"),
        };

        let vault = vault::load(ProviderId::Anthropic).unwrap().unwrap();
        assert_eq!(vault.accounts.len(), 1);
        assert_eq!(vault.accounts[0].id, account_id);
        assert_eq!(vault.accounts[0].label.as_deref(), Some("Default"));
        assert_eq!(
            vault.active_account_id.as_deref(),
            Some(account_id.as_str())
        );
        match &vault.accounts[0].credential {
            ProviderCredential::Anthropic(c) => {
                assert_eq!(c.access_token, "oat01-v1");
                assert_eq!(c.email.as_deref(), Some("legacy@example.com"));
            }
            _ => panic!("wrong variant"),
        }

        // V1 entry untouched (90-day rollback).
        let entry = Entry::new(V1_ANTHROPIC_SERVICE, V1_ACCOUNT).unwrap();
        assert!(entry.get_password().is_ok());

        // Cleanup.
        clear_v1(V1_ANTHROPIC_SERVICE);
        vault::clear(ProviderId::Anthropic).unwrap();
    }

    #[test]
    fn re_running_migration_is_idempotent() {
        if !keyring_available() {
            return;
        }
        let _ = vault::clear(ProviderId::Anthropic);
        clear_v1(V1_ANTHROPIC_SERVICE);
        write_v1_anthropic();

        let first = migrate_v1_to_v2(ProviderId::Anthropic).unwrap();
        assert!(matches!(first, MigrationOutcome::Migrated { .. }));

        let second = migrate_v1_to_v2(ProviderId::Anthropic).unwrap();
        match second {
            MigrationOutcome::AlreadyMigrated { provider } => assert_eq!(provider, "anthropic"),
            other => panic!("expected AlreadyMigrated, got {other:?}"),
        }

        // Vault still has exactly one account.
        let vault = vault::load(ProviderId::Anthropic).unwrap().unwrap();
        assert_eq!(vault.accounts.len(), 1);

        clear_v1(V1_ANTHROPIC_SERVICE);
        vault::clear(ProviderId::Anthropic).unwrap();
    }

    #[test]
    fn migrate_codex_wraps_v1_into_v2() {
        if !keyring_available() {
            return;
        }
        let _ = vault::clear(ProviderId::Codex);
        clear_v1(V1_CODEX_SERVICE);
        write_v1_codex();

        let outcome = migrate_v1_to_v2(ProviderId::Codex).unwrap();
        match outcome {
            MigrationOutcome::Migrated { provider, .. } => assert_eq!(provider, "codex"),
            other => panic!("expected Migrated, got {other:?}"),
        }

        let vault = vault::load(ProviderId::Codex).unwrap().unwrap();
        assert_eq!(vault.accounts.len(), 1);
        match &vault.accounts[0].credential {
            ProviderCredential::Codex(c) => {
                assert_eq!(c.access_token, "oat-codex-v1");
                assert_eq!(c.auth_mode, "chatgpt");
            }
            _ => panic!("wrong variant"),
        }

        clear_v1(V1_CODEX_SERVICE);
        vault::clear(ProviderId::Codex).unwrap();
    }

    #[test]
    fn migrate_all_returns_three_entries() {
        // Doesn't write any v1 data — keyring availability irrelevant.
        let outcomes = migrate_all();
        assert_eq!(outcomes.len(), 3);
        assert_eq!(extract_provider(&outcomes[0]), "anthropic");
        assert_eq!(extract_provider(&outcomes[1]), "codex");
        assert_eq!(extract_provider(&outcomes[2]), "opencode");
    }

    fn extract_provider(o: &MigrationOutcome) -> &str {
        match o {
            MigrationOutcome::NoLegacyData { provider }
            | MigrationOutcome::Migrated { provider, .. }
            | MigrationOutcome::AlreadyMigrated { provider } => provider.as_str(),
        }
    }
}

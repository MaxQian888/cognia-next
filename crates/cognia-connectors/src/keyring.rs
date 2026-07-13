//! Storage helpers for platform connector credentials.
//!
//! Service: `"com.cognia.platforms"`.
//! Account naming: `"<adapterId>:<credentialName>"` — e.g. `"tg-personal:botToken"`.
//!
//! Backed by [`cognia_secrets::secret_store`] (single OS-keyring master key); a missing
//! entry maps to `None` on reads, and delete is idempotent.

use cognia_secrets::secret_store;

const SERVICE: &str = "com.cognia.platforms";

fn account_key(adapter_id: &str, credential: &str) -> String {
    format!("{adapter_id}:{credential}")
}

/// Store `value` for `(adapter_id, credential)`.
pub fn set(adapter_id: &str, credential: &str, value: &str) -> Result<(), String> {
    secret_store::set(SERVICE, &account_key(adapter_id, credential), value)
}

/// Retrieve the stored value for `(adapter_id, credential)`.
///
/// Returns `Ok(None)` when no entry exists.
pub fn get(adapter_id: &str, credential: &str) -> Result<Option<String>, String> {
    secret_store::get(SERVICE, &account_key(adapter_id, credential))
}

/// Delete the entry for `(adapter_id, credential)`.
///
/// Returns `Ok(())` even when the entry did not exist.
pub fn delete(adapter_id: &str, credential: &str) -> Result<(), String> {
    secret_store::delete(SERVICE, &account_key(adapter_id, credential))
}

/// Probe each name in `accounts` for the given `adapter_id` and return the
/// subset that have an entry.
///
/// OS keyrings don't provide reliable enumeration, so the caller (TS side)
/// supplies the list of account names it knows about (from
/// `AdapterInstanceRow.credentialsRef.accounts`), and we probe each one.
pub fn list(adapter_id: &str, accounts: &[String]) -> Result<Vec<String>, String> {
    let mut found = Vec::new();
    for account in accounts {
        if get(adapter_id, account)?.is_some() {
            found.push(account.clone());
        }
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_key_joins_adapter_and_credential() {
        assert_eq!(
            account_key("tg-personal", "botToken"),
            "tg-personal:botToken"
        );
        assert_eq!(
            account_key("", "attachment-master-key"),
            ":attachment-master-key"
        );
    }

    #[test]
    fn set_get_delete_round_trip() {
        // Hermetic via the in-memory secret_store global under cfg(test).
        set("tg-sgrdt", "botTokenCK", "secret123").unwrap();
        assert_eq!(
            get("tg-sgrdt", "botTokenCK").unwrap(),
            Some("secret123".to_string())
        );
        delete("tg-sgrdt", "botTokenCK").unwrap();
        assert_eq!(get("tg-sgrdt", "botTokenCK").unwrap(), None);
    }

    #[test]
    fn delete_nonexistent_is_ok() {
        delete("ds-main-xvbq", "botTokenNE").unwrap();
    }

    #[test]
    fn list_returns_only_set_accounts() {
        set("slack-work-list", "userToken", "xoxp-abc").unwrap();
        set("slack-work-list", "botToken", "xoxb-def").unwrap();

        let accounts = vec![
            "userToken".to_string(),
            "botToken".to_string(),
            "signingSecret".to_string(),
        ];
        let found = list("slack-work-list", &accounts).unwrap();
        assert!(found.contains(&"userToken".to_string()));
        assert!(found.contains(&"botToken".to_string()));
        assert!(!found.contains(&"signingSecret".to_string()));
    }
}

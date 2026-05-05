//! OS-keyring helpers for platform connector credentials.
//!
//! Service: `"com.cognia.platforms"`.
//! Account naming: `"<adapterId>:<credentialName>"` — e.g. `"tg-personal:botToken"`.
//!
//! Mirrors `remote_control::keyring` — same `keyring::Entry::new` pattern,
//! `NoEntry` tolerantly maps to `None` on reads, and `NoEntry` on delete is
//! treated as success.

use keyring::Entry;

const SERVICE: &str = "com.cognia.platforms";

fn account_key(adapter_id: &str, credential: &str) -> String {
    format!("{adapter_id}:{credential}")
}

fn entry(adapter_id: &str, credential: &str) -> Result<Entry, String> {
    let account = account_key(adapter_id, credential);
    Entry::new(SERVICE, &account).map_err(|e| format!("keyring init failed: {e}"))
}

/// Store `value` for `(adapter_id, credential)`.
pub fn set(adapter_id: &str, credential: &str, value: &str) -> Result<(), String> {
    let e = entry(adapter_id, credential)?;
    e.set_password(value)
        .map_err(|e| format!("keyring write failed: {e}"))
}

/// Retrieve the stored value for `(adapter_id, credential)`.
///
/// Returns `Ok(None)` when no entry exists.
pub fn get(adapter_id: &str, credential: &str) -> Result<Option<String>, String> {
    let e = entry(adapter_id, credential)?;
    match e.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(format!("keyring read failed: {err}")),
    }
}

/// Delete the entry for `(adapter_id, credential)`.
///
/// Returns `Ok(())` even when the entry did not exist.
pub fn delete(adapter_id: &str, credential: &str) -> Result<(), String> {
    let e = entry(adapter_id, credential)?;
    match e.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(format!("keyring delete failed: {err}")),
    }
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
        match get(adapter_id, account)? {
            Some(_) => found.push(account.clone()),
            None => {}
        }
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Mirror `tts::keyring` pattern — skip when no OS keyring available.
    fn keyring_available() -> bool {
        crate::connectors::keyring_available()
    }

    #[test]
    fn set_get_delete_round_trip() {
        if !keyring_available() {
            return;
        }
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
        if !keyring_available() {
            return;
        }
        delete("ds-main-xvbq", "botTokenNE").unwrap();
    }

    #[test]
    fn list_returns_only_set_accounts() {
        if !keyring_available() {
            return;
        }
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

//! Storage helpers for platform connector credentials.
//!
//! Service: `"com.cognia.platforms"`.
//! Account naming: `"<adapterId>:<credentialName>"` — e.g. `"tg-personal:botToken"`.
//!
//! Backed by [`cognia_secrets::secret_store`] (single OS-keyring master key); a missing
//! entry maps to `None` on reads, and delete is idempotent.

use cognia_secrets::secret_store;

/// Owned by `host_secrets`, which indexes these entries for "Secrets on this
/// host" (ADR-0224 A6); one constant so the two cannot drift.
const SERVICE: &str = cognia_secrets::host_secrets::CONNECTOR_SERVICE;

/// The store account for `(adapter_id, credential)`, which is also the name
/// `host_secrets` lists the credential under.
pub fn account_key(adapter_id: &str, credential: &str) -> String {
    format!("{adapter_id}:{credential}")
}

/// Store `value` for `(adapter_id, credential)`.
pub fn set(adapter_id: &str, credential: &str, value: &str) -> Result<(), String> {
    set_with_writer(
        adapter_id,
        credential,
        value,
        None,
        chrono::Utc::now().timestamp_millis(),
    )
}

/// Seal a connector credential, write generation and its actual writer in
/// one transaction. Callers must not append a separate metadata-only write.
pub fn set_with_writer(
    adapter_id: &str,
    credential: &str,
    value: &str,
    writer: Option<cognia_secrets::host_secrets::SecretWriter>,
    now_ms: i64,
) -> Result<(), String> {
    let write = || {
        cognia_secrets::host_secrets::set(
            cognia_secrets::host_secrets::HostSecretKind::Connector,
            &account_key(adapter_id, credential),
            value,
            writer,
            now_ms,
        )
    };
    if matches!(credential, "token" | "encodingAesKey" | "appId") {
        super::wechat_oa_ingress::replace_token(adapter_id, write)
    } else {
        write()
    }
}

/// Retrieve the stored value for `(adapter_id, credential)`.
///
/// Returns `Ok(None)` when no entry exists.
pub fn get(adapter_id: &str, credential: &str) -> Result<Option<String>, String> {
    secret_store::get(SERVICE, &account_key(adapter_id, credential))
}

/// Host-only atomic value/revision capture used to fence asynchronous work.
pub fn get_snapshot(
    adapter_id: &str,
    credential: &str,
) -> Result<Option<cognia_secrets::host_secrets::HostSecretSnapshot>, String> {
    cognia_secrets::host_secrets::snapshot(
        cognia_secrets::host_secrets::HostSecretKind::Connector,
        &account_key(adapter_id, credential),
    )
}

/// Delete the entry for `(adapter_id, credential)`.
///
/// Returns `Ok(())` even when the entry did not exist.
pub fn delete(adapter_id: &str, credential: &str) -> Result<(), String> {
    let delete = || {
        cognia_secrets::host_secrets::delete(
            cognia_secrets::host_secrets::HostSecretKind::Connector,
            &account_key(adapter_id, credential),
        )
    };
    if credential == "token" {
        super::wechat_oa_ingress::delete_token_and_clear(adapter_id, delete)
    } else if matches!(credential, "encodingAesKey" | "appId") {
        super::wechat_oa_ingress::replace_token(adapter_id, delete)
    } else {
        delete()
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
    fn indexed_connector_writes_keep_the_actual_owner_and_revision_together() {
        use cognia_secrets::host_secrets::{self, HostSecretKind, SecretWriter};
        let adapter = "atomic-keyring-owner";
        let writer = |device: &str| {
            Some(SecretWriter {
                device_id: device.into(),
                label: None,
            })
        };
        set_with_writer(adapter, "token", "same", writer("keyring-owner-old"), 1).unwrap();
        let first = get_snapshot(adapter, "token").unwrap().unwrap();
        set_with_writer(adapter, "token", "same", writer("keyring-owner-new"), 2).unwrap();
        let fresh = get_snapshot(adapter, "token").unwrap().unwrap();
        assert_ne!(first.revision, fresh.revision);
        host_secrets::forget_device("keyring-owner-old").unwrap();
        assert_eq!(
            get_snapshot(adapter, "token").unwrap().unwrap().revision,
            fresh.revision
        );
        let entry = host_secrets::list()
            .unwrap()
            .into_iter()
            .find(|entry| {
                entry.kind == HostSecretKind::Connector
                    && entry.name == account_key(adapter, "token")
            })
            .unwrap();
        assert_eq!(entry.set_by, writer("keyring-owner-new"));
        delete(adapter, "token").unwrap();
        assert!(get_snapshot(adapter, "token").unwrap().is_none());
    }

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
    fn deleting_oa_token_purges_pending_callbacks_but_other_credentials_do_not() {
        let adapter = "oa-inbox-delete-token";
        set(adapter, "token", "verified-token").unwrap();
        set(adapter, "appSecret", "other").unwrap();
        super::super::wechat_oa_ingress::enqueue(adapter, "<xml>pending</xml>").unwrap();
        delete(adapter, "appSecret").unwrap();
        assert_eq!(
            super::super::wechat_oa_ingress::list(adapter)
                .unwrap()
                .len(),
            1
        );
        delete(adapter, "token").unwrap();
        assert!(super::super::wechat_oa_ingress::list(adapter)
            .unwrap()
            .is_empty());
        assert_eq!(get(adapter, "token").unwrap(), None);
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

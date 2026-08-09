//! App-side facade over Cognia's encrypted secret store (ADR-0067).
//!
//! The store logic lives in the `cognia-secrets` crate; this file keeps the
//! thin `#[tauri::command]` IPC shells (and their input shape) so the command
//! surface, capability entries and `generate_handler!` list stay app-side.

pub use cognia_secrets::keyring_secrets::*;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretStoreInput {
    pub namespace: String,
    pub key: String,
    #[serde(default)]
    pub value: Option<String>,
}

/// Legacy input name retained for source compatibility.
pub type KeyringInput = SecretStoreInput;

#[tauri::command]
pub async fn secret_store_get(input: SecretStoreInput) -> Result<Option<String>, String> {
    let current = get(&input.namespace, &input.key)?;
    if current.is_some() || input.namespace != "webhooks" || input.key != "standard-signing-secret"
    {
        return Ok(current);
    }

    const LEGACY_SERVICE: &str = "com.cognia.remote-control";
    const LEGACY_KEY: &str = "outbound-signing-secret";
    let Some(legacy) = cognia_secrets::secret_store::get(LEGACY_SERVICE, LEGACY_KEY)? else {
        return Ok(None);
    };
    set(&input.namespace, &input.key, &legacy)?;
    cognia_secrets::secret_store::delete(LEGACY_SERVICE, LEGACY_KEY)?;
    Ok(Some(legacy))
}

#[tauri::command]
pub async fn secret_store_set(input: SecretStoreInput) -> Result<(), String> {
    let value = input
        .value
        .as_deref()
        .ok_or_else(|| "secret-store set: value is required".to_string())?;
    set(&input.namespace, &input.key, value)
}

#[tauri::command]
pub async fn secret_store_delete(input: SecretStoreInput) -> Result<(), String> {
    clear(&input.namespace, &input.key)
}

/// Deprecated wire alias for pre-secret-store clients.
#[tauri::command]
pub async fn keyring_secret_get(input: KeyringInput) -> Result<Option<String>, String> {
    secret_store_get(input).await
}

/// Deprecated wire alias for pre-secret-store clients.
#[tauri::command]
pub async fn keyring_secret_set(input: KeyringInput) -> Result<(), String> {
    secret_store_set(input).await
}

/// Deprecated wire alias for pre-secret-store clients.
#[tauri::command]
pub async fn keyring_secret_clear(input: KeyringInput) -> Result<(), String> {
    secret_store_delete(input).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(value: Option<&str>) -> SecretStoreInput {
        SecretStoreInput {
            namespace: "secret-store-command-test".into(),
            key: "token".into(),
            value: value.map(str::to_owned),
        }
    }

    #[tokio::test]
    async fn canonical_commands_round_trip_and_legacy_aliases_share_storage() {
        secret_store_delete(input(None)).await.unwrap();
        secret_store_set(input(Some("canonical"))).await.unwrap();
        assert_eq!(
            keyring_secret_get(input(None)).await.unwrap().as_deref(),
            Some("canonical")
        );
        keyring_secret_set(input(Some("legacy"))).await.unwrap();
        assert_eq!(
            secret_store_get(input(None)).await.unwrap().as_deref(),
            Some("legacy")
        );
        keyring_secret_clear(input(None)).await.unwrap();
        assert_eq!(secret_store_get(input(None)).await.unwrap(), None);
    }

    #[tokio::test]
    async fn canonical_set_requires_a_value() {
        let error = secret_store_set(input(None)).await.unwrap_err();
        assert_eq!(error, "secret-store set: value is required");
    }

    #[tokio::test]
    async fn webhook_read_migrates_the_legacy_remote_control_secret() {
        const LEGACY_SERVICE: &str = "com.cognia.remote-control";
        const LEGACY_KEY: &str = "outbound-signing-secret";
        let webhook = SecretStoreInput {
            namespace: "webhooks".into(),
            key: "standard-signing-secret".into(),
            value: None,
        };
        secret_store_delete(webhook.clone()).await.unwrap();
        cognia_secrets::secret_store::set(LEGACY_SERVICE, LEGACY_KEY, "legacy-secret").unwrap();

        assert_eq!(
            secret_store_get(webhook.clone()).await.unwrap().as_deref(),
            Some("legacy-secret")
        );
        assert_eq!(
            cognia_secrets::secret_store::get(LEGACY_SERVICE, LEGACY_KEY).unwrap(),
            None
        );
        secret_store_delete(webhook).await.unwrap();
    }
}

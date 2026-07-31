//! App-side facade over [`cognia_secrets::keyring_secrets`] (ADR-0067).
//!
//! The store logic lives in the `cognia-secrets` crate; this file keeps the
//! thin `#[tauri::command]` IPC shells (and their input shape) so the command
//! surface, capability entries and `generate_handler!` list stay app-side.

pub use cognia_secrets::keyring_secrets::*;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyringInput {
    pub namespace: String,
    pub key: String,
    #[serde(default)]
    pub value: Option<String>,
}

#[tauri::command]
pub async fn keyring_secret_get(input: KeyringInput) -> Result<Option<String>, String> {
    get(&input.namespace, &input.key)
}

#[tauri::command]
pub async fn keyring_secret_set(input: KeyringInput) -> Result<(), String> {
    let value = input
        .value
        .as_deref()
        .ok_or_else(|| "keyring set: value is required".to_string())?;
    set(&input.namespace, &input.key, value)
}

#[tauri::command]
pub async fn keyring_secret_clear(input: KeyringInput) -> Result<(), String> {
    clear(&input.namespace, &input.key)
}

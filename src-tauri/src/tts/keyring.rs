// OS-keyring-backed storage for TTS provider API keys.
//
// Uses the cross-platform `keyring` crate (Keychain on macOS, Credential
// Manager on Windows, Secret Service on Linux). Service name is namespaced
// to "com.cognia.tts" and the entry account is the provider id (`openai`,
// `google`, `elevenlabs`, etc.).
//
// The frontend hits these via `tts_keyring_get/set/delete/list_providers`.
// On a system without an OS keyring (rare server-mode CI), every command
// returns a structured error so the UI can fall back to a different store.

use keyring::Entry;

const SERVICE: &str = "com.cognia.tts";

const KNOWN_PROVIDERS: &[&str] = &[
    "openai",
    "google",
    "elevenlabs",
    "lmnt",
    "hume",
    "cartesia",
    "deepgram",
];

fn entry_for(provider: &str) -> Result<Entry, String> {
    if provider.is_empty() {
        return Err("provider must not be empty".into());
    }
    Entry::new(SERVICE, provider).map_err(|e| format!("keyring init failed: {e}"))
}

#[tauri::command]
pub async fn tts_keyring_get(provider: String) -> Result<Option<String>, String> {
    let entry = entry_for(&provider)?;
    match entry.get_password() {
        Ok(s) => Ok(Some(s)),
        // Map "no entry" (NoEntry) to None — the caller treats this as "no key".
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keyring read failed: {e}")),
    }
}

#[tauri::command]
pub async fn tts_keyring_set(provider: String, key: String) -> Result<(), String> {
    let entry = entry_for(&provider)?;
    if key.trim().is_empty() {
        // Treat empty as a delete — keeps the UI flow simple.
        return tts_keyring_delete(provider).await;
    }
    entry
        .set_password(&key)
        .map_err(|e| format!("keyring write failed: {e}"))
}

#[tauri::command]
pub async fn tts_keyring_delete(provider: String) -> Result<(), String> {
    let entry = entry_for(&provider)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keyring delete failed: {e}")),
    }
}

/// Returns the list of providers that currently have a key stored. Useful
/// for the Speech settings UI to render "configured" badges without a
/// per-provider round-trip.
#[tauri::command]
pub async fn tts_keyring_list_providers() -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for p in KNOWN_PROVIDERS {
        let entry = entry_for(p)?;
        match entry.get_password() {
            Ok(_) => out.push((*p).to_string()),
            Err(keyring::Error::NoEntry) => {}
            Err(e) => {
                // A single broken entry shouldn't kill enumeration; log and continue.
                log::warn!("keyring read failed for {p}: {e}");
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    // The OS keyring is unavailable in many CI environments. Skip the
    // round-trip tests unless explicitly opted in via an env var.
    fn keyring_available() -> bool {
        std::env::var("COGNIA_TEST_KEYRING").ok().as_deref() == Some("1")
    }

    #[tokio::test]
    async fn rejects_empty_provider() {
        let res = tts_keyring_get(String::new()).await;
        assert!(res.is_err());
    }

    #[tokio::test]
    async fn empty_set_is_delete() {
        if !keyring_available() {
            return;
        }
        let provider = "cognia_test_provider_empty";
        tts_keyring_set(provider.into(), "value".into())
            .await
            .unwrap();
        tts_keyring_set(provider.into(), "".into()).await.unwrap();
        let got = tts_keyring_get(provider.into()).await.unwrap();
        assert_eq!(got, None);
    }

    #[tokio::test]
    async fn round_trip() {
        if !keyring_available() {
            return;
        }
        let provider = "cognia_test_provider_rt";
        tts_keyring_set(provider.into(), "secret".into())
            .await
            .unwrap();
        assert_eq!(
            tts_keyring_get(provider.into()).await.unwrap(),
            Some("secret".into())
        );
        tts_keyring_delete(provider.into()).await.unwrap();
        assert_eq!(tts_keyring_get(provider.into()).await.unwrap(), None);
    }
}

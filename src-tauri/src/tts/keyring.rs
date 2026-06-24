// Storage for TTS provider API keys.
//
// Service name is namespaced to "com.cognia.tts" and the entry account is the
// provider id (`openai`, `google`, `elevenlabs`, etc.). Backed by
// [`crate::secret_store`] (single OS-keyring master key), so the
// `list_providers` enumeration below is an in-memory map scan — not seven
// separate Keychain prompts.
//
// The frontend hits these via `tts_keyring_get/set/delete/list_providers`.

use crate::secret_store;

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

fn validate_provider(provider: &str) -> Result<(), String> {
    if provider.is_empty() {
        return Err("provider must not be empty".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn tts_keyring_get(provider: String) -> Result<Option<String>, String> {
    validate_provider(&provider)?;
    secret_store::get(SERVICE, &provider)
}

#[tauri::command]
pub async fn tts_keyring_set(provider: String, key: String) -> Result<(), String> {
    validate_provider(&provider)?;
    if key.trim().is_empty() {
        // Treat empty as a delete — keeps the UI flow simple.
        return tts_keyring_delete(provider).await;
    }
    secret_store::set(SERVICE, &provider, &key)
}

#[tauri::command]
pub async fn tts_keyring_delete(provider: String) -> Result<(), String> {
    validate_provider(&provider)?;
    secret_store::delete(SERVICE, &provider)
}

/// Returns the list of providers that currently have a key stored. Useful
/// for the Speech settings UI to render "configured" badges without a
/// per-provider round-trip.
#[tauri::command]
pub async fn tts_keyring_list_providers() -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for p in KNOWN_PROVIDERS {
        match secret_store::get(SERVICE, p) {
            Ok(Some(_)) => out.push((*p).to_string()),
            Ok(None) => {}
            Err(e) => {
                // A single broken entry shouldn't kill enumeration; log and continue.
                log::warn!("secret-store read failed for {p}: {e}");
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn rejects_empty_provider() {
        let res = tts_keyring_get(String::new()).await;
        assert!(res.is_err());
    }

    #[tokio::test]
    async fn empty_set_is_delete() {
        // Hermetic via the in-memory secret_store global under cfg(test).
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

    #[tokio::test]
    async fn list_providers_reports_only_configured() {
        // "openai" + "hume" configured; the rest absent.
        tts_keyring_set("openai".into(), "k-openai".into())
            .await
            .unwrap();
        tts_keyring_set("hume".into(), "k-hume".into())
            .await
            .unwrap();
        let found = tts_keyring_list_providers().await.unwrap();
        assert!(found.contains(&"openai".to_string()));
        assert!(found.contains(&"hume".to_string()));
        assert!(!found.contains(&"deepgram".to_string()));
        // Cleanup so this never bleeds into another test in the shared global.
        tts_keyring_delete("openai".into()).await.unwrap();
        tts_keyring_delete("hume".into()).await.unwrap();
    }
}

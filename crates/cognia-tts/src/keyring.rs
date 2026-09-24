// Storage for TTS provider API keys.
//
// Service name is namespaced to "com.cognia.tts" and the entry account is the
// provider id (`openai`, `google`, `elevenlabs`, etc.). Backed by
// [`cognia_secrets::secret_store`] (single OS-keyring master key), so the
// `list_providers` enumeration below is an in-memory map scan — not seven
// separate Keychain prompts.
//
// The frontend hits these via `tts_keyring_get/set/delete/list_providers`.

use cognia_secrets::secret_store;

const SERVICE: &str = "com.cognia.tts";

// Must stay in lockstep with the TS source of truth,
// `lib/tts/keyring.ts` KEYRING_PROVIDER_IDS. The `known_providers_match_ts`
// test below reads that file and fails on drift.
const KNOWN_PROVIDERS: &[&str] = &[
    "openai",
    "google",
    "elevenlabs",
    "lmnt",
    "hume",
    "cartesia",
    "deepgram",
    "xiaomi",
    "mistral",
    "local-openai-compatible",
    "xai",
    "qwen",
    "doubao",
    "baidu",
];

fn validate_provider(provider: &str) -> Result<(), String> {
    if provider.is_empty() {
        return Err("provider must not be empty".into());
    }
    Ok(())
}

pub fn get_provider_key(provider: &str) -> Result<Option<String>, String> {
    validate_provider(provider)?;
    secret_store::get(SERVICE, provider)
}

#[tauri::command]
pub async fn tts_keyring_get(provider: String) -> Result<Option<String>, String> {
    get_provider_key(&provider)
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
    list_configured_providers(KNOWN_PROVIDERS, |provider| {
        secret_store::get(SERVICE, provider)
    })
}

/// Enumerate providers with a stored key.
///
/// A single broken entry must not kill enumeration, so per-entry failures are
/// logged and skipped. A store that is not *ready* is different: every entry
/// would fail identically, and reporting an empty list would tell the Speech
/// UI "no keys configured" and cache that answer. That case returns the typed
/// store error once instead of one WARN per provider, so the renderer keeps its
/// "not loaded" state and reloads after the store unlocks.
fn list_configured_providers(
    providers: &[&str],
    read: impl Fn(&str) -> Result<Option<String>, String>,
) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for provider in providers {
        match read(provider) {
            Ok(Some(_)) => out.push((*provider).to_string()),
            Ok(None) => {}
            Err(error) if secret_store::unavailable_reason(&error).is_some() => {
                return Err(error);
            }
            Err(error) => {
                log::warn!("secret-store read failed for {provider}: {error}");
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

    #[test]
    fn a_locked_store_fails_enumeration_once_instead_of_reporting_no_keys() {
        let calls = std::cell::Cell::new(0);
        let error = list_configured_providers(&["openai", "google", "xai"], |_| {
            calls.set(calls.get() + 1);
            Err("SECRET_STORE_LOCKED: master key read: denied".into())
        })
        .unwrap_err();
        assert!(error.starts_with(secret_store::LOCKED_CODE));
        assert_eq!(calls.get(), 1, "stop at the first store-level failure");

        let initializing = list_configured_providers(&["openai"], |_| {
            Err(format!("{}: in progress", secret_store::INITIALIZING_CODE))
        })
        .unwrap_err();
        assert!(initializing.starts_with(secret_store::INITIALIZING_CODE));
    }

    #[test]
    fn a_broken_entry_is_skipped_while_the_rest_enumerate() {
        let listed = list_configured_providers(&["openai", "google", "xai"], |provider| {
            match provider {
                "openai" => Ok(Some("key".into())),
                "google" => Err("legacy keyring read: denied".into()),
                _ => Ok(None),
            }
        })
        .unwrap();
        assert_eq!(listed, vec!["openai".to_string()]);
    }

    #[test]
    fn known_providers_match_ts() {
        // Parity guard (plan D5): xiaomi was silently dropped once because the
        // two lists were hand-synced with nothing pinning them. Rather than
        // duplicate the list, read the TS source of truth and diff — drift on
        // either side turns this test red.
        let ts_path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../lib/tts/keyring.ts");
        let src = std::fs::read_to_string(ts_path)
            .unwrap_or_else(|e| panic!("cannot read {ts_path}: {e}"));
        let anchor = src
            .find("KEYRING_PROVIDER_IDS")
            .expect("KEYRING_PROVIDER_IDS missing from lib/tts/keyring.ts");
        // Skip past the `: KeyringProviderId[]` type annotation to the `=`, then
        // take the first `[ ... ]` after it — the array literal itself.
        let eq = src[anchor..]
            .find('=')
            .expect("= after KEYRING_PROVIDER_IDS")
            + anchor;
        let open = src[eq..].find('[').expect("array literal open") + eq;
        let close = src[open..].find(']').expect("array literal close") + open;
        let mut ts_ids: Vec<String> = src[open + 1..close]
            .split(',')
            .map(|tok| {
                tok.trim()
                    .trim_matches(|c| c == '"' || c == '\'')
                    .to_string()
            })
            .filter(|s| !s.is_empty())
            .collect();
        ts_ids.sort();
        let mut rust_ids: Vec<String> = KNOWN_PROVIDERS.iter().map(|s| s.to_string()).collect();
        rust_ids.sort();
        assert_eq!(
            rust_ids, ts_ids,
            "Rust KNOWN_PROVIDERS drifted from TS KEYRING_PROVIDER_IDS"
        );
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

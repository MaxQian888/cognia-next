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
];

fn validate_provider(provider: &str) -> Result<(), String> {
    if provider.is_empty() {
        return Err("provider must not be empty".into());
    }
    Ok(())
}

pub(crate) fn get_provider_key(provider: &str) -> Result<Option<String>, String> {
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

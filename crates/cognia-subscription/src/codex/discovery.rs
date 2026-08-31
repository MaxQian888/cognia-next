// Discover an existing codex-cli credential so the user doesn't have to log in
// twice. Two sources, both read-only:
//
//   1. `~/.codex/auth.json` — the default storage. Schema mirrors
//      `openai/codex` `codex-rs/login/src/auth/storage.rs::AuthDotJson`:
//        {
//          "auth_mode": "ApiKey" | "ChatGPT" | null,
//          "OPENAI_API_KEY": "sk-..." | null,
//          "tokens": {
//            "id_token": "<jwt>",
//            "access_token": "<jwt>",
//            "refresh_token": "<opaque>",
//            "account_id": "acct_..." | null
//          } | null,
//          "last_refresh": "2026-05-15T01:23:45Z" | null,
//          "agent_identity": "<jwt>" | null
//        }
//
//   2. OS keyring entry with service `"Codex Auth"` (set by codex-cli when
//      `cli_auth_credentials_store: keyring` is configured in
//      `~/.codex/config.toml`). The payload format is the same JSON shape.
//
// We never write back to either surface. The renderer's `Adopt` action just
// copies the relevant fields into our own keyring via `commands::codex_sub_save_token`.

use base64::Engine as _;
use chrono::{DateTime, Utc};
#[cfg(not(test))]
use keyring::Entry;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

const CODEX_KEYRING_SERVICE: &str = "Codex Auth";
#[cfg(not(test))]
const CODEX_KEYRING_ACCOUNT: &str = "default";

/// Outcome of probing for a codex-cli credential. The renderer renders this
/// directly — fields are intentionally renamed to camelCase for IPC stability.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredCodexAuth {
    /// Where we read it from.
    pub source: DiscoverySource,
    /// Resolved path to `auth.json` (always populated, even for `Keyring`
    /// source — useful for the audit info on the Usage tab).
    pub auth_json_path: String,
    /// `"ChatGPT"` or `"ApiKey"` exactly as codex-cli serialises it. May be
    /// missing on older auth.json files that pre-date the field.
    pub auth_mode: Option<String>,
    /// Raw `OPENAI_API_KEY` field (only set in api-key mode).
    pub openai_api_key: Option<String>,
    /// Token bundle (only set in ChatGPT mode).
    pub tokens: Option<DiscoveredTokens>,
    /// `last_refresh` parsed as ISO-8601, or echoed back as-is when parsing
    /// fails (so the renderer can still display it).
    pub last_refresh_iso: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DiscoverySource {
    File,
    Keyring,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredTokens {
    pub access_token: String,
    pub refresh_token: String,
    /// id_token JWT verbatim. Parsed claims live alongside it.
    pub id_token_raw: String,
    pub account_id: Option<String>,
    pub email: Option<String>,
    pub chatgpt_plan_type: Option<String>,
    pub chatgpt_user_id: Option<String>,
    pub chatgpt_account_id: Option<String>,
}

/// Minimal shape we deserialise out of `auth.json`. We deliberately tolerate
/// missing fields (older codex-cli releases didn't include `agent_identity`
/// or `auth_mode`) and treat parse failures of optional fields as `None`.
#[derive(Debug, Deserialize)]
struct AuthDotJson {
    #[serde(default)]
    auth_mode: Option<String>,
    #[serde(rename = "OPENAI_API_KEY", default)]
    openai_api_key: Option<String>,
    #[serde(default)]
    tokens: Option<TokenData>,
    #[serde(default)]
    last_refresh: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
struct TokenData {
    #[serde(default)]
    id_token: serde_json::Value,
    #[serde(default)]
    access_token: String,
    #[serde(default)]
    refresh_token: String,
    #[serde(default)]
    account_id: Option<String>,
}

/// Resolve the directory used by codex-cli. Honors `CODEX_HOME` exactly the
/// way codex-cli does, otherwise falls back to `~/.codex`.
fn codex_home() -> Option<PathBuf> {
    if let Ok(s) = std::env::var("CODEX_HOME") {
        let trimmed = s.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }
    dirs::home_dir().map(|h| h.join(".codex"))
}

/// Resolved path to `~/.codex/auth.json` (or `$CODEX_HOME/auth.json`).
pub fn codex_auth_file_path() -> Option<PathBuf> {
    codex_home().map(|d| d.join("auth.json"))
}

/// Probe both sources. Returns `Ok(None)` only when no credential is found
/// anywhere; `Err` is reserved for genuine parse failures (so the UI can show
/// "credential corrupted" rather than silently appearing logged-out).
pub fn discover_codex_auth() -> Result<Option<DiscoveredCodexAuth>, String> {
    let path = match codex_auth_file_path() {
        Some(p) => p,
        None => return Ok(None),
    };
    let path_str = path.to_string_lossy().into_owned();

    if let Some(from_file) = load_file(&path)? {
        return Ok(Some(materialise(
            DiscoverySource::File,
            path_str,
            from_file,
        )));
    }
    if let Some(from_keyring) = load_keyring()? {
        return Ok(Some(materialise(
            DiscoverySource::Keyring,
            path_str,
            from_keyring,
        )));
    }
    Ok(None)
}

fn load_file(path: &std::path::Path) -> Result<Option<AuthDotJson>, String> {
    if !path.is_file() {
        return Ok(None);
    }
    let raw =
        std::fs::read_to_string(path).map_err(|e| format!("read {}: {}", path.display(), e))?;
    if raw.trim().is_empty() {
        return Ok(None);
    }
    let parsed: AuthDotJson =
        serde_json::from_str(&raw).map_err(|e| format!("parse {}: {}", path.display(), e))?;
    Ok(Some(parsed))
}

fn load_keyring() -> Result<Option<AuthDotJson>, String> {
    // In test builds, an injected seam lets unit tests model the keyring
    // contents deterministically instead of reading the developer's / CI
    // host's real OS keyring (which may legitimately hold a live codex-cli
    // credential and would otherwise make these tests environment-dependent).
    #[cfg(test)]
    {
        match test_support::keyring_override() {
            Some(blob) => parse_keyring_blob(blob.as_deref()),
            None => Err("subscription simulation blocked an unmocked OS keyring read".into()),
        }
    }

    #[cfg(not(test))]
    {
        let entry = Entry::new(CODEX_KEYRING_SERVICE, CODEX_KEYRING_ACCOUNT)
            .map_err(|e| format!("keyring init failed: {e}"))?;
        match entry.get_password() {
            Ok(blob) => parse_keyring_blob(Some(&blob)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("keyring read failed: {e}")),
        }
    }
}

/// Parse a raw keyring payload into an [`AuthDotJson`]. `None` models a missing
/// entry; `Some(blob)` parses the JSON, surfacing malformed payloads as `Err`.
fn parse_keyring_blob(blob: Option<&str>) -> Result<Option<AuthDotJson>, String> {
    match blob {
        Some(blob) => {
            let parsed: AuthDotJson = serde_json::from_str(blob)
                .map_err(|e| format!("parse keyring '{CODEX_KEYRING_SERVICE}' payload: {e}"))?;
            Ok(Some(parsed))
        }
        None => Ok(None),
    }
}

fn materialise(
    source: DiscoverySource,
    auth_json_path: String,
    record: AuthDotJson,
) -> DiscoveredCodexAuth {
    let last_refresh_iso = record.last_refresh.map(|d| d.to_rfc3339());
    let tokens = record.tokens.map(parse_tokens);
    DiscoveredCodexAuth {
        source,
        auth_json_path,
        auth_mode: record.auth_mode,
        openai_api_key: record.openai_api_key.filter(|s| !s.is_empty()),
        tokens,
        last_refresh_iso,
    }
}

fn parse_tokens(t: TokenData) -> DiscoveredTokens {
    let (id_token_raw, claims) = id_token_to_string_and_claims(&t.id_token);
    DiscoveredTokens {
        access_token: t.access_token,
        refresh_token: t.refresh_token,
        id_token_raw,
        account_id: t.account_id,
        email: claims.email,
        chatgpt_plan_type: claims.chatgpt_plan_type,
        chatgpt_user_id: claims.chatgpt_user_id,
        chatgpt_account_id: claims.chatgpt_account_id,
    }
}

#[derive(Default)]
struct Claims {
    email: Option<String>,
    chatgpt_plan_type: Option<String>,
    chatgpt_user_id: Option<String>,
    chatgpt_account_id: Option<String>,
}

fn id_token_to_string_and_claims(v: &serde_json::Value) -> (String, Claims) {
    let raw = match v {
        serde_json::Value::String(s) => s.clone(),
        // Newer codex-cli releases serialize id_token as a nested object with
        // a `raw_jwt` field (the embedded JWT plus pre-parsed claims). Both
        // shapes are tolerated.
        serde_json::Value::Object(map) => map
            .get("raw_jwt")
            .and_then(|x| x.as_str())
            .map(String::from)
            .unwrap_or_default(),
        _ => String::new(),
    };
    if raw.is_empty() {
        return (raw, Claims::default());
    }
    let claims = decode_jwt_claims(&raw).unwrap_or_default();
    (raw, claims)
}

fn decode_jwt_claims(jwt: &str) -> Option<Claims> {
    let mut parts = jwt.splitn(3, '.');
    let _header = parts.next()?;
    let payload = parts.next()?;
    let _sig = parts.next()?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let mut out = Claims {
        email: v.get("email").and_then(|x| x.as_str()).map(String::from),
        ..Claims::default()
    };
    // OpenAI scopes its custom claims under namespaced keys. We tolerate
    // either nested shape.
    let profile = v.get("https://api.openai.com/profile");
    if let Some(p) = profile {
        if out.email.is_none() {
            out.email = p.get("email").and_then(|x| x.as_str()).map(String::from);
        }
    }
    let auth_block = v.get("https://api.openai.com/auth");
    if let Some(a) = auth_block {
        out.chatgpt_plan_type = a
            .get("chatgpt_plan_type")
            .and_then(read_string_or_enum)
            .or_else(|| v.get("chatgpt_plan_type").and_then(read_string_or_enum));
        out.chatgpt_user_id = a
            .get("chatgpt_user_id")
            .and_then(|x| x.as_str())
            .map(String::from)
            .or_else(|| a.get("user_id").and_then(|x| x.as_str()).map(String::from));
        out.chatgpt_account_id = a
            .get("chatgpt_account_id")
            .and_then(|x| x.as_str())
            .map(String::from);
    } else {
        out.chatgpt_plan_type = v.get("chatgpt_plan_type").and_then(read_string_or_enum);
        out.chatgpt_user_id = v
            .get("chatgpt_user_id")
            .and_then(|x| x.as_str())
            .map(String::from);
        out.chatgpt_account_id = v
            .get("chatgpt_account_id")
            .and_then(|x| x.as_str())
            .map(String::from);
    }
    Some(out)
}

/// codex-cli encodes `chatgpt_plan_type` either as a string ("plus") or as a
/// tagged enum like `{"Unknown":"plus"}` / `{"Known":"Plus"}`. Normalise to
/// a plain string for display.
fn read_string_or_enum(v: &serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Object(map) => {
            if let Some(s) = map.get("Known").and_then(|x| x.as_str()) {
                return Some(s.to_string());
            }
            if let Some(s) = map.get("Unknown").and_then(|x| x.as_str()) {
                return Some(s.to_string());
            }
            // Some serializations are `{"Plus": null}` (serde adjacent tag).
            if let Some((k, _v)) = map.iter().next() {
                return Some(k.clone());
            }
            None
        }
        _ => None,
    }
}

/// Hermetic test seam shared by every codex test that exercises
/// [`discover_codex_auth`] (this module's `tests` plus the sibling
/// `commands::tests`).
///
/// `discover_codex_auth` reads two process-global surfaces — the `CODEX_HOME`
/// env var and the OS keyring entry `"Codex Auth"`. Without isolation those
/// tests (a) race each other over `CODEX_HOME` (cargo runs them in parallel)
/// and (b) read the developer's real keyring, which on a machine with codex-cli
/// installed holds a live credential. [`TestEnv`] serialises the env mutation
/// behind a process-wide lock and routes the keyring read through an injected
/// override, so every test runs against a fully controlled view regardless of
/// host state.
#[cfg(test)]
pub(crate) mod test_support {
    use std::sync::{Mutex, MutexGuard, OnceLock};

    /// Injected keyring contents for the current test:
    /// - `None`               → no override active; real keyring is consulted.
    /// - `Some(None)`         → override active, keyring reports *no entry*.
    /// - `Some(Some(blob))`   → override active, keyring returns `blob`.
    static KEYRING_OVERRIDE: Mutex<Option<Option<String>>> = Mutex::new(None);

    /// Serialises every test that mutates `CODEX_HOME` / the keyring override
    /// so cargo's parallel runner can't interleave them. Exposed `pub(crate)`
    /// so the rare test that pokes `CODEX_HOME` directly (without a `TestEnv`)
    /// can hold the *same* lock and stay ordered against everything else.
    pub(crate) fn env_lock() -> MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        // Recover from a poisoned lock: a panicking test must not wedge the
        // whole module.
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    /// Read the injected keyring override (consumed by `super::load_keyring`).
    /// Returns the inner `Option<String>` only when an override is active.
    pub(crate) fn keyring_override() -> Option<Option<String>> {
        KEYRING_OVERRIDE
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// RAII guard that pins `CODEX_HOME` to a temp dir and forces the keyring
    /// seam to report *no entry*, restoring both on drop. Holds the env lock
    /// for its lifetime so concurrent tests never observe each other's state.
    pub(crate) struct TestEnv {
        _guard: MutexGuard<'static, ()>,
        tmp: tempfile::TempDir,
        prev_codex_home: Option<String>,
    }

    impl TestEnv {
        /// New isolated environment with an empty keyring.
        pub(crate) fn new() -> Self {
            let guard = env_lock();
            let prev_codex_home = std::env::var("CODEX_HOME").ok();
            let tmp = tempfile::tempdir().unwrap();
            std::env::set_var("CODEX_HOME", tmp.path());
            // Default: keyring is empty unless a test overrides it explicitly.
            *KEYRING_OVERRIDE.lock().unwrap_or_else(|e| e.into_inner()) = Some(None);
            Self {
                _guard: guard,
                tmp,
                prev_codex_home,
            }
        }

        /// The isolated `CODEX_HOME` directory.
        pub(crate) fn path(&self) -> &std::path::Path {
            self.tmp.path()
        }

        /// Make the keyring seam return `blob` on the next discovery probe.
        pub(crate) fn set_keyring(&self, blob: &str) {
            *KEYRING_OVERRIDE.lock().unwrap_or_else(|e| e.into_inner()) =
                Some(Some(blob.to_string()));
        }
    }

    impl Drop for TestEnv {
        fn drop(&mut self) {
            *KEYRING_OVERRIDE.lock().unwrap_or_else(|e| e.into_inner()) = None;
            match &self.prev_codex_home {
                Some(v) => std::env::set_var("CODEX_HOME", v),
                None => std::env::remove_var("CODEX_HOME"),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{env_lock, TestEnv};
    use super::*;

    #[test]
    fn codex_home_honours_env_var() {
        // Serialise the `CODEX_HOME` mutation behind the same lock the
        // discovery tests use, so cargo's parallel runner can't interleave.
        let _guard = env_lock();
        let prev = std::env::var("CODEX_HOME").ok();
        std::env::set_var("CODEX_HOME", "C:/custom/codex");
        let resolved = codex_home().expect("env-var path resolvable");
        assert_eq!(resolved, PathBuf::from("C:/custom/codex"));
        match prev {
            Some(v) => std::env::set_var("CODEX_HOME", v),
            None => std::env::remove_var("CODEX_HOME"),
        }
    }

    #[test]
    fn codex_home_falls_back_to_dot_codex() {
        let _guard = env_lock();
        let prev = std::env::var("CODEX_HOME").ok();
        std::env::remove_var("CODEX_HOME");
        let resolved = codex_home().expect("home dir resolvable on test host");
        let home = dirs::home_dir().unwrap();
        assert_eq!(resolved, home.join(".codex"));
        if let Some(v) = prev {
            std::env::set_var("CODEX_HOME", v);
        }
    }

    #[test]
    fn discovers_api_key_payload_from_file() {
        let env = TestEnv::new();
        let auth_path = env.path().join("auth.json");
        std::fs::write(
            &auth_path,
            r#"{"auth_mode":"ApiKey","OPENAI_API_KEY":"sk-test","tokens":null}"#,
        )
        .unwrap();

        let got = discover_codex_auth().unwrap().unwrap();
        assert_eq!(got.source, DiscoverySource::File);
        assert_eq!(got.auth_mode.as_deref(), Some("ApiKey"));
        assert_eq!(got.openai_api_key.as_deref(), Some("sk-test"));
        assert!(got.tokens.is_none());
    }

    #[test]
    fn discovers_chatgpt_payload_with_jwt_claims() {
        // Build a JWT whose payload encodes the chatgpt_* claims under the
        // namespaced `https://api.openai.com/auth` claim — mirrors the real
        // codex-cli payload shape.
        let payload = serde_json::json!({
            "email": "user@example.com",
            "https://api.openai.com/auth": {
                "chatgpt_plan_type": {"Known": "Plus"},
                "chatgpt_user_id": "user_abc",
                "chatgpt_account_id": "acct_def",
            }
        });
        let payload_bytes = serde_json::to_vec(&payload).unwrap();
        let payload_b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&payload_bytes);
        let jwt = format!("hdr.{payload_b64}.sig");

        let body = serde_json::json!({
            "auth_mode": "ChatGPT",
            "OPENAI_API_KEY": null,
            "tokens": {
                "id_token": jwt,
                "access_token": "oat-test",
                "refresh_token": "rt-test",
                "account_id": "acct_def"
            },
            "last_refresh": "2026-05-10T01:23:45Z"
        });
        let env = TestEnv::new();
        std::fs::write(
            env.path().join("auth.json"),
            serde_json::to_string(&body).unwrap(),
        )
        .unwrap();

        let got = discover_codex_auth().unwrap().unwrap();
        assert_eq!(got.source, DiscoverySource::File);
        let tokens = got.tokens.expect("tokens present");
        assert_eq!(tokens.access_token, "oat-test");
        assert_eq!(tokens.refresh_token, "rt-test");
        assert_eq!(tokens.account_id.as_deref(), Some("acct_def"));
        assert_eq!(tokens.email.as_deref(), Some("user@example.com"));
        assert_eq!(tokens.chatgpt_plan_type.as_deref(), Some("Plus"));
        assert_eq!(tokens.chatgpt_user_id.as_deref(), Some("user_abc"));
        assert_eq!(tokens.chatgpt_account_id.as_deref(), Some("acct_def"));
        assert!(got.last_refresh_iso.as_deref().is_some());
    }

    #[test]
    fn discovery_returns_none_when_nothing_exists() {
        // No auth.json and an empty keyring (forced by the seam) → the clean
        // logged-out state. The seam lets this be a strict `is_none()` instead
        // of the old `|| source == Keyring` escape hatch that papered over a
        // real keyring entry on the host.
        let _env = TestEnv::new();
        let got = discover_codex_auth().unwrap();
        assert!(got.is_none());
    }

    #[test]
    fn empty_auth_json_treated_as_missing() {
        // Whitespace-only auth.json is treated as missing, so discovery falls
        // through to the (seam-forced empty) keyring and yields `None`.
        let env = TestEnv::new();
        std::fs::write(env.path().join("auth.json"), "  \n").unwrap();
        let got = discover_codex_auth().unwrap();
        assert!(got.is_none());
    }

    #[test]
    fn discovers_from_keyring_when_no_auth_json() {
        // With no auth.json present, discovery falls through to the keyring.
        // The seam injects a valid payload so the `Keyring` branch is covered
        // deterministically (previously it had no host-independent coverage).
        let env = TestEnv::new();
        env.set_keyring(
            r#"{"auth_mode":"ApiKey","OPENAI_API_KEY":"sk-from-keyring","tokens":null}"#,
        );
        let got = discover_codex_auth().unwrap().unwrap();
        assert_eq!(got.source, DiscoverySource::Keyring);
        assert_eq!(got.openai_api_key.as_deref(), Some("sk-from-keyring"));
    }

    #[test]
    fn malformed_keyring_payload_surfaces_parse_error() {
        // A corrupt keyring blob must surface as `Err` (so the UI can show
        // "credential corrupted") rather than silently appearing logged out.
        let env = TestEnv::new();
        env.set_keyring("{not json");
        assert!(discover_codex_auth().is_err());
    }

    #[test]
    fn malformed_auth_json_surfaces_parse_error() {
        let env = TestEnv::new();
        std::fs::write(env.path().join("auth.json"), "{not json").unwrap();
        assert!(discover_codex_auth().is_err());
    }

    #[test]
    fn read_string_or_enum_handles_plain_string() {
        assert_eq!(
            read_string_or_enum(&serde_json::Value::String("plus".into())),
            Some("plus".into())
        );
    }

    #[test]
    fn read_string_or_enum_unwraps_known_tag() {
        let v = serde_json::json!({"Known": "Pro"});
        assert_eq!(read_string_or_enum(&v), Some("Pro".into()));
    }

    #[test]
    fn read_string_or_enum_unwraps_unknown_tag() {
        let v = serde_json::json!({"Unknown": "Enterprise"});
        assert_eq!(read_string_or_enum(&v), Some("Enterprise".into()));
    }
}

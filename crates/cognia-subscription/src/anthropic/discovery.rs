// Discover an existing Claude Code CLI subscription login so the user doesn't
// have to run the PKCE flow twice. Two sources, both read-only:
//
//   1. `$CLAUDE_CONFIG_DIR/.credentials.json` (default `~/.claude/.credentials.json`)
//      — Claude Code's file-based credential store (Linux, and macOS/Windows
//      hosts where the keychain isn't used). Schema:
//        {
//          "claudeAiOauth": {
//            "accessToken": "sk-ant-oat01-...",
//            "refreshToken": "sk-ant-ort01-...",
//            "expiresAt": 1783590329176,          // ms epoch
//            "scopes": ["user:inference", ...],
//            "subscriptionType": "max" | "pro" | ...,
//            "rateLimitTier": "default_claude_max_20x" | ...
//          }
//        }
//
//   2. OS keyring entry with service `"Claude Code-credentials"` and the OS
//      username as the account (what `claude login` writes on macOS). The
//      payload is the same JSON shape.
//
// We never write back to either surface. The renderer's `Adopt` action records
// a linked snapshot in our v2 vault; refresh re-runs discovery so Claude Code
// remains the owner of refresh-token rotation.

use keyring::Entry;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

const CLAUDE_KEYRING_SERVICE: &str = "Claude Code-credentials";

/// Outcome of probing for a Claude Code CLI credential. The renderer renders
/// this directly — fields are camelCase for IPC stability.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredAnthropicAuth {
    /// Where we read it from.
    pub source: DiscoverySource,
    /// Resolved path to `.credentials.json` (always populated, even for the
    /// `Keyring` source — useful as an audit hint in the UI).
    pub credentials_path: String,
    pub access_token: String,
    pub refresh_token: String,
    /// Absolute expiry of the access token, ms epoch. 0 when absent.
    pub expires_at_ms: i64,
    pub scopes: Vec<String>,
    /// "max" | "pro" | "team" | … as Claude Code serialises it.
    pub subscription_type: Option<String>,
    pub rate_limit_tier: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DiscoverySource {
    File,
    Keyring,
}

/// Minimal shape we deserialise. Tolerates missing optional fields; a payload
/// without `claudeAiOauth` (e.g. API-key-only hosts) reads as "not found".
#[derive(Debug, Deserialize)]
struct CredentialsDotJson {
    #[serde(rename = "claudeAiOauth", default)]
    claude_ai_oauth: Option<ClaudeAiOauth>,
}

#[derive(Debug, Deserialize)]
struct ClaudeAiOauth {
    #[serde(rename = "accessToken", default)]
    access_token: String,
    #[serde(rename = "refreshToken", default)]
    refresh_token: String,
    #[serde(rename = "expiresAt", default)]
    expires_at: i64,
    #[serde(default)]
    scopes: Vec<String>,
    #[serde(rename = "subscriptionType", default)]
    subscription_type: Option<String>,
    #[serde(rename = "rateLimitTier", default)]
    rate_limit_tier: Option<String>,
}

/// Resolve Claude Code's config dir. Honors `CLAUDE_CONFIG_DIR` exactly the
/// way the CLI does, otherwise falls back to `~/.claude`.
fn claude_config_dir() -> Option<PathBuf> {
    if let Ok(s) = std::env::var("CLAUDE_CONFIG_DIR") {
        let trimmed = s.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }
    dirs::home_dir().map(|h| h.join(".claude"))
}

/// Resolved path to `.credentials.json`.
pub fn claude_credentials_file_path() -> Option<PathBuf> {
    claude_config_dir().map(|d| d.join(".credentials.json"))
}

/// Probe both sources. Returns `Ok(None)` only when no subscription credential
/// is found anywhere; `Err` is reserved for genuine parse failures (so the UI
/// can show "credential corrupted" rather than silently appearing logged-out).
pub fn discover_anthropic_auth() -> Result<Option<DiscoveredAnthropicAuth>, String> {
    let path = match claude_credentials_file_path() {
        Some(p) => p,
        None => return Ok(None),
    };
    let path_str = path.to_string_lossy().into_owned();

    // Claude Code uses the macOS Keychain as its authoritative store. A stale
    // credentials file can remain after upgrades/manual restores; CCSwitch and
    // Claude Code both read the Keychain first on macOS, so mirror that order.
    #[cfg(target_os = "macos")]
    let keyring_error = match load_keyring() {
        Ok(Some(from_keyring)) => {
            if let Some(found) =
                materialise(DiscoverySource::Keyring, path_str.clone(), from_keyring)
            {
                return Ok(Some(found));
            }
            None
        }
        Ok(None) => None,
        Err(error) => Some(error),
    };

    match load_file(&path) {
        Ok(Some(from_file)) => {
            if let Some(found) = materialise(DiscoverySource::File, path_str.clone(), from_file) {
                return Ok(Some(found));
            }
        }
        Ok(None) => {}
        Err(file_error) => {
            #[cfg(target_os = "macos")]
            if let Some(keyring_error) = keyring_error {
                return Err(format!(
                    "{keyring_error}; credentials-file fallback also failed: {file_error}"
                ));
            }
            return Err(file_error);
        }
    }

    #[cfg(target_os = "macos")]
    if let Some(error) = keyring_error {
        return Err(error);
    }

    // Linux/Windows primarily use the credentials file, with the keyring kept
    // as a supported fallback. Avoid reading the macOS Keychain twice.
    #[cfg(not(target_os = "macos"))]
    if let Some(from_keyring) = load_keyring()? {
        if let Some(found) = materialise(DiscoverySource::Keyring, path_str, from_keyring) {
            return Ok(Some(found));
        }
    }
    Ok(None)
}

fn load_file(path: &std::path::Path) -> Result<Option<CredentialsDotJson>, String> {
    if !path.is_file() {
        return Ok(None);
    }
    let raw =
        std::fs::read_to_string(path).map_err(|e| format!("read {}: {}", path.display(), e))?;
    if raw.trim().is_empty() {
        return Ok(None);
    }
    let parsed: CredentialsDotJson =
        serde_json::from_str(&raw).map_err(|e| format!("parse {}: {}", path.display(), e))?;
    Ok(Some(parsed))
}

fn load_keyring() -> Result<Option<CredentialsDotJson>, String> {
    // Test builds route the read through an injected seam so unit tests never
    // touch the developer's / CI host's real keychain (which on a machine with
    // Claude Code installed holds a live credential).
    #[cfg(test)]
    if let Some(result) = test_support::keyring_override() {
        return match result {
            Ok(blob) => parse_keyring_blob(blob.as_deref()),
            Err(error) => Err(error),
        };
    }

    let account = os_username();
    let entry = Entry::new(CLAUDE_KEYRING_SERVICE, &account)
        .map_err(|e| format!("keyring init failed: {e}"))?;
    match entry.get_password() {
        Ok(blob) => parse_keyring_blob(Some(&blob)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keyring read failed: {e}")),
    }
}

/// Claude Code writes the keychain item with the OS login name as the account
/// attribute. `USER` covers macOS/Linux; `USERNAME` covers Windows.
fn os_username() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "default".to_string())
}

/// Parse a raw keyring payload. `None` models a missing entry; `Some(blob)`
/// parses the JSON, surfacing malformed payloads as `Err`.
fn parse_keyring_blob(blob: Option<&str>) -> Result<Option<CredentialsDotJson>, String> {
    match blob {
        Some(blob) => {
            let parsed: CredentialsDotJson = serde_json::from_str(blob)
                .map_err(|e| format!("parse keyring '{CLAUDE_KEYRING_SERVICE}' payload: {e}"))?;
            Ok(Some(parsed))
        }
        None => Ok(None),
    }
}

/// `None` when the payload has no `claudeAiOauth` block or the block carries
/// an empty access token — both read as "no subscription login here", letting
/// discovery fall through to the next source.
fn materialise(
    source: DiscoverySource,
    credentials_path: String,
    record: CredentialsDotJson,
) -> Option<DiscoveredAnthropicAuth> {
    let oauth = record.claude_ai_oauth?;
    if oauth.access_token.trim().is_empty() {
        return None;
    }
    Some(DiscoveredAnthropicAuth {
        source,
        credentials_path,
        access_token: oauth.access_token,
        refresh_token: oauth.refresh_token,
        expires_at_ms: oauth.expires_at,
        scopes: oauth.scopes,
        subscription_type: oauth.subscription_type,
        rate_limit_tier: oauth.rate_limit_tier,
    })
}

/// Hermetic test seam shared by every test that exercises
/// [`discover_anthropic_auth`] (this module's `tests` plus the sibling
/// `commands::tests`). Same design as `codex::discovery::test_support`:
/// serialise the `CLAUDE_CONFIG_DIR` mutation behind a process-wide lock and
/// route the keyring read through an injected override.
#[cfg(test)]
pub(crate) mod test_support {
    use std::sync::{Mutex, MutexGuard, OnceLock};

    /// Injected keyring contents for the current test:
    /// - `None`               → no override active; real keyring is consulted.
    /// - `Some(None)`         → override active, keyring reports *no entry*.
    /// - `Some(Some(blob))`   → override active, keyring returns `blob`.
    static KEYRING_OVERRIDE: Mutex<Option<Result<Option<String>, String>>> = Mutex::new(None);

    pub(crate) fn env_lock() -> MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    pub(crate) fn keyring_override() -> Option<Result<Option<String>, String>> {
        KEYRING_OVERRIDE
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// RAII guard that pins `CLAUDE_CONFIG_DIR` to a temp dir and forces the
    /// keyring seam to report *no entry*, restoring both on drop. Holds the
    /// env lock for its lifetime.
    pub(crate) struct TestEnv {
        _guard: MutexGuard<'static, ()>,
        tmp: tempfile::TempDir,
        prev_config_dir: Option<String>,
    }

    impl TestEnv {
        pub(crate) fn new() -> Self {
            let guard = env_lock();
            let prev_config_dir = std::env::var("CLAUDE_CONFIG_DIR").ok();
            let tmp = tempfile::tempdir().unwrap();
            std::env::set_var("CLAUDE_CONFIG_DIR", tmp.path());
            *KEYRING_OVERRIDE.lock().unwrap_or_else(|e| e.into_inner()) = Some(Ok(None));
            Self {
                _guard: guard,
                tmp,
                prev_config_dir,
            }
        }

        pub(crate) fn path(&self) -> &std::path::Path {
            self.tmp.path()
        }

        pub(crate) fn set_keyring(&self, blob: &str) {
            *KEYRING_OVERRIDE.lock().unwrap_or_else(|e| e.into_inner()) =
                Some(Ok(Some(blob.to_string())));
        }

        pub(crate) fn set_keyring_error(&self, error: &str) {
            *KEYRING_OVERRIDE.lock().unwrap_or_else(|e| e.into_inner()) =
                Some(Err(error.to_string()));
        }
    }

    impl Drop for TestEnv {
        fn drop(&mut self) {
            *KEYRING_OVERRIDE.lock().unwrap_or_else(|e| e.into_inner()) = None;
            match &self.prev_config_dir {
                Some(v) => std::env::set_var("CLAUDE_CONFIG_DIR", v),
                None => std::env::remove_var("CLAUDE_CONFIG_DIR"),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{env_lock, TestEnv};
    use super::*;

    const SAMPLE: &str = r#"{
        "claudeAiOauth": {
            "accessToken": "sk-ant-oat01-test",
            "refreshToken": "sk-ant-ort01-test",
            "expiresAt": 1783590329176,
            "scopes": ["user:inference", "user:profile"],
            "subscriptionType": "max",
            "rateLimitTier": "default_claude_max_20x"
        }
    }"#;

    #[test]
    fn config_dir_honours_env_var() {
        let _guard = env_lock();
        let prev = std::env::var("CLAUDE_CONFIG_DIR").ok();
        std::env::set_var("CLAUDE_CONFIG_DIR", "/custom/claude");
        let resolved = claude_config_dir().expect("env-var path resolvable");
        assert_eq!(resolved, PathBuf::from("/custom/claude"));
        match prev {
            Some(v) => std::env::set_var("CLAUDE_CONFIG_DIR", v),
            None => std::env::remove_var("CLAUDE_CONFIG_DIR"),
        }
    }

    #[test]
    fn config_dir_falls_back_to_dot_claude() {
        let _guard = env_lock();
        let prev = std::env::var("CLAUDE_CONFIG_DIR").ok();
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        let resolved = claude_config_dir().expect("home dir resolvable on test host");
        assert_eq!(resolved, dirs::home_dir().unwrap().join(".claude"));
        if let Some(v) = prev {
            std::env::set_var("CLAUDE_CONFIG_DIR", v);
        }
    }

    #[test]
    fn discovers_subscription_payload_from_file() {
        let env = TestEnv::new();
        std::fs::write(env.path().join(".credentials.json"), SAMPLE).unwrap();

        let got = discover_anthropic_auth().unwrap().unwrap();
        assert_eq!(got.source, DiscoverySource::File);
        assert_eq!(got.access_token, "sk-ant-oat01-test");
        assert_eq!(got.refresh_token, "sk-ant-ort01-test");
        assert_eq!(got.expires_at_ms, 1_783_590_329_176);
        assert_eq!(got.scopes.len(), 2);
        assert_eq!(got.subscription_type.as_deref(), Some("max"));
        assert_eq!(
            got.rate_limit_tier.as_deref(),
            Some("default_claude_max_20x")
        );
        assert!(got.credentials_path.ends_with(".credentials.json"));
    }

    #[test]
    fn discovers_from_keyring_when_no_file() {
        let env = TestEnv::new();
        env.set_keyring(SAMPLE);
        let got = discover_anthropic_auth().unwrap().unwrap();
        assert_eq!(got.source, DiscoverySource::Keyring);
        assert_eq!(got.access_token, "sk-ant-oat01-test");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_keyring_is_authoritative_over_a_stale_credentials_file() {
        let env = TestEnv::new();
        std::fs::write(
            env.path().join(".credentials.json"),
            r#"{"claudeAiOauth":{"accessToken":"stale-file","refreshToken":"stale-rt"}}"#,
        )
        .unwrap();
        env.set_keyring(SAMPLE);

        let got = discover_anthropic_auth().unwrap().unwrap();

        assert_eq!(got.source, DiscoverySource::Keyring);
        assert_eq!(got.access_token, "sk-ant-oat01-test");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_falls_back_to_credentials_file_when_keyring_read_fails() {
        let env = TestEnv::new();
        std::fs::write(env.path().join(".credentials.json"), SAMPLE).unwrap();
        env.set_keyring_error("keyring locked");

        let got = discover_anthropic_auth().unwrap().unwrap();

        assert_eq!(got.source, DiscoverySource::File);
        assert_eq!(got.access_token, "sk-ant-oat01-test");
    }

    #[test]
    fn discovery_returns_none_when_nothing_exists() {
        let _env = TestEnv::new();
        assert!(discover_anthropic_auth().unwrap().is_none());
    }

    #[test]
    fn empty_credentials_file_treated_as_missing() {
        let env = TestEnv::new();
        std::fs::write(env.path().join(".credentials.json"), "  \n").unwrap();
        assert!(discover_anthropic_auth().unwrap().is_none());
    }

    #[test]
    fn payload_without_oauth_block_treated_as_missing() {
        // API-key-only hosts have a .credentials.json without `claudeAiOauth`.
        let env = TestEnv::new();
        std::fs::write(env.path().join(".credentials.json"), r#"{"other": 1}"#).unwrap();
        assert!(discover_anthropic_auth().unwrap().is_none());
    }

    #[test]
    fn blank_access_token_falls_through_to_keyring() {
        let env = TestEnv::new();
        std::fs::write(
            env.path().join(".credentials.json"),
            r#"{"claudeAiOauth": {"accessToken": "  "}}"#,
        )
        .unwrap();
        env.set_keyring(SAMPLE);
        let got = discover_anthropic_auth().unwrap().unwrap();
        assert_eq!(got.source, DiscoverySource::Keyring);
    }

    #[test]
    fn malformed_file_surfaces_parse_error() {
        let env = TestEnv::new();
        std::fs::write(env.path().join(".credentials.json"), "{not json").unwrap();
        assert!(discover_anthropic_auth().is_err());
    }

    #[test]
    fn malformed_keyring_payload_surfaces_parse_error() {
        let env = TestEnv::new();
        env.set_keyring("{not json");
        assert!(discover_anthropic_auth().is_err());
    }

    #[test]
    fn tolerates_missing_optional_fields() {
        let env = TestEnv::new();
        std::fs::write(
            env.path().join(".credentials.json"),
            r#"{"claudeAiOauth": {"accessToken": "sk-ant-oat01-min", "refreshToken": "rt"}}"#,
        )
        .unwrap();
        let got = discover_anthropic_auth().unwrap().unwrap();
        assert_eq!(got.expires_at_ms, 0);
        assert!(got.scopes.is_empty());
        assert!(got.subscription_type.is_none());
        assert!(got.rate_limit_tier.is_none());
    }
}

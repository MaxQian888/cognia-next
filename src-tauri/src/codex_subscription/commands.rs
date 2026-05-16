// Tauri commands the renderer invokes for Codex subscription management.
//
// Three categories:
//
//   * Credential vault: codex_sub_{save,load,clear}_token — JSON in/out,
//     mirrors the Anthropic subscription surface so the renderer's hooks can
//     follow the same shape.
//
//   * Discovery: codex_sub_discover — read-only probe of ~/.codex/auth.json
//     and codex-cli's keyring entry. Used by the "Reuse" mode of the login
//     dialog.
//
//   * OAuth: codex_sub_request_device_code / codex_sub_poll_device_code /
//     codex_sub_refresh / codex_sub_revoke — wraps the HTTP calls so the
//     frontend's transport layer doesn't have to embed OpenAI URLs.

use super::credential::{self, CodexCredential};
use super::discovery::{self, DiscoveredCodexAuth};
use super::oauth::{self, DeviceCodeResponse, PollOutcome, TokenResponse};

#[tauri::command]
pub async fn codex_sub_save_token(payload: CodexCredential) -> Result<(), String> {
    credential::save(&payload)
}

#[tauri::command]
pub async fn codex_sub_load_token() -> Result<Option<CodexCredential>, String> {
    credential::load()
}

#[tauri::command]
pub async fn codex_sub_clear_token() -> Result<(), String> {
    credential::clear()
}

#[tauri::command]
pub async fn codex_sub_discover() -> Result<Option<DiscoveredCodexAuth>, String> {
    discovery::discover_codex_auth()
}

#[tauri::command]
pub async fn codex_sub_request_device_code() -> Result<DeviceCodeResponse, String> {
    oauth::request_device_code().await
}

#[tauri::command]
pub async fn codex_sub_poll_device_code(device_code: String) -> Result<PollOutcome, String> {
    oauth::poll_device_code(&device_code).await
}

#[tauri::command]
pub async fn codex_sub_refresh(refresh_token: String) -> Result<TokenResponse, String> {
    oauth::refresh_token(&refresh_token).await
}

#[tauri::command]
pub async fn codex_sub_revoke(token: String) -> Result<(), String> {
    oauth::revoke_token(&token).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> CodexCredential {
        CodexCredential {
            access_token: "oat-codex-cmd".into(),
            refresh_token: "rt-codex-cmd".into(),
            id_token_raw: String::new(),
            expires_at_ms: 1_700_000_000_000,
            auth_mode: "chatgpt".into(),
            email: None,
            chatgpt_plan_type: None,
            chatgpt_user_id: None,
            account_id: None,
            original_source: Some("oauth".into()),
            stored_at_ms: 1_700_000_000_000,
        }
    }

    #[tokio::test]
    async fn save_rejects_blank_tokens() {
        let mut c = sample();
        c.access_token = String::new();
        c.refresh_token = String::new();
        assert!(codex_sub_save_token(c).await.is_err());
    }

    #[tokio::test]
    async fn load_when_missing_is_none_under_keyring() {
        if std::env::var("COGNIA_TEST_KEYRING").ok().as_deref() != Some("1") {
            return;
        }
        let _ = codex_sub_clear_token().await;
        let got = codex_sub_load_token().await.unwrap();
        assert!(got.is_none());
    }

    #[tokio::test]
    async fn discover_returns_none_when_codex_home_empty() {
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("CODEX_HOME", tmp.path());
        // No auth.json + no keyring on most CI hosts → None. Tolerate the
        // CI host having a stray codex-cli keyring entry.
        let got = codex_sub_discover().await.unwrap();
        if let Some(g) = got {
            assert_eq!(g.source, super::discovery::DiscoverySource::Keyring);
        }
        std::env::remove_var("CODEX_HOME");
    }
}

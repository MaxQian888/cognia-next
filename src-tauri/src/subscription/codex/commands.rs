// Codex-specific Tauri commands.
//
// Three categories:
//
//   * Discovery: codex_oauth_discover — read-only probe of ~/.codex/auth.json
//     and codex-cli's keyring entry. Used by the "Reuse" mode of the login
//     dialog.
//
//   * OAuth: codex_oauth_request_device_code / codex_oauth_poll_device_code /
//     codex_oauth_refresh / codex_oauth_revoke — wraps the HTTP calls so the
//     renderer's transport layer doesn't have to embed OpenAI URLs.
//
// Generic CRUD (save/load/clear/list/delete/rename) flows through the shared
// `subscription::commands::subscription_*` commands; only Codex-specific
// transport-layer wrappers live here.

use super::discovery::{self, DiscoveredCodexAuth};
use super::oauth::{self, DeviceCodeResponse, PollOutcome, TokenResponse};

#[tauri::command]
pub async fn codex_oauth_discover() -> Result<Option<DiscoveredCodexAuth>, String> {
    discovery::discover_codex_auth()
}

#[tauri::command]
pub async fn codex_oauth_request_device_code() -> Result<DeviceCodeResponse, String> {
    oauth::request_device_code().await
}

#[tauri::command]
pub async fn codex_oauth_poll_device_code(device_code: String) -> Result<PollOutcome, String> {
    oauth::poll_device_code(&device_code).await
}

#[tauri::command]
pub async fn codex_oauth_refresh(refresh_token: String) -> Result<TokenResponse, String> {
    oauth::refresh_token(&refresh_token).await
}

#[tauri::command]
pub async fn codex_oauth_revoke(token: String) -> Result<(), String> {
    oauth::revoke_token(&token).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn discover_returns_none_when_codex_home_empty() {
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("CODEX_HOME", tmp.path());
        // No auth.json + no keyring on most CI hosts → None. Tolerate the
        // CI host having a stray codex-cli keyring entry.
        let got = codex_oauth_discover().await.unwrap();
        if let Some(g) = got {
            assert_eq!(g.source, super::discovery::DiscoverySource::Keyring);
        }
        std::env::remove_var("CODEX_HOME");
    }
}

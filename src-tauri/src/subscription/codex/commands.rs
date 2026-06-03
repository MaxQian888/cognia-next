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
        // Use the shared hermetic seam: an isolated `CODEX_HOME` (held behind
        // the cross-test env lock) plus a forced-empty keyring, so this never
        // reads the developer's real keyring nor races the discovery tests
        // over the process-global `CODEX_HOME`.
        let _env = super::discovery::test_support::TestEnv::new();
        let got = codex_oauth_discover().await.unwrap();
        assert!(got.is_none());
    }
}

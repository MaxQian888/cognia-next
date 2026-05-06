// Tauri commands the renderer calls into to manage the Claude subscription
// OAuth credential. Three thin wrappers around credential::{save,load,clear}.

use super::credential::{self, SubscriptionCredential};

#[tauri::command]
pub async fn claude_sub_save_token(payload: SubscriptionCredential) -> Result<(), String> {
    credential::save(&payload)
}

#[tauri::command]
pub async fn claude_sub_load_token() -> Result<Option<SubscriptionCredential>, String> {
    credential::load()
}

#[tauri::command]
pub async fn claude_sub_clear_token() -> Result<(), String> {
    credential::clear()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> SubscriptionCredential {
        SubscriptionCredential {
            access_token: "oat01-cmd-test".into(),
            refresh_token: "rt-cmd-test".into(),
            expires_at_ms: 1_700_000_000_000,
            mode: "console".into(),
            scope: None,
            email: None,
            plan: None,
            stored_at_ms: 1_700_000_000_000,
        }
    }

    #[tokio::test]
    async fn save_rejects_empty_token() {
        let mut c = sample();
        c.access_token = String::new();
        assert!(claude_sub_save_token(c).await.is_err());
    }

    #[tokio::test]
    async fn load_when_missing_is_none() {
        // Skip if the keyring isn't available — same convention as tts::keyring.
        if std::env::var("COGNIA_TEST_KEYRING").ok().as_deref() != Some("1") {
            return;
        }
        // Ensure clean slate.
        let _ = claude_sub_clear_token().await;
        let got = claude_sub_load_token().await.unwrap();
        assert!(got.is_none());
    }
}

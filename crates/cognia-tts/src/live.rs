//! Short-lived credential provisioning for browser-native Realtime WebRTC.
//!
//! The renderer handles microphone and remote audio as WebRTC media tracks.
//! This module keeps the long-lived OpenAI API key in the native host and
//! returns only the expiring client secret needed to establish one session.

use serde::{Deserialize, Serialize};

use crate::keyring::get_provider_key;

const CLIENT_SECRETS_URL: &str = "https://api.openai.com/v1/realtime/client_secrets";
const MAX_INSTRUCTIONS_LEN: usize = 8_192;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveClientSecretRequest {
    pub model: String,
    pub voice: String,
    #[serde(default)]
    pub instructions: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct LiveClientSecretResponse {
    pub value: String,
}

fn validate_request(request: &LiveClientSecretRequest) -> Result<(), String> {
    if !request.model.starts_with("gpt-realtime") {
        return Err("a GPT Realtime model is required".into());
    }
    if request.voice.trim().is_empty() {
        return Err("voice is required".into());
    }
    if request.instructions.chars().count() > MAX_INSTRUCTIONS_LEN {
        return Err(format!(
            "instructions exceed {MAX_INSTRUCTIONS_LEN} characters"
        ));
    }
    Ok(())
}

fn build_session_body(request: &LiveClientSecretRequest) -> serde_json::Value {
    let instructions = if request.instructions.trim().is_empty() {
        "Be concise, conversational, and action-oriented. Confirm before consequential actions."
    } else {
        request.instructions.trim()
    };

    serde_json::json!({
        "session": {
            "type": "realtime",
            "model": request.model,
            "output_modalities": ["audio"],
            "audio": {
                "input": {
                    "transcription": { "model": "gpt-realtime-whisper" },
                    "turn_detection": {
                        "type": "semantic_vad",
                        "create_response": true,
                        "interrupt_response": true
                    }
                },
                "output": { "voice": request.voice }
            },
            "instructions": instructions
        }
    })
}

#[tauri::command]
pub async fn voice_live_client_secret(
    request: LiveClientSecretRequest,
) -> Result<LiveClientSecretResponse, String> {
    validate_request(&request)?;
    let api_key = get_provider_key("openai")?
        .filter(|key| !key.trim().is_empty())
        .ok_or_else(|| "OpenAI API key is required".to_string())?;

    let (builder, _) = cognia_net::proxy_config::apply_reqwest_policy(
        reqwest::Client::builder(),
        CLIENT_SECRETS_URL,
    )
    .map_err(|error| error.to_string())?;
    let client = builder
        .build()
        .map_err(|error| format!("client secret client build failed: {error}"))?;
    let response = client
        .post(CLIENT_SECRETS_URL)
        .bearer_auth(api_key)
        .json(&build_session_body(&request))
        .send()
        .await
        .map_err(|error| format!("client secret request failed: {error}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("client secret response read failed: {error}"))?;
    if !status.is_success() {
        return Err(format!(
            "client secret request failed ({status}): {}",
            body.chars().take(512).collect::<String>()
        ));
    }

    let result: LiveClientSecretResponse = serde_json::from_str(&body)
        .map_err(|error| format!("invalid client secret response: {error}"))?;
    if result.value.is_empty() {
        return Err("client secret response is missing a value".into());
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> LiveClientSecretRequest {
        LiveClientSecretRequest {
            model: "gpt-realtime-2.1".into(),
            voice: "marin".into(),
            instructions: String::new(),
        }
    }

    #[test]
    fn session_uses_semantic_vad_transcription_and_interruption() {
        let body = build_session_body(&request());
        let input = &body["session"]["audio"]["input"];
        assert_eq!(input["transcription"]["model"], "gpt-realtime-whisper");
        assert_eq!(input["turn_detection"]["type"], "semantic_vad");
        assert_eq!(input["turn_detection"]["create_response"], true);
        assert_eq!(input["turn_detection"]["interrupt_response"], true);
        assert_eq!(body["session"]["audio"]["output"]["voice"], "marin");
    }

    #[test]
    fn rejects_non_realtime_models_and_oversized_instructions() {
        let mut invalid = request();
        invalid.model = "gpt-5.6".into();
        assert!(validate_request(&invalid).is_err());

        invalid = request();
        invalid.instructions = "x".repeat(MAX_INSTRUCTIONS_LEN + 1);
        assert!(validate_request(&invalid).is_err());
    }

    #[test]
    fn client_secret_response_serializes_without_exposing_the_api_key() {
        let response = LiveClientSecretResponse {
            value: "ek_live".into(),
        };
        assert_eq!(
            serde_json::to_string(&response).unwrap(),
            r#"{"value":"ek_live"}"#
        );
    }
}

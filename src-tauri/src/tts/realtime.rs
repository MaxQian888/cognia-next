// OpenAI Realtime TTS WebSocket bridge.
//
// The Realtime API speaks over `wss://api.openai.com/v1/realtime` and requires
// an `Authorization: Bearer` header on the WebSocket handshake, which browsers
// cannot set. So — like Edge-TTS — synthesis runs from the Tauri host process
// and streams audio back to the renderer, here via a `tauri::ipc::Channel` so
// playback can start on the first delta instead of waiting for the full clip.
//
// Protocol (text-to-speech use of a speech-to-speech API):
//   1. Connect WSS with the bearer token.
//   2. `session.update` — request PCM16/24kHz audio output + a verbatim
//      "read this aloud" instruction so the model narrates rather than answers.
//   3. `conversation.item.create` — the text to speak as an input_text message.
//   4. `response.create` — ask the model to produce the audio response.
//   5. Forward each `response.output_audio.delta` (base64 PCM16) over the
//      channel until `response.done`.
//
// Cancellation: each request registers an `Arc<Notify>` under its request id;
// `tts_realtime_cancel` fires it and the receive loop selects on it.

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use tauri::ipc::Channel;
use tokio::sync::Notify;
use tokio_tungstenite::{
    connect_async, tungstenite::client::IntoClientRequest, tungstenite::Message,
};

const REALTIME_URL_BASE: &str = "wss://api.openai.com/v1/realtime";
const MAX_TEXT_LEN: usize = 4096;
const VERBATIM_INSTRUCTION: &str = "You are a text-to-speech engine. Read the user's message aloud exactly as written, verbatim. Do not answer it, summarize it, translate it, or add any words of your own.";

#[derive(Debug, serde::Deserialize)]
pub struct RealtimeRequest {
    pub request_id: String,
    pub api_key: String,
    pub text: String,
    #[serde(default = "default_voice")]
    pub voice: String,
    #[serde(default = "default_model")]
    pub model: String,
    #[serde(default)]
    pub instructions: String,
}

fn default_voice() -> String {
    "marin".into()
}
fn default_model() -> String {
    "gpt-realtime".into()
}

/// Streamed back to the renderer. Serializes as `{ "event": "...", "data": "..." }`.
#[derive(Clone, serde::Serialize)]
#[serde(tag = "event", content = "data", rename_all = "snake_case")]
pub enum RealtimeEvent {
    /// base64 PCM16 mono @ 24kHz.
    Audio(String),
    Done,
    Error(String),
}

static CANCELS: OnceLock<Mutex<HashMap<String, Arc<Notify>>>> = OnceLock::new();

fn cancels() -> &'static Mutex<HashMap<String, Arc<Notify>>> {
    CANCELS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[tauri::command]
pub async fn tts_realtime_synthesize(
    request: RealtimeRequest,
    on_event: Channel<RealtimeEvent>,
) -> Result<(), String> {
    if request.text.trim().is_empty() {
        return Err("text is required".into());
    }
    if request.text.chars().count() > MAX_TEXT_LEN {
        return Err(format!("text exceeds {MAX_TEXT_LEN} characters"));
    }
    if request.api_key.is_empty() {
        return Err("OpenAI API key is required".into());
    }

    let cancel = Arc::new(Notify::new());
    cancels()
        .lock()
        .insert(request.request_id.clone(), cancel.clone());

    let result = synthesize(&request, &on_event, &cancel).await;
    cancels().lock().remove(&request.request_id);

    if let Err(message) = &result {
        // Surface connection-level failures over the channel too, so the
        // renderer reacts even though the command also returns Err.
        let _ = on_event.send(RealtimeEvent::Error(message.clone()));
    }
    result
}

#[tauri::command]
pub fn tts_realtime_cancel(request_id: String) {
    if let Some(cancel) = cancels().lock().remove(&request_id) {
        cancel.notify_waiters();
    }
}

async fn synthesize(
    request: &RealtimeRequest,
    on_event: &Channel<RealtimeEvent>,
    cancel: &Arc<Notify>,
) -> Result<(), String> {
    let url = format!("{REALTIME_URL_BASE}?model={}", request.model);
    let mut req = url
        .into_client_request()
        .map_err(|e| format!("ws req build failed: {e}"))?;
    {
        let h = req.headers_mut();
        h.insert(
            "Authorization",
            format!("Bearer {}", request.api_key)
                .parse()
                .map_err(|_| "invalid api key header".to_string())?,
        );
        h.insert("OpenAI-Beta", "realtime=v1".parse().unwrap());
    }

    let (mut ws, _) = connect_async(req)
        .await
        .map_err(|e| format!("ws connect failed: {e}"))?;

    ws.send(Message::Text(build_session_update(
        &request.voice,
        &request.instructions,
    )))
    .await
    .map_err(|e| format!("ws send session failed: {e}"))?;
    ws.send(Message::Text(build_item_create(&request.text)))
        .await
        .map_err(|e| format!("ws send item failed: {e}"))?;
    ws.send(Message::Text(build_response_create()))
        .await
        .map_err(|e| format!("ws send response failed: {e}"))?;

    loop {
        tokio::select! {
            _ = cancel.notified() => {
                let _ = ws.send(Message::Close(None)).await;
                break;
            }
            msg = ws.next() => {
                match msg {
                    Some(Ok(Message::Text(txt))) => match parse_event(&txt) {
                        Some(RealtimeEvent::Audio(b64)) => {
                            on_event
                                .send(RealtimeEvent::Audio(b64))
                                .map_err(|e| format!("channel send failed: {e}"))?;
                        }
                        Some(RealtimeEvent::Done) => {
                            on_event
                                .send(RealtimeEvent::Done)
                                .map_err(|e| format!("channel send failed: {e}"))?;
                            break;
                        }
                        Some(RealtimeEvent::Error(e)) => {
                            on_event
                                .send(RealtimeEvent::Error(e))
                                .map_err(|e| format!("channel send failed: {e}"))?;
                            break;
                        }
                        None => {}
                    },
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(e)) => return Err(format!("ws recv failed: {e}")),
                }
            }
        }
    }

    let _ = ws.send(Message::Close(None)).await;
    Ok(())
}

fn build_session_update(voice: &str, user_instructions: &str) -> String {
    let instructions = if user_instructions.trim().is_empty() {
        VERBATIM_INSTRUCTION.to_string()
    } else {
        format!("{VERBATIM_INSTRUCTION} Delivery style: {user_instructions}")
    };
    serde_json::json!({
        "type": "session.update",
        "session": {
            "type": "realtime",
            "output_modalities": ["audio"],
            "audio": {
                "output": {
                    "voice": voice,
                    "format": { "type": "audio/pcm", "rate": 24000 }
                }
            },
            "instructions": instructions
        }
    })
    .to_string()
}

fn build_item_create(text: &str) -> String {
    serde_json::json!({
        "type": "conversation.item.create",
        "item": {
            "type": "message",
            "role": "user",
            "content": [{ "type": "input_text", "text": text }]
        }
    })
    .to_string()
}

fn build_response_create() -> String {
    serde_json::json!({ "type": "response.create" }).to_string()
}

/// Map a server event to a channel event. Handles both the GA
/// (`response.output_audio.delta`) and legacy (`response.audio.delta`) names.
fn parse_event(text: &str) -> Option<RealtimeEvent> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    let kind = value.get("type")?.as_str()?;
    match kind {
        "response.output_audio.delta" | "response.audio.delta" => {
            let delta = value.get("delta")?.as_str()?;
            Some(RealtimeEvent::Audio(delta.to_string()))
        }
        "response.done" => Some(RealtimeEvent::Done),
        "error" | "response.failed" => {
            let message = value
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .unwrap_or("Realtime synthesis failed")
                .to_string();
            Some(RealtimeEvent::Error(message))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_update_requests_pcm_audio_and_voice() {
        let frame = build_session_update("cedar", "");
        assert!(frame.contains("session.update"));
        assert!(frame.contains("\"voice\":\"cedar\""));
        assert!(frame.contains("audio/pcm"));
        assert!(frame.contains(VERBATIM_INSTRUCTION));
    }

    #[test]
    fn session_update_appends_user_delivery_style() {
        let frame = build_session_update("marin", "sound excited");
        assert!(frame.contains("Delivery style: sound excited"));
    }

    #[test]
    fn item_create_carries_the_text_as_input_text() {
        let frame = build_item_create("hello world");
        assert!(frame.contains("conversation.item.create"));
        assert!(frame.contains("input_text"));
        assert!(frame.contains("hello world"));
    }

    #[test]
    fn response_create_is_minimal() {
        assert_eq!(build_response_create(), "{\"type\":\"response.create\"}");
    }

    #[test]
    fn parse_event_reads_ga_audio_delta() {
        let ev = parse_event(r#"{"type":"response.output_audio.delta","delta":"QUJD"}"#);
        assert!(matches!(ev, Some(RealtimeEvent::Audio(b)) if b == "QUJD"));
    }

    #[test]
    fn parse_event_reads_legacy_audio_delta() {
        let ev = parse_event(r#"{"type":"response.audio.delta","delta":"WFla"}"#);
        assert!(matches!(ev, Some(RealtimeEvent::Audio(b)) if b == "WFla"));
    }

    #[test]
    fn parse_event_maps_done_and_error() {
        assert!(matches!(
            parse_event(r#"{"type":"response.done"}"#),
            Some(RealtimeEvent::Done)
        ));
        let err = parse_event(r#"{"type":"error","error":{"message":"bad key"}}"#);
        assert!(matches!(err, Some(RealtimeEvent::Error(m)) if m == "bad key"));
    }

    #[test]
    fn parse_event_ignores_unrelated_and_malformed() {
        assert!(parse_event(r#"{"type":"response.created"}"#).is_none());
        assert!(parse_event("not json").is_none());
    }

    #[test]
    fn cancel_of_unknown_id_is_a_noop() {
        // Should not panic when the id was never registered.
        tts_realtime_cancel("never-registered".into());
    }

    #[test]
    fn realtime_event_serializes_with_event_tag() {
        let audio = serde_json::to_string(&RealtimeEvent::Audio("AA==".into())).unwrap();
        assert_eq!(audio, "{\"event\":\"audio\",\"data\":\"AA==\"}");
        let done = serde_json::to_string(&RealtimeEvent::Done).unwrap();
        assert_eq!(done, "{\"event\":\"done\"}");
    }
}

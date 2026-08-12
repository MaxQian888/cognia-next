// Edge-TTS WebSocket bridge.
//
// Microsoft Edge's free neural-voice TTS speaks a custom WebSocket protocol
// that browsers cannot reach directly under static export. This module talks
// to `speech.platform.bing.com` from the Tauri host process and returns the
// raw MP3 bytes back to the renderer.
//
// Protocol summary (reverse-engineered, public references):
//   1. Open WSS with TrustedClientToken query param + Edge-extension Origin.
//   2. Send a text frame "speech.config" with desired audio format.
//   3. Send a text frame "ssml" with the SSML payload.
//   4. Receive text + binary frames; binary frames carry [u16 header_len ||
//      header_text || audio_bytes]. Stop once a text frame with
//      "Path:turn.end" arrives.
//
// We deliberately avoid third-party Edge-TTS crates so the dep surface stays
// small (`tokio-tungstenite` + a UUID + chrono-style timestamp).

use std::time::{SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::{
    connect_async, tungstenite::client::IntoClientRequest, tungstenite::Message,
};
use uuid::Uuid;

const WSS_URL: &str = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const ORIGIN: &str = "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold";
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";
const OUTPUT_FORMAT: &str = "audio-24khz-48kbitrate-mono-mp3";
const MAX_TEXT_LEN: usize = 10_000;

#[derive(Debug, serde::Deserialize)]
pub struct EdgeRequest {
    pub text: String,
    #[serde(default = "default_voice")]
    pub voice: String,
    /// e.g. "+0%", "-10%"
    #[serde(default = "default_rate")]
    pub rate: String,
    /// e.g. "+0Hz", "-10Hz"
    #[serde(default = "default_pitch")]
    pub pitch: String,
    /// e.g. "+0%"
    #[serde(default = "default_volume")]
    pub volume: String,
}

fn default_voice() -> String {
    "en-US-JennyNeural".into()
}
fn default_rate() -> String {
    "+0%".into()
}
fn default_pitch() -> String {
    "+0Hz".into()
}
fn default_volume() -> String {
    "+0%".into()
}

#[derive(Debug, serde::Serialize)]
pub struct EdgeResponse {
    /// Base64 MP3 bytes.
    pub body_b64: String,
    pub mime: String,
}

#[tauri::command]
pub async fn tts_edge_synthesize(request: EdgeRequest) -> Result<EdgeResponse, String> {
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};

    if request.text.is_empty() {
        return Err("text is required".into());
    }
    if request.text.chars().count() > MAX_TEXT_LEN {
        return Err(format!("text exceeds {MAX_TEXT_LEN} characters"));
    }

    let bytes = synthesize(&request).await?;
    if bytes.is_empty() {
        return Err("Edge-TTS returned empty audio".into());
    }
    Ok(EdgeResponse {
        body_b64: B64.encode(bytes),
        mime: "audio/mpeg".into(),
    })
}

async fn synthesize(request: &EdgeRequest) -> Result<Vec<u8>, String> {
    let mut req = WSS_URL
        .into_client_request()
        .map_err(|e| format!("ws req build failed: {e}"))?;

    let h = req.headers_mut();
    h.insert("Origin", ORIGIN.parse().unwrap());
    h.insert("User-Agent", USER_AGENT.parse().unwrap());

    let (mut ws, _) = connect_async(req)
        .await
        .map_err(|e| format!("ws connect failed: {e}"))?;

    // 1) speech.config
    let config = build_config_frame();
    ws.send(Message::Text(config.into()))
        .await
        .map_err(|e| format!("ws send config failed: {e}"))?;

    // 2) ssml
    let request_id = Uuid::new_v4().simple().to_string();
    let ssml = build_ssml_frame(
        &request_id,
        &request.voice,
        &request.rate,
        &request.pitch,
        &request.volume,
        &request.text,
    );
    ws.send(Message::Text(ssml.into()))
        .await
        .map_err(|e| format!("ws send ssml failed: {e}"))?;

    // 3) collect binary audio chunks until turn.end (or close)
    let mut audio = Vec::<u8>::new();
    while let Some(msg) = ws.next().await {
        let msg = msg.map_err(|e| format!("ws recv failed: {e}"))?;
        match msg {
            Message::Binary(buf) => {
                if buf.len() < 2 {
                    continue;
                }
                let header_len = u16::from_be_bytes([buf[0], buf[1]]) as usize;
                if buf.len() < 2 + header_len {
                    continue;
                }
                // Frames before "Path:audio" can be metadata; only Path:audio carries
                // MP3 bytes. Cheap substring check on the header text avoids parsing.
                let header = std::str::from_utf8(&buf[2..2 + header_len]).unwrap_or("");
                if header.contains("Path:audio") {
                    audio.extend_from_slice(&buf[2 + header_len..]);
                }
            }
            Message::Text(s) => {
                if s.contains("Path:turn.end") {
                    break;
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    let _ = ws.send(Message::Close(None)).await;
    Ok(audio)
}

fn build_config_frame() -> String {
    let ts = http_date_now();
    let body = format!(
    "{{\"context\":{{\"synthesis\":{{\"audio\":{{\"metadataoptions\":{{\"sentenceBoundaryEnabled\":\"false\",\"wordBoundaryEnabled\":\"false\"}},\"outputFormat\":\"{OUTPUT_FORMAT}\"}}}}}}}}"
  );
    format!(
    "X-Timestamp:{ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{body}"
  )
}

fn build_ssml_frame(
    request_id: &str,
    voice: &str,
    rate: &str,
    pitch: &str,
    volume: &str,
    text: &str,
) -> String {
    let ts = http_date_now();
    let escaped = xml_escape(text);
    // Edge-TTS expects xml:lang to match the voice's locale prefix.
    let lang = voice.split('-').take(2).collect::<Vec<_>>().join("-");
    let lang = if lang.is_empty() {
        "en-US".into()
    } else {
        lang
    };
    let ssml = format!(
    "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='{lang}'><voice name='{voice}'><prosody pitch='{pitch}' rate='{rate}' volume='{volume}'>{escaped}</prosody></voice></speak>"
  );
    format!(
    "X-RequestId:{request_id}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:{ts}\r\nPath:ssml\r\n\r\n{ssml}"
  )
}

fn http_date_now() -> String {
    // RFC1123-ish without pulling in `chrono`. Edge-TTS only needs a string.
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs}.0Z")
}

fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '\'' => out.push_str("&apos;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xml_escape_handles_special_chars() {
        assert_eq!(
            xml_escape("a&b<c>d'e\"f"),
            "a&amp;b&lt;c&gt;d&apos;e&quot;f"
        );
    }

    #[test]
    fn ssml_frame_contains_voice_and_text() {
        let frame = build_ssml_frame(
            "req",
            "zh-CN-XiaoxiaoNeural",
            "+10%",
            "+0Hz",
            "+0%",
            "hello",
        );
        assert!(frame.contains("Path:ssml"));
        assert!(frame.contains("zh-CN-XiaoxiaoNeural"));
        assert!(frame.contains(">hello<"));
        assert!(frame.contains("xml:lang='zh-CN'"));
    }

    #[test]
    fn config_frame_has_format() {
        let frame = build_config_frame();
        assert!(frame.contains("Path:speech.config"));
        assert!(frame.contains(OUTPUT_FORMAT));
    }
}

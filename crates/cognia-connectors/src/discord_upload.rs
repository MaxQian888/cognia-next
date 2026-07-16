//! Discord multipart media upload.
//!
//! Unlike most connectors, Discord has no separate "upload → key" step: posting
//! `multipart/form-data` to `POST /channels/{id}/messages` with a `payload_json`
//! part plus `files[n]` parts CREATES the message and returns the message object
//! in one round-trip. This module fetches each source URL and streams the bytes
//! up in that single request, returning the new message id.
//!
//! Voice messages are the same endpoint with `flags = 1 << 13` (IS_VOICE_MESSAGE)
//! and a `duration_secs` + `waveform` on the (single) audio attachment.

use std::time::Duration;

use reqwest::multipart::{Form, Part};
use serde::Deserialize;

use cognia_net::proxy_config;

const DISCORD_API_BASE: &str = "https://discord.com/api/v10";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscordUploadFile {
    pub source_url: String,
    pub filename: String,
    #[serde(default)]
    pub content_type: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    /// Voice-message duration in seconds (audio attachments only).
    #[serde(default)]
    pub duration_secs: Option<f64>,
    /// Base64 waveform for voice messages; Discord clients render it.
    #[serde(default)]
    pub waveform: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorDiscordUploadRequest {
    pub bot_token: String,
    pub channel_id: String,
    #[serde(default)]
    pub content: Option<String>,
    pub files: Vec<DiscordUploadFile>,
    #[serde(default)]
    pub reply_to_message_id: Option<String>,
    /// Message flags bitfield (e.g. IS_VOICE_MESSAGE = 1 << 13).
    #[serde(default)]
    pub flags: Option<u32>,
}

/// Build a reqwest client that honours the same proxy bypass / TLS config as the
/// rest of the connector HTTP layer.
fn build_client(target_url: &str) -> Result<reqwest::Client, String> {
    let proxy_cfg = proxy_config::current();
    let mut builder = reqwest::Client::builder().timeout(Duration::from_secs(60));
    if proxy_cfg.is_active() && !proxy_cfg.should_bypass(target_url) {
        if let Some(proxy) = proxy_cfg.build_reqwest_proxy() {
            builder = builder.proxy(proxy);
        }
    }
    builder
        .build()
        .map_err(|e| format!("reqwest build failed: {e}"))
}

/// Fetch the source URL into memory (shared proxy / TLS config). Times out after
/// 60 s — enough for typical image / short-video / voice payloads.
async fn fetch_bytes(source_url: &str) -> Result<bytes::Bytes, String> {
    let client = build_client(source_url)?;
    let resp = client
        .get(source_url)
        .send()
        .await
        .map_err(|e| format!("fetch source failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "fetch source returned HTTP {}",
            resp.status().as_u16()
        ));
    }
    resp.bytes()
        .await
        .map_err(|e| format!("read source body failed: {e}"))
}

/// Build the `payload_json` value: the attachments array (indexed to the
/// `files[n]` parts) plus optional content / flags / reply reference.
fn build_payload_json(req: &ConnectorDiscordUploadRequest) -> serde_json::Value {
    let attachments: Vec<serde_json::Value> = req
        .files
        .iter()
        .enumerate()
        .map(|(i, f)| {
            let mut a = serde_json::json!({ "id": i, "filename": f.filename });
            if let Some(d) = &f.description {
                a["description"] = serde_json::json!(d);
            }
            if let Some(secs) = f.duration_secs {
                a["duration_secs"] = serde_json::json!(secs);
            }
            if let Some(w) = &f.waveform {
                a["waveform"] = serde_json::json!(w);
            }
            a
        })
        .collect();

    let mut payload = serde_json::json!({ "attachments": attachments });
    if let Some(c) = &req.content {
        payload["content"] = serde_json::json!(c);
    }
    if let Some(flags) = req.flags {
        payload["flags"] = serde_json::json!(flags);
    }
    if let Some(mid) = &req.reply_to_message_id {
        payload["message_reference"] = serde_json::json!({ "message_id": mid });
    }
    payload
}

/// Pull the created message's `id` out of the Discord response.
fn extract_message_id(json: &serde_json::Value) -> Result<String, String> {
    json.get("id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("Discord response missing message id: {json}"))
}

/// Fetch each source URL and post them as `multipart/form-data` to Discord's
/// create-message endpoint. Returns the new message id.
pub async fn upload(req: ConnectorDiscordUploadRequest) -> Result<String, String> {
    if req.files.is_empty() {
        return Err("discord upload requires at least one file".to_string());
    }

    let payload_json = build_payload_json(&req);
    let mut form = Form::new().text("payload_json", payload_json.to_string());

    for (i, f) in req.files.iter().enumerate() {
        let bytes = fetch_bytes(&f.source_url).await?;
        let mut part = Part::bytes(bytes.to_vec()).file_name(f.filename.clone());
        if let Some(ct) = &f.content_type {
            part = part
                .mime_str(ct)
                .map_err(|e| format!("invalid content_type {ct}: {e}"))?;
        }
        form = form.part(format!("files[{i}]"), part);
    }

    let target = format!("{DISCORD_API_BASE}/channels/{}/messages", req.channel_id);
    let client = build_client(&target)?;
    let resp = client
        .post(&target)
        .header("Authorization", format!("Bot {}", req.bot_token))
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("discord upload request failed: {e}"))?;
    let status = resp.status().as_u16();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("read discord upload response failed: {e}"))?;
    if status >= 400 {
        return Err(format!("Discord upload HTTP {status}: {body}"));
    }
    let json: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| format!("Discord upload response is not JSON: {e}; body={body}"))?;
    extract_message_id(&json)
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn file(source_url: &str) -> DiscordUploadFile {
        DiscordUploadFile {
            source_url: source_url.to_string(),
            filename: "f.png".to_string(),
            content_type: Some("image/png".to_string()),
            description: None,
            duration_secs: None,
            waveform: None,
        }
    }

    #[test]
    fn build_payload_json_indexes_attachments_with_content_and_reply() {
        let req = ConnectorDiscordUploadRequest {
            bot_token: "T".into(),
            channel_id: "c1".into(),
            content: Some("hi".into()),
            files: vec![file("http://x/a.png"), file("http://x/b.png")],
            reply_to_message_id: Some("m9".into()),
            flags: None,
        };
        let p = build_payload_json(&req);
        assert_eq!(p["content"], "hi");
        assert_eq!(p["message_reference"]["message_id"], "m9");
        let atts = p["attachments"].as_array().unwrap();
        assert_eq!(atts.len(), 2);
        assert_eq!(atts[0]["id"], 0);
        assert_eq!(atts[1]["id"], 1);
        assert_eq!(atts[0]["filename"], "f.png");
    }

    #[test]
    fn build_payload_json_carries_voice_flag_duration_and_waveform() {
        let req = ConnectorDiscordUploadRequest {
            bot_token: "T".into(),
            channel_id: "c1".into(),
            content: None,
            files: vec![DiscordUploadFile {
                source_url: "http://x/v.ogg".into(),
                filename: "voice.ogg".into(),
                content_type: Some("audio/ogg".into()),
                description: None,
                duration_secs: Some(3.5),
                waveform: Some("AAAA".into()),
            }],
            reply_to_message_id: None,
            flags: Some(1 << 13),
        };
        let p = build_payload_json(&req);
        assert_eq!(p["flags"], 1 << 13);
        assert!(p.get("content").is_none());
        assert_eq!(p["attachments"][0]["duration_secs"], 3.5);
        assert_eq!(p["attachments"][0]["waveform"], "AAAA");
    }

    #[test]
    fn extract_message_id_reads_id() {
        let v: serde_json::Value =
            serde_json::from_str(r#"{"id":"123","channel_id":"c"}"#).unwrap();
        assert_eq!(extract_message_id(&v).unwrap(), "123");
    }

    #[test]
    fn extract_message_id_errors_when_missing() {
        let v: serde_json::Value = serde_json::from_str(r#"{"channel_id":"c"}"#).unwrap();
        assert!(extract_message_id(&v)
            .unwrap_err()
            .contains("missing message id"));
    }

    #[tokio::test]
    async fn fetch_bytes_returns_body() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/a.png"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(vec![9, 8, 7]))
            .mount(&server)
            .await;
        let bytes = fetch_bytes(&format!("{}/a.png", server.uri()))
            .await
            .unwrap();
        assert_eq!(&bytes[..], &[9u8, 8, 7]);
    }

    #[tokio::test]
    async fn fetch_bytes_propagates_http_error() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/missing.png"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;
        let err = fetch_bytes(&format!("{}/missing.png", server.uri()))
            .await
            .unwrap_err();
        assert!(err.contains("HTTP 404"), "got: {err}");
    }

    #[tokio::test]
    async fn upload_rejects_empty_files() {
        let req = ConnectorDiscordUploadRequest {
            bot_token: "T".into(),
            channel_id: "c1".into(),
            content: None,
            files: vec![],
            reply_to_message_id: None,
            flags: None,
        };
        assert!(upload(req).await.unwrap_err().contains("at least one file"));
    }
}

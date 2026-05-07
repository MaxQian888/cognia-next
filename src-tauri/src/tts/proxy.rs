// Generic HTTP proxy for TTS provider calls.
//
// Browser fetches to OpenAI / ElevenLabs / Cartesia / Deepgram / LMNT / Hume /
// Gemini fail in two ways under static export: (1) some providers reject
// browser Origins outright (CORS), (2) browser-side calls leak the API key
// into the renderer. This proxy keeps the key in the Rust process and
// returns the raw audio bytes back to the renderer.
//
// Wire format intentionally mirrors what each provider's REST endpoint
// expects — the frontend builds the body & headers, we just relay.

use std::collections::HashMap;

use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
pub struct ProxyRequest {
    /// Fully-qualified URL (e.g., "https://api.openai.com/v1/audio/speech").
    pub url: String,
    /// HTTP method — "POST" / "GET" / etc. Defaults to POST.
    #[serde(default = "default_method")]
    pub method: String,
    /// Header map — keys are lowercased before sending.
    #[serde(default)]
    pub headers: HashMap<String, String>,
    /// Optional JSON body. Mutually exclusive with `body_bytes`.
    #[serde(default)]
    pub json: Option<serde_json::Value>,
    /// Optional raw body — base64-encoded so the bridge stays JSON-safe.
    #[serde(default)]
    pub body_b64: Option<String>,
}

fn default_method() -> String {
    "POST".to_string()
}

#[derive(Debug, Serialize)]
pub struct ProxyResponse {
    pub status: u16,
    pub mime: String,
    /// Base64-encoded body bytes.
    pub body_b64: String,
}

fn build_headers(map: &HashMap<String, String>) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();
    for (k, v) in map {
        let name = HeaderName::from_bytes(k.to_lowercase().as_bytes())
            .map_err(|e| format!("invalid header name '{k}': {e}"))?;
        let val =
            HeaderValue::from_str(v).map_err(|e| format!("invalid header value for '{k}': {e}"))?;
        headers.insert(name, val);
    }
    Ok(headers)
}

#[tauri::command]
pub async fn tts_proxy_fetch(request: ProxyRequest) -> Result<ProxyResponse, String> {
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};

    let proxy_cfg = crate::proxy_config::current();
    let mut client_builder = reqwest::Client::builder().user_agent("cognia-next-tts/1.0");
    if proxy_cfg.is_active() && !proxy_cfg.should_bypass(&request.url) {
        if let Some(proxy) = proxy_cfg.build_reqwest_proxy() {
            client_builder = client_builder.proxy(proxy);
        }
    }
    let client = client_builder
        .build()
        .map_err(|e| format!("client build failed: {e}"))?;

    let method = match request.method.to_uppercase().as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "DELETE" => reqwest::Method::DELETE,
        other => return Err(format!("unsupported method '{other}'")),
    };

    let mut req = client.request(method, &request.url);
    req = req.headers(build_headers(&request.headers)?);

    if let Some(json) = request.json {
        req = req.json(&json);
    } else if let Some(b64) = request.body_b64 {
        let bytes = B64
            .decode(b64)
            .map_err(|e| format!("body_b64 decode failed: {e}"))?;
        req = req.body(bytes);
    }

    let response = req.send().await.map_err(|e| format!("send failed: {e}"))?;

    let status = response.status().as_u16();
    let mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("body read failed: {e}"))?;

    Ok(ProxyResponse {
        status,
        mime,
        body_b64: B64.encode(bytes),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_headers_lowercased() {
        let mut map = HashMap::new();
        map.insert("Authorization".to_string(), "Bearer xyz".to_string());
        let headers = build_headers(&map).unwrap();
        assert!(headers.contains_key("authorization"));
    }

    #[test]
    fn rejects_invalid_header_name() {
        let mut map = HashMap::new();
        map.insert("invalid header".to_string(), "v".to_string());
        assert!(build_headers(&map).is_err());
    }

    #[test]
    fn default_method_is_post() {
        let req: ProxyRequest = serde_json::from_str(r#"{"url":"https://example.com"}"#).unwrap();
        assert_eq!(req.method, "POST");
    }
}

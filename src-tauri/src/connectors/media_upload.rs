//! Generic connector media upload command.
//!
//! Some platforms, including Matrix, require raw bytes to be uploaded to a
//! platform media repository before a chat message can reference the asset.
//! The renderer prepares the platform-specific upload URL and auth headers;
//! this module owns byte loading, proxy-aware HTTP dispatch, and response
//! extraction.

use std::time::Duration;

use reqwest::header::{HeaderName, HeaderValue};

use super::types::ConnectorMediaUploadRequest;
use crate::proxy_config;

/// Hard cap on the bytes loaded into memory for a single outbound upload. The
/// source (remote URL or local file) is streamed/checked against this so a
/// multi-GB asset can't OOM the process on a memory-constrained device. 100 MiB
/// comfortably covers images / short clips while staying bounded.
const MAX_UPLOAD_BYTES: usize = 100 * 1024 * 1024;

fn build_client(target_url: &str) -> Result<reqwest::Client, String> {
    let proxy_cfg = proxy_config::current();
    let mut builder = reqwest::Client::builder().timeout(Duration::from_secs(120));
    if proxy_cfg.is_active() && !proxy_cfg.should_bypass(target_url) {
        if let Some(proxy) = proxy_cfg.build_reqwest_proxy() {
            builder = builder.proxy(proxy);
        }
    }
    builder
        .build()
        .map_err(|e| format!("reqwest build failed: {e}"))
}

async fn read_source_bytes(
    req: &ConnectorMediaUploadRequest,
    max_bytes: usize,
) -> Result<bytes::Bytes, String> {
    match (&req.source_url, &req.local_path) {
        (Some(source_url), None) => {
            let client = build_client(source_url)?;
            let mut resp = client
                .get(source_url)
                .send()
                .await
                .map_err(|e| format!("fetch source failed: {e}"))?;
            let status = resp.status().as_u16();
            if status >= 400 {
                return Err(format!("fetch source returned HTTP {status}"));
            }
            // Reject early when the server advertises an oversized body.
            if let Some(len) = resp.content_length() {
                if len > max_bytes as u64 {
                    return Err(format!(
                        "source media is {len} bytes, exceeding the {max_bytes}-byte upload cap"
                    ));
                }
            }
            // Stream with a hard cap so a missing / lying Content-Length can't
            // buffer an unbounded amount of memory.
            let mut buf: Vec<u8> = Vec::new();
            while let Some(chunk) = resp
                .chunk()
                .await
                .map_err(|e| format!("read source body failed: {e}"))?
            {
                if buf.len() + chunk.len() > max_bytes {
                    return Err(format!(
                        "source media exceeds the {max_bytes}-byte upload cap"
                    ));
                }
                buf.extend_from_slice(&chunk);
            }
            Ok(bytes::Bytes::from(buf))
        }
        (None, Some(local_path)) => {
            // std has no async file API here (tokio built without the `fs`
            // feature), so read on a blocking pool to avoid stalling the async
            // executor, and stat-then-cap so an oversized file is never slurped.
            let local_path = local_path.clone();
            tokio::task::spawn_blocking(move || {
                let meta = std::fs::metadata(&local_path)
                    .map_err(|e| format!("stat local media failed: {e}"))?;
                if meta.len() > max_bytes as u64 {
                    return Err(format!(
                        "local media is {} bytes, exceeding the {max_bytes}-byte upload cap",
                        meta.len()
                    ));
                }
                std::fs::read(&local_path)
                    .map(bytes::Bytes::from)
                    .map_err(|e| format!("read local media failed: {e}"))
            })
            .await
            .map_err(|e| format!("local media read task failed: {e}"))?
        }
        (Some(_), Some(_)) => {
            Err("media upload accepts either sourceUrl or localPath, not both".into())
        }
        (None, None) => Err("media upload requires sourceUrl or localPath".into()),
    }
}

fn apply_headers(
    mut builder: reqwest::RequestBuilder,
    req: &ConnectorMediaUploadRequest,
) -> Result<reqwest::RequestBuilder, String> {
    if let Some(headers) = &req.headers {
        for (name, value) in headers {
            if req.content_type.is_some() && name.eq_ignore_ascii_case("content-type") {
                continue;
            }
            let header_name = HeaderName::from_bytes(name.as_bytes())
                .map_err(|e| format!("invalid upload header name '{name}': {e}"))?;
            let header_value = HeaderValue::from_str(value)
                .map_err(|e| format!("invalid upload header value for '{name}': {e}"))?;
            builder = builder.header(header_name, header_value);
        }
    }
    if let Some(content_type) = &req.content_type {
        builder = builder.header(reqwest::header::CONTENT_TYPE, content_type);
    }
    Ok(builder)
}

fn extract_content_uri(body: &str) -> Result<String, String> {
    let json: serde_json::Value = serde_json::from_str(body)
        .map_err(|e| format!("media upload response is not JSON: {e}; body={body}"))?;
    json.get("content_uri")
        .and_then(|v| v.as_str())
        .map(ToString::to_string)
        .ok_or_else(|| "media upload response missing content_uri".to_string())
}

pub async fn upload_media(req: ConnectorMediaUploadRequest) -> Result<String, String> {
    let bytes = read_source_bytes(&req, MAX_UPLOAD_BYTES).await?;
    let client = build_client(&req.upload_url)?;
    let builder = client.post(&req.upload_url).body(bytes);
    let builder = apply_headers(builder, &req)?;
    let resp = builder
        .send()
        .await
        .map_err(|e| format!("media upload request failed: {e}"))?;
    let status = resp.status().as_u16();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("read media upload response failed: {e}"))?;
    if status >= 400 {
        return Err(format!("media upload HTTP {status}: {body}"));
    }
    extract_content_uri(&body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_bytes, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn upload_media_posts_local_bytes_and_returns_content_uri() {
        let mock_server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/_matrix/media/v3/upload"))
            .and(header("authorization", "Bearer tok"))
            .and(header("content-type", "image/png"))
            .and(body_bytes(vec![1u8, 2, 3]))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "content_uri": "mxc://matrix.org/up" })),
            )
            .expect(1)
            .mount(&mock_server)
            .await;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pic.png");
        std::fs::write(&path, [1u8, 2, 3]).unwrap();

        let mut headers = std::collections::HashMap::new();
        headers.insert("Authorization".to_string(), "Bearer tok".to_string());

        let content_uri = upload_media(ConnectorMediaUploadRequest {
            upload_url: format!(
                "{}/_matrix/media/v3/upload?filename=pic.png",
                mock_server.uri()
            ),
            headers: Some(headers),
            source_url: None,
            local_path: Some(path.to_string_lossy().into_owned()),
            content_type: Some("image/png".to_string()),
        })
        .await
        .unwrap();

        assert_eq!(content_uri, "mxc://matrix.org/up");
        mock_server.verify().await;
    }

    #[tokio::test]
    async fn upload_media_fetches_source_url_first() {
        let mock_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/source.bin"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(vec![7u8, 8, 9]))
            .expect(1)
            .mount(&mock_server)
            .await;
        Mock::given(method("POST"))
            .and(path("/upload"))
            .and(body_bytes(vec![7u8, 8, 9]))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "content_uri": "mxc://matrix.org/url" })),
            )
            .expect(1)
            .mount(&mock_server)
            .await;

        let content_uri = upload_media(ConnectorMediaUploadRequest {
            upload_url: format!("{}/upload", mock_server.uri()),
            headers: None,
            source_url: Some(format!("{}/source.bin", mock_server.uri())),
            local_path: None,
            content_type: None,
        })
        .await
        .unwrap();

        assert_eq!(content_uri, "mxc://matrix.org/url");
        mock_server.verify().await;
    }

    #[tokio::test]
    async fn upload_media_requires_exactly_one_source() {
        let err = upload_media(ConnectorMediaUploadRequest {
            upload_url: "https://matrix.example/upload".to_string(),
            headers: None,
            source_url: None,
            local_path: None,
            content_type: None,
        })
        .await
        .unwrap_err();
        assert!(
            err.contains("requires sourceUrl or localPath"),
            "got: {err}"
        );
    }

    #[test]
    fn extract_content_uri_rejects_missing_field() {
        let err = extract_content_uri(r#"{"ok":true}"#).unwrap_err();
        assert!(err.contains("missing content_uri"));
    }

    #[tokio::test]
    async fn read_source_bytes_rejects_oversized_local_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.bin");
        std::fs::write(&path, [0u8; 16]).unwrap();
        let req = ConnectorMediaUploadRequest {
            upload_url: "https://x/upload".into(),
            headers: None,
            source_url: None,
            local_path: Some(path.to_string_lossy().into_owned()),
            content_type: None,
        };
        let err = read_source_bytes(&req, 8).await.unwrap_err();
        assert!(err.contains("upload cap"), "got: {err}");
    }

    #[tokio::test]
    async fn read_source_bytes_rejects_oversized_remote_body() {
        let mock_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/big.bin"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(vec![0u8; 16]))
            .mount(&mock_server)
            .await;
        let req = ConnectorMediaUploadRequest {
            upload_url: "https://x/upload".into(),
            headers: None,
            source_url: Some(format!("{}/big.bin", mock_server.uri())),
            local_path: None,
            content_type: None,
        };
        let err = read_source_bytes(&req, 8).await.unwrap_err();
        assert!(err.contains("upload cap"), "got: {err}");
    }

    #[tokio::test]
    async fn read_source_bytes_accepts_within_cap() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ok.bin");
        std::fs::write(&path, [1u8, 2, 3]).unwrap();
        let req = ConnectorMediaUploadRequest {
            upload_url: "https://x/upload".into(),
            headers: None,
            source_url: None,
            local_path: Some(path.to_string_lossy().into_owned()),
            content_type: None,
        };
        let bytes = read_source_bytes(&req, 1024).await.unwrap();
        assert_eq!(bytes.as_ref(), &[1u8, 2, 3]);
    }
}

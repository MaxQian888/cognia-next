//! Generic connector media upload command.
//!
//! Some platforms, including Matrix, require raw bytes to be uploaded to a
//! platform media repository before a chat message can reference the asset.
//! The renderer prepares the platform-specific upload URL and auth headers;
//! this module owns byte loading, proxy-aware HTTP dispatch, and response
//! extraction.

use std::time::Duration;

use reqwest::header::{HeaderName, HeaderValue};

use super::types::{ConnectorMediaUploadRequest, MediaUploadResponseMode, TauriHttpResponse};
use cognia_net::proxy_config;

/// Hard cap on the bytes loaded into memory for a single outbound upload. The
/// source (remote URL or local file) is streamed/checked against this so a
/// multi-GB asset can't OOM the process on a memory-constrained device. 100 MiB
/// comfortably covers images / short clips while staying bounded.
const MAX_UPLOAD_BYTES: usize = 100 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_FORM_FIELDS_BYTES: usize = 64 * 1024;

fn build_client(target_url: &str) -> Result<reqwest::Client, String> {
    let builder = reqwest::Client::builder().timeout(Duration::from_secs(120));
    let (builder, _) = proxy_config::apply_reqwest_policy(builder, target_url)
        .map_err(|error| error.to_string())?;
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
                if !meta.is_file() {
                    return Err("local media must be a regular file".into());
                }
                // Bound the read itself as well as metadata: files may grow
                // between stat and read, and special files may report size 0.
                use std::io::Read;
                let file = std::fs::File::open(&local_path)
                    .map_err(|e| format!("open local media failed: {e}"))?;
                let mut bytes = Vec::new();
                file.take(max_bytes as u64 + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|e| format!("read local media failed: {e}"))?;
                if bytes.len() > max_bytes {
                    return Err(format!(
                        "local media exceeds the {max_bytes}-byte upload cap"
                    ));
                }
                Ok(bytes::Bytes::from(bytes))
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
            if (req.content_type.is_some() || req.multipart.is_some())
                && name.eq_ignore_ascii_case("content-type")
            {
                continue;
            }
            let header_name = HeaderName::from_bytes(name.as_bytes())
                .map_err(|e| format!("invalid upload header name '{name}': {e}"))?;
            let header_value = HeaderValue::from_str(value)
                .map_err(|e| format!("invalid upload header value for '{name}': {e}"))?;
            builder = builder.header(header_name, header_value);
        }
    }
    if let Some(content_type) = req
        .content_type
        .as_ref()
        .filter(|_| req.multipart.is_none())
    {
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

async fn upload_bytes(
    req: &ConnectorMediaUploadRequest,
    bytes: bytes::Bytes,
) -> Result<String, String> {
    let client = build_client(&req.upload_url)?;
    let builder = if let Some(multipart) = &req.multipart {
        if multipart.field_name.is_empty() || multipart.filename.is_empty() {
            return Err("multipart upload requires fieldName and filename".into());
        }
        if multipart.fields.contains_key(&multipart.field_name) {
            return Err("multipart file field duplicates a text field".into());
        }
        let field_bytes = multipart
            .fields
            .iter()
            .try_fold(0usize, |total, (key, value)| {
                total
                    .checked_add(key.len())
                    .and_then(|size| size.checked_add(value.len()))
            });
        if field_bytes.is_none_or(|size| size > MAX_FORM_FIELDS_BYTES) {
            return Err("multipart text fields exceed upload cap".into());
        }
        let mut file = reqwest::multipart::Part::stream(reqwest::Body::from(bytes))
            .file_name(multipart.filename.clone());
        if let Some(content_type) = &req.content_type {
            file = file
                .mime_str(content_type)
                .map_err(|e| format!("invalid media contentType: {e}"))?;
        }
        let mut form = reqwest::multipart::Form::new().part(multipart.field_name.clone(), file);
        for (name, value) in &multipart.fields {
            form = form.text(name.clone(), value.clone());
        }
        client.post(&req.upload_url).multipart(form)
    } else {
        client.post(&req.upload_url).body(bytes)
    };
    let builder = apply_headers(builder, req)?;
    let mut resp = builder
        .send()
        .await
        .map_err(|e| format!("media upload request failed: {e}"))?;
    let status = resp.status().as_u16();
    let headers = resp
        .headers()
        .iter()
        .filter_map(|(key, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (key.to_string(), value.to_string()))
        })
        .collect();
    let mut response_bytes = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("read media upload response failed: {e}"))?
    {
        if chunk.len() > MAX_RESPONSE_BYTES.saturating_sub(response_bytes.len()) {
            return Err("media upload response exceeds size cap".into());
        }
        response_bytes.extend_from_slice(&chunk);
    }
    let body = String::from_utf8_lossy(&response_bytes).into_owned();
    if req.response_mode == Some(MediaUploadResponseMode::Http) {
        return serde_json::to_string(&TauriHttpResponse {
            status,
            headers,
            body,
        })
        .map_err(|e| format!("serialize media upload response failed: {e}"));
    }
    if status >= 400 {
        return Err(format!("media upload HTTP {status}: {body}"));
    }
    extract_content_uri(&body)
}

pub async fn upload_media(req: ConnectorMediaUploadRequest) -> Result<String, String> {
    let bytes = read_source_bytes(&req, MAX_UPLOAD_BYTES).await?;
    upload_bytes(&req, bytes).await
}

pub async fn upload_matrix_encrypted_media(
    req: super::types::MatrixEncryptedMediaUploadRequest,
) -> Result<super::types::MatrixEncryptedMediaUploadResponse, String> {
    let req: ConnectorMediaUploadRequest = req.into();
    let source = read_source_bytes(&req, MAX_UPLOAD_BYTES).await?;
    let (encrypted, mut file) = super::matrix_crypto::encrypt_attachment_bytes(source.to_vec())?;
    let content_uri = upload_bytes(&req, bytes::Bytes::from(encrypted)).await?;
    let object = file
        .as_object_mut()
        .ok_or_else(|| "Matrix attachment info must be an object".to_string())?;
    object.insert(
        "url".to_string(),
        serde_json::Value::String(content_uri.clone()),
    );
    Ok(super::types::MatrixEncryptedMediaUploadResponse { content_uri, file })
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_bytes, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn multipart_upload_preserves_file_fields_and_http_error_envelope() {
        proxy_config::apply_current(proxy_config::ProxyConfig::default()).unwrap();
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/sendDocument"))
            .respond_with(
                ResponseTemplate::new(429)
                    .insert_header("retry-after", "7")
                    .set_body_json(serde_json::json!({"ok":false,"parameters":{"retry_after":7}})),
            )
            .expect(1)
            .mount(&server)
            .await;
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("document.txt");
        std::fs::write(&source, b"document bytes").unwrap();
        let req = serde_json::from_value(serde_json::json!({
            "uploadUrl": format!("{}/sendDocument", server.uri()),
            "localPath": source.to_string_lossy(), "contentType":"text/plain",
            "headers": {"Content-Type":"application/json", "Authorization":"Bearer test"},
            "multipart": {"fieldName":"document", "filename":"document.txt", "fields":{"chat_id":"42", "caption":"hello"}},
            "responseMode":"http"
        })).unwrap();
        let result: serde_json::Value =
            serde_json::from_str(&upload_media(req).await.unwrap()).unwrap();
        assert_eq!(result["status"], 429);
        assert_eq!(result["headers"]["retry-after"], "7");
        let api: serde_json::Value =
            serde_json::from_str(result["body"].as_str().unwrap()).unwrap();
        assert_eq!(api["parameters"]["retry_after"], 7);
        let requests = server.received_requests().await.unwrap();
        let request = &requests[0];
        assert!(request.headers["content-type"]
            .to_str()
            .unwrap()
            .starts_with("multipart/form-data; boundary="));
        assert_eq!(request.headers["authorization"], "Bearer test");
        let body = String::from_utf8_lossy(&request.body);
        assert!(body.contains("name=\"document\"; filename=\"document.txt\""));
        assert!(body.contains("Content-Type: text/plain"));
        assert!(body.contains("document bytes"));
        assert!(body.contains("name=\"chat_id\"\r\n\r\n42"));
        assert!(body.contains("name=\"caption\"\r\n\r\nhello"));
    }

    fn request_for_test(server: &MockServer) -> ConnectorMediaUploadRequest {
        serde_json::from_value(
            serde_json::json!({ "uploadUrl": format!("{}/upload", server.uri()) }),
        )
        .unwrap()
    }

    #[tokio::test]
    async fn response_mode_http_keeps_non_json_and_legacy_mode_keeps_errors() {
        proxy_config::apply_current(proxy_config::ProxyConfig::default()).unwrap();
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(502).set_body_string("upstream unavailable"))
            .mount(&server)
            .await;
        let mut req = request_for_test(&server);
        assert!(upload_bytes(&req, bytes::Bytes::new())
            .await
            .unwrap_err()
            .contains("HTTP 502"));
        req.response_mode = Some(MediaUploadResponseMode::Http);
        let value: serde_json::Value =
            serde_json::from_str(&upload_bytes(&req, bytes::Bytes::new()).await.unwrap()).unwrap();
        assert_eq!(value["status"], 502);
        assert_eq!(value["body"], "upstream unavailable");
    }

    #[tokio::test]
    async fn multipart_rejects_invalid_file_metadata_and_field_overflow() {
        proxy_config::apply_current(proxy_config::ProxyConfig::default()).unwrap();
        let server = MockServer::start().await;
        let mut req = request_for_test(&server);
        for multipart in [
            serde_json::json!({ "fieldName":"", "filename":"file" }),
            serde_json::json!({ "fieldName":"file", "filename":"" }),
            serde_json::json!({ "fieldName":"file", "filename":"f", "fields":{"file":"duplicate"} }),
            serde_json::json!({ "fieldName":"file", "filename":"f", "fields":{"caption":"x".repeat(MAX_FORM_FIELDS_BYTES)} }),
        ] {
            req.multipart = Some(serde_json::from_value(multipart).unwrap());
            assert!(upload_bytes(&req, bytes::Bytes::new()).await.is_err());
        }
        req.multipart = Some(
            serde_json::from_value(serde_json::json!({"fieldName":"file", "filename":"f"}))
                .unwrap(),
        );
        req.content_type = Some("invalid mime".into());
        assert!(upload_bytes(&req, bytes::Bytes::new())
            .await
            .unwrap_err()
            .contains("contentType"));
        assert!(server.received_requests().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn upload_response_is_bounded_even_in_http_mode() {
        proxy_config::apply_current(proxy_config::ProxyConfig::default()).unwrap();
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(
                ResponseTemplate::new(200).set_body_bytes(vec![0; MAX_RESPONSE_BYTES + 1]),
            )
            .mount(&server)
            .await;
        let mut req = request_for_test(&server);
        req.response_mode = Some(MediaUploadResponseMode::Http);
        assert!(upload_bytes(&req, bytes::Bytes::new())
            .await
            .unwrap_err()
            .contains("size cap"));
    }

    #[tokio::test]
    async fn source_validation_rejects_conflicting_paths_directory_and_http_failure() {
        proxy_config::apply_current(proxy_config::ProxyConfig::default()).unwrap();
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;
        let mut req = request_for_test(&server);
        req.source_url = Some(format!("{}/missing", server.uri()));
        assert!(read_source_bytes(&req, 8)
            .await
            .unwrap_err()
            .contains("HTTP 404"));
        req.local_path = Some("/missing".into());
        assert!(read_source_bytes(&req, 8)
            .await
            .unwrap_err()
            .contains("not both"));
        req.source_url = None;
        assert!(read_source_bytes(&req, 8)
            .await
            .unwrap_err()
            .contains("stat local media"));
        let dir = tempfile::tempdir().unwrap();
        req.local_path = Some(dir.path().to_string_lossy().into_owned());
        assert!(read_source_bytes(&req, MAX_UPLOAD_BYTES)
            .await
            .unwrap_err()
            .contains("regular file"));
    }

    #[tokio::test]
    async fn upload_media_posts_local_bytes_and_returns_content_uri() {
        proxy_config::apply_current(proxy_config::ProxyConfig::default()).unwrap();
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
            multipart: None,
            response_mode: None,
        })
        .await
        .unwrap();

        assert_eq!(content_uri, "mxc://matrix.org/up");
        mock_server.verify().await;
    }

    #[tokio::test]
    async fn upload_media_fetches_source_url_first() {
        proxy_config::apply_current(proxy_config::ProxyConfig::default()).unwrap();
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
            multipart: None,
            response_mode: None,
        })
        .await
        .unwrap();

        assert_eq!(content_uri, "mxc://matrix.org/url");
        mock_server.verify().await;
    }

    #[tokio::test]
    async fn encrypted_matrix_upload_reuses_bounded_reader_and_returns_file_object() {
        proxy_config::apply_current(proxy_config::ProxyConfig::default()).unwrap();
        let mock_server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/upload"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "content_uri": "mxc://matrix.org/enc" })),
            )
            .expect(1)
            .mount(&mock_server)
            .await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("plain.bin");
        std::fs::write(&path, b"secret media").unwrap();

        let result =
            upload_matrix_encrypted_media(super::super::types::MatrixEncryptedMediaUploadRequest {
                upload_url: format!("{}/upload", mock_server.uri()),
                headers: None,
                source_url: None,
                local_path: Some(path.to_string_lossy().into_owned()),
                content_type: Some("application/octet-stream".to_string()),
            })
            .await
            .unwrap();

        assert_eq!(result.content_uri, "mxc://matrix.org/enc");
        assert_eq!(result.file["url"], "mxc://matrix.org/enc");
        assert!(result.file.get("key").is_some());
        assert!(result.file.get("hashes").is_some());
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
            multipart: None,
            response_mode: None,
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
            multipart: None,
            response_mode: None,
        };
        let err = read_source_bytes(&req, 8).await.unwrap_err();
        assert!(err.contains("upload cap"), "got: {err}");
    }

    #[tokio::test]
    async fn read_source_bytes_rejects_oversized_remote_body() {
        proxy_config::apply_current(proxy_config::ProxyConfig::default()).unwrap();
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
            multipart: None,
            response_mode: None,
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
            multipart: None,
            response_mode: None,
        };
        let bytes = read_source_bytes(&req, 1024).await.unwrap();
        assert_eq!(bytes.as_ref(), &[1u8, 2, 3]);
    }
}

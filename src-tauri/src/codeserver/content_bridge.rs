//! Raw companion transport for broker content handles.
//!
//! The headless Node brain and cognia-server are separate processes. Binary
//! provider values cross their loopback HTTPS boundary as raw bodies, never as
//! base64/JSON arrays, then enter the generation- and permission-bound content
//! handle store.

use axum::body::{to_bytes, Body};
use axum::extract::{Extension, Path, Request};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::Deserialize;

const MAX_CONTENT_BYTES: usize = 64 * 1024 * 1024;
const CONTEXT_HEADER: &str = "x-cognia-content-context";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContentContext {
    root: String,
    generation: u64,
    plugin_id: String,
    provider_id: String,
    permission: Option<String>,
    media_type: Option<String>,
}

// Axum owns the concrete response layout; retaining it here avoids rebuilding
// or erasing the already-complete HTTP error response.
#[allow(clippy::result_large_err)]
fn context(headers: &HeaderMap) -> Result<ContentContext, Response> {
    let encoded = headers
        .get(CONTEXT_HEADER)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| (StatusCode::BAD_REQUEST, "missing content context").into_response())?;
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| (StatusCode::BAD_REQUEST, "invalid content context").into_response())?;
    serde_json::from_slice(&bytes)
        .map_err(|_| (StatusCode::BAD_REQUEST, "invalid content context").into_response())
}

#[allow(clippy::result_large_err)]
fn require_service(
    identity: &crate::companion_api::middleware::DeviceContext,
) -> Result<(), Response> {
    if identity.scope == "service" {
        Ok(())
    } else {
        Err((StatusCode::FORBIDDEN, "service token required").into_response())
    }
}

pub async fn upload_content(
    Extension(identity): Extension<crate::companion_api::middleware::DeviceContext>,
    headers: HeaderMap,
    request: Request,
) -> Response {
    if let Err(response) = require_service(&identity) {
        return response;
    }
    let context = match context(&headers) {
        Ok(context) => context,
        Err(response) => return response,
    };
    let bytes = match to_bytes(request.into_body(), MAX_CONTENT_BYTES).await {
        Ok(bytes) => bytes,
        Err(_) => return (StatusCode::PAYLOAD_TOO_LARGE, "content exceeds limit").into_response(),
    };
    match crate::codeserver::agent_channel::global().create_content_handle(
        &context.root,
        context.generation,
        &context.plugin_id,
        &context.provider_id,
        context.permission,
        context
            .media_type
            .unwrap_or_else(|| "application/octet-stream".to_string()),
        bytes.to_vec(),
    ) {
        Ok(handle) => axum::Json(handle).into_response(),
        Err(error) => (StatusCode::CONFLICT, error).into_response(),
    }
}

pub async fn redeem_content(
    Extension(identity): Extension<crate::companion_api::middleware::DeviceContext>,
    Path(handle_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = require_service(&identity) {
        return response;
    }
    let context = match context(&headers) {
        Ok(context) => context,
        Err(response) => return response,
    };
    match crate::codeserver::agent_channel::global().redeem_content_handle(
        &context.root,
        context.generation,
        &context.plugin_id,
        &context.provider_id,
        context.permission.as_deref(),
        &handle_id,
    ) {
        Ok(bytes) => {
            let media_type = context
                .media_type
                .as_deref()
                .unwrap_or("application/octet-stream");
            let mut response = Response::new(Body::from(bytes));
            response.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_str(media_type)
                    .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
            );
            response
        }
        Err(error) => (StatusCode::NOT_FOUND, error).into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_context_is_header_encoded_and_typed() {
        let value = serde_json::json!({
            "root": "/workspace",
            "generation": 7,
            "pluginId": "demo",
            "providerId": "cognia.demo.fs",
            "permission": "filesystem:read",
            "mediaType": "application/octet-stream"
        });
        let mut headers = HeaderMap::new();
        headers.insert(
            CONTEXT_HEADER,
            HeaderValue::from_str(&URL_SAFE_NO_PAD.encode(value.to_string())).unwrap(),
        );
        let parsed = context(&headers).unwrap();
        assert_eq!(parsed.root, "/workspace");
        assert_eq!(parsed.generation, 7);
        assert_eq!(parsed.plugin_id, "demo");
    }

    #[test]
    fn malformed_context_fails_before_content_allocation() {
        let mut headers = HeaderMap::new();
        headers.insert(CONTEXT_HEADER, HeaderValue::from_static("%%%"));
        assert_eq!(
            context(&headers).unwrap_err().status(),
            StatusCode::BAD_REQUEST
        );
    }
}

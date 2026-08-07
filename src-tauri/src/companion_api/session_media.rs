//! Authenticated, session-scoped binary media reads for transcript V1.

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use serde::Deserialize;

use super::{data_plane::DataPlane, SharedState};

const MAX_MEDIA_BYTES: usize = 10 * 1024 * 1024;

#[derive(Debug, Deserialize)]
pub struct MediaQuery {
    #[serde(default = "canonical_variant")]
    variant: String,
}

fn canonical_variant() -> String {
    "canonical".to_string()
}

fn valid_request(session_id: &str, hash: &str, variant: &str) -> bool {
    !session_id.is_empty()
        && session_id.len() <= 512
        && hash.len() == 64
        && hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        && matches!(variant, "thumbnail" | "canonical" | "original")
}

pub async fn session_media_handler(
    Path((session_id, hash)): Path<(String, String)>,
    Query(query): Query<MediaQuery>,
    State(state): State<SharedState>,
) -> Response {
    if !valid_request(&session_id, &hash, &query.variant) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let Some(data_plane) = DataPlane::pick(&state) else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let media = match data_plane
        .session_media(session_id, hash, query.variant)
        .await
    {
        Ok(media) => media,
        Err(error) if error == "MEDIA_NOT_FOUND" => return StatusCode::NOT_FOUND.into_response(),
        Err(error) if error == "INVALID_PARAMS" => return StatusCode::BAD_REQUEST.into_response(),
        Err(_) => return StatusCode::SERVICE_UNAVAILABLE.into_response(),
    };
    if media.bytes.len() > MAX_MEDIA_BYTES {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    }

    let mut response = Response::new(Body::from(media.bytes));
    *response.status_mut() = StatusCode::OK;
    let headers = response.headers_mut();
    if let Ok(value) = HeaderValue::from_str(&media.media_type) {
        headers.insert(header::CONTENT_TYPE, value);
    }
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=31536000, immutable"),
    );
    if let Some(etag) = media
        .etag
        .and_then(|value| HeaderValue::from_str(&value).ok())
    {
        headers.insert(header::ETAG, etag);
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_hash_variant_and_session_bounds() {
        assert!(valid_request("s1", &"a".repeat(64), "thumbnail"));
        assert!(valid_request("s1", &"0".repeat(64), "canonical"));
        assert!(!valid_request("", &"a".repeat(64), "canonical"));
        assert!(!valid_request("s1", "short", "canonical"));
        assert!(!valid_request("s1", &"A".repeat(64), "canonical"));
        assert!(!valid_request("s1", &"a".repeat(64), "other"));
    }
}

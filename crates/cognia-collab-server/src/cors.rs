//! Cross-origin access for browsers.
//!
//! The web app is served from one origin (Caddy, `https://<domain>`) and this
//! service answers on another unless the operator proxies it under the same
//! front door. A browser sends `Authorization` on every call here, so every
//! call is preflighted, and without an explicit allow-list the first thing a
//! signed-in person sees is a network error on `GET /v1/account/memberships`.
//!
//! The list is exact origins, never a wildcard: a grant in the `Authorization`
//! header is a bearer credential, and a wildcard would let any page that
//! obtained one use it from anywhere.

use std::time::Duration;

use axum::http::{header, HeaderValue, Method};
use tower_http::cors::{AllowOrigin, CorsLayer};

/// Parse `COLLAB_ALLOWED_ORIGINS`: comma or whitespace separated, each an
/// `http(s)` origin with nothing after the authority. Anything else is
/// dropped and reported, never widened into a match.
pub fn parse_allowed_origins(raw: Option<&str>) -> (Vec<HeaderValue>, Vec<String>) {
    let mut accepted: Vec<HeaderValue> = Vec::new();
    let mut rejected: Vec<String> = Vec::new();
    for entry in raw
        .unwrap_or_default()
        .split(|character: char| character == ',' || character.is_whitespace())
    {
        let entry = entry.trim().trim_end_matches('/');
        if entry.is_empty() {
            continue;
        }
        match normalize_origin(entry) {
            Some(origin) => {
                if let Ok(value) = HeaderValue::from_str(&origin) {
                    if !accepted.iter().any(|existing| existing == &value) {
                        accepted.push(value);
                    }
                }
            }
            None => rejected.push(entry.to_owned()),
        }
    }
    (accepted, rejected)
}

/// `scheme://host[:port]`, scheme and host lower-cased, or `None`.
fn normalize_origin(value: &str) -> Option<String> {
    let (scheme, rest) = value.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return None;
    }
    if rest.is_empty()
        || rest.contains('/')
        || rest.contains('?')
        || rest.contains('#')
        || rest.contains('@')
        || rest.contains(char::is_whitespace)
    {
        return None;
    }
    let (host, port) = match rest.rsplit_once(':') {
        Some((host, port)) if !host.contains(':') || host.starts_with('[') => {
            if port.is_empty() || !port.bytes().all(|byte| byte.is_ascii_digit()) {
                return None;
            }
            (host, Some(port))
        }
        _ => (rest, None),
    };
    if host.is_empty() {
        return None;
    }
    let host = host.to_ascii_lowercase();
    Some(match port {
        Some(port) => format!("{scheme}://{host}:{port}"),
        None => format!("{scheme}://{host}"),
    })
}

/// The layer for an allow-list, or `None` when there is nothing to allow.
/// Same-origin deployments and non-browser clients never need one.
pub fn cors_layer(origins: &[HeaderValue]) -> Option<CorsLayer> {
    if origins.is_empty() {
        return None;
    }
    Some(
        CorsLayer::new()
            .allow_origin(AllowOrigin::list(origins.iter().cloned()))
            .allow_methods([
                Method::GET,
                Method::POST,
                Method::PATCH,
                Method::PUT,
                Method::DELETE,
                Method::OPTIONS,
            ])
            .allow_headers([
                header::AUTHORIZATION,
                header::CONTENT_TYPE,
                header::HeaderName::from_static("x-cognia-reason"),
                header::HeaderName::from_static("x-cognia-collab-protocol"),
                header::HeaderName::from_static("x-cognia-run-token"),
                header::HeaderName::from_static("x-cognia-attachment-ticket"),
            ])
            .expose_headers([header::ETAG, header::LOCATION])
            .max_age(Duration::from_secs(600)),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins_are_exact_lower_cased_and_deduplicated() {
        let (accepted, rejected) = parse_allowed_origins(Some(
            " https://App.Example.com/, https://app.example.com ,http://localhost:3000\nhttps://[::1]:8443",
        ));
        let accepted: Vec<&str> = accepted
            .iter()
            .map(|value| value.to_str().unwrap())
            .collect();
        assert_eq!(
            accepted,
            [
                "https://app.example.com",
                "http://localhost:3000",
                "https://[::1]:8443"
            ]
        );
        assert!(rejected.is_empty());
    }

    #[test]
    fn anything_that_is_not_an_origin_is_rejected_not_widened() {
        let (accepted, rejected) = parse_allowed_origins(Some(
            "*, app.example.com, https://app.example.com/path, https://a?x=1, ftp://a, https://user@a, https://a:notaport",
        ));
        assert!(accepted.is_empty());
        assert_eq!(rejected.len(), 7);
        assert_eq!(parse_allowed_origins(None), (vec![], vec![]));
        assert_eq!(parse_allowed_origins(Some(" , ")), (vec![], vec![]));
    }

    #[test]
    fn no_origins_means_no_layer() {
        assert!(cors_layer(&[]).is_none());
        let (accepted, _) = parse_allowed_origins(Some("https://app.example.com"));
        assert!(cors_layer(&accepted).is_some());
    }
}

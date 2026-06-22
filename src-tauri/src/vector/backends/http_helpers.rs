//! Shared HTTP client utilities for cloud vector backends.

use std::time::Duration;

use reqwest::{Client, StatusCode};

use crate::vector::error::{Result, VectorError};

const MAX_UPSTREAM_ERROR_BODY_CHARS: usize = 512;
const TRUNCATED_BODY_SUFFIX: &str = "... (truncated)";

pub fn build_client(default_headers: Option<reqwest::header::HeaderMap>) -> Result<Client> {
    let mut builder = Client::builder()
        .timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(10))
        .user_agent(concat!("cognia-next/", env!("CARGO_PKG_VERSION")));
    if let Some(h) = default_headers {
        builder = builder.default_headers(h);
    }
    builder.build().map_err(|e| VectorError::Http {
        status: 0,
        message: format!("client build: {e}"),
    })
}

pub fn http_err(status: StatusCode, body: &str) -> VectorError {
    let body = sanitize_upstream_error_body(body);
    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        VectorError::Auth(format!("{} from upstream: {body}", status.as_u16()))
    } else if status == StatusCode::NOT_FOUND {
        VectorError::NotFound(body)
    } else {
        VectorError::Http {
            status: status.as_u16(),
            message: body,
        }
    }
}

fn sanitize_upstream_error_body(body: &str) -> String {
    let mut normalized = String::new();
    let mut emitted = 0usize;
    let mut truncated = false;

    for ch in body.chars() {
        if emitted >= MAX_UPSTREAM_ERROR_BODY_CHARS {
            truncated = true;
            break;
        }

        let ch = if ch.is_control() || ch.is_whitespace() {
            ' '
        } else {
            ch
        };

        if ch == ' ' && (normalized.is_empty() || normalized.ends_with(' ')) {
            continue;
        }

        normalized.push(ch);
        emitted += 1;
    }

    if truncated {
        normalized.truncate(normalized.trim_end().len());
        normalized.push_str(TRUNCATED_BODY_SUFFIX);
    } else {
        normalized.truncate(normalized.trim_end().len());
    }

    normalized
}

pub async fn read_body(resp: reqwest::Response) -> Result<String> {
    resp.text().await.map_err(|e| VectorError::Http {
        status: 0,
        message: format!("read body: {e}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_errors_use_bounded_upstream_body() {
        let body = format!("bad key\n{}", "x".repeat(1_200));

        let err = http_err(StatusCode::UNAUTHORIZED, &body);

        let VectorError::Auth(message) = err else {
            panic!("expected auth error");
        };
        assert!(message.starts_with("401 from upstream: bad key"));
        assert!(message.ends_with("... (truncated)"));
        assert!(!message.contains('\n'));
        assert!(message.len() < 700);
    }

    #[test]
    fn http_errors_strip_control_characters() {
        let err = http_err(
            StatusCode::INTERNAL_SERVER_ERROR,
            "failed\u{0}\u{1f}\nretry\tlater",
        );

        let VectorError::Http { message, .. } = err else {
            panic!("expected http error");
        };
        assert_eq!(message, "failed retry later");
    }
}

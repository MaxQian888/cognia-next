//! Shared HTTP client utilities for cloud vector backends.

use std::time::Duration;

use reqwest::{Client, StatusCode};

use crate::vector::error::{Result, VectorError};

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
    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        VectorError::Auth(format!("{} from upstream: {body}", status.as_u16()))
    } else if status == StatusCode::NOT_FOUND {
        VectorError::NotFound(body.to_string())
    } else {
        VectorError::Http {
            status: status.as_u16(),
            message: body.to_string(),
        }
    }
}

pub async fn read_body(resp: reqwest::Response) -> Result<String> {
    resp.text().await.map_err(|e| VectorError::Http {
        status: 0,
        message: format!("read body: {e}"),
    })
}

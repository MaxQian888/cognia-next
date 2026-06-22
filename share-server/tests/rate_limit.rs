//! Per-IP rate-limiting integration test — the abuse control the Worker leans
//! on Cloudflare for, here enforced in-process.

mod common;

use common::start_with;
use reqwest::{Client, StatusCode};

#[tokio::test]
async fn per_ip_rate_limit_returns_429_after_burst() {
    // Burst of 2, slow refill — three quick requests trip the limit.
    let (base, _dir) = start_with(|c| {
        c.rate_burst = 2;
        c.rate_per_sec = 1;
    })
    .await;
    let client = Client::new();

    // The first two are admitted (the code is unknown, so 404 — but admitted),
    // the third is rate-limited before any work.
    let s1 = client
        .get(format!("{base}/v1/share/x"))
        .send()
        .await
        .unwrap()
        .status();
    let s2 = client
        .get(format!("{base}/v1/share/x"))
        .send()
        .await
        .unwrap()
        .status();
    let s3 = client
        .get(format!("{base}/v1/share/x"))
        .send()
        .await
        .unwrap()
        .status();

    assert_eq!(s1, StatusCode::NOT_FOUND);
    assert_eq!(s2, StatusCode::NOT_FOUND);
    assert_eq!(s3, StatusCode::TOO_MANY_REQUESTS);
}

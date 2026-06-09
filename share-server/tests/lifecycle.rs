//! End-to-end lifecycle tests: max-views, burn-after-read, stats, delete.

mod common;

use common::{start, valid_envelope, SECRET};
use reqwest::{Client, StatusCode};
use serde_json::{json, Value};

async fn create(client: &Client, base: &str, body: Value) -> String {
    let res = client
        .post(format!("{base}/v1/share"))
        .bearer_auth(SECRET)
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::CREATED);
    let created: Value = res.json().await.unwrap();
    created["code"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn max_views_self_destructs_after_n_reads() {
    let (base, _dir) = start().await;
    let client = Client::new();
    let code = create(
        &client,
        &base,
        json!({ "envelope": valid_envelope(), "maxViews": 2 }),
    )
    .await;

    for _ in 0..2 {
        let res = client.get(format!("{base}/v1/share/{code}")).send().await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
    }
    // Third read — already burned.
    let res = client.get(format!("{base}/v1/share/{code}")).send().await.unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn burn_after_read_destroys_on_first_view() {
    let (base, _dir) = start().await;
    let client = Client::new();
    let code = create(
        &client,
        &base,
        json!({ "envelope": valid_envelope(), "burnAfterRead": true }),
    )
    .await;

    let res = client.get(format!("{base}/v1/share/{code}")).send().await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let res = client.get(format!("{base}/v1/share/{code}")).send().await.unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn stats_reports_view_count_for_owner_only() {
    let (base, _dir) = start().await;
    let client = Client::new();
    let code = create(
        &client,
        &base,
        json!({ "envelope": valid_envelope(), "maxViews": 5 }),
    )
    .await;

    // One read bumps the counter.
    client.get(format!("{base}/v1/share/{code}")).send().await.unwrap();

    // Owner stats with bearer.
    let res = client
        .get(format!("{base}/v1/share/{code}/stats"))
        .bearer_auth(SECRET)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let stats: Value = res.json().await.unwrap();
    assert_eq!(stats["viewCount"], 1);
    assert_eq!(stats["maxViews"], 5);
    assert_eq!(stats["revoked"], false);

    // Stats without bearer is unauthorized.
    let res = client
        .get(format!("{base}/v1/share/{code}/stats"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn delete_revokes_and_requires_bearer() {
    let (base, _dir) = start().await;
    let client = Client::new();
    let code = create(&client, &base, json!({ "envelope": valid_envelope() })).await;

    // Delete without bearer is rejected.
    let res = client.delete(format!("{base}/v1/share/{code}")).send().await.unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);

    // Delete with bearer succeeds (204).
    let res = client
        .delete(format!("{base}/v1/share/{code}"))
        .bearer_auth(SECRET)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NO_CONTENT);

    // Subsequent read is gone.
    let res = client.get(format!("{base}/v1/share/{code}")).send().await.unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

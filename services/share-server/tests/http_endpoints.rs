//! End-to-end HTTP contract tests against a real server + SQLite, asserting the
//! self-hosted service matches the Cloudflare Worker's observable behavior.

mod common;

use common::{start, start_with, valid_envelope, SECRET};
use reqwest::{Client, Method, StatusCode};
use serde_json::{json, Value};
use std::time::{SystemTime, UNIX_EPOCH};

#[tokio::test]
async fn create_then_read_round_trips_the_envelope() {
    let (base, _dir) = start().await;
    let client = Client::new();

    let envelope = valid_envelope();
    let res = client
        .post(format!("{base}/v1/share"))
        .bearer_auth(SECRET)
        .json(&json!({ "envelope": envelope }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::CREATED);
    let created: Value = res.json().await.unwrap();
    let code = created["code"].as_str().expect("code").to_string();
    assert_eq!(code.len(), 12);
    let owner_token = created["ownerToken"].as_str().expect("ownerToken");
    assert_eq!(owner_token.len(), 64);
    assert!(owner_token
        .chars()
        .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    assert!(
        created["expiresAt"].as_i64().unwrap() > 0,
        "no ttl is clamped to the max ttl"
    );

    let res = client
        .get(format!("{base}/v1/share/{code}"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(
        res.headers()
            .get("cache-control")
            .and_then(|v| v.to_str().ok()),
        Some("no-store")
    );
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["envelope"], envelope);
}

#[tokio::test]
async fn create_requires_bearer() {
    let (base, _dir) = start().await;
    let client = Client::new();

    // No bearer.
    let res = client
        .post(format!("{base}/v1/share"))
        .json(&json!({ "envelope": valid_envelope() }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);

    // Wrong bearer.
    let res = client
        .post(format!("{base}/v1/share"))
        .bearer_auth("nope")
        .json(&json!({ "envelope": valid_envelope() }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn create_rejects_invalid_json_and_envelope() {
    let (base, _dir) = start().await;
    let client = Client::new();

    // Malformed JSON.
    let res = client
        .post(format!("{base}/v1/share"))
        .bearer_auth(SECRET)
        .header("content-type", "application/json")
        .body("{not json")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);

    // Valid JSON, bad envelope shape.
    let res = client
        .post(format!("{base}/v1/share"))
        .bearer_auth(SECRET)
        .json(&json!({ "envelope": { "v": 2, "alg": "RSA" } }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn create_returns_expires_at_when_ttl_set() {
    let (base, _dir) = start().await;
    let client = Client::new();
    let res = client
        .post(format!("{base}/v1/share"))
        .bearer_auth(SECRET)
        .json(&json!({ "envelope": valid_envelope(), "ttlSeconds": 3600 }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::CREATED);
    let created: Value = res.json().await.unwrap();
    assert!(created["expiresAt"].as_i64().unwrap() > 0);
}

#[tokio::test]
async fn create_clamps_ttl_to_configured_hard_ceiling() {
    let (base, _dir) = start_with(|c| c.max_ttl_seconds = 60).await;
    let client = Client::new();
    let before = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let res = client
        .post(format!("{base}/v1/share"))
        .bearer_auth(SECRET)
        .json(&json!({ "envelope": valid_envelope(), "ttlSeconds": 3600 }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::CREATED);
    let created: Value = res.json().await.unwrap();
    let expires_at = created["expiresAt"].as_i64().unwrap();
    let delta_ms = expires_at - before;
    assert!(
        (1..=61_000).contains(&delta_ms),
        "expected ttl to be clamped near 60s, got {delta_ms}ms"
    );
}

#[tokio::test]
async fn read_unknown_code_is_not_found() {
    let (base, _dir) = start().await;
    let client = Client::new();
    let res = client
        .get(format!("{base}/v1/share/doesnotexist"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn oversized_body_is_rejected() {
    let (base, _dir) = start_with(|c| c.max_body_bytes = 50).await;
    let client = Client::new();
    let res = client
        .post(format!("{base}/v1/share"))
        .bearer_auth(SECRET)
        .json(&json!({ "envelope": valid_envelope() }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn options_preflight_returns_cors() {
    let (base, _dir) = start().await;
    let client = Client::new();
    let res = client
        .request(Method::OPTIONS, format!("{base}/v1/share"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        res.headers()
            .get("access-control-allow-origin")
            .and_then(|v| v.to_str().ok()),
        Some("*")
    );
    assert_eq!(
        res.headers()
            .get("access-control-allow-methods")
            .and_then(|v| v.to_str().ok()),
        Some("GET, POST, PATCH, DELETE, OPTIONS")
    );
    let allow_headers = res
        .headers()
        .get("access-control-allow-headers")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    assert!(
        allow_headers
            .split(',')
            .map(|header| header.trim().to_ascii_lowercase())
            .any(|header| header == "x-owner-token"),
        "preflight headers must allow owner-token lifecycle requests: {allow_headers}"
    );
}

#[tokio::test]
async fn unsupported_method_on_code_path_is_405() {
    let (base, _dir) = start().await;
    let client = Client::new();
    let res = client
        .put(format!("{base}/v1/share/abc"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::METHOD_NOT_ALLOWED);
}

#[tokio::test]
async fn non_v1_path_is_404() {
    let (base, _dir) = start().await;
    let client = Client::new();
    let res = client
        .get(format!("{base}/share/view"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn healthz_and_metrics_have_expected_shape() {
    let (base, _dir) = start().await;
    let client = Client::new();

    let res = client.get(format!("{base}/healthz")).send().await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let v: Value = res.json().await.unwrap();
    assert_eq!(v["ok"], true);
    assert_eq!(v["shares"], 0);
    assert!(v["version"].is_string());

    let res = client.get(format!("{base}/metrics")).send().await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let ct = res
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    assert!(ct.starts_with("text/plain"), "content-type: {ct}");
    let body = res.text().await.unwrap();
    assert!(body.contains("share_created_total"));
    assert!(body.contains("share_active 0"));
}

#[tokio::test]
async fn renewal_preserves_content_and_views_and_clamps_ttl() {
    let (base, _dir) = start_with(|c| c.max_ttl_seconds = 60).await;
    let client = Client::new();
    let created: Value = client
        .post(format!("{base}/v1/share"))
        .bearer_auth(SECRET)
        .json(&json!({ "envelope": valid_envelope(), "ttlSeconds": 10, "maxViews": 3 }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let url = format!("{base}/v1/share/{}", created["code"].as_str().unwrap());
    assert_eq!(
        client.get(&url).send().await.unwrap().status(),
        StatusCode::OK
    );
    let before = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let response = client
        .patch(&url)
        .header("x-owner-token", created["ownerToken"].as_str().unwrap())
        .json(&json!({ "ttlSeconds": 3600 }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let renewed: Value = response.json().await.unwrap();
    let expires_at = renewed["expiresAt"].as_i64().unwrap();
    assert!((60_000..=61_000).contains(&(expires_at - before)));
    assert!(expires_at > created["expiresAt"].as_i64().unwrap());
    let stats: Value = client
        .get(format!("{url}/stats"))
        .header("x-owner-token", created["ownerToken"].as_str().unwrap())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(stats["viewCount"], 1);
    assert_eq!(stats["maxViews"], 3);
    assert_eq!(stats["expiresAt"], expires_at);
    let read: Value = client.get(&url).send().await.unwrap().json().await.unwrap();
    assert_eq!(read["envelope"], valid_envelope());
}

#[tokio::test]
async fn renewal_requires_owner_and_valid_positive_ttl() {
    let (base, _dir) = start().await;
    let client = Client::new();
    let created: Value = client
        .post(format!("{base}/v1/share"))
        .bearer_auth(SECRET)
        .json(&json!({ "envelope": valid_envelope() }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let url = format!("{base}/v1/share/{}", created["code"].as_str().unwrap());
    for credential in ["", SECRET] {
        let response = client
            .patch(&url)
            .bearer_auth(credential)
            .json(&json!({ "ttlSeconds": 60 }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
    for body in [
        "{}",
        "null",
        "[]",
        r#"{"ttlSeconds":0}"#,
        r#"{"ttlSeconds":-1}"#,
        r#"{"ttlSeconds":"60"}"#,
    ] {
        let response = client
            .patch(&url)
            .header("x-owner-token", created["ownerToken"].as_str().unwrap())
            .body(body)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(
            response.json::<Value>().await.unwrap()["error"],
            "ttlSeconds required"
        );
    }
    let response = client
        .patch(&url)
        .header("x-owner-token", created["ownerToken"].as_str().unwrap())
        .body("{invalid")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        response.json::<Value>().await.unwrap()["error"],
        "invalid json"
    );
}

#[tokio::test]
async fn renewal_uses_existing_org_authorization() {
    let (base, _dir) = start().await;
    let client = Client::new();
    let grant = common::grant_for("org_owner");
    let created: Value = client
        .post(format!("{base}/v1/share"))
        .bearer_auth(&grant)
        .json(&json!({ "envelope": valid_envelope() }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let url = format!("{base}/v1/share/{}", created["code"].as_str().unwrap());
    let response = client
        .patch(&url)
        .bearer_auth(common::grant_for("org_other"))
        .json(&json!({ "ttlSeconds": 60 }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let response = client
        .patch(&url)
        .bearer_auth(grant)
        .json(&json!({ "ttlSeconds": 60 }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn renewal_cannot_restore_deleted_burned_or_expired_shares() {
    let (base, dir) = start().await;
    let client = Client::new();
    for lifecycle in ["deleted", "burned", "expired"] {
        let created: Value = client
            .post(format!("{base}/v1/share"))
            .bearer_auth(SECRET)
            .json(&json!({ "envelope": valid_envelope(), "burnAfterRead": lifecycle == "burned" }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let code = created["code"].as_str().unwrap();
        let url = format!("{base}/v1/share/{code}");
        let owner = created["ownerToken"].as_str().unwrap();
        match lifecycle {
            "deleted" => {
                assert_eq!(
                    client
                        .delete(&url)
                        .header("x-owner-token", owner)
                        .send()
                        .await
                        .unwrap()
                        .status(),
                    StatusCode::NO_CONTENT
                );
            }
            "burned" => {
                assert_eq!(
                    client.get(&url).send().await.unwrap().status(),
                    StatusCode::OK
                );
            }
            _ => {
                let conn = rusqlite::Connection::open(dir.path().join("shares.sqlite")).unwrap();
                conn.execute("UPDATE shares SET expires_at = 1 WHERE code = ?1", [code])
                    .unwrap();
            }
        }
        assert_eq!(
            client
                .patch(&url)
                .header("x-owner-token", owner)
                .json(&json!({ "ttlSeconds": 60 }))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND,
            "{lifecycle}"
        );
        assert_eq!(
            client.get(&url).send().await.unwrap().status(),
            StatusCode::NOT_FOUND
        );
    }
}

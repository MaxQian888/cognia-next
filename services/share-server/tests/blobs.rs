//! End-to-end tests for ADR-0222 file blobs: chunk upload, commit, ticketed
//! download, and how each lifecycle gate reaches a share's files.

mod common;

use common::{grant_for, start, valid_envelope, SECRET};
use reqwest::{Client, StatusCode};
use serde_json::{json, Value};

const BLOB: &str = "AAAAAAAAAAAAAAAAAAAAAA";
const CHUNK: usize = 4 * 1024 * 1024 + 16;

struct Created {
    code: String,
    owner_token: String,
}

async fn create(client: &Client, base: &str, body: Value) -> Created {
    let res = client
        .post(format!("{base}/v1/share"))
        .bearer_auth(SECRET)
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::CREATED);
    let created: Value = res.json().await.unwrap();
    Created {
        code: created["code"].as_str().unwrap().to_string(),
        owner_token: created["ownerToken"].as_str().unwrap().to_string(),
    }
}

async fn put_chunk(
    client: &Client,
    base: &str,
    share: &Created,
    blob: &str,
    index: &str,
    bytes: Vec<u8>,
) -> StatusCode {
    client
        .put(format!(
            "{base}/v1/share/{}/blobs/{blob}/{index}",
            share.code
        ))
        .header("X-Owner-Token", &share.owner_token)
        .body(bytes)
        .send()
        .await
        .unwrap()
        .status()
}

async fn commit(
    client: &Client,
    base: &str,
    share: &Created,
    blob: &str,
    body: Value,
) -> StatusCode {
    client
        .post(format!(
            "{base}/v1/share/{}/blobs/{blob}/commit",
            share.code
        ))
        .header("X-Owner-Token", &share.owner_token)
        .json(&body)
        .send()
        .await
        .unwrap()
        .status()
}

/// Read the envelope (spending a view) and return the read ticket.
async fn read_ticket(client: &Client, base: &str, code: &str) -> (String, i64) {
    let res = client
        .get(format!("{base}/v1/share/{code}"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["envelope"], valid_envelope());
    (
        body["readTicket"].as_str().unwrap().to_string(),
        body["readTicketExpiresAt"].as_i64().unwrap(),
    )
}

async fn get_chunk(
    client: &Client,
    base: &str,
    code: &str,
    index: &str,
    ticket: Option<&str>,
) -> (StatusCode, Vec<u8>) {
    let mut request = client.get(format!("{base}/v1/share/{code}/blobs/{BLOB}/{index}"));
    if let Some(ticket) = ticket {
        request = request.header("X-Read-Ticket", ticket);
    }
    let res = request.send().await.unwrap();
    let status = res.status();
    (status, res.bytes().await.unwrap().to_vec())
}

async fn upload_two_chunks(client: &Client, base: &str, share: &Created) {
    assert_eq!(
        put_chunk(client, base, share, BLOB, "0", vec![1u8; CHUNK]).await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        put_chunk(client, base, share, BLOB, "1", vec![2u8; 100]).await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        commit(
            client,
            base,
            share,
            BLOB,
            json!({ "chunkCount": 2, "totalBytes": CHUNK + 100 })
        )
        .await,
        StatusCode::OK
    );
}

#[tokio::test]
async fn files_round_trip_without_spending_views() {
    let (base, _dir) = start().await;
    let client = Client::new();
    let share = create(
        &client,
        &base,
        json!({ "envelope": valid_envelope(), "maxViews": 2 }),
    )
    .await;
    upload_two_chunks(&client, &base, &share).await;

    let (ticket, expires_at) = read_ticket(&client, &base, &share.code).await;
    assert!(expires_at > 0);
    for _ in 0..3 {
        let (status, bytes) = get_chunk(&client, &base, &share.code, "0", Some(&ticket)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(bytes, vec![1u8; CHUNK]);
    }
    let (status, bytes) = get_chunk(&client, &base, &share.code, "1", Some(&ticket)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(bytes, vec![2u8; 100]);

    // Downloads did not count: one view is still left.
    let stats: Value = client
        .get(format!("{base}/v1/share/{}/stats", share.code))
        .header("X-Owner-Token", &share.owner_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(stats["viewCount"], 1);
}

#[tokio::test]
async fn downloads_need_a_ticket_for_this_share() {
    let (base, _dir) = start().await;
    let client = Client::new();
    let share = create(&client, &base, json!({ "envelope": valid_envelope() })).await;
    upload_two_chunks(&client, &base, &share).await;
    let other = create(&client, &base, json!({ "envelope": valid_envelope() })).await;
    let (other_ticket, _) = read_ticket(&client, &base, &other.code).await;

    let (status, _) = get_chunk(&client, &base, &share.code, "0", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = get_chunk(&client, &base, &share.code, "0", Some(&other_ticket)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = get_chunk(&client, &base, &share.code, "0", Some("1.forged")).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn a_burned_share_s_files_outlive_its_last_view() {
    let (base, _dir) = start().await;
    let client = Client::new();
    let share = create(
        &client,
        &base,
        json!({ "envelope": valid_envelope(), "burnAfterRead": true }),
    )
    .await;
    upload_two_chunks(&client, &base, &share).await;
    let (ticket, _) = read_ticket(&client, &base, &share.code).await;

    // The envelope is gone…
    let res = client
        .get(format!("{base}/v1/share/{}", share.code))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
    // …the files are still reachable with the ticket that view issued.
    let (status, bytes) = get_chunk(&client, &base, &share.code, "1", Some(&ticket)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(bytes, vec![2u8; 100]);
}

#[tokio::test]
async fn revoking_stops_downloads_a_ticket_would_allow() {
    let (base, _dir) = start().await;
    let client = Client::new();
    let share = create(&client, &base, json!({ "envelope": valid_envelope() })).await;
    upload_two_chunks(&client, &base, &share).await;
    let (ticket, _) = read_ticket(&client, &base, &share.code).await;
    let res = client
        .delete(format!("{base}/v1/share/{}", share.code))
        .header("X-Owner-Token", &share.owner_token)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NO_CONTENT);
    let (status, _) = get_chunk(&client, &base, &share.code, "0", Some(&ticket)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn an_org_revocation_reaches_files_too() {
    let (base, _dir) = start().await;
    let client = Client::new();
    let res = client
        .post(format!("{base}/v1/share"))
        .bearer_auth(grant_for("org_acme"))
        .json(&json!({ "envelope": valid_envelope() }))
        .send()
        .await
        .unwrap();
    let created: Value = res.json().await.unwrap();
    let share = Created {
        code: created["code"].as_str().unwrap().to_string(),
        owner_token: created["ownerToken"].as_str().unwrap().to_string(),
    };
    upload_two_chunks(&client, &base, &share).await;
    let (ticket, _) = read_ticket(&client, &base, &share.code).await;
    let res = client
        .delete(format!("{base}/v1/orgs/org_acme/shares/{}", share.code))
        .bearer_auth(grant_for("org_acme"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let (status, _) = get_chunk(&client, &base, &share.code, "0", Some(&ticket)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn uploads_need_the_owner() {
    let (base, _dir) = start().await;
    let client = Client::new();
    let share = create(&client, &base, json!({ "envelope": valid_envelope() })).await;
    let stranger = Created {
        code: share.code.clone(),
        owner_token: "0".repeat(64),
    };
    assert_eq!(
        put_chunk(&client, &base, &stranger, BLOB, "0", vec![1u8; 40]).await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        commit(
            &client,
            &base,
            &stranger,
            BLOB,
            json!({ "chunkCount": 1, "totalBytes": 40 })
        )
        .await,
        StatusCode::UNAUTHORIZED
    );
    // The upload secret does not stand in for a share's own owner token.
    let res = client
        .put(format!("{base}/v1/share/{}/blobs/{BLOB}/0", share.code))
        .bearer_auth(SECRET)
        .body(vec![1u8; 40])
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    let missing = Created {
        code: "NoSuchCode12".into(),
        owner_token: share.owner_token.clone(),
    };
    assert_eq!(
        put_chunk(&client, &base, &missing, BLOB, "0", vec![1u8; 40]).await,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn malformed_blob_requests_are_refused() {
    let (base, _dir) = start().await;
    let client = Client::new();
    let share = create(&client, &base, json!({ "envelope": valid_envelope() })).await;
    for (blob, index) in [("short", "0"), (BLOB, "128"), (BLOB, "01"), (BLOB, "x")] {
        assert_eq!(
            put_chunk(&client, &base, &share, blob, index, vec![1u8; 40]).await,
            StatusCode::BAD_REQUEST,
            "{blob}/{index}"
        );
    }
    assert_eq!(
        put_chunk(&client, &base, &share, BLOB, "0", vec![1u8; 16]).await,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        put_chunk(&client, &base, &share, BLOB, "0", vec![1u8; CHUNK + 1]).await,
        StatusCode::PAYLOAD_TOO_LARGE
    );
    assert_eq!(
        commit(&client, &base, &share, BLOB, json!({ "chunkCount": 1 })).await,
        StatusCode::BAD_REQUEST
    );
    // Committing what was never uploaded is a 404; a short declaration a 400.
    assert_eq!(
        commit(
            &client,
            &base,
            &share,
            BLOB,
            json!({ "chunkCount": 1, "totalBytes": 40 })
        )
        .await,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        put_chunk(&client, &base, &share, BLOB, "0", vec![1u8; 40]).await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        commit(
            &client,
            &base,
            &share,
            BLOB,
            json!({ "chunkCount": 2, "totalBytes": 40 })
        )
        .await,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        commit(
            &client,
            &base,
            &share,
            BLOB,
            json!({ "chunkCount": 1, "totalBytes": 40 })
        )
        .await,
        StatusCode::OK
    );
    assert_eq!(
        put_chunk(&client, &base, &share, BLOB, "0", vec![1u8; 40]).await,
        StatusCode::CONFLICT
    );
    assert_eq!(
        commit(
            &client,
            &base,
            &share,
            BLOB,
            json!({ "chunkCount": 1, "totalBytes": 41 })
        )
        .await,
        StatusCode::CONFLICT
    );
}

#[tokio::test]
async fn an_uncommitted_blob_is_not_served() {
    let (base, _dir) = start().await;
    let client = Client::new();
    let share = create(&client, &base, json!({ "envelope": valid_envelope() })).await;
    assert_eq!(
        put_chunk(&client, &base, &share, BLOB, "0", vec![1u8; 40]).await,
        StatusCode::NO_CONTENT
    );
    let (ticket, _) = read_ticket(&client, &base, &share.code).await;
    let (status, _) = get_chunk(&client, &base, &share.code, "0", Some(&ticket)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_chunk_larger_than_the_envelope_cap_is_still_accepted() {
    // Envelope bodies are capped by SHARE_MAX_BODY_BYTES; chunks are not.
    let (base, _dir) = common::start_with(|config| config.max_body_bytes = 1024).await;
    let client = Client::new();
    let share = create(&client, &base, json!({ "envelope": valid_envelope() })).await;
    assert_eq!(
        put_chunk(&client, &base, &share, BLOB, "0", vec![1u8; CHUNK]).await,
        StatusCode::NO_CONTENT
    );
}

#[tokio::test]
async fn blob_routes_answer_preflight_and_refuse_other_methods() {
    let (base, _dir) = start().await;
    let client = Client::new();
    let res = client
        .request(
            reqwest::Method::OPTIONS,
            format!("{base}/v1/share/abc/blobs/{BLOB}/0"),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NO_CONTENT);
    let res = client
        .delete(format!("{base}/v1/share/abc/blobs/{BLOB}/0"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::METHOD_NOT_ALLOWED);
    let res = client
        .get(format!("{base}/v1/share/abc/blobs/{BLOB}/commit"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::METHOD_NOT_ALLOWED);
}

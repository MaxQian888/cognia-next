use axum::body::{to_bytes, Body};
use axum::http::{header, Request, StatusCode};
use chrono::{Duration, Utc};
use cognia_ops_controller::{
    router, AppState, CertificateIssuer, InMemoryStore, IssuedCertificate, OperationSigner,
    TestAuthenticator,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tower::ServiceExt;

fn app() -> axum::Router {
    let store = Arc::new(InMemoryStore::default());
    router(AppState::new(store, Arc::new(TestAuthenticator)))
}

struct FakeCertificateIssuer;

impl CertificateIssuer for FakeCertificateIssuer {
    fn issue(
        &self,
        agent_id: &str,
        target_id: &str,
        _csr_pem: &str,
    ) -> anyhow::Result<IssuedCertificate> {
        Ok(IssuedCertificate {
            certificate_pem: format!("certificate:{agent_id}:{target_id}"),
            ca_certificate_pem: "test-ca".into(),
            fingerprint_sha256: format!("fingerprint-{agent_id}-{target_id}"),
            expires_at: Utc::now() + Duration::hours(24),
        })
    }
}

fn app_with_certificate_issuer() -> axum::Router {
    router(
        AppState::new(
            Arc::new(InMemoryStore::default()),
            Arc::new(TestAuthenticator),
        )
        .with_certificate_issuer(Arc::new(FakeCertificateIssuer))
        .with_operation_signer(
            OperationSigner::from_base64(
                "test-controller".into(),
                &base64::Engine::encode(&base64::engine::general_purpose::STANDARD, [5_u8; 32]),
            )
            .expect("signer"),
        ),
    )
}

async fn send(request: Request<Body>) -> (StatusCode, Value) {
    let response = app().oneshot(request).await.expect("router response");
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1024 * 1024)
        .await
        .expect("body");
    let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, value)
}

fn request(method: &str, path: &str, token: &str, body: Value) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(path)
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .expect("request")
}

#[tokio::test]
async fn read_routes_require_read_scope_and_isolate_tenants() {
    let (status, body) = send(request("GET", "/v1/servers", "tenant-a:none", json!({}))).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["code"], "insufficient_scope");

    let (status, body) = send(request(
        "GET",
        "/v1/servers",
        "tenant-a:servers:read",
        json!({}),
    ))
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["items"], json!([]));
}

#[tokio::test]
async fn mutations_require_and_replay_the_same_idempotency_key() {
    let request_without_key = request(
        "POST",
        "/v1/servers/server-1/backups",
        "tenant-a:servers:operate",
        json!({}),
    );
    let (status, body) = send(request_without_key).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["code"], "idempotency_key_required");

    let make_request = || {
        let mut request = request(
            "POST",
            "/v1/servers/server-1/backups",
            "tenant-a:servers:operate",
            json!({}),
        );
        request.headers_mut().insert(
            "idempotency-key",
            "backup-2026-08-01".parse().expect("header"),
        );
        request
    };

    let application = app();
    let first = application
        .clone()
        .oneshot(make_request())
        .await
        .expect("first response");
    let first_body: Value = serde_json::from_slice(
        &to_bytes(first.into_body(), 1024 * 1024)
            .await
            .expect("body"),
    )
    .expect("json");
    let second = application
        .oneshot(make_request())
        .await
        .expect("second response");
    let second_body: Value = serde_json::from_slice(
        &to_bytes(second.into_body(), 1024 * 1024)
            .await
            .expect("body"),
    )
    .expect("json");

    assert_eq!(first_body["id"], second_body["id"]);
    assert_eq!(first_body["state"], "queued");
}

#[tokio::test]
async fn restore_requires_a_user_and_operation_bound_admin_lease() {
    let mut missing_lease = request(
        "POST",
        "/v1/servers/server-1/restore",
        "tenant-a:servers:operate,servers:admin",
        json!({ "recoveryPointId": "rp-1" }),
    );
    missing_lease
        .headers_mut()
        .insert("idempotency-key", "restore-1".parse().expect("header"));
    let (status, body) = send(missing_lease).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["code"], "admin_lease_required");
}

#[tokio::test]
async fn admin_lease_is_bound_to_user_target_operation_and_idempotent_replay() {
    let application = app();
    let lease_request = request(
        "POST",
        "/v1/admin-leases",
        "tenant-a:servers:admin",
        json!({ "targetId": "server-1", "operation": "restore", "ttlSeconds": 60 }),
    );
    let lease_response = application
        .clone()
        .oneshot(lease_request)
        .await
        .expect("lease response");
    assert_eq!(lease_response.status(), StatusCode::OK);
    let lease: Value = serde_json::from_slice(
        &to_bytes(lease_response.into_body(), 1024 * 1024)
            .await
            .expect("lease body"),
    )
    .expect("lease json");

    let restore_request = || {
        let mut request = request(
            "POST",
            "/v1/servers/server-1/restore",
            "tenant-a:servers:operate,servers:admin",
            json!({ "recoveryPointId": "rp-1" }),
        );
        request.headers_mut().insert(
            "idempotency-key",
            "restore-with-lease".parse().expect("header"),
        );
        request.headers_mut().insert(
            "x-admin-lease",
            lease["token"]
                .as_str()
                .expect("lease token")
                .parse()
                .expect("header"),
        );
        request
    };
    let first = application
        .clone()
        .oneshot(restore_request())
        .await
        .expect("first restore");
    assert_eq!(first.status(), StatusCode::ACCEPTED);
    let first_body: Value = serde_json::from_slice(
        &to_bytes(first.into_body(), 1024 * 1024)
            .await
            .expect("first body"),
    )
    .expect("first json");

    let replay = application
        .oneshot(restore_request())
        .await
        .expect("restore replay");
    assert_eq!(replay.status(), StatusCode::ACCEPTED);
    let replay_body: Value = serde_json::from_slice(
        &to_bytes(replay.into_body(), 1024 * 1024)
            .await
            .expect("replay body"),
    )
    .expect("replay json");
    assert_eq!(first_body["id"], replay_body["id"]);
}

#[tokio::test]
async fn reusing_an_idempotency_key_for_a_different_mutation_is_rejected() {
    let application = app();
    let make_request = |path: &str| {
        let mut request = request("POST", path, "tenant-a:servers:operate", json!({}));
        request
            .headers_mut()
            .insert("idempotency-key", "same-key".parse().expect("header"));
        request
    };
    let first = application
        .clone()
        .oneshot(make_request("/v1/servers/server-1/backups"))
        .await
        .expect("first mutation");
    assert_eq!(first.status(), StatusCode::ACCEPTED);

    let conflict = application
        .oneshot(make_request("/v1/servers/server-1/upgrade"))
        .await
        .expect("conflict response");
    assert_eq!(conflict.status(), StatusCode::CONFLICT);
    let body: Value = serde_json::from_slice(
        &to_bytes(conflict.into_body(), 1024 * 1024)
            .await
            .expect("body"),
    )
    .expect("json");
    assert_eq!(body["code"], "idempotency_conflict");
}

#[tokio::test]
async fn target_validation_rejects_unknown_fields() {
    let mut validate = request(
        "POST",
        "/v1/targets/validate",
        "tenant-a:servers:operate",
        json!({
            "apiVersion": "deploy.cognia.dev/v1alpha1",
            "kind": "DeploymentTarget",
            "metadata": { "id": "staging", "label": "Staging", "secret": "nope" },
            "spec": {}
        }),
    );
    validate
        .headers_mut()
        .insert("idempotency-key", "validate-1".parse().expect("header"));
    let (status, body) = send(validate).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["code"], "invalid_deployment_target");
}

#[tokio::test]
async fn enrollment_token_is_single_use_and_returns_a_target_bound_certificate() {
    let application = app_with_certificate_issuer();
    let mut token_request = request(
        "POST",
        "/v1/agents/enrollment-tokens",
        "tenant-a:servers:admin",
        json!({ "targetId": "staging", "ttlSeconds": 300 }),
    );
    token_request
        .headers_mut()
        .insert("idempotency-key", "enroll-token-1".parse().expect("header"));
    let token_response = application
        .clone()
        .oneshot(token_request)
        .await
        .expect("token response");
    assert_eq!(token_response.status(), StatusCode::OK);
    let token: Value = serde_json::from_slice(
        &to_bytes(token_response.into_body(), 1024 * 1024)
            .await
            .expect("token body"),
    )
    .expect("token json");

    let enroll_request = || {
        Request::builder()
            .method("POST")
            .uri("/v1/agents/enroll")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                json!({
                    "token": token["token"],
                    "agentId": "agent-1",
                    "csrPem": "test-csr"
                })
                .to_string(),
            ))
            .expect("enrollment request")
    };
    let enrolled = application
        .clone()
        .oneshot(enroll_request())
        .await
        .expect("enrollment response");
    assert_eq!(enrolled.status(), StatusCode::OK);
    let certificate: Value = serde_json::from_slice(
        &to_bytes(enrolled.into_body(), 1024 * 1024)
            .await
            .expect("certificate body"),
    )
    .expect("certificate json");
    assert_eq!(certificate["targetId"], "staging");
    assert_eq!(certificate["certificatePem"], "certificate:agent-1:staging");

    let replay = application
        .oneshot(enroll_request())
        .await
        .expect("replay response");
    assert_eq!(replay.status(), StatusCode::UNAUTHORIZED);
}

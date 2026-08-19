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
async fn rollback_rejects_client_selected_release_targets() {
    let mut rollback = request(
        "POST",
        "/v1/servers/server-1/rollback",
        "tenant-a:servers:operate,servers:admin",
        json!({ "releaseDigest": "sha256:client-controlled" }),
    );
    rollback
        .headers_mut()
        .insert("idempotency-key", "rollback-1".parse().expect("header"));
    let (status, body) = send(rollback).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["code"], "invalid_rollback_request");
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
async fn target_registration_is_idempotent_and_immediately_queryable() {
    let application = app();
    let target = json!({
        "apiVersion": "deploy.cognia.dev/v1alpha1",
        "kind": "DeploymentTarget",
        "metadata": { "id": "staging", "label": "Staging" },
        "spec": {
            "topology": "kubernetes",
            "publicUrl": "https://server.example.com",
            "kubernetes": {
                "namespace": "cognia-staging",
                "ingressClassName": "nginx",
                "storageClassName": "standard-rwo",
                "runtimeClassName": "gvisor"
            },
            "controller": {
                "url": "https://ops.example.com",
                "credentialRef": "ops-controller/staging"
            },
            "identity": {
                "provider": "oidc",
                "issuer": "https://auth.example.com/oidc",
                "audience": "https://server.example.com/api",
                "tenantClaim": "organization_id",
                "scopes": {
                    "read": "servers:read",
                    "operate": "servers:operate",
                    "admin": "servers:admin"
                }
            },
            "objectStore": {
                "provider": "s3-compatible",
                "endpoint": "https://s3.example.com",
                "region": "auto",
                "bucket": "cognia-backups",
                "pathStyle": false,
                "credentialRef": "backups/staging"
            },
            "snapshots": { "provider": "kubernetes-csi", "className": "cognia-snapshots" },
            "tls": { "provider": "ingress", "secretRef": "cognia-server-tls" },
            "secrets": { "provider": "kubernetes", "rootRef": "cognia/staging" },
            "images": {
                "server": format!("server@sha256:{}", "a".repeat(64)),
                "runner": format!("runner@sha256:{}", "b".repeat(64)),
                "workspaceRuntime": format!("runtime@sha256:{}", "c".repeat(64))
            }
        }
    });
    let register = |body: Value| {
        let mut request = request(
            "POST",
            "/v1/targets",
            "tenant-a:servers:operate,servers:read",
            body,
        );
        request.headers_mut().insert(
            "idempotency-key",
            "register-staging".parse().expect("header"),
        );
        request
    };

    let first = application
        .clone()
        .oneshot(register(target.clone()))
        .await
        .expect("register target");
    assert_eq!(first.status(), StatusCode::CREATED);
    let body: Value = serde_json::from_slice(
        &to_bytes(first.into_body(), 1024 * 1024)
            .await
            .expect("target body"),
    )
    .expect("target json");
    assert_eq!(body["id"], "staging");
    assert_eq!(body["targetRevision"], 1);

    let replay = application
        .clone()
        .oneshot(register(target.clone()))
        .await
        .expect("replay target");
    assert_eq!(replay.status(), StatusCode::CREATED);

    let mut changed = target;
    changed["metadata"]["label"] = json!("Changed");
    let conflict = application
        .clone()
        .oneshot(register(changed))
        .await
        .expect("conflicting target");
    assert_eq!(conflict.status(), StatusCode::CONFLICT);

    let listed = application
        .clone()
        .oneshot(request(
            "GET",
            "/v1/servers",
            "tenant-a:servers:read",
            json!({}),
        ))
        .await
        .expect("list servers");
    let body: Value = serde_json::from_slice(
        &to_bytes(listed.into_body(), 1024 * 1024)
            .await
            .expect("list body"),
    )
    .expect("list json");
    assert_eq!(body["items"][0]["id"], "staging");

    let mut deploy = request(
        "POST",
        "/v1/servers/staging/deploy",
        "tenant-a:servers:operate",
        json!({
            "targetRevision": 1,
            "release": {
                "serverImage": format!("server@sha256:{}", "a".repeat(64)),
                "runnerImage": format!("runner@sha256:{}", "b".repeat(64)),
                "workspaceRuntimeImage": format!("runtime@sha256:{}", "c".repeat(64)),
                "configRevision": "1"
            }
        }),
    );
    deploy
        .headers_mut()
        .insert("idempotency-key", "deploy-staging".parse().expect("header"));
    let deployed = application
        .oneshot(deploy)
        .await
        .expect("queue target deployment");
    assert_eq!(deployed.status(), StatusCode::ACCEPTED);
    let operation: Value = serde_json::from_slice(
        &to_bytes(deployed.into_body(), 1024 * 1024)
            .await
            .expect("operation body"),
    )
    .expect("operation json");
    assert_eq!(operation["targetId"], "staging");
    assert_eq!(operation["kind"], "deploy");
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

/// The staging target every operation test below needs registered first.
fn staging_target() -> Value {
    json!({
        "apiVersion": "deploy.cognia.dev/v1alpha1",
        "kind": "DeploymentTarget",
        "metadata": { "id": "staging", "label": "Staging" },
        "spec": {
            "topology": "kubernetes",
            "publicUrl": "https://server.example.com",
            "kubernetes": {
                "namespace": "cognia-staging",
                "ingressClassName": "nginx",
                "storageClassName": "standard-rwo",
                "runtimeClassName": "gvisor"
            },
            "controller": {
                "url": "https://ops.example.com",
                "credentialRef": "ops-controller/staging"
            },
            "identity": {
                "provider": "oidc",
                "issuer": "https://auth.example.com/oidc",
                "audience": "https://server.example.com/api",
                "tenantClaim": "organization_id",
                "scopes": {
                    "read": "servers:read",
                    "operate": "servers:operate",
                    "admin": "servers:admin"
                }
            },
            "objectStore": {
                "provider": "s3-compatible",
                "endpoint": "https://s3.example.com",
                "region": "auto",
                "bucket": "cognia-backups",
                "pathStyle": false,
                "credentialRef": "backups/staging"
            },
            "snapshots": { "provider": "kubernetes-csi", "className": "cognia-snapshots" },
            "tls": { "provider": "ingress", "secretRef": "cognia-server-tls" },
            "secrets": { "provider": "kubernetes", "rootRef": "cognia/staging" },
            "images": {
                "server": format!("server@sha256:{}", "a".repeat(64)),
                "runner": format!("runner@sha256:{}", "b".repeat(64)),
                "workspaceRuntime": format!("runtime@sha256:{}", "c".repeat(64))
            }
        }
    })
}

fn keyed(method: &str, path: &str, token: &str, body: Value, key: &str) -> Request<Body> {
    let mut request = request(method, path, token, body);
    request
        .headers_mut()
        .insert("idempotency-key", key.parse().expect("header"));
    request
}

async fn json_body(response: axum::response::Response) -> Value {
    let bytes = to_bytes(response.into_body(), 1024 * 1024)
        .await
        .expect("body");
    serde_json::from_slice(&bytes).unwrap_or(Value::Null)
}

async fn app_with_staging() -> axum::Router {
    let application = app();
    let registered = application
        .clone()
        .oneshot(keyed(
            "POST",
            "/v1/targets",
            "tenant-a:servers:operate,servers:read",
            staging_target(),
            "register-staging",
        ))
        .await
        .expect("register target");
    assert_eq!(registered.status(), StatusCode::CREATED);
    application
}

#[tokio::test]
async fn preflight_is_derived_from_the_registered_target() {
    let application = app_with_staging().await;

    // The revision and topology come from the stored target, so a tab that
    // never reloaded cannot preflight a configuration that no longer exists.
    let queued = application
        .clone()
        .oneshot(keyed(
            "POST",
            "/v1/servers/staging/preflight",
            "tenant-a:servers:operate",
            json!({}),
            "preflight-1",
        ))
        .await
        .expect("queue preflight");
    assert_eq!(queued.status(), StatusCode::ACCEPTED);
    let operation = json_body(queued).await;
    assert_eq!(operation["kind"], "preflight");
    assert_eq!(operation["request"]["targetRevision"], 1);
    assert_eq!(operation["request"]["topology"], "kubernetes");

    // A client-supplied revision is refused rather than quietly ignored.
    let rejected = application
        .clone()
        .oneshot(keyed(
            "POST",
            "/v1/servers/staging/preflight",
            "tenant-a:servers:operate",
            json!({ "targetRevision": 99 }),
            "preflight-2",
        ))
        .await
        .expect("reject preflight parameters");
    assert_eq!(rejected.status(), StatusCode::BAD_REQUEST);
    assert_eq!(json_body(rejected).await["code"], "invalid_preflight_request");

    let missing = application
        .oneshot(keyed(
            "POST",
            "/v1/servers/absent/preflight",
            "tenant-a:servers:operate",
            json!({}),
            "preflight-3",
        ))
        .await
        .expect("preflight an unknown target");
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn collection_operations_queue_with_agent_defaults() {
    let application = app_with_staging().await;

    for (path, kind, key) in [
        ("collect-status", "collect-status", "collect-status-1"),
        ("collect-logs", "collect-logs", "collect-logs-1"),
    ] {
        // An empty body is the documented shape: the agent fills in its own
        // defaults (`includeRuntimeUsage: false`, `limit: 200`), so the UI does
        // not have to know them.
        let queued = application
            .clone()
            .oneshot(keyed(
                "POST",
                &format!("/v1/servers/staging/{path}"),
                "tenant-a:servers:operate",
                json!({}),
                key,
            ))
            .await
            .expect("queue collection operation");
        assert_eq!(queued.status(), StatusCode::ACCEPTED);
        let operation = json_body(queued).await;
        assert_eq!(operation["kind"], kind);
        assert_eq!(operation["state"], "queued");
    }
}

#[tokio::test]
async fn cancel_applies_only_to_a_queued_operation() {
    let application = app_with_staging().await;

    let queued = application
        .clone()
        .oneshot(keyed(
            "POST",
            "/v1/servers/staging/backups",
            "tenant-a:servers:operate",
            json!({}),
            "backup-to-cancel",
        ))
        .await
        .expect("queue backup");
    let operation = json_body(queued).await;
    let operation_id = operation["id"].as_str().expect("operation id").to_owned();

    let cancelled = application
        .clone()
        .oneshot(keyed(
            "POST",
            &format!("/v1/operations/{operation_id}/cancel"),
            "tenant-a:servers:operate",
            json!({}),
            "cancel-1",
        ))
        .await
        .expect("cancel the queued backup");
    assert_eq!(cancelled.status(), StatusCode::OK);
    assert_eq!(json_body(cancelled).await["state"], "cancelled");

    // Cancelling twice is a conflict, not a silent success: the second caller
    // must not be told it stopped work that had already stopped for another
    // reason.
    let again = application
        .clone()
        .oneshot(keyed(
            "POST",
            &format!("/v1/operations/{operation_id}/cancel"),
            "tenant-a:servers:operate",
            json!({}),
            "cancel-2",
        ))
        .await
        .expect("cancel twice");
    assert_eq!(again.status(), StatusCode::CONFLICT);
    assert_eq!(
        json_body(again).await["code"],
        "operation_not_cancellable"
    );

    let unknown = application
        .clone()
        .oneshot(keyed(
            "POST",
            "/v1/operations/00000000-0000-4000-8000-000000000000/cancel",
            "tenant-a:servers:operate",
            json!({}),
            "cancel-3",
        ))
        .await
        .expect("cancel an unknown operation");
    assert_eq!(unknown.status(), StatusCode::NOT_FOUND);

    // Another tenant's operation is invisible, not merely unauthorized.
    let cross_tenant = application
        .oneshot(keyed(
            "POST",
            &format!("/v1/operations/{operation_id}/cancel"),
            "tenant-b:servers:operate",
            json!({}),
            "cancel-4",
        ))
        .await
        .expect("cancel across tenants");
    assert_eq!(cross_tenant.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn cancel_requires_operate_scope_and_an_idempotency_key() {
    let application = app_with_staging().await;
    let id = "00000000-0000-4000-8000-000000000000";

    let (status, body) = send(keyed(
        "POST",
        &format!("/v1/operations/{id}/cancel"),
        "tenant-a:servers:read",
        json!({}),
        "cancel-scope",
    ))
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["code"], "insufficient_scope");

    let no_key = application
        .oneshot(request(
            "POST",
            &format!("/v1/operations/{id}/cancel"),
            "tenant-a:servers:operate",
            json!({}),
        ))
        .await
        .expect("cancel without a key");
    assert_eq!(no_key.status(), StatusCode::BAD_REQUEST);
}

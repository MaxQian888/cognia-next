//! Public health / discovery endpoint.
//!
//! `GET /healthz` is the unauthenticated diagnostic mobile clients
//! use to:
//!   1. confirm the server is reachable at all (vs "wrong port", "TLS
//!      rejected", "fingerprint mismatch"),
//!   2. cross-check the TLS SPKI fingerprint against the one pinned in
//!      a paired-device record (cert-rotation detection),
//!   3. learn what port the server believes it is advertising on (helpful
//!      when the mobile client probes a list of likely ports).
//!
//! # Why no auth?
//!
//! The endpoint is read-only and reveals only:
//!   * `version` — already exposed via the QR pair payload,
//!   * `fingerprint` — already exposed in every TLS handshake,
//!   * `advertised_port` — derivable from a successful TCP connect,
//!   * `server_id` — 16 bytes of HMAC-style installation identifier derived
//!     from the signing secret; same identifier across cert rotations so
//!     the mobile can distinguish "same desktop, fresh cert" (legitimate
//!     dev rebuild) from "different desktop" (mid-pair MITM).
//!
//! None of these enable mutation, exfiltrate user data, or reveal the
//! signing secret itself.

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use sha2::{Digest, Sha256};

use super::{advertised_port, tls_fingerprint, SharedState};

pub async fn livez_handler() -> Response {
    (
        StatusCode::OK,
        Json(json!({
            "status": "live",
            "version": env!("CARGO_PKG_VERSION"),
        })),
    )
        .into_response()
}

const EXPECTED_CONFIG_REVISION_HEADER: &str = "x-cognia-expected-config-revision";

pub async fn readyz_handler(State(_state): State<SharedState>, headers: HeaderMap) -> Response {
    let accepting_writes = super::server::is_accepting_writes();
    let actual_revision = std::env::var("COGNIA_CONFIG_REVISION").ok();
    let expected_revision = headers
        .get(EXPECTED_CONFIG_REVISION_HEADER)
        .and_then(|value| value.to_str().ok());
    let revision_ready = config_revision_matches(expected_revision, actual_revision.as_deref());
    let contract_ready = super::command_manifest::headless_contract().is_ok();
    let mut checks = json!({
        "draining": !accepting_writes,
        "acceptingWrites": accepting_writes,
        "storage": true,
        "brain": true,
        "sidecar": true,
        "gateway": true,
        "configRevision": revision_ready,
        "headlessContract": contract_ready,
    });
    let mut ready = accepting_writes && revision_ready && contract_ready;
    if let Some(services) = super::runtime::headless() {
        let storage_ready = super::data_plane::headless_store().is_some();
        let brain_required = std::env::var_os(super::runtime::BRAIN_ENTRY_ENV).is_some();
        let brain_ready =
            !brain_required || super::runtime::brain_status().is_some_and(|status| status.ready);
        let sidecar_ready = services.sidecar_ready().await;
        let gateway_required = services.gateway_enabled()
            || std::env::var("COGNIA_GATEWAY").is_ok_and(|value| value == "1" || value == "true");
        let gateway_ready = !gateway_required || services.gateway_running();
        ready &= storage_ready && brain_ready && sidecar_ready && gateway_ready;
        checks = json!({
            "draining": !accepting_writes,
            "acceptingWrites": accepting_writes,
            "storage": storage_ready,
            "brain": brain_ready,
            "sidecar": sidecar_ready,
            "gateway": gateway_ready,
            "configRevision": revision_ready,
            "headlessContract": contract_ready,
        });
    }
    let runtime_health = super::ws_bridge::brain_runtime_health();
    ready &= runtime_health.required_ready();
    checks["bootstrapped"] = json!(runtime_health.bootstrapped != Some(false));
    checks["requiredRuntimes"] = json!(runtime_health.required_ready());
    checks["failedRequiredRuntimes"] = json!(runtime_health.failed_required);
    checks["restartingRequiredRuntimes"] = json!(runtime_health.restarting_required);
    let status = if ready {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    let mut body = json!({
        "status": if ready { "ready" } else { "not_ready" },
        "configRevision": actual_revision,
        "checks": checks,
    });
    // A refused brain is not "still starting": the server and brain come from
    // different builds and will not converge by waiting (ADR-0224 A10).
    if let Some(refusal) = super::ws_bridge::brain_refusal() {
        body["brainRefusal"] = serde_json::to_value(refusal).unwrap_or_default();
    }
    // Preserve the legacy failure list; only required failures block readiness.
    let failed_runtimes = runtime_health.failed;
    if !failed_runtimes.is_empty() {
        body["degraded"] = json!(true);
        body["failedRuntimes"] = json!(failed_runtimes);
    }
    (status, Json(body)).into_response()
}

fn config_revision_matches(expected: Option<&str>, actual: Option<&str>) -> bool {
    expected.is_none_or(|expected| actual == Some(expected))
}

/// `GET /healthz` handler.
///
/// On a headless `cognia-server` (ADR-0059 R8) the payload additionally
/// carries `brain` and `sidecar` supervision blocks so orchestrators and the
/// tier-2 smoke can see the full process tree's health. Both keys are absent
/// on desktop (no headless services installed).
pub async fn healthz_handler(State(state): State<SharedState>) -> Response {
    let secret = state.secret.read().clone();
    let server_id = derive_server_id(&secret);
    let mut payload = json!({
        "version": env!("CARGO_PKG_VERSION"),
        "fingerprint": tls_fingerprint(),
        "advertised_port": advertised_port(),
        "server_id": server_id,
    });
    if let Ok(contract) = super::command_manifest::headless_contract() {
        payload["headlessContract"] = json!({
            "schemaVersion": contract.schema_version(),
            "catalogHash": contract.catalog_hash(),
            "commandCount": contract.command_count(),
            "enforced": super::command_manifest::headless_contract_enforced(),
        });
    } else {
        payload["headlessContract"] = json!({ "available": false });
    }
    if let Some(services) = super::runtime::headless() {
        let obj = payload.as_object_mut().expect("payload is an object");
        // `brain` reports the supervisor when one is installed; a headless
        // server booted without a brain entry reports `configured: false`.
        obj.insert(
            "brain".to_string(),
            match super::runtime::brain_status() {
                Some(status) => {
                    let mut b = serde_json::to_value(status).unwrap_or_else(|_| json!({}));
                    if let Some(map) = b.as_object_mut() {
                        map.insert("configured".to_string(), json!(true));
                    }
                    b
                }
                None => json!({ "configured": false }),
            },
        );
        obj.insert(
            "sidecar".to_string(),
            json!({
                "ready": services.sidecar_ready().await,
                "restart_count": services.sidecar_restart_count(),
            }),
        );
        // ADR-0090 Phase 2 — headless LLM Gateway health.
        obj.insert("gateway".to_string(), services.gateway_health());
        // ADR-0059 W2 — the brain's headless runtimes that failed to start.
        let runtime_health = super::ws_bridge::brain_runtime_health();
        let warnings: Vec<&str> = runtime_health
            .failed
            .iter()
            .filter_map(|name| match name.as_str() {
                "backup-scheduler" => Some("scheduled_backups_unavailable"),
                "storage-retention" => Some("storage_cleanup_unavailable_disk_may_fill"),
                _ => None,
            })
            .collect();
        obj.insert(
            "runtimes".to_string(),
            json!({
                "degraded": !runtime_health.failed.is_empty(),
                "ready": runtime_health.required_ready(),
                "bootstrapped": runtime_health.bootstrapped,
                "failed": runtime_health.failed,
                "failedRequired": runtime_health.failed_required,
                "restartingRequired": runtime_health.restarting_required,
                "warnings": warnings,
            }),
        );
    }
    (StatusCode::OK, Json(payload)).into_response()
}

/// Derive a stable, opaque installation identifier from the signing
/// secret. SHA-256(secret) truncated to 16 bytes, hex-encoded → 32 chars.
///
/// Pure function so it can be reused by tests without the keyring.
pub fn derive_server_id(secret: &[u8]) -> String {
    let digest = Sha256::digest(secret);
    hex::encode(&digest[..16])
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        deny_list::DenyList, desktop_messages_bridge::DesktopMessagesBridge,
        desktop_writes_bridge::DesktopWritesBridge, event_bus::EventBus,
        idempotency::IdempotencyCache, push::PushTokenRegistry, rate_limit::RateLimiter,
        sync_bridge::SyncBridge, sync_registry::SyncTableRegistry, CompanionState, SharedState,
    };
    use axum::{body::Body, http::Request, routing::get, Router};
    use parking_lot::RwLock;
    use std::sync::Arc;
    use tower::ServiceExt as _;

    const SECRET: &[u8] = b"test-secret-32-bytes-exactly____";

    fn test_state() -> SharedState {
        Arc::new(CompanionState {
            secret: RwLock::new(SECRET.to_vec()),
            deny_list: Arc::new(DenyList::new()),
            renderer: None,
            runtime: crate::runtime::unwired(),
            idempotency: Arc::new(IdempotencyCache::new()),
            event_bus: EventBus::new(),
            sync_bridge: SyncBridge::new(),
            desktop_messages_bridge: DesktopMessagesBridge::new(),
            desktop_writes_bridge: DesktopWritesBridge::new(),
            sync_registry: SyncTableRegistry::with_defaults(),
            rate_limiter: RateLimiter::with_defaults(),
            push_tokens: PushTokenRegistry::new(),
        })
    }

    fn build_router(state: SharedState) -> Router {
        Router::new()
            .route("/healthz", get(healthz_handler))
            .route("/livez", get(livez_handler))
            .route("/readyz", get(readyz_handler))
            .with_state(state)
    }

    async fn body_json(resp: axum::response::Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("body bytes");
        serde_json::from_slice(&bytes).expect("json parse")
    }

    #[test]
    fn server_id_is_stable_for_same_secret() {
        let id1 = derive_server_id(SECRET);
        let id2 = derive_server_id(SECRET);
        assert_eq!(id1, id2);
        assert_eq!(id1.len(), 32, "hex-encoded 16 bytes → 32 chars");
    }

    #[test]
    fn server_id_changes_with_secret() {
        let alt = b"different-secret-32-bytes-____ab";
        assert_ne!(derive_server_id(SECRET), derive_server_id(alt));
    }

    #[test]
    fn server_id_does_not_reveal_secret() {
        // Trivially: server_id is 32 hex chars (128 bits) vs the 32-byte
        // (256-bit) secret. The mapping is one-way (sha256 truncation).
        // The strict guarantee is sha256's preimage resistance; here we
        // only smoke-test that the hex output never contains the raw
        // secret bytes as a substring of any reasonable encoding.
        let id = derive_server_id(SECRET);
        let hex_secret = hex::encode(SECRET);
        assert!(!hex_secret.contains(&id));
    }

    #[test]
    fn strict_readiness_requires_the_expected_config_revision() {
        assert!(config_revision_matches(None, None));
        assert!(config_revision_matches(
            Some("revision-7"),
            Some("revision-7")
        ));
        assert!(!config_revision_matches(Some("revision-7"), None));
        assert!(!config_revision_matches(
            Some("revision-7"),
            Some("revision-6")
        ));
    }

    #[tokio::test]
    async fn healthz_returns_200_with_expected_fields() {
        let router = build_router(test_state());
        let req = Request::builder()
            .method("GET")
            .uri("/healthz")
            .body(Body::empty())
            .unwrap();
        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(resp.status().as_u16(), 200);
        let body = body_json(resp).await;
        assert!(body["version"].is_string(), "version is string");
        assert!(body["fingerprint"].is_string(), "fingerprint is string");
        assert!(
            body["advertised_port"].is_number(),
            "advertised_port is number"
        );
        let sid = body["server_id"].as_str().expect("server_id is string");
        assert_eq!(sid, derive_server_id(SECRET));
    }

    /// Desktop shape: no headless services installed → no brain/sidecar keys.
    /// Headless shape: both keys present (ADR-0059 R8).
    #[tokio::test]
    async fn healthz_gains_brain_and_sidecar_blocks_only_when_headless() {
        // The headless-services slot is process-global; serialize on the same
        // lock the other global-slot tests use.
        let _guard = crate::ws_bridge::test_support::lock_slot().await;
        crate::runtime::test_support::clear_headless();

        let router = build_router(test_state());
        let req = Request::builder()
            .method("GET")
            .uri("/healthz")
            .body(Body::empty())
            .unwrap();
        let resp = router.oneshot(req).await.unwrap();
        let body = body_json(resp).await;
        assert!(body.get("brain").is_none(), "desktop must not report brain");
        assert!(
            body.get("sidecar").is_none(),
            "desktop must not report sidecar"
        );
        assert!(
            body.get("runtimes").is_none(),
            "desktop has no headless runtimes"
        );

        crate::runtime::test_support::install_fake_headless();
        let router = build_router(test_state());
        let req = Request::builder()
            .method("GET")
            .uri("/healthz")
            .body(Body::empty())
            .unwrap();
        let resp = router.oneshot(req).await.unwrap();
        let body = body_json(resp).await;
        assert_eq!(
            body["brain"]["configured"], false,
            "no brain supervisor installed in this test"
        );
        assert_eq!(body["sidecar"]["ready"], false);
        assert!(body["sidecar"]["restart_count"].is_number());
        assert_eq!(body["runtimes"]["degraded"], false);
        assert_eq!(body["runtimes"]["ready"], true);
        assert_eq!(body["runtimes"]["failed"], json!([]));

        crate::runtime::test_support::clear_headless();
    }

    #[tokio::test]
    async fn healthz_does_not_require_authorization_header() {
        // Build a router with NO middleware applied — the public route is
        // intentionally outside `require_device_jwt`. We assert the
        // handler itself succeeds on a plain GET with no headers.
        let router = build_router(test_state());
        let req = Request::builder()
            .method("GET")
            .uri("/healthz")
            .body(Body::empty())
            .unwrap();
        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(resp.status().as_u16(), 200);
    }

    #[tokio::test]
    async fn livez_and_readyz_are_distinct_probe_contracts() {
        struct DrainingReset;

        impl Drop for DrainingReset {
            fn drop(&mut self) {
                crate::server::set_draining_for_test(false);
            }
        }

        let _guard = crate::ws_bridge::test_support::lock_slot().await;
        let _reset = DrainingReset;
        crate::server::set_draining_for_test(false);
        let router = build_router(test_state());
        let live = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/livez")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(live.status(), StatusCode::OK);
        assert_eq!(body_json(live).await["status"], "live");

        let ready = router
            .oneshot(
                Request::builder()
                    .uri("/readyz")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(ready.status(), StatusCode::OK);
        let ready_body = body_json(ready).await;
        assert_eq!(ready_body["status"], "ready");
        assert_eq!(ready_body["checks"]["draining"], false);
        assert_eq!(ready_body["checks"]["acceptingWrites"], true);

        crate::server::set_draining_for_test(true);
        let draining = build_router(test_state())
            .oneshot(
                Request::builder()
                    .uri("/readyz")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(draining.status(), StatusCode::SERVICE_UNAVAILABLE);
        let draining_body = body_json(draining).await;
        assert_eq!(draining_body["checks"]["draining"], true);
        assert_eq!(draining_body["checks"]["acceptingWrites"], false);
        crate::server::set_draining_for_test(false);
    }

    #[tokio::test]
    async fn readyz_names_a_refused_brain_until_one_is_accepted() {
        let _guard = crate::ws_bridge::test_support::lock_slot().await;
        crate::ws_bridge::test_support::clear_refusal_for_testing();
        let readyz = || async {
            let response = build_router(test_state())
                .oneshot(
                    Request::builder()
                        .uri("/readyz")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            body_json(response).await
        };
        assert!(readyz().await.get("brainRefusal").is_none());

        crate::ws_bridge::test_support::refuse_for_testing("contract_mismatch");
        let body = readyz().await;
        assert_eq!(body["brainRefusal"]["reason"], "contract_mismatch");
        assert_eq!(body["brainRefusal"]["brain"]["contractVersion"], 2);
        assert_eq!(body["brainRefusal"]["server"]["contractVersion"], 3);

        crate::ws_bridge::test_support::clear_refusal_for_testing();
        assert!(readyz().await.get("brainRefusal").is_none());
    }

    #[tokio::test]
    async fn required_health_blocks_readiness_but_never_liveness() {
        use crate::ws_bridge::{test_support, BrainRuntimeHealth};
        let _guard = test_support::lock_slot().await;
        struct Reset;
        impl Drop for Reset {
            fn drop(&mut self) {
                crate::ws_bridge::test_support::report_runtime_health_for_testing(
                    Default::default(),
                );
                crate::runtime::test_support::clear_headless();
            }
        }
        let _reset = Reset;
        crate::server::set_draining_for_test(false);
        for (health, ready) in [
            (BrainRuntimeHealth::default(), true),
            (
                BrainRuntimeHealth {
                    bootstrapped: Some(false),
                    ..Default::default()
                },
                false,
            ),
            (
                BrainRuntimeHealth {
                    bootstrapped: Some(true),
                    failed: vec!["scheduler".into()],
                    failed_required: vec!["scheduler".into()],
                    ..Default::default()
                },
                false,
            ),
            (
                BrainRuntimeHealth {
                    bootstrapped: Some(true),
                    restarting_required: vec!["scheduler".into()],
                    ..Default::default()
                },
                false,
            ),
            (
                BrainRuntimeHealth {
                    bootstrapped: Some(true),
                    failed: vec!["backup-scheduler".into(), "storage-retention".into()],
                    ..Default::default()
                },
                true,
            ),
        ] {
            test_support::report_runtime_health_for_testing(health.clone());
            let response = build_router(test_state())
                .oneshot(
                    Request::builder()
                        .uri("/readyz")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                if ready {
                    StatusCode::OK
                } else {
                    StatusCode::SERVICE_UNAVAILABLE
                }
            );
            let body = body_json(response).await;
            assert_eq!(
                body["checks"]["failedRequiredRuntimes"],
                json!(health.failed_required)
            );
            assert_eq!(
                body["checks"]["restartingRequiredRuntimes"],
                json!(health.restarting_required)
            );
            assert_eq!(livez_handler().await.status(), StatusCode::OK);
        }
        crate::runtime::test_support::install_fake_headless();
        let response = build_router(test_state())
            .oneshot(
                Request::builder()
                    .uri("/healthz")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = body_json(response).await;
        assert_eq!(
            body["runtimes"]["warnings"],
            json!([
                "scheduled_backups_unavailable",
                "storage_cleanup_unavailable_disk_may_fill"
            ])
        );
        assert_eq!(body["runtimes"]["degraded"], true);
    }

    #[tokio::test]
    async fn failed_runtimes_degrade_readyz_without_failing_it() {
        struct Reset;
        impl Drop for Reset {
            fn drop(&mut self) {
                crate::ws_bridge::test_support::report_failed_runtimes_for_testing(&[]);
            }
        }
        let _guard = crate::ws_bridge::test_support::lock_slot().await;
        let _reset = Reset;
        crate::server::set_draining_for_test(false);
        let readyz = || async {
            build_router(test_state())
                .oneshot(
                    Request::builder()
                        .uri("/readyz")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap()
        };
        let healthy = body_json(readyz().await).await;
        assert!(healthy.get("degraded").is_none());
        assert!(healthy.get("failedRuntimes").is_none());

        crate::ws_bridge::test_support::report_failed_runtimes_for_testing(&["connector-runtime"]);
        let response = readyz().await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = body_json(response).await;
        assert_eq!(body["status"], "ready");
        assert_eq!(body["degraded"], true);
        assert_eq!(body["failedRuntimes"], json!(["connector-runtime"]));
    }
}

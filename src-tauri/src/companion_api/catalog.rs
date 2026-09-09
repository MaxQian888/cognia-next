//! Runtime discovery of the command contract (ADR-0175).
//!
//! `GET /api/catalog` (device plane) and `GET /internal/catalog` (service
//! plane) list the commands the caller may dispatch, as the contract describes
//! them. Devices used to ship all 1,325 descriptors and guess. The device list
//! is filtered with the same predicate dispatch uses
//! (`remote_execution::command_admitted`), so the catalog can never advertise
//! what dispatch would refuse, and a command a device cannot find here is one
//! it would be refused.
//!
//! The strong ETag is the catalog hash. On the device plane it is suffixed
//! with a fingerprint of the admitted set, because two devices with different
//! grants see different lists under the same contract, and a grant change must
//! never answer 304 with a stale list.

use axum::{
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Extension, Json,
};
use cognia_problem::Problem;
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::command_manifest::{self, CommandDescriptor, CATALOG_HASH, CONTRACT_VERSION};
use super::middleware::DeviceContext;
use super::remote_execution::{command_admitted, ExecutionTransport};

/// The document both planes answer with. Mirrors `CommandCatalog` in the
/// generated specifications.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandCatalog {
    pub contract_version: u32,
    pub catalog_hash: &'static str,
    pub plane: &'static str,
    pub commands: Vec<&'static CommandDescriptor>,
}

/// `GET /api/catalog`. Authenticated by `require_device_access`, like `whoami`.
pub(crate) async fn device_catalog_handler(
    Extension(context): Extension<DeviceContext>,
    headers: HeaderMap,
) -> Response {
    respond(
        &headers,
        "device",
        admitted_commands(&context, ExecutionTransport::Http),
    )
}

/// `GET /internal/catalog`. Authenticated by `require_service_jwt`.
pub(crate) async fn internal_catalog_handler(
    Extension(context): Extension<DeviceContext>,
    headers: HeaderMap,
) -> Response {
    respond(
        &headers,
        "service",
        admitted_commands(&context, ExecutionTransport::Internal),
    )
}

/// The remote commands this principal may dispatch over `transport`, in
/// contract order. One request id covers the whole walk so a store failure
/// mid-list answers as one problem.
pub(super) fn admitted_commands(
    principal: &DeviceContext,
    transport: ExecutionTransport,
) -> Result<Vec<&'static CommandDescriptor>, Problem> {
    let request_id = uuid::Uuid::new_v4().to_string();
    let mut commands = Vec::new();
    for name in command_manifest::remote_command_names() {
        let descriptor = command_manifest::descriptor(name)
            .expect("remote command names resolve to descriptors");
        if command_admitted(principal, transport, descriptor, &request_id)? {
            commands.push(descriptor);
        }
    }
    Ok(commands)
}

/// The strong validator for one answer.
fn etag(plane: &str, commands: &[&CommandDescriptor]) -> String {
    if plane == "service" {
        return format!("\"{CATALOG_HASH}\"");
    }
    let mut digest = Sha256::new();
    for command in commands {
        digest.update(command.name.as_bytes());
        digest.update(b"\n");
    }
    let fingerprint = hex::encode(digest.finalize());
    format!("\"{CATALOG_HASH}.{}\"", &fingerprint[..16])
}

/// The validators an `If-None-Match` header presents. Weak markers are
/// stripped: the catalog is byte-for-byte a function of the tag, so a weak
/// match is as good as a strong one here.
fn presented_etags(headers: &HeaderMap) -> Vec<String> {
    headers
        .get_all(header::IF_NONE_MATCH)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(str::trim)
        .filter(|tag| !tag.is_empty())
        .map(|tag| tag.strip_prefix("W/").unwrap_or(tag).to_string())
        .collect()
}

fn respond(
    headers: &HeaderMap,
    plane: &'static str,
    commands: Result<Vec<&'static CommandDescriptor>, Problem>,
) -> Response {
    let commands = match commands {
        Ok(commands) => commands,
        Err(problem) => return problem.into_response(),
    };
    let tag = etag(plane, &commands);
    let cache_headers = [
        (header::ETAG, tag.clone()),
        (header::CACHE_CONTROL, "private, no-cache".to_string()),
        (
            header::VARY,
            format!("authorization, {}", header::IF_NONE_MATCH),
        ),
    ];
    if presented_etags(headers)
        .iter()
        .any(|presented| presented == &tag || presented == "*")
    {
        return (StatusCode::NOT_MODIFIED, cache_headers).into_response();
    }
    let document = CommandCatalog {
        contract_version: CONTRACT_VERSION,
        catalog_hash: CATALOG_HASH,
        plane,
        commands,
    };
    (StatusCode::OK, cache_headers, Json(document)).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::companion_api::command_manifest::{CommandTarget, CommandTransport};
    use axum::http::HeaderValue;
    use serde_json::Value;
    use tower::ServiceExt as _;

    const SECRET: &[u8] = b"test-secret-32-bytes-exactly____";
    const ACCOUNT_ID: &str = "local_acct_a";

    fn principal(scope: &str, capabilities: Option<Vec<&str>>) -> DeviceContext {
        DeviceContext {
            device_id: "device-a".to_string(),
            account_id: ACCOUNT_ID.to_string(),
            scope: scope.to_string(),
            granted_scopes: Vec::new(),
            authorization_capabilities: capabilities
                .map(|list| list.into_iter().map(str::to_owned).collect()),
        }
    }

    fn test_state() -> crate::companion_api::SharedState {
        use crate::companion_api::{
            deny_list::DenyList, event_bus::EventBus, idempotency::IdempotencyCache, CompanionState,
        };
        std::sync::Arc::new(CompanionState {
            secret: parking_lot::RwLock::new(SECRET.to_vec()),
            deny_list: std::sync::Arc::new(DenyList::new()),
            app_handle: None,
            idempotency: std::sync::Arc::new(IdempotencyCache::new()),
            event_bus: EventBus::new(),
            sync_bridge: crate::companion_api::sync_bridge::SyncBridge::new(),
            desktop_messages_bridge:
                crate::companion_api::desktop_messages_bridge::DesktopMessagesBridge::new(),
            desktop_writes_bridge:
                crate::companion_api::desktop_writes_bridge::DesktopWritesBridge::new(),
            sync_registry: crate::companion_api::sync_registry::SyncTableRegistry::with_defaults(),
            rate_limiter: crate::companion_api::rate_limit::RateLimiter::with_defaults(),
            push_tokens: crate::companion_api::push::PushTokenRegistry::new(),
        })
    }

    async fn get(
        router: &axum::Router,
        path: &str,
        bearer: Option<&str>,
        if_none_match: Option<&str>,
    ) -> axum::response::Response {
        let mut builder = axum::http::Request::builder().method("GET").uri(path);
        if let Some(bearer) = bearer {
            builder = builder.header("authorization", format!("Bearer {bearer}"));
        }
        if let Some(tag) = if_none_match {
            builder = builder.header("if-none-match", tag);
        }
        let mut request = builder.body(axum::body::Body::empty()).unwrap();
        request
            .extensions_mut()
            .insert(axum::extract::ConnectInfo(std::net::SocketAddr::from((
                [127, 0, 0, 1],
                34567,
            ))));
        router.clone().oneshot(request).await.unwrap()
    }

    async fn body_json(response: axum::response::Response) -> Value {
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    /// The service principal on the internal transport is the whole remote
    /// set, in contract order. This is the list the Brain validates against.
    #[test]
    fn service_principal_sees_every_remote_command_in_contract_order() {
        let commands = admitted_commands(&principal("service", None), ExecutionTransport::Internal)
            .expect("no store is consulted for the service principal");
        let names: Vec<&str> = commands.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, command_manifest::remote_command_names());
    }

    /// A device sees only what dispatch would admit for it: execution and
    /// host-admin targets with the HTTP transport, and only those whose
    /// capability its authorization snapshot grants. Service-target commands
    /// never appear, and neither does a granted command on a transport the
    /// contract does not list.
    #[test]
    fn device_catalog_equals_what_dispatch_admits() {
        let granted = ["sessions.read", "host.observe"];
        let device = principal("device", Some(granted.to_vec()));
        let commands = admitted_commands(&device, ExecutionTransport::Http)
            .expect("an authorization snapshot needs no store");
        assert!(!commands.is_empty());
        for command in &commands {
            assert!(
                matches!(
                    command.target,
                    CommandTarget::Execution | CommandTarget::HostAdmin
                ),
                "{} target",
                command.name
            );
            assert!(
                command.transports.contains(&CommandTransport::Http),
                "{} transport",
                command.name
            );
            assert!(
                granted.contains(&command.capability.as_str()),
                "{} capability {}",
                command.name,
                command.capability
            );
        }
        let expected = command_manifest::commands()
            .iter()
            .filter(|c| {
                matches!(
                    c.target,
                    CommandTarget::Execution | CommandTarget::HostAdmin
                )
            })
            .filter(|c| c.transports.contains(&CommandTransport::Http))
            .filter(|c| granted.contains(&c.capability.as_str()))
            .count();
        assert_eq!(commands.len(), expected);

        // No grants, no commands. The predicate is the dispatch predicate, so
        // an empty snapshot is authoritative rather than a fallback to the store.
        let none = admitted_commands(
            &principal("device", Some(Vec::new())),
            ExecutionTransport::Http,
        )
        .unwrap();
        assert!(none.is_empty());
    }

    #[test]
    fn etag_is_the_catalog_hash_and_the_device_suffix_tracks_the_admitted_set() {
        assert_eq!(etag("service", &[]), format!("\"{CATALOG_HASH}\""));
        let all =
            admitted_commands(&principal("service", None), ExecutionTransport::Internal).unwrap();
        let some = &all[..all.len() / 2];
        let full = etag("device", &all);
        let half = etag("device", some);
        assert!(full.starts_with(&format!("\"{CATALOG_HASH}.")));
        assert_ne!(full, half);
        assert_eq!(etag("device", &all), full, "deterministic");
    }

    #[test]
    fn presented_etags_split_lists_and_strip_weak_markers() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::IF_NONE_MATCH,
            HeaderValue::from_static("W/\"a\", \"b\" ,, *"),
        );
        assert_eq!(presented_etags(&headers), vec!["\"a\"", "\"b\"", "*"]);
        assert!(presented_etags(&HeaderMap::new()).is_empty());
    }

    /// The assembled router: a service token gets the whole catalog with the
    /// catalog hash as a strong ETag, sending it back answers 304 with no body,
    /// a missing bearer is a problem document, and the device route is
    /// mounted behind device authentication.
    #[tokio::test]
    async fn internal_catalog_roundtrips_its_etag_and_refuses_without_a_token() {
        let _guard = crate::companion_api::ws_bridge::test_support::lock_slot().await;
        crate::headless::install_headless_services(None);
        let router = crate::companion_api::server::build_router(test_state());
        let (service, _) =
            crate::companion_api::jwt::issue_service_jwt(SECRET, ACCOUNT_ID).expect("service jwt");

        let response = get(&router, "/internal/catalog", Some(&service), None).await;
        assert_eq!(response.status(), StatusCode::OK);
        let tag = response
            .headers()
            .get(header::ETAG)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
            .expect("etag");
        assert_eq!(tag, format!("\"{CATALOG_HASH}\""));
        let document = body_json(response).await;
        assert_eq!(document["contractVersion"], CONTRACT_VERSION);
        assert_eq!(document["catalogHash"], CATALOG_HASH);
        assert_eq!(document["plane"], "service");
        let commands = document["commands"].as_array().expect("commands");
        assert_eq!(
            commands.len(),
            command_manifest::remote_command_names().len()
        );
        assert_eq!(
            commands[0]["name"],
            command_manifest::remote_command_names()[0]
        );
        // The descriptor is serialized as the contract wrote it.
        for field in [
            "resource",
            "verb",
            "arm",
            "target",
            "operation",
            "capability",
            "risk",
            "approval",
            "idempotency",
            "transports",
            "pagination",
            "longRunning",
            "inputSchema",
            "outputSchema",
        ] {
            assert!(commands[0].get(field).is_some(), "descriptor field {field}");
        }

        let response = get(&router, "/internal/catalog", Some(&service), Some(&tag)).await;
        assert_eq!(response.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(
            response
                .headers()
                .get(header::ETAG)
                .unwrap()
                .to_str()
                .unwrap(),
            tag
        );
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert!(bytes.is_empty(), "304 carries no body");

        let response = get(&router, "/internal/catalog", None, None).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            response
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok()),
            Some(cognia_problem::CONTENT_TYPE)
        );

        let response = get(&router, "/api/catalog", None, None).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            response
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok()),
            Some(cognia_problem::CONTENT_TYPE)
        );
    }
}

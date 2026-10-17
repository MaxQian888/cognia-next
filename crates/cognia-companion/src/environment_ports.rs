//! Device- and workspace-authorized HTTP/upgrade relay over the container's
//! private exec stream. There is no host port, public Docker binding, or
//! credential-bearing URL for an untrusted application to discover.

use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::extract::{Path, Request};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use hyper_util::rt::TokioIo;

use super::middleware::DeviceContext;

pub async fn root_handler(
    Path((project, container, port)): Path<(String, String, u16)>,
    request: Request,
) -> Response {
    relay(project, container, port, String::new(), request).await
}

pub async fn handler(
    Path((project, container, port, tail)): Path<(String, String, u16, String)>,
    request: Request,
) -> Response {
    relay(project, container, port, tail, request).await
}

pub(crate) fn strip_private_headers(headers: &mut HeaderMap, request: bool) {
    // Connection can nominate additional hop-by-hop fields. Never let a
    // project service receive host credentials or a caller-injected identity.
    let connection: Vec<String> = headers
        .get_all("connection")
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| {
            value
                .split(',')
                .map(|name| name.trim().to_ascii_lowercase())
        })
        .collect();
    for name in connection {
        if name != "upgrade" {
            headers.remove(name);
        }
    }
    for name in [
        "dpop",
        "proxy-authorization",
        "proxy-authenticate",
        "x-cognia-account-id",
        "x-cognia-device-id",
        "x-forwarded-for",
        "x-forwarded-host",
        "x-forwarded-proto",
        "forwarded",
        "keep-alive",
        "te",
        "trailer",
        "transfer-encoding",
        "x-cognia-port-authorization",
        "x-cognia-port-host",
        "x-cognia-port-origin",
    ] {
        headers.remove(name);
    }
    if request {
        headers.remove("authorization");
        headers.remove("origin");
    }
    if !headers.contains_key("upgrade") {
        headers.remove("connection");
    }
}

async fn authorized(context: &DeviceContext, project: &str) -> bool {
    super::workspace_access::device_can_control(&context.device_id)
        && super::workspace_access::require_approval_authority(
            "environment_port_access",
            project,
            Some(&context.tenant_id),
        )
        .await
        .is_ok()
}

async fn relay(
    project: String,
    container: String,
    port: u16,
    _tail: String,
    request: Request,
) -> Response {
    let Some(context) = request.extensions().get::<DeviceContext>().cloned() else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    if !authorized(&context, &project).await {
        return StatusCode::FORBIDDEN.into_response();
    }
    relay_request_inner(
        project,
        container,
        port,
        request,
        Some(context),
        None,
        PORT_ROUTE_TAIL,
    )
    .await
}

/// `/api/environment/ports/{project}/{container}/{port}/<tail>`: the tail is
/// the eighth `/`-separated piece.
const PORT_ROUTE_TAIL: usize = 7;
/// `/api/sandbox/previews/{grant}/<tail>`.
const PREVIEW_ROUTE_TAIL: usize = 5;

/// Native local relay: the caller binds one fixed workspace/port on a separate
/// loopback origin. The Tauri command is the owner boundary, and every request
/// still re-admits the stored spec before opening the tunnel.
pub async fn local_relay(
    project: String,
    container: String,
    port: u16,
    request: Request,
) -> Response {
    relay_request_inner(project, container, port, request, None, None, 0).await
}

/// The preview grant owns cancellation until the last HTTP body or upgraded
/// stream finishes. Reuses the exact same admission and exec forwarder.
pub(crate) async fn preview_relay(
    project: String,
    container: String,
    port: u16,
    request: Request,
    cancellation: tokio::sync::watch::Receiver<bool>,
) -> Response {
    relay_request_inner(
        project,
        container,
        port,
        request,
        None,
        Some(cancellation),
        0,
    )
    .await
}

/// A paired device's preview through its native relay: the grant owns
/// cancellation and the device keeps its workspace authority for the whole
/// stream, both re-checked while bodies and upgrades are open.
pub(crate) async fn preview_device_relay(
    project: String,
    container: String,
    port: u16,
    request: Request,
    context: DeviceContext,
    cancellation: tokio::sync::watch::Receiver<bool>,
) -> Response {
    relay_request_inner(
        project,
        container,
        port,
        request,
        Some(context),
        Some(cancellation),
        PREVIEW_ROUTE_TAIL,
    )
    .await
}

/// Whether a paired device may reach a project's ports right now.
pub(crate) async fn device_authorized(context: &DeviceContext, project: &str) -> bool {
    authorized(context, project).await
}

async fn relay_request_inner(
    project: String,
    container: String,
    port: u16,
    request: Request,
    context: Option<DeviceContext>,
    preview_cancel: Option<tokio::sync::watch::Receiver<bool>>,
    device_tail: usize,
) -> Response {
    let Some(runtime) = super::environment_pool::installed().and_then(|pool| pool.runtime) else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    forward_request(
        runtime,
        project,
        container,
        port,
        request,
        context,
        preview_cancel,
        device_tail,
    )
    .await
}

/// The still-encoded application path after a device route's own segments.
fn route_tail(path: &str, index: usize) -> &str {
    path.splitn(index + 1, '/').nth(index).unwrap_or("")
}

async fn forward_request(
    runtime: Arc<dyn cognia_sandbox_pool::runtime::SandboxRuntimeControl>,
    project: String,
    container: String,
    port: u16,
    mut request: Request,
    context: Option<DeviceContext>,
    preview_cancel: Option<tokio::sync::watch::Receiver<bool>>,
    device_tail: usize,
) -> Response {
    let remote = context.is_some();
    let stream = match runtime.open_port(&project, &container, port).await {
        Ok(stream) => stream,
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };
    let query = request
        .uri()
        .query()
        .map(|query| format!("?{query}"))
        .unwrap_or_default();
    // Axum's Path extractor decodes %2F/%3F. Keep the original encoded tail
    // so application URLs retain their exact path/query boundary.
    let tail = if remote {
        route_tail(request.uri().path(), device_tail)
    } else {
        request
            .uri()
            .path()
            .strip_prefix('/')
            .unwrap_or(request.uri().path())
    };
    let path = format!("/{tail}{query}");
    let Ok(uri) = path.parse() else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    *request.uri_mut() = uri;
    let application_auth = request.headers_mut().remove(if remote {
        "x-cognia-port-authorization"
    } else {
        "authorization"
    });
    let application_host = request
        .headers_mut()
        .remove(if remote { "x-cognia-port-host" } else { "host" })
        .filter(|value| {
            value
                .to_str()
                .ok()
                .is_some_and(|host| host.parse::<axum::http::uri::Authority>().is_ok())
        });
    let application_origin = request.headers_mut().remove(if remote {
        "x-cognia-port-origin"
    } else {
        "origin"
    });
    strip_private_headers(request.headers_mut(), true);
    if let Some(auth) = application_auth {
        request.headers_mut().insert("authorization", auth);
    }
    if let Some(origin) = application_origin {
        request.headers_mut().insert("origin", origin);
    }
    request.headers_mut().insert(
        "host",
        application_host.unwrap_or_else(|| {
            HeaderValue::from_str(&format!("127.0.0.1:{port}")).expect("numeric port")
        }),
    );
    let downstream_upgrade = hyper::upgrade::on(&mut request);
    let (mut sender, connection) =
        match hyper::client::conn::http1::handshake(TokioIo::new(stream)).await {
            Ok(connection) => connection,
            Err(_) => return StatusCode::BAD_GATEWAY.into_response(),
        };
    let (cancel_tx, mut cancel_rx) = tokio::sync::watch::channel(false);
    let authorization = tokio::spawn(async move {
        // The runtime owns continuous spec/port admission for its stream.
        // This layer adds grant cancellation and device/workspace authority
        // only, avoiding a second Docker inspect and policy lookup for every
        // connection every tick. A paired preview has both.
        let mut preview_cancel = preview_cancel;
        if preview_cancel
            .as_ref()
            .is_some_and(|cancel| *cancel.borrow())
        {
            cancel_tx.send_replace(true);
            return;
        }
        loop {
            tokio::select! {
                _ = cancel_tx.closed() => break,
                _ = async {
                    match preview_cancel.as_mut() {
                        // A dropped sender means the grant is gone too.
                        Some(cancel) => { let _ = cancel.changed().await; }
                        None => std::future::pending::<()>().await,
                    }
                } => {
                    cancel_tx.send_replace(true);
                    break;
                }
                _ = async {
                    match &context {
                        Some(_) => tokio::time::sleep(Duration::from_secs(2)).await,
                        None => std::future::pending::<()>().await,
                    }
                } => {
                    if let Some(context) = &context {
                        if !authorized(context, &project).await {
                            cancel_tx.send_replace(true);
                            break;
                        }
                    }
                }
            }
        }
    });
    // Keep cancellation alive for the response body and any upgraded stream,
    // not just until HTTP headers arrive.
    let cancellation = Arc::new(CancelAuthorization(authorization));
    let connection_lifetime = cancellation.clone();
    let mut connection_cancel = cancel_rx.clone();
    tokio::spawn(async move {
        let _lifetime = connection_lifetime;
        tokio::select! {
            _ = connection.with_upgrades() => {},
            _ = connection_cancel.changed() => {},
        }
    });
    let mut response = match tokio::select! {
        response = tokio::time::timeout(Duration::from_secs(60), sender.send_request(request)) => response,
        _ = cancel_rx.changed() => return StatusCode::GONE.into_response(),
    } {
        Ok(Ok(response)) => response,
        _ => return StatusCode::BAD_GATEWAY.into_response(),
    };
    strip_private_headers(response.headers_mut(), false);
    if response.status() == StatusCode::SWITCHING_PROTOCOLS {
        let upstream_upgrade = hyper::upgrade::on(&mut response);
        tokio::spawn(async move {
            let _lifetime = cancellation;
            let relay = async {
                let (upstream, downstream) =
                    tokio::try_join!(upstream_upgrade, downstream_upgrade)?;
                let _ = tokio::io::copy_bidirectional(
                    &mut TokioIo::new(upstream),
                    &mut TokioIo::new(downstream),
                )
                .await;
                Ok::<(), hyper::Error>(())
            };
            tokio::select! { _ = relay => {}, _ = cancel_rx.changed() => {} }
        });
    }
    response.map(Body::new)
}

struct CancelAuthorization(tokio::task::JoinHandle<()>);
impl Drop for CancelAuthorization {
    fn drop(&mut self) {
        self.0.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_routes_hand_the_encoded_application_tail_to_the_project() {
        assert_eq!(
            route_tail("/api/environment/ports/p/c/3000/a%2Fb/c", PORT_ROUTE_TAIL),
            "a%2Fb/c"
        );
        assert_eq!(
            route_tail("/api/environment/ports/p/c/3000", PORT_ROUTE_TAIL),
            ""
        );
        assert_eq!(
            route_tail(
                "/api/sandbox/previews/abc/assets/app.js",
                PREVIEW_ROUTE_TAIL
            ),
            "assets/app.js"
        );
        assert_eq!(
            route_tail("/api/sandbox/previews/abc/", PREVIEW_ROUTE_TAIL),
            ""
        );
    }

    #[test]
    fn host_credentials_and_nominated_headers_never_reach_project_ports() {
        let mut headers = HeaderMap::new();
        for (name, value) in [
            ("authorization", "Bearer secret"),
            ("dpop", "proof"),
            ("x-cognia-account-id", "owner"),
            ("connection", "x-injected, Upgrade"),
            ("x-injected", "value"),
            ("upgrade", "websocket"),
            ("content-type", "text/plain"),
        ] {
            headers.insert(
                axum::http::HeaderName::from_static(name),
                HeaderValue::from_static(value),
            );
        }
        strip_private_headers(&mut headers, true);
        for name in ["authorization", "dpop", "x-cognia-account-id", "x-injected"] {
            assert!(!headers.contains_key(name));
        }
        assert_eq!(headers["upgrade"], "websocket");
        assert_eq!(headers["content-type"], "text/plain");
    }
}

#[cfg(test)]
mod preview_stream_tests {
    use super::*;
    use cognia_external_agent::sandbox_routing_backend::SandboxSpawnError;
    use cognia_sandbox_pool::runtime::{RuntimePort, SandboxRuntimeControl};
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::{
        tungstenite::{protocol::Role, Message},
        WebSocketStream,
    };
    struct Runtime;
    #[async_trait::async_trait]
    impl SandboxRuntimeControl for Runtime {
        async fn list_ports(&self, _: &str) -> Result<Vec<RuntimePort>, SandboxSpawnError> {
            Ok(Vec::new())
        }
        async fn port_allowed(&self, _: &str, _: &str, _: u16) -> Result<bool, SandboxSpawnError> {
            Ok(true)
        }
        async fn open_port(
            &self,
            _: &str,
            _: &str,
            _: u16,
        ) -> Result<tokio::io::DuplexStream, SandboxSpawnError> {
            let (client, server) = tokio::io::duplex(4096);
            tokio::spawn(async move {
                let app = hyper::service::service_fn(
                    |mut request: hyper::Request<hyper::body::Incoming>| async move {
                        if request.headers().contains_key("upgrade") {
                            let accept =
                                tokio_tungstenite::tungstenite::handshake::derive_accept_key(
                                    request.headers()["sec-websocket-key"].as_bytes(),
                                );
                            let upgrade = hyper::upgrade::on(&mut request);
                            tokio::spawn(async move {
                                if let Ok(stream) = upgrade.await {
                                    let mut websocket = WebSocketStream::from_raw_socket(
                                        TokioIo::new(stream),
                                        Role::Server,
                                        None,
                                    )
                                    .await;
                                    while let Some(Ok(message)) = websocket.next().await {
                                        if websocket.send(message).await.is_err() {
                                            break;
                                        }
                                    }
                                }
                            });
                            Ok::<_, std::convert::Infallible>(
                                axum::http::Response::builder()
                                    .status(101)
                                    .header("connection", "upgrade")
                                    .header("upgrade", "websocket")
                                    .header("sec-websocket-accept", accept)
                                    .body(Body::empty())
                                    .unwrap(),
                            )
                        } else {
                            let stream = futures_util::stream::once(async {
                                Ok::<_, std::io::Error>(bytes::Bytes::from_static(
                                    b"data: ready\n\n",
                                ))
                            });
                            let stream = futures_util::StreamExt::chain(
                                stream,
                                futures_util::stream::pending(),
                            );
                            Ok(axum::http::Response::builder()
                                .header("content-type", "text/event-stream")
                                .body(Body::from_stream(stream))
                                .unwrap())
                        }
                    },
                );
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(TokioIo::new(server), app)
                    .with_upgrades()
                    .await;
            });
            Ok(client)
        }
    }
    async fn connection(
        cancel: tokio::sync::watch::Receiver<bool>,
    ) -> hyper::client::conn::http1::SendRequest<Body> {
        let (client, server) = tokio::io::duplex(4096);
        tokio::spawn(async move {
            let app = hyper::service::service_fn(
                move |request: hyper::Request<hyper::body::Incoming>| {
                    let cancel = cancel.clone();
                    async move {
                        Ok::<_, std::convert::Infallible>(
                            forward_request(
                                Arc::new(Runtime),
                                "project".into(),
                                "container".into(),
                                3000,
                                request.map(Body::new),
                                None,
                                Some(cancel),
                                0,
                            )
                            .await,
                        )
                    }
                },
            );
            let _ = hyper::server::conn::http1::Builder::new()
                .serve_connection(TokioIo::new(server), app)
                .with_upgrades()
                .await;
        });
        let (sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(client))
            .await
            .unwrap();
        tokio::spawn(async move {
            let _ = connection.with_upgrades().await;
        });
        sender
    }
    #[tokio::test]
    async fn preview_revocation_closes_a_live_sse_body_without_sockets() {
        let (cancel, receiver) = tokio::sync::watch::channel(false);
        let mut sender = connection(receiver).await;
        let response = sender
            .send_request(Request::builder().uri("/").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let mut stream = Body::new(response.into_body()).into_data_stream();
        assert_eq!(
            futures_util::StreamExt::next(&mut stream)
                .await
                .unwrap()
                .unwrap(),
            "data: ready\n\n"
        );
        cancel.send_replace(true);
        let closed = tokio::time::timeout(
            Duration::from_secs(1),
            futures_util::StreamExt::next(&mut stream),
        )
        .await
        .unwrap();
        assert!(closed.is_none_or(|chunk| chunk.is_err()));
    }
    #[tokio::test]
    async fn preview_revocation_closes_an_upgraded_websocket_without_sockets() {
        let (cancel, receiver) = tokio::sync::watch::channel(false);
        let mut sender = connection(receiver).await;
        let mut response = sender
            .send_request(
                Request::builder()
                    .uri("/")
                    .header("connection", "upgrade")
                    .header("upgrade", "websocket")
                    .header("sec-websocket-version", "13")
                    .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SWITCHING_PROTOCOLS);
        assert_eq!(
            response.headers()["sec-websocket-accept"],
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
        );
        let stream = TokioIo::new(hyper::upgrade::on(&mut response).await.unwrap());
        let mut websocket = WebSocketStream::from_raw_socket(stream, Role::Client, None).await;
        websocket
            .send(Message::Text("preview ping".into()))
            .await
            .unwrap();
        assert_eq!(
            websocket.next().await.unwrap().unwrap(),
            Message::Text("preview ping".into())
        );
        cancel.send_replace(true);
        let result = tokio::time::timeout(Duration::from_secs(1), websocket.next())
            .await
            .unwrap();
        assert!(result.is_none_or(|message| message.is_err()));
    }
}

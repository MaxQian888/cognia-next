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

fn strip_private_headers(headers: &mut HeaderMap, request: bool) {
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
    super::rpc::device_can_control(&context.device_id)
        && super::rpc::environment::require_approval_authority(
            "environment_port_access",
            project,
            Some(&context.account_id),
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
    relay_request_inner(project, container, port, request, Some(context)).await
}

/// Native local relay: the caller binds one fixed workspace/port on a separate
/// loopback origin. The Tauri command is the owner boundary, and every request
/// still re-admits the stored spec before opening the tunnel.
pub(crate) async fn local_relay(
    project: String,
    container: String,
    port: u16,
    request: Request,
) -> Response {
    relay_request_inner(project, container, port, request, None).await
}

async fn relay_request_inner(
    project: String,
    container: String,
    port: u16,
    mut request: Request,
    context: Option<DeviceContext>,
) -> Response {
    let remote = context.is_some();
    let Some(runtime) = super::environment_pool::installed().and_then(|pool| pool.runtime) else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
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
        request.uri().path().splitn(8, '/').nth(7).unwrap_or("")
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
        // This layer adds device/workspace authority only, avoiding a second
        // Docker inspect and policy lookup for every connection every tick.
        let Some(context) = context else {
            cancel_tx.closed().await;
            return;
        };
        loop {
            tokio::select! {
                _ = cancel_tx.closed() => break,
                _ = tokio::time::sleep(Duration::from_secs(2)) => {
                    if !authorized(&context, &project).await {
                        cancel_tx.send_replace(true);
                        break;
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
    let mut response =
        match tokio::time::timeout(Duration::from_secs(60), sender.send_request(request)).await {
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

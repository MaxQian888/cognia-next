//! Desktop-side ephemeral relay for a paired host's managed Pro IDE.
//!
//! The embedded webview talks only to a random loopback port. This relay pins
//! the companion certificate before establishing TLS, then adds the existing
//! device JWT as an HTTP header. Neither JWT nor capability material appears in
//! the browser URL.

use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{FromRequestParts, Request, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::WebPkiSupportedAlgorithms;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, Error as RustlsError, SignatureScheme};
use serde::Serialize;
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::{connect_async_tls_with_config, Connector};

const MAX_RELAY_MESSAGE_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRelayStatus {
    pub port: u16,
    pub url: String,
}

struct RunningRelay {
    key: String,
    port: u16,
    task: tokio::task::JoinHandle<()>,
    /// Kept so a re-`ensure` for the same target can swap in a fresh device
    /// access token WITHOUT rebinding the port. Device access tokens live five
    /// minutes (`ACCESS_TOKEN_TTL_SECS`); rebinding instead would hand the
    /// webview a new URL every refresh and reboot the VS Code workbench, which
    /// is exactly the session loss the pane exists to prevent.
    target: Arc<RelayTarget>,
}

impl RunningRelay {
    fn stop(self) {
        self.task.abort();
    }
}

#[derive(Default)]
pub struct DesktopRelayState {
    running: Mutex<Option<RunningRelay>>,
}

impl DesktopRelayState {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn ensure(
        &self,
        base_url: String,
        device_jwt: String,
        server_fingerprint: String,
        relay_path: String,
    ) -> Result<DesktopRelayStatus, String> {
        let target = Arc::new(RelayTarget::new(
            base_url,
            device_jwt.clone(),
            server_fingerprint,
            relay_path,
        )?);
        let key = target.key();
        let mut running = self.running.lock().await;
        if let Some(existing) = running.as_ref() {
            if existing.key == key && !existing.task.is_finished() {
                // Same host, same relay, same pinned certificate — only the
                // short-lived credential can have changed. Swap it and keep the
                // port so the live workbench never notices.
                existing.target.set_device_jwt(device_jwt).await;
                return Ok(relay_status(existing.port));
            }
        }
        if let Some(existing) = running.take() {
            existing.stop();
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|error| format!("bind desktop managed IDE relay: {error}"))?;
        let port = listener
            .local_addr()
            .map_err(|error| format!("read desktop relay port: {error}"))?
            .port();
        let router = Router::new()
            .fallback(any(desktop_relay_handler))
            .with_state(Arc::clone(&target));
        let task = tokio::spawn(async move {
            if let Err(error) = axum::serve(listener, router).await {
                log::warn!("desktop managed IDE relay stopped: {error}");
            }
        });
        *running = Some(RunningRelay {
            key,
            port,
            task,
            target,
        });
        Ok(relay_status(port))
    }

    pub async fn stop(&self) -> bool {
        if let Some(running) = self.running.lock().await.take() {
            running.stop();
            true
        } else {
            false
        }
    }
}

fn relay_status(port: u16) -> DesktopRelayStatus {
    DesktopRelayStatus {
        port,
        url: format!("http://127.0.0.1:{port}/"),
    }
}

struct RelayTarget {
    base_url: url::Url,
    relay_path: String,
    /// Device access token, replaceable in place — see [`RunningRelay::target`].
    /// A `tokio` lock rather than `parking_lot`: it is read on every proxied
    /// request and upgrade, all of which are `async`, and a sync guard held
    /// across the send would be the classic guard-across-await hazard.
    device_jwt: tokio::sync::RwLock<String>,
    fingerprint: String,
    tls: Arc<ClientConfig>,
    http: reqwest::Client,
}

impl RelayTarget {
    fn new(
        base_url: String,
        device_jwt: String,
        server_fingerprint: String,
        relay_path: String,
    ) -> Result<Self, String> {
        let base_url = url::Url::parse(&base_url)
            .map_err(|error| format!("invalid remote companion URL: {error}"))?;
        if base_url.scheme() != "https"
            || base_url.host_str().is_none()
            || !base_url.username().is_empty()
            || base_url.password().is_some()
        {
            return Err(
                "remote managed IDE relay requires a credential-free https companion URL"
                    .to_string(),
            );
        }
        if device_jwt.trim().is_empty() {
            return Err("remote managed IDE relay requires a device JWT".to_string());
        }
        let fingerprint = normalize_fingerprint(&server_fingerprint)?;
        let relay_path = normalize_relay_path(&relay_path)?;
        let tls = pinned_tls_config(&fingerprint)?;
        let http = reqwest::Client::builder()
            .use_preconfigured_tls(Arc::clone(&tls))
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(120))
            .build()
            .map_err(|error| format!("build pinned managed IDE client: {error}"))?;
        Ok(Self {
            base_url,
            relay_path,
            device_jwt: tokio::sync::RwLock::new(device_jwt),
            fingerprint,
            tls,
            http,
        })
    }

    /// Replace the device access token used by subsequent requests.
    async fn set_device_jwt(&self, device_jwt: String) {
        if device_jwt.trim().is_empty() {
            return;
        }
        *self.device_jwt.write().await = device_jwt;
    }

    /// Snapshot the current token. Cloned out rather than returning a guard so
    /// no lock is held across the upstream send.
    async fn bearer(&self) -> String {
        self.device_jwt.read().await.clone()
    }

    fn key(&self) -> String {
        format!(
            "{}|{}|{}",
            self.base_url.as_str(),
            self.relay_path,
            self.fingerprint
        )
    }

    fn upstream_url(&self, request_uri: &axum::http::Uri, websocket: bool) -> String {
        let mut url = self.base_url.clone();
        if websocket {
            let _ = url.set_scheme("wss");
        }
        let tail = request_uri.path().trim_start_matches('/');
        url.set_path(&format!("{}{tail}", self.relay_path));
        url.set_query(request_uri.query());
        url.to_string()
    }
}

fn normalize_fingerprint(value: &str) -> Result<String, String> {
    let normalized = value
        .trim()
        .strip_prefix("sha256:")
        .unwrap_or(value.trim())
        .replace(':', "")
        .to_ascii_lowercase();
    if normalized.len() != 64 || !normalized.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("remote companion certificate fingerprint is invalid".to_string());
    }
    Ok(normalized)
}

fn normalize_relay_path(value: &str) -> Result<String, String> {
    let path = value.trim();
    if !path.starts_with("/ide/relay/")
        || path.contains("..")
        || path.contains('?')
        || path.contains('#')
    {
        return Err("remote managed IDE relay path is invalid".to_string());
    }
    Ok(format!("{}/", path.trim_end_matches('/')))
}

#[derive(Debug)]
struct PinnedSpkiVerifier {
    expected: String,
    algorithms: WebPkiSupportedAlgorithms,
}

impl ServerCertVerifier for PinnedSpkiVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, RustlsError> {
        let actual = crate::companion_api::tls::spki_fingerprint_from_der(end_entity.as_ref())
            .map_err(|_| RustlsError::InvalidCertificate(rustls::CertificateError::BadEncoding))?;
        if subtle::ConstantTimeEq::ct_eq(actual.as_bytes(), self.expected.as_bytes()).into() {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(RustlsError::InvalidCertificate(
                rustls::CertificateError::ApplicationVerificationFailure,
            ))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, RustlsError> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, RustlsError> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algorithms.supported_schemes()
    }
}

fn pinned_tls_config(fingerprint: &str) -> Result<Arc<ClientConfig>, String> {
    let provider = rustls::crypto::ring::default_provider();
    let algorithms = provider.signature_verification_algorithms;
    let config = ClientConfig::builder_with_provider(Arc::new(provider))
        .with_safe_default_protocol_versions()
        .map_err(|error| format!("build pinned TLS protocol set: {error}"))?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(PinnedSpkiVerifier {
            expected: fingerprint.to_string(),
            algorithms,
        }))
        .with_no_client_auth();
    Ok(Arc::new(config))
}

async fn desktop_relay_handler(
    State(target): State<Arc<RelayTarget>>,
    request: Request,
) -> Response {
    let (mut parts, body) = request.into_parts();
    let ws = WebSocketUpgrade::from_request_parts(&mut parts, &())
        .await
        .ok();
    let request = Request::from_parts(parts, body);
    if let Some(ws) = ws {
        let upstream = target.upstream_url(request.uri(), true);
        let requested_protocol = request
            .headers()
            .get(axum::http::header::SEC_WEBSOCKET_PROTOCOL)
            .and_then(|value| value.to_str().ok())
            .map(ToString::to_string);
        let mut upgrade = ws.max_message_size(MAX_RELAY_MESSAGE_BYTES);
        if let Some(protocols) = requested_protocol.as_deref() {
            let protocols = protocols
                .split(',')
                .map(str::trim)
                .filter(|protocol| !protocol.is_empty())
                .map(ToString::to_string)
                .collect::<Vec<_>>();
            upgrade = upgrade.protocols(protocols);
        }
        let target = Arc::clone(&target);
        return upgrade
            .on_upgrade(move |socket| {
                relay_pinned_websocket(socket, target, upstream, requested_protocol)
            })
            .into_response();
    }
    relay_pinned_http(target, request).await
}

async fn relay_pinned_http(target: Arc<RelayTarget>, request: Request) -> Response {
    let url = target.upstream_url(request.uri(), false);
    let method = request.method().clone();
    let headers = filtered_headers(request.headers());
    let stream = request.into_body().into_data_stream();
    let bearer = target.bearer().await;
    let mut upstream = target
        .http
        .request(method, url)
        .bearer_auth(&bearer)
        .body(reqwest::Body::wrap_stream(stream));
    for (name, value) in headers {
        upstream = upstream.header(name, value);
    }
    match upstream.send().await {
        Ok(response) => {
            let status = response.status();
            let headers = filtered_headers(response.headers());
            let mut output = Response::builder().status(status);
            for (name, value) in headers {
                output = output.header(name, value);
            }
            output
                .body(Body::from_stream(response.bytes_stream()))
                .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response())
        }
        Err(error) => {
            log::warn!("desktop managed IDE relay HTTP failed: {error}");
            StatusCode::BAD_GATEWAY.into_response()
        }
    }
}

async fn relay_pinned_websocket(
    mut downstream: WebSocket,
    target: Arc<RelayTarget>,
    upstream_url: String,
    requested_protocol: Option<String>,
) {
    let Ok(mut request) = upstream_url.into_client_request() else {
        let _ = downstream.close().await;
        return;
    };
    let Ok(auth) = HeaderValue::from_str(&format!("Bearer {}", target.bearer().await)) else {
        let _ = downstream.close().await;
        return;
    };
    request
        .headers_mut()
        .insert(axum::http::header::AUTHORIZATION, auth);
    if let Some(protocol) = requested_protocol.and_then(|value| HeaderValue::from_str(&value).ok())
    {
        request
            .headers_mut()
            .insert(axum::http::header::SEC_WEBSOCKET_PROTOCOL, protocol);
    }
    let connector = Connector::Rustls(Arc::clone(&target.tls));
    let Ok((upstream, _)) =
        connect_async_tls_with_config(request, None, false, Some(connector)).await
    else {
        let _ = downstream.close().await;
        return;
    };
    let (mut upstream_tx, mut upstream_rx) = upstream.split();
    loop {
        tokio::select! {
            message = downstream.recv() => {
                let Some(Ok(message)) = message else { break };
                let Some(message) = to_tungstenite(message) else { continue };
                if upstream_tx.send(message).await.is_err() { break; }
            }
            message = upstream_rx.next() => {
                let Some(Ok(message)) = message else { break };
                let Some(message) = to_axum(message) else { continue };
                if downstream.send(message).await.is_err() { break; }
            }
        }
    }
    let _ = upstream_tx.close().await;
    let _ = downstream.close().await;
}

fn filtered_headers(headers: &HeaderMap) -> Vec<(HeaderName, HeaderValue)> {
    headers
        .iter()
        .filter(|(name, _)| {
            !matches!(
                name.as_str(),
                "authorization"
                    | "connection"
                    | "host"
                    | "keep-alive"
                    | "proxy-authenticate"
                    | "proxy-authorization"
                    | "te"
                    | "trailer"
                    | "transfer-encoding"
                    | "upgrade"
            )
        })
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect()
}

fn to_tungstenite(message: Message) -> Option<tokio_tungstenite::tungstenite::Message> {
    use tokio_tungstenite::tungstenite::Message as Target;
    match message {
        Message::Text(value) => Some(Target::Text(value.to_string().into())),
        Message::Binary(value) => Some(Target::Binary(value)),
        Message::Ping(value) => Some(Target::Ping(value)),
        Message::Pong(value) => Some(Target::Pong(value)),
        Message::Close(frame) => Some(Target::Close(frame.map(|frame| {
            tokio_tungstenite::tungstenite::protocol::CloseFrame {
                code: frame.code.into(),
                reason: frame.reason.to_string().into(),
            }
        }))),
    }
}

fn to_axum(message: tokio_tungstenite::tungstenite::Message) -> Option<Message> {
    use tokio_tungstenite::tungstenite::Message as Source;
    match message {
        Source::Text(value) => Some(Message::Text(value.to_string().into())),
        Source::Binary(value) => Some(Message::Binary(value)),
        Source::Ping(value) => Some(Message::Ping(value)),
        Source::Pong(value) => Some(Message::Pong(value)),
        Source::Close(frame) => Some(Message::Close(frame.map(|frame| {
            axum::extract::ws::CloseFrame {
                code: frame.code.into(),
                reason: frame.reason.to_string().into(),
            }
        }))),
        Source::Frame(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rustls::pki_types::IpAddr;

    #[test]
    fn fingerprint_normalization_accepts_pairing_shapes() {
        let hex = "ab".repeat(32);
        assert_eq!(normalize_fingerprint(&hex).unwrap(), hex);
        assert_eq!(
            normalize_fingerprint(&format!("sha256:{}", "AB".repeat(32))).unwrap(),
            hex
        );
        assert!(normalize_fingerprint("not-a-fingerprint").is_err());
    }

    #[test]
    fn only_managed_relay_paths_are_accepted() {
        assert_eq!(
            normalize_relay_path("/ide/relay/opaque").unwrap(),
            "/ide/relay/opaque/"
        );
        assert!(normalize_relay_path("/api/_rpc/x").is_err());
        assert!(normalize_relay_path("/ide/relay/../secret").is_err());
        // The mount the companion actually serves is `/ide/relay/...`
        // (protocol/companion-api-routes.json). A `/ide/v1/relay/...` path was
        // advertised and accepted by both halves for a while; every request
        // through it 404s at the front door.
        assert!(normalize_relay_path("/ide/v1/relay/opaque").is_err());
    }

    #[test]
    fn credentials_and_hop_by_hop_headers_never_reach_code_server() {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", HeaderValue::from_static("Bearer browser"));
        headers.insert("connection", HeaderValue::from_static("upgrade"));
        headers.insert("x-forwarded-test", HeaderValue::from_static("kept"));
        let filtered = filtered_headers(&headers);
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].0, "x-forwarded-test");
    }

    #[test]
    fn pinned_verifier_accepts_only_the_paired_spki() {
        let directory = tempfile::tempdir().unwrap();
        let material = crate::companion_api::tls::ensure_certificate(directory.path()).unwrap();
        let pem = std::fs::read_to_string(material.cert_pem_path).unwrap();
        let der = crate::companion_api::tls::pem_to_der(&pem).unwrap();
        let algorithms = rustls::crypto::ring::default_provider().signature_verification_algorithms;
        let server_name = ServerName::IpAddress(IpAddr::V4([127, 0, 0, 1].into()));
        let verifier = PinnedSpkiVerifier {
            expected: material.fingerprint_sha256,
            algorithms,
        };
        assert!(verifier
            .verify_server_cert(
                &CertificateDer::from(der.clone()),
                &[],
                &server_name,
                &[],
                UnixTime::since_unix_epoch(Duration::ZERO),
            )
            .is_ok());

        let forged = PinnedSpkiVerifier {
            expected: "00".repeat(32),
            algorithms,
        };
        assert!(forged
            .verify_server_cert(
                &CertificateDer::from(der),
                &[],
                &server_name,
                &[],
                UnixTime::since_unix_epoch(Duration::ZERO),
            )
            .is_err());
    }
}

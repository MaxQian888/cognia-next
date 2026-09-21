//! Desktop-side ephemeral relay for a paired host's managed Pro IDE.
//!
//! The embedded webview talks only to a random loopback port. This relay pins
//! the companion certificate before establishing TLS, then adds the existing
//! device JWT and a fresh device proof as HTTP headers. Neither credential appears in
//! the browser URL.

use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{FromRequestParts, Request, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::middleware::{from_fn_with_state, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::Router;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use futures_util::{SinkExt, StreamExt};
use p256::ecdsa::{signature::Signer, Signature, SigningKey};
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
    target: Option<Arc<RelayTarget>>,
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
        device_private_key_jwk: serde_json::Value,
    ) -> Result<DesktopRelayStatus, String> {
        let target = Arc::new(RelayTarget::new(
            base_url,
            device_jwt,
            server_fingerprint,
            relay_path,
            device_private_key_jwk,
        )?);
        let key = target.key();
        let mut running = self.running.lock().await;
        if let Some(existing) = running.as_ref() {
            if existing.key == key && !existing.task.is_finished() {
                // Same host, same relay, same pinned certificate — only the
                // short-lived credential can have changed. Swap it and keep the
                // port so the live workbench never notices.
                if let Some(existing_target) = &existing.target {
                    *existing_target.credentials.write().await =
                        target.credentials.read().await.clone();
                }
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
        let mut router = Router::new()
            .fallback(any(desktop_relay_handler))
            .with_state(Arc::clone(&target));
        if target.is_port() {
            router = router.layer(from_fn_with_state(port, loopback_guard));
        }
        let task = tokio::spawn(async move {
            if let Err(error) = axum::serve(listener, router).await {
                log::warn!("desktop managed IDE relay stopped: {error}");
            }
        });
        *running = Some(RunningRelay {
            key,
            port,
            task,
            target: Some(target),
        });
        Ok(relay_status(port))
    }

    /// A native owner may preview its local container without minting a
    /// fictitious paired-device token. The same streamed Host proxy performs
    /// the port admission checks, on a dedicated loopback browser origin.
    pub async fn ensure_local(
        &self,
        project_id: String,
        container_id: String,
        port: u16,
    ) -> Result<DesktopRelayStatus, String> {
        let runtime = crate::companion_api::environment_pool::installed()
            .and_then(|pool| pool.runtime)
            .ok_or("runtime environment service is unavailable")?;
        if !runtime
            .port_allowed(&project_id, &container_id, port)
            .await
            .map_err(|error| error.to_string())?
        {
            return Err("port is not declared by an active approved runtime".into());
        }
        let key = format!("local:{project_id}\0{container_id}\0{port}");
        let mut running = self.running.lock().await;
        if let Some(existing) = running.as_ref() {
            if existing.key == key && !existing.task.is_finished() {
                return Ok(relay_status(existing.port));
            }
        }
        if let Some(existing) = running.take() {
            existing.stop();
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|error| format!("bind local environment relay: {error}"))?;
        let container_port = port;
        let port = listener
            .local_addr()
            .map_err(|error| error.to_string())?
            .port();
        let router = Router::new()
            .fallback(any(move |request: Request| {
                let project_id = project_id.clone();
                let container_id = container_id.clone();
                async move {
                    crate::companion_api::environment_ports::local_relay(
                        project_id,
                        container_id,
                        container_port,
                        request,
                    )
                    .await
                }
            }))
            .layer(from_fn_with_state(port, loopback_guard));
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        *running = Some(RunningRelay {
            key,
            port,
            task,
            target: None,
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

fn loopback_request_allowed(headers: &HeaderMap, port: u16) -> bool {
    let authority = format!("127.0.0.1:{port}");
    headers.get("host").and_then(|value| value.to_str().ok()) == Some(authority.as_str())
        && headers
            .get("origin")
            .is_none_or(|value| value.to_str().ok() == Some(format!("http://{authority}").as_str()))
}

async fn loopback_guard(State(port): State<u16>, request: Request, next: Next) -> Response {
    if !loopback_request_allowed(request.headers(), port) {
        return StatusCode::FORBIDDEN.into_response();
    }
    next.run(request).await
}

struct RelayTarget {
    base_url: url::Url,
    relay_path: String,
    /// Device access token, replaceable in place — see [`RunningRelay::target`].
    /// A `tokio` lock rather than `parking_lot`: it is read on every proxied
    /// request and upgrade, all of which are `async`, and a sync guard held
    /// across the send would be the classic guard-across-await hazard.
    credentials: tokio::sync::RwLock<RelayCredentials>,
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
        device_private_key_jwk: serde_json::Value,
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
        let credentials = RelayCredentials::new(device_jwt, device_private_key_jwk)?;
        let fingerprint = normalize_fingerprint(&server_fingerprint)?;
        let relay_path = normalize_relay_path(&relay_path)?;
        let tls = pinned_tls_config(&fingerprint)?;
        let http = reqwest::Client::builder()
            .use_preconfigured_tls((*tls).clone())
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .build()
            .map_err(|error| format!("build pinned managed IDE client: {error}"))?;
        Ok(Self {
            base_url,
            relay_path,
            credentials: tokio::sync::RwLock::new(credentials),
            fingerprint,
            tls,
            http,
        })
    }

    /// The token and its proof nonce/key must come from the same refresh.
    async fn request_auth(&self, method: &str, path: &str) -> Result<(String, String), String> {
        let credentials = self.credentials.read().await;
        Ok((
            credentials.device_jwt.clone(),
            credentials.proof(method, path)?,
        ))
    }

    fn is_port(&self) -> bool {
        self.relay_path.starts_with("/api/environment/ports/")
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

/// Native-memory-only signing material. Never serialized or included in Debug.
#[derive(Clone)]
struct RelayCredentials {
    device_jwt: String,
    nonce: String,
    signing_key: SigningKey,
}

impl RelayCredentials {
    fn new(device_jwt: String, jwk: serde_json::Value) -> Result<Self, String> {
        let invalid =
            || "remote relay requires a valid P-256 device key and access token".to_string();
        if jwk["kty"] != "EC" || jwk["crv"] != "P-256" || device_jwt.len() > 64 * 1024 {
            return Err(invalid());
        }
        let decode = |name: &str| {
            URL_SAFE_NO_PAD
                .decode(jwk[name].as_str().ok_or_else(invalid)?)
                .map_err(|_| invalid())
        };
        let private = decode("d")?;
        if private.len() != 32 {
            return Err(invalid());
        }
        let signing_key = SigningKey::from_slice(&private).map_err(|_| invalid())?;
        let public = signing_key.verifying_key().to_sec1_point(false);
        if decode("x")?.as_slice() != &public.as_bytes()[1..33]
            || decode("y")?.as_slice() != &public.as_bytes()[33..65]
        {
            return Err(invalid());
        }
        // The relay cannot verify the Host's process-private JWT signature.
        // This payload read only binds the proof nonce; the Host still verifies
        // the access token, registered key, capability, and proof independently.
        let parts: Vec<_> = device_jwt.split('.').collect();
        if parts.len() != 3 {
            return Err(invalid());
        }
        let claims: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).map_err(|_| invalid())?)
                .map_err(|_| invalid())?;
        let nonce = claims["jti"]
            .as_str()
            .filter(|nonce| !nonce.is_empty() && nonce.len() <= 256)
            .ok_or_else(invalid)?
            .to_string();
        Ok(Self {
            device_jwt,
            nonce,
            signing_key,
        })
    }

    fn proof(&self, method: &str, path: &str) -> Result<String, String> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "system clock is before Unix epoch")?
            .as_secs();
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"ES256","typ":"dpop+jwt"}"#);
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&serde_json::json!({"nonce":self.nonce,"htm":method,"htu":path,"iat":now,"exp":now+60,"jti":uuid::Uuid::new_v4().to_string()})).map_err(|_| "could not encode relay proof")?);
        let input = format!("{header}.{payload}");
        let signature: Signature = self
            .signing_key
            .try_sign(input.as_bytes())
            .map_err(|_| "could not sign relay proof")?;
        Ok(format!(
            "{input}.{}",
            URL_SAFE_NO_PAD.encode(signature.to_bytes())
        ))
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
    let port_path = path
        .strip_prefix("/api/environment/ports/")
        .is_some_and(|suffix| {
            let parts: Vec<_> = suffix.trim_end_matches('/').split('/').collect();
            parts.len() == 3
                && !parts[0].is_empty()
                && !parts[1].is_empty()
                && parts[2].parse::<u16>().is_ok_and(|port| port != 0)
        });
    if !(path.starts_with("/ide/relay/") || port_path)
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
        // The upstream chooses the subprotocol before we acknowledge the
        // browser upgrade. Selecting independently can produce two different
        // protocols on the two sides of the same connection.
        let (upstream, headers) = match connect_pinned_websocket(
            &target,
            request.uri().clone(),
            request.headers().clone(),
        )
        .await
        {
            Ok(connected) => connected,
            Err(status) => return status.into_response(),
        };
        let mut upgrade = ws.max_message_size(MAX_RELAY_MESSAGE_BYTES);
        if let Some(protocol) = headers
            .get("sec-websocket-protocol")
            .and_then(|value| value.to_str().ok())
        {
            upgrade = upgrade.protocols([protocol.to_string()]);
        }
        let mut response = upgrade
            .on_upgrade(move |socket| relay_pinned_websocket(socket, upstream))
            .into_response();
        for (name, value) in response_headers(&headers, target.is_port()) {
            if !name.as_str().starts_with("sec-websocket-") {
                response.headers_mut().append(name, value);
            }
        }
        return response;
    }
    relay_pinned_http(target, request).await
}

async fn relay_pinned_http(target: Arc<RelayTarget>, request: Request) -> Response {
    let url = target.upstream_url(request.uri(), false);
    let method = request.method().clone();
    let mut headers = filtered_headers(request.headers());
    headers.extend(port_application_headers(&target, request.headers()));
    let stream = request.into_body().into_data_stream();
    let path = match url::Url::parse(&url) {
        Ok(url) => url.path().to_string(),
        Err(_) => return StatusCode::BAD_GATEWAY.into_response(),
    };
    let (bearer, proof) = match target.request_auth(method.as_str(), &path).await {
        Ok(auth) => auth,
        Err(_) => return StatusCode::BAD_GATEWAY.into_response(),
    };
    let mut upstream = target
        .http
        .request(method, url)
        .bearer_auth(&bearer)
        .header("dpop", proof)
        .body(reqwest::Body::wrap_stream(stream));
    for (name, value) in headers {
        upstream = upstream.header(name, value);
    }
    // Bound connection/response-header preparation without imposing a total
    // deadline on an SSE response, download, or another streaming body.
    match tokio::time::timeout(Duration::from_secs(60), upstream.send()).await {
        Ok(Ok(response)) => {
            let status = response.status();
            let headers = response_headers(response.headers(), target.is_port());
            let mut output = Response::builder().status(status);
            for (name, value) in headers {
                output = output.header(name, value);
            }
            output
                .body(Body::from_stream(response.bytes_stream()))
                .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response())
        }
        _ => {
            log::warn!("desktop managed IDE relay HTTP failed before response headers");
            StatusCode::BAD_GATEWAY.into_response()
        }
    }
}

type PinnedWebSocket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect_pinned_websocket(
    target: &RelayTarget,
    uri: axum::http::Uri,
    browser_headers: HeaderMap,
) -> Result<(PinnedWebSocket, HeaderMap), StatusCode> {
    let mut request = target
        .upstream_url(&uri, true)
        .into_client_request()
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    let (bearer, proof) = target
        .request_auth("GET", request.uri().path())
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    let auth =
        HeaderValue::from_str(&format!("Bearer {bearer}")).map_err(|_| StatusCode::BAD_GATEWAY)?;
    request
        .headers_mut()
        .insert(axum::http::header::AUTHORIZATION, auth);
    request.headers_mut().insert(
        "dpop",
        HeaderValue::from_str(&proof).map_err(|_| StatusCode::BAD_GATEWAY)?,
    );
    if let Some(protocol) = browser_headers.get(axum::http::header::SEC_WEBSOCKET_PROTOCOL) {
        request
            .headers_mut()
            .insert(axum::http::header::SEC_WEBSOCKET_PROTOCOL, protocol.clone());
    }
    let mut headers = filtered_headers(&browser_headers);
    headers.extend(port_application_headers(target, &browser_headers));
    for (name, value) in headers {
        if !name.as_str().starts_with("sec-websocket-") {
            request.headers_mut().append(name, value);
        }
    }
    let connector = Connector::Rustls(Arc::clone(&target.tls));
    let config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default()
        .max_message_size(Some(MAX_RELAY_MESSAGE_BYTES));
    let (upstream, response) = tokio::time::timeout(
        Duration::from_secs(10),
        connect_async_tls_with_config(request, Some(config), false, Some(connector)),
    )
    .await
    .map_err(|_| StatusCode::BAD_GATEWAY)?
    .map_err(|_| StatusCode::BAD_GATEWAY)?;
    Ok((upstream, response.into_parts().0.headers))
}

async fn relay_pinned_websocket(mut downstream: WebSocket, upstream: PinnedWebSocket) {
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

/// Companion authentication stays separate from the proxied application's
/// own Authorization and virtual Host. The Host consumes these headers only
/// after authenticating the device and workspace; it never forwards its JWT.
fn port_application_headers(
    target: &RelayTarget,
    headers: &HeaderMap,
) -> Vec<(HeaderName, HeaderValue)> {
    if !target.is_port() {
        return Vec::new();
    }
    [
        ("authorization", "x-cognia-port-authorization"),
        ("host", "x-cognia-port-host"),
        ("origin", "x-cognia-port-origin"),
    ]
    .into_iter()
    .filter_map(|(source, destination)| {
        headers
            .get(source)
            .cloned()
            .map(|value| (HeaderName::from_static(destination), value))
    })
    .collect()
}

fn response_headers(headers: &HeaderMap, application: bool) -> Vec<(HeaderName, HeaderValue)> {
    let mut result = filtered_headers(headers);
    if application {
        result.extend(
            headers
                .get_all("authorization")
                .iter()
                .cloned()
                .map(|value| (axum::http::header::AUTHORIZATION, value)),
        );
    }
    result
}

fn filtered_headers(headers: &HeaderMap) -> Vec<(HeaderName, HeaderValue)> {
    let nominated: Vec<_> = headers
        .get_all("connection")
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| {
            value
                .split(',')
                .map(|name| name.trim().to_ascii_lowercase())
        })
        .collect();
    headers
        .iter()
        .filter(|(name, _)| {
            !nominated
                .iter()
                .any(|connection| connection == name.as_str())
                && !matches!(
                    name.as_str(),
                    "authorization"
                        | "dpop"
                        | "origin"
                        | "x-cognia-port-authorization"
                        | "x-cognia-port-host"
                        | "x-cognia-port-origin"
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

    fn device_credentials(nonce: &str) -> (String, serde_json::Value, String) {
        use p256::pkcs8::EncodePublicKey;
        let signing = SigningKey::from_slice(&[1u8; 32]).unwrap();
        let public = signing.verifying_key().to_sec1_point(false);
        let jwk = serde_json::json!({"kty":"EC","crv":"P-256","d":URL_SAFE_NO_PAD.encode([1u8;32]),"x":URL_SAFE_NO_PAD.encode(&public.as_bytes()[1..33]),"y":URL_SAFE_NO_PAD.encode(&public.as_bytes()[33..65])});
        let token = format!(
            "header.{}.signature",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&serde_json::json!({"jti":nonce})).unwrap())
        );
        let pem = p256::PublicKey::from_sec1_bytes(public.as_bytes())
            .unwrap()
            .to_public_key_pem(Default::default())
            .unwrap();
        (token, jwk, pem)
    }

    fn verify_relay_headers(headers: &HeaderMap, nonce: &str, method: &str, path: &str) -> String {
        let (_, _, pem) = device_credentials(nonce);
        assert!(
            !headers.contains_key("origin"),
            "browser origin must not enter native Host authentication"
        );
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        crate::companion_api::api::verify_relay_device_proof(
            &pem,
            headers["dpop"].to_str().unwrap(),
            nonce,
            method,
            path,
            now,
        )
        .unwrap()
    }

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
        assert_eq!(
            normalize_relay_path("/api/environment/ports/project/container/3000").unwrap(),
            "/api/environment/ports/project/container/3000/"
        );
        for invalid in [
            "/api/environment/ports/project/container/0",
            "/api/environment/ports/project/container/65536",
            "/api/environment/ports//container/3000",
            "/api/environment/ports/project/container/3000/extra",
        ] {
            assert!(normalize_relay_path(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn port_application_credentials_are_separate_from_device_credentials() {
        let (token, key, _) = device_credentials("access-jti");
        let target = RelayTarget::new(
            "https://localhost:9443".into(),
            token,
            "ab".repeat(32),
            "/api/environment/ports/project/container/3000".into(),
            key,
        )
        .unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(
            "authorization",
            HeaderValue::from_static("Basic application"),
        );
        headers.insert("host", HeaderValue::from_static("app.local:1234"));
        headers.insert("cookie", HeaderValue::from_static("session=app"));
        headers.insert(
            "x-cognia-port-authorization",
            HeaderValue::from_static("forged"),
        );
        let application: HeaderMap = filtered_headers(&headers)
            .into_iter()
            .chain(port_application_headers(&target, &headers))
            .collect();
        assert_eq!(
            application["x-cognia-port-authorization"],
            "Basic application"
        );
        assert_eq!(application["x-cognia-port-host"], "app.local:1234");
        assert_eq!(application["cookie"], "session=app");
        assert!(!application.contains_key("authorization"));
        assert!(!filtered_headers(&headers)
            .iter()
            .any(|(name, _)| name == "x-cognia-port-authorization"));
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
    fn port_loopback_guards_rebinding_and_cross_origin_but_allows_navigation() {
        let mut headers = HeaderMap::new();
        headers.insert("host", HeaderValue::from_static("127.0.0.1:43210"));
        assert!(loopback_request_allowed(&headers, 43210));
        headers.insert("origin", HeaderValue::from_static("http://127.0.0.1:43210"));
        assert!(loopback_request_allowed(&headers, 43210));
        for origin in ["https://evil.example", "null", "http://127.0.0.1:43211"] {
            headers.insert("origin", HeaderValue::from_str(origin).unwrap());
            assert!(!loopback_request_allowed(&headers, 43210));
        }
        headers.remove("origin");
        headers.insert("host", HeaderValue::from_static("rebound.example:43210"));
        assert!(!loopback_request_allowed(&headers, 43210));
    }

    #[test]
    fn app_response_credentials_and_repeated_cookies_are_preserved() {
        let mut headers = HeaderMap::new();
        headers.append("set-cookie", HeaderValue::from_static("a=1"));
        headers.append("set-cookie", HeaderValue::from_static("b=2"));
        headers.insert(
            "authorization",
            HeaderValue::from_static("Bearer app-token"),
        );
        headers.insert("connection", HeaderValue::from_static("x-hop"));
        headers.insert("x-hop", HeaderValue::from_static("private"));
        let application: HeaderMap = response_headers(&headers, true).into_iter().collect();
        assert_eq!(application.get_all("set-cookie").iter().count(), 2);
        assert_eq!(application["authorization"], "Bearer app-token");
        assert!(!application.contains_key("x-hop"));
        assert!(!response_headers(&headers, false)
            .iter()
            .any(|(name, _)| name == "authorization"));
    }

    #[tokio::test]
    async fn device_proofs_are_fresh_and_bound_to_token_method_and_exact_encoded_path() {
        let (token, key, pem) = device_credentials("first-jti");
        let target = RelayTarget::new(
            "https://localhost:9443".into(),
            token.clone(),
            "ab".repeat(32),
            "/api/environment/ports/project/container/3000".into(),
            key.clone(),
        )
        .unwrap();
        let path = "/api/environment/ports/project/container/3000/a%2Fb";
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        let (bearer, first) = target.request_auth("POST", path).await.unwrap();
        assert_eq!(bearer, token);
        let verify = crate::companion_api::api::verify_relay_device_proof;
        let first_id = verify(&pem, &first, "first-jti", "POST", path, now).unwrap();
        for (nonce, method, bound_path) in [
            ("other", "POST", path),
            ("first-jti", "GET", path),
            ("first-jti", "POST", "/other"),
        ] {
            assert!(verify(&pem, &first, nonce, method, bound_path, now).is_err());
        }
        let (_, second) = target.request_auth("POST", path).await.unwrap();
        assert_ne!(
            first_id,
            verify(&pem, &second, "first-jti", "POST", path, now).unwrap()
        );
        let (fresh_token, _, _) = device_credentials("refreshed-jti");
        *target.credentials.write().await =
            RelayCredentials::new(fresh_token.clone(), key.clone()).unwrap();
        let (bearer, proof) = target.request_auth("GET", path).await.unwrap();
        assert_eq!(bearer, fresh_token);
        verify(&pem, &proof, "refreshed-jti", "GET", path, now).unwrap();
        assert!(RelayCredentials::new("malformed".into(), key.clone()).is_err());
        let mut mismatched = key;
        mismatched["x"] = serde_json::json!(URL_SAFE_NO_PAD.encode([0u8; 32]));
        assert!(RelayCredentials::new(token, mismatched).is_err());
    }

    #[tokio::test]
    async fn real_pinned_websocket_uses_upstream_protocol_and_preserves_application_headers() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let directory = tempfile::tempdir().unwrap();
        let material = crate::companion_api::tls::ensure_certificate(directory.path()).unwrap();
        let tls = axum_server::tls_rustls::RustlsConfig::from_pem_file(
            &material.cert_pem_path,
            &material.key_pem_path,
        )
        .await
        .unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let upstream_port = listener.local_addr().unwrap().port();
        let router =
            Router::new().fallback(any(|ws: WebSocketUpgrade, headers: HeaderMap| async move {
                let (token, _, _) = device_credentials("ws-jti");
                assert_eq!(headers["authorization"], format!("Bearer {token}"));
                verify_relay_headers(
                    &headers,
                    "ws-jti",
                    "GET",
                    "/api/environment/ports/project/container/3000/socket",
                );
                assert!(headers.contains_key("x-cognia-port-origin"));
                assert_eq!(headers["x-cognia-port-authorization"], "Basic application");
                assert_eq!(headers["x-app-token"], "custom");
                assert_eq!(headers.get_all("cookie").iter().count(), 1);
                let mut response = ws
                    .protocols(["second"])
                    .on_upgrade(|mut socket| async move {
                        if let Some(Ok(message)) = socket.recv().await {
                            socket.send(message).await.unwrap();
                        }
                    })
                    .into_response();
                response.headers_mut().insert(
                    "authorization",
                    HeaderValue::from_static("Bearer refreshed-app"),
                );
                response
                    .headers_mut()
                    .append("set-cookie", HeaderValue::from_static("one=1"));
                response
                    .headers_mut()
                    .append("set-cookie", HeaderValue::from_static("two=2"));
                response
            }));
        let server = tokio::spawn(async move {
            axum_server::from_tcp_rustls(listener, tls)
                .unwrap()
                .serve(router.into_make_service())
                .await
                .unwrap();
        });
        let relay = DesktopRelayState::new();
        let (token, key, _) = device_credentials("ws-jti");
        let status = relay
            .ensure(
                format!("https://127.0.0.1:{upstream_port}"),
                token,
                material.fingerprint_sha256,
                "/api/environment/ports/project/container/3000".into(),
                key,
            )
            .await
            .unwrap();
        let mut request = format!("ws://127.0.0.1:{}/socket", status.port)
            .into_client_request()
            .unwrap();
        request.headers_mut().insert(
            "sec-websocket-protocol",
            HeaderValue::from_static("first, second"),
        );
        request.headers_mut().insert(
            "origin",
            HeaderValue::from_str(status.url.trim_end_matches('/')).unwrap(),
        );
        request.headers_mut().insert(
            "authorization",
            HeaderValue::from_static("Basic application"),
        );
        request
            .headers_mut()
            .insert("cookie", HeaderValue::from_static("session=one"));
        request
            .headers_mut()
            .insert("x-app-token", HeaderValue::from_static("custom"));
        let (mut socket, response) = tokio_tungstenite::connect_async(request).await.unwrap();
        assert_eq!(response.headers()["sec-websocket-protocol"], "second");
        assert_eq!(response.headers()["authorization"], "Bearer refreshed-app");
        assert_eq!(response.headers().get_all("set-cookie").iter().count(), 2);
        let bytes = vec![0, 255, 1, 0];
        socket
            .send(tokio_tungstenite::tungstenite::Message::Binary(
                bytes.clone().into(),
            ))
            .await
            .unwrap();
        let echoed = socket.next().await.unwrap().unwrap().into_data();
        assert_eq!(echoed.as_ref(), bytes.as_slice());
        let mut denied = format!("ws://127.0.0.1:{}/socket", status.port)
            .into_client_request()
            .unwrap();
        denied
            .headers_mut()
            .insert("origin", HeaderValue::from_static("https://evil.example"));
        let error = tokio_tungstenite::connect_async(denied).await.unwrap_err();
        assert!(
            matches!(error, tokio_tungstenite::tungstenite::Error::Http(response) if response.status() == StatusCode::FORBIDDEN)
        );
        relay.stop().await;
        server.abort();
    }

    #[tokio::test]
    async fn pinned_http_streams_sse_frames_and_preserves_application_response_headers() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let directory = tempfile::tempdir().unwrap();
        let material = crate::companion_api::tls::ensure_certificate(directory.path()).unwrap();
        let tls = axum_server::tls_rustls::RustlsConfig::from_pem_file(
            &material.cert_pem_path,
            &material.key_pem_path,
        )
        .await
        .unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let upstream_port = listener.local_addr().unwrap().port();
        let (send, receive) = tokio::sync::mpsc::channel::<Vec<u8>>(2);
        let receive = Arc::new(Mutex::new(Some(receive)));
        let router = Router::new().fallback(any(move |headers: HeaderMap| {
            let receive = receive.clone();
            async move {
                let (token, _, _) = device_credentials("http-jti");
                assert_eq!(headers["authorization"], format!("Bearer {token}"));
                verify_relay_headers(
                    &headers,
                    "http-jti",
                    "GET",
                    "/api/environment/ports/project/container/3000/",
                );
                assert_eq!(headers["x-cognia-port-authorization"], "Basic application");
                assert_eq!(headers.get_all("cookie").iter().count(), 1);
                let stream = futures_util::stream::unfold(
                    receive.lock().await.take().unwrap(),
                    |mut receive| async move {
                        receive
                            .recv()
                            .await
                            .map(|bytes| (Ok::<_, std::convert::Infallible>(bytes), receive))
                    },
                );
                Response::builder()
                    .header("content-type", "text/event-stream")
                    .header("authorization", "Bearer app-response")
                    .header("set-cookie", "first=1")
                    .header("set-cookie", "second=2")
                    .body(Body::from_stream(stream))
                    .unwrap()
            }
        }));
        let server = tokio::spawn(async move {
            axum_server::from_tcp_rustls(listener, tls)
                .unwrap()
                .serve(router.into_make_service())
                .await
                .unwrap();
        });
        let relay = DesktopRelayState::new();
        let (token, key, _) = device_credentials("http-jti");
        let status = relay
            .ensure(
                format!("https://127.0.0.1:{upstream_port}"),
                token,
                material.fingerprint_sha256,
                "/api/environment/ports/project/container/3000".into(),
                key,
            )
            .await
            .unwrap();
        send.send(b"data: first\n\n".to_vec()).await.unwrap();
        let response = reqwest::Client::new()
            .get(&status.url)
            .header("authorization", "Basic application")
            .header("cookie", "session=one")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["authorization"], "Bearer app-response");
        assert_eq!(response.headers().get_all("set-cookie").iter().count(), 2);
        let mut stream = response.bytes_stream();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), stream.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap()
                .as_ref(),
            b"data: first\n\n"
        );
        // The upstream cannot send this frame before the caller received the
        // first, proving neither relay buffers the complete response body.
        send.send(b"data: second\n\n".to_vec()).await.unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), stream.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap()
                .as_ref(),
            b"data: second\n\n"
        );
        drop(send);
        assert!(stream.next().await.is_none());
        relay.stop().await;
        server.abort();
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

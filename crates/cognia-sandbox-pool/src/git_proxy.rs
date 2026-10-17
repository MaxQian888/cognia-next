//! The Host-side git proxy of a remote workspace (ADR-0221, D6).
//!
//! A remote sandbox (a Kubernetes pod, an E2B microVM) holds no git
//! credential. Its git talks to `http://127.0.0.1:<port>/repo.git` inside the
//! instance; that port is bridged over the exec channel to one of these
//! proxies, which listens on the Host's loopback and forwards to exactly one
//! upstream repository with the credential added here, on the Host.
//!
//! # What it serves
//!
//! The four smart-HTTP endpoints and nothing else:
//!
//! - `GET /repo.git/info/refs?service=git-upload-pack`
//! - `GET /repo.git/info/refs?service=git-receive-pack`
//! - `POST /repo.git/git-upload-pack` (protocol v0, v1 and v2 alike — v2
//!   only changes the bodies and the `Git-Protocol` header, both forwarded)
//! - `POST /repo.git/git-receive-pack`
//!
//! Every other method, path or query is a 404 that never reaches the
//! upstream. The paths are matched on their raw form, so an encoded
//! `/repo.git/%69nfo/refs` is not a second spelling of the first route.
//!
//! # Push authority
//!
//! Reading is unrestricted: the sandbox may fetch anything in the one
//! repository. Writing is not. Before a receive-pack request is forwarded its
//! command list is read and every command must update `refs/heads/<branch>`
//! to a non-zero object. A push that names another ref, deletes the branch,
//! is signed (`push-cert`), is malformed, or carries a command list larger
//! than [`MAX_COMMAND_SECTION`] bytes or [`MAX_COMMANDS`] commands is answered
//! here, as a receive-pack response the client prints, and the upstream never
//! sees it. An accepted request is forwarded byte for byte: the command
//! section that was read is sent first and the rest of the body (push options,
//! packfile) streams behind it.
//!
//! A gzip-encoded receive-pack request (which a client may send; git itself
//! compresses only upload-pack requests) is inspected through a bounded
//! decoder of its prefix — [`inflate`] — and then forwarded still compressed,
//! so the upstream decodes the very bytes that were checked.
//!
//! # What crosses
//!
//! Requests carry an allowlist of headers (`Content-Type`, `Accept`,
//! `Content-Encoding`, `Git-Protocol`, the framing `Content-Length`, and a
//! `User-Agent` suffixed with `cognia-git-proxy`). The sandbox's own
//! `Authorization` is never forwarded; the Host's credential is added as
//! `Authorization: Basic base64("x-access-token:<token>")`, the form
//! `cognia_git_mirror::credential` gives git. Responses carry their status and
//! `Content-Type`, `Cache-Control` and `Content-Encoding`. Redirects are not
//! followed, so a credential can never be offered to a host it was not issued
//! for. Bodies stream in both directions.
//!
//! # Lifetime
//!
//! [`GitProxy::start`] binds `127.0.0.1:0` and serves until the handle is
//! dropped. Dropping it closes the listener and cuts every in-flight body, so
//! a workspace that is torn down cannot keep a transfer to the upstream open.

use std::future::Future;
use std::net::{IpAddr, Ipv4Addr};
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::header::{
    ACCEPT, AUTHORIZATION, CACHE_CONTROL, CONTENT_ENCODING, CONTENT_LENGTH, CONTENT_TYPE,
    TRANSFER_ENCODING, USER_AGENT,
};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri};
use axum::response::Response;
use axum::Router;
use bytes::Bytes;
use cognia_git_mirror::credential::{redact, GitCredential};
use futures_util::stream::{self, Stream, StreamExt};
use tokio::net::TcpListener;
use tokio::sync::{watch, OwnedSemaphorePermit, Semaphore};
use url::{Host, Url};

/// The largest receive-pack command section read before forwarding. It holds
/// the ref updates (and any `shallow` lines) up to the first flush-pkt; a
/// sandbox that may push one branch has no business sending more.
pub const MAX_COMMAND_SECTION: usize = 64 * 1024;

/// The most ref updates one push may carry. One is all an accepted push can
/// name; the bound is about refusing cleanly, not about what is allowed.
pub const MAX_COMMANDS: usize = 64;

/// The most gzip bytes read while looking for the end of the command section.
/// Deflate can spend input without producing output (empty blocks), so the
/// decoded bound alone would not bound what is buffered.
const MAX_COMPRESSED_PREFIX: usize = 1024 * 1024;

/// The least a receive-pack body must grow by before its prefix is inspected
/// again.
const INSPECTION_STEP: usize = 4 * 1024;

/// Upstream requests one proxy runs at once. A clone or push is a handful of
/// sequential requests; the bound is against a sandbox that opens hundreds.
const MAX_CONCURRENT_UPSTREAM: usize = 8;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// How long an upstream may go without sending a byte. Not a total timeout:
/// a large clone streams for as long as it streams. Long enough for a server
/// that verifies a big pack before it reports.
const READ_TIMEOUT: Duration = Duration::from_secs(600);

/// `git check-ref-format` has no length limit; this one keeps a branch name
/// inside a single pkt-line with room for two object ids.
const MAX_BRANCH_BYTES: usize = 200;

/// The largest pkt-line git reads (`LARGE_PACKET_MAX`).
const MAX_PKT_LEN: usize = 65520;

const GIT_PROTOCOL: HeaderName = HeaderName::from_static("git-protocol");
const RECEIVE_PACK_RESULT: &str = "application/x-git-receive-pack-result";
const PROXY_AGENT: &str = concat!("cognia-git-proxy/", env!("CARGO_PKG_VERSION"));

type BoxError = Box<dyn std::error::Error + Send + Sync>;
type StopSignal = Pin<Box<dyn Future<Output = ()> + Send>>;

/// What one proxy forwards to, and what it lets a push update.
#[derive(Clone)]
pub struct GitProxyConfig {
    /// Upstream clone URL, credential-free, `https://…` (plain `http://` only
    /// when the host is a loopback address — tests use this).
    pub upstream: Url,
    /// Token for the upstream (e.g. a GitHub token). None = anonymous.
    pub credential: Option<String>,
    /// The only branch a push may update: `refs/heads/<branch>`.
    pub branch: String,
}

impl std::fmt::Debug for GitProxyConfig {
    /// A config that prints its token is a token in a log file.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GitProxyConfig")
            .field("upstream", &self.upstream.as_str())
            .field(
                "credential",
                &self.credential.as_ref().map(|_| "<redacted>"),
            )
            .field("branch", &self.branch)
            .finish()
    }
}

/// A running proxy. Serves until dropped.
pub struct GitProxy {
    port: u16,
    stop: watch::Sender<bool>,
}

impl std::fmt::Debug for GitProxy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GitProxy")
            .field("port", &self.port)
            .finish()
    }
}

impl GitProxy {
    /// Validates config (refuse non-https non-loopback upstreams, URLs
    /// carrying userinfo/query/fragment, invalid branch names), binds
    /// 127.0.0.1:0 and serves until dropped.
    pub async fn start(config: GitProxyConfig) -> Result<GitProxy, String> {
        Self::start_with_access(config, GitProxyAccess::TaskBranch).await
    }

    /// Acceptance reconstruction grants fetch only. Both receive-pack discovery
    /// and RPC are refused locally, before credentials or upstream are consulted.
    pub async fn start_read_only(config: GitProxyConfig) -> Result<GitProxy, String> {
        Self::start_with_access(config, GitProxyAccess::ReadOnly).await
    }

    async fn start_with_access(config: GitProxyConfig, access: GitProxyAccess) -> Result<GitProxy, String> {
        let base = validate_upstream(&config.upstream)?;
        if !is_valid_branch(&config.branch) {
            return Err(format!(
                "git proxy: {:?} is not a valid branch name",
                truncate_for_message(config.branch.as_bytes())
            ));
        }
        // The shared credential policy decides what counts as a credential
        // (an empty token does not, so a blank config value cannot become
        // `Basic eC1hY2Nlc3M…`) and redacts it from anything this logs.
        let credential = config
            .credential
            .as_deref()
            .and_then(GitCredential::from_token);
        let authorization = config
            .credential
            .as_deref()
            .filter(|_| credential.is_some())
            .map(basic_authorization)
            .transpose()?;

        cognia_net::proxy_config::ensure_crypto_provider();
        let builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(CONNECT_TIMEOUT)
            .read_timeout(READ_TIMEOUT)
            // Relay what the upstream sent, encoding and all, even if another
            // crate turns on reqwest's decoders through feature unification.
            .no_gzip()
            .no_brotli()
            .no_deflate()
            .no_zstd();
        // The Host's Off/Manual/Auto proxy, bypass list and credentials, as
        // every other Host egress uses.
        let (builder, _route) =
            cognia_net::proxy_config::apply_reqwest_policy(builder, config.upstream.as_str())
                .map_err(|error| format!("git proxy: network policy: {error}"))?;
        let client = builder
            .build()
            .map_err(|error| format!("git proxy: building the upstream client: {error}"))?;

        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|error| format!("git proxy: binding 127.0.0.1:0: {error}"))?;
        let port = listener
            .local_addr()
            .map_err(|error| format!("git proxy: reading the bound address: {error}"))?
            .port();

        let (stop_tx, stop_rx) = watch::channel(false);
        let shared = Arc::new(Shared {
            client,
            access,
            base,
            authorization,
            credential,
            branch_ref: format!("refs/heads/{}", config.branch),
            limiter: Arc::new(Semaphore::new(MAX_CONCURRENT_UPSTREAM)),
            stop: stop_rx.clone(),
        });
        if access == GitProxyAccess::ReadOnly {
            log::info!("git proxy: read-only acceptance proxy listening on loopback");
        } else {
            log::info!("git proxy: serving 127.0.0.1:{port} for {} (task branch {})", shared.base, shared.branch_ref);
        }

        let app = Router::new().fallback(handle).with_state(shared);
        let shutdown = stop_signal(stop_rx);
        tokio::spawn(async move {
            if let Err(error) = axum::serve(listener, app)
                .with_graceful_shutdown(shutdown)
                .await
            {
                log::warn!("git proxy: 127.0.0.1:{port} stopped with an error: {error}");
            }
        });

        Ok(GitProxy {
            port,
            stop: stop_tx,
        })
    }

    /// The Host loopback port the instance's bridge connects to.
    pub fn port(&self) -> u16 {
        self.port
    }
}

impl Drop for GitProxy {
    /// Closes the listener and cuts every body still streaming. The sender
    /// dropping right after does the same on its own; the explicit send makes
    /// the intent readable.
    fn drop(&mut self) {
        let _ = self.stop.send(true);
        log::debug!("git proxy: 127.0.0.1:{} stopped", self.port);
    }
}

/// How long the Host's credential helpers may take to answer.
const CREDENTIAL_FILL_TIMEOUT: Duration = Duration::from_secs(15);

/// The Host's own credential for `upstream`, from its git credential helpers
/// (the desktop keychain, a server's configured helper), for a workspace the
/// brain sent no token with.
///
/// Runs `git credential fill` on the Host — never in the sandbox — with every
/// prompt disabled, so a Host with no helper for that origin answers `None`
/// instead of waiting on a terminal. A helper may still show its own consent
/// dialog (a keychain asking to allow access), which is the same consent a
/// push from this machine would ask for.
pub async fn host_credential(upstream: &Url) -> Option<String> {
    host_credential_with(upstream, &[]).await
}

async fn host_credential_with(upstream: &Url, env: &[(&str, &str)]) -> Option<String> {
    use tokio::io::AsyncWriteExt as _;

    if upstream.scheme() != "https" {
        return None;
    }
    let host = match (upstream.host_str(), upstream.port()) {
        (Some(host), Some(port)) => format!("{host}:{port}"),
        (Some(host), None) => host.to_string(),
        (None, _) => return None,
    };
    let path = upstream.path().trim_start_matches('/');
    let request = format!("protocol=https\nhost={host}\npath={path}\n\n");
    let mut child = tokio::process::Command::new("git")
        .args(["credential", "fill"])
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .env("GIT_ASKPASS", "")
        .env("SSH_ASKPASS", "")
        .envs(env.iter().copied())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .ok()?;
    let mut stdin = child.stdin.take()?;
    stdin.write_all(request.as_bytes()).await.ok()?;
    drop(stdin);
    let output = tokio::time::timeout(CREDENTIAL_FILL_TIMEOUT, child.wait_with_output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout)
        .ok()?
        .lines()
        .find_map(|line| line.strip_prefix("password="))
        .map(str::trim)
        .filter(|password| !password.is_empty())
        .map(str::to_string)
}

/// Branch-name validation used by start() and by the driver: git
/// check-ref-format rules for a branch component path (no `..`, no leading
/// `-` or `/`, no trailing `/` or `.lock`, no `@{`, no control
/// chars/space/~^:?*[\\, max 200 bytes).
///
/// Also refused, as `git branch` refuses them: `HEAD`, `@`, an empty path
/// component (`a//b`), a component starting with `.` or ending with `.lock`,
/// and a name ending with `.`.
pub fn is_valid_branch(branch: &str) -> bool {
    if branch.is_empty() || branch.len() > MAX_BRANCH_BYTES {
        return false;
    }
    if branch == "HEAD" || branch == "@" {
        return false;
    }
    if branch.starts_with('-')
        || branch.starts_with('/')
        || branch.ends_with('/')
        || branch.ends_with('.')
    {
        return false;
    }
    if branch.contains("..") || branch.contains("@{") {
        return false;
    }
    if branch.bytes().any(|byte| {
        byte < 0x20
            || byte == 0x7f
            || matches!(byte, b' ' | b'~' | b'^' | b':' | b'?' | b'*' | b'[' | b'\\')
    }) {
        return false;
    }
    branch.split('/').all(|component| {
        !component.is_empty() && !component.starts_with('.') && !component.ends_with(".lock")
    })
}

/// The upstream base (no trailing slash) the endpoints are appended to.
fn validate_upstream(url: &Url) -> Result<String, String> {
    // Checked first and without echoing the URL: the URL is the secret.
    if !url.username().is_empty() || url.password().is_some() {
        return Err("git proxy: the upstream URL carries credentials; pass the token as the credential instead".into());
    }
    match url.scheme() {
        "https" => {}
        "http" if is_loopback_host(url) => {}
        "http" => {
            return Err(format!(
                "git proxy: refusing plain-http upstream {url}: the credential would cross the network in the clear"
            ))
        }
        other => {
            return Err(format!(
                "git proxy: refusing upstream {url}: scheme {other:?} is not https"
            ))
        }
    }
    if url.cannot_be_a_base() || url.host().is_none() {
        return Err(format!("git proxy: upstream {url} names no host"));
    }
    if url.query().is_some() {
        return Err(format!("git proxy: upstream {url} carries a query"));
    }
    if url.fragment().is_some() {
        return Err(format!("git proxy: upstream {url} carries a fragment"));
    }
    if url.path().trim_matches('/').is_empty() {
        return Err(format!("git proxy: upstream {url} names no repository"));
    }
    Ok(url.as_str().trim_end_matches('/').to_string())
}

/// Loopback by address only: `localhost` is a name, and a name can resolve
/// anywhere.
fn is_loopback_host(url: &Url) -> bool {
    match url.host() {
        Some(Host::Ipv4(ip)) => IpAddr::V4(ip).is_loopback(),
        Some(Host::Ipv6(ip)) => IpAddr::V6(ip).is_loopback(),
        _ => false,
    }
}

/// The header `cognia_git_mirror::credential::auth_env` hands git, built here
/// because `GitCredential` deliberately keeps its basic form private.
fn basic_authorization(token: &str) -> Result<HeaderValue, String> {
    use base64::Engine as _;
    let basic = base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{token}"));
    let mut value = HeaderValue::from_str(&format!("Basic {basic}"))
        .map_err(|_| "git proxy: the credential cannot be sent as a header".to_string())?;
    // Keeps the value out of HTTP/2 header compression tables and `Debug`.
    value.set_sensitive(true);
    Ok(value)
}

/// The code-task publisher and the GUI acceptance reader are distinct grants.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GitProxyAccess {
    TaskBranch,
    ReadOnly,
}

struct Shared {
    access: GitProxyAccess,
    client: reqwest::Client,
    base: String,
    authorization: Option<HeaderValue>,
    credential: Option<GitCredential>,
    branch_ref: String,
    limiter: Arc<Semaphore>,
    stop: watch::Receiver<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Service {
    UploadPack,
    ReceivePack,
}

impl Service {
    fn name(self) -> &'static str {
        match self {
            Service::UploadPack => "git-upload-pack",
            Service::ReceivePack => "git-receive-pack",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Route {
    InfoRefs(Service),
    Rpc(Service),
}

impl Route {
    fn upstream_url(self, base: &str) -> String {
        match self {
            Route::InfoRefs(service) => format!("{base}/info/refs?service={}", service.name()),
            Route::Rpc(service) => format!("{base}/{}", service.name()),
        }
    }
}

/// The one place a request is matched. Raw path and query, exact.
fn route(method: &Method, uri: &Uri) -> Option<Route> {
    match (method, uri.path(), uri.query()) {
        (&Method::GET, "/repo.git/info/refs", Some("service=git-upload-pack")) => {
            Some(Route::InfoRefs(Service::UploadPack))
        }
        (&Method::GET, "/repo.git/info/refs", Some("service=git-receive-pack")) => {
            Some(Route::InfoRefs(Service::ReceivePack))
        }
        (&Method::POST, "/repo.git/git-upload-pack", None) => Some(Route::Rpc(Service::UploadPack)),
        (&Method::POST, "/repo.git/git-receive-pack", None) => {
            Some(Route::Rpc(Service::ReceivePack))
        }
        _ => None,
    }
}

async fn handle(State(shared): State<Arc<Shared>>, request: Request) -> Response {
    let Some(route) = route(request.method(), request.uri()) else {
        log::debug!(
            "git proxy: refused {} {} (not a smart-HTTP route of /repo.git)",
            request.method(),
            request.uri().path()
        );
        return plain(StatusCode::NOT_FOUND, "not found\n");
    };
    if shared.access == GitProxyAccess::ReadOnly
        && matches!(route, Route::InfoRefs(Service::ReceivePack) | Route::Rpc(Service::ReceivePack))
    {
        return plain(StatusCode::FORBIDDEN, "read-only git proxy\n");
    }
    let stop = stop_signal(shared.stop.clone());
    tokio::select! {
        response = serve(shared.clone(), route, request) => response,
        _ = stop => plain(StatusCode::SERVICE_UNAVAILABLE, "the git proxy is stopping\n"),
    }
}

async fn serve(shared: Arc<Shared>, route: Route, request: Request) -> Response {
    let Ok(permit) = shared.limiter.clone().acquire_owned().await else {
        return plain(
            StatusCode::SERVICE_UNAVAILABLE,
            "the git proxy is stopping\n",
        );
    };
    let (parts, body) = request.into_parts();
    match route {
        Route::InfoRefs(_) => forward(&shared, route, &parts.headers, None, permit).await,
        Route::Rpc(Service::UploadPack) => {
            let body = reqwest::Body::wrap_stream(Guarded::new(
                body.into_data_stream(),
                &shared.stop,
                None,
            ));
            forward(&shared, route, &parts.headers, Some(body), permit).await
        }
        Route::Rpc(Service::ReceivePack) => {
            receive_pack(&shared, &parts.headers, body, permit).await
        }
    }
}

/// Reads the command section, decides, and either forwards the whole body or
/// answers the push here.
async fn receive_pack(
    shared: &Shared,
    headers: &HeaderMap,
    body: Body,
    permit: OwnedSemaphorePermit,
) -> Response {
    let encoding = BodyEncoding::of(headers);
    let mut incoming = Guarded::new(body.into_data_stream(), &shared.stop, None);
    let mut buffered: Vec<u8> = Vec::new();
    let mut eof = false;
    // Re-inspecting after every chunk would let a client that sends one byte
    // at a time make the proxy decode the same prefix a million times; the
    // threshold grows geometrically, so the total work stays linear in what
    // was read.
    let mut next_inspection = 1usize;
    loop {
        if !eof && buffered.len() < next_inspection {
            match incoming.next().await {
                Some(Ok(chunk)) => buffered.extend_from_slice(&chunk),
                Some(Err(error)) => {
                    log::debug!("git proxy: a push request body broke off: {error}");
                    return plain(StatusCode::BAD_REQUEST, "the request body broke off\n");
                }
                None => eof = true,
            }
            continue;
        }
        match inspect(&buffered, &encoding, eof, &shared.branch_ref) {
            Inspection::Accept => break,
            Inspection::Refuse(refusal) => {
                log::warn!(
                    "git proxy: refused a push to {}: {}",
                    shared.base,
                    refusal.log_line()
                );
                // Read the rest before answering: a client still uploading
                // its pack when the connection closes reports a broken pipe
                // instead of the refusal.
                while let Some(item) = incoming.next().await {
                    if item.is_err() {
                        break;
                    }
                }
                drop(permit);
                return refusal.into_response();
            }
            Inspection::NeedMore => {
                // Never past the bound, so the refusal comes as soon as the
                // body crosses it rather than after another doubling.
                let bound = match encoding {
                    BodyEncoding::Gzip => MAX_COMPRESSED_PREFIX,
                    _ => MAX_COMMAND_SECTION,
                };
                next_inspection = (buffered.len() * 2)
                    .max(buffered.len() + INSPECTION_STEP)
                    .min(bound);
            }
        }
    }
    // The section that was read goes first, byte for byte, then the rest of
    // the body exactly as it arrives.
    let prefix = Bytes::from(buffered);
    let body = reqwest::Body::wrap_stream(
        stream::iter(std::iter::once(Ok::<Bytes, BoxError>(prefix))).chain(incoming),
    );
    forward(
        shared,
        Route::Rpc(Service::ReceivePack),
        headers,
        Some(body),
        permit,
    )
    .await
}

async fn forward(
    shared: &Shared,
    route: Route,
    headers: &HeaderMap,
    body: Option<reqwest::Body>,
    permit: OwnedSemaphorePermit,
) -> Response {
    let url = route.upstream_url(&shared.base);
    let method = match route {
        Route::InfoRefs(_) => reqwest::Method::GET,
        Route::Rpc(_) => reqwest::Method::POST,
    };
    let mut upstream_headers = HeaderMap::new();
    for name in [CONTENT_TYPE, ACCEPT, CONTENT_ENCODING, GIT_PROTOCOL] {
        for value in headers.get_all(&name) {
            upstream_headers.append(name.clone(), value.clone());
        }
    }
    if body.is_some() && !headers.contains_key(TRANSFER_ENCODING) {
        // Every forwarded body is byte-identical to the one received, so its
        // declared length still holds and the upstream gets the framing git
        // chose rather than a chunked rewrite. Never alongside a
        // Transfer-Encoding, which overrides it; hyper's length encoder also
        // refuses a body that does not match.
        let mut lengths = headers.get_all(CONTENT_LENGTH).iter();
        if let (Some(length), None) = (lengths.next(), lengths.next()) {
            upstream_headers.insert(CONTENT_LENGTH, length.clone());
        }
    }
    upstream_headers.insert(USER_AGENT, user_agent(headers));
    if let Some(authorization) = &shared.authorization {
        upstream_headers.insert(AUTHORIZATION, authorization.clone());
    }

    let mut call = shared
        .client
        .request(method, &url)
        .headers(upstream_headers);
    if let Some(body) = body {
        call = call.body(body);
    }
    let upstream = match call.send().await {
        Ok(upstream) => upstream,
        Err(error) => {
            // Reqwest errors name the URL, which carries no credential, and
            // never the headers; the redactor is the backstop all the same.
            if shared.access == GitProxyAccess::ReadOnly {
                log::warn!("git proxy: read-only upstream request failed");
            } else {
                log::warn!("git proxy: {url} failed: {}", redact(&error.to_string(), shared.credential.as_ref()));
            }
            return plain(
                StatusCode::BAD_GATEWAY,
                "the upstream git server is unreachable\n",
            );
        }
    };
    let status = upstream.status();
    if shared.access == GitProxyAccess::ReadOnly {
        if !status.is_success() { log::debug!("git proxy: read-only upstream answered {status}"); }
    } else if status.is_redirection() {
        log::warn!("git proxy: {url} answered {status}; redirects are not followed");
    } else if !status.is_success() {
        log::debug!("git proxy: {url} answered {status}");
    }
    let mut response = Response::builder().status(status.as_u16());
    for name in [CONTENT_TYPE, CACHE_CONTROL, CONTENT_ENCODING] {
        for value in upstream.headers().get_all(&name) {
            response = response.header(name.clone(), value.clone());
        }
    }
    // The permit rides with the response body: an upstream request counts
    // until its last byte has been relayed.
    let body = Body::from_stream(Guarded::new(
        upstream.bytes_stream(),
        &shared.stop,
        Some(permit),
    ));
    response
        .body(body)
        .unwrap_or_else(|_| plain(StatusCode::BAD_GATEWAY, "unrelayable upstream response\n"))
}

/// The client's agent with this proxy appended, so a server that keys on a
/// `git/` prefix still sees one, and the upstream's logs still show which
/// git made the request.
fn user_agent(headers: &HeaderMap) -> HeaderValue {
    headers
        .get(USER_AGENT)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .and_then(|value| HeaderValue::from_str(&format!("{value} {PROXY_AGENT}")).ok())
        .unwrap_or_else(|| HeaderValue::from_static(PROXY_AGENT))
}

fn plain(status: StatusCode, message: &'static str) -> Response {
    let mut response = Response::new(Body::from(message));
    *response.status_mut() = status;
    response.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    response
}

fn stop_signal(mut stop: watch::Receiver<bool>) -> StopSignal {
    // `wait_for` also returns when the sender is gone, which is the same
    // thing: the proxy handle no longer exists.
    Box::pin(async move {
        let _ = stop.wait_for(|stopped| *stopped).await;
    })
}

/// A body stream that ends with an error the moment the proxy stops, and that
/// optionally holds a concurrency permit until it is finished or dropped.
struct Guarded {
    inner: Pin<Box<dyn Stream<Item = Result<Bytes, BoxError>> + Send>>,
    stop: StopSignal,
    permit: Option<OwnedSemaphorePermit>,
    done: bool,
}

impl Guarded {
    fn new<S, E>(
        inner: S,
        stop: &watch::Receiver<bool>,
        permit: Option<OwnedSemaphorePermit>,
    ) -> Self
    where
        S: Stream<Item = Result<Bytes, E>> + Send + 'static,
        E: Into<BoxError>,
    {
        Self {
            inner: Box::pin(inner.map(|item| item.map_err(Into::into))),
            stop: stop_signal(stop.clone()),
            permit,
            done: false,
        }
    }

    fn finish(&mut self) {
        self.done = true;
        self.permit = None;
    }
}

impl Stream for Guarded {
    type Item = Result<Bytes, BoxError>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if self.done {
            return Poll::Ready(None);
        }
        if self.stop.as_mut().poll(cx).is_ready() {
            self.finish();
            return Poll::Ready(Some(Err("the git proxy stopped".into())));
        }
        match self.inner.as_mut().poll_next(cx) {
            Poll::Ready(Some(Ok(chunk))) => Poll::Ready(Some(Ok(chunk))),
            Poll::Ready(Some(Err(error))) => {
                self.finish();
                Poll::Ready(Some(Err(error)))
            }
            Poll::Ready(None) => {
                self.finish();
                Poll::Ready(None)
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

// ---------------------------------------------------------------------------
// The receive-pack command section.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
enum BodyEncoding {
    Identity,
    Gzip,
    /// Anything the proxy cannot decode, so cannot check.
    Unsupported(String),
}

impl BodyEncoding {
    /// `gzip` and `x-gzip` as `git http-backend` accepts them; a stacked or
    /// repeated encoding is not something git sends and is not decoded.
    fn of(headers: &HeaderMap) -> Self {
        let mut values = headers.get_all(CONTENT_ENCODING).iter();
        let (first, second) = (values.next(), values.next());
        let Some(first) = first else {
            return BodyEncoding::Identity;
        };
        let text = String::from_utf8_lossy(first.as_bytes())
            .trim()
            .to_ascii_lowercase();
        if second.is_some() {
            return BodyEncoding::Unsupported(format!("{text}, …"));
        }
        match text.as_str() {
            "" | "identity" => BodyEncoding::Identity,
            "gzip" | "x-gzip" => BodyEncoding::Gzip,
            _ => BodyEncoding::Unsupported(text),
        }
    }
}

/// The capabilities of a push that decide how a refusal is spelled.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct Capabilities {
    side_band_64k: bool,
    side_band: bool,
    report_status: bool,
    report_status_v2: bool,
}

impl Capabilities {
    /// `receive-pack` reads a feature list after a NUL on any command line and
    /// ORs it in, so this does too.
    fn absorb(&mut self, list: &[u8]) {
        for token in list.split(|byte| *byte == b' ') {
            match token {
                b"side-band-64k" => self.side_band_64k = true,
                b"side-band" => self.side_band = true,
                b"report-status" => self.report_status = true,
                b"report-status-v2" => self.report_status_v2 = true,
                _ => {}
            }
        }
    }

    fn reports(self) -> bool {
        self.report_status || self.report_status_v2
    }

    /// The largest pkt-line a side-band packet may be, when one was asked for.
    fn side_band_packet(self) -> Option<usize> {
        if self.side_band_64k {
            Some(MAX_PKT_LEN)
        } else if self.side_band {
            Some(1000)
        } else {
            None
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RefUpdate {
    old: Vec<u8>,
    new: Vec<u8>,
    refname: Vec<u8>,
}

impl RefUpdate {
    fn is_delete(&self) -> bool {
        self.new.iter().all(|byte| *byte == b'0')
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CommandSection {
    capabilities: Capabilities,
    updates: Vec<RefUpdate>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum SectionParse {
    /// No flush-pkt yet, and the section is still under the bound.
    Incomplete,
    Complete(CommandSection),
    Malformed {
        reason: String,
        capabilities: Capabilities,
    },
}

/// Parses the command list at the start of a receive-pack request body, the
/// way `receive-pack`'s `read_head_info` reads it: pkt-lines up to the first
/// flush-pkt, each a `shallow <oid>` or an `<old> <new> <ref>` update with an
/// optional NUL-separated feature list. Anything `receive-pack` would die on
/// is malformed here too; a few things it would accept are also refused —
/// `push-cert` (a signed push, whose updates live inside the certificate),
/// a `shallow` line with trailing bytes, and object ids of mixed lengths.
fn parse_command_section(buf: &[u8]) -> SectionParse {
    let mut capabilities = Capabilities::default();
    let mut updates = Vec::new();
    let mut oid_len: Option<usize> = None;
    let mut pos = 0usize;
    let malformed = |reason: String, capabilities: Capabilities| SectionParse::Malformed {
        reason,
        capabilities,
    };
    let oversized = |capabilities: Capabilities| SectionParse::Malformed {
        reason: format!("its command list is larger than {MAX_COMMAND_SECTION} bytes"),
        capabilities,
    };
    loop {
        if pos + 4 > MAX_COMMAND_SECTION {
            return oversized(capabilities);
        }
        if pos + 4 > buf.len() {
            return SectionParse::Incomplete;
        }
        let Some(len) = parse_pkt_len(&buf[pos..pos + 4]) else {
            return malformed("a pkt-line length is not hexadecimal".into(), capabilities);
        };
        match len {
            0 => {
                return SectionParse::Complete(CommandSection {
                    capabilities,
                    updates,
                })
            }
            1..=4 => {
                return malformed(
                    format!("unexpected special or empty pkt-line {len:04x} in the command list"),
                    capabilities,
                )
            }
            _ if len > MAX_PKT_LEN => {
                return malformed("a pkt-line is longer than git allows".into(), capabilities)
            }
            _ => {}
        }
        if pos + len > MAX_COMMAND_SECTION {
            return oversized(capabilities);
        }
        if pos + len > buf.len() {
            return SectionParse::Incomplete;
        }
        let mut payload = &buf[pos + 4..pos + len];
        pos += len;
        if let Some(chomped) = payload.strip_suffix(b"\n") {
            payload = chomped;
        }

        if let Some(oid) = payload.strip_prefix(b"shallow ") {
            if !accept_oid(oid, &mut oid_len) {
                return malformed(
                    "a shallow line carries no valid object id".into(),
                    capabilities,
                );
            }
            continue;
        }

        let (line, features) = match payload.iter().position(|byte| *byte == 0) {
            Some(nul) => (&payload[..nul], Some(&payload[nul + 1..])),
            None => (payload, None),
        };
        if let Some(features) = features {
            capabilities.absorb(features);
        }
        if line == b"push-cert" {
            return malformed(
                "signed pushes are not supported through the sandbox git proxy".into(),
                capabilities,
            );
        }
        let Some(update) = parse_update(line, &mut oid_len) else {
            return malformed(
                format!(
                    "expected `<old-oid> <new-oid> <ref>`, got {:?}",
                    truncate_for_message(line)
                ),
                capabilities,
            );
        };
        if updates.len() == MAX_COMMANDS {
            return malformed(
                format!("it updates more than {MAX_COMMANDS} refs"),
                capabilities,
            );
        }
        updates.push(update);
    }
}

fn parse_update(line: &[u8], oid_len: &mut Option<usize>) -> Option<RefUpdate> {
    let mut fields = line.splitn(3, |byte| *byte == b' ');
    let old = fields.next()?;
    let new = fields.next()?;
    let refname = fields.next()?;
    if refname.is_empty() || !accept_oid(old, oid_len) || !accept_oid(new, oid_len) {
        return None;
    }
    Some(RefUpdate {
        old: old.to_vec(),
        new: new.to_vec(),
        refname: refname.to_vec(),
    })
}

/// A SHA-1 (40) or SHA-256 (64) hex object id, of the same length as every
/// other id in the section.
fn accept_oid(oid: &[u8], oid_len: &mut Option<usize>) -> bool {
    if !matches!(oid.len(), 40 | 64) || !oid.iter().all(u8::is_ascii_hexdigit) {
        return false;
    }
    match oid_len {
        Some(len) => *len == oid.len(),
        None => {
            *oid_len = Some(oid.len());
            true
        }
    }
}

fn parse_pkt_len(digits: &[u8]) -> Option<usize> {
    let text = std::str::from_utf8(digits).ok()?;
    if !text.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    usize::from_str_radix(text, 16).ok()
}

enum Inspection {
    NeedMore,
    Accept,
    Refuse(Refusal),
}

/// Decides on what has been read so far. `eof` means the body has ended.
fn inspect(buffered: &[u8], encoding: &BodyEncoding, eof: bool, branch_ref: &str) -> Inspection {
    let parsed = match encoding {
        BodyEncoding::Unsupported(name) => {
            return Inspection::Refuse(Refusal::malformed(
                branch_ref,
                format!("its content encoding {name:?} cannot be inspected"),
                Capabilities::default(),
            ))
        }
        BodyEncoding::Identity => {
            let parsed = parse_command_section(buffered);
            if parsed == SectionParse::Incomplete && eof {
                return Inspection::Refuse(Refusal::truncated(branch_ref));
            }
            parsed
        }
        BodyEncoding::Gzip => {
            let (decoded, progress) = match inflate::gunzip_prefix(buffered, MAX_COMMAND_SECTION) {
                Ok(decoded) => decoded,
                Err(reason) => {
                    return Inspection::Refuse(Refusal::malformed(
                        branch_ref,
                        format!("its gzip body does not decode ({reason})"),
                        Capabilities::default(),
                    ))
                }
            };
            let parsed = parse_command_section(&decoded);
            if parsed == SectionParse::Incomplete {
                if eof || progress == inflate::Progress::StreamEnd {
                    return Inspection::Refuse(Refusal::truncated(branch_ref));
                }
                if buffered.len() >= MAX_COMPRESSED_PREFIX {
                    return Inspection::Refuse(Refusal::malformed(
                        branch_ref,
                        format!(
                            "its command list does not end within {MAX_COMPRESSED_PREFIX} compressed bytes"
                        ),
                        Capabilities::default(),
                    ));
                }
            }
            parsed
        }
    };
    match parsed {
        SectionParse::Incomplete => Inspection::NeedMore,
        SectionParse::Malformed {
            reason,
            capabilities,
        } => Inspection::Refuse(Refusal::malformed(branch_ref, reason, capabilities)),
        SectionParse::Complete(section) => match authorize(&section, branch_ref) {
            Ok(()) => Inspection::Accept,
            Err(refusal) => Inspection::Refuse(refusal),
        },
    }
}

/// Every update must move `branch_ref` to a non-zero object. A push with no
/// updates at all is allowed through: `receive-pack` does nothing with it,
/// and it is how git probes a large push (`0000` alone) before sending it.
fn authorize(section: &CommandSection, branch_ref: &str) -> Result<(), Refusal> {
    let verdicts: Vec<Option<String>> = section
        .updates
        .iter()
        .map(|update| {
            if update.refname != branch_ref.as_bytes() {
                Some(format!("the sandbox may only push {branch_ref}"))
            } else if update.is_delete() {
                Some(format!("the sandbox may not delete {branch_ref}"))
            } else {
                None
            }
        })
        .collect();
    if verdicts.iter().all(Option::is_none) {
        return Ok(());
    }
    let offending: Vec<String> = section
        .updates
        .iter()
        .zip(&verdicts)
        .filter(|(_, verdict)| verdict.is_some())
        .map(|(update, _)| {
            let name = truncate_for_message(&update.refname);
            if update.is_delete() {
                format!("delete {name}")
            } else {
                name
            }
        })
        .collect();
    let shown = offending
        .iter()
        .take(5)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    let more = offending.len().saturating_sub(5);
    let summary = if more > 0 {
        format!("{shown} and {more} more")
    } else {
        shown
    };
    let report = section
        .updates
        .iter()
        .zip(verdicts)
        .map(|(update, verdict)| {
            (
                update.refname.clone(),
                verdict.unwrap_or_else(|| "refused with the rest of this push".to_string()),
            )
        })
        .collect();
    Err(Refusal {
        message: format!(
            "cognia git proxy: this sandbox may only push {branch_ref}; refused: {summary}"
        ),
        capabilities: section.capabilities,
        report: Some(report),
    })
}

/// A push answered by the proxy instead of the upstream.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Refusal {
    /// One line, shown to the user by their git.
    message: String,
    capabilities: Capabilities,
    /// Per-ref statuses, when the updates could be read.
    report: Option<Vec<(Vec<u8>, String)>>,
}

impl Refusal {
    fn malformed(branch_ref: &str, reason: String, capabilities: Capabilities) -> Self {
        Self {
            message: format!(
                "cognia git proxy: refused a push that cannot be checked ({reason}); this sandbox may only push {branch_ref}"
            ),
            capabilities,
            report: None,
        }
    }

    fn truncated(branch_ref: &str) -> Self {
        Self::malformed(
            branch_ref,
            "its body ended inside the command list".into(),
            Capabilities::default(),
        )
    }

    fn log_line(&self) -> &str {
        &self.message
    }

    /// The receive-pack response a git client prints.
    ///
    /// - With side-band: the message on band 2 (git shows it as `remote:`),
    ///   then the report-status on band 1 when the updates are known (each
    ///   ref shows as `[remote rejected]`), otherwise the message on band 3,
    ///   which git treats as a fatal remote error.
    /// - Without side-band but with report-status: the report-status alone,
    ///   or an `ERR` packet when the updates could not be read.
    /// - With neither, git would not read a body at all and would call the
    ///   push a success, so the refusal is an HTTP 403 instead.
    fn into_response(self) -> Response {
        let capabilities = self.capabilities;
        let report = self
            .report
            .as_deref()
            .filter(|_| capabilities.reports())
            .and_then(report_status);
        let line = format!("{}\n", self.message);
        let body = if let Some(packet) = capabilities.side_band_packet() {
            let mut body = side_band(2, line.as_bytes(), packet);
            match &report {
                Some(report) => body.extend(side_band(1, report, packet)),
                None => body.extend(side_band(3, line.as_bytes(), packet)),
            }
            body.extend_from_slice(b"0000");
            body
        } else if let Some(report) = report {
            report
        } else if capabilities.reports() {
            pkt_line(format!("ERR {line}").as_bytes())
        } else {
            let mut response = Response::new(Body::from(line));
            *response.status_mut() = StatusCode::FORBIDDEN;
            response.headers_mut().insert(
                CONTENT_TYPE,
                HeaderValue::from_static("text/plain; charset=utf-8"),
            );
            return response;
        };
        let mut response = Response::new(Body::from(body));
        response
            .headers_mut()
            .insert(CONTENT_TYPE, HeaderValue::from_static(RECEIVE_PACK_RESULT));
        response
            .headers_mut()
            .insert(CACHE_CONTROL, HeaderValue::from_static("no-cache"));
        response
    }
}

/// `unpack <reason>`, one `ng <ref> <reason>` per update, flush. `None` when a
/// ref name is too long to echo back in one pkt-line, in which case the
/// caller sends the message alone.
fn report_status(report: &[(Vec<u8>, String)]) -> Option<Vec<u8>> {
    let mut out = pkt_line(b"unpack push refused by the sandbox git proxy\n");
    for (refname, reason) in report {
        let mut line = Vec::with_capacity(refname.len() + reason.len() + 5);
        line.extend_from_slice(b"ng ");
        line.extend_from_slice(refname);
        line.push(b' ');
        line.extend_from_slice(reason.as_bytes());
        line.push(b'\n');
        if line.len() + 4 > MAX_PKT_LEN {
            return None;
        }
        out.extend(pkt_line(&line));
    }
    out.extend_from_slice(b"0000");
    Some(out)
}

/// One pkt-line. The payload must fit `MAX_PKT_LEN - 4`; callers check.
fn pkt_line(payload: &[u8]) -> Vec<u8> {
    debug_assert!(payload.len() + 4 <= MAX_PKT_LEN);
    let mut out = format!("{:04x}", payload.len() + 4).into_bytes();
    out.extend_from_slice(payload);
    out
}

/// `data` on side-band `band`, split over as many packets as it needs.
fn side_band(band: u8, data: &[u8], max_packet: usize) -> Vec<u8> {
    let per_packet = max_packet - 5;
    let mut out = Vec::with_capacity(data.len() + 5 * (data.len() / per_packet + 1));
    for chunk in data.chunks(per_packet) {
        let mut payload = Vec::with_capacity(chunk.len() + 1);
        payload.push(band);
        payload.extend_from_slice(chunk);
        out.extend(pkt_line(&payload));
    }
    out
}

/// Printable and short, for a message a terminal shows or a log keeps.
fn truncate_for_message(bytes: &[u8]) -> String {
    const LIMIT: usize = 120;
    let mut text: String = String::from_utf8_lossy(&bytes[..bytes.len().min(LIMIT)])
        .chars()
        .map(|c| if c.is_control() { '?' } else { c })
        .collect();
    if bytes.len() > LIMIT {
        text.push('…');
    }
    text
}

/// A decoder for the start of a gzip stream (RFC 1952 around RFC 1951).
///
/// It exists for one job: reading a receive-pack command section out of a
/// gzip-encoded request without decoding (or buffering) the packfile behind
/// it. It is stateless — each call decodes from the first byte of the input it
/// is given — and it stops at whichever comes first: the output limit, the end
/// of the input, or the end of the deflate stream. Output is only ever whole
/// symbols, so a prefix of the input decodes to a prefix of the output.
///
/// It is at least as strict as zlib: over-subscribed and (except for the
/// single one-bit code the format allows) incomplete Huffman codes, distances
/// reaching before the start of the output, invalid length and distance
/// symbols, and a stored block whose length check fails are all errors. The
/// request is forwarded still compressed, so the upstream's own decoder reads
/// the bytes this one checked; a disagreement could only make the upstream
/// reject a push this decoder accepted, never the other way round.
mod inflate {
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub(super) enum Progress {
        /// The input ran out; more of it may decode to more output.
        InputExhausted,
        /// The final deflate block ended.
        StreamEnd,
        /// The output reached the limit.
        OutputLimit,
    }

    enum Stop {
        NeedInput,
        Error(&'static str),
    }

    const MAX_BITS: usize = 15;
    const MAX_LCODES: usize = 286;
    const MAX_DCODES: usize = 30;
    const FIX_LCODES: usize = 288;

    const LBASE: [u16; 29] = [
        3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115,
        131, 163, 195, 227, 258,
    ];
    const LEXT: [u8; 29] = [
        0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
    ];
    const DBASE: [u16; 30] = [
        1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537,
        2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
    ];
    const DEXT: [u8; 30] = [
        0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12,
        13, 13,
    ];
    const CODE_LENGTH_ORDER: [usize; 19] = [
        16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
    ];

    /// Decodes the start of a gzip member, up to about `limit` output bytes.
    pub(super) fn gunzip_prefix(
        input: &[u8],
        limit: usize,
    ) -> Result<(Vec<u8>, Progress), &'static str> {
        match header_len(input)? {
            Some(start) => inflate_prefix(&input[start..], limit),
            None => Ok((Vec::new(), Progress::InputExhausted)),
        }
    }

    /// The length of the gzip member header, `None` while it is incomplete.
    fn header_len(input: &[u8]) -> Result<Option<usize>, &'static str> {
        const MAGIC: [u8; 3] = [0x1f, 0x8b, 8];
        let known = input.len().min(3);
        if input[..known] != MAGIC[..known] {
            return Err("not a gzip stream");
        }
        if input.len() < 10 {
            return Ok(None);
        }
        let flags = input[3];
        if flags & 0xe0 != 0 {
            return Err("reserved gzip header flags are set");
        }
        let mut pos = 10usize;
        if flags & 0x04 != 0 {
            // FEXTRA
            if input.len() < pos + 2 {
                return Ok(None);
            }
            let extra = usize::from(u16::from_le_bytes([input[pos], input[pos + 1]]));
            pos += 2 + extra;
            if input.len() < pos {
                return Ok(None);
            }
        }
        for flag in [0x08u8, 0x10] {
            // FNAME, FCOMMENT: zero-terminated.
            if flags & flag != 0 {
                match input[pos.min(input.len())..].iter().position(|b| *b == 0) {
                    Some(end) => pos += end + 1,
                    None => return Ok(None),
                }
            }
        }
        if flags & 0x02 != 0 {
            // FHCRC
            pos += 2;
        }
        if input.len() < pos {
            return Ok(None);
        }
        Ok(Some(pos))
    }

    /// Decodes the start of a raw deflate stream.
    pub(super) fn inflate_prefix(
        input: &[u8],
        limit: usize,
    ) -> Result<(Vec<u8>, Progress), &'static str> {
        let mut state = State {
            input,
            pos: 0,
            bit_buf: 0,
            bit_count: 0,
            out: Vec::new(),
            limit,
        };
        match state.blocks() {
            Ok(progress) => Ok((state.out, progress)),
            Err(Stop::NeedInput) => Ok((state.out, Progress::InputExhausted)),
            Err(Stop::Error(reason)) => Err(reason),
        }
    }

    struct Huffman {
        count: [u16; MAX_BITS + 1],
        symbol: Vec<u16>,
    }

    impl Huffman {
        /// The canonical code for `lengths`, and how many codes short of
        /// complete it is (negative: over-subscribed).
        fn new(lengths: &[u8]) -> (Self, i32) {
            let mut count = [0u16; MAX_BITS + 1];
            for &length in lengths {
                count[usize::from(length)] += 1;
            }
            let mut huffman = Huffman {
                count,
                symbol: vec![0; lengths.len()],
            };
            if usize::from(count[0]) == lengths.len() {
                return (huffman, 0);
            }
            let mut left: i32 = 1;
            for &codes in &count[1..] {
                left <<= 1;
                left -= i32::from(codes);
                if left < 0 {
                    return (huffman, left);
                }
            }
            let mut offsets = [0u16; MAX_BITS + 1];
            for length in 1..MAX_BITS {
                offsets[length + 1] = offsets[length] + count[length];
            }
            for (symbol, &length) in lengths.iter().enumerate() {
                if length != 0 {
                    let slot = &mut offsets[usize::from(length)];
                    huffman.symbol[usize::from(*slot)] = symbol as u16;
                    *slot += 1;
                }
            }
            (huffman, left)
        }
    }

    struct State<'a> {
        input: &'a [u8],
        pos: usize,
        bit_buf: u64,
        bit_count: u32,
        out: Vec<u8>,
        limit: usize,
    }

    enum Block {
        Done,
        OutputLimit,
    }

    impl State<'_> {
        fn bits(&mut self, need: u32) -> Result<u32, Stop> {
            let mut value = self.bit_buf;
            while self.bit_count < need {
                let Some(&byte) = self.input.get(self.pos) else {
                    return Err(Stop::NeedInput);
                };
                self.pos += 1;
                value |= u64::from(byte) << self.bit_count;
                self.bit_count += 8;
            }
            self.bit_buf = value >> need;
            self.bit_count -= need;
            Ok((value & ((1u64 << need) - 1)) as u32)
        }

        fn decode(&mut self, huffman: &Huffman) -> Result<usize, Stop> {
            let (mut code, mut first, mut index) = (0i32, 0i32, 0i32);
            for length in 1..=MAX_BITS {
                code |= self.bits(1)? as i32;
                let count = i32::from(huffman.count[length]);
                if code - count < first {
                    return Ok(usize::from(
                        huffman.symbol[(index + (code - first)) as usize],
                    ));
                }
                index += count;
                first += count;
                first <<= 1;
                code <<= 1;
            }
            Err(Stop::Error("a Huffman code is out of range"))
        }

        fn blocks(&mut self) -> Result<Progress, Stop> {
            loop {
                let last = self.bits(1)?;
                let block = match self.bits(2)? {
                    0 => self.stored()?,
                    1 => self.fixed()?,
                    2 => self.dynamic()?,
                    _ => return Err(Stop::Error("invalid deflate block type")),
                };
                if let Block::OutputLimit = block {
                    return Ok(Progress::OutputLimit);
                }
                if last == 1 {
                    return Ok(Progress::StreamEnd);
                }
            }
        }

        fn stored(&mut self) -> Result<Block, Stop> {
            // The rest of the current byte is padding.
            self.bit_buf = 0;
            self.bit_count = 0;
            let Some(header) = self.input.get(self.pos..self.pos + 4) else {
                return Err(Stop::NeedInput);
            };
            let len = u16::from_le_bytes([header[0], header[1]]);
            let nlen = u16::from_le_bytes([header[2], header[3]]);
            if len != !nlen {
                return Err(Stop::Error("a stored block's length check failed"));
            }
            self.pos += 4;
            let len = usize::from(len);
            let room = self.limit.saturating_sub(self.out.len());
            let available = self.input.len() - self.pos;
            let take = len.min(available).min(room);
            self.out
                .extend_from_slice(&self.input[self.pos..self.pos + take]);
            self.pos += take;
            if self.out.len() >= self.limit {
                return Ok(Block::OutputLimit);
            }
            if take < len {
                return Err(Stop::NeedInput);
            }
            Ok(Block::Done)
        }

        fn fixed(&mut self) -> Result<Block, Stop> {
            let mut lengths = [0u8; FIX_LCODES];
            lengths[..144].fill(8);
            lengths[144..256].fill(9);
            lengths[256..280].fill(7);
            lengths[280..].fill(8);
            let (lencode, _) = Huffman::new(&lengths);
            let (distcode, _) = Huffman::new(&[5u8; MAX_DCODES]);
            self.codes(&lencode, &distcode)
        }

        fn dynamic(&mut self) -> Result<Block, Stop> {
            let nlen = self.bits(5)? as usize + 257;
            let ndist = self.bits(5)? as usize + 1;
            let ncode = self.bits(4)? as usize + 4;
            if nlen > MAX_LCODES || ndist > MAX_DCODES {
                return Err(Stop::Error("a dynamic block declares too many codes"));
            }
            let mut lengths = [0u8; MAX_LCODES + MAX_DCODES];
            for &slot in &CODE_LENGTH_ORDER[..ncode] {
                lengths[slot] = self.bits(3)? as u8;
            }
            let (lencode, left) = Huffman::new(&lengths[..19]);
            if left != 0 {
                return Err(Stop::Error("the code-length code is not complete"));
            }
            let mut index = 0usize;
            while index < nlen + ndist {
                let symbol = self.decode(&lencode)?;
                if symbol < 16 {
                    lengths[index] = symbol as u8;
                    index += 1;
                    continue;
                }
                let (value, repeat) = match symbol {
                    16 => {
                        if index == 0 {
                            return Err(Stop::Error("a length repeat has nothing to repeat"));
                        }
                        (lengths[index - 1], 3 + self.bits(2)? as usize)
                    }
                    17 => (0, 3 + self.bits(3)? as usize),
                    _ => (0, 11 + self.bits(7)? as usize),
                };
                if index + repeat > nlen + ndist {
                    return Err(Stop::Error("a length repeat runs past the code lengths"));
                }
                lengths[index..index + repeat].fill(value);
                index += repeat;
            }
            if lengths[256] == 0 {
                return Err(Stop::Error("the block has no end-of-block code"));
            }
            let (lencode, left) = Huffman::new(&lengths[..nlen]);
            if left < 0
                || (left > 0
                    && nlen != usize::from(lencode.count[0]) + usize::from(lencode.count[1]))
            {
                return Err(Stop::Error(
                    "the literal/length code is incomplete or over-subscribed",
                ));
            }
            let (distcode, left) = Huffman::new(&lengths[nlen..nlen + ndist]);
            if left < 0
                || (left > 0
                    && ndist != usize::from(distcode.count[0]) + usize::from(distcode.count[1]))
            {
                return Err(Stop::Error(
                    "the distance code is incomplete or over-subscribed",
                ));
            }
            self.codes(&lencode, &distcode)
        }

        fn codes(&mut self, lencode: &Huffman, distcode: &Huffman) -> Result<Block, Stop> {
            loop {
                let symbol = self.decode(lencode)?;
                if symbol < 256 {
                    self.out.push(symbol as u8);
                } else if symbol == 256 {
                    return Ok(Block::Done);
                } else {
                    let symbol = symbol - 257;
                    if symbol >= LBASE.len() {
                        return Err(Stop::Error("an invalid length symbol"));
                    }
                    let len =
                        usize::from(LBASE[symbol]) + self.bits(u32::from(LEXT[symbol]))? as usize;
                    let dsymbol = self.decode(distcode)?;
                    if dsymbol >= DBASE.len() {
                        return Err(Stop::Error("an invalid distance symbol"));
                    }
                    let dist =
                        usize::from(DBASE[dsymbol]) + self.bits(u32::from(DEXT[dsymbol]))? as usize;
                    if dist > self.out.len() {
                        return Err(Stop::Error("a distance reaches before the output"));
                    }
                    let from = self.out.len() - dist;
                    for offset in 0..len {
                        let byte = self.out[from + offset];
                        self.out.push(byte);
                    }
                }
                if self.out.len() >= self.limit {
                    return Ok(Block::OutputLimit);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A git config that names only `helper`, and no system or user config,
    /// so the developer's own keychain is never asked.
    fn isolated_git(dir: &Path, helper: Option<&str>) -> Vec<(String, String)> {
        let config = dir.join("gitconfig");
        let body = helper
            .map(|helper| format!("[credential]\n\thelper = {helper}\n"))
            .unwrap_or_default();
        std::fs::write(&config, body).unwrap();
        vec![
            ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
            ("GIT_CONFIG_GLOBAL".into(), config.display().to_string()),
            ("HOME".into(), dir.display().to_string()),
            ("XDG_CONFIG_HOME".into(), dir.display().to_string()),
        ]
    }

    #[tokio::test]
    async fn the_host_credential_comes_from_its_own_helpers() {
        let dir = tempfile::tempdir().unwrap();
        let env = isolated_git(
            dir.path(),
            Some("\"!f() { test \\\"$1\\\" = get && echo username=x-access-token && echo password=host-token; }; f\""),
        );
        let env: Vec<(&str, &str)> = env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        let upstream = Url::parse("https://github.com/acme/app.git").unwrap();
        assert_eq!(
            host_credential_with(&upstream, &env).await.as_deref(),
            Some("host-token")
        );
    }

    #[tokio::test]
    async fn a_host_with_no_helper_has_no_credential_and_does_not_prompt() {
        let dir = tempfile::tempdir().unwrap();
        let env = isolated_git(dir.path(), None);
        let env: Vec<(&str, &str)> = env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        let upstream = Url::parse("https://github.com/acme/app.git").unwrap();
        assert_eq!(host_credential_with(&upstream, &env).await, None);
        let plain = Url::parse("http://github.com/acme/app.git").unwrap();
        assert_eq!(host_credential_with(&plain, &env).await, None);
    }

    use std::collections::HashMap;
    use std::net::SocketAddr;
    use std::path::Path;

    use parking_lot::Mutex;

    const BRANCH: &str = "feature";
    const TOKEN: &str = "ghp_upstream_secret";
    const OID_A: &str = "1111111111111111111111111111111111111111";
    const OID_B: &str = "2222222222222222222222222222222222222222";
    const ZERO: &str = "0000000000000000000000000000000000000000";
    const SLOW: &str = "test-endless";

    fn basic_for(token: &str) -> String {
        use base64::Engine as _;
        format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{token}"))
        )
    }

    /// Deterministic incompressible-ish bytes.
    fn noise(len: usize, seed: u64) -> Vec<u8> {
        let mut state = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (0..len)
            .map(|_| {
                state = state
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                (state >> 33) as u8
            })
            .collect()
    }

    fn command(old: &str, new: &str, refname: &str, caps: Option<&str>) -> Vec<u8> {
        let mut payload = format!("{old} {new} {refname}").into_bytes();
        if let Some(caps) = caps {
            payload.push(0);
            payload.extend_from_slice(caps.as_bytes());
        }
        pkt_line(&payload)
    }

    fn push_body(commands: &[Vec<u8>], pack: &[u8]) -> Vec<u8> {
        let mut body: Vec<u8> = commands.concat();
        body.extend_from_slice(b"0000");
        body.extend_from_slice(pack);
        body
    }

    fn gzip(data: &[u8], level: &str) -> Vec<u8> {
        use std::io::Write as _;
        let mut child = std::process::Command::new("gzip")
            .args(["-c", "-n", level])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .expect("gzip is installed");
        let mut stdin = child.stdin.take().expect("stdin");
        let input = data.to_vec();
        let writer = std::thread::spawn(move || {
            stdin.write_all(&input).expect("write to gzip");
        });
        let output = child.wait_with_output().expect("gzip output");
        writer.join().expect("writer");
        assert!(output.status.success());
        output.stdout
    }

    /// Splits a body into pkt-line payloads; a flush-pkt is an empty entry.
    fn read_pkts(mut body: &[u8]) -> Vec<Vec<u8>> {
        let mut out = Vec::new();
        while body.len() >= 4 {
            let len = parse_pkt_len(&body[..4]).expect("pkt length");
            if len == 0 {
                body = &body[4..];
                out.push(Vec::new());
                continue;
            }
            out.push(body[4..len].to_vec());
            body = &body[len..];
        }
        assert!(body.is_empty(), "trailing bytes: {body:?}");
        out
    }

    fn side_bands(body: &[u8]) -> HashMap<u8, Vec<u8>> {
        let mut bands: HashMap<u8, Vec<u8>> = HashMap::new();
        for pkt in read_pkts(body) {
            if pkt.is_empty() {
                continue;
            }
            bands
                .entry(pkt[0])
                .or_default()
                .extend_from_slice(&pkt[1..]);
        }
        bands
    }

    fn lines(report: &[u8]) -> Vec<String> {
        read_pkts(report)
            .into_iter()
            .map(|pkt| String::from_utf8(pkt).expect("utf8"))
            .collect()
    }

    // -- the fake upstream --------------------------------------------------

    #[derive(Debug, Clone)]
    struct Recorded {
        method: Method,
        uri: String,
        headers: HeaderMap,
        body: Vec<u8>,
    }

    #[derive(Clone)]
    struct FakeConfig {
        /// The capabilities the receive-pack advertisement offers.
        receive_caps: &'static str,
        /// The body answered to a receive-pack POST.
        receive_result: Vec<u8>,
    }

    impl Default for FakeConfig {
        fn default() -> Self {
            Self {
                receive_caps: "report-status side-band-64k ofs-delta delete-refs agent=fake/1",
                receive_result: side_band_ok(BRANCH),
            }
        }
    }

    fn side_band_ok(branch: &str) -> Vec<u8> {
        let mut report = pkt_line(b"unpack ok\n");
        report.extend(pkt_line(format!("ok refs/heads/{branch}\n").as_bytes()));
        report.extend_from_slice(b"0000");
        let mut body = side_band(1, &report, MAX_PKT_LEN);
        body.extend_from_slice(b"0000");
        body
    }

    struct FakeUpstream {
        addr: SocketAddr,
        requests: Arc<Mutex<Vec<Recorded>>>,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for FakeUpstream {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    impl FakeUpstream {
        async fn start(config: FakeConfig) -> Self {
            let requests: Arc<Mutex<Vec<Recorded>>> = Arc::default();
            let recorded = requests.clone();
            let app = Router::new().fallback(move |request: Request| {
                let recorded = recorded.clone();
                let config = config.clone();
                async move { fake_answer(request, &recorded, &config).await }
            });
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
            let addr = listener.local_addr().unwrap();
            let task = tokio::spawn(async move {
                axum::serve(listener, app).await.unwrap();
            });
            Self {
                addr,
                requests,
                task,
            }
        }

        fn url(&self) -> Url {
            Url::parse(&format!("http://{}/o/r.git", self.addr)).unwrap()
        }

        fn requests(&self) -> Vec<Recorded> {
            self.requests.lock().clone()
        }

        fn posts_to(&self, path: &str) -> Vec<Recorded> {
            self.requests()
                .into_iter()
                .filter(|r| r.method == Method::POST && r.uri == path)
                .collect()
        }
    }

    async fn fake_answer(
        request: Request,
        recorded: &Mutex<Vec<Recorded>>,
        config: &FakeConfig,
    ) -> Response {
        let (parts, body) = request.into_parts();
        let uri = parts.uri.to_string();
        // Marked through a header the proxy forwards: an endless response.
        let slow = uri == "/o/r.git/git-upload-pack"
            && parts.headers.get("git-protocol").is_some_and(|v| v == SLOW);
        let body = if slow {
            Vec::new()
        } else {
            axum::body::to_bytes(body, usize::MAX)
                .await
                .unwrap()
                .to_vec()
        };
        recorded.lock().push(Recorded {
            method: parts.method.clone(),
            uri: uri.clone(),
            headers: parts.headers.clone(),
            body: body.clone(),
        });
        let respond = |content_type: &str, body: Body| {
            Response::builder()
                .status(200)
                .header(CONTENT_TYPE, content_type)
                .header(CACHE_CONTROL, "no-cache")
                .header("x-upstream-secret", "do-not-relay")
                .header("set-cookie", "session=upstream")
                .body(body)
                .unwrap()
        };
        match uri.as_str() {
            "/o/r.git/info/refs?service=git-upload-pack" => respond(
                "application/x-git-upload-pack-advertisement",
                Body::from(&b"001e# service=git-upload-pack\n0000"[..]),
            ),
            "/o/r.git/info/refs?service=git-receive-pack" => {
                let mut body = pkt_line(b"# service=git-receive-pack\n");
                body.extend_from_slice(b"0000");
                body.extend(pkt_line(
                    format!("{ZERO} capabilities^{{}}\0{}\n", config.receive_caps).as_bytes(),
                ));
                body.extend_from_slice(b"0000");
                respond(
                    "application/x-git-receive-pack-advertisement",
                    Body::from(body),
                )
            }
            "/o/r.git/git-upload-pack" if slow => {
                let endless = stream::unfold((), |()| async {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                    Some((
                        Ok::<Bytes, std::io::Error>(Bytes::from(vec![b'x'; 1024])),
                        (),
                    ))
                });
                respond(
                    "application/x-git-upload-pack-result",
                    Body::from_stream(endless),
                )
            }
            "/o/r.git/git-upload-pack" => {
                respond("application/x-git-upload-pack-result", Body::from(body))
            }
            "/o/r.git/git-receive-pack" => respond(
                "application/x-git-receive-pack-result",
                Body::from(config.receive_result.clone()),
            ),
            _ => Response::builder()
                .status(404)
                .body(Body::from("fake: not found"))
                .unwrap(),
        }
    }

    // -- helpers -------------------------------------------------------------

    /// [`GitProxy::start`] with the Host's network policy in place, as a
    /// running Host has it.
    async fn start_proxy(config: GitProxyConfig) -> Result<GitProxy, String> {
        init_policy();
        GitProxy::start(config).await
    }

    fn init_policy() {
        cognia_net::proxy_config::apply_current(cognia_net::proxy_config::ProxyConfig::default())
            .expect("the default policy is valid");
    }

    fn client() -> reqwest::Client {
        cognia_net::proxy_config::ensure_crypto_provider();
        reqwest::Client::builder().build().unwrap()
    }

    async fn proxy_for(upstream: &FakeUpstream, credential: Option<&str>) -> GitProxy {
        start_proxy(GitProxyConfig {
            upstream: upstream.url(),
            credential: credential.map(str::to_string),
            branch: BRANCH.into(),
        })
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn read_only_refuses_every_push_route_before_upstream() {
        init_policy();
        let upstream = FakeUpstream::start(FakeConfig::default()).await;
        let proxy = GitProxy::start_read_only(GitProxyConfig {
            upstream: upstream.url(), credential: Some("host-only-token".into()), branch: BRANCH.into(),
        }).await.unwrap();
        for (method, path, expected) in [
            (Method::GET, "/repo.git/info/refs?service=git-receive-pack", 403),
            (Method::POST, "/repo.git/git-receive-pack", 403),
            (Method::GET, "/repo.git/info/refs?service=git-receive-pack&x=1", 404),
            (Method::POST, "/repo.git/%67it-receive-pack", 404),
            (Method::POST, "/other.git/git-receive-pack", 404),
        ] {
            let response = client().request(method, url(&proxy, path)).body("0000").send().await.unwrap();
            assert_eq!(response.status().as_u16(), expected);
        }
        assert!(upstream.requests().is_empty());
        let response = client().get(url(&proxy, "/repo.git/info/refs?service=git-upload-pack")).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(upstream.requests().len(), 1);
    }

    fn url(proxy: &GitProxy, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", proxy.port())
    }

    async fn post_receive(
        proxy: &GitProxy,
        body: Vec<u8>,
        encoding: Option<&str>,
    ) -> (StatusCode, HeaderMap, Vec<u8>) {
        let mut call = client()
            .post(url(proxy, "/repo.git/git-receive-pack"))
            .header(CONTENT_TYPE, "application/x-git-receive-pack-request")
            .header(ACCEPT, "application/x-git-receive-pack-result");
        if let Some(encoding) = encoding {
            call = call.header(CONTENT_ENCODING, encoding);
        }
        let response = call.body(body).send().await.unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        (status, headers, response.bytes().await.unwrap().to_vec())
    }

    fn assert_refused_side_band(
        status: StatusCode,
        headers: &HeaderMap,
        body: &[u8],
        expect_ng: &[&str],
    ) {
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            headers.get(CONTENT_TYPE).unwrap(),
            "application/x-git-receive-pack-result"
        );
        assert!(body.ends_with(b"0000"));
        let bands = side_bands(body);
        let message = String::from_utf8(bands[&2].clone()).unwrap();
        assert!(
            message.contains("may only push refs/heads/feature"),
            "{message}"
        );
        let report = lines(&bands[&1]);
        assert!(report[0].starts_with("unpack "), "{report:?}");
        assert_ne!(report[0], "unpack ok\n");
        for (expected, line) in expect_ng.iter().zip(&report[1..]) {
            assert!(line.starts_with(&format!("ng {expected} ")), "{line}");
        }
        assert_eq!(report.len(), expect_ng.len() + 2, "{report:?}");
        assert_eq!(report.last().unwrap(), "");
    }

    // -- 1. forwarding -------------------------------------------------------

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn info_refs_and_upload_pack_carry_the_host_credential_not_the_sandboxs() {
        let upstream = FakeUpstream::start(FakeConfig::default()).await;
        let proxy = proxy_for(&upstream, Some(TOKEN)).await;

        let response = client()
            .get(url(&proxy, "/repo.git/info/refs?service=git-upload-pack"))
            .header(AUTHORIZATION, "Basic c2FuZGJveDpzZWNyZXQ=")
            .header("git-protocol", "version=2")
            .header(USER_AGENT, "git/2.54.0")
            .header("cookie", "sandbox=1")
            .header("x-custom", "1")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(
            response.headers().get(CONTENT_TYPE).unwrap(),
            "application/x-git-upload-pack-advertisement"
        );
        assert_eq!(response.headers().get(CACHE_CONTROL).unwrap(), "no-cache");
        assert!(response.headers().get("x-upstream-secret").is_none());
        assert!(response.headers().get("set-cookie").is_none());
        assert_eq!(
            response.bytes().await.unwrap().as_ref(),
            b"001e# service=git-upload-pack\n0000"
        );

        let payload = noise(5 * 1024 * 1024, 7);
        let response = client()
            .post(url(&proxy, "/repo.git/git-upload-pack"))
            .header(AUTHORIZATION, "Bearer sandbox-token")
            .header(CONTENT_TYPE, "application/x-git-upload-pack-request")
            .header(ACCEPT, "application/x-git-upload-pack-result")
            .header("git-protocol", "version=2")
            .body(payload.clone())
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        let echoed = response.bytes().await.unwrap();
        assert_eq!(echoed.len(), payload.len());
        assert!(
            echoed.as_ref() == payload.as_slice(),
            "body changed in transit"
        );

        let requests = upstream.requests();
        assert_eq!(requests.len(), 2);
        for request in &requests {
            assert_eq!(
                request.headers.get(AUTHORIZATION).unwrap(),
                basic_for(TOKEN).as_str()
            );
            assert_eq!(request.headers.get_all(AUTHORIZATION).iter().count(), 1);
            assert_eq!(request.headers.get("git-protocol").unwrap(), "version=2");
            assert!(request.headers.get("cookie").is_none());
            assert!(request.headers.get("x-custom").is_none());
        }
        assert_eq!(
            requests[0].headers.get(USER_AGENT).unwrap(),
            format!("git/2.54.0 {PROXY_AGENT}").as_str()
        );
        assert_eq!(
            requests[0].uri,
            "/o/r.git/info/refs?service=git-upload-pack"
        );
        assert_eq!(requests[1].uri, "/o/r.git/git-upload-pack");
        assert!(requests[1].body == payload, "upstream got a different body");
        assert_eq!(
            requests[1].headers.get(CONTENT_TYPE).unwrap(),
            "application/x-git-upload-pack-request"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_anonymous_proxy_adds_no_authorization() {
        let upstream = FakeUpstream::start(FakeConfig::default()).await;
        for credential in [None, Some("")] {
            let proxy = proxy_for(&upstream, credential).await;
            let response = client()
                .get(url(&proxy, "/repo.git/info/refs?service=git-receive-pack"))
                .header(AUTHORIZATION, "Basic c2FuZGJveDpzZWNyZXQ=")
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), 200);
        }
        let requests = upstream.requests();
        assert_eq!(requests.len(), 2);
        assert!(requests
            .iter()
            .all(|request| request.headers.get(AUTHORIZATION).is_none()));
        assert_eq!(
            requests[0].uri,
            "/o/r.git/info/refs?service=git-receive-pack"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_upstream_without_a_git_suffix_or_with_a_trailing_slash_is_joined_cleanly() {
        let upstream = FakeUpstream::start(FakeConfig::default()).await;
        for path in ["o/r.git/", "o/r"] {
            let proxy = start_proxy(GitProxyConfig {
                upstream: Url::parse(&format!("http://{}/{path}", upstream.addr)).unwrap(),
                credential: None,
                branch: BRANCH.into(),
            })
            .await
            .unwrap();
            client()
                .get(url(&proxy, "/repo.git/info/refs?service=git-upload-pack"))
                .send()
                .await
                .unwrap();
        }
        let uris: Vec<String> = upstream.requests().into_iter().map(|r| r.uri).collect();
        assert_eq!(
            uris,
            [
                "/o/r.git/info/refs?service=git-upload-pack",
                "/o/r/info/refs?service=git-upload-pack"
            ]
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_unreachable_upstream_is_a_bad_gateway() {
        // Bind and release a port so nothing listens on it.
        let port = {
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
            listener.local_addr().unwrap().port()
        };
        let proxy = start_proxy(GitProxyConfig {
            upstream: Url::parse(&format!("http://127.0.0.1:{port}/o/r.git")).unwrap(),
            credential: Some(TOKEN.into()),
            branch: BRANCH.into(),
        })
        .await
        .unwrap();
        let response = client()
            .get(url(&proxy, "/repo.git/info/refs?service=git-upload-pack"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        assert!(!response.text().await.unwrap().contains(TOKEN));
    }

    // -- 2. accepted pushes --------------------------------------------------

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_push_to_the_branch_is_forwarded_byte_identical() {
        let upstream = FakeUpstream::start(FakeConfig::default()).await;
        let proxy = proxy_for(&upstream, Some(TOKEN)).await;
        let mut pack = b"PACK".to_vec();
        pack.extend(noise(3 * 1024 * 1024, 11));
        let body = push_body(
            &[command(
                OID_A,
                OID_B,
                "refs/heads/feature",
                Some("report-status side-band-64k agent=git/2.54.0"),
            )],
            &pack,
        );

        let (status, headers, answer) = post_receive(&proxy, body.clone(), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            headers.get(CONTENT_TYPE).unwrap(),
            "application/x-git-receive-pack-result"
        );
        assert_eq!(answer, side_band_ok(BRANCH));

        let posts = upstream.posts_to("/o/r.git/git-receive-pack");
        assert_eq!(posts.len(), 1);
        assert!(posts[0].body == body, "the forwarded push differs");
        assert_eq!(
            posts[0].headers.get(CONTENT_LENGTH).unwrap(),
            body.len().to_string().as_str()
        );
        assert_eq!(
            posts[0].headers.get(AUTHORIZATION).unwrap(),
            basic_for(TOKEN).as_str()
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_chunked_push_split_inside_the_command_section_is_forwarded() {
        let upstream = FakeUpstream::start(FakeConfig::default()).await;
        let proxy = proxy_for(&upstream, None).await;
        let mut pack = b"PACK".to_vec();
        pack.extend(noise(256 * 1024, 13));
        let body = push_body(
            &[command(
                OID_A,
                OID_B,
                "refs/heads/feature",
                Some("report-status side-band-64k"),
            )],
            &pack,
        );
        // Byte-sized pieces through the command section, then the pack.
        let mut pieces: Vec<Result<Bytes, std::io::Error>> = body[..120]
            .iter()
            .map(|byte| Ok(Bytes::from(vec![*byte])))
            .collect();
        pieces.push(Ok(Bytes::copy_from_slice(&body[120..])));
        let response = client()
            .post(url(&proxy, "/repo.git/git-receive-pack"))
            .header(CONTENT_TYPE, "application/x-git-receive-pack-request")
            .body(reqwest::Body::wrap_stream(stream::iter(pieces)))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let posts = upstream.posts_to("/o/r.git/git-receive-pack");
        assert_eq!(posts.len(), 1);
        assert!(posts[0].body == body, "the forwarded push differs");
        assert!(posts[0].headers.get(CONTENT_LENGTH).is_none());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn creating_the_branch_with_push_options_and_shallow_lines_is_forwarded() {
        let upstream = FakeUpstream::start(FakeConfig::default()).await;
        let proxy = proxy_for(&upstream, None).await;
        let mut body = pkt_line(format!("shallow {OID_A}").as_bytes());
        body.extend(command(
            ZERO,
            OID_B,
            "refs/heads/feature",
            Some("report-status-v2 side-band-64k push-options"),
        ));
        body.extend_from_slice(b"0000");
        body.extend(pkt_line(b"ci.skip"));
        body.extend_from_slice(b"0000");
        body.extend_from_slice(b"PACK\0\0\0\x02\0\0\0\0");

        let (status, _, _) = post_receive(&proxy, body.clone(), None).await;
        assert_eq!(status, StatusCode::OK);
        let posts = upstream.posts_to("/o/r.git/git-receive-pack");
        assert_eq!(posts.len(), 1);
        assert_eq!(posts[0].body, body);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_flush_only_probe_is_forwarded() {
        // git sends `0000` alone before a push larger than http.postBuffer.
        let upstream = FakeUpstream::start(FakeConfig::default()).await;
        let proxy = proxy_for(&upstream, None).await;
        let (status, _, _) = post_receive(&proxy, b"0000".to_vec(), None).await;
        assert_eq!(status, StatusCode::OK);
        let posts = upstream.posts_to("/o/r.git/git-receive-pack");
        assert_eq!(posts.len(), 1);
        assert_eq!(posts[0].body, b"0000");
    }

    // -- 3. refused pushes ---------------------------------------------------

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn pushes_outside_the_branch_are_refused_without_reaching_upstream() {
        let upstream = FakeUpstream::start(FakeConfig::default()).await;
        let proxy = proxy_for(&upstream, Some(TOKEN)).await;
        let caps = Some("report-status side-band-64k");
        let pack = noise(512 * 1024, 3);

        // Another ref.
        let body = push_body(&[command(OID_A, OID_B, "refs/heads/main", caps)], &pack);
        let (status, headers, answer) = post_receive(&proxy, body, None).await;
        assert_refused_side_band(status, &headers, &answer, &["refs/heads/main"]);
        let report = lines(&side_bands(&answer)[&1]);
        assert!(
            report[1].contains("may only push refs/heads/feature"),
            "{report:?}"
        );

        // A delete of the branch itself.
        let body = push_body(&[command(OID_A, ZERO, "refs/heads/feature", caps)], b"");
        let (status, headers, answer) = post_receive(&proxy, body, None).await;
        assert_refused_side_band(status, &headers, &answer, &["refs/heads/feature"]);
        let report = lines(&side_bands(&answer)[&1]);
        assert!(report[1].contains("may not delete"), "{report:?}");

        // Allowed and disallowed together: the whole push is refused.
        let body = push_body(
            &[
                command(OID_A, OID_B, "refs/heads/feature", caps),
                command(ZERO, OID_B, "refs/tags/v1", None),
            ],
            &pack,
        );
        let (status, headers, answer) = post_receive(&proxy, body, None).await;
        assert_refused_side_band(
            status,
            &headers,
            &answer,
            &["refs/heads/feature", "refs/tags/v1"],
        );
        let report = lines(&side_bands(&answer)[&1]);
        assert!(report[1].contains("refused with the rest"), "{report:?}");

        // A ref that only starts like the branch.
        let body = push_body(
            &[command(OID_A, OID_B, "refs/heads/feature-2", caps)],
            &pack,
        );
        let (status, headers, answer) = post_receive(&proxy, body, None).await;
        assert_refused_side_band(status, &headers, &answer, &["refs/heads/feature-2"]);

        assert!(upstream.posts_to("/o/r.git/git-receive-pack").is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn malformed_and_oversized_command_sections_are_refused_locally() {
        let upstream = FakeUpstream::start(FakeConfig::default()).await;
        let proxy = proxy_for(&upstream, Some(TOKEN)).await;
        let caps = Some("report-status side-band-64k");

        let too_many: Vec<Vec<u8>> = (0..=MAX_COMMANDS)
            .map(|i| {
                command(
                    OID_A,
                    OID_B,
                    "refs/heads/feature",
                    if i == 0 { caps } else { None },
                )
            })
            .collect();
        let mut no_flush = command(OID_A, OID_B, "refs/heads/feature", caps);
        while no_flush.len() <= MAX_COMMAND_SECTION + 1024 {
            no_flush.extend(pkt_line(format!("shallow {OID_A}").as_bytes()));
        }
        let cases: Vec<(&str, Vec<u8>)> = vec![
            ("too many commands", push_body(&too_many, b"PACK")),
            ("no flush within the bound", no_flush),
            (
                "bad hex length",
                [b"zz10".to_vec(), b"0000".to_vec()].concat(),
            ),
            (
                "delim packet",
                [
                    command(OID_A, OID_B, "refs/heads/feature", caps),
                    b"0001".to_vec(),
                ]
                .concat(),
            ),
            (
                "not a command",
                push_body(&[pkt_line(b"hello\0report-status side-band-64k")], b""),
            ),
            (
                "short oid",
                push_body(&[command("1111", OID_B, "refs/heads/feature", caps)], b""),
            ),
            (
                "signed push",
                push_body(&[pkt_line(b"push-cert\0report-status side-band-64k")], b""),
            ),
            (
                "truncated",
                command(OID_A, OID_B, "refs/heads/feature", caps)[..30].to_vec(),
            ),
            ("empty body", Vec::new()),
        ];
        for (name, body) in cases {
            let (status, headers, answer) = post_receive(&proxy, body, None).await;
            assert!(
                status == StatusCode::OK || status == StatusCode::FORBIDDEN,
                "{name}: {status}"
            );
            if status == StatusCode::OK {
                assert_eq!(
                    headers.get(CONTENT_TYPE).unwrap(),
                    "application/x-git-receive-pack-result",
                    "{name}"
                );
                let bands = side_bands(&answer);
                let fatal = String::from_utf8(bands[&3].clone()).unwrap();
                assert!(fatal.contains("refs/heads/feature"), "{name}: {fatal}");
                assert!(!bands.contains_key(&1), "{name}");
            } else {
                // Capabilities were never read: plain HTTP refusal.
                let text = String::from_utf8(answer).unwrap();
                assert!(text.contains("refs/heads/feature"), "{name}: {text}");
            }
        }
        assert!(upstream.posts_to("/o/r.git/git-receive-pack").is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_refusal_without_side_band_is_a_plain_report_status() {
        let upstream = FakeUpstream::start(FakeConfig::default()).await;
        let proxy = proxy_for(&upstream, None).await;
        let body = push_body(
            &[command(
                OID_A,
                OID_B,
                "refs/heads/main",
                Some("report-status"),
            )],
            b"PACK",
        );
        let (status, _, answer) = post_receive(&proxy, body, None).await;
        assert_eq!(status, StatusCode::OK);
        let report = lines(&answer);
        assert_eq!(report[0], "unpack push refused by the sandbox git proxy\n");
        assert!(report[1].starts_with("ng refs/heads/main "), "{report:?}");
        assert_eq!(report[2], "");

        // No report-status and no side-band: git would not read a body.
        let body = push_body(&[command(OID_A, OID_B, "refs/heads/main", None)], b"PACK");
        let (status, _, answer) = post_receive(&proxy, body, None).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(String::from_utf8(answer)
            .unwrap()
            .contains("may only push refs/heads/feature"));

        // Malformed after report-status was requested: an ERR packet.
        let mut body = command(OID_A, OID_B, "refs/heads/feature", Some("report-status"));
        body.extend_from_slice(b"0002");
        let (status, _, answer) = post_receive(&proxy, body, None).await;
        assert_eq!(status, StatusCode::OK);
        let report = lines(&answer);
        assert!(report[0].starts_with("ERR cognia git proxy:"), "{report:?}");

        // Side-band without 64k uses small packets.
        let body = push_body(
            &[command(
                OID_A,
                OID_B,
                "refs/heads/main",
                Some("report-status side-band"),
            )],
            b"PACK",
        );
        let (_, _, answer) = post_receive(&proxy, body, None).await;
        assert!(read_pkts(&answer).iter().all(|pkt| pkt.len() + 4 <= 1000));
        assert!(side_bands(&answer).contains_key(&1));

        assert!(upstream.posts_to("/o/r.git/git-receive-pack").is_empty());
    }

    // -- 4. gzip ---------------------------------------------------------------

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_gzip_push_is_checked_and_forwarded_still_compressed() {
        let upstream = FakeUpstream::start(FakeConfig::default()).await;
        let proxy = proxy_for(&upstream, Some(TOKEN)).await;
        let mut pack = b"PACK".to_vec();
        pack.extend(noise(2 * 1024 * 1024, 5));
        let caps = Some("report-status side-band-64k");

        let allowed = gzip(
            &push_body(&[command(OID_A, OID_B, "refs/heads/feature", caps)], &pack),
            "-6",
        );
        let (status, _, answer) = post_receive(&proxy, allowed.clone(), Some("gzip")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(answer, side_band_ok(BRANCH));
        let posts = upstream.posts_to("/o/r.git/git-receive-pack");
        assert_eq!(posts.len(), 1);
        assert!(posts[0].body == allowed, "the compressed body changed");
        assert_eq!(posts[0].headers.get(CONTENT_ENCODING).unwrap(), "gzip");

        let refused = gzip(
            &push_body(&[command(OID_A, OID_B, "refs/heads/main", caps)], &pack),
            "-9",
        );
        let (status, headers, answer) = post_receive(&proxy, refused, Some("x-gzip")).await;
        assert_refused_side_band(status, &headers, &answer, &["refs/heads/main"]);

        let (status, _, answer) =
            post_receive(&proxy, b"not gzip at all".to_vec(), Some("gzip")).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(String::from_utf8(answer).unwrap().contains("gzip"));

        let (status, _, _) = post_receive(&proxy, b"0000".to_vec(), Some("br")).await;
        assert_eq!(status, StatusCode::FORBIDDEN);

        assert_eq!(upstream.posts_to("/o/r.git/git-receive-pack").len(), 1);
    }

    #[test]
    fn inflate_matches_gzip_on_every_kind_of_input() {
        let mut text = Vec::new();
        for i in 0..4000 {
            text.extend_from_slice(format!("line {i} of a fairly repetitive text\n").as_bytes());
        }
        let inputs: Vec<Vec<u8>> = vec![
            Vec::new(),
            b"a".to_vec(),
            b"0000".to_vec(),
            text,
            noise(300 * 1024, 1),
            vec![0u8; 200 * 1024],
            [noise(70 * 1024, 2), vec![b'z'; 70 * 1024], noise(10, 3)].concat(),
        ];
        for input in &inputs {
            for level in ["-1", "-6", "-9"] {
                let compressed = gzip(input, level);
                let (out, progress) =
                    inflate::gunzip_prefix(&compressed, usize::MAX).expect("decodes");
                assert_eq!(progress, inflate::Progress::StreamEnd, "level {level}");
                assert!(out == *input, "level {level}, {} bytes", input.len());

                // Any prefix of the input decodes to a prefix of the output.
                for cut in [1, 9, 10, 11, compressed.len() / 3, compressed.len() - 9] {
                    let cut = cut.min(compressed.len());
                    let (partial, _) = inflate::gunzip_prefix(&compressed[..cut], usize::MAX)
                        .expect("a prefix decodes");
                    assert!(input.starts_with(&partial), "cut {cut}");
                }
                // The limit stops early.
                if input.len() > 1000 {
                    let (limited, progress) =
                        inflate::gunzip_prefix(&compressed, 1000).expect("decodes");
                    assert_eq!(progress, inflate::Progress::OutputLimit);
                    assert!(limited.len() >= 1000 && input.starts_with(&limited));
                }
            }
        }
    }

    #[test]
    fn inflate_reads_every_gzip_header_field_and_stored_blocks() {
        // FEXTRA, FNAME, FCOMMENT, FHCRC, then two stored blocks by hand.
        let mut stream = vec![0x1f, 0x8b, 8, 0x04 | 0x08 | 0x10 | 0x02, 0, 0, 0, 0, 0, 3];
        stream.extend_from_slice(&[3, 0, b'a', b'b', b'c']);
        stream.extend_from_slice(b"name\0comment\0");
        stream.extend_from_slice(&[0xaa, 0xbb]);
        stream.push(0x00); // BFINAL=0, stored
        stream.extend_from_slice(&[5, 0, !5u8, 0xff]);
        stream.extend_from_slice(b"hello");
        stream.push(0x01); // BFINAL=1, stored
        stream.extend_from_slice(&[6, 0, !6u8, 0xff]);
        stream.extend_from_slice(b" world");
        stream.extend_from_slice(&[0; 8]); // trailer, never read
        let (out, progress) = inflate::gunzip_prefix(&stream, usize::MAX).unwrap();
        assert_eq!(out, b"hello world");
        assert_eq!(progress, inflate::Progress::StreamEnd);

        // A stored block cut short yields what has arrived.
        // (Header 30 bytes, block header 5, then "he" of "hello".)
        let (out, progress) = inflate::gunzip_prefix(&stream[..37], usize::MAX).unwrap();
        assert_eq!(progress, inflate::Progress::InputExhausted);
        assert_eq!(out, b"he");

        // Headers that are still arriving are not errors.
        for cut in 0..30 {
            assert!(
                inflate::gunzip_prefix(&stream[..cut], usize::MAX).is_ok(),
                "{cut}"
            );
        }
    }

    #[test]
    fn inflate_refuses_corrupt_streams() {
        assert!(inflate::gunzip_prefix(b"PK\x03\x04", 100).is_err());
        assert!(inflate::gunzip_prefix(&[0x1f, 0x8b, 8, 0x20, 0, 0, 0, 0, 0, 3], 100).is_err());
        // A stored block whose length check fails.
        let mut bad = vec![0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3, 0x01, 5, 0, 5, 0];
        bad.extend_from_slice(b"hello");
        assert!(inflate::gunzip_prefix(&bad, 100).is_err());
        // Block type 3.
        assert!(inflate::inflate_prefix(&[0x07], 100).is_err());
        // A fixed-Huffman match reaching before the start of the output:
        // BFINAL=1, BTYPE=01, length symbol 257 (0000001), distance 0 (00000).
        assert!(inflate::inflate_prefix(&[0x03, 0x02, 0x00, 0x00], 100).is_err());
    }

    // -- 5. routes and configuration -----------------------------------------

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn anything_but_the_four_routes_is_a_404_that_never_reaches_upstream() {
        let upstream = FakeUpstream::start(FakeConfig::default()).await;
        let proxy = proxy_for(&upstream, Some(TOKEN)).await;
        let cases: &[(Method, &str)] = &[
            (Method::GET, "/repo.git/info/refs"),
            (
                Method::GET,
                "/repo.git/info/refs?service=git-upload-pack&x=1",
            ),
            (
                Method::GET,
                "/repo.git/info/refs?service=git-upload-archive",
            ),
            (Method::GET, "/repo.git/%69nfo/refs?service=git-upload-pack"),
            (Method::GET, "/other.git/info/refs?service=git-upload-pack"),
            (Method::GET, "/x/repo.git/info/refs?service=git-upload-pack"),
            (Method::GET, "/repo.git/HEAD"),
            (Method::GET, "/repo.git/objects/info/packs"),
            (Method::GET, "/repo.git/git-upload-pack"),
            (Method::POST, "/repo.git/info/refs?service=git-upload-pack"),
            (Method::POST, "/repo.git/git-receive-pack?x=1"),
            (Method::PUT, "/repo.git/git-receive-pack"),
            (Method::DELETE, "/repo.git/git-receive-pack"),
            (Method::HEAD, "/repo.git/info/refs?service=git-upload-pack"),
            (Method::GET, "/"),
        ];
        for (method, path) in cases {
            let response = client()
                .request(method.clone(), url(&proxy, path))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{method} {path}");
        }
        assert!(upstream.requests().is_empty());
    }

    #[tokio::test]
    async fn start_refuses_unsafe_upstreams_and_invalid_branches() {
        let start = |upstream: &str, branch: &str| {
            let config = GitProxyConfig {
                upstream: Url::parse(upstream).unwrap(),
                credential: Some(TOKEN.into()),
                branch: branch.into(),
            };
            start_proxy(config)
        };
        for upstream in [
            "http://example.com/o/r.git",
            "http://localhost/o/r.git",
            "http://10.0.0.1/o/r.git",
            "https://user:pw@github.com/o/r.git",
            "https://x-access-token@github.com/o/r.git",
            "https://github.com/o/r.git?ref=main",
            "https://github.com/o/r.git#frag",
            "https://github.com/",
            "ftp://github.com/o/r.git",
            "ssh://git@github.com/o/r.git",
            "file:///tmp/r.git",
        ] {
            let error = start(upstream, BRANCH).await.expect_err(upstream);
            assert!(!error.contains("pw@"), "{error}");
            assert!(!error.contains(TOKEN), "{error}");
        }
        for branch in ["", "a..b", "-x", "HEAD", "a b", "x.lock"] {
            assert!(
                start("https://github.com/o/r.git", branch).await.is_err(),
                "{branch:?}"
            );
        }
        for upstream in [
            "https://github.com/o/r.git",
            "http://127.0.0.1:9/o/r.git",
            "http://[::1]:9/o/r",
        ] {
            let proxy = start(upstream, "agent/task-1").await.expect(upstream);
            assert_ne!(proxy.port(), 0);
        }
    }

    #[test]
    fn the_config_never_prints_its_credential() {
        let config = GitProxyConfig {
            upstream: Url::parse("https://github.com/o/r.git").unwrap(),
            credential: Some(TOKEN.into()),
            branch: BRANCH.into(),
        };
        let shown = format!("{config:?}");
        assert!(!shown.contains(TOKEN), "{shown}");
        assert!(shown.contains("<redacted>"), "{shown}");
    }

    #[test]
    fn the_header_is_the_one_the_shared_credential_policy_gives_git() {
        let credential = GitCredential::from_token(TOKEN).unwrap();
        let from_policy =
            cognia_git_mirror::credential::auth_env("https://github.com", &credential)
                .into_iter()
                .find(|(key, _)| key == "GIT_CONFIG_VALUE_3")
                .map(|(_, value)| value)
                .unwrap();
        let ours = basic_authorization(TOKEN).unwrap();
        assert!(ours.is_sensitive());
        assert_eq!(
            format!("Authorization: {}", ours.to_str().unwrap()),
            from_policy
        );
        assert_eq!(ours.to_str().unwrap(), basic_for(TOKEN));
    }

    #[test]
    fn branch_names_follow_check_ref_format() {
        for valid in [
            "main",
            "feature",
            "agent/task-1",
            "cognia/agent/7f3a",
            "fix_123",
            "v1.2",
            "a@b",
            "ünïcode",
            "a-",
            &"x".repeat(MAX_BRANCH_BYTES),
        ] {
            assert!(is_valid_branch(valid), "{valid:?} should be valid");
        }
        for invalid in [
            "",
            "HEAD",
            "@",
            "-leading-dash",
            "/leading",
            "trailing/",
            "trailing.",
            "a..b",
            "a//b",
            ".hidden",
            "a/.hidden",
            "x.lock",
            "a.lock/b",
            "a@{b",
            "a b",
            "a~1",
            "a^",
            "a:b",
            "a?",
            "a*",
            "a[b",
            "a\\b",
            "tab\there",
            "nl\n",
            "del\x7f",
            &"x".repeat(MAX_BRANCH_BYTES + 1),
        ] {
            assert!(!is_valid_branch(invalid), "{invalid:?} should be invalid");
        }
    }

    // -- 6. lifetime and concurrency -------------------------------------------

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn dropping_the_proxy_stops_the_listener() {
        let upstream = FakeUpstream::start(FakeConfig::default()).await;
        let proxy = proxy_for(&upstream, None).await;
        let port = proxy.port();
        tokio::net::TcpStream::connect((Ipv4Addr::LOCALHOST, port))
            .await
            .expect("listening while alive");
        drop(proxy);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            if tokio::net::TcpStream::connect((Ipv4Addr::LOCALHOST, port))
                .await
                .is_err()
            {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "still accepting after drop"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn dropping_the_proxy_cuts_a_stream_in_flight() {
        let upstream = FakeUpstream::start(FakeConfig::default()).await;
        let proxy = proxy_for(&upstream, None).await;
        let mut response = client()
            .post(url(&proxy, "/repo.git/git-upload-pack"))
            .header("git-protocol", SLOW)
            .body("0000")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        assert!(response.chunk().await.unwrap().is_some());
        drop(proxy);
        let ended = tokio::time::timeout(Duration::from_secs(5), async {
            while let Ok(Some(_)) = response.chunk().await {}
        })
        .await;
        assert!(ended.is_ok(), "the body kept streaming after drop");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn upstream_requests_are_bounded_per_proxy() {
        let upstream = FakeUpstream::start(FakeConfig::default()).await;
        let proxy = proxy_for(&upstream, None).await;
        let mut held = Vec::new();
        for _ in 0..MAX_CONCURRENT_UPSTREAM {
            let mut response = client()
                .post(url(&proxy, "/repo.git/git-upload-pack"))
                .header("git-protocol", SLOW)
                .body("0000")
                .send()
                .await
                .unwrap();
            assert!(response.chunk().await.unwrap().is_some());
            held.push(response);
        }
        let waiting = tokio::spawn({
            let target = url(&proxy, "/repo.git/info/refs?service=git-upload-pack");
            async move { client().get(target).send().await.unwrap().status() }
        });
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(!waiting.is_finished(), "a ninth request ran unbounded");
        assert_eq!(upstream.requests().len(), MAX_CONCURRENT_UPSTREAM);

        drop(held.pop());
        let status = tokio::time::timeout(Duration::from_secs(5), waiting)
            .await
            .expect("released when a stream ends")
            .unwrap();
        assert_eq!(status, 200);
    }

    // -- 7. SHA-256 ---------------------------------------------------------------

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sha256_object_ids_are_accepted() {
        let upstream = FakeUpstream::start(FakeConfig::default()).await;
        let proxy = proxy_for(&upstream, None).await;
        let old = "a".repeat(64);
        let new = "B".repeat(64);
        let body = push_body(
            &[command(
                &old,
                &new,
                "refs/heads/feature",
                Some("report-status side-band-64k object-format=sha256"),
            )],
            b"PACK",
        );
        let (status, _, _) = post_receive(&proxy, body.clone(), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(upstream.posts_to("/o/r.git/git-receive-pack")[0].body, body);

        // A SHA-256 delete is still a delete.
        let body = push_body(
            &[command(
                &old,
                &"0".repeat(64),
                "refs/heads/feature",
                Some("report-status side-band-64k"),
            )],
            b"",
        );
        let (status, headers, answer) = post_receive(&proxy, body, None).await;
        assert_refused_side_band(status, &headers, &answer, &["refs/heads/feature"]);
        assert_eq!(upstream.posts_to("/o/r.git/git-receive-pack").len(), 1);
    }

    #[test]
    fn the_parser_reads_commands_the_way_receive_pack_does() {
        let sha256 = "c".repeat(64);
        let mut body = command(OID_A, OID_B, "refs/heads/feature", Some("report-status"));
        body.extend(command(
            OID_B,
            OID_A,
            "refs/heads/feature",
            Some("side-band-64k"),
        ));
        body.extend(command(OID_A, OID_B, "refs/heads/feature\n", None));
        // An LF before the NUL is not the pkt-line's trailing LF: git's
        // `strlen` keeps it in the ref name, and so does this parser.
        body.extend(command(OID_A, OID_B, "refs/heads/feature\n", Some("quiet")));
        body.extend_from_slice(b"0000PACK");
        let SectionParse::Complete(section) = parse_command_section(&body) else {
            panic!("expected a complete section");
        };
        // A trailing LF is chomped; features on a later line are OR-ed in.
        assert_eq!(section.updates[2].refname, b"refs/heads/feature");
        assert_eq!(section.updates[3].refname, b"refs/heads/feature\n");
        assert!(section.capabilities.report_status && section.capabilities.side_band_64k);
        assert!(authorize(&section, "refs/heads/feature").is_err());

        // Every prefix short of the flush is incomplete, never malformed.
        let end = body.len() - 4;
        for cut in 0..end {
            assert_eq!(
                parse_command_section(&body[..cut]),
                SectionParse::Incomplete,
                "{cut}"
            );
        }

        // Mixed object id lengths.
        let mixed = push_body(&[command(OID_A, &sha256, "refs/heads/feature", None)], b"");
        assert!(matches!(
            parse_command_section(&mixed),
            SectionParse::Malformed { .. }
        ));
        // An empty ref name.
        let empty = push_body(&[pkt_line(format!("{OID_A} {OID_B} ").as_bytes())], b"");
        assert!(matches!(
            parse_command_section(&empty),
            SectionParse::Malformed { .. }
        ));
        // Capabilities read before a malformed line are kept for the answer.
        let mut late = command(OID_A, OID_B, "refs/heads/feature", Some("side-band-64k"));
        late.extend(pkt_line(b"garbage"));
        let SectionParse::Malformed { capabilities, .. } = parse_command_section(&late) else {
            panic!("expected malformed");
        };
        assert!(capabilities.side_band_64k);
    }

    #[test]
    fn a_ref_name_too_long_to_echo_falls_back_to_the_fatal_message() {
        let report = vec![(vec![b'r'; MAX_PKT_LEN], "reason".to_string())];
        assert!(report_status(&report).is_none());
        let refusal = Refusal {
            message: "cognia git proxy: refused refs/heads/feature".into(),
            capabilities: Capabilities {
                side_band_64k: true,
                report_status: true,
                ..Capabilities::default()
            },
            report: Some(report),
        };
        let response = refusal.into_response();
        assert_eq!(response.status(), StatusCode::OK);
    }

    // -- real git --------------------------------------------------------------

    async fn git(dir: &Path, home: &Path, args: &[&str]) -> std::process::Output {
        tokio::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("HOME", home)
            .env("LC_ALL", "C")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_AUTHOR_NAME", "Cognia Agent")
            .env("GIT_AUTHOR_EMAIL", "agent@cognia.test")
            .env("GIT_COMMITTER_NAME", "Cognia Agent")
            .env("GIT_COMMITTER_EMAIL", "agent@cognia.test")
            .output()
            .await
            .expect("git runs")
    }

    async fn repo_with_a_commit(root: &Path) -> std::path::PathBuf {
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        assert!(git(&repo, root, &["init", "-q", "-b", "main"])
            .await
            .status
            .success());
        std::fs::write(repo.join("a.txt"), "hello\n").unwrap();
        assert!(git(&repo, root, &["add", "a.txt"]).await.status.success());
        assert!(git(&repo, root, &["commit", "-q", "-m", "init"])
            .await
            .status
            .success());
        repo
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn real_git_prints_the_refusal_and_pushes_the_branch() {
        for receive_caps in [
            "report-status side-band-64k ofs-delta agent=fake/1",
            "report-status ofs-delta agent=fake/1",
        ] {
            let side_band_result = side_band_ok(BRANCH);
            let receive_result = if receive_caps.contains("side-band") {
                side_band_result
            } else {
                let mut report = pkt_line(b"unpack ok\n");
                report.extend(pkt_line(format!("ok refs/heads/{BRANCH}\n").as_bytes()));
                report.extend_from_slice(b"0000");
                report
            };
            let upstream = FakeUpstream::start(FakeConfig {
                receive_caps,
                receive_result,
            })
            .await;
            let proxy = proxy_for(&upstream, Some(TOKEN)).await;
            let root = tempfile::tempdir().unwrap();
            let repo = repo_with_a_commit(root.path()).await;
            let remote = url(&proxy, "/repo.git");

            let refused = git(
                &repo,
                root.path(),
                &["push", &remote, "HEAD:refs/heads/main"],
            )
            .await;
            let stderr = String::from_utf8_lossy(&refused.stderr);
            assert!(!refused.status.success(), "{receive_caps}: {stderr}");
            assert!(
                stderr.contains("may only push refs/heads/feature"),
                "{receive_caps}: {stderr}"
            );
            assert!(
                stderr.contains("remote rejected"),
                "{receive_caps}: {stderr}"
            );
            assert!(upstream.posts_to("/o/r.git/git-receive-pack").is_empty());

            let pushed = git(
                &repo,
                root.path(),
                &["push", &remote, "HEAD:refs/heads/feature"],
            )
            .await;
            assert!(
                pushed.status.success(),
                "{receive_caps}: {}",
                String::from_utf8_lossy(&pushed.stderr)
            );
            let posts = upstream.posts_to("/o/r.git/git-receive-pack");
            assert_eq!(posts.len(), 1);
            let SectionParse::Complete(section) = parse_command_section(&posts[0].body) else {
                panic!("upstream got an unreadable push");
            };
            assert_eq!(section.updates.len(), 1);
            assert_eq!(section.updates[0].refname, b"refs/heads/feature");
            assert!(posts[0].body.windows(4).any(|window| window == b"PACK"));
            assert_eq!(
                posts[0].headers.get(AUTHORIZATION).unwrap(),
                basic_for(TOKEN).as_str()
            );
        }
    }
}

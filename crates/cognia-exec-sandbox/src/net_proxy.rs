//! Shared host egress enforcement for TCP, Unix sockets and accepted byte streams.
//!
//! Supports HTTP CONNECT and absolute-form HTTP requests; no SOCKS listener.
//! Plain HTTP serves exactly one request, strips hop-by-hop headers, and closes
//! both connections. Pipelined/second-origin requests are never tunnel bytes.
//! CONNECT preserves read-ahead and TCP-style half-closes. Host matching and
//! forbidden IP checks come exclusively from `cognia_net::egress`.
//! HTTP and CONNECT connections expire when neither leg makes byte progress
//! for the configured idle interval; active transfers have no total deadline.
//!
//! DNS is resolved once and the vetted IP is used for both direct dials and
//! host-proxy tunnels (including SOCKS upstreams). Proxy refusal fails closed:
//! there is no hostname resubmission or direct fallback. Platform adapters must
//! still prevent clients from bypassing this proxy at the OS/network boundary.

use std::io::{self, ErrorKind};
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use cognia_net::proxy_config::wsproxy::ProxyStream;
use tokio::io::{
    AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader,
    ReadBuf,
};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, watch};
use tokio::task::{JoinHandle, JoinSet};
use tokio::time::{timeout, Instant};

pub use cognia_net::egress::{
    is_forbidden_dest_ip, is_host_allowed, is_valid_hostname, matches_domain_pattern,
    parse_authority, parse_connect_target,
};

const MAX_HEADER_BYTES: usize = 16 * 1024;

/// A listener address, never an interchangeable port/path string.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProxyEndpoint {
    Tcp(u16),
    #[cfg(unix)]
    Unix(std::path::PathBuf),
}

/// Resource bounds shared by listeners and the accepted-stream handler.
#[derive(Clone, Debug)]
pub struct ProxyPolicy {
    pub allowlist: Vec<String>,
    pub max_concurrent_connections: usize,
    pub header_timeout: Duration,
    pub dns_timeout: Duration,
    pub dial_timeout: Duration,
    /// Maximum time without a successful nonempty read or write on either
    /// leg after dialing. Applies to HTTP bodies and CONNECT, not total life.
    pub idle_timeout: Duration,
}

impl Default for ProxyPolicy {
    fn default() -> Self {
        Self {
            allowlist: Vec::new(),
            max_concurrent_connections: 128,
            header_timeout: Duration::from_secs(10),
            dns_timeout: Duration::from_secs(5),
            dial_timeout: Duration::from_secs(10),
            idle_timeout: Duration::from_secs(120),
        }
    }
}

impl From<Vec<String>> for ProxyPolicy {
    fn from(allowlist: Vec<String>) -> Self {
        Self {
            allowlist,
            ..Self::default()
        }
    }
}

impl ProxyPolicy {
    fn validate(&self) -> io::Result<()> {
        if self.max_concurrent_connections == 0
            || self.header_timeout.is_zero()
            || self.dns_timeout.is_zero()
            || self.dial_timeout.is_zero()
            || self.idle_timeout.is_zero()
        {
            return Err(io::Error::new(
                ErrorKind::InvalidInput,
                "proxy limits must be nonzero",
            ));
        }
        Ok(())
    }
}

/// Owns the accept task and all its connection tasks. Prefer `shutdown` to
/// await tunnel closure; dropping the guard cancels the task tree as a backstop.
pub struct FilteringProxy {
    endpoint: ProxyEndpoint,
    stop: Option<oneshot::Sender<()>>,
    handle: JoinHandle<()>,
    joined: bool,
}

impl FilteringProxy {
    /// Compatibility entry for macOS's loopback/SBPL integration.
    pub async fn start(allowlist: Vec<String>) -> io::Result<Self> {
        Self::start_with_policy(allowlist.into()).await
    }

    pub async fn start_with_policy(policy: ProxyPolicy) -> io::Result<Self> {
        policy.validate()?;
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let endpoint = ProxyEndpoint::Tcp(listener.local_addr()?.port());
        Ok(Self::spawn(
            Listener::Tcp(listener),
            endpoint,
            policy,
            Network::default(),
        ))
    }

    /// Bind a new Unix socket. Never unlinks a pre-existing path. The caller
    /// should place it in a directory accessible only to its intended clients.
    #[cfg(unix)]
    pub async fn start_unix(
        path: impl AsRef<std::path::Path>,
        policy: impl Into<ProxyPolicy>,
    ) -> io::Result<Self> {
        let policy = policy.into();
        policy.validate()?;
        let path = std::path::absolute(path)?;
        let listener = tokio::net::UnixListener::bind(&path)?;
        let cleanup = UnixSocketCleanup::new(path.clone())?;
        Ok(Self::spawn(
            Listener::Unix(listener, cleanup),
            ProxyEndpoint::Unix(path),
            policy,
            Network::default(),
        ))
    }

    fn spawn(
        listener: Listener,
        endpoint: ProxyEndpoint,
        policy: ProxyPolicy,
        network: Network,
    ) -> Self {
        let (stop, receiver) = oneshot::channel();
        let handle = tokio::spawn(accept_loop(listener, Arc::new(policy), receiver, network));
        Self {
            endpoint,
            stop: Some(stop),
            handle,
            joined: false,
        }
    }

    pub fn endpoint(&self) -> &ProxyEndpoint {
        &self.endpoint
    }

    /// Legacy TCP-only accessor. Unix callers must use `endpoint()`.
    /// Panics for a Unix listener rather than returning a misleading TCP port.
    pub fn port(&self) -> u16 {
        match self.endpoint {
            ProxyEndpoint::Tcp(port) => port,
            #[cfg(unix)]
            ProxyEndpoint::Unix(_) => panic!("Unix proxy has no TCP port; use endpoint()"),
        }
    }

    /// Stop accepting, cancel every tunnel, and wait until all streams close.
    /// Cancellation-safe: if this future is dropped, a later call still joins
    /// the same accept task; dropping the proxy aborts it.
    pub async fn shutdown(&mut self) -> io::Result<()> {
        if self.joined {
            return Ok(());
        }
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        let result = (&mut self.handle).await.map_err(io::Error::other);
        self.joined = true;
        result
    }
}

impl Drop for FilteringProxy {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

#[cfg(unix)]
struct UnixSocketCleanup {
    path: std::path::PathBuf,
    identity: (u64, u64),
}

#[cfg(unix)]
impl UnixSocketCleanup {
    fn new(path: std::path::PathBuf) -> io::Result<Self> {
        use std::os::unix::fs::MetadataExt;
        let metadata = std::fs::symlink_metadata(&path)?;
        Ok(Self {
            path,
            identity: (metadata.dev(), metadata.ino()),
        })
    }
}

#[cfg(unix)]
impl Drop for UnixSocketCleanup {
    fn drop(&mut self) {
        use std::os::unix::fs::MetadataExt;
        if let Ok(metadata) = std::fs::symlink_metadata(&self.path) {
            if (metadata.dev(), metadata.ino()) == self.identity {
                let _ = std::fs::remove_file(&self.path);
            }
        }
    }
}

enum Listener {
    Tcp(TcpListener),
    #[cfg(unix)]
    Unix(tokio::net::UnixListener, UnixSocketCleanup),
    #[cfg(test)]
    Memory(tokio::sync::mpsc::Receiver<ProxyStream>),
}

impl Listener {
    async fn accept(&mut self) -> io::Result<ProxyStream> {
        match self {
            Self::Tcp(listener) => Ok(Box::new(listener.accept().await?.0)),
            #[cfg(unix)]
            Self::Unix(listener, _cleanup) => Ok(Box::new(listener.accept().await?.0)),
            #[cfg(test)]
            Self::Memory(receiver) => receiver
                .recv()
                .await
                .ok_or_else(|| io::Error::from(ErrorKind::BrokenPipe)),
        }
    }
}

async fn accept_loop(
    mut listener: Listener,
    policy: Arc<ProxyPolicy>,
    mut stop: oneshot::Receiver<()>,
    network: Network,
) {
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            biased;
            _ = &mut stop => break,
            Some(_) = connections.join_next(), if !connections.is_empty() => {},
            accepted = listener.accept(), if connections.len() < policy.max_concurrent_connections => {
                let Ok(stream) = accepted else { break };
                let policy = Arc::clone(&policy);
                let network = network.clone();
                connections.spawn(async move { let _ = handle_stream(stream, &policy, &network).await; });
            }
        }
    }
    drop(listener);
    connections.shutdown().await;
}

/// Serve one already-accepted stream (for example a Docker exec byte bridge).
/// This future spawns no tasks and owns the stream: cancellation closes it and
/// its upstream. Bridge callers own scheduling/concurrency; listener callers
/// get those bounds and shutdown ownership from `FilteringProxy`.
pub async fn serve_stream<S>(stream: S, policy: impl Into<ProxyPolicy>) -> io::Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin + Send,
{
    let policy = policy.into();
    policy.validate()?;
    handle_stream(stream, &policy, &Network::default()).await
}

// Injection exists only in test builds. Policy enforcement remains outside
// the injected resolver/dialer, so tests cannot disable the production IP gate.
#[derive(Clone, Default)]
struct Network {
    #[cfg(test)]
    test: Option<Arc<dyn TestNetwork>>,
}

#[cfg(test)]
#[async_trait::async_trait]
trait TestNetwork: Send + Sync {
    async fn resolve(&self, host: &str, port: u16) -> io::Result<Vec<SocketAddr>>;
    async fn dial(&self, host: &str, port: u16, vetted: SocketAddr) -> io::Result<ProxyStream>;
}

impl Network {
    async fn resolve(&self, host: &str, port: u16) -> io::Result<Vec<SocketAddr>> {
        #[cfg(test)]
        if let Some(test) = &self.test {
            return test.resolve(host, port).await;
        }
        Ok(tokio::net::lookup_host((host, port)).await?.collect())
    }

    async fn dial(&self, host: &str, port: u16, vetted: SocketAddr) -> io::Result<ProxyStream> {
        #[cfg(test)]
        if let Some(test) = &self.test {
            return test.dial(host, port, vetted).await;
        }
        dial_upstream(host, port, vetted).await
    }
}

async fn dial_upstream(host: &str, port: u16, vetted: SocketAddr) -> io::Result<ProxyStream> {
    use cognia_net::proxy_config::{self, ProxyRouteSummary};
    let config = proxy_config::current().map_err(io::Error::other)?;
    // Routing uses the original hostname (including bypass rules), but the
    // selected route always connects to the checked IP, never re-resolves it.
    let target = format!("https://{}", authority(host, port));
    match config.route_for(&target).map_err(io::Error::other)? {
        ProxyRouteSummary::Direct { .. } => Ok(Box::new(TcpStream::connect(vetted).await?)),
        ProxyRouteSummary::Proxy { .. } => {
            proxy_config::wsproxy::connect_via_proxy_resolved(&config, vetted)
                .await
                .map_err(io::Error::other)
        }
    }
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(ErrorKind::InvalidData, message)
}

fn authority(host: &str, port: u16) -> String {
    if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

/// Buffer at most `limit` bytes, including the delimiter, and leave read-ahead
/// in the BufReader. Checking capacity before scanning prevents oversized
/// headers with a delimiter in their last read from slipping through.
async fn read_section<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    delimiter: &[u8],
    limit: usize,
) -> io::Result<Vec<u8>> {
    let mut result = Vec::new();
    loop {
        let remaining = limit.saturating_sub(result.len());
        if remaining == 0 {
            return Err(invalid("HTTP section too large"));
        }
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return Err(io::Error::from(ErrorKind::UnexpectedEof));
        }
        let n = available.len().min(remaining);
        let old_len = result.len();
        result.extend_from_slice(&available[..n]);
        let search_from = old_len.saturating_sub(delimiter.len() - 1);
        if let Some(offset) = result[search_from..]
            .windows(delimiter.len())
            .position(|w| w == delimiter)
        {
            let end = search_from + offset + delimiter.len();
            reader.consume(end - old_len);
            result.truncate(end);
            return Ok(result);
        }
        reader.consume(n);
    }
}

struct Head {
    first: String,
    fields: Vec<(String, String)>,
}

fn token(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
}

fn parse_head(bytes: &[u8]) -> io::Result<Head> {
    let text = std::str::from_utf8(bytes).map_err(|_| invalid("invalid HTTP text"))?;
    let text = text
        .strip_suffix("\r\n\r\n")
        .ok_or_else(|| invalid("incomplete header"))?;
    let mut lines = text.split("\r\n");
    let first = lines.next().ok_or_else(|| invalid("missing start line"))?;
    if first.bytes().any(|b| b < 32 || b == 127) {
        return Err(invalid("invalid start line"));
    }
    let mut fields = Vec::new();
    for line in lines {
        let (name, value) = line
            .split_once(':')
            .ok_or_else(|| invalid("invalid header"))?;
        if !token(name) || value.bytes().any(|b| (b < 32 && b != b'\t') || b == 127) {
            return Err(invalid("invalid header"));
        }
        fields.push((
            name.to_ascii_lowercase(),
            value.trim_matches([' ', '\t']).to_string(),
        ));
    }
    Ok(Head {
        first: first.to_string(),
        fields,
    })
}

impl Head {
    fn values<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a str> {
        self.fields
            .iter()
            .filter(move |(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    }

    fn one(&self, name: &str) -> io::Result<Option<&str>> {
        let mut values = self
            .fields
            .iter()
            .filter(|(n, _)| n == name)
            .map(|(_, v)| v.as_str());
        let result = values.next();
        if values.next().is_some() {
            return Err(invalid("duplicate singleton header"));
        }
        Ok(result)
    }

    fn connection_tokens(&self) -> io::Result<Vec<String>> {
        let mut result = Vec::new();
        for value in self
            .values("connection")
            .chain(self.values("proxy-connection"))
        {
            for name in value.split(',').map(str::trim) {
                if !token(name) {
                    return Err(invalid("invalid connection option"));
                }
                let name = name.to_ascii_lowercase();
                if matches!(
                    name.as_str(),
                    "host" | "content-length" | "transfer-encoding"
                ) {
                    return Err(invalid("connection option hides routing or framing"));
                }
                result.push(name);
            }
        }
        Ok(result)
    }

    fn framing(&self) -> io::Result<Body> {
        let length = self.one("content-length")?;
        let transfer = self.one("transfer-encoding")?;
        if length.is_some() && transfer.is_some() {
            return Err(invalid("conflicting body framing"));
        }
        if let Some(transfer) = transfer {
            if !transfer.eq_ignore_ascii_case("chunked") {
                return Err(invalid("unsupported transfer encoding"));
            }
            return Ok(Body::Chunked);
        }
        if let Some(length) = length {
            if length.is_empty() || !length.bytes().all(|b| b.is_ascii_digit()) {
                return Err(invalid("invalid content length"));
            }
            return Ok(Body::Length(
                length
                    .parse()
                    .map_err(|_| invalid("invalid content length"))?,
            ));
        }
        Ok(Body::Unframed)
    }

    fn sanitized(&self, first: &str, body: Body, host: Option<&str>) -> io::Result<Vec<u8>> {
        let connection = self.connection_tokens()?;
        let mut output = format!("{first}\r\n");
        for (name, value) in &self.fields {
            if connection.contains(name)
                || matches!(
                    name.as_str(),
                    "connection"
                        | "proxy-connection"
                        | "keep-alive"
                        | "proxy-authenticate"
                        | "proxy-authorization"
                        | "te"
                        | "trailer"
                        | "transfer-encoding"
                        | "upgrade"
                        | "content-length"
                        | "expect"
                )
                || (host.is_some() && name == "host")
            {
                continue;
            }
            output.push_str(&format!("{name}: {value}\r\n"));
        }
        if let Some(host) = host {
            output.push_str(&format!("Host: {host}\r\n"));
        }
        match body {
            Body::Length(length) => output.push_str(&format!("Content-Length: {length}\r\n")),
            Body::Chunked => output.push_str("Transfer-Encoding: chunked\r\n"),
            Body::Unframed => {}
        }
        output.push_str("Connection: close\r\n\r\n");
        Ok(output.into_bytes())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Body {
    Length(u64),
    Chunked,
    Unframed,
}

struct Request {
    head: Head,
    host: String,
    port: u16,
    method: String,
    path: String,
    connect: bool,
    body: Body,
    expect_continue: bool,
}

fn parse_request(bytes: &[u8]) -> io::Result<Request> {
    let head = parse_head(bytes)?;
    let parts: Vec<_> = head.first.split(' ').collect();
    if parts.len() != 3 || !token(parts[0]) || !matches!(parts[2], "HTTP/1.0" | "HTTP/1.1") {
        return Err(invalid("invalid request line"));
    }
    let method = parts[0].to_string();
    let connect = method.eq_ignore_ascii_case("CONNECT");
    let (host, port, path) = if connect {
        let (host, port) =
            parse_connect_target(&head.first).ok_or_else(|| invalid("invalid CONNECT target"))?;
        (host, port, String::new())
    } else {
        let target = parts[1];
        if !target.is_ascii()
            || target.len() < 7
            || !target[..7].eq_ignore_ascii_case("http://")
            || target
                .bytes()
                .any(|b| b <= 32 || b == 127 || b == b'\\' || b == b'#')
        {
            return Err(invalid("expected absolute-form HTTP URI"));
        }
        let rest = &target[7..];
        let end = rest.find(['/', '?']).unwrap_or(rest.len());
        let (host, port) = parse_authority(&rest[..end], Some(80))
            .ok_or_else(|| invalid("invalid URI authority"))?;
        let path = match &rest[end..] {
            "" => "/".to_string(),
            query if query.starts_with('?') => format!("/{query}"),
            path => path.to_string(),
        };
        (host, port, path)
    };
    let host_header = head.one("host")?;
    if !connect && host_header.is_none() {
        return Err(invalid("missing Host"));
    }
    if let Some(value) = host_header {
        let parsed = parse_authority(value, Some(if connect { port } else { 80 }))
            .ok_or_else(|| invalid("invalid Host"))?;
        if parsed != (host.clone(), port) {
            return Err(invalid("Host/authority mismatch"));
        }
    }
    let body = head.framing()?;
    head.connection_tokens()?;
    if head.one("upgrade")?.is_some() {
        return Err(invalid("HTTP upgrade is unsupported; use CONNECT"));
    }
    let expect_continue = match head.one("expect")? {
        None => false,
        Some(value) if value.eq_ignore_ascii_case("100-continue") && !connect => true,
        Some(_) => return Err(invalid("unsupported expectation")),
    };
    if connect && !matches!(body, Body::Unframed | Body::Length(0)) {
        return Err(invalid("CONNECT body is unsupported"));
    }
    Ok(Request {
        head,
        host,
        port,
        method,
        path,
        connect,
        body,
        expect_continue,
    })
}

async fn reject<W: AsyncWrite + Unpin>(
    client: &mut W,
    status: &str,
    bound: Duration,
) -> io::Result<()> {
    timeout(
        bound,
        client.write_all(
            format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        ),
    )
    .await
    .map_err(|_| io::Error::from(ErrorKind::TimedOut))?
}

/// Observe actual I/O completion, including partial reads/writes inside
/// `copy`, `write_all`, chunk parsing and bidirectional tunnels. Both legs
/// share one timestamp so a quiet direction does not kill an active peer.
struct ProgressStream<S> {
    inner: S,
    activity: watch::Sender<Instant>,
}

impl<S: AsyncRead + Unpin> AsyncRead for ProgressStream<S> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        let before = buf.filled().len();
        let result = Pin::new(&mut this.inner).poll_read(cx, buf);
        if matches!(result, Poll::Ready(Ok(()))) && buf.filled().len() > before {
            this.activity.send_replace(Instant::now());
        }
        result
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for ProgressStream<S> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        let result = Pin::new(&mut this.inner).poll_write(cx, buf);
        if matches!(result, Poll::Ready(Ok(n)) if n > 0) {
            this.activity.send_replace(Instant::now());
        }
        result
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }
}

async fn handle_stream<S>(stream: S, policy: &ProxyPolicy, network: &Network) -> io::Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin + Send,
{
    let mut client = BufReader::new(stream);
    let bytes = match timeout(
        policy.header_timeout,
        read_section(&mut client, b"\r\n\r\n", MAX_HEADER_BYTES),
    )
    .await
    {
        Ok(Ok(bytes)) => bytes,
        Err(_) => return reject(&mut client, "408 Request Timeout", policy.header_timeout).await,
        Ok(Err(_)) => return reject(&mut client, "400 Bad Request", policy.header_timeout).await,
    };
    let request = match parse_request(&bytes) {
        Ok(request) => request,
        Err(_) => return reject(&mut client, "400 Bad Request", policy.header_timeout).await,
    };
    // Host and URI authorities have been checked for exact canonical equality;
    // they therefore share this allowlist decision and this single DNS result.
    if !is_host_allowed(&request.host, &policy.allowlist) {
        return reject(&mut client, "403 Forbidden", policy.header_timeout).await;
    }
    let addresses = match timeout(
        policy.dns_timeout,
        network.resolve(&request.host, request.port),
    )
    .await
    {
        Ok(Ok(addresses)) => addresses,
        Err(_) => return reject(&mut client, "504 Gateway Timeout", policy.header_timeout).await,
        Ok(Err(_)) => return reject(&mut client, "502 Bad Gateway", policy.header_timeout).await,
    };
    let Some(vetted) = addresses
        .into_iter()
        .find(|addr| !is_forbidden_dest_ip(&addr.ip()))
    else {
        return reject(&mut client, "403 Forbidden", policy.header_timeout).await;
    };
    let upstream = match timeout(
        policy.dial_timeout,
        network.dial(&request.host, request.port, vetted),
    )
    .await
    {
        Ok(Ok(upstream)) => upstream,
        Err(_) => return reject(&mut client, "504 Gateway Timeout", policy.header_timeout).await,
        Ok(Err(_)) => return reject(&mut client, "502 Bad Gateway", policy.header_timeout).await,
    };
    let (activity, _) = watch::channel(Instant::now());
    let mut client = ProgressStream {
        inner: client,
        activity: activity.clone(),
    };
    let mut upstream = ProgressStream {
        inner: upstream,
        activity: activity.clone(),
    };
    let forwarding = async move {
        if request.connect {
            timeout(
                policy.header_timeout,
                client.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n"),
            )
            .await
            .map_err(|_| io::Error::from(ErrorKind::TimedOut))??;
            // The inner BufReader retains CONNECT read-ahead. Tokio shuts down
            // each writer only after that direction reaches EOF; the shared
            // activity clock allows the remaining direction to keep working.
            tokio::io::copy_bidirectional(&mut client, &mut upstream).await?;
        } else {
            forward_http(client, upstream, request, policy).await?;
        }
        Ok(())
    };
    let idle = async {
        loop {
            // No borrow guard crosses an await. A successful I/O may extend
            // the deadline while sleeping; recheck the shared timestamp before
            // expiring. No per-byte wakeups or detached watchdog task needed.
            let deadline = *activity.borrow() + policy.idle_timeout;
            tokio::time::sleep_until(deadline).await;
            if Instant::now().duration_since(*activity.borrow()) >= policy.idle_timeout {
                return Err(io::Error::new(ErrorKind::TimedOut, "proxy connection idle"));
            }
        }
    };
    tokio::select! {
        biased;
        result = forwarding => result,
        result = idle => result,
    }
}

async fn copy_exact<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(
    reader: &mut R,
    writer: &mut W,
    length: u64,
) -> io::Result<()> {
    let copied = tokio::io::copy(&mut reader.take(length), writer).await?;
    if copied != length {
        return Err(io::Error::from(ErrorKind::UnexpectedEof));
    }
    Ok(())
}

/// Re-emit chunk framing instead of transparently forwarding arbitrary bytes.
/// Extensions are discarded; trailers are syntax-checked and discarded, so a
/// trailer can never override the validated Host/framing on the upstream hop.
async fn copy_chunked<R: AsyncBufRead + Unpin, W: AsyncWrite + Unpin>(
    reader: &mut R,
    writer: &mut W,
) -> io::Result<()> {
    loop {
        let line = read_section(reader, b"\r\n", MAX_HEADER_BYTES).await?;
        let line =
            std::str::from_utf8(&line[..line.len() - 2]).map_err(|_| invalid("invalid chunk"))?;
        let size = line.split(';').next().unwrap_or("");
        if size.is_empty()
            || !size.bytes().all(|b| b.is_ascii_hexdigit())
            || line.bytes().any(|b| b < 32 || b == 127)
        {
            return Err(invalid("invalid chunk size"));
        }
        let size = u64::from_str_radix(size, 16).map_err(|_| invalid("invalid chunk size"))?;
        if size == 0 {
            let mut remaining = MAX_HEADER_BYTES;
            loop {
                let trailer = read_section(reader, b"\r\n", remaining).await?;
                remaining -= trailer.len();
                if trailer == b"\r\n" {
                    break;
                }
                let mut header = b"trailers\r\n".to_vec();
                header.extend_from_slice(&trailer);
                header.extend_from_slice(b"\r\n");
                parse_head(&header)?;
            }
            writer.write_all(b"0\r\n\r\n").await?;
            return Ok(());
        }
        writer.write_all(format!("{size:x}\r\n").as_bytes()).await?;
        copy_exact(reader, writer, size).await?;
        let mut end = [0; 2];
        reader.read_exact(&mut end).await?;
        if end != *b"\r\n" {
            return Err(invalid("invalid chunk delimiter"));
        }
        writer.write_all(&end).await?;
    }
}

async fn forward_http<S, U>(
    client: S,
    mut upstream: U,
    request: Request,
    policy: &ProxyPolicy,
) -> io::Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin + Send,
    U: AsyncRead + AsyncWrite + Unpin + Send,
{
    let first = format!("{} {} HTTP/1.1", request.method, request.path);
    let body = match request.body {
        Body::Unframed => Body::Length(0),
        other => other,
    };
    let header =
        request
            .head
            .sanitized(&first, body, Some(&authority(&request.host, request.port)))?;
    timeout(policy.dial_timeout, upstream.write_all(&header))
        .await
        .map_err(|_| io::Error::from(ErrorKind::TimedOut))??;
    let (mut client_read, mut client_write) = tokio::io::split(client);
    if request.expect_continue {
        timeout(
            policy.header_timeout,
            client_write.write_all(b"HTTP/1.1 100 Continue\r\n\r\n"),
        )
        .await
        .map_err(|_| io::Error::from(ErrorKind::TimedOut))??;
    }
    let (upstream_read, mut upstream_write) = tokio::io::split(upstream);
    let (upload_done, uploaded) = oneshot::channel();
    let upload = async {
        match body {
            Body::Length(length) => {
                copy_exact(&mut client_read, &mut upstream_write, length).await?
            }
            Body::Chunked => {
                copy_chunked(&mut BufReader::new(&mut client_read), &mut upstream_write).await?
            }
            Body::Unframed => unreachable!(),
        }
        upstream_write.flush().await?;
        let _ = upload_done.send(());
        Ok::<(), io::Error>(())
    };
    let download = forward_response(
        BufReader::new(upstream_read),
        &mut client_write,
        &request.method,
        policy.header_timeout,
        uploaded,
    );
    tokio::pin!(upload, download);
    // An origin may reject a request before reading its body. Reading responses
    // concurrently avoids deadlocks; once the response ends, cancel the upload.
    tokio::select! {
        result = &mut download => result,
        result = &mut upload => { result?; download.await }
    }
}

async fn forward_response<R: AsyncBufRead + Unpin, W: AsyncWrite + Unpin>(
    mut upstream: R,
    client: &mut W,
    method: &str,
    header_timeout: Duration,
    uploaded: oneshot::Receiver<()>,
) -> io::Result<()> {
    let (head, status, framing) = {
        let headers = async {
            loop {
                let bytes = read_section(&mut upstream, b"\r\n\r\n", MAX_HEADER_BYTES).await?;
                let head = parse_head(&bytes)?;
                let mut parts = head.first.splitn(3, ' ');
                if !matches!(parts.next(), Some("HTTP/1.0" | "HTTP/1.1")) {
                    return Err(invalid("invalid response version"));
                }
                let code = parts
                    .next()
                    .ok_or_else(|| invalid("invalid response status"))?;
                if code.len() != 3 || !code.bytes().all(|b| b.is_ascii_digit()) {
                    return Err(invalid("invalid response status"));
                }
                let status: u16 = code
                    .parse()
                    .map_err(|_| invalid("invalid response status"))?;
                if !(100..=599).contains(&status) || status == 101 {
                    return Err(invalid("unsupported response status"));
                }
                let framing = head.framing()?;
                head.connection_tokens()?;
                if status >= 200 {
                    return Ok((head, status, framing));
                }
                // 100-continue is handled locally; informational responses
                // cannot turn this request into a transparent tunnel.
            }
        };
        tokio::pin!(headers);
        // Bound the entire informational/final header sequence once the request
        // has been sent. The origin may wait for a large upload before replying;
        // that upload must not consume its response-header budget. Keep polling
        // the same future so partial response headers survive this transition.
        tokio::select! {
            result = &mut headers => result?,
            _ = uploaded => timeout(header_timeout, &mut headers).await
                .map_err(|_| io::Error::from(ErrorKind::TimedOut))??,
        }
    };
    client
        .write_all(&head.sanitized(&head.first, framing, None)?)
        .await?;
    if method == "HEAD" || status == 204 || status == 304 {
        return Ok(());
    }
    match framing {
        Body::Length(length) => copy_exact(&mut upstream, client, length).await,
        Body::Chunked => copy_chunked(&mut upstream, client).await,
        Body::Unframed => tokio::io::copy(&mut upstream, client).await.map(|_| ()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::net::IpAddr;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;
    use tokio::io::{duplex, DuplexStream};

    struct FakeNetwork {
        addresses: Vec<IpAddr>,
        upstreams: Mutex<VecDeque<ProxyStream>>,
        resolutions: AtomicUsize,
        dials: Mutex<Vec<SocketAddr>>,
        resolve_delay: Duration,
        dial_delay: Duration,
    }

    impl FakeNetwork {
        fn new(ips: &[&str]) -> Self {
            Self {
                addresses: ips.iter().map(|ip| ip.parse().unwrap()).collect(),
                upstreams: Mutex::new(VecDeque::new()),
                resolutions: AtomicUsize::new(0),
                dials: Mutex::new(Vec::new()),
                resolve_delay: Duration::ZERO,
                dial_delay: Duration::ZERO,
            }
        }

        fn upstream(&self) -> DuplexStream {
            self.upstream_with_capacity(64 * 1024)
        }

        fn upstream_with_capacity(&self, capacity: usize) -> DuplexStream {
            let (proxy, origin) = duplex(capacity);
            self.upstreams.lock().unwrap().push_back(Box::new(proxy));
            origin
        }
    }

    #[async_trait::async_trait]
    impl TestNetwork for FakeNetwork {
        async fn resolve(&self, _: &str, port: u16) -> io::Result<Vec<SocketAddr>> {
            self.resolutions.fetch_add(1, Ordering::SeqCst);
            if !self.resolve_delay.is_zero() {
                tokio::time::sleep(self.resolve_delay).await;
            }
            Ok(self
                .addresses
                .iter()
                .map(|ip| SocketAddr::new(*ip, port))
                .collect())
        }

        async fn dial(&self, _: &str, _: u16, vetted: SocketAddr) -> io::Result<ProxyStream> {
            self.dials.lock().unwrap().push(vetted);
            if !self.dial_delay.is_zero() {
                tokio::time::sleep(self.dial_delay).await;
            }
            self.upstreams
                .lock()
                .unwrap()
                .pop_front()
                .ok_or_else(|| io::Error::from(ErrorKind::ConnectionRefused))
        }
    }

    fn policy() -> ProxyPolicy {
        ProxyPolicy {
            allowlist: vec!["allowed.test".into(), "second.test".into()],
            header_timeout: Duration::from_millis(100),
            dns_timeout: Duration::from_millis(100),
            dial_timeout: Duration::from_millis(100),
            ..ProxyPolicy::default()
        }
    }

    fn injected(fake: &Arc<FakeNetwork>) -> Network {
        Network {
            test: Some(fake.clone()),
        }
    }

    fn spawn_client(
        policy: ProxyPolicy,
        fake: &Arc<FakeNetwork>,
    ) -> (DuplexStream, JoinHandle<io::Result<()>>) {
        let (client, server) = duplex(128 * 1024);
        let network = injected(fake);
        (
            client,
            tokio::spawn(async move { handle_stream(server, &policy, &network).await }),
        )
    }

    async fn response(request: &[u8], fake: &Arc<FakeNetwork>) -> Vec<u8> {
        let (mut client, handler) = spawn_client(policy(), fake);
        client.write_all(request).await.unwrap();
        client.shutdown().await.unwrap();
        let mut response = Vec::new();
        timeout(Duration::from_secs(2), client.read_to_end(&mut response))
            .await
            .unwrap()
            .unwrap();
        handler.await.unwrap().unwrap();
        response
    }

    #[tokio::test]
    async fn connect_read_ahead_and_half_close_survive_one_write() {
        let fake = Arc::new(FakeNetwork::new(&["93.184.216.34"]));
        let mut origin = fake.upstream();
        let origin_task = tokio::spawn(async move {
            let mut bytes = Vec::new();
            // Response is sent only after the client's write half closes.
            origin.read_to_end(&mut bytes).await.unwrap();
            assert_eq!(bytes, b"first tunnel bytes");
            origin.write_all(b"reply after half-close").await.unwrap();
            origin.shutdown().await.unwrap();
        });
        let bytes = response(
            b"CONNECT allowed.test:443 HTTP/1.1\r\n\r\nfirst tunnel bytes",
            &fake,
        )
        .await;
        assert_eq!(
            bytes,
            b"HTTP/1.1 200 Connection Established\r\n\r\nreply after half-close"
        );
        assert_eq!(
            *fake.dials.lock().unwrap(),
            vec!["93.184.216.34:443".parse::<SocketAddr>().unwrap()]
        );
        origin_task.await.unwrap();
    }

    #[tokio::test]
    async fn upstream_half_close_does_not_truncate_client_upload() {
        let fake = Arc::new(FakeNetwork::new(&["93.184.216.34"]));
        let mut origin = fake.upstream();
        let (mut client, handler) = spawn_client(policy(), &fake);
        client
            .write_all(b"CONNECT allowed.test:443 HTTP/1.1\r\n\r\n")
            .await
            .unwrap();
        origin.write_all(b"greeting").await.unwrap();
        origin.shutdown().await.unwrap();
        let mut reply = Vec::new();
        timeout(Duration::from_secs(2), client.read_to_end(&mut reply))
            .await
            .unwrap()
            .unwrap();
        assert!(reply.ends_with(b"greeting"));
        client.write_all(b"last upload").await.unwrap();
        client.shutdown().await.unwrap();
        let mut upload = Vec::new();
        timeout(Duration::from_secs(2), origin.read_to_end(&mut upload))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(upload, b"last upload");
        handler.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn denied_host_never_resolves_or_dials() {
        let fake = Arc::new(FakeNetwork::new(&["93.184.216.34"]));
        for request in [
            &b"CONNECT denied.test:443 HTTP/1.1\r\n\r\n"[..],
            &b"GET http://denied.test/ HTTP/1.1\r\nHost: denied.test\r\n\r\n"[..],
        ] {
            assert!(response(request, &fake).await.starts_with(b"HTTP/1.1 403"));
        }
        assert_eq!(fake.resolutions.load(Ordering::SeqCst), 0);
        assert!(fake.dials.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn allowed_names_cannot_resolve_to_ipv4_ipv6_or_metadata_internal_ips() {
        for ip in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.0.1",
            "169.254.169.254",
            "100.100.100.200",
            "100.96.0.96",
            "::1",
            "fe80::1",
            "fd00:ec2::254",
            "::ffff:127.0.0.1",
            "::ffff:169.254.169.254",
        ] {
            let fake = Arc::new(FakeNetwork::new(&[ip]));
            for request in [
                &b"CONNECT allowed.test:443 HTTP/1.1\r\n\r\n"[..],
                &b"GET http://allowed.test/ HTTP/1.1\r\nHost: allowed.test\r\n\r\n"[..],
            ] {
                assert!(
                    response(request, &fake).await.starts_with(b"HTTP/1.1 403"),
                    "{ip}"
                );
            }
            assert!(fake.dials.lock().unwrap().is_empty());
        }
    }

    #[tokio::test]
    async fn public_ipv6_target_uses_shared_authority_parser() {
        let fake = Arc::new(FakeNetwork::new(&["2606:4700:4700::1111"]));
        let mut origin = fake.upstream();
        let mut rules = policy();
        rules.allowlist = vec!["2606:4700:4700::1111".into()];
        let (mut client, handler) = spawn_client(rules, &fake);
        client.write_all(b"CONNECT [2606:4700:4700::1111]:443 HTTP/1.1\r\nHost: [2606:4700:4700::1111]:443\r\n\r\n").await.unwrap();
        client.shutdown().await.unwrap();
        origin.shutdown().await.unwrap();
        let mut reply = Vec::new();
        timeout(Duration::from_secs(2), client.read_to_end(&mut reply))
            .await
            .unwrap()
            .unwrap();
        assert!(reply.starts_with(b"HTTP/1.1 200"));
        handler.await.unwrap().unwrap();
        assert_eq!(
            fake.dials.lock().unwrap()[0],
            "[2606:4700:4700::1111]:443".parse().unwrap()
        );
    }

    #[tokio::test]
    async fn oversized_header_is_rejected_even_with_delimiter_in_final_read() {
        let fake = Arc::new(FakeNetwork::new(&["93.184.216.34"]));
        let request = format!(
            "CONNECT allowed.test:443 HTTP/1.1\r\nX-Padding: {}\r\n\r\n",
            "a".repeat(MAX_HEADER_BYTES)
        );
        assert!(response(request.as_bytes(), &fake)
            .await
            .starts_with(b"HTTP/1.1 400"));
        assert_eq!(fake.resolutions.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn header_limit_counts_header_not_tunnel_read_ahead() {
        let (mut sender, receiver) = duplex(MAX_HEADER_BYTES * 2);
        let head = format!("X{}\r\n\r\n", "a".repeat(MAX_HEADER_BYTES - 5));
        sender
            .write_all(format!("{head}tunnel").as_bytes())
            .await
            .unwrap();
        let mut reader = BufReader::new(receiver);
        assert_eq!(
            read_section(&mut reader, b"\r\n\r\n", MAX_HEADER_BYTES)
                .await
                .unwrap()
                .len(),
            MAX_HEADER_BYTES
        );
        let mut tail = [0; 6];
        reader.read_exact(&mut tail).await.unwrap();
        assert_eq!(&tail, b"tunnel");
    }

    #[tokio::test]
    async fn header_dns_and_dial_timeouts_are_bounded() {
        for phase in ["header", "dns", "dial"] {
            let mut fake = FakeNetwork::new(&["93.184.216.34"]);
            if phase == "dns" {
                fake.resolve_delay = Duration::from_secs(10);
            }
            if phase == "dial" {
                fake.dial_delay = Duration::from_secs(10);
            }
            let fake = Arc::new(fake);
            let (mut client, handler) = spawn_client(policy(), &fake);
            client
                .write_all(if phase == "header" {
                    b"CONNECT allowed.test:443"
                } else {
                    b"CONNECT allowed.test:443 HTTP/1.1\r\n\r\n"
                })
                .await
                .unwrap();
            let mut reply = Vec::new();
            timeout(Duration::from_secs(2), client.read_to_end(&mut reply))
                .await
                .unwrap()
                .unwrap();
            let status = if phase == "header" { "408" } else { "504" };
            assert!(
                String::from_utf8(reply).unwrap().contains(status),
                "{phase}"
            );
            handler.await.unwrap().unwrap();
        }
    }

    #[tokio::test]
    async fn plain_http_rejects_ambiguous_framing_and_host_mismatch_before_dns() {
        let fake = Arc::new(FakeNetwork::new(&["93.184.216.34"]));
        for request in [
            "GET http://allowed.test/ HTTP/1.1\r\nHost: second.test\r\n\r\n",
            "GET http://allowed.test:81/ HTTP/1.1\r\nHost: allowed.test\r\n\r\n",
            "GET http://allowed.test/ HTTP/1.1\r\n\r\n",
            "GET http://allowed.test/ HTTP/1.1\r\nHost: allowed.test\r\nHost: allowed.test\r\n\r\n",
            "POST http://allowed.test/ HTTP/1.1\r\nHost: allowed.test\r\nContent-Length: 3\r\nTransfer-Encoding: chunked\r\n\r\n",
            "POST http://allowed.test/ HTTP/1.1\r\nHost: allowed.test\r\nContent-Length: 3\r\nContent-Length: 4\r\n\r\n",
            "POST http://allowed.test/ HTTP/1.1\r\nHost: allowed.test\r\nContent-Length: 3, 3\r\n\r\n",
            "POST http://allowed.test/ HTTP/1.1\r\nHost: allowed.test\r\nTransfer-Encoding: gzip, chunked\r\n\r\n",
            "GET http://allowed.test/ HTTP/1.1\r\nHost: allowed.test\r\nConnection: Host\r\n\r\n",
            "GET http://allowed.test/ HTTP/1.1\r\nHost: allowed.test\r\nUpgrade: websocket\r\n\r\n",
            "GET http://allowed.test/ HTTP/1.1\r\n Host: allowed.test\r\n\r\n",
            "GET http://allowed.test\\@denied.test/ HTTP/1.1\r\nHost: allowed.test\r\n\r\n",
            "GET http://user@allowed.test/ HTTP/1.1\r\nHost: allowed.test\r\n\r\n",
            "GET http://allowed.test/#fragment HTTP/1.1\r\nHost: allowed.test\r\n\r\n",
            "GET / HTTP/1.1\r\nHost: allowed.test\r\n\r\n",
            "GET ああああ HTTP/1.1\r\nHost: allowed.test\r\n\r\n",
        ] {
            assert!(response(request.as_bytes(), &fake).await.starts_with(b"HTTP/1.1 400"), "{request}");
        }
        assert_eq!(fake.resolutions.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn plain_http_strips_hop_headers_and_never_forwards_second_origin() {
        for body in [
            "",
            "Content-Length: 4\r\n",
            "Transfer-Encoding: chunked\r\n",
        ] {
            let fake = Arc::new(FakeNetwork::new(&["93.184.216.34"]));
            let origin = fake.upstream();
            let origin_task = tokio::spawn(async move {
                let mut origin = BufReader::new(origin);
                let head = read_section(&mut origin, b"\r\n\r\n", MAX_HEADER_BYTES)
                    .await
                    .unwrap();
                let parsed = parse_head(&head).unwrap();
                assert_eq!(parsed.first, "POST /path?q=1 HTTP/1.1");
                assert_eq!(parsed.one("host").unwrap(), Some("allowed.test:80"));
                assert_eq!(parsed.one("connection").unwrap(), Some("close"));
                for removed in [
                    "x-secret",
                    "proxy-authorization",
                    "proxy-connection",
                    "keep-alive",
                    "te",
                    "trailer",
                ] {
                    assert_eq!(parsed.one(removed).unwrap(), None, "{removed}");
                }
                let mut body = Vec::new();
                match parsed.framing().unwrap() {
                    Body::Length(n) => copy_exact(&mut origin, &mut body, n).await.unwrap(),
                    Body::Chunked => copy_chunked(&mut origin, &mut body).await.unwrap(),
                    Body::Unframed => panic!("missing explicit framing"),
                }
                assert!(
                    [b"".as_slice(), b"data", b"4\r\ndata\r\n0\r\n\r\n"].contains(&body.as_slice())
                );
                origin.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: x-origin\r\nX-Origin: secret\r\nProxy-Authenticate: secret\r\n\r\nok").await.unwrap();
                let mut tail = Vec::new();
                timeout(Duration::from_secs(2), origin.read_to_end(&mut tail))
                    .await
                    .unwrap()
                    .unwrap();
                assert!(tail.is_empty(), "second origin leaked: {tail:?}");
            });
            let data = if body.starts_with("Transfer") {
                "4;ignored=value\r\ndata\r\n0\r\nHost: denied.test\r\n\r\n"
            } else if body.is_empty() {
                ""
            } else {
                "data"
            };
            let request = format!("POST http://ALLOWED.test./path?q=1 HTTP/1.1\r\nHost: allowed.test:80\r\nConnection: keep-alive, X-Secret\r\nX-Secret: hidden\r\nProxy-Authorization: secret\r\nProxy-Connection: keep-alive\r\nKeep-Alive: timeout=5\r\nTE: trailers\r\nTrailer: Host\r\n{body}\r\n{data}GET http://second.test/ HTTP/1.1\r\nHost: second.test\r\n\r\n");
            let reply = response(request.as_bytes(), &fake).await;
            assert!(reply.ends_with(b"\r\n\r\nok"));
            assert!(!String::from_utf8(reply).unwrap().contains("secret"));
            origin_task.await.unwrap();
            assert_eq!(fake.resolutions.load(Ordering::SeqCst), 1);
            assert_eq!(fake.dials.lock().unwrap().len(), 1);
        }
    }

    #[tokio::test]
    async fn response_header_timeout_does_not_limit_request_body_duration() {
        let fake = Arc::new(FakeNetwork::new(&["93.184.216.34"]));
        let mut origin = BufReader::new(fake.upstream());
        let (mut client, handler) = spawn_client(policy(), &fake);
        client.write_all(b"POST http://allowed.test/ HTTP/1.1\r\nHost: allowed.test\r\nContent-Length: 4\r\n\r\n").await.unwrap();
        read_section(&mut origin, b"\r\n\r\n", MAX_HEADER_BYTES)
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
        client.write_all(b"data").await.unwrap();
        let mut body = [0; 4];
        timeout(Duration::from_secs(2), origin.read_exact(&mut body))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(&body, b"data");
        origin
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
            .await
            .unwrap();
        let mut reply = Vec::new();
        timeout(Duration::from_secs(2), client.read_to_end(&mut reply))
            .await
            .unwrap()
            .unwrap();
        assert!(reply.starts_with(b"HTTP/1.1 200"));
        handler.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn expect_continue_and_early_origin_response_do_not_deadlock_upload() {
        let fake = Arc::new(FakeNetwork::new(&["93.184.216.34"]));
        let mut origin = BufReader::new(fake.upstream());
        let (mut client, handler) = spawn_client(policy(), &fake);
        client.write_all(b"POST http://allowed.test/ HTTP/1.1\r\nHost: allowed.test\r\nContent-Length: 9999999\r\nExpect: 100-continue\r\n\r\n").await.unwrap();
        let header = read_section(&mut origin, b"\r\n\r\n", MAX_HEADER_BYTES)
            .await
            .unwrap();
        assert!(!String::from_utf8(header)
            .unwrap()
            .to_ascii_lowercase()
            .contains("expect:"));
        origin
            .write_all(b"HTTP/1.1 413 Content Too Large\r\nContent-Length: 0\r\n\r\n")
            .await
            .unwrap();
        let mut reply = Vec::new();
        timeout(Duration::from_secs(2), client.read_to_end(&mut reply))
            .await
            .unwrap()
            .unwrap();
        assert!(reply.starts_with(b"HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 413"));
        handler.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn chunked_response_and_head_response_are_framed_without_waiting_for_eof() {
        for method in ["GET", "HEAD"] {
            let fake = Arc::new(FakeNetwork::new(&["93.184.216.34"]));
            let mut origin = BufReader::new(fake.upstream());
            let (mut client, handler) = spawn_client(policy(), &fake);
            client
                .write_all(
                    format!("{method} http://allowed.test/ HTTP/1.1\r\nHost: allowed.test\r\n\r\n")
                        .as_bytes(),
                )
                .await
                .unwrap();
            read_section(&mut origin, b"\r\n\r\n", MAX_HEADER_BYTES)
                .await
                .unwrap();
            origin.write_all(b"HTTP/1.1 103 Early Hints\r\n\r\nHTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nok\r\n0\r\nX-Trailer: ignored\r\n\r\n").await.unwrap();
            let mut reply = Vec::new();
            timeout(Duration::from_secs(2), client.read_to_end(&mut reply))
                .await
                .unwrap()
                .unwrap();
            assert!(reply.starts_with(b"HTTP/1.1 200 OK"));
            if method == "GET" {
                assert!(reply.ends_with(b"2\r\nok\r\n0\r\n\r\n"));
            } else {
                assert!(reply.ends_with(b"\r\n\r\n"));
                assert!(!reply.ends_with(b"0\r\n\r\n"));
            }
            handler.await.unwrap().unwrap();
        }
    }

    #[derive(Clone, Copy)]
    enum Stall {
        ContentLengthUpload,
        ChunkedUpload,
        UpstreamNotReading,
        ResponseBody,
        ClientNotReading,
        Connect,
    }

    async fn assert_idle_releases_slot(stall: Stall) {
        let fake = Arc::new(FakeNetwork::new(&["93.184.216.34"]));
        let origin_capacity = if matches!(stall, Stall::UpstreamNotReading) {
            1024
        } else {
            64 * 1024
        };
        let mut origin = BufReader::new(fake.upstream_with_capacity(origin_capacity));
        let mut rules = policy();
        rules.max_concurrent_connections = 1;
        rules.idle_timeout = Duration::from_millis(100);
        // These regressions must be rescued by idle expiry, not a header timer.
        rules.header_timeout = Duration::from_secs(10);
        let (sender, receiver) = tokio::sync::mpsc::channel(2);
        let mut proxy = FilteringProxy::spawn(
            Listener::Memory(receiver),
            ProxyEndpoint::Tcp(0),
            rules,
            injected(&fake),
        );
        let client_capacity = if matches!(stall, Stall::UpstreamNotReading) {
            128 * 1024
        } else {
            1024
        };
        let (client, server) = duplex(client_capacity);
        let mut client = BufReader::new(client);
        sender.send(Box::new(server)).await.unwrap();
        let request = match stall {
            Stall::ContentLengthUpload => "POST http://allowed.test/ HTTP/1.1\r\nHost: allowed.test\r\nContent-Length: 1\r\n\r\n",
            Stall::ChunkedUpload => "POST http://allowed.test/ HTTP/1.1\r\nHost: allowed.test\r\nTransfer-Encoding: chunked\r\n\r\n3\r\na",
            Stall::UpstreamNotReading => "POST http://allowed.test/ HTTP/1.1\r\nHost: allowed.test\r\nContent-Length: 65536\r\n\r\n",
            Stall::ResponseBody | Stall::ClientNotReading => "GET http://allowed.test/ HTTP/1.1\r\nHost: allowed.test\r\n\r\n",
            Stall::Connect => "CONNECT allowed.test:443 HTTP/1.1\r\n\r\n",
        };
        client.write_all(request.as_bytes()).await.unwrap();
        if matches!(stall, Stall::Connect) {
            let response = timeout(
                Duration::from_secs(2),
                read_section(&mut client, b"\r\n\r\n", MAX_HEADER_BYTES),
            )
            .await
            .unwrap()
            .unwrap();
            assert!(response.starts_with(b"HTTP/1.1 200"));
        } else {
            timeout(
                Duration::from_secs(2),
                read_section(&mut origin, b"\r\n\r\n", MAX_HEADER_BYTES),
            )
            .await
            .unwrap()
            .unwrap();
        }
        match stall {
            Stall::UpstreamNotReading => {
                // Fits in the client transport but not in the origin transport.
                client.write_all(&vec![b'x'; 65536]).await.unwrap();
            }
            Stall::ResponseBody => {
                origin
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\n")
                    .await
                    .unwrap();
                timeout(
                    Duration::from_secs(2),
                    read_section(&mut client, b"\r\n\r\n", MAX_HEADER_BYTES),
                )
                .await
                .unwrap()
                .unwrap();
            }
            Stall::ClientNotReading => {
                origin
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 16384\r\n\r\n")
                    .await
                    .unwrap();
                // Fits in the origin transport; blocks the proxy's client write.
                origin.write_all(&vec![b'x'; 16384]).await.unwrap();
            }
            _ => {}
        }
        let (mut next, server) = duplex(1024);
        sender.send(Box::new(server)).await.unwrap();
        next.write_all(b"CONNECT denied.test:443 HTTP/1.1\r\n\r\n")
            .await
            .unwrap();
        // No first-leg reads here: they would relieve the deliberately stalled
        // writer. The queued request can run only after the first slot expires.
        let mut reply = Vec::new();
        timeout(Duration::from_secs(2), next.read_to_end(&mut reply))
            .await
            .expect("idle connection must release its slot")
            .unwrap();
        assert!(reply.starts_with(b"HTTP/1.1 403"));
        assert_eq!(fake.dials.lock().unwrap().len(), 1);
        for stream in [&mut client, &mut origin] {
            timeout(Duration::from_secs(2), stream.read_to_end(&mut Vec::new()))
                .await
                .expect("both idle legs must close")
                .unwrap();
        }
        proxy.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn idle_content_length_upload_frees_slot() {
        assert_idle_releases_slot(Stall::ContentLengthUpload).await;
    }

    #[tokio::test]
    async fn idle_chunked_upload_frees_slot() {
        assert_idle_releases_slot(Stall::ChunkedUpload).await;
    }

    #[tokio::test]
    async fn idle_upstream_not_reading_upload_frees_slot() {
        assert_idle_releases_slot(Stall::UpstreamNotReading).await;
    }

    #[tokio::test]
    async fn idle_response_body_frees_slot() {
        assert_idle_releases_slot(Stall::ResponseBody).await;
    }

    #[tokio::test]
    async fn idle_client_not_reading_response_frees_slot() {
        assert_idle_releases_slot(Stall::ClientNotReading).await;
    }

    #[tokio::test]
    async fn idle_connect_tunnel_frees_slot() {
        assert_idle_releases_slot(Stall::Connect).await;
    }

    #[tokio::test]
    async fn idle_timeout_keeps_slow_active_http_and_connect_transfers_alive() {
        for direction in ["upload", "download", "connect-upload", "connect-download"] {
            let fake = Arc::new(FakeNetwork::new(&["93.184.216.34"]));
            let mut origin = BufReader::new(fake.upstream());
            let mut rules = policy();
            rules.idle_timeout = Duration::from_millis(200);
            rules.header_timeout = Duration::from_secs(2);
            let (client, handler) = spawn_client(rules, &fake);
            let mut client = BufReader::new(client);
            let connect = direction.starts_with("connect-");
            let request = if connect {
                "CONNECT allowed.test:443 HTTP/1.1\r\n\r\n"
            } else if direction == "upload" {
                "POST http://allowed.test/ HTTP/1.1\r\nHost: allowed.test\r\nContent-Length: 10\r\n\r\n"
            } else {
                "GET http://allowed.test/ HTTP/1.1\r\nHost: allowed.test\r\n\r\n"
            };
            client.write_all(request.as_bytes()).await.unwrap();
            if connect {
                read_section(&mut client, b"\r\n\r\n", MAX_HEADER_BYTES)
                    .await
                    .unwrap();
                // The quiet half is already closed; activity on the other
                // half must keep the tunnel alive beyond the idle interval.
                if direction.ends_with("upload") {
                    origin.shutdown().await.unwrap();
                } else {
                    client.shutdown().await.unwrap();
                }
            } else {
                read_section(&mut origin, b"\r\n\r\n", MAX_HEADER_BYTES)
                    .await
                    .unwrap();
                if direction == "download" {
                    // SSE-style close-delimited response: no total body deadline.
                    origin
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
                        .await
                        .unwrap();
                    read_section(&mut client, b"\r\n\r\n", MAX_HEADER_BYTES)
                        .await
                        .unwrap();
                }
            }
            let start = tokio::time::Instant::now();
            for byte in 0..10 {
                tokio::time::sleep(Duration::from_millis(50)).await;
                let (writer, reader) = if direction.ends_with("upload") {
                    (&mut client, &mut origin)
                } else {
                    (&mut origin, &mut client)
                };
                writer.write_all(&[byte]).await.unwrap();
                assert_eq!(
                    timeout(Duration::from_secs(2), reader.read_u8())
                        .await
                        .unwrap()
                        .unwrap(),
                    byte,
                    "{direction}"
                );
            }
            assert!(start.elapsed() > Duration::from_millis(400));
            if direction == "upload" {
                origin
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
                    .await
                    .unwrap();
            }
            origin.shutdown().await.unwrap();
            client.shutdown().await.unwrap();
            timeout(Duration::from_secs(2), client.read_to_end(&mut Vec::new()))
                .await
                .unwrap()
                .unwrap();
            timeout(Duration::from_secs(2), handler)
                .await
                .unwrap()
                .unwrap()
                .unwrap();
        }
    }

    #[tokio::test]
    async fn concurrency_limit_and_shutdown_own_every_tunnel() {
        let fake = Arc::new(FakeNetwork::new(&["93.184.216.34"]));
        let mut origin = fake.upstream();
        let _second_origin = fake.upstream();
        let mut rules = policy();
        rules.max_concurrent_connections = 1;
        let (sender, receiver) = tokio::sync::mpsc::channel(2);
        let mut proxy = FilteringProxy::spawn(
            Listener::Memory(receiver),
            ProxyEndpoint::Tcp(0),
            rules,
            injected(&fake),
        );
        let (mut first, first_server) = duplex(1024);
        sender.send(Box::new(first_server)).await.unwrap();
        first
            .write_all(b"CONNECT allowed.test:443 HTTP/1.1\r\n\r\n")
            .await
            .unwrap();
        let mut first = BufReader::new(first);
        assert!(read_section(&mut first, b"\r\n\r\n", MAX_HEADER_BYTES)
            .await
            .unwrap()
            .starts_with(b"HTTP/1.1 200"));
        let (mut second, second_server) = duplex(1024);
        sender.send(Box::new(second_server)).await.unwrap();
        second
            .write_all(b"CONNECT allowed.test:443 HTTP/1.1\r\n\r\n")
            .await
            .unwrap();
        assert!(timeout(Duration::from_millis(30), second.read_u8())
            .await
            .is_err());
        assert_eq!(fake.dials.lock().unwrap().len(), 1);
        timeout(Duration::from_secs(2), proxy.shutdown())
            .await
            .unwrap()
            .unwrap();
        proxy.shutdown().await.unwrap();
        assert_eq!(first.read(&mut [0]).await.unwrap(), 0);
        assert_eq!(origin.read(&mut [0]).await.unwrap(), 0);
        assert_eq!(second.read(&mut [0]).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn completed_connections_release_capacity_and_drop_cancels_tunnels() {
        let fake = Arc::new(FakeNetwork::new(&["93.184.216.34"]));
        let mut origin = fake.upstream();
        let mut rules = policy();
        rules.max_concurrent_connections = 1;
        let (sender, receiver) = tokio::sync::mpsc::channel(2);
        let proxy = FilteringProxy::spawn(
            Listener::Memory(receiver),
            ProxyEndpoint::Tcp(0),
            rules,
            injected(&fake),
        );
        let (mut denied, server) = duplex(1024);
        sender.send(Box::new(server)).await.unwrap();
        denied
            .write_all(b"CONNECT denied.test:443 HTTP/1.1\r\n\r\n")
            .await
            .unwrap();
        let mut reply = Vec::new();
        timeout(Duration::from_secs(2), denied.read_to_end(&mut reply))
            .await
            .unwrap()
            .unwrap();
        assert!(reply.starts_with(b"HTTP/1.1 403"));
        let (mut client, server) = duplex(1024);
        sender.send(Box::new(server)).await.unwrap();
        client
            .write_all(b"CONNECT allowed.test:443 HTTP/1.1\r\n\r\n")
            .await
            .unwrap();
        let mut client = BufReader::new(client);
        timeout(
            Duration::from_secs(2),
            read_section(&mut client, b"\r\n\r\n", MAX_HEADER_BYTES),
        )
        .await
        .unwrap()
        .unwrap();
        drop(proxy);
        assert_eq!(
            timeout(Duration::from_secs(2), client.read(&mut [0]))
                .await
                .unwrap()
                .unwrap(),
            0
        );
        assert_eq!(
            timeout(Duration::from_secs(2), origin.read(&mut [0]))
                .await
                .unwrap()
                .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn public_accepted_stream_entry_uses_the_same_policy_gate() {
        let (mut client, server) = duplex(1024);
        let handler = tokio::spawn(serve_stream(server, Vec::<String>::new()));
        client
            .write_all(b"CONNECT denied.test:443 HTTP/1.1\r\n\r\n")
            .await
            .unwrap();
        let mut reply = Vec::new();
        timeout(Duration::from_secs(2), client.read_to_end(&mut reply))
            .await
            .unwrap()
            .unwrap();
        assert!(reply.starts_with(b"HTTP/1.1 403"));
        handler.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn tcp_listener_uses_shared_handler() {
        let mut proxy = FilteringProxy::start(Vec::new()).await.unwrap();
        assert_eq!(proxy.endpoint(), &ProxyEndpoint::Tcp(proxy.port()));
        let mut client = TcpStream::connect(("127.0.0.1", proxy.port()))
            .await
            .unwrap();
        client
            .write_all(b"GET http://denied.test/ HTTP/1.1\r\nHost: denied.test\r\n\r\n")
            .await
            .unwrap();
        let mut reply = Vec::new();
        timeout(Duration::from_secs(2), client.read_to_end(&mut reply))
            .await
            .unwrap()
            .unwrap();
        assert!(reply.starts_with(b"HTTP/1.1 403"));
        proxy.shutdown().await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unix_listener_uses_shared_handler_and_cleans_up_only_owned_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("proxy.sock");
        let mut proxy = FilteringProxy::start_unix(&path, Vec::new()).await.unwrap();
        assert_eq!(proxy.endpoint(), &ProxyEndpoint::Unix(path.clone()));
        assert!(FilteringProxy::start_unix(&path, Vec::new()).await.is_err());
        let mut client = tokio::net::UnixStream::connect(&path).await.unwrap();
        client
            .write_all(b"CONNECT denied.test:443 HTTP/1.1\r\n\r\n")
            .await
            .unwrap();
        let mut reply = Vec::new();
        timeout(Duration::from_secs(2), client.read_to_end(&mut reply))
            .await
            .unwrap()
            .unwrap();
        assert!(reply.starts_with(b"HTTP/1.1 403"));
        proxy.shutdown().await.unwrap();
        assert!(!path.exists());
        let mut proxy = FilteringProxy::start_unix(&path, Vec::new()).await.unwrap();
        std::fs::remove_file(&path).unwrap();
        std::fs::write(&path, b"replacement").unwrap();
        proxy.shutdown().await.unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"replacement");
    }

    #[test]
    fn invalid_resource_limits_fail_closed() {
        let mut rules = policy();
        rules.max_concurrent_connections = 0;
        assert!(rules.validate().is_err());
        rules = policy();
        rules.header_timeout = Duration::ZERO;
        assert!(rules.validate().is_err());
        rules = policy();
        rules.idle_timeout = Duration::ZERO;
        assert!(rules.validate().is_err());
    }
    /// The upstream leg must obey the Host proxy policy.
    ///
    /// One test, not several: the policy is process-wide, so separate tests in
    /// the same binary would race each other's `apply`/`block`.
    #[tokio::test]
    async fn upstream_dial_follows_the_host_proxy_policy() {
        use cognia_net::proxy_config::{
            apply_current, block_current, ProxyConfig, ProxyError, ProxyErrorCode, ProxyMode,
            ProxyProtocol,
        };

        // A real listener stands in for the vetted public address on the
        // direct leg; nothing ever connects to it on the proxied leg.
        let origin = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let vetted = origin.local_addr().unwrap();

        // 1. A blocked policy fails closed — never a silent direct dial.
        block_current(ProxyError::new(
            ProxyErrorCode::ProxyCredentialUnavailable,
            "test",
        ));
        assert!(dial_upstream("api.github.com", 443, vetted).await.is_err());

        // 2. Proxy off → direct, to the exact address `resolve_public_addr`
        //    vetted rather than a re-resolution of the name.
        apply_current(ProxyConfig::default()).unwrap();
        assert!(dial_upstream("api.github.com", 443, vetted).await.is_ok());

        // 3. Proxy on → the direct dial must NOT happen. Pointing the config at
        //    a closed port proves it: a direct fallback would reach `vetted`
        //    and succeed, so an error here is the assertion.
        let closed = {
            let probe = tokio::net::TcpListener::bind(("127.0.0.1", 0))
                .await
                .unwrap();
            let port = probe.local_addr().unwrap().port();
            drop(probe);
            port
        };
        apply_current(ProxyConfig {
            mode: ProxyMode::Manual,
            protocol: ProxyProtocol::Http,
            host: "127.0.0.1".to_string(),
            port: closed,
            bypass: vec![],
            ..ProxyConfig::default()
        })
        .unwrap();
        assert!(
            dial_upstream("api.github.com", 443, vetted).await.is_err(),
            "an active proxy must not fall back to a direct dial"
        );

        // 4. A bypassed host still goes direct, so a loopback or intranet
        //    target keeps working while the proxy is on.
        apply_current(ProxyConfig {
            mode: ProxyMode::Manual,
            protocol: ProxyProtocol::Http,
            host: "127.0.0.1".to_string(),
            port: closed,
            bypass: vec!["api.github.com".to_string()],
            ..ProxyConfig::default()
        })
        .unwrap();
        assert!(dial_upstream("api.github.com", 443, vetted).await.is_ok());

        apply_current(ProxyConfig::default()).unwrap();
    }
}

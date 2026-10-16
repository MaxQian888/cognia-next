//! envd's process service: start a process in a sandbox, stream its output,
//! write its stdin.
//!
//! envd is the agent inside every E2B sandbox, reached at
//! `https://49983-<sandboxID>.<domain>`. Requests carry the sandbox's
//! `X-Access-Token` and `Authorization: Basic base64("root:")`, which is how
//! the official SDK selects the user a process runs as (`user: 'root'`); envd
//! resolves the Basic username to the account it spawns under.
//!
//! What this relies on, from envd's `process` service:
//!
//! - `Start` spawns under a context detached from the request unless the
//!   request carries `Connect-Timeout-Ms`, so a client that disconnects does
//!   not kill the process. This client never sends that header: a long-lived
//!   supervisor, agent session or bridge must outlive any deadline here.
//! - Output is fanned out only to live subscribers; once the stream is
//!   dropped, output is read and discarded, never blocking the process.
//! - A quiet stream carries a keepalive every `Keepalive-Ping-Interval`
//!   seconds, so a dead connection is told from an idle process by a read
//!   timeout a few intervals long.
//! - proto3 JSON omits zero values: an `end` event without `exitCode` is an
//!   exit with status 0.

use std::collections::BTreeMap;
use std::fmt;
use std::time::Duration;

use base64::Engine as _;
use serde::Deserialize;
use serde_json::json;
use url::Url;

use super::connect::{
    encode_envelope, parse_unary_error, truncate, ConnectError, EnvelopeDecoder, Frame,
    FramingError,
};

/// envd's port inside every sandbox.
pub const ENVD_PORT: u16 = 49983;
/// The interval envd is asked to send keepalives at, as the SDK does.
const KEEPALIVE_PING_SECS: u64 = 50;
/// No byte for three keepalive intervals means the connection is gone.
const STREAM_READ_TIMEOUT: Duration = Duration::from_secs(3 * KEEPALIVE_PING_SECS);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const TCP_KEEPALIVE: Duration = Duration::from_secs(30);
/// Whole-exchange ceiling for `CloseStdin`, which never blocks in envd.
/// `SendInput` has none: envd answers it once the bytes are in the pipe, so
/// a process that is busy and not reading holds it — backpressure, as a
/// Docker attach write blocks, not a failure. TCP keepalive finds a dead peer.
const CLOSE_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_UNARY_RESPONSE_BYTES: usize = 64 * 1024;
const USER_AGENT: &str = concat!("cognia-sandbox-pool/", env!("CARGO_PKG_VERSION"));

/// Where one sandbox's envd answers, and the token it wants.
#[derive(Clone)]
pub struct EnvdEndpoint {
    pub base: Url,
    pub sandbox_id: String,
    pub access_token: Option<String>,
}

impl fmt::Debug for EnvdEndpoint {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("EnvdEndpoint")
            .field("base", &self.base.origin().ascii_serialization())
            .field("sandbox_id", &self.sandbox_id)
            .field(
                "access_token",
                &self.access_token.as_ref().map(|_| "<redacted>"),
            )
            .finish()
    }
}

/// `https://49983-<sandboxID>.<domain>/`.
pub fn default_envd_base(sandbox_id: &str, domain: &str) -> Result<Url, String> {
    let raw = format!("https://{ENVD_PORT}-{sandbox_id}.{domain}/");
    Url::parse(&raw).map_err(|error| format!("envd address {raw:?} is invalid: {error}"))
}

/// One process to start.
#[derive(Clone, PartialEq, Eq)]
pub struct StartSpec {
    pub cmd: String,
    pub args: Vec<String>,
    pub envs: BTreeMap<String, String>,
    pub cwd: Option<String>,
    /// Whether the process gets a stdin pipe (else `/dev/null`).
    pub stdin: bool,
}

impl fmt::Debug for StartSpec {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("StartSpec")
            .field("cmd", &self.cmd)
            .field("args", &"<redacted>")
            .field("env_keys", &self.envs.keys().collect::<Vec<_>>())
            .field("cwd", &self.cwd)
            .field("stdin", &self.stdin)
            .finish()
    }
}

/// How a process ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EndStatus {
    pub exit_code: Option<i32>,
    pub exited: bool,
    /// Go's `ProcessState.String()`: `exit status 2`, `signal: killed`.
    pub status: String,
    pub error: Option<String>,
}

impl EndStatus {
    /// The exit code a shell would report: the status for a normal exit,
    /// `128 + n` for a death by signal `n`, `None` when neither is known.
    pub fn code(&self) -> Option<i64> {
        if self.exited {
            return Some(i64::from(self.exit_code.unwrap_or(0)));
        }
        if let Some(signal) = signal_number(&self.status) {
            return Some(128 + signal);
        }
        self.exit_code.filter(|code| *code >= 0).map(i64::from)
    }
}

/// Linux signal numbers for the names Go prints (`syscall.Signal.String`).
fn signal_number(status: &str) -> Option<i64> {
    let name = status.strip_prefix("signal: ")?;
    let name = name.strip_suffix(" (core dumped)").unwrap_or(name);
    Some(match name {
        "hangup" => 1,
        "interrupt" => 2,
        "quit" => 3,
        "illegal instruction" => 4,
        "trace/breakpoint trap" => 5,
        "aborted" => 6,
        "bus error" => 7,
        "floating point exception" => 8,
        "killed" => 9,
        "user defined signal 1" => 10,
        "segmentation fault" => 11,
        "user defined signal 2" => 12,
        "broken pipe" => 13,
        "alarm clock" => 14,
        "terminated" => 15,
        _ => return None,
    })
}

/// One event of a started process.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProcessEvent {
    Start { pid: u32 },
    Stdout(Vec<u8>),
    Stderr(Vec<u8>),
    End(EndStatus),
    Keepalive,
}

/// Why an envd call failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EnvdError {
    /// envd refused the access token.
    Unauthorized(String),
    /// The connection failed or broke.
    Transport(String),
    /// envd answered the call with an error.
    Rpc(ConnectError),
    /// envd answered something this client cannot read.
    Protocol(String),
}

impl fmt::Display for EnvdError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unauthorized(message) => write!(f, "envd refused the access token: {message}"),
            Self::Transport(message) => write!(f, "envd is unreachable: {message}"),
            Self::Rpc(error) => write!(f, "envd refused the call: {error}"),
            Self::Protocol(message) => write!(f, "envd answered unexpectedly: {message}"),
        }
    }
}

impl From<FramingError> for EnvdError {
    fn from(error: FramingError) -> Self {
        Self::Protocol(error.to_string())
    }
}

#[derive(Debug, Deserialize)]
struct WireResponse {
    #[serde(default)]
    event: Option<WireEvent>,
}

#[derive(Debug, Deserialize)]
struct WireEvent {
    #[serde(default)]
    start: Option<WireStart>,
    #[serde(default)]
    data: Option<WireData>,
    #[serde(default)]
    end: Option<WireEnd>,
    #[serde(default)]
    keepalive: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct WireStart {
    #[serde(default)]
    pid: u32,
}

#[derive(Debug, Deserialize)]
struct WireData {
    #[serde(default)]
    stdout: Option<String>,
    #[serde(default)]
    stderr: Option<String>,
    #[serde(default)]
    pty: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireEnd {
    #[serde(default, alias = "exit_code")]
    exit_code: Option<i32>,
    #[serde(default)]
    exited: bool,
    #[serde(default)]
    status: String,
    #[serde(default)]
    error: Option<String>,
}

/// proto3 JSON writes `bytes` as standard base64; URL-safe and unpadded
/// spellings are accepted on input, so they are here too.
fn decode_bytes(text: &str) -> Result<Vec<u8>, String> {
    use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD};
    STANDARD
        .decode(text)
        .or_else(|_| STANDARD_NO_PAD.decode(text))
        .or_else(|_| URL_SAFE.decode(text))
        .or_else(|_| URL_SAFE_NO_PAD.decode(text))
        .map_err(|error| format!("output is not base64: {error}"))
}

/// One `StartResponse` message.
pub fn decode_event(payload: &[u8]) -> Result<ProcessEvent, EnvdError> {
    let response: WireResponse = serde_json::from_slice(payload)
        .map_err(|error| EnvdError::Protocol(format!("event is not JSON: {error}")))?;
    let event = response
        .event
        .ok_or_else(|| EnvdError::Protocol("a message without an event".into()))?;
    if let Some(start) = event.start {
        if start.pid == 0 {
            return Err(EnvdError::Protocol("a start event without a pid".into()));
        }
        return Ok(ProcessEvent::Start { pid: start.pid });
    }
    if let Some(data) = event.data {
        return match (data.stdout, data.stderr, data.pty) {
            (Some(stdout), _, _) => decode_bytes(&stdout)
                .map(ProcessEvent::Stdout)
                .map_err(EnvdError::Protocol),
            (None, Some(stderr), _) => decode_bytes(&stderr)
                .map(ProcessEvent::Stderr)
                .map_err(EnvdError::Protocol),
            // Never requested; a terminal multiplexes both streams anyway.
            (None, None, Some(pty)) => decode_bytes(&pty)
                .map(ProcessEvent::Stdout)
                .map_err(EnvdError::Protocol),
            // An empty chunk: proto3 JSON drops the empty field entirely.
            (None, None, None) => Ok(ProcessEvent::Stdout(Vec::new())),
        };
    }
    if let Some(end) = event.end {
        return Ok(ProcessEvent::End(EndStatus {
            exit_code: end.exit_code,
            exited: end.exited,
            status: end.status,
            error: end.error.filter(|error| !error.is_empty()),
        }));
    }
    if event.keepalive.is_some() {
        return Ok(ProcessEvent::Keepalive);
    }
    Err(EnvdError::Protocol("an event of an unknown kind".into()))
}

/// The response stream of one `Start` call.
pub struct ProcessStream {
    response: reqwest::Response,
    decoder: EnvelopeDecoder,
    done: bool,
}

impl ProcessStream {
    /// The next event; `Ok(None)` once the call has completed cleanly.
    pub async fn next_event(&mut self) -> Result<Option<ProcessEvent>, EnvdError> {
        loop {
            if let Some(frame) = self.decoder.next_frame()? {
                return match frame {
                    Frame::Message(payload) => decode_event(&payload).map(Some),
                    Frame::End(None) => {
                        self.done = true;
                        Ok(None)
                    }
                    Frame::End(Some(error)) => {
                        self.done = true;
                        Err(EnvdError::Rpc(error))
                    }
                };
            }
            if self.done {
                return Ok(None);
            }
            match self.response.chunk().await {
                Ok(Some(chunk)) => self.decoder.push(&chunk),
                Ok(None) => {
                    self.done = true;
                    self.decoder.finish()?;
                    return Err(EnvdError::Protocol(
                        "the stream ended without an end-of-stream message".into(),
                    ));
                }
                Err(error) => {
                    self.done = true;
                    return Err(EnvdError::Transport(error.without_url().to_string()));
                }
            }
        }
    }
}

fn basic_root() -> String {
    format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD.encode("root:")
    )
}

fn rpc_url(endpoint: &EnvdEndpoint, method: &str) -> Result<Url, EnvdError> {
    endpoint
        .base
        .join(&format!("process.Process/{method}"))
        .map_err(|error| EnvdError::Protocol(format!("envd address: {error}")))
}

/// A client bound to the Host's proxy policy for `url`. `read_timeout` bounds
/// the silence a stream tolerates; unary calls carry their own timeouts.
fn client(url: &Url, read_timeout: Option<Duration>) -> Result<reqwest::Client, EnvdError> {
    let mut builder = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(CONNECT_TIMEOUT)
        .tcp_keepalive(TCP_KEEPALIVE)
        .redirect(reqwest::redirect::Policy::none());
    if let Some(timeout) = read_timeout {
        builder = builder.read_timeout(timeout);
    }
    cognia_net::proxy_config::managed_client(builder, url.as_str())
        .map_err(|error| EnvdError::Transport(format!("network policy: {error}")))
}

fn secret_header(value: &str) -> Result<reqwest::header::HeaderValue, EnvdError> {
    let mut header = reqwest::header::HeaderValue::from_str(value)
        .map_err(|_| EnvdError::Protocol("invalid protected header".into()))?;
    header.set_sensitive(true);
    Ok(header)
}

fn authorize(
    request: reqwest::RequestBuilder,
    endpoint: &EnvdEndpoint,
) -> Result<reqwest::RequestBuilder, EnvdError> {
    let mut request = request
        .header("authorization", secret_header(&basic_root())?)
        .header("e2b-sandbox-id", endpoint.sandbox_id.as_str())
        .header("e2b-sandbox-port", ENVD_PORT.to_string());
    if let Some(token) = &endpoint.access_token {
        request = request.header("x-access-token", secret_header(token)?);
    }
    Ok(request)
}

/// The error a refused call answered with, read from a bounded body.
async fn refusal(status: u16, mut response: reqwest::Response) -> EnvdError {
    let mut body = Vec::new();
    while let Ok(Some(chunk)) = response.chunk().await {
        body.extend_from_slice(&chunk);
        if body.len() >= MAX_UNARY_RESPONSE_BYTES {
            break;
        }
    }
    let error = parse_unary_error(status, &body);
    if status == 401 {
        EnvdError::Unauthorized(truncate(&error.message, 512))
    } else {
        EnvdError::Rpc(error)
    }
}

/// Starts `spec` and returns its event stream. The first event is `Start`
/// unless the call fails.
pub async fn start(endpoint: &EnvdEndpoint, spec: &StartSpec) -> Result<ProcessStream, EnvdError> {
    start_with_traffic(endpoint, spec, None).await
}

async fn start_with_traffic(
    endpoint: &EnvdEndpoint,
    spec: &StartSpec,
    traffic_token: Option<&str>,
) -> Result<ProcessStream, EnvdError> {
    let url = rpc_url(endpoint, "Start")?;
    let mut process = json!({
        "cmd": spec.cmd,
        "args": spec.args,
        "envs": spec.envs,
    });
    if let Some(cwd) = &spec.cwd {
        process["cwd"] = json!(cwd);
    }
    let body = json!({ "process": process, "stdin": spec.stdin });
    let payload = serde_json::to_vec(&body).expect("a JSON value serializes");
    let request = client(&url, Some(STREAM_READ_TIMEOUT))?
        .post(url)
        .header("content-type", "application/connect+json")
        .header("keepalive-ping-interval", KEEPALIVE_PING_SECS.to_string())
        .body(encode_envelope(&payload));
    let request = match traffic_token {
        Some(token) => request.header("e2b-traffic-access-token", secret_header(token)?),
        None => request,
    };
    let response = authorize(request, endpoint)?
        .send()
        .await
        .map_err(|error| EnvdError::Transport(error.without_url().to_string()))?;
    let status = response.status().as_u16();
    if status != 200 {
        return Err(refusal(status, response).await);
    }
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !content_type.starts_with("application/connect+json") {
        return Err(EnvdError::Protocol(format!(
            "a stream of type {content_type:?}"
        )));
    }
    Ok(ProcessStream {
        response,
        decoder: EnvelopeDecoder::default(),
        done: false,
    })
}

/// The unary calls of one process (`SendInput`, `CloseStdin`) over one
/// client, so a stream of stdin chunks reuses one connection instead of
/// paying a handshake per chunk. The client is built once per process: the
/// proxy policy is read when the process starts, as for its output stream.
pub struct ProcessInput {
    endpoint: EnvdEndpoint,
    pid: u32,
    client: reqwest::Client,
    traffic_token: Option<String>,
}

impl ProcessInput {
    pub fn new(endpoint: EnvdEndpoint, pid: u32) -> Result<Self, EnvdError> {
        let probe = rpc_url(&endpoint, "SendInput")?;
        let client = client(&probe, None)?;
        Ok(Self {
            endpoint,
            pid,
            client,
            traffic_token: None,
        })
    }

    /// Protected managed-desktop stdin; provider traffic auth remains Host-only.
    pub fn for_desktop(bootstrap: &DesktopBootstrap, pid: u32) -> Result<Self, EnvdError> {
        let mut input = Self::new(bootstrap.endpoint()?, pid)?;
        input.traffic_token = Some(bootstrap.traffic_access_token.clone());
        Ok(input)
    }

    async fn unary(
        &self,
        method: &str,
        body: serde_json::Value,
        timeout: Option<Duration>,
    ) -> Result<(), EnvdError> {
        let url = rpc_url(&self.endpoint, method)?;
        let mut request = self
            .client
            .post(url)
            .header("content-type", "application/json")
            .header("connect-protocol-version", "1")
            .body(serde_json::to_vec(&body).expect("a JSON value serializes"));
        if let Some(timeout) = timeout {
            request = request.timeout(timeout);
        }
        if let Some(token) = &self.traffic_token {
            request = request.header("e2b-traffic-access-token", secret_header(token)?);
        }
        let response = authorize(request, &self.endpoint)?
            .send()
            .await
            .map_err(|error| EnvdError::Transport(error.without_url().to_string()))?;
        let status = response.status().as_u16();
        if status != 200 {
            return Err(refusal(status, response).await);
        }
        Ok(())
    }

    /// Writes `bytes` to the process's stdin; returns once envd has written
    /// them to the pipe.
    pub async fn send(&self, bytes: &[u8]) -> Result<(), EnvdError> {
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        self.unary(
            "SendInput",
            json!({ "process": { "pid": self.pid }, "input": { "stdin": encoded } }),
            None,
        )
        .await
    }

    /// Closes the process's stdin (EOF).
    pub async fn close(&self) -> Result<(), EnvdError> {
        self.unary(
            "CloseStdin",
            json!({ "process": { "pid": self.pid } }),
            Some(CLOSE_TIMEOUT),
        )
        .await
    }
}

/// Runtime-only credentials for one already-persisted managed desktop resource.
/// This value must never be placed in template build inputs or global sandbox envVars.
#[derive(Clone)]
pub struct DesktopBootstrap {
    pub sandbox_id: String,
    pub domain: String,
    pub envd_access_token: String,
    pub traffic_access_token: String,
    pub guest_token: String,
}

impl fmt::Debug for DesktopBootstrap {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DesktopBootstrap")
            .field("sandbox_id", &self.sandbox_id)
            .field("credentials", &"<redacted>")
            .finish()
    }
}

impl DesktopBootstrap {
    fn endpoint(&self) -> Result<EnvdEndpoint, EnvdError> {
        let safe_id = !self.sandbox_id.is_empty()
            && self.sandbox_id.len() <= 128
            && self
                .sandbox_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-');
        let domain = self.domain.to_ascii_lowercase();
        let safe_domain = ["e2b.app", "e2b.dev"]
            .iter()
            .any(|suffix| domain == *suffix || domain.ends_with(&format!(".{suffix}")))
            && domain.split('.').all(|part| {
                !part.is_empty()
                    && !part.starts_with('-')
                    && !part.ends_with('-')
                    && part.len() <= 63
                    && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            });
        if !safe_id || !safe_domain || domain.len() > 253 {
            return Err(EnvdError::Protocol("untrusted desktop endpoint".into()));
        }
        for token in [
            &self.envd_access_token,
            &self.traffic_access_token,
            &self.guest_token,
        ] {
            if token.is_empty() || token.len() > 8192 || token.chars().any(char::is_control) {
                return Err(EnvdError::Protocol(
                    "invalid desktop runtime credential".into(),
                ));
            }
            secret_header(token)?;
        }
        Ok(EnvdEndpoint {
            base: default_envd_base(&self.sandbox_id, &domain).map_err(EnvdError::Protocol)?,
            sandbox_id: self.sandbox_id.clone(),
            access_token: Some(self.envd_access_token.clone()),
        })
    }
}

/// Host-internal process transport for the fixed acceptance installer. This is
/// not an RPC accepting browser commands. Both endpoint and edge auth validate.
pub async fn start_protected(
    bootstrap: &DesktopBootstrap,
    spec: &StartSpec,
) -> Result<ProcessStream, EnvdError> {
    start_with_traffic(
        &bootstrap.endpoint()?,
        spec,
        Some(&bootstrap.traffic_access_token),
    )
    .await
}

/// Starts the pinned image's entrypoint once, after the Host durably records the
/// resource ID and runtime secrets. The returned PID only acknowledges creation;
/// the caller must still verify authenticated image identity and GUI health.
///
/// A failure after dispatch has an uncertain outcome: quarantine and delete the
/// resource, never retry bootstrap blindly. There is no account API key here.
/// envd detaches processes when no Connect-Timeout-Ms is supplied, so dropping
/// the start stream after its acknowledgement does not stop the desktop.
pub async fn start_desktop(bootstrap: &DesktopBootstrap) -> Result<u32, EnvdError> {
    let endpoint = bootstrap.endpoint()?;
    start_desktop_at(bootstrap, &endpoint, Duration::from_secs(60)).await
}

async fn start_desktop_at(
    bootstrap: &DesktopBootstrap,
    endpoint: &EnvdEndpoint,
    deadline: Duration,
) -> Result<u32, EnvdError> {
    let spec = StartSpec {
        cmd: "/usr/local/bin/cognia-desktop".into(),
        args: vec!["--managed".into()],
        envs: BTreeMap::from([(
            "COGNIA_CUA_AUTH_TOKEN".into(),
            bootstrap.guest_token.clone(),
        )]),
        // Managed execution must enter the mandatory guest guard; no Docker fallback.
        // envd does not inherit the image WORKDIR. The entrypoint drops to
        // cua; dependency startup must not inspect dotenv from root's cwd.
        cwd: Some("/home/cua".into()),
        stdin: false,
    };
    let result = tokio::time::timeout(deadline, async {
        let mut stream =
            start_with_traffic(endpoint, &spec, Some(&bootstrap.traffic_access_token)).await?;
        loop {
            match stream.next_event().await? {
                Some(ProcessEvent::Start { pid }) if pid > 0 => return Ok(pid),
                Some(ProcessEvent::Keepalive) => continue,
                _ => {
                    return Err(EnvdError::Protocol(
                        "desktop start was not acknowledged".into(),
                    ))
                }
            }
        }
    })
    .await;
    // envd or its proxy could reflect request headers/env in an error body.
    // Preserve the failure class, never expose arbitrary provider output here.
    match result {
        Ok(Ok(pid)) => Ok(pid),
        Ok(Err(EnvdError::Unauthorized(_))) => {
            Err(EnvdError::Unauthorized("desktop bootstrap refused".into()))
        }
        Ok(Err(EnvdError::Transport(_))) => Err(EnvdError::Transport(
            "desktop bootstrap connection failed".into(),
        )),
        Ok(Err(_)) => Err(EnvdError::Protocol(
            "desktop bootstrap was not acknowledged".into(),
        )),
        Err(_) => Err(EnvdError::Transport(
            "desktop bootstrap acknowledgement timed out".into(),
        )),
    }
}

/// Execute the immutable root observer, never a caller-provided script or PID.
/// The caller independently parses and validates the bounded versioned report.
pub async fn observe_desktop_boundary(bootstrap: &DesktopBootstrap) -> Result<Vec<u8>, EnvdError> {
    let endpoint = bootstrap.endpoint()?;
    observe_desktop_boundary_at(bootstrap, &endpoint, Duration::from_secs(35)).await
}

/// Destructive native qualification of the fixed workload launch paths. This
/// command accepts no caller script, destination, PID, environment or stdin.
pub async fn qualify_desktop_workload(bootstrap: &DesktopBootstrap) -> Result<Vec<u8>, EnvdError> {
    let endpoint = bootstrap.endpoint()?;
    let start = fixed_desktop_report_at(bootstrap, &endpoint, Duration::from_secs(15), "qualify-start", 1024).await?;
    let start: serde_json::Value = serde_json::from_slice(&start)
        .map_err(|_| EnvdError::Protocol("workload qualification start invalid".into()))?;
    let generation = start.get("boundaryGeneration").and_then(|v|v.as_str())
        .filter(|_| start.as_object().is_some_and(|v|v.len()==2) && start["started"]==true)
        .ok_or_else(|| EnvdError::Protocol("workload qualification start invalid".into()))?.to_owned();
    if !uuid::Uuid::parse_str(&generation).is_ok_and(|id|!id.is_nil() && id.to_string()==generation) {
        return Err(EnvdError::Protocol("workload qualification generation invalid".into()));
    }
    // The start stream has ended and been dropped. The independent collector
    // kills the supervisor while no Host request or reconciliation is active.
    tokio::time::sleep(Duration::from_secs(90)).await;
    let result = tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let bytes = fixed_desktop_report_at(bootstrap,&endpoint,Duration::from_secs(15),"qualify-result",262144).await?;
            let value:serde_json::Value=serde_json::from_slice(&bytes)
                .map_err(|_|EnvdError::Protocol("workload qualification report invalid".into()))?;
            if value["boundaryGeneration"] != generation {return Err(EnvdError::Protocol("workload qualification generation changed".into()));}
            if value.as_object().is_some_and(|v|v.len()==2) && value["pending"]==true {
                tokio::time::sleep(Duration::from_secs(2)).await;continue;
            }
            return Ok(bytes);
        }
    }).await;
    result.map_err(|_|EnvdError::Transport("workload qualification timed out".into()))?
}

async fn observe_desktop_boundary_at(
    bootstrap: &DesktopBootstrap,
    endpoint: &EnvdEndpoint,
    deadline: Duration,
) -> Result<Vec<u8>, EnvdError> {
    fixed_desktop_report_at(bootstrap, endpoint, deadline, "observe", 32768).await
}

async fn fixed_desktop_report_at(
    bootstrap: &DesktopBootstrap,
    endpoint: &EnvdEndpoint,
    deadline: Duration,
    command: &str,
    maximum_bytes: usize,
) -> Result<Vec<u8>, EnvdError> {
    let spec = StartSpec {
        cmd: "/usr/local/bin/cognia-desktop-guest".into(),
        args: vec![command.into()],
        envs: BTreeMap::new(),
        cwd: None,
        stdin: false,
    };
    let result = tokio::time::timeout(deadline, async {
        let mut stream =
            start_with_traffic(endpoint, &spec, Some(&bootstrap.traffic_access_token)).await?;
        let mut stdout = Vec::new();
        let mut total = 0usize;
        let mut started = false;
        loop {
            match stream.next_event().await? {
                Some(ProcessEvent::Start { pid }) if pid > 0 && !started => started = true,
                Some(ProcessEvent::Stdout(bytes)) if started => {
                    total = total.saturating_add(bytes.len());
                    if total > maximum_bytes {
                        return Err(EnvdError::Protocol("boundary report exceeded bound".into()));
                    }
                    stdout.extend_from_slice(&bytes);
                }
                Some(ProcessEvent::Stderr(bytes)) if started => {
                    total = total.saturating_add(bytes.len());
                    if total > maximum_bytes {
                        return Err(EnvdError::Protocol("boundary report exceeded bound".into()));
                    }
                }
                Some(ProcessEvent::Keepalive) => (),
                Some(ProcessEvent::End(status))
                    if started && status.code() == Some(0) && !stdout.is_empty() =>
                {
                    return Ok(stdout)
                }
                _ => {
                    return Err(EnvdError::Protocol(
                        "boundary report did not complete".into(),
                    ))
                }
            }
        }
    })
    .await;
    match result {
        Ok(Ok(bytes)) => Ok(bytes),
        Ok(Err(EnvdError::Unauthorized(_))) => Err(EnvdError::Unauthorized(
            "boundary observation refused".into(),
        )),
        Ok(Err(_)) => Err(EnvdError::Protocol("boundary observation failed".into())),
        Err(_) => Err(EnvdError::Transport(
            "boundary observation timed out".into(),
        )),
    }
}

/// Fixed negative-egress observations. True means an HTTP response reached the
/// guest; false can also mean no service. This is not proof of firewall enforcement.
#[derive(Debug, Clone, serde::Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EgressProbeReport {
    pub observations: BTreeMap<String, bool>,
}

impl EgressProbeReport {
    pub fn all_no_response(&self) -> bool {
        self.observations.len() == EGRESS_PROBE_TARGETS.len()
            && EGRESS_PROBE_TARGETS
                .iter()
                .all(|target| self.observations.get(*target) == Some(&false))
    }
}

const EGRESS_PROBE_TARGETS: &[&str] = &[
    "publicIp",
    "publicDns",
    "private10",
    "private172",
    "private192",
    "carrierPrivate",
    "linkLocal",
    "metadata",
    "publicIpv6",
    "metadataIpv6",
];

// No arbitrary command, targets, path or headers. No response bodies or redirects.
const EGRESS_PROBE_SCRIPT: &str = r#"import http.client, json
probes = [("publicIp", "1.1.1.1"), ("publicDns", "example.com"),
          ("private10", "10.0.0.1"), ("private172", "172.16.0.1"),
          ("private192", "192.168.0.1"), ("carrierPrivate", "100.64.0.1"),
          ("linkLocal", "169.254.0.1"), ("metadata", "169.254.169.254"),
          ("publicIpv6", "2606:4700:4700::1111"), ("metadataIpv6", "fd00:ec2::254")]
observations = {}
for name, host in probes:
    connection = http.client.HTTPConnection(host, 80, timeout=2)
    try:
        connection.request("HEAD", "/")
        response = connection.getresponse()
        observations[name] = True
        response.close()
    except Exception:
        observations[name] = False
    finally:
        connection.close()
print(json.dumps({"observations": observations}, separators=(",", ":")))
"#;

/// Runs fixed negative-egress checks through protected envd. Only for separately
/// authorized smoke on an egress-Off desktop; combine with inspected provider
/// policy and attestation. No reply does not prove every destination is denied.
pub async fn probe_desktop_egress(
    bootstrap: &DesktopBootstrap,
) -> Result<EgressProbeReport, EnvdError> {
    let endpoint = bootstrap.endpoint()?;
    probe_desktop_egress_at(bootstrap, &endpoint, Duration::from_secs(45)).await
}

async fn probe_desktop_egress_at(
    bootstrap: &DesktopBootstrap,
    endpoint: &EnvdEndpoint,
    deadline: Duration,
) -> Result<EgressProbeReport, EnvdError> {
    let spec = StartSpec {
        cmd: "/usr/local/bin/python3".into(),
        args: vec!["-c".into(), EGRESS_PROBE_SCRIPT.into()],
        envs: BTreeMap::new(),
        cwd: None,
        stdin: false,
    };
    let result = tokio::time::timeout(deadline, async {
        let mut stream =
            start_with_traffic(endpoint, &spec, Some(&bootstrap.traffic_access_token)).await?;
        let mut stdout = Vec::new();
        let mut total_bytes = 0_usize;
        let mut started = false;
        loop {
            match stream.next_event().await? {
                Some(ProcessEvent::Start { pid }) if pid > 0 && !started => started = true,
                Some(ProcessEvent::Stdout(bytes)) if started => {
                    total_bytes = total_bytes.saturating_add(bytes.len());
                    if total_bytes > 8192 {
                        return Err(EnvdError::Protocol(
                            "egress probe output exceeded bound".into(),
                        ));
                    }
                    stdout.extend_from_slice(&bytes);
                }
                Some(ProcessEvent::Stderr(bytes)) if started => {
                    total_bytes = total_bytes.saturating_add(bytes.len());
                    if total_bytes > 8192 {
                        return Err(EnvdError::Protocol(
                            "egress probe output exceeded bound".into(),
                        ));
                    }
                }
                Some(ProcessEvent::Keepalive) => (),
                Some(ProcessEvent::End(status)) if started && status.code() == Some(0) => break,
                _ => return Err(EnvdError::Protocol("egress probe did not complete".into())),
            }
        }
        let report: EgressProbeReport = serde_json::from_slice(&stdout)
            .map_err(|_| EnvdError::Protocol("invalid egress probe report".into()))?;
        if report.observations.len() != EGRESS_PROBE_TARGETS.len()
            || EGRESS_PROBE_TARGETS
                .iter()
                .any(|target| !report.observations.contains_key(*target))
        {
            return Err(EnvdError::Protocol("incomplete egress probe report".into()));
        }
        Ok(report)
    })
    .await;
    // Never surface stdout, stderr, reflected headers or remote error bodies.
    match result {
        Ok(Ok(report)) => Ok(report),
        Ok(Err(EnvdError::Unauthorized(_))) => {
            Err(EnvdError::Unauthorized("egress probe refused".into()))
        }
        Ok(Err(_)) => Err(EnvdError::Protocol("egress probe failed".into())),
        Err(_) => Err(EnvdError::Transport("egress probe timed out".into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data(field: &str, bytes: &[u8]) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "event": { "data": { field: base64::engine::general_purpose::STANDARD.encode(bytes) } }
        }))
        .unwrap()
    }

    #[test]
    fn events_decode_from_proto3_json() {
        assert_eq!(
            decode_event(br#"{"event":{"start":{"pid":42}}}"#).unwrap(),
            ProcessEvent::Start { pid: 42 }
        );
        assert_eq!(
            decode_event(&data("stdout", b"\x00\xffbinary")).unwrap(),
            ProcessEvent::Stdout(b"\x00\xffbinary".to_vec())
        );
        assert_eq!(
            decode_event(&data("stderr", b"oops")).unwrap(),
            ProcessEvent::Stderr(b"oops".to_vec())
        );
        assert_eq!(
            decode_event(br#"{"event":{"data":{"stdout":"aGk"}}}"#).unwrap(),
            ProcessEvent::Stdout(b"hi".to_vec()),
            "unpadded base64 is accepted"
        );
        assert_eq!(
            decode_event(br#"{"event":{"keepalive":{}}}"#).unwrap(),
            ProcessEvent::Keepalive
        );
        assert_eq!(
            decode_event(br#"{"event":{"end":{"exited":true,"status":"exit status 0"}}}"#).unwrap(),
            ProcessEvent::End(EndStatus {
                exit_code: None,
                exited: true,
                status: "exit status 0".into(),
                error: None,
            })
        );
        assert!(decode_event(br#"{"event":{"start":{}}}"#).is_err());
        assert!(decode_event(br#"{"event":{"data":{"stdout":"!!"}}}"#).is_err());
        assert!(decode_event(br#"{"event":{}}"#).is_err());
        assert!(decode_event(br#"{}"#).is_err());
        assert!(decode_event(b"nope").is_err());
    }

    #[test]
    fn exit_codes_follow_shell_conventions() {
        let end = |exit_code: Option<i32>, exited: bool, status: &str| EndStatus {
            exit_code,
            exited,
            status: status.into(),
            error: None,
        };
        assert_eq!(
            end(None, true, "exit status 0").code(),
            Some(0),
            "proto3 omits 0"
        );
        assert_eq!(end(Some(3), true, "exit status 3").code(), Some(3));
        assert_eq!(end(Some(-1), false, "signal: killed").code(), Some(137));
        assert_eq!(end(Some(-1), false, "signal: terminated").code(), Some(143));
        assert_eq!(
            end(Some(-1), false, "signal: aborted (core dumped)").code(),
            Some(134)
        );
        assert_eq!(end(Some(-1), false, "signal: power failure").code(), None);
        assert_eq!(end(None, false, "").code(), None);
    }

    #[test]
    fn the_endpoint_debug_output_never_shows_the_token() {
        let endpoint = EnvdEndpoint {
            base: default_envd_base("abc123", "e2b.app").unwrap(),
            sandbox_id: "abc123".into(),
            access_token: Some("secret-envd-token".into()),
        };
        assert_eq!(endpoint.base.as_str(), "https://49983-abc123.e2b.app/");
        let debug = format!("{endpoint:?}");
        assert!(!debug.contains("secret-envd-token"), "{debug}");
        assert!(debug.contains("<redacted>"));
        assert_eq!(basic_root(), "Basic cm9vdDo=");
    }

    fn bootstrap() -> DesktopBootstrap {
        DesktopBootstrap {
            sandbox_id: "desktop123".into(),
            domain: "e2b.app".into(),
            envd_access_token: "envd-secret".into(),
            traffic_access_token: "traffic-secret".into(),
            guest_token: "guest-secret".into(),
        }
    }

    #[test]
    fn bootstrap_refuses_untrusted_endpoints_and_redacts_credentials() {
        let valid = bootstrap();
        assert_eq!(
            valid.endpoint().unwrap().base.as_str(),
            "https://49983-desktop123.e2b.app/"
        );
        assert!(!format!("{valid:?}").contains("secret"));
        for domain in [
            "e2b.app.evil.test",
            "e2b.app/path",
            "e2b.app@evil.test",
            "-bad.e2b.app",
            "localhost",
        ] {
            let mut invalid = valid.clone();
            invalid.domain = domain.into();
            assert!(invalid.endpoint().is_err(), "{domain}");
        }
        let mut invalid = valid.clone();
        invalid.sandbox_id = "id@evil.test/path".into();
        assert!(invalid.endpoint().is_err());
        invalid = valid.clone();
        invalid.guest_token = "guest\nsecret".into();
        assert!(invalid.endpoint().is_err());
        let mut regional = valid;
        regional.domain = "eu.e2b.dev".into();
        assert!(regional.endpoint().is_ok());
    }

    struct BootstrapFixture {
        endpoint: EnvdEndpoint,
        requests: std::sync::Arc<std::sync::Mutex<Vec<(axum::http::HeaderMap, Vec<u8>)>>>,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for BootstrapFixture {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    async fn bootstrap_fixture(status: u16, body: Vec<u8>, delay: Duration) -> BootstrapFixture {
        use axum::{
            body::{to_bytes, Body},
            extract::Request,
            response::Response,
            Router,
        };
        let _ = cognia_net::proxy_config::apply_current(
            cognia_net::proxy_config::ProxyConfig::default(),
        );
        let requests = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let recorded = requests.clone();
        let router = Router::new().fallback(move |request: Request| {
            let recorded = recorded.clone();
            let body = body.clone();
            async move {
                assert!(matches!(
                    request.uri().path(),
                    "/process.Process/Start"
                        | "/process.Process/SendInput"
                        | "/process.Process/CloseStdin"
                ));
                let headers = request.headers().clone();
                let bytes = to_bytes(request.into_body(), 65536).await.unwrap();
                recorded.lock().unwrap().push((headers, bytes.to_vec()));
                tokio::time::sleep(delay).await;
                Response::builder()
                    .status(status)
                    .header("content-type", "application/connect+json")
                    .header("location", "http://127.0.0.1:1/must-not-follow")
                    .body(Body::from(body))
                    .unwrap()
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        BootstrapFixture {
            endpoint: EnvdEndpoint {
                base,
                sandbox_id: "desktop123".into(),
                access_token: Some("envd-secret".into()),
            },
            requests,
            task,
        }
    }

    #[tokio::test]
    async fn desktop_bootstrap_uses_runtime_only_env_and_both_protected_headers_once() {
        let fixture = bootstrap_fixture(
            200,
            encode_envelope(br#"{"event":{"start":{"pid":42}}}"#),
            Duration::ZERO,
        )
        .await;
        assert_eq!(
            start_desktop_at(&bootstrap(), &fixture.endpoint, Duration::from_secs(1))
                .await
                .unwrap(),
            42
        );
        let requests = fixture.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        let (headers, body) = &requests[0];
        assert_eq!(headers["e2b-traffic-access-token"], "traffic-secret");
        assert_eq!(headers["x-access-token"], "envd-secret");
        assert_eq!(headers["authorization"], "Basic cm9vdDo=");
        assert!(!headers.contains_key("connect-timeout-ms"));
        assert!(!headers.contains_key("x-api-key"));
        assert!(!headers.values().any(|h| h.as_bytes() == b"guest-secret"));
        let mut decoder = EnvelopeDecoder::default();
        decoder.push(body);
        let Frame::Message(payload) = decoder.next_frame().unwrap().unwrap() else {
            panic!("not a message")
        };
        let value: serde_json::Value = serde_json::from_slice(&payload).unwrap();
        assert_eq!(
            value,
            json!({"process":{"cmd":"/usr/local/bin/cognia-desktop","args":["--managed"],"envs":{"COGNIA_CUA_AUTH_TOKEN":"guest-secret"},"cwd":"/home/cua"},"stdin":false})
        );
    }

    #[tokio::test]
    async fn protected_process_input_keeps_edge_and_envd_credentials_on_every_chunk() {
        let fixture = bootstrap_fixture(
            200,
            encode_envelope(br#"{"event":{"start":{"pid":42}}}"#),
            Duration::ZERO,
        )
        .await;
        // Use the same private constructor state as for_desktop, with a local
        // fixture endpoint; public for_desktop still validates provider domains.
        let mut input = ProcessInput::new(fixture.endpoint.clone(), 42).unwrap();
        input.traffic_token = Some("traffic-secret".into());
        input.send(b"bounded chunk").await.unwrap();
        input.close().await.unwrap();
        let requests = fixture.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        for (headers, body) in requests.iter() {
            assert_eq!(headers["e2b-traffic-access-token"], "traffic-secret");
            assert_eq!(headers["x-access-token"], "envd-secret");
            assert_eq!(headers["authorization"], "Basic cm9vdDo=");
            assert!(!headers.contains_key("x-api-key"));
            assert!(!String::from_utf8_lossy(body).contains("secret"));
        }
        assert!(ProcessInput::for_desktop(&bootstrap(), 42).is_ok());
        let mut bad = bootstrap();
        bad.domain = "e2b.app.attacker.invalid".into();
        assert!(ProcessInput::for_desktop(&bad, 42).is_err());
    }

    #[tokio::test]
    async fn desktop_bootstrap_refusals_redirects_missing_ack_and_timeout_are_secret_safe() {
        for status in [401, 403, 307, 500, 200] {
            let fixture = bootstrap_fixture(
                status,
                b"envd-secret traffic-secret guest-secret".to_vec(),
                Duration::ZERO,
            )
            .await;
            let error = start_desktop_at(&bootstrap(), &fixture.endpoint, Duration::from_secs(1))
                .await
                .unwrap_err();
            assert!(!format!("{error:?}").contains("secret"));
            assert_eq!(fixture.requests.lock().unwrap().len(), 1);
            if status == 307 {
                assert!(matches!(error, EnvdError::Protocol(_)), "{error}");
            }
        }
        let fixture = bootstrap_fixture(200, Vec::new(), Duration::from_secs(1)).await;
        let error = start_desktop_at(&bootstrap(), &fixture.endpoint, Duration::from_millis(20))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("timed out"));
    }

    fn probe_frames(output: &[u8]) -> Vec<u8> {
        [
            encode_envelope(br#"{"event":{"start":{"pid":42}}}"#),
            encode_envelope(&data("stdout", output)),
            encode_envelope(br#"{"event":{"end":{"exited":true}}}"#),
        ]
        .concat()
    }

    #[tokio::test]
    async fn egress_probe_is_fixed_bounded_and_reports_only_response_observations() {
        let mut report = EgressProbeReport {
            observations: EGRESS_PROBE_TARGETS
                .iter()
                .map(|name| ((*name).to_string(), false))
                .collect(),
        };
        let fixture = bootstrap_fixture(
            200,
            probe_frames(&serde_json::to_vec(&report).unwrap()),
            Duration::ZERO,
        )
        .await;
        let result =
            probe_desktop_egress_at(&bootstrap(), &fixture.endpoint, Duration::from_secs(1))
                .await
                .unwrap();
        assert!(result.all_no_response());
        let request = fixture.requests.lock().unwrap()[0].clone();
        let mut decoder = EnvelopeDecoder::default();
        decoder.push(&request.1);
        let Frame::Message(payload) = decoder.next_frame().unwrap().unwrap() else {
            panic!("not message")
        };
        let value: serde_json::Value = serde_json::from_slice(&payload).unwrap();
        assert_eq!(value["process"]["envs"], json!({}));
        assert_eq!(value["process"]["cmd"], "/usr/local/bin/python3");
        assert_eq!(value["process"]["args"], json!(["-c", EGRESS_PROBE_SCRIPT]));
        assert!(!String::from_utf8(payload).unwrap().contains("guest-secret"));
        report.observations.insert("publicIp".into(), true);
        assert!(!report.all_no_response());
        for output in [
            b"guest-secret malformed".to_vec(),
            vec![b'x'; 8193],
            br#"{"observations":{}}"#.to_vec(),
        ] {
            let fixture = bootstrap_fixture(200, probe_frames(&output), Duration::ZERO).await;
            let error =
                probe_desktop_egress_at(&bootstrap(), &fixture.endpoint, Duration::from_secs(1))
                    .await
                    .unwrap_err();
            assert!(!error.to_string().contains("secret"));
        }
    }
    #[tokio::test]
    async fn boundary_observation_is_fixed_bounded_and_does_not_forward_secrets() {
        let fixture = bootstrap_fixture(200, probe_frames(b"{}"), Duration::ZERO).await;
        assert_eq!(
            observe_desktop_boundary_at(&bootstrap(), &fixture.endpoint, Duration::from_secs(1))
                .await
                .unwrap(),
            b"{}"
        );
        let request = fixture.requests.lock().unwrap()[0].clone();
        let mut decoder = EnvelopeDecoder::default();
        decoder.push(&request.1);
        let Frame::Message(payload) = decoder.next_frame().unwrap().unwrap() else {
            panic!("not message")
        };
        let value: serde_json::Value = serde_json::from_slice(&payload).unwrap();
        assert_eq!(
            value["process"]["cmd"],
            "/usr/local/bin/cognia-desktop-guest"
        );
        assert_eq!(value["process"]["args"], json!(["observe"]));
        assert_eq!(value["process"]["envs"], json!({}));
        assert_eq!(value["stdin"], false);
        assert!(!String::from_utf8(payload).unwrap().contains("secret"));
        for output in [Vec::new(), vec![b'x'; 32769]] {
            let fixture = bootstrap_fixture(200, probe_frames(&output), Duration::ZERO).await;
            assert!(observe_desktop_boundary_at(
                &bootstrap(),
                &fixture.endpoint,
                Duration::from_secs(1)
            )
            .await
            .is_err());
        }
        let fixture = bootstrap_fixture(401, b"envd-secret".to_vec(), Duration::ZERO).await;
        let error =
            observe_desktop_boundary_at(&bootstrap(), &fixture.endpoint, Duration::from_secs(1))
                .await
                .unwrap_err();
        assert!(matches!(error, EnvdError::Unauthorized(_)));
        assert!(!error.to_string().contains("secret"));
    }
    #[tokio::test]
    async fn destructive_qualification_uses_only_fixed_command_and_bounded_output() {
        let fixture = bootstrap_fixture(200, probe_frames(b"{}"), Duration::ZERO).await;
        assert_eq!(
            fixed_desktop_report_at(
                &bootstrap(),
                &fixture.endpoint,
                Duration::from_secs(1),
                "qualify-result",
                262144
            )
            .await
            .unwrap(),
            b"{}"
        );
        let request = fixture.requests.lock().unwrap()[0].clone();
        let mut decoder = EnvelopeDecoder::default();
        decoder.push(&request.1);
        let Frame::Message(payload) = decoder.next_frame().unwrap().unwrap() else {
            panic!("not message")
        };
        let value: serde_json::Value = serde_json::from_slice(&payload).unwrap();
        assert_eq!(
            value["process"]["cmd"],
            "/usr/local/bin/cognia-desktop-guest"
        );
        assert_eq!(value["process"]["args"], json!(["qualify-result"]));
        assert_eq!(value["process"]["envs"], json!({}));
        assert_eq!(value["stdin"], false);
        for output in [Vec::new(), vec![b'x'; 262145]] {
            let fixture = bootstrap_fixture(200, probe_frames(&output), Duration::ZERO).await;
            assert!(fixed_desktop_report_at(
                &bootstrap(),
                &fixture.endpoint,
                Duration::from_secs(1),
                "qualify-result",
                262144
            )
            .await
            .is_err());
        }
    }
}

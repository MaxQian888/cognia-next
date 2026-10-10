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
pub(super) const ENVD_PORT: u16 = 49983;
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
pub(super) struct EnvdEndpoint {
    pub base: Url,
    pub sandbox_id: String,
    pub access_token: Option<String>,
}

impl fmt::Debug for EnvdEndpoint {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("EnvdEndpoint")
            .field("base", &self.base.as_str())
            .field("sandbox_id", &self.sandbox_id)
            .field(
                "access_token",
                &self.access_token.as_ref().map(|_| "<redacted>"),
            )
            .finish()
    }
}

/// `https://49983-<sandboxID>.<domain>/`.
pub(super) fn default_envd_base(sandbox_id: &str, domain: &str) -> Result<Url, String> {
    let raw = format!("https://{ENVD_PORT}-{sandbox_id}.{domain}/");
    Url::parse(&raw).map_err(|error| format!("envd address {raw:?} is invalid: {error}"))
}

/// One process to start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct StartSpec {
    pub cmd: String,
    pub args: Vec<String>,
    pub envs: BTreeMap<String, String>,
    pub cwd: Option<String>,
    /// Whether the process gets a stdin pipe (else `/dev/null`).
    pub stdin: bool,
}

/// How a process ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct EndStatus {
    pub exit_code: Option<i32>,
    pub exited: bool,
    /// Go's `ProcessState.String()`: `exit status 2`, `signal: killed`.
    pub status: String,
    pub error: Option<String>,
}

impl EndStatus {
    /// The exit code a shell would report: the status for a normal exit,
    /// `128 + n` for a death by signal `n`, `None` when neither is known.
    pub(super) fn code(&self) -> Option<i64> {
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
pub(super) enum ProcessEvent {
    Start { pid: u32 },
    Stdout(Vec<u8>),
    Stderr(Vec<u8>),
    End(EndStatus),
    Keepalive,
}

/// Why an envd call failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum EnvdError {
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
pub(super) fn decode_event(payload: &[u8]) -> Result<ProcessEvent, EnvdError> {
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
pub(super) struct ProcessStream {
    response: reqwest::Response,
    decoder: EnvelopeDecoder,
    done: bool,
}

impl ProcessStream {
    /// The next event; `Ok(None)` once the call has completed cleanly.
    pub(super) async fn next_event(&mut self) -> Result<Option<ProcessEvent>, EnvdError> {
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
                    return Err(EnvdError::Transport(error.to_string()));
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
        .tcp_keepalive(TCP_KEEPALIVE);
    if let Some(timeout) = read_timeout {
        builder = builder.read_timeout(timeout);
    }
    cognia_net::proxy_config::managed_client(builder, url.as_str())
        .map_err(|error| EnvdError::Transport(format!("network policy: {error}")))
}

fn authorize(request: reqwest::RequestBuilder, endpoint: &EnvdEndpoint) -> reqwest::RequestBuilder {
    let mut request = request
        .header("authorization", basic_root())
        .header("e2b-sandbox-id", endpoint.sandbox_id.as_str())
        .header("e2b-sandbox-port", ENVD_PORT.to_string());
    if let Some(token) = &endpoint.access_token {
        request = request.header("x-access-token", token.as_str());
    }
    request
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
pub(super) async fn start(
    endpoint: &EnvdEndpoint,
    spec: &StartSpec,
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
    let response = authorize(request, endpoint)
        .send()
        .await
        .map_err(|error| EnvdError::Transport(error.to_string()))?;
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
pub(super) struct ProcessInput {
    endpoint: EnvdEndpoint,
    pid: u32,
    client: reqwest::Client,
}

impl ProcessInput {
    pub(super) fn new(endpoint: EnvdEndpoint, pid: u32) -> Result<Self, EnvdError> {
        let probe = rpc_url(&endpoint, "SendInput")?;
        let client = client(&probe, None)?;
        Ok(Self {
            endpoint,
            pid,
            client,
        })
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
        let response = authorize(request, &self.endpoint)
            .send()
            .await
            .map_err(|error| EnvdError::Transport(error.to_string()))?;
        let status = response.status().as_u16();
        if status != 200 {
            return Err(refusal(status, response).await);
        }
        Ok(())
    }

    /// Writes `bytes` to the process's stdin; returns once envd has written
    /// them to the pipe.
    pub(super) async fn send(&self, bytes: &[u8]) -> Result<(), EnvdError> {
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        self.unary(
            "SendInput",
            json!({ "process": { "pid": self.pid }, "input": { "stdin": encoded } }),
            None,
        )
        .await
    }

    /// Closes the process's stdin (EOF).
    pub(super) async fn close(&self) -> Result<(), EnvdError> {
        self.unary(
            "CloseStdin",
            json!({ "process": { "pid": self.pid } }),
            Some(CLOSE_TIMEOUT),
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_server::{FakeE2b, ProcessScript, ScriptFrame};
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

    #[tokio::test]
    async fn a_started_process_streams_fragmented_events_as_root() {
        let fake = FakeE2b::start().await;
        let sandbox = fake.add_sandbox("running", BTreeMap::new());
        fake.script(
            "/bin/echo",
            ProcessScript::Fixed {
                frames: vec![
                    ScriptFrame::Keepalive,
                    ScriptFrame::Stdout(b"hello ".to_vec()),
                    ScriptFrame::Stderr(b"warn".to_vec()),
                    ScriptFrame::Stdout(b"world".to_vec()),
                    ScriptFrame::End {
                        code: 0,
                        status: "exit status 0".into(),
                    },
                ],
                chunk: 1,
            },
        );
        let endpoint = fake.envd_endpoint(&sandbox);
        let spec = StartSpec {
            cmd: "/bin/echo".into(),
            args: vec!["hello".into()],
            envs: BTreeMap::from([("A".to_string(), "1".to_string())]),
            cwd: Some("/workspace".into()),
            stdin: false,
        };
        let mut stream = start(&endpoint, &spec).await.unwrap();
        let mut events = Vec::new();
        while let Some(event) = stream.next_event().await.unwrap() {
            events.push(event);
        }
        assert!(matches!(events[0], ProcessEvent::Start { .. }));
        assert_eq!(events[1], ProcessEvent::Keepalive);
        assert_eq!(events[2], ProcessEvent::Stdout(b"hello ".to_vec()));
        assert_eq!(events[3], ProcessEvent::Stderr(b"warn".to_vec()));
        assert_eq!(events[4], ProcessEvent::Stdout(b"world".to_vec()));
        assert!(matches!(&events[5], ProcessEvent::End(end) if end.code() == Some(0)));

        let request = fake.last_request("/process.Process/Start");
        assert_eq!(request.header("authorization"), Some("Basic cm9vdDo="));
        assert_eq!(
            request.header("x-access-token"),
            Some(fake.token(&sandbox).as_str())
        );
        assert_eq!(request.header("e2b-sandbox-id"), Some(sandbox.as_str()));
        assert_eq!(request.header("keepalive-ping-interval"), Some("50"));
        assert_eq!(request.header("connect-timeout-ms"), None);
        assert_eq!(
            request.header("content-type"),
            Some("application/connect+json")
        );
        let body = request.envelope_json();
        assert_eq!(
            body,
            json!({
                "process": {
                    "cmd": "/bin/echo",
                    "args": ["hello"],
                    "envs": { "A": "1" },
                    "cwd": "/workspace",
                },
                "stdin": false,
            })
        );
    }

    #[tokio::test]
    async fn refusals_and_broken_streams_are_errors() {
        let fake = FakeE2b::start().await;
        let sandbox = fake.add_sandbox("running", BTreeMap::new());
        let spec = |cmd: &str| StartSpec {
            cmd: cmd.into(),
            args: Vec::new(),
            envs: BTreeMap::new(),
            cwd: None,
            stdin: true,
        };

        let mut wrong = fake.envd_endpoint(&sandbox);
        wrong.access_token = Some("not-the-token".into());
        let error = start(&wrong, &spec("/bin/true")).await.err().unwrap();
        assert!(matches!(error, EnvdError::Unauthorized(_)), "{error}");

        fake.script(
            "/bad/cwd",
            ProcessScript::Fixed {
                frames: vec![ScriptFrame::EndStreamError {
                    code: "invalid_argument".into(),
                    message: "cwd '/nope' does not exist".into(),
                }],
                chunk: 3,
            },
        );
        let endpoint = fake.envd_endpoint(&sandbox);
        let mut stream = start(&endpoint, &spec("/bad/cwd")).await.unwrap();
        let error = stream.next_event().await.unwrap_err();
        assert_eq!(
            error,
            EnvdError::Rpc(ConnectError {
                code: "invalid_argument".into(),
                message: "cwd '/nope' does not exist".into(),
            })
        );

        fake.script(
            "/cut",
            ProcessScript::Fixed {
                frames: vec![ScriptFrame::Stdout(b"partial".to_vec()), ScriptFrame::Cut],
                chunk: 64,
            },
        );
        let mut stream = start(&endpoint, &spec("/cut")).await.unwrap();
        assert!(matches!(
            stream.next_event().await.unwrap(),
            Some(ProcessEvent::Start { .. })
        ));
        assert_eq!(
            stream.next_event().await.unwrap(),
            Some(ProcessEvent::Stdout(b"partial".to_vec()))
        );
        assert!(matches!(
            stream.next_event().await,
            Err(EnvdError::Protocol(_))
        ));
    }

    #[tokio::test]
    async fn input_and_close_reach_the_process_by_pid() {
        let fake = FakeE2b::start().await;
        let sandbox = fake.add_sandbox("running", BTreeMap::new());
        fake.script("/bin/cat", ProcessScript::Echo);
        let endpoint = fake.envd_endpoint(&sandbox);
        let mut stream = start(
            &endpoint,
            &StartSpec {
                cmd: "/bin/cat".into(),
                args: Vec::new(),
                envs: BTreeMap::new(),
                cwd: None,
                stdin: true,
            },
        )
        .await
        .unwrap();
        let Some(ProcessEvent::Start { pid }) = stream.next_event().await.unwrap() else {
            panic!("no start event");
        };
        let input = ProcessInput::new(endpoint.clone(), pid).unwrap();
        input.send(b"ping").await.unwrap();
        assert_eq!(
            stream.next_event().await.unwrap(),
            Some(ProcessEvent::Stdout(b"ping".to_vec()))
        );
        input.close().await.unwrap();
        assert!(matches!(
            stream.next_event().await.unwrap(),
            Some(ProcessEvent::End(end)) if end.code() == Some(0)
        ));
        let request = fake.last_request("/process.Process/SendInput");
        assert_eq!(request.header("authorization"), Some("Basic cm9vdDo="));
        assert_eq!(request.header("connect-protocol-version"), Some("1"));
        assert_eq!(
            request.json(),
            json!({ "process": { "pid": pid }, "input": { "stdin": "cGluZw==" } })
        );

        let error = ProcessInput::new(endpoint, pid + 1000)
            .unwrap()
            .send(b"x")
            .await
            .unwrap_err();
        assert!(
            matches!(&error, EnvdError::Rpc(rpc) if rpc.code == "not_found"),
            "{error}"
        );
    }
}

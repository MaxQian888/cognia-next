//! Test doubles for the E2B provider: a fake E2B (control plane, template
//! build, presigned upload and envd) and a fake OCI registry serving an agent
//! bundle, both real HTTP servers on 127.0.0.1, so the provider's own reqwest
//! clients, Connect framing and registry transport run unmodified.
//!
//! The fake follows the behaviour the provider depends on, read from E2B's
//! OpenAPI spec and envd's sources: metadata filters unescaped as the API's
//! `parseFilters` does, `X-Next-Token` pagination, 404/409 semantics of
//! kill/pause/connect, the Build System 2.0 file cache, and envd's
//! enveloped `Start` stream with unary `SendInput`/`CloseStdin`.

use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::response::Response;
use base64::Engine as _;
use bytes::Bytes;
use cognia_environment::image::PinnedImage;
use flate2::write::GzEncoder;
use flate2::Compression;
use futures_util::StreamExt as _;
use parking_lot::Mutex;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;
use url::Url;

use super::api::ApiClient;
use super::connect::{encode_envelope, FLAG_END_STREAM};
use super::envd::EnvdEndpoint;

/// The proxy policy every managed client consults; tests run direct.
pub(super) fn init_network_policy() {
    let _ =
        cognia_net::proxy_config::apply_current(cognia_net::proxy_config::ProxyConfig::default());
}

/// One request the fake received.
#[derive(Debug, Clone)]
pub(super) struct Recorded {
    pub method: String,
    pub path: String,
    pub query: Option<String>,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Recorded {
    pub(super) fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    pub(super) fn json(&self) -> Value {
        serde_json::from_slice(&self.body).expect("a JSON body")
    }

    /// The JSON message of a Connect streaming request.
    pub(super) fn envelope_json(&self) -> Value {
        assert!(self.body.len() >= 5, "an enveloped body");
        assert_eq!(self.body[0], 0, "uncompressed, not end-of-stream");
        let length = u32::from_be_bytes([self.body[1], self.body[2], self.body[3], self.body[4]]);
        assert_eq!(length as usize, self.body.len() - 5, "exactly one message");
        serde_json::from_slice(&self.body[5..]).expect("a JSON message")
    }
}

/// One frame a scripted process emits after its start event.
#[derive(Debug, Clone)]
pub(super) enum ScriptFrame {
    Stdout(Vec<u8>),
    Stderr(Vec<u8>),
    Keepalive,
    /// An end event followed by a clean end-of-stream.
    End {
        code: i32,
        status: String,
    },
    /// An end-of-stream carrying an error (no end event). First in the
    /// script, it replaces the start event: the process never started.
    EndStreamError {
        code: String,
        message: String,
    },
    /// The connection ends partway into an envelope.
    Cut,
}

/// How a process started through the fake behaves.
#[derive(Debug, Clone)]
pub(super) enum ProcessScript {
    /// These frames, the response body split into `chunk`-byte pieces.
    Fixed {
        frames: Vec<ScriptFrame>,
        chunk: usize,
    },
    /// Echoes each `SendInput` as stdout; exits 0 on `CloseStdin`.
    Echo,
    /// Starts and never ends (a supervisor).
    Linger,
}

enum EchoInput {
    Data(Vec<u8>),
    Close,
}

struct FakeSandbox {
    state: String,
    metadata: BTreeMap<String, String>,
    token: String,
    hide_token: bool,
}

struct FakeTemplate {
    id: String,
    alias: String,
    builds: Vec<(String, String)>,
}

#[derive(Clone)]
struct ScriptedStatus {
    status: String,
    logs: Vec<(String, String)>,
    reason: Option<(String, Vec<(String, String)>)>,
}

struct FakeState {
    base: Url,
    requests: Vec<Recorded>,
    failures: HashMap<String, VecDeque<(u16, String)>>,
    sandboxes: BTreeMap<String, FakeSandbox>,
    counter: u64,
    page_size: usize,
    create_domain: Option<String>,
    templates: Vec<FakeTemplate>,
    foreign_aliases: BTreeSet<String>,
    files_present: BTreeSet<String>,
    build_script: VecDeque<ScriptedStatus>,
    scripts: HashMap<String, ProcessScript>,
    echoes: HashMap<u32, mpsc::UnboundedSender<EchoInput>>,
    live: BTreeSet<u32>,
}

type Shared = Arc<Mutex<FakeState>>;

/// A fake E2B.
pub(super) struct FakeE2b {
    pub base: Url,
    state: Shared,
    server: tokio::task::JoinHandle<()>,
}

impl Drop for FakeE2b {
    fn drop(&mut self) {
        self.server.abort();
    }
}

fn json_response(status: u16, value: Value) -> Response {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::from(value.to_string()))
        .expect("a response")
}

fn empty(status: u16) -> Response {
    Response::builder()
        .status(status)
        .body(Body::empty())
        .expect("a response")
}

fn error(status: u16, message: &str) -> Response {
    json_response(status, json!({ "code": status, "message": message }))
}

/// Go's `url.QueryUnescape`.
fn query_unescape(text: &str) -> Result<String, String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                out.push(b' ');
                index += 1;
            }
            b'%' => {
                let hex = text
                    .get(index + 1..index + 3)
                    .ok_or_else(|| format!("truncated escape in {text:?}"))?;
                out.push(u8::from_str_radix(hex, 16).map_err(|e| e.to_string())?);
                index += 3;
            }
            other => {
                out.push(other);
                index += 1;
            }
        }
    }
    String::from_utf8(out).map_err(|error| error.to_string())
}

/// E2B's `parseFilters`: unescape the whole value, split, unescape each.
pub(super) fn parse_metadata_filter(value: &str) -> Result<BTreeMap<String, String>, String> {
    let unescaped = query_unescape(value)?;
    let mut filter = BTreeMap::new();
    for pair in unescaped.split('&') {
        let parts: Vec<&str> = pair.split('=').collect();
        if parts.len() != 2 {
            return Err("invalid key value pair in query".into());
        }
        filter.insert(query_unescape(parts[0])?, query_unescape(parts[1])?);
    }
    Ok(filter)
}

fn listed(id: &str, sandbox: &FakeSandbox) -> Value {
    json!({
        "sandboxID": id,
        "templateID": "tpl",
        "clientID": "client",
        "startedAt": "2026-10-10T00:00:00Z",
        "endAt": "2026-10-10T02:00:00Z",
        "cpuCount": 2,
        "memoryMB": 2048,
        "diskSizeMB": 10240,
        "state": sandbox.state,
        "envdVersion": "0.2.4",
        "metadata": sandbox.metadata,
    })
}

fn envelope(value: Value) -> Vec<u8> {
    encode_envelope(value.to_string().as_bytes())
}

fn end_stream(value: Value) -> Vec<u8> {
    let mut frame = encode_envelope(value.to_string().as_bytes());
    frame[0] = FLAG_END_STREAM;
    frame
}

fn data_frame(field: &str, bytes: &[u8]) -> Vec<u8> {
    envelope(json!({
        "event": { "data": { field: base64::engine::general_purpose::STANDARD.encode(bytes) } }
    }))
}

fn end_frame(code: i32, status: &str) -> Vec<u8> {
    // proto3 JSON leaves a zero exit code out.
    let mut end = json!({ "exited": status.starts_with("exit status"), "status": status });
    if code != 0 {
        end["exitCode"] = json!(code);
    }
    envelope(json!({ "event": { "end": end } }))
}

fn stream_response(body: Body) -> Response {
    Response::builder()
        .status(200)
        .header("content-type", "application/connect+json")
        .body(body)
        .expect("a response")
}

impl FakeE2b {
    pub(super) const API_KEY: &'static str = "e2b_test_key_0123456789";

    pub(super) async fn start() -> Self {
        init_network_policy();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let state: Shared = Arc::new(Mutex::new(FakeState {
            base: base.clone(),
            requests: Vec::new(),
            failures: HashMap::new(),
            sandboxes: BTreeMap::new(),
            counter: 0,
            page_size: 100,
            create_domain: Some("fake.e2b.test".into()),
            templates: Vec::new(),
            foreign_aliases: BTreeSet::new(),
            files_present: BTreeSet::new(),
            build_script: VecDeque::new(),
            scripts: HashMap::new(),
            echoes: HashMap::new(),
            live: BTreeSet::new(),
        }));
        let app = axum::Router::new()
            .fallback(handle)
            .with_state(state.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self {
            base,
            state,
            server,
        }
    }

    pub(super) fn url(&self, path: &str) -> Url {
        self.base.join(path.trim_start_matches('/')).unwrap()
    }

    pub(super) fn api(&self) -> ApiClient {
        ApiClient::new(self.base.clone(), Self::API_KEY.to_string())
    }

    pub(super) fn add_sandbox(&self, state: &str, metadata: BTreeMap<String, String>) -> String {
        let mut guard = self.state.lock();
        guard.counter += 1;
        let id = format!("sbx{}", guard.counter);
        let token = format!("tok{}", guard.counter);
        guard.sandboxes.insert(
            id.clone(),
            FakeSandbox {
                state: state.into(),
                metadata,
                token,
                hide_token: false,
            },
        );
        id
    }

    pub(super) fn token(&self, id: &str) -> String {
        self.state.lock().sandboxes[id].token.clone()
    }

    pub(super) fn hide_token(&self, id: &str) {
        if let Some(sandbox) = self.state.lock().sandboxes.get_mut(id) {
            sandbox.hide_token = true;
        }
    }

    pub(super) fn sandbox_state(&self, id: &str) -> Option<String> {
        self.state
            .lock()
            .sandboxes
            .get(id)
            .map(|sandbox| sandbox.state.clone())
    }

    pub(super) fn sandbox_metadata(&self, id: &str) -> Option<BTreeMap<String, String>> {
        self.state
            .lock()
            .sandboxes
            .get(id)
            .map(|sandbox| sandbox.metadata.clone())
    }

    pub(super) fn sandbox_ids(&self) -> Vec<String> {
        self.state.lock().sandboxes.keys().cloned().collect()
    }

    pub(super) fn set_page_size(&self, size: usize) {
        self.state.lock().page_size = size;
    }

    pub(super) fn set_create_domain(&self, domain: Option<&str>) {
        self.state.lock().create_domain = domain.map(str::to_string);
    }

    pub(super) fn script(&self, cmd: &str, script: ProcessScript) {
        self.state.lock().scripts.insert(cmd.into(), script);
    }

    /// The next request to `path` (any method) answers `status`.
    pub(super) fn fail_next(&self, path: &str, status: u16, message: &str) {
        self.state
            .lock()
            .failures
            .entry(path.into())
            .or_default()
            .push_back((status, message.into()));
    }

    pub(super) fn envd_endpoint(&self, id: &str) -> EnvdEndpoint {
        EnvdEndpoint {
            base: self.base.clone(),
            sandbox_id: id.into(),
            access_token: Some(self.token(id)),
        }
    }

    pub(super) fn requests(&self) -> Vec<Recorded> {
        self.state.lock().requests.clone()
    }

    pub(super) fn requests_to(&self, path: &str) -> Vec<Recorded> {
        self.requests()
            .into_iter()
            .filter(|request| request.path == path)
            .collect()
    }

    pub(super) fn last_request(&self, path: &str) -> Recorded {
        self.requests_to(path)
            .pop()
            .unwrap_or_else(|| panic!("no request to {path}"))
    }

    /// The statuses successive polls of a running build answer.
    pub(super) fn script_build_statuses(&self, statuses: &[&str]) {
        self.state.lock().build_script = statuses
            .iter()
            .map(|status| ScriptedStatus {
                status: (*status).into(),
                logs: vec![("info".into(), format!("status {status}"))],
                reason: None,
            })
            .collect();
    }

    /// The next poll of a running build fails it.
    pub(super) fn script_build_failure(&self, reason: &str, logs: &[(&str, &str)]) {
        let logs: Vec<(String, String)> = logs
            .iter()
            .map(|(level, message)| ((*level).into(), (*message).into()))
            .collect();
        self.state.lock().build_script = VecDeque::from([ScriptedStatus {
            status: "error".into(),
            logs: logs.clone(),
            reason: Some((reason.into(), Vec::new())),
        }]);
    }

    pub(super) fn add_template(&self, alias: &str, builds: &[(&str, &str)]) -> String {
        let mut guard = self.state.lock();
        guard.counter += 1;
        let id = format!("tpl{}", guard.counter);
        guard.templates.push(FakeTemplate {
            id: id.clone(),
            alias: alias.into(),
            builds: builds
                .iter()
                .map(|(build, status)| ((*build).into(), (*status).into()))
                .collect(),
        });
        id
    }

    pub(super) fn add_foreign_alias(&self, alias: &str) {
        self.state.lock().foreign_aliases.insert(alias.into());
    }

    pub(super) fn template_id(&self, alias: &str) -> Option<String> {
        self.state
            .lock()
            .templates
            .iter()
            .find(|template| template.alias == alias)
            .map(|template| template.id.clone())
    }

    /// Whether a started process has not ended.
    pub(super) fn is_live(&self, pid: u32) -> bool {
        self.state.lock().live.contains(&pid)
    }

    /// Every started process that has not ended.
    pub(super) fn live_pids(&self) -> Vec<u32> {
        self.state.lock().live.iter().copied().collect()
    }
}

async fn handle(State(state): State<Shared>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    let body = axum::body::to_bytes(body, 256 * 1024 * 1024)
        .await
        .unwrap_or_default()
        .to_vec();
    let recorded = Recorded {
        method: parts.method.as_str().to_string(),
        path: parts.uri.path().to_string(),
        query: parts.uri.query().map(str::to_string),
        headers: parts
            .headers
            .iter()
            .map(|(name, value)| {
                (
                    name.as_str().to_ascii_lowercase(),
                    value.to_str().unwrap_or_default().to_string(),
                )
            })
            .collect(),
        body,
    };
    let failure = {
        let mut guard = state.lock();
        guard.requests.push(recorded.clone());
        guard
            .failures
            .get_mut(&recorded.path)
            .and_then(VecDeque::pop_front)
    };
    if let Some((status, message)) = failure {
        return error(status, &message);
    }
    route(&state, &recorded)
}

fn route(state: &Shared, request: &Recorded) -> Response {
    let segments: Vec<&str> = request.path.trim_start_matches('/').split('/').collect();
    match (request.method.as_str(), segments.as_slice()) {
        ("GET", ["v2", "sandboxes"]) => list_sandboxes(state, request),
        ("POST", ["v2", "sandboxes"]) => create_sandbox(state, request),
        ("GET", ["sandboxes", id]) => {
            let guard = state.lock();
            match guard.sandboxes.get(*id) {
                Some(sandbox) => {
                    let mut detail = listed(id, sandbox);
                    if !sandbox.hide_token {
                        detail["envdAccessToken"] = json!(sandbox.token);
                    }
                    detail["domain"] = json!("detail.e2b.test");
                    json_response(200, detail)
                }
                None => error(404, "sandbox not found"),
            }
        }
        ("DELETE", ["sandboxes", id]) => match state.lock().sandboxes.remove(*id) {
            Some(_) => empty(204),
            None => error(404, "sandbox not found"),
        },
        ("POST", ["sandboxes", id, "pause"]) => {
            let mut guard = state.lock();
            match guard.sandboxes.get_mut(*id) {
                Some(sandbox) if sandbox.state == "running" => {
                    sandbox.state = "paused".into();
                    empty(204)
                }
                Some(_) => error(409, "sandbox is already paused"),
                None => error(404, "sandbox not found"),
            }
        }
        ("POST", ["v2", "sandboxes", id, "connect"]) => {
            let mut guard = state.lock();
            match guard.sandboxes.get_mut(*id) {
                Some(sandbox) => {
                    let status = if sandbox.state == "paused" { 201 } else { 200 };
                    sandbox.state = "running".into();
                    json_response(
                        status,
                        json!({
                            "sandboxID": id,
                            "templateID": "tpl",
                            "clientID": "client",
                            "envdVersion": "0.2.4",
                            "envdAccessToken": sandbox.token,
                            "domain": "connect.e2b.test",
                        }),
                    )
                }
                None => error(404, "sandbox not found"),
            }
        }
        ("GET", ["templates", "aliases", alias]) => {
            let guard = state.lock();
            if guard.foreign_aliases.contains(*alias) {
                return error(403, "alias belongs to another team");
            }
            match guard.templates.iter().find(|t| t.alias == *alias) {
                Some(template) => {
                    json_response(200, json!({ "templateID": template.id, "public": false }))
                }
                None => error(404, "template not found"),
            }
        }
        ("GET", ["templates", id]) => {
            let guard = state.lock();
            match guard.templates.iter().find(|t| t.id == *id) {
                Some(template) => json_response(
                    200,
                    json!({
                        "templateID": template.id,
                        "public": false,
                        "aliases": [template.alias],
                        "names": [template.alias],
                        "createdAt": "2026-10-10T00:00:00Z",
                        "updatedAt": "2026-10-10T00:00:00Z",
                        "lastSpawnedAt": null,
                        "spawnCount": 0,
                        "builds": template.builds.iter().map(|(build, status)| json!({
                            "buildID": build,
                            "status": status,
                            "createdAt": "2026-10-10T00:00:00Z",
                            "updatedAt": "2026-10-10T00:00:00Z",
                            "cpuCount": 2,
                            "memoryMB": 2048,
                        })).collect::<Vec<_>>(),
                    }),
                ),
                None => error(404, "template not found"),
            }
        }
        ("POST", ["v3", "templates"]) => {
            let body = request.json();
            let name = body["name"].as_str().unwrap_or_default().to_string();
            let mut guard = state.lock();
            guard.counter += 1;
            let build = format!("bld{}", guard.counter);
            let counter = guard.counter;
            let id = match guard.templates.iter_mut().find(|t| t.alias == name) {
                Some(template) => {
                    template.builds.push((build.clone(), "waiting".into()));
                    template.id.clone()
                }
                None => {
                    let id = format!("tpl{counter}");
                    guard.templates.push(FakeTemplate {
                        id: id.clone(),
                        alias: name.clone(),
                        builds: vec![(build.clone(), "waiting".into())],
                    });
                    id
                }
            };
            json_response(
                202,
                json!({
                    "templateID": id,
                    "buildID": build,
                    "public": false,
                    "names": [name],
                    "tags": [],
                    "aliases": [name],
                }),
            )
        }
        ("GET", ["templates", _id, "files", hash]) => {
            let guard = state.lock();
            if guard.files_present.contains(*hash) {
                json_response(201, json!({ "present": true }))
            } else {
                json_response(
                    201,
                    json!({
                        "present": false,
                        "url": guard.base.join(&format!("upload/{hash}")).unwrap().to_string(),
                        "headers": { "x-amz-meta-cognia": "1" },
                    }),
                )
            }
        }
        ("PUT", ["upload", hash]) => {
            state.lock().files_present.insert((*hash).to_string());
            empty(200)
        }
        ("POST", ["v2", "templates", id, "builds", build]) => {
            let mut guard = state.lock();
            match guard
                .templates
                .iter_mut()
                .find(|t| t.id == *id)
                .and_then(|t| t.builds.iter_mut().find(|(b, _)| b == build))
            {
                Some(entry) => {
                    entry.1 = "building".into();
                    empty(202)
                }
                None => error(404, "build not found"),
            }
        }
        ("GET", ["templates", id, "builds", build, "status"]) => {
            let mut guard = state.lock();
            let current = guard
                .templates
                .iter()
                .find(|t| t.id == *id)
                .and_then(|t| t.builds.iter().find(|(b, _)| b == build))
                .map(|(_, status)| status.clone());
            let Some(current) = current else {
                return error(404, "build not found");
            };
            if current == "ready" || current == "error" {
                return json_response(
                    200,
                    json!({
                        "templateID": id, "buildID": build, "status": current,
                        "logs": [], "logEntries": [],
                    }),
                );
            }
            let scripted = guard.build_script.pop_front().unwrap_or(ScriptedStatus {
                status: "ready".into(),
                logs: Vec::new(),
                reason: None,
            });
            if let Some(entry) = guard
                .templates
                .iter_mut()
                .find(|t| t.id == *id)
                .and_then(|t| t.builds.iter_mut().find(|(b, _)| b == build))
            {
                entry.1 = scripted.status.clone();
            }
            let entry = |(level, message): &(String, String)| json!({ "timestamp": "2026-10-10T00:00:00Z", "level": level, "message": message });
            let mut body = json!({
                "templateID": id,
                "buildID": build,
                "status": scripted.status,
                "logs": [],
                "logEntries": scripted.logs.iter().map(entry).collect::<Vec<_>>(),
            });
            if let Some((message, logs)) = &scripted.reason {
                body["reason"] = json!({
                    "message": message,
                    "logEntries": logs.iter().map(entry).collect::<Vec<_>>(),
                });
            }
            json_response(200, body)
        }
        ("POST", ["process.Process", method]) => envd(state, request, method),
        _ => error(
            404,
            &format!("no route {} {}", request.method, request.path),
        ),
    }
}

fn list_sandboxes(state: &Shared, request: &Recorded) -> Response {
    let query: Vec<(String, String)> =
        url::form_urlencoded::parse(request.query.as_deref().unwrap_or_default().as_bytes())
            .into_owned()
            .collect();
    let get = |name: &str| {
        query
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.clone())
    };
    let filter = match get("metadata") {
        Some(value) => match parse_metadata_filter(&value) {
            Ok(filter) => filter,
            Err(message) => return error(400, &format!("Error parsing metadata: {message}")),
        },
        None => BTreeMap::new(),
    };
    let guard = state.lock();
    let limit = get("limit")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(100)
        .min(guard.page_size);
    let offset = get("nextToken")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    let matching: Vec<Value> = guard
        .sandboxes
        .iter()
        .filter(|(_, sandbox)| {
            filter
                .iter()
                .all(|(key, value)| sandbox.metadata.get(key) == Some(value))
        })
        .map(|(id, sandbox)| listed(id, sandbox))
        .collect();
    let page: Vec<Value> = matching.iter().skip(offset).take(limit).cloned().collect();
    let mut response = json_response(200, Value::Array(page));
    if offset + limit < matching.len() {
        response.headers_mut().insert(
            "x-next-token",
            (offset + limit).to_string().parse().unwrap(),
        );
    }
    response
}

fn create_sandbox(state: &Shared, request: &Recorded) -> Response {
    let body = request.json();
    if body["templateID"].as_str().is_none() {
        return error(400, "templateID is required");
    }
    let metadata: BTreeMap<String, String> = body
        .get("metadata")
        .cloned()
        .map(|value| serde_json::from_value(value).expect("string metadata"))
        .unwrap_or_default();
    let mut guard = state.lock();
    guard.counter += 1;
    let id = format!("sbx{}", guard.counter);
    let token = format!("tok{}", guard.counter);
    guard.sandboxes.insert(
        id.clone(),
        FakeSandbox {
            state: "running".into(),
            metadata,
            token: token.clone(),
            hide_token: false,
        },
    );
    let mut created = json!({
        "sandboxID": id,
        "templateID": body["templateID"],
        "clientID": "client",
        "envdVersion": "0.2.4",
        "envdAccessToken": token,
    });
    if let Some(domain) = &guard.create_domain {
        created["domain"] = json!(domain);
    }
    json_response(201, created)
}

fn envd(state: &Shared, request: &Recorded, method: &str) -> Response {
    let sandbox_id = request.header("e2b-sandbox-id").unwrap_or_default();
    {
        let guard = state.lock();
        let authorized = guard.sandboxes.get(sandbox_id).is_some_and(|sandbox| {
            request.header("x-access-token") == Some(sandbox.token.as_str())
        }) && request.header("authorization") == Some("Basic cm9vdDo=");
        if !authorized {
            return json_response(
                401,
                json!({ "code": 401, "message": "unauthorized access, please provide a valid access token" }),
            );
        }
        if guard.sandboxes[sandbox_id].state != "running" {
            return error(502, "sandbox is paused");
        }
    }
    match method {
        "Start" => start_process(state, request),
        "SendInput" | "CloseStdin" => {
            let body = request.json();
            let pid = body["process"]["pid"].as_u64().unwrap_or_default() as u32;
            let mut guard = state.lock();
            if !guard.live.contains(&pid) {
                return json_response(
                    404,
                    json!({ "code": "not_found", "message": format!("process with pid {pid} not found") }),
                );
            }
            if let Some(echo) = guard.echoes.get(&pid) {
                let input = if method == "SendInput" {
                    let encoded = body["input"]["stdin"].as_str().unwrap_or_default();
                    EchoInput::Data(
                        base64::engine::general_purpose::STANDARD
                            .decode(encoded)
                            .expect("base64 stdin"),
                    )
                } else {
                    EchoInput::Close
                };
                let _ = echo.send(input);
            }
            if method == "CloseStdin" {
                guard.echoes.remove(&pid);
            }
            json_response(200, json!({}))
        }
        other => error(404, &format!("no envd method {other}")),
    }
}

fn start_process(state: &Shared, request: &Recorded) -> Response {
    let body = request.envelope_json();
    let cmd = body["process"]["cmd"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    let mut guard = state.lock();
    guard.counter += 1;
    let pid = 1000 + guard.counter as u32;
    let script = guard
        .scripts
        .get(&cmd)
        .cloned()
        .unwrap_or(ProcessScript::Fixed {
            frames: vec![ScriptFrame::End {
                code: 0,
                status: "exit status 0".into(),
            }],
            chunk: 4096,
        });
    let start = envelope(json!({ "event": { "start": { "pid": pid } } }));
    match script {
        ProcessScript::Fixed { frames, chunk } => {
            let mut bytes = Vec::new();
            let refused_start = matches!(frames.first(), Some(ScriptFrame::EndStreamError { .. }));
            if !refused_start {
                bytes.extend(start);
                guard.live.insert(pid);
            }
            for frame in frames {
                match frame {
                    ScriptFrame::Stdout(data) => bytes.extend(data_frame("stdout", &data)),
                    ScriptFrame::Stderr(data) => bytes.extend(data_frame("stderr", &data)),
                    ScriptFrame::Keepalive => {
                        bytes.extend(envelope(json!({ "event": { "keepalive": {} } })))
                    }
                    ScriptFrame::End { code, status } => {
                        bytes.extend(end_frame(code, &status));
                        bytes.extend(end_stream(json!({})));
                        guard.live.remove(&pid);
                    }
                    ScriptFrame::EndStreamError { code, message } => {
                        bytes.extend(end_stream(
                            json!({ "error": { "code": code, "message": message } }),
                        ));
                        guard.live.remove(&pid);
                    }
                    ScriptFrame::Cut => {
                        bytes.extend(&encode_envelope(b"{\"event\":{}}")[..3]);
                        break;
                    }
                }
            }
            let chunks: Vec<Result<Bytes, std::io::Error>> = bytes
                .chunks(chunk.max(1))
                .map(|piece| Ok(Bytes::copy_from_slice(piece)))
                .collect();
            stream_response(Body::from_stream(futures_util::stream::iter(chunks)))
        }
        ProcessScript::Echo => {
            let (sender, receiver) = mpsc::unbounded_channel();
            guard.echoes.insert(pid, sender);
            guard.live.insert(pid);
            let shared = state.clone();
            let first =
                futures_util::stream::once(
                    async move { Ok::<_, std::io::Error>(Bytes::from(start)) },
                );
            let rest = futures_util::stream::unfold(Some(receiver), move |receiver| {
                let shared = shared.clone();
                async move {
                    let mut receiver = receiver?;
                    match receiver.recv().await {
                        Some(EchoInput::Data(bytes)) => Some((
                            Ok(Bytes::from(data_frame("stdout", &bytes))),
                            Some(receiver),
                        )),
                        Some(EchoInput::Close) => {
                            shared.lock().live.remove(&pid);
                            let mut tail = end_frame(0, "exit status 0");
                            tail.extend(end_stream(json!({})));
                            Some((Ok(Bytes::from(tail)), None))
                        }
                        None => None,
                    }
                }
            });
            stream_response(Body::from_stream(first.chain(rest)))
        }
        ProcessScript::Linger => {
            guard.live.insert(pid);
            let first =
                futures_util::stream::once(
                    async move { Ok::<_, std::io::Error>(Bytes::from(start)) },
                );
            stream_response(Body::from_stream(
                first.chain(futures_util::stream::pending()),
            ))
        }
    }
}

/// One entry of a test tar.
#[derive(Debug, Clone)]
pub(super) enum TarEntry {
    Dir(String),
    File {
        path: String,
        content: Vec<u8>,
        mode: u32,
    },
    /// A path written verbatim into the header, `..` and all.
    RawPath {
        path: String,
        content: Vec<u8>,
    },
    Symlink {
        path: String,
        target: String,
    },
    Hardlink {
        path: String,
        target: String,
    },
    Fifo(String),
}

impl TarEntry {
    pub(super) fn dir(path: &str) -> Self {
        Self::Dir(path.into())
    }
    pub(super) fn file(path: &str, content: &[u8], mode: u32) -> Self {
        Self::File {
            path: path.into(),
            content: content.to_vec(),
            mode,
        }
    }
    pub(super) fn file_raw_path(path: &str, content: &[u8]) -> Self {
        Self::RawPath {
            path: path.into(),
            content: content.to_vec(),
        }
    }
    pub(super) fn symlink(path: &str, target: &str) -> Self {
        Self::Symlink {
            path: path.into(),
            target: target.into(),
        }
    }
    pub(super) fn hardlink(path: &str, target: &str) -> Self {
        Self::Hardlink {
            path: path.into(),
            target: target.into(),
        }
    }
    pub(super) fn fifo(path: &str) -> Self {
        Self::Fifo(path.into())
    }
}

fn header(kind: tar::EntryType, mode: u32, size: u64) -> tar::Header {
    let mut header = tar::Header::new_gnu();
    header.set_entry_type(kind);
    header.set_mode(mode);
    header.set_size(size);
    header.set_mtime(1_700_000_000);
    header.set_uid(0);
    header.set_gid(0);
    header
}

/// An uncompressed tar of `entries`.
pub(super) fn tar(entries: &[TarEntry]) -> Vec<u8> {
    let mut builder = tar::Builder::new(Vec::new());
    for entry in entries {
        match entry {
            TarEntry::Dir(path) => {
                let mut h = header(tar::EntryType::Directory, 0o755, 0);
                builder.append_data(&mut h, path, std::io::empty()).unwrap();
            }
            TarEntry::File {
                path,
                content,
                mode,
            } => {
                let mut h = header(tar::EntryType::Regular, *mode, content.len() as u64);
                builder
                    .append_data(&mut h, path, content.as_slice())
                    .unwrap();
            }
            TarEntry::RawPath { path, content } => {
                let mut h = header(tar::EntryType::Regular, 0o644, content.len() as u64);
                let name = &mut h.as_old_mut().name;
                name[..path.len()].copy_from_slice(path.as_bytes());
                h.set_cksum();
                builder.append(&h, content.as_slice()).unwrap();
            }
            TarEntry::Symlink { path, target } => {
                let mut h = header(tar::EntryType::Symlink, 0o777, 0);
                builder.append_link(&mut h, path, target).unwrap();
            }
            TarEntry::Hardlink { path, target } => {
                let mut h = header(tar::EntryType::Link, 0o755, 0);
                builder.append_link(&mut h, path, target).unwrap();
            }
            TarEntry::Fifo(path) => {
                let mut h = header(tar::EntryType::Fifo, 0o644, 0);
                builder.append_data(&mut h, path, std::io::empty()).unwrap();
            }
        }
    }
    builder.into_inner().unwrap()
}

pub(super) fn gzip(bytes: &[u8]) -> Vec<u8> {
    use std::io::Write as _;
    let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
    encoder.write_all(bytes).unwrap();
    encoder.finish().unwrap()
}

fn sha256(bytes: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}

struct RegistryState {
    manifests: HashMap<String, (String, Vec<u8>)>,
    blobs: HashMap<String, Vec<u8>>,
    require_auth: bool,
    served_with_auth: bool,
}

/// A fake OCI registry serving one agent bundle at `127.0.0.1:<port>/cognia/bundle`.
pub(super) struct FakeRegistry {
    pub image: PinnedImage,
    state: Arc<Mutex<RegistryState>>,
    server: tokio::task::JoinHandle<()>,
}

impl Drop for FakeRegistry {
    fn drop(&mut self) {
        self.server.abort();
    }
}

const OCI_INDEX: &str = "application/vnd.oci.image.index.v1+json";
const OCI_MANIFEST: &str = "application/vnd.oci.image.manifest.v1+json";

fn image_manifest(config: &[u8], layer: &[u8]) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "schemaVersion": 2,
        "mediaType": OCI_MANIFEST,
        "config": {
            "mediaType": "application/vnd.oci.image.config.v1+json",
            "digest": sha256(config),
            "size": config.len(),
        },
        "layers": [{
            "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",
            "digest": sha256(layer),
            "size": layer.len(),
        }],
    }))
    .unwrap()
}

impl FakeRegistry {
    pub(super) const USER: &'static str = "bundle-bot";
    pub(super) const PASSWORD: &'static str = "bundle-password";

    /// A two-platform bundle whose amd64 image has one layer of `entries`;
    /// pulls need Basic credentials.
    pub(super) async fn start_bundle(entries: &[TarEntry]) -> Self {
        Self::serve(gzip(&tar(entries)), None, true).await
    }

    /// A bundle whose layer bytes do not match the layer's digest.
    pub(super) async fn start_tampered_bundle() -> Self {
        let layer = gzip(&tar(&[TarEntry::file(
            "opt/cognia/bin/cognia-sandboxd",
            b"real",
            0o755,
        )]));
        let tampered = gzip(&tar(&[TarEntry::file(
            "opt/cognia/bin/cognia-sandboxd",
            b"evil",
            0o755,
        )]));
        Self::serve(layer, Some(tampered), false).await
    }

    async fn serve(layer: Vec<u8>, served_layer: Option<Vec<u8>>, require_auth: bool) -> Self {
        init_network_policy();
        let amd_config = serde_json::to_vec(&json!({
            "architecture": "amd64", "os": "linux",
            "rootfs": { "type": "layers", "diff_ids": [] },
        }))
        .unwrap();
        let arm_config = serde_json::to_vec(&json!({
            "architecture": "arm64", "os": "linux",
            "rootfs": { "type": "layers", "diff_ids": [] },
        }))
        .unwrap();
        let arm_layer = gzip(&tar(&[TarEntry::file("opt/cognia/arm", b"arm", 0o644)]));
        let amd = image_manifest(&amd_config, &layer);
        let arm = image_manifest(&arm_config, &arm_layer);
        let index = serde_json::to_vec(&json!({
            "schemaVersion": 2,
            "mediaType": OCI_INDEX,
            "manifests": [
                { "mediaType": OCI_MANIFEST, "digest": sha256(&arm), "size": arm.len(),
                  "platform": { "os": "linux", "architecture": "arm64" } },
                { "mediaType": OCI_MANIFEST, "digest": sha256(&amd), "size": amd.len(),
                  "platform": { "os": "linux", "architecture": "amd64" } },
            ],
        }))
        .unwrap();
        let mut manifests = HashMap::new();
        manifests.insert(sha256(&index), (OCI_INDEX.to_string(), index.clone()));
        manifests.insert(sha256(&amd), (OCI_MANIFEST.to_string(), amd));
        manifests.insert(sha256(&arm), (OCI_MANIFEST.to_string(), arm));
        let mut blobs = HashMap::new();
        blobs.insert(sha256(&amd_config), amd_config);
        blobs.insert(sha256(&arm_config), arm_config);
        blobs.insert(sha256(&arm_layer), arm_layer);
        blobs.insert(sha256(&layer), served_layer.unwrap_or(layer));
        let state = Arc::new(Mutex::new(RegistryState {
            manifests,
            blobs,
            require_auth,
            served_with_auth: false,
        }));

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = axum::Router::new()
            .fallback(registry_handle)
            .with_state(state.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self {
            image: PinnedImage {
                registry: address.to_string(),
                repository: "cognia/bundle".into(),
                digest: sha256(&index),
            },
            state,
            server,
        }
    }

    pub(super) fn served_with_auth(&self) -> bool {
        self.state.lock().served_with_auth
    }
}

async fn registry_handle(
    State(state): State<Arc<Mutex<RegistryState>>>,
    request: Request,
) -> Response {
    let path = request.uri().path().to_string();
    let authorization = request
        .headers()
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let mut guard = state.lock();
    if guard.require_auth {
        let expected = format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode(format!(
                "{}:{}",
                FakeRegistry::USER,
                FakeRegistry::PASSWORD
            ))
        );
        if authorization.as_deref() != Some(expected.as_str()) {
            return Response::builder()
                .status(StatusCode::UNAUTHORIZED)
                .header("www-authenticate", "Basic realm=\"fake\"")
                .body(Body::empty())
                .unwrap();
        }
        guard.served_with_auth = true;
    }
    let Some(rest) = path.strip_prefix("/v2/cognia/bundle/") else {
        return empty(404);
    };
    if let Some(reference) = rest.strip_prefix("manifests/") {
        return match guard.manifests.get(reference) {
            Some((content_type, body)) => Response::builder()
                .status(200)
                .header("content-type", content_type.as_str())
                .body(Body::from(body.clone()))
                .unwrap(),
            None => empty(404),
        };
    }
    if let Some(digest) = rest.strip_prefix("blobs/") {
        return match guard.blobs.get(digest) {
            Some(body) => Response::builder()
                .status(200)
                .header("content-type", "application/octet-stream")
                .body(Body::from(body.clone()))
                .unwrap(),
            None => empty(404),
        };
    }
    empty(404)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_metadata_parser_mirrors_e2b() {
        assert_eq!(
            parse_metadata_filter("a%3Db%26c%3Dd").unwrap(),
            BTreeMap::from([("a".into(), "b".into()), ("c".into(), "d".into())])
        );
        assert_eq!(
            parse_metadata_filter("k%3Dv%2520x").unwrap(),
            BTreeMap::from([("k".into(), "v x".into())])
        );
        assert!(parse_metadata_filter("novalue").is_err());
        assert!(parse_metadata_filter("%zz").is_err());
    }

    #[test]
    fn test_tars_round_trip() {
        let bytes = tar(&[
            TarEntry::dir("opt/"),
            TarEntry::file("opt/a", b"x", 0o600),
            TarEntry::symlink("opt/l", "a"),
        ]);
        let zipped = gzip(&bytes);
        assert_eq!(&zipped[..2], &[0x1f, 0x8b]);
        let mut plain = tar::Archive::new(bytes.as_slice());
        let names: Vec<String> = plain
            .entries()
            .unwrap()
            .map(|entry| entry.unwrap().path().unwrap().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["opt/", "opt/a", "opt/l"]);
    }

    async fn get(url: Url) -> u16 {
        let client =
            cognia_net::proxy_config::managed_client(reqwest::Client::builder(), url.as_str())
                .unwrap();
        client.get(url).send().await.unwrap().status().as_u16()
    }

    #[tokio::test]
    async fn the_fake_serves_and_records() {
        let fake = FakeE2b::start().await;
        let id = fake.add_sandbox("running", BTreeMap::new());
        assert_eq!(get(fake.url(&format!("/sandboxes/{id}"))).await, 200);
        assert_eq!(fake.requests_to(&format!("/sandboxes/{id}")).len(), 1);
        fake.fail_next("/v2/sandboxes", 503, "busy");
        assert_eq!(get(fake.url("/v2/sandboxes")).await, 503);
        assert_eq!(
            get(fake.url("/v2/sandboxes")).await,
            200,
            "one failure only"
        );
    }
}

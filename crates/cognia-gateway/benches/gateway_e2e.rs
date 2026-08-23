#[path = "support/stats.rs"]
mod stats;

use std::convert::Infallible;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::{Json, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::Router;
use bytes::Bytes;
use cognia_gateway::api_keys::GatewayApiKey;
use cognia_gateway::concurrency::ConcurrencyLimiter;
use cognia_gateway::cooldown::KeyCooldownMap;
use cognia_gateway::execute::KeyRotationMap;
use cognia_gateway::host::NoopGatewayHost;
use cognia_gateway::lease::CredentialLeaseMap;
use cognia_gateway::route_planner::RoutePlannerState;
use cognia_gateway::route_ticket::{InMemoryTicketMetaStore, RouteTicketRegistry};
use cognia_gateway::server::{spawn_server, RequestObserver, ServerHandle};
use cognia_gateway::snapshot::RoutingSnapshot;
use cognia_gateway::types::GatewayConfig;
use futures_util::stream;
use parking_lot::{Mutex, RwLock};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::task::JoinSet;

use stats::{summarize_ms, Distribution};

const DEFAULT_WARMUPS: usize = 5;
const DEFAULT_SAMPLES: usize = 30;
const DEFAULT_STREAM_FRAMES: usize = 512;
const SMALL_REQUEST_BYTES: usize = 2 * 1024;
const LARGE_REQUEST_BYTES: usize = 256 * 1024;
const GATEWAY_SECRET: &str = "sk-cognia-benchmark-benchmark-benchmark-benchmark-benchmark";

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
enum PathKind {
    BufferedOpenAi,
    StreamingOpenAi,
    StreamingTranslatedAnthropic,
}

impl PathKind {
    fn name(self) -> &'static str {
        match self {
            Self::BufferedOpenAi => "buffered-openai",
            Self::StreamingOpenAi => "streaming-openai",
            Self::StreamingTranslatedAnthropic => "streaming-translated-anthropic",
        }
    }

    fn gateway_path(self) -> &'static str {
        match self {
            Self::StreamingTranslatedAnthropic => "/v1/messages",
            Self::BufferedOpenAi | Self::StreamingOpenAi => "/v1/chat/completions",
        }
    }

    fn direct_path(self) -> &'static str {
        "/v1/chat/completions"
    }

    fn streams(self) -> bool {
        !matches!(self, Self::BufferedOpenAi)
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
enum SnapshotScale {
    Small,
    Large,
}

impl SnapshotScale {
    fn dimensions(self) -> (usize, usize, usize) {
        match self {
            Self::Small => (1, 1, 1),
            Self::Large => (32, 128, 4),
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Small => "small",
            Self::Large => "large",
        }
    }
}

#[derive(Clone)]
struct RequestSpec {
    url: String,
    body: Value,
    gateway_auth: bool,
}

#[derive(Debug)]
struct Observation {
    ttft_ms: f64,
    completion_ms: f64,
    response_bytes: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EndpointReport {
    ttft: Distribution,
    completion: Distribution,
    throughput_requests_per_sec: f64,
    response_bytes: usize,
    observations: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScenarioReport {
    name: String,
    path: PathKind,
    request_bytes: usize,
    snapshot: SnapshotScale,
    providers: usize,
    aliases: usize,
    candidates_per_alias: usize,
    concurrency: usize,
    direct: EndpointReport,
    gateway: EndpointReport,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Environment {
    os: &'static str,
    arch: &'static str,
    logical_cpus: usize,
    rust_profile: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BenchmarkReport {
    schema_version: u32,
    label: String,
    generated_at: String,
    environment: Environment,
    warmups: usize,
    measured_samples: usize,
    stream_frames: usize,
    scenarios: Vec<ScenarioReport>,
}

struct Args {
    label: String,
    output: PathBuf,
    warmups: usize,
    samples: usize,
    stream_frames: usize,
    quick: bool,
}

impl Args {
    fn parse() -> Self {
        let mut label = format!("run-{}", chrono::Utc::now().format("%Y%m%dT%H%M%SZ"));
        let mut output = None;
        let mut warmups = DEFAULT_WARMUPS;
        let mut samples = DEFAULT_SAMPLES;
        let mut stream_frames = DEFAULT_STREAM_FRAMES;
        let mut quick = false;
        let mut args = std::env::args().skip(1);
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--label" => label = args.next().expect("--label requires a value"),
                "--output" => {
                    output = Some(PathBuf::from(
                        args.next().expect("--output requires a value"),
                    ));
                }
                "--warmups" => {
                    warmups = args
                        .next()
                        .expect("--warmups requires a value")
                        .parse()
                        .expect("--warmups must be an integer");
                }
                "--samples" => {
                    samples = args
                        .next()
                        .expect("--samples requires a value")
                        .parse()
                        .expect("--samples must be an integer");
                }
                "--frames" => {
                    stream_frames = args
                        .next()
                        .expect("--frames requires a value")
                        .parse()
                        .expect("--frames must be an integer");
                }
                "--bench" => {}
                "--quick" => quick = true,
                other => panic!("unknown benchmark argument: {other}"),
            }
        }
        if quick {
            warmups = 1;
            samples = 3;
            stream_frames = 16;
        }
        assert!(samples > 0, "at least one measured sample is required");
        assert!(
            stream_frames > 1,
            "stream benchmark requires at least two frames"
        );
        let default_output = workspace_root()
            .join("target/perf/gateway")
            .join(format!("{label}.json"));
        Self {
            label,
            output: output.unwrap_or(default_output),
            warmups,
            samples,
            stream_frames,
            quick,
        }
    }
}

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|path| path.parent())
        .expect("gateway crate must live under workspace/crates")
        .to_path_buf()
}

#[derive(Clone)]
struct UpstreamState {
    frames: Arc<Vec<Bytes>>,
}

async fn upstream_chat(State(state): State<UpstreamState>, Json(body): Json<Value>) -> Response {
    if body.get("stream").and_then(Value::as_bool) == Some(true) {
        let frames = Arc::clone(&state.frames);
        let chunks = stream::iter(
            frames
                .iter()
                .cloned()
                .map(Ok::<Bytes, Infallible>)
                .collect::<Vec<_>>(),
        );
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream")
            .header("cache-control", "no-cache")
            .body(Body::from_stream(chunks))
            .expect("valid streaming response");
    }
    Json(json!({
        "id": "chatcmpl-benchmark",
        "object": "chat.completion",
        "model": body.get("model").cloned().unwrap_or(Value::Null),
        "choices": [{
            "index": 0,
            "message": { "role": "assistant", "content": "ok" },
            "finish_reason": "stop"
        }],
        "usage": { "prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12 }
    }))
    .into_response()
}

async fn start_upstream(frames: usize) -> (std::net::SocketAddr, tokio::sync::watch::Sender<()>) {
    let state = UpstreamState {
        frames: Arc::new(openai_sse_frames(frames)),
    };
    let app = Router::new()
        .route("/v1/chat/completions", post(upstream_chat))
        .with_state(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind deterministic upstream");
    let address = listener.local_addr().expect("upstream address");
    let (shutdown, mut shutdown_rx) = tokio::sync::watch::channel(());
    tokio::spawn(async move {
        let server = axum::serve(listener, app).with_graceful_shutdown(async move {
            let _ = shutdown_rx.changed().await;
        });
        if let Err(error) = server.await {
            panic!("benchmark upstream failed: {error}");
        }
    });
    (address, shutdown)
}

fn openai_sse_frames(count: usize) -> Vec<Bytes> {
    (0..count)
        .map(|index| {
            let value = if index + 1 == count {
                json!({
                    "id": "chatcmpl-benchmark",
                    "object": "chat.completion.chunk",
                    "model": "model-0",
                    "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop" }],
                    "usage": {
                        "prompt_tokens": 10,
                        "completion_tokens": count,
                        "total_tokens": count + 10
                    }
                })
            } else {
                json!({
                    "id": "chatcmpl-benchmark",
                    "object": "chat.completion.chunk",
                    "model": "model-0",
                    "choices": [{
                        "index": 0,
                        "delta": { "content": "x" },
                        "finish_reason": null
                    }]
                })
            };
            Bytes::from(format!("data: {value}\n\n"))
        })
        .chain(std::iter::once(Bytes::from_static(b"data: [DONE]\n\n")))
        .collect()
}

struct NoopObserver;

impl RequestObserver for NoopObserver {
    fn on_call(&self, _route: &str, _status: StatusCode, _remote_ip: std::net::IpAddr) {}
}

struct GatewayFixture {
    port: u16,
    _handle: ServerHandle,
}

async fn start_gateway(upstream: std::net::SocketAddr, scale: SnapshotScale) -> GatewayFixture {
    let config = Arc::new(RwLock::new(GatewayConfig {
        port: 0,
        rate_limit_per_min: 1_000_000,
        ..GatewayConfig::default()
    }));
    let keys = Arc::new(RwLock::new(vec![GatewayApiKey {
        id: "benchmark-key".into(),
        name: "Benchmark".into(),
        secret: GATEWAY_SECRET.into(),
        model_allowlist: Vec::new(),
        expires_at_ms: None,
        enabled: true,
        rate_limit_per_min: None,
        quota_tokens: None,
        quota_used_tokens: 0,
        created_at_ms: 0,
        last_used_at_ms: None,
    }]));
    let snapshot = Arc::new(RwLock::new(Some(snapshot(upstream, scale))));
    let handle = spawn_server(
        Arc::new(NoopGatewayHost),
        config,
        keys,
        snapshot,
        Arc::new(Mutex::new(std::collections::HashMap::new())),
        Arc::new(KeyRotationMap::default()),
        Arc::new(RoutePlannerState::default()),
        Arc::new(KeyCooldownMap::default()),
        Arc::new(ConcurrencyLimiter::default()),
        Arc::new(NoopObserver),
        Arc::new(RouteTicketRegistry::new(Arc::new(
            InMemoryTicketMetaStore::default(),
        ))),
        Arc::new(CredentialLeaseMap::default()),
    )
    .await
    .expect("start benchmark gateway");
    GatewayFixture {
        port: handle.bound_port,
        _handle: handle,
    }
}

fn snapshot(upstream: std::net::SocketAddr, scale: SnapshotScale) -> RoutingSnapshot {
    let (provider_count, alias_count, candidates_per_alias) = scale.dimensions();
    let providers: Vec<Value> = (0..provider_count)
        .map(|index| {
            json!({
                "id": format!("provider-{index}"),
                "protocol": "openai",
                "baseUrl": format!("http://{upstream}/v1"),
                "apiKey": format!("upstream-key-{index}"),
                "enabled": true,
                "models": [format!("model-{index}")],
                "deploymentId": format!("provider-{index}")
            })
        })
        .collect();
    let aliases: Vec<Value> = (0..alias_count)
        .map(|alias| {
            let entries: Vec<Value> = (0..candidates_per_alias)
                .map(|offset| {
                    let provider = (alias + offset) % provider_count;
                    json!({
                        "providerId": format!("provider-{provider}"),
                        "modelId": format!("model-{provider}"),
                        "weight": candidates_per_alias - offset
                    })
                })
                .collect();
            json!({
                "alias": format!("route-{alias}"),
                "distribution": "weighted",
                "entries": entries
            })
        })
        .collect();
    let candidate_aliases: Vec<String> = (0..alias_count)
        .map(|index| format!("route-{index}"))
        .collect();
    let snapshot: RoutingSnapshot = serde_json::from_value(json!({
        "aliases": aliases,
        "providers": providers,
        "generatedAtMs": 1,
        "profileVersion": 1,
        "authority": "renderer",
        "routingPolicy": {
            "schemaVersion": 2,
            "policyRevision": format!("benchmark-{}", scale.name()),
            "auto": {
                "modelId": "auto",
                "strategy": "balanced",
                "candidateAliases": candidate_aliases
            },
            "maxFallbackAttempts": candidates_per_alias
        }
    }))
    .expect("valid benchmark snapshot shape");
    snapshot.validate().expect("valid benchmark routing policy");
    snapshot
}

fn request_body(kind: PathKind, bytes: usize) -> Value {
    let content = "x".repeat(bytes.saturating_sub(256));
    match kind {
        PathKind::StreamingTranslatedAnthropic => json!({
            "model": "route-0",
            "max_tokens": 64,
            "stream": true,
            "messages": [{ "role": "user", "content": content }]
        }),
        PathKind::BufferedOpenAi | PathKind::StreamingOpenAi => json!({
            "model": "route-0",
            "max_tokens": 64,
            "stream": kind.streams(),
            "messages": [{ "role": "user", "content": content }]
        }),
    }
}

async fn observe(client: &reqwest::Client, spec: &RequestSpec) -> Observation {
    let started = Instant::now();
    let mut request = client.post(&spec.url).json(&spec.body);
    if spec.gateway_auth {
        request = request.header("x-api-key", GATEWAY_SECRET);
    }
    let mut response = request.send().await.expect("benchmark request succeeds");
    assert_eq!(
        response.status(),
        reqwest::StatusCode::OK,
        "benchmark endpoint returned a non-success response"
    );
    let first = response
        .chunk()
        .await
        .expect("read first response chunk")
        .expect("benchmark response must not be empty");
    let ttft_ms = started.elapsed().as_secs_f64() * 1_000.0;
    let mut response_bytes = first.len();
    while let Some(chunk) = response.chunk().await.expect("read response chunk") {
        response_bytes += chunk.len();
    }
    Observation {
        ttft_ms,
        completion_ms: started.elapsed().as_secs_f64() * 1_000.0,
        response_bytes,
    }
}

async fn run_batch(
    client: &reqwest::Client,
    spec: &RequestSpec,
    concurrency: usize,
) -> (Vec<Observation>, Duration) {
    let started = Instant::now();
    let mut tasks = JoinSet::new();
    for _ in 0..concurrency {
        let client = client.clone();
        let spec = spec.clone();
        tasks.spawn(async move { observe(&client, &spec).await });
    }
    let mut observations = Vec::with_capacity(concurrency);
    while let Some(result) = tasks.join_next().await {
        observations.push(result.expect("benchmark request task must not panic"));
    }
    (observations, started.elapsed())
}

async fn measure_endpoint(
    client: &reqwest::Client,
    spec: &RequestSpec,
    concurrency: usize,
    warmups: usize,
    samples: usize,
) -> EndpointReport {
    for _ in 0..warmups {
        let _ = run_batch(client, spec, concurrency).await;
    }
    let mut observations = Vec::with_capacity(samples * concurrency);
    let mut total_elapsed = Duration::ZERO;
    for _ in 0..samples {
        let (mut batch, elapsed) = run_batch(client, spec, concurrency).await;
        observations.append(&mut batch);
        total_elapsed += elapsed;
    }
    let ttft: Vec<f64> = observations.iter().map(|value| value.ttft_ms).collect();
    let completion: Vec<f64> = observations
        .iter()
        .map(|value| value.completion_ms)
        .collect();
    let response_bytes = observations
        .first()
        .map(|value| value.response_bytes)
        .unwrap_or_default();
    EndpointReport {
        ttft: summarize_ms(&ttft),
        completion: summarize_ms(&completion),
        throughput_requests_per_sec: observations.len() as f64 / total_elapsed.as_secs_f64(),
        response_bytes,
        observations: observations.len(),
    }
}

#[allow(clippy::too_many_arguments)]
async fn measure_scenario(
    client: &reqwest::Client,
    upstream: std::net::SocketAddr,
    gateway_port: u16,
    kind: PathKind,
    request_bytes: usize,
    snapshot_scale: SnapshotScale,
    concurrency: usize,
    args: &Args,
) -> ScenarioReport {
    let body = request_body(kind, request_bytes);
    let direct = RequestSpec {
        url: format!("http://{upstream}{}", kind.direct_path()),
        body: body.clone(),
        gateway_auth: false,
    };
    let gateway = RequestSpec {
        url: format!("http://127.0.0.1:{gateway_port}{}", kind.gateway_path()),
        body,
        gateway_auth: true,
    };
    let direct_report =
        measure_endpoint(client, &direct, concurrency, args.warmups, args.samples).await;
    let gateway_report =
        measure_endpoint(client, &gateway, concurrency, args.warmups, args.samples).await;
    let (providers, aliases, candidates_per_alias) = snapshot_scale.dimensions();
    ScenarioReport {
        name: format!(
            "{}-{}-{}k-c{}",
            kind.name(),
            snapshot_scale.name(),
            request_bytes / 1024,
            concurrency
        ),
        path: kind,
        request_bytes,
        snapshot: snapshot_scale,
        providers,
        aliases,
        candidates_per_alias,
        concurrency,
        direct: direct_report,
        gateway: gateway_report,
    }
}

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    let args = Args::parse();
    let (upstream, upstream_shutdown) = start_upstream(args.stream_frames).await;
    let small_gateway = start_gateway(upstream, SnapshotScale::Small).await;
    let large_gateway = start_gateway(upstream, SnapshotScale::Large).await;
    let client = reqwest::Client::builder()
        .pool_max_idle_per_host(64)
        .build()
        .expect("build benchmark client");
    let kinds = [
        PathKind::BufferedOpenAi,
        PathKind::StreamingOpenAi,
        PathKind::StreamingTranslatedAnthropic,
    ];
    let request_sizes = [SMALL_REQUEST_BYTES, LARGE_REQUEST_BYTES];
    let scales = [SnapshotScale::Small, SnapshotScale::Large];
    let concurrencies: &[usize] = if args.quick { &[1] } else { &[1, 32] };
    let mut scenarios = Vec::new();
    for kind in kinds {
        for request_bytes in request_sizes {
            for scale in scales {
                let port = match scale {
                    SnapshotScale::Small => small_gateway.port,
                    SnapshotScale::Large => large_gateway.port,
                };
                for &concurrency in concurrencies {
                    eprintln!(
                        "measuring {} / {} / {} KiB / concurrency {}",
                        kind.name(),
                        scale.name(),
                        request_bytes / 1024,
                        concurrency
                    );
                    scenarios.push(
                        measure_scenario(
                            &client,
                            upstream,
                            port,
                            kind,
                            request_bytes,
                            scale,
                            concurrency,
                            &args,
                        )
                        .await,
                    );
                }
            }
        }
    }
    let report = BenchmarkReport {
        schema_version: 1,
        label: args.label,
        generated_at: chrono::Utc::now().to_rfc3339(),
        environment: Environment {
            os: std::env::consts::OS,
            arch: std::env::consts::ARCH,
            logical_cpus: std::thread::available_parallelism()
                .map(usize::from)
                .unwrap_or(1),
            rust_profile: "release-bench",
        },
        warmups: args.warmups,
        measured_samples: args.samples,
        stream_frames: args.stream_frames,
        scenarios,
    };
    if let Some(parent) = args.output.parent() {
        std::fs::create_dir_all(parent).expect("create benchmark output directory");
    }
    let json = serde_json::to_vec_pretty(&report).expect("serialize benchmark report");
    std::fs::write(&args.output, json).expect("write benchmark report");
    let _ = upstream_shutdown.send(());
    println!("{}", args.output.display());
}

//! Feature-gated, loopback-only debug surface for agents driving the real
//! Tauri webviews. Transport and authentication are owned by `cli_bridge`;
//! this module contributes routes only when the `agent-debug` Cargo feature is
//! explicitly enabled.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::{
    extract::{Json, Query, State},
    http::StatusCode,
    routing::{get, post},
    Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Webview, WebviewWindow};

use crate::cli_bridge::SharedState;
use crate::webview_watchdog::RendererLifecycle;

const INJECTED_SCRIPT: &str = include_str!("agent_debug/injected.js");
const AUTOMATION_CORE_SCRIPT: &str = include_str!("../../lib/browser/automation-core.injected.js");
const MAX_EXPRESSION_BYTES: usize = 64 * 1024;
const MAX_RESULT_BYTES: usize = 2 * 1024 * 1024;
const DEFAULT_WINDOW: &str = "main";
const DEFAULT_LOG_LINES: usize = 400;
const MAX_LOG_LINES: usize = 5_000;
const EVAL_TIMEOUT: Duration = Duration::from_secs(10);
/// How long an evaluation waits for a terminated renderer's replacement to
/// commit a document before failing with `webview_renderer_restarting`.
const RENDERER_RELOAD_WAIT: Duration = Duration::from_secs(10);

/// Why a webview evaluation failed. Renderer lifecycle failures are typed so
/// the HTTP payload can carry the window and renderer generation.
#[derive(Debug, Clone, PartialEq, Eq)]
enum EvalError {
    /// A bridge/evaluation failure, classified by message in [`eval_error`].
    Failed(String),
    /// The renderer this evaluation was sent to terminated (WKWebView web
    /// content process died) before answering. Its realm, helper state, and
    /// element refs are gone; the webview is reloading into a new renderer.
    RendererRestarted { window: String, generation: u64 },
    /// A terminated renderer's replacement has not committed a document yet.
    RendererRestarting { window: String, generation: u64 },
}

impl From<String> for EvalError {
    fn from(message: String) -> Self {
        Self::Failed(message)
    }
}

impl std::fmt::Display for EvalError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Failed(message) => formatter.write_str(message),
            Self::RendererRestarted { window, generation } => write!(
                formatter,
                "webview renderer restarted: the {window} web content process terminated before answering (renderer generation {generation}); the page reloaded, so element refs and in-page state are gone — re-run the command"
            ),
            Self::RendererRestarting { window, generation } => write!(
                formatter,
                "webview renderer is restarting: the {window} web content process terminated (renderer generation {generation}) and its replacement has not loaded a document yet"
            ),
        }
    }
}

type ApiResult = Result<Json<Value>, (StatusCode, Json<Value>)>;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowQuery {
    #[serde(default = "default_window")]
    window: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticQuery {
    #[serde(default = "default_window")]
    window: String,
    #[serde(default)]
    after: u64,
    #[serde(default = "default_diagnostic_limit")]
    limit: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotRequest {
    #[serde(default = "default_window")]
    window: String,
    #[serde(default)]
    include_text: bool,
    #[serde(default)]
    include_hidden: bool,
    selector: Option<String>,
    role: Option<String>,
    name: Option<String>,
    #[serde(default)]
    name_exact: bool,
    query: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActRequest {
    #[serde(default = "default_window")]
    window: String,
    reference: String,
    action: String,
    #[serde(default)]
    args: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InspectRequest {
    #[serde(default = "default_window")]
    window: String,
    reference: String,
    operation: String,
    #[serde(default)]
    args: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocatorRequest {
    #[serde(default = "default_window")]
    window: String,
    query: Value,
    index: Option<i64>,
    #[serde(default)]
    filters: Vec<Value>,
    operation: String,
    name: Option<String>,
    #[serde(default)]
    args: Value,
    #[serde(default)]
    options: Value,
    #[serde(default)]
    requirements: Value,
    #[serde(default = "default_true")]
    strict: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EvaluateRequest {
    #[serde(default = "default_window")]
    window: String,
    expression: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NavigateRequest {
    #[serde(default = "default_window")]
    window: String,
    url: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LogsQuery {
    lines: Option<usize>,
}

fn default_window() -> String {
    DEFAULT_WINDOW.to_string()
}

fn default_true() -> bool {
    true
}

fn default_diagnostic_limit() -> usize {
    500
}

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/api/dev/agent/health", get(health))
        .route("/api/dev/agent/windows", get(windows))
        .route("/api/dev/agent/snapshot", post(snapshot))
        .route("/api/dev/agent/act", post(act))
        .route("/api/dev/agent/inspect", post(inspect))
        .route("/api/dev/agent/locator", post(locator))
        .route("/api/dev/agent/evaluate", post(evaluate))
        .route("/api/dev/agent/console", get(console))
        .route("/api/dev/agent/network", get(network))
        .route("/api/dev/agent/navigate", post(navigate))
        .route("/api/dev/agent/reload", post(reload))
        .route("/api/dev/agent/screenshot", get(screenshot))
        .route("/api/dev/agent/logs", get(logs))
        .route("/api/dev/agent/shutdown", post(shutdown))
}

/// Install the non-invasive page helper after each navigation. The helper is
/// idempotent, so routes may also install it lazily before an operation.
pub fn install(webview: &Webview) {
    if let Err(error) = webview.eval(AUTOMATION_CORE_SCRIPT) {
        log::warn!(
            "agent_debug automation core injection failed for {}: {error}",
            webview.label()
        );
        return;
    }
    if let Err(error) = webview.eval(INJECTED_SCRIPT) {
        log::warn!(
            "agent_debug helper injection failed for {}: {error}",
            webview.label()
        );
    }
}

async fn health(State(state): State<SharedState>) -> ApiResult {
    let app = &state.app_handle;
    let lifecycle = renderer_lifecycle(app);
    // Health must stay fast while a renderer is being replaced: report the
    // restart through `renderers` instead of blocking on the reload.
    let helper = match app.get_webview(DEFAULT_WINDOW) {
        Some(webview) if !lifecycle.state(DEFAULT_WINDOW).awaiting_load => eval_json(
            &webview,
            &lifecycle,
            "JSON.stringify(window.__cogniaAgentDebug.health())",
        )
        .await
        .ok(),
        _ => None,
    };
    Ok(Json(json!({
        "ok": true,
        "agentDebug": true,
        "pid": std::process::id(),
        "version": app.package_info().version.to_string(),
        "platform": std::env::consts::OS,
        "helper": helper,
        "renderers": lifecycle.snapshot(),
        "logDir": crate::logging::native_bootstrap::log_dir(),
    })))
}

async fn windows(State(state): State<SharedState>) -> ApiResult {
    let mut entries = Vec::new();
    for (label, window) in state.app_handle.webview_windows() {
        entries.push(json!({
            "label": label,
            "url": window.url().map(|url| url.to_string()).ok(),
            "title": window.title().ok(),
            "visible": window.is_visible().ok(),
            "focused": window.is_focused().ok(),
        }));
    }
    entries.sort_by(|left, right| left["label"].as_str().cmp(&right["label"].as_str()));
    Ok(Json(json!({ "ok": true, "windows": entries })))
}

async fn snapshot(
    State(state): State<SharedState>,
    Json(request): Json<SnapshotRequest>,
) -> ApiResult {
    let webview = resolve_webview(&state.app_handle, &request.window)?;
    let options = serde_json::to_string(&json!({
        "includeText": request.include_text,
        "includeHidden": request.include_hidden,
        "selector": request.selector,
        "role": request.role,
        "name": request.name,
        "nameExact": request.name_exact,
        "query": request.query,
    }))
    .map_err(internal_error)?;
    let script = format!("JSON.stringify(window.__cogniaAgentDebug.snapshot({options}))");
    let lifecycle = renderer_lifecycle(&state.app_handle);
    let value = eval_json(&webview, &lifecycle, &script)
        .await
        .map_err(eval_error)?;
    Ok(Json(
        json!({ "ok": true, "window": request.window, "snapshot": value }),
    ))
}

async fn inspect(
    State(state): State<SharedState>,
    Json(request): Json<InspectRequest>,
) -> ApiResult {
    validate_ref(&request.reference)?;
    validate_inspection(&request.operation)?;
    let webview = resolve_webview(&state.app_handle, &request.window)?;
    let reference = serde_json::to_string(&request.reference).map_err(internal_error)?;
    let operation = serde_json::to_string(&request.operation).map_err(internal_error)?;
    let args = serde_json::to_string(&request.args).map_err(internal_error)?;
    let script = format!(
        "(async()=>JSON.stringify(await window.__cogniaAgentDebug.inspect({reference},{operation},{args})))()"
    );
    let lifecycle = renderer_lifecycle(&state.app_handle);
    let value = eval_json_async(&webview, &lifecycle, &script)
        .await
        .map_err(eval_error)?;
    Ok(Json(json!({
        "ok": true,
        "window": request.window,
        "value": value,
    })))
}

async fn locator(
    State(state): State<SharedState>,
    Json(request): Json<LocatorRequest>,
) -> ApiResult {
    const OPERATIONS: [&str; 3] = ["query", "inspect", "action"];
    if !OPERATIONS.contains(&request.operation.as_str()) {
        return Err(bad_request(
            "unsupported_locator_operation",
            format!("unsupported locator operation: {}", request.operation),
        ));
    }
    let webview = resolve_webview(&state.app_handle, &request.window)?;
    let timeout = Duration::from_millis(
        request
            .options
            .get("timeout")
            .and_then(Value::as_u64)
            .unwrap_or(10_000)
            .clamp(1, 10_000),
    );
    let payload = serde_json::to_string(&json!({
        "query": request.query,
        "index": request.index,
        "filters": request.filters,
        "operation": request.operation,
        "name": request.name,
        "args": request.args,
        "options": request.options,
        "requirements": request.requirements,
        "strict": request.strict,
    }))
    .map_err(internal_error)?;
    let script =
        format!("(async()=>JSON.stringify(await window.__cogniaAgentDebug.locator({payload})))()");
    let lifecycle = renderer_lifecycle(&state.app_handle);
    let value = eval_json_async_with_timeout(&webview, &lifecycle, &script, timeout)
        .await
        .map_err(eval_error)?;
    Ok(Json(json!({
        "ok": true,
        "window": request.window,
        "locator": value,
    })))
}

async fn act(State(state): State<SharedState>, Json(request): Json<ActRequest>) -> ApiResult {
    validate_ref(&request.reference)?;
    validate_action(&request.action)?;
    let webview = resolve_webview(&state.app_handle, &request.window)?;
    let reference = serde_json::to_string(&request.reference).map_err(internal_error)?;
    let action = serde_json::to_string(&request.action).map_err(internal_error)?;
    let args = serde_json::to_string(&request.args).map_err(internal_error)?;
    let script = format!(
        "(async()=>{{const result=await window.__cogniaAgentDebug.act({reference},{action},{args});const snapshot=window.__cogniaAgentDebug.snapshot({{includeText:false}});return JSON.stringify({{result,snapshot}});}})()"
    );
    let lifecycle = renderer_lifecycle(&state.app_handle);
    let value = eval_json_async(&webview, &lifecycle, &script)
        .await
        .map_err(eval_error)?;
    Ok(Json(
        json!({ "ok": true, "window": request.window, "act": value }),
    ))
}

async fn evaluate(
    State(state): State<SharedState>,
    Json(request): Json<EvaluateRequest>,
) -> ApiResult {
    if request.expression.trim().is_empty() {
        return Err(bad_request(
            "empty_expression",
            "expression must not be empty",
        ));
    }
    if request.expression.len() > MAX_EXPRESSION_BYTES {
        return Err(bad_request(
            "expression_too_large",
            "expression exceeds the 64 KiB limit",
        ));
    }
    let webview = resolve_webview(&state.app_handle, &request.window)?;
    let expression = serde_json::to_string(&request.expression).map_err(internal_error)?;
    let script = format!(
        "(async()=>{{const value=await (0,eval)({expression});return JSON.stringify(window.__cogniaAgentDebug.serialize(value));}})()"
    );
    let lifecycle = renderer_lifecycle(&state.app_handle);
    let value = eval_json_async(&webview, &lifecycle, &script)
        .await
        .map_err(eval_error)?;
    Ok(Json(
        json!({ "ok": true, "window": request.window, "value": value }),
    ))
}

async fn console(
    State(state): State<SharedState>,
    Query(query): Query<DiagnosticQuery>,
) -> ApiResult {
    read_diagnostics(&state.app_handle, &query, "readConsole", "console").await
}

async fn network(
    State(state): State<SharedState>,
    Query(query): Query<DiagnosticQuery>,
) -> ApiResult {
    read_diagnostics(&state.app_handle, &query, "readNetwork", "network").await
}

async fn read_diagnostics(
    app: &AppHandle,
    query: &DiagnosticQuery,
    method: &str,
    key: &str,
) -> ApiResult {
    let webview = resolve_webview(app, &query.window)?;
    let limit = query.limit.clamp(1, 500);
    let script = format!(
        "JSON.stringify(window.__cogniaAgentDebug.{method}({}, {limit}))",
        query.after
    );
    let lifecycle = renderer_lifecycle(app);
    let value = eval_json(&webview, &lifecycle, &script)
        .await
        .map_err(eval_error)?;
    Ok(Json(
        json!({ "ok": true, "window": query.window, (key): value }),
    ))
}

async fn reload(State(state): State<SharedState>, Json(request): Json<WindowQuery>) -> ApiResult {
    let webview = resolve_webview(&state.app_handle, &request.window)?;
    webview
        .reload()
        .map_err(|error| internal_error(format!("failed to reload {}: {error}", request.window)))?;
    Ok(Json(json!({ "ok": true, "window": request.window })))
}

async fn navigate(
    State(state): State<SharedState>,
    Json(request): Json<NavigateRequest>,
) -> ApiResult {
    let webview = resolve_webview(&state.app_handle, &request.window)?;
    let target = match url::Url::parse(&request.url) {
        Ok(url) => url,
        Err(url::ParseError::RelativeUrlWithoutBase) => webview
            .url()
            .map_err(internal_error)?
            .join(&request.url)
            .map_err(|error| bad_request("invalid_url", error.to_string()))?,
        Err(error) => return Err(bad_request("invalid_url", error.to_string())),
    };
    match target.scheme() {
        "http" | "https" | "tauri" => {}
        scheme => {
            return Err(bad_request(
                "unsupported_url_scheme",
                format!("unsupported navigation scheme: {scheme}"),
            ));
        }
    }
    webview.navigate(target.clone()).map_err(internal_error)?;
    Ok(Json(
        json!({ "ok": true, "window": request.window, "url": target }),
    ))
}

async fn screenshot(
    State(state): State<SharedState>,
    Query(query): Query<WindowQuery>,
) -> ApiResult {
    let window = state
        .app_handle
        .get_webview_window(&query.window)
        .ok_or_else(|| {
            not_found(
                "window_not_found",
                format!("webview window not found: {}", query.window),
            )
        })?;
    let region = webview_window_region(&window)?;
    let capture = tokio::task::spawn_blocking(move || {
        crate::automation::platform::shared::screenshot::capture_global_region(
            region,
            crate::automation::types::ImageFormat::Png,
        )
    })
    .await
    .map_err(internal_error)?;
    let capture = match capture {
        Ok(capture) => capture,
        Err(error) if screenshot_needs_recenter(&error) => {
            window.show().map_err(internal_error)?;
            window.unminimize().map_err(internal_error)?;
            window
                .set_position(tauri::LogicalPosition::new(0.0, 0.0))
                .map_err(internal_error)?;
            tokio::time::sleep(Duration::from_millis(100)).await;
            let region = webview_window_region(&window)?;
            tokio::task::spawn_blocking(move || {
                crate::automation::platform::shared::screenshot::capture_global_region(
                    region,
                    crate::automation::types::ImageFormat::Png,
                )
            })
            .await
            .map_err(internal_error)?
            .map_err(internal_error)?
        }
        Err(error) => return Err(internal_error(error)),
    };
    Ok(Json(
        json!({ "ok": true, "window": query.window, "screenshot": capture }),
    ))
}

fn webview_window_region(
    window: &WebviewWindow,
) -> Result<crate::automation::types::Rect, (StatusCode, Json<Value>)> {
    let position = window.outer_position().map_err(internal_error)?;
    let size = window.outer_size().map_err(internal_error)?;
    let scale = window.scale_factor().map_err(internal_error)?;
    logical_region(position.x, position.y, size.width, size.height, scale)
}

fn screenshot_needs_recenter(error: &crate::automation::types::AutomationError) -> bool {
    matches!(
        error,
        crate::automation::types::AutomationError::BackendError { message }
            if message == "capture region falls outside every monitor"
    )
}

async fn logs(Query(query): Query<LogsQuery>) -> ApiResult {
    let lines = query
        .lines
        .unwrap_or(DEFAULT_LOG_LINES)
        .clamp(1, MAX_LOG_LINES);
    let log_dir = crate::logging::native_bootstrap::log_dir()
        .ok_or_else(|| not_found("log_dir_unavailable", "native log directory is unavailable"))?;
    let result = tokio::task::spawn_blocking(move || read_log_tail(log_dir, lines))
        .await
        .map_err(internal_error)?
        .map_err(internal_error)?;
    Ok(Json(json!({ "ok": true, "lines": result })))
}

async fn shutdown(State(state): State<SharedState>) -> ApiResult {
    let app = state.app_handle.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        app.exit(0);
    });
    Ok(Json(json!({ "ok": true, "shuttingDown": true })))
}

fn resolve_webview(app: &AppHandle, label: &str) -> Result<Webview, (StatusCode, Json<Value>)> {
    if label.is_empty() || label.len() > 128 {
        return Err(bad_request("invalid_window", "window label is invalid"));
    }
    app.get_webview(label)
        .ok_or_else(|| not_found("window_not_found", format!("webview not found: {label}")))
}

/// Managed renderer lifecycle; an untracked fallback keeps the bridge usable
/// (without restart detection) if the state was never registered.
fn renderer_lifecycle(app: &AppHandle) -> RendererLifecycle {
    app.try_state::<RendererLifecycle>()
        .map(|state| state.inner().clone())
        .unwrap_or_default()
}

async fn eval_json(
    webview: &Webview,
    lifecycle: &RendererLifecycle,
    script: &str,
) -> Result<Value, EvalError> {
    eval_json_on_renderer(webview, lifecycle, script)
        .await
        .map(|(value, _)| value)
}

/// Evaluate `script` and return its JSON result together with the renderer
/// generation that produced it.
///
/// Rebinding after a web content process termination: the evaluation first
/// waits for the replacement renderer to commit a document, re-injects the
/// helper (idempotent), and then races the completion callback against a
/// further termination. A renderer that dies mid-evaluation never invokes the
/// callback (or invokes it with no value), which previously surfaced only as a
/// 10 s `webview_eval_timeout` on every call.
async fn eval_json_on_renderer(
    webview: &Webview,
    lifecycle: &RendererLifecycle,
    script: &str,
) -> Result<(Value, u64), EvalError> {
    let label = webview.label().to_string();
    let renderer = bind_renderer(lifecycle, &label, RENDERER_RELOAD_WAIT).await?;

    // Re-inject the helper on every call: after a renderer restart the new
    // realm starts without it (installation is idempotent otherwise).
    install(webview);
    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    let slot = Arc::new(Mutex::new(Some(tx)));
    let callback = slot.clone();
    webview
        .eval_with_callback(script, move |result| {
            if let Ok(mut guard) = callback.lock() {
                if let Some(sender) = guard.take() {
                    let _ = sender.send(result);
                }
            }
        })
        .map_err(|error| EvalError::Failed(error.to_string()))?;

    let raw = await_eval_answer(rx, lifecycle, &label, renderer.generation, EVAL_TIMEOUT).await?;
    let unwrapped = unwrap_js_string(raw);
    if unwrapped.len() > MAX_RESULT_BYTES {
        return Err("webview evaluation result exceeds the 2 MiB limit"
            .to_string()
            .into());
    }
    let value = serde_json::from_str(&unwrapped)
        .map_err(|error| EvalError::Failed(format!("invalid JSON from webview: {error}")))?;
    Ok((value, renderer.generation))
}

/// Resolve the renderer an evaluation will run on. While a terminated
/// renderer is being replaced, wait (bounded) for the replacement to commit a
/// document — the rebind — instead of sending the script into the void.
async fn bind_renderer(
    lifecycle: &RendererLifecycle,
    label: &str,
    wait: Duration,
) -> Result<crate::webview_watchdog::RendererState, EvalError> {
    let mut renderer = lifecycle.state(label);
    if renderer.awaiting_load {
        renderer = lifecycle.wait_until_loaded(label, wait).await;
        if renderer.awaiting_load {
            return Err(EvalError::RendererRestarting {
                window: label.to_string(),
                generation: renderer.generation,
            });
        }
    }
    Ok(renderer)
}

/// Outcome of waiting on an evaluation's completion callback.
type EvalAnswer = Option<
    Result<Result<String, tokio::sync::oneshot::error::RecvError>, tokio::time::error::Elapsed>,
>;

/// Race the completion callback against a termination of the renderer the
/// script was sent to (`generation`). A renderer that dies mid-evaluation never
/// invokes the callback — that used to surface only as a 10 s timeout, on every
/// call, with no hint that the page had been replaced.
async fn await_eval_answer(
    answer: tokio::sync::oneshot::Receiver<String>,
    lifecycle: &RendererLifecycle,
    label: &str,
    generation: u64,
    timeout: Duration,
) -> Result<String, EvalError> {
    let outcome: EvalAnswer = tokio::select! {
        result = tokio::time::timeout(timeout, answer) => Some(result),
        () = lifecycle.wait_for_termination(label, generation) => None,
    };
    classify_eval_answer(
        outcome,
        label,
        generation,
        lifecycle.state(label).generation,
    )
}

/// Pure classification of an evaluation answer given the renderer generation
/// it was sent to (`sent_on`) and the generation observed afterwards (`now`).
fn classify_eval_answer(
    outcome: EvalAnswer,
    label: &str,
    sent_on: u64,
    now: u64,
) -> Result<String, EvalError> {
    let restarted = || EvalError::RendererRestarted {
        window: label.to_string(),
        generation: now,
    };
    match outcome {
        None => Err(restarted()),
        Some(Ok(Ok(value))) if !value.is_empty() => Ok(value),
        // An empty completion (wry's shape for an errored evaluation), a
        // dropped callback, or silence around a termination is the dead
        // renderer's non-answer, not a page result.
        Some(_) if now != sent_on => Err(restarted()),
        Some(Ok(Ok(value))) => Ok(value),
        Some(Ok(Err(_))) => Err("webview evaluation channel closed".to_string().into()),
        Some(Err(_)) => Err("webview evaluation timed out".to_string().into()),
    }
}

/// An async-evaluation poll answered by a different renderer than the one
/// holding the pending promise means the promise (and its result) is gone.
fn check_poll_renderer(label: &str, started_on: u64, polled_on: u64) -> Result<(), EvalError> {
    if polled_on == started_on {
        Ok(())
    } else {
        Err(EvalError::RendererRestarted {
            window: label.to_string(),
            generation: polled_on,
        })
    }
}

fn unwrap_js_string(raw: String) -> String {
    serde_json::from_str::<String>(&raw).unwrap_or(raw)
}

fn async_eval_start_script(request_id: &str, expression: &str) -> String {
    let request_id = serde_json::to_string(request_id).expect("request id is serializable");
    format!(
        "(()=>{{const id={request_id};const results=window.__cogniaAgentDebugAsyncResults||(window.__cogniaAgentDebugAsyncResults=Object.create(null));const now=Date.now();for(const [key,result] of Object.entries(results)){{if(now-Number(result.startedAt||now)>30000)delete results[key]}}const keys=Object.keys(results).sort((left,right)=>Number(results[left].startedAt||0)-Number(results[right].startedAt||0));while(keys.length>=100)delete results[keys.shift()];results[id]={{status:\"pending\",startedAt:now}};Promise.resolve().then(async()=>{{try{{results[id]={{status:\"fulfilled\",startedAt:now,value:await ({expression})}}}}catch(error){{results[id]={{status:\"rejected\",startedAt:now,error:String((error&&(error.stack||error.message))||error)}}}}}});return JSON.stringify({{status:\"started\"}})}})()"
    )
}

fn async_eval_poll_script(request_id: &str) -> String {
    let request_id = serde_json::to_string(request_id).expect("request id is serializable");
    format!(
        "(()=>{{const id={request_id};const results=window.__cogniaAgentDebugAsyncResults;const result=results&&results[id];if(!result)return JSON.stringify({{status:\"missing\"}});if(result.status===\"pending\")return JSON.stringify(result);delete results[id];return JSON.stringify(result)}})()"
    )
}

fn async_eval_cleanup_script(request_id: &str) -> String {
    let request_id = serde_json::to_string(request_id).expect("request id is serializable");
    format!(
        "(()=>{{const results=window.__cogniaAgentDebugAsyncResults;if(results)delete results[{request_id}];return JSON.stringify({{status:\"cleaned\"}})}})()"
    )
}

async fn cleanup_async_eval(webview: &Webview, lifecycle: &RendererLifecycle, request_id: &str) {
    let _ = eval_json(webview, lifecycle, &async_eval_cleanup_script(request_id)).await;
}

async fn eval_json_async(
    webview: &Webview,
    lifecycle: &RendererLifecycle,
    expression: &str,
) -> Result<Value, EvalError> {
    eval_json_async_with_timeout(webview, lifecycle, expression, EVAL_TIMEOUT).await
}

async fn eval_json_async_with_timeout(
    webview: &Webview,
    lifecycle: &RendererLifecycle,
    expression: &str,
    timeout: Duration,
) -> Result<Value, EvalError> {
    let label = webview.label().to_string();
    let request_id = uuid::Uuid::new_v4().simple().to_string();
    let (start, started_on) = eval_json_on_renderer(
        webview,
        lifecycle,
        &async_eval_start_script(&request_id, expression),
    )
    .await?;
    if start["status"] != "started" {
        return Err("webview async evaluation did not start".to_string().into());
    }
    // The pending promise lives in the realm of generation `started_on`; any
    // later renderer cannot hold its result.

    let deadline = std::time::Instant::now() + timeout;
    loop {
        if std::time::Instant::now() >= deadline {
            cleanup_async_eval(webview, lifecycle, &request_id).await;
            return Err("webview async evaluation timed out".to_string().into());
        }
        let result =
            match eval_json_on_renderer(webview, lifecycle, &async_eval_poll_script(&request_id))
                .await
            {
                Ok((result, generation)) => {
                    check_poll_renderer(&label, started_on, generation)?;
                    result
                }
                Err(error @ EvalError::RendererRestarted { .. })
                | Err(error @ EvalError::RendererRestarting { .. }) => return Err(error),
                Err(error) => {
                    cleanup_async_eval(webview, lifecycle, &request_id).await;
                    return Err(error);
                }
            };
        match result["status"].as_str() {
            Some("pending") => tokio::time::sleep(Duration::from_millis(25)).await,
            Some("fulfilled") => {
                let raw = result["value"].as_str().ok_or_else(|| {
                    EvalError::Failed(
                        "webview async evaluation returned a non-string result".to_string(),
                    )
                })?;
                return serde_json::from_str(raw).map_err(|error| {
                    EvalError::Failed(format!(
                        "invalid JSON from async webview evaluation: {error}"
                    ))
                });
            }
            Some("rejected") => {
                return Err(EvalError::Failed(format!(
                    "webview async evaluation rejected: {}",
                    result["error"]
                        .as_str()
                        .unwrap_or("webview async evaluation failed")
                )));
            }
            Some("missing") => {
                check_poll_renderer(&label, started_on, lifecycle.state(&label).generation)?;
                return Err("webview async evaluation result disappeared"
                    .to_string()
                    .into());
            }
            _ => {
                return Err("webview async evaluation returned an invalid state"
                    .to_string()
                    .into())
            }
        }
    }
}

fn validate_ref(reference: &str) -> Result<(), (StatusCode, Json<Value>)> {
    let Some((generation, element)) = reference
        .strip_prefix('g')
        .and_then(|value| value.split_once('e'))
    else {
        return Err(bad_request(
            "invalid_ref",
            "element ref must match g<generation>e<element>",
        ));
    };
    if generation.parse::<u64>().is_err() || element.parse::<u64>().is_err() {
        return Err(bad_request(
            "invalid_ref",
            "element ref must match g<generation>e<element>",
        ));
    }
    Ok(())
}

fn validate_action(action: &str) -> Result<(), (StatusCode, Json<Value>)> {
    const ACTIONS: &[&str] = &[
        "click",
        "dblclick",
        "focus",
        "blur",
        "hover",
        "fill",
        "type",
        "press",
        "check",
        "uncheck",
        "select",
        "scrollIntoView",
        "dispatchEvent",
        "dragTo",
        "setInputFiles",
    ];
    if ACTIONS.contains(&action) {
        Ok(())
    } else {
        Err(bad_request(
            "unsupported_action",
            format!("unsupported action: {action}"),
        ))
    }
}

fn validate_inspection(operation: &str) -> Result<(), (StatusCode, Json<Value>)> {
    const OPERATIONS: [&str; 8] = [
        "textContent",
        "innerText",
        "innerHTML",
        "inputValue",
        "getAttribute",
        "boundingBox",
        "getComputedStyle",
        "evaluate",
    ];
    if OPERATIONS.contains(&operation) {
        Ok(())
    } else {
        Err(bad_request(
            "unsupported_inspection",
            format!("unsupported inspection: {operation}"),
        ))
    }
}

fn logical_region(
    physical_x: i32,
    physical_y: i32,
    physical_width: u32,
    physical_height: u32,
    scale: f64,
) -> Result<crate::automation::types::Rect, (StatusCode, Json<Value>)> {
    if !scale.is_finite() || scale <= 0.0 || physical_width == 0 || physical_height == 0 {
        return Err(bad_request(
            "invalid_window_bounds",
            "window bounds are invalid",
        ));
    }
    Ok(crate::automation::types::Rect {
        x: (f64::from(physical_x) / scale).round() as i32,
        y: (f64::from(physical_y) / scale).round() as i32,
        width: (f64::from(physical_width) / scale).round() as i32,
        height: (f64::from(physical_height) / scale).round() as i32,
    })
}

fn read_log_tail(dir: PathBuf, line_limit: usize) -> Result<Vec<Value>, String> {
    let mut files = std::fs::read_dir(&dir)
        .map_err(|error| format!("unable to read {}: {error}", dir.display()))?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "log"))
        .collect::<Vec<_>>();
    files.sort_by_key(|entry| {
        std::cmp::Reverse(entry.metadata().and_then(|meta| meta.modified()).ok())
    });
    let mut remaining = line_limit;
    let mut chunks = Vec::new();
    for entry in files.into_iter().take(8) {
        if remaining == 0 {
            break;
        }
        let path = entry.path();
        let content = std::fs::read_to_string(&path)
            .map_err(|error| format!("unable to read {}: {error}", path.display()))?;
        let selected = content
            .lines()
            .rev()
            .take(remaining)
            .map(str::to_owned)
            .collect::<Vec<_>>();
        remaining = remaining.saturating_sub(selected.len());
        chunks.push((path, selected));
    }
    chunks.reverse();
    let mut result = Vec::new();
    for (path, lines) in chunks {
        for line in lines.into_iter().rev() {
            result.push(json!({ "source": path, "text": line }));
        }
    }
    Ok(result)
}

fn bad_request(code: &str, message: impl Into<String>) -> (StatusCode, Json<Value>) {
    api_error(StatusCode::BAD_REQUEST, code, message)
}

fn not_found(code: &str, message: impl Into<String>) -> (StatusCode, Json<Value>) {
    api_error(StatusCode::NOT_FOUND, code, message)
}

fn internal_error(error: impl std::fmt::Display) -> (StatusCode, Json<Value>) {
    api_error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "internal_error",
        error.to_string(),
    )
}

fn eval_error(error: EvalError) -> (StatusCode, Json<Value>) {
    let message = error.to_string();
    let (code, window, generation) = match &error {
        EvalError::RendererRestarted { window, generation } => {
            ("webview_renderer_restarted", window, *generation)
        }
        EvalError::RendererRestarting { window, generation } => {
            ("webview_renderer_restarting", window, *generation)
        }
        EvalError::Failed(error) => {
            return api_error(
                StatusCode::UNPROCESSABLE_ENTITY,
                classify_eval_failure(error),
                message,
            )
        }
    };
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({
            "ok": false,
            "code": code,
            "error": message,
            "window": window,
            "rendererGeneration": generation,
            "retryable": true,
        })),
    )
}

fn classify_eval_failure(error: &str) -> &'static str {
    if error == "webview async evaluation timed out" || error == "webview evaluation timed out" {
        "webview_eval_timeout"
    } else if error.starts_with("webview async evaluation rejected:") {
        "webview_eval_rejected"
    } else if error == "webview async evaluation result disappeared" {
        "webview_eval_missing"
    } else if error == "webview evaluation channel closed" {
        "webview_eval_cancelled"
    } else if error.contains("invalid JSON")
        || error.contains("non-string result")
        || error.contains("invalid state")
        || error.contains("exceeds the 2 MiB limit")
    {
        "webview_eval_malformed"
    } else {
        "webview_eval_failed"
    }
}

fn api_error(
    status: StatusCode,
    code: &str,
    message: impl Into<String>,
) -> (StatusCode, Json<Value>) {
    (
        status,
        Json(json!({ "ok": false, "code": code, "error": message.into() })),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const AGENT_ROUTES: [&str; 14] = [
        "/api/dev/agent/health",
        "/api/dev/agent/windows",
        "/api/dev/agent/snapshot",
        "/api/dev/agent/act",
        "/api/dev/agent/inspect",
        "/api/dev/agent/locator",
        "/api/dev/agent/evaluate",
        "/api/dev/agent/console",
        "/api/dev/agent/network",
        "/api/dev/agent/navigate",
        "/api/dev/agent/reload",
        "/api/dev/agent/screenshot",
        "/api/dev/agent/logs",
        "/api/dev/agent/shutdown",
    ];

    #[test]
    fn route_catalog_matches_feature_router() {
        let source = include_str!("agent_debug.rs");
        let router_source = source.split("#[cfg(test)]").next().unwrap();
        assert_eq!(router_source.matches(".route(").count(), AGENT_ROUTES.len());
        for route in AGENT_ROUTES {
            assert_eq!(router_source.matches(&format!("\"{route}\"")).count(), 1);
        }
    }

    #[test]
    fn validates_generation_scoped_refs() {
        assert!(validate_ref("g1e42").is_ok());
        assert!(validate_ref("e1").is_err());
        assert!(validate_ref("gxe1").is_err());
    }

    #[test]
    fn validates_supported_actions_and_rejects_unknown_ones() {
        for action in [
            "click",
            "dblclick",
            "focus",
            "blur",
            "hover",
            "fill",
            "type",
            "press",
            "check",
            "uncheck",
            "select",
            "scrollIntoView",
            "dispatchEvent",
            "dragTo",
            "setInputFiles",
        ] {
            assert!(
                validate_action(action).is_ok(),
                "action {action} should be supported"
            );
        }
        assert!(validate_action("remove").is_err());
    }

    #[test]
    fn rejects_unknown_inspections() {
        assert!(validate_inspection("innerHTML").is_ok());
        assert!(validate_inspection("remove").is_err());
    }

    #[test]
    fn converts_physical_window_bounds_to_logical_coordinates() {
        let rect = logical_region(200, 100, 1600, 1200, 2.0).unwrap();
        assert_eq!(
            rect,
            crate::automation::types::Rect {
                x: 100,
                y: 50,
                width: 800,
                height: 600
            }
        );
        assert!(logical_region(0, 0, 0, 100, 1.0).is_err());
    }

    #[test]
    fn recenters_only_offscreen_window_screenshot_failures() {
        use crate::automation::types::AutomationError;

        assert!(screenshot_needs_recenter(&AutomationError::BackendError {
            message: "capture region falls outside every monitor".into(),
        }));
        assert!(!screenshot_needs_recenter(&AutomationError::BackendError {
            message: "monitor capture failed".into(),
        }));
    }

    #[test]
    fn unwraps_wry_string_results_once() {
        assert_eq!(
            unwrap_js_string("\"{\\\"ok\\\":true}\"".to_string()),
            "{\"ok\":true}"
        );
        assert_eq!(unwrap_js_string("true".to_string()), "true");
    }

    #[test]
    fn async_eval_scripts_start_and_collect_promise_results() {
        let start = async_eval_start_script("request-1", "work()");
        assert!(start.contains("Promise.resolve"));
        assert!(start.contains("await (work())"));
        assert!(start.contains("request-1"));

        let poll = async_eval_poll_script("request-1");
        assert!(poll.contains("delete results[id]"));
        assert!(poll.contains("request-1"));

        assert!(start.contains("keys.length>=100"));
        assert!(start.contains("startedAt"));
        let cleanup = async_eval_cleanup_script("request-1");
        assert!(cleanup.contains("delete results"));
        assert!(cleanup.contains("request-1"));
    }

    #[test]
    fn injected_helper_is_versioned_and_non_invasive() {
        assert!(INJECTED_SCRIPT.contains("__cogniaAgentDebug"));
        assert!(INJECTED_SCRIPT.contains("snapshot"));
        assert!(INJECTED_SCRIPT.contains("capabilities"));
        assert!(!INJECTED_SCRIPT.contains("setInterval ="));
        assert!(!INJECTED_SCRIPT.contains("requestAnimationFrame ="));
    }

    #[test]
    fn classifies_evaluation_failures_with_stable_codes() {
        let (status, Json(timeout)) =
            eval_error("webview async evaluation timed out".to_string().into());
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(timeout["code"], "webview_eval_timeout");
        let (_, Json(rejected)) =
            eval_error("webview async evaluation rejected: boom".to_string().into());
        assert_eq!(rejected["code"], "webview_eval_rejected");
        let (_, Json(missing)) = eval_error(
            "webview async evaluation result disappeared"
                .to_string()
                .into(),
        );
        assert_eq!(missing["code"], "webview_eval_missing");
        let (_, Json(cancelled)) =
            eval_error("webview evaluation channel closed".to_string().into());
        assert_eq!(cancelled["code"], "webview_eval_cancelled");
        let (_, Json(malformed)) = eval_error("invalid JSON from webview: EOF".to_string().into());
        assert_eq!(malformed["code"], "webview_eval_malformed");
    }

    #[test]
    fn renderer_restarts_report_window_generation_and_retryability() {
        let (status, Json(restarted)) = eval_error(EvalError::RendererRestarted {
            window: "main".into(),
            generation: 2,
        });
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(restarted["code"], "webview_renderer_restarted");
        assert_eq!(restarted["window"], "main");
        assert_eq!(restarted["rendererGeneration"], 2);
        assert_eq!(restarted["retryable"], true);
        assert!(restarted["error"]
            .as_str()
            .unwrap()
            .starts_with("webview renderer restarted"));

        let (status, Json(restarting)) = eval_error(EvalError::RendererRestarting {
            window: "main".into(),
            generation: 3,
        });
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(restarting["code"], "webview_renderer_restarting");
        assert_eq!(restarting["rendererGeneration"], 3);
    }

    fn sent(value: &str) -> EvalAnswer {
        Some(Ok(Ok(value.to_string())))
    }

    #[test]
    fn classifies_answers_from_a_live_renderer() {
        assert_eq!(
            classify_eval_answer(sent("\"{}\""), "main", 0, 0),
            Ok("\"{}\"".to_string())
        );
        // An empty completion from a live renderer keeps its old meaning (the
        // caller reports it as malformed JSON), not a restart.
        assert_eq!(
            classify_eval_answer(sent(""), "main", 1, 1),
            Ok(String::new())
        );
    }

    #[test]
    fn a_real_answer_wins_even_if_the_renderer_died_right_after() {
        assert_eq!(
            classify_eval_answer(sent("true"), "main", 0, 1),
            Ok("true".to_string())
        );
    }

    #[test]
    fn non_answers_around_a_termination_report_a_restart() {
        let restarted = Err(EvalError::RendererRestarted {
            window: "main".into(),
            generation: 1,
        });
        assert_eq!(classify_eval_answer(None, "main", 0, 1), restarted);
        assert_eq!(classify_eval_answer(sent(""), "main", 0, 1), restarted);
    }

    #[tokio::test]
    async fn timeouts_and_dropped_callbacks_without_a_termination_keep_their_codes() {
        let lifecycle = RendererLifecycle::new();
        let (_keep_sender_alive, rx) = tokio::sync::oneshot::channel::<String>();
        let timed_out =
            await_eval_answer(rx, &lifecycle, "main", 0, Duration::from_millis(20)).await;
        assert_eq!(
            timed_out,
            Err(EvalError::Failed("webview evaluation timed out".into()))
        );

        let (tx, rx) = tokio::sync::oneshot::channel::<String>();
        drop(tx);
        let closed = await_eval_answer(rx, &lifecycle, "main", 0, Duration::from_secs(5)).await;
        assert_eq!(
            closed,
            Err(EvalError::Failed(
                "webview evaluation channel closed".into()
            ))
        );
    }

    #[tokio::test]
    async fn a_termination_mid_evaluation_fails_fast_as_restarted() {
        let lifecycle = RendererLifecycle::new();
        // The dead renderer never answers: keep the sender alive and silent.
        let (_silent_sender, rx) = tokio::sync::oneshot::channel::<String>();
        let pending = {
            let lifecycle = lifecycle.clone();
            tokio::spawn(async move {
                await_eval_answer(rx, &lifecycle, "main", 0, Duration::from_secs(30)).await
            })
        };
        tokio::task::yield_now().await;
        lifecycle.record_termination("main", std::time::Instant::now());

        let result = tokio::time::timeout(Duration::from_secs(2), pending)
            .await
            .expect("must not wait for the 30 s evaluation timeout")
            .unwrap();
        assert_eq!(
            result,
            Err(EvalError::RendererRestarted {
                window: "main".into(),
                generation: 1
            })
        );
    }

    #[tokio::test]
    async fn another_webviews_termination_does_not_interrupt_an_evaluation() {
        let lifecycle = RendererLifecycle::new();
        let (tx, rx) = tokio::sync::oneshot::channel::<String>();
        let pending = {
            let lifecycle = lifecycle.clone();
            tokio::spawn(async move {
                await_eval_answer(rx, &lifecycle, "main", 0, Duration::from_secs(5)).await
            })
        };
        tokio::task::yield_now().await;
        lifecycle.record_termination("pet", std::time::Instant::now());
        tx.send("1".into()).unwrap();
        assert_eq!(pending.await.unwrap(), Ok("1".to_string()));
    }

    #[tokio::test]
    async fn rebinds_to_the_replacement_renderer_once_it_loads() {
        let lifecycle = RendererLifecycle::new();
        lifecycle.record_termination("main", std::time::Instant::now());
        let binding = {
            let lifecycle = lifecycle.clone();
            tokio::spawn(
                async move { bind_renderer(&lifecycle, "main", Duration::from_secs(5)).await },
            )
        };
        tokio::task::yield_now().await;
        lifecycle.record_page_load("main");

        let renderer = binding.await.unwrap().expect("rebinds after reload");
        assert_eq!(renderer.generation, 1);
        assert!(!renderer.awaiting_load);

        // The next evaluation is tied to the new generation: its answer is
        // accepted, and only a further termination interrupts it.
        let (tx, rx) = tokio::sync::oneshot::channel::<String>();
        tx.send("\"ok\"".into()).unwrap();
        assert_eq!(
            await_eval_answer(rx, &lifecycle, "main", renderer.generation, EVAL_TIMEOUT).await,
            Ok("\"ok\"".to_string())
        );
    }

    #[tokio::test]
    async fn reports_restarting_while_the_replacement_never_loads() {
        let lifecycle = RendererLifecycle::new();
        lifecycle.record_termination("main", std::time::Instant::now());
        assert_eq!(
            bind_renderer(&lifecycle, "main", Duration::from_millis(20)).await,
            Err(EvalError::RendererRestarting {
                window: "main".into(),
                generation: 1
            })
        );
    }

    #[test]
    fn async_polls_answered_by_a_new_renderer_report_a_restart() {
        assert_eq!(check_poll_renderer("main", 2, 2), Ok(()));
        assert_eq!(
            check_poll_renderer("main", 2, 3),
            Err(EvalError::RendererRestarted {
                window: "main".into(),
                generation: 3
            })
        );
    }

    #[test]
    fn untracked_lifecycle_fallback_reports_no_restarts() {
        let lifecycle = RendererLifecycle::default();
        assert_eq!(lifecycle.state(DEFAULT_WINDOW).generation, 0);
        assert!(!lifecycle.state(DEFAULT_WINDOW).awaiting_load);
    }

    #[test]
    fn reads_bounded_log_tail_in_chronological_order() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cognia.log");
        std::fs::write(&path, "one\ntwo\nthree\nfour\n").unwrap();
        let rows = read_log_tail(dir.path().to_path_buf(), 2).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["text"], "three");
        assert_eq!(rows[1]["text"], "four");
    }
}

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

const INJECTED_SCRIPT: &str = include_str!("agent_debug/injected.js");
const MAX_EXPRESSION_BYTES: usize = 64 * 1024;
const MAX_RESULT_BYTES: usize = 2 * 1024 * 1024;
const DEFAULT_WINDOW: &str = "main";
const DEFAULT_LOG_LINES: usize = 400;
const MAX_LOG_LINES: usize = 5_000;

type ApiResult = Result<Json<Value>, (StatusCode, Json<Value>)>;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowQuery {
    #[serde(default = "default_window")]
    window: String,
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

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/api/dev/agent/health", get(health))
        .route("/api/dev/agent/windows", get(windows))
        .route("/api/dev/agent/snapshot", post(snapshot))
        .route("/api/dev/agent/act", post(act))
        .route("/api/dev/agent/inspect", post(inspect))
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
    if let Err(error) = webview.eval(INJECTED_SCRIPT) {
        log::warn!(
            "agent_debug helper injection failed for {}: {error}",
            webview.label()
        );
    }
}

async fn health(State(state): State<SharedState>) -> ApiResult {
    let app = &state.app_handle;
    let helper = match app.get_webview(DEFAULT_WINDOW) {
        Some(webview) => eval_json(
            &webview,
            "JSON.stringify(window.__cogniaAgentDebug.health())",
        )
        .await
        .ok(),
        None => None,
    };
    Ok(Json(json!({
        "ok": true,
        "agentDebug": true,
        "pid": std::process::id(),
        "version": app.package_info().version.to_string(),
        "platform": std::env::consts::OS,
        "helper": helper,
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
    let value = eval_json(&webview, &script).await.map_err(eval_error)?;
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
    let value = eval_json_async(&webview, &script)
        .await
        .map_err(eval_error)?;
    Ok(Json(json!({
        "ok": true,
        "window": request.window,
        "value": value,
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
    let value = eval_json_async(&webview, &script)
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
    let value = eval_json_async(&webview, &script)
        .await
        .map_err(eval_error)?;
    Ok(Json(
        json!({ "ok": true, "window": request.window, "value": value }),
    ))
}

async fn console(State(state): State<SharedState>, Query(query): Query<WindowQuery>) -> ApiResult {
    drain(&state.app_handle, &query.window, "drainConsole", "console").await
}

async fn network(State(state): State<SharedState>, Query(query): Query<WindowQuery>) -> ApiResult {
    drain(&state.app_handle, &query.window, "drainNetwork", "network").await
}

async fn drain(app: &AppHandle, label: &str, method: &str, key: &str) -> ApiResult {
    let webview = resolve_webview(app, label)?;
    let script = format!("JSON.stringify(window.__cogniaAgentDebug.{method}())");
    let value = eval_json(&webview, &script).await.map_err(eval_error)?;
    Ok(Json(json!({ "ok": true, "window": label, (key): value })))
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

async fn eval_json(webview: &Webview, script: &str) -> Result<Value, String> {
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
        .map_err(|error| error.to_string())?;
    let raw = match tokio::time::timeout(Duration::from_secs(10), rx).await {
        Ok(Ok(value)) => value,
        Ok(Err(_)) => return Err("webview evaluation channel closed".to_string()),
        Err(_) => return Err("webview evaluation timed out".to_string()),
    };
    let unwrapped = unwrap_js_string(raw);
    if unwrapped.len() > MAX_RESULT_BYTES {
        return Err("webview evaluation result exceeds the 2 MiB limit".to_string());
    }
    serde_json::from_str(&unwrapped).map_err(|error| format!("invalid JSON from webview: {error}"))
}

fn unwrap_js_string(raw: String) -> String {
    serde_json::from_str::<String>(&raw).unwrap_or(raw)
}

fn async_eval_start_script(request_id: &str, expression: &str) -> String {
    let request_id = serde_json::to_string(request_id).expect("request id is serializable");
    format!(
        "(()=>{{const id={request_id};const results=window.__cogniaAgentDebugAsyncResults||(window.__cogniaAgentDebugAsyncResults=Object.create(null));results[id]={{status:\"pending\"}};Promise.resolve().then(async()=>{{try{{results[id]={{status:\"fulfilled\",value:await ({expression})}}}}catch(error){{results[id]={{status:\"rejected\",error:String((error&&(error.stack||error.message))||error)}}}}}});return JSON.stringify({{status:\"started\"}})}})()"
    )
}

fn async_eval_poll_script(request_id: &str) -> String {
    let request_id = serde_json::to_string(request_id).expect("request id is serializable");
    format!(
        "(()=>{{const id={request_id};const results=window.__cogniaAgentDebugAsyncResults;const result=results&&results[id];if(!result)return JSON.stringify({{status:\"missing\"}});if(result.status===\"pending\")return JSON.stringify(result);delete results[id];return JSON.stringify(result)}})()"
    )
}

async fn eval_json_async(webview: &Webview, expression: &str) -> Result<Value, String> {
    let request_id = uuid::Uuid::new_v4().simple().to_string();
    let start = eval_json(webview, &async_eval_start_script(&request_id, expression)).await?;
    if start["status"] != "started" {
        return Err("webview async evaluation did not start".to_string());
    }

    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        if std::time::Instant::now() >= deadline {
            return Err("webview async evaluation timed out".to_string());
        }
        let result = eval_json(webview, &async_eval_poll_script(&request_id)).await?;
        match result["status"].as_str() {
            Some("pending") => tokio::time::sleep(Duration::from_millis(25)).await,
            Some("fulfilled") => {
                let raw = result["value"].as_str().ok_or_else(|| {
                    "webview async evaluation returned a non-string result".to_string()
                })?;
                return serde_json::from_str(raw).map_err(|error| {
                    format!("invalid JSON from async webview evaluation: {error}")
                });
            }
            Some("rejected") => {
                return Err(result["error"]
                    .as_str()
                    .unwrap_or("webview async evaluation failed")
                    .to_string());
            }
            Some("missing") => {
                return Err("webview async evaluation result disappeared".to_string());
            }
            _ => return Err("webview async evaluation returned an invalid state".to_string()),
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

fn eval_error(error: String) -> (StatusCode, Json<Value>) {
    api_error(
        StatusCode::UNPROCESSABLE_ENTITY,
        "webview_eval_failed",
        error,
    )
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

    const AGENT_ROUTES: [&str; 13] = [
        "/api/dev/agent/health",
        "/api/dev/agent/windows",
        "/api/dev/agent/snapshot",
        "/api/dev/agent/act",
        "/api/dev/agent/inspect",
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

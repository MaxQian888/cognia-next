//! Feature-gated, loopback-only debug surface for agents driving the real
//! Tauri webviews. Transport and authentication are owned by `cli_bridge`;
//! this module contributes routes only when the `agent-debug` Cargo feature is
//! explicitly enabled.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use axum::{
    extract::{Json, Path, Query, State},
    http::StatusCode,
    routing::{get, post},
    Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Webview, WebviewWindow};

pub(crate) mod sessions;
use axum::Extension;
use sessions::{Admission, Context as ClientContext, Identity};

use crate::cli_bridge::SharedState;
use crate::webview_watchdog::{RendererLifecycle, RendererState};

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

/// The launcher's identity survives `tauri dev` rebuilds; this process identity
/// does not. Keep credentials separate from this non-secret ownership record.
pub fn session_identity() -> &'static Value {
    static IDENTITY: OnceLock<Value> = OnceLock::new();
    IDENTITY.get_or_init(|| {
        debug_session_identity(
            std::env::var("COGNIA_AGENT_DEBUG_SESSION_ID").ok(),
            std::env::var("COGNIA_AGENT_DEBUG_WORKSPACE").ok(),
            uuid::Uuid::new_v4().to_string(),
            std::process::id(),
        )
    })
}

fn debug_session_identity(
    session_id: Option<String>,
    workspace: Option<String>,
    instance: String,
    pid: u32,
) -> Value {
    json!({ "sessionId": session_id, "workspace": workspace, "appInstanceId": instance, "pid": pid })
}

pub fn managed_endpoint_file() -> Option<PathBuf> {
    std::env::var_os("COGNIA_AGENT_DEBUG_ENDPOINT_FILE")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
}

/// Why a webview evaluation failed. Renderer lifecycle failures are typed so
/// the HTTP payload can carry the window and renderer generation.
#[derive(Debug, Clone, PartialEq, Eq)]
enum EvalError {
    /// A bridge/evaluation failure, classified by message in [`eval_error`].
    Failed(String),
    /// The async helper reported a settled rejection, not a lost callback.
    Rejected(String),
    Session(sessions::Fault),
    /// The renderer this evaluation was sent to terminated (WKWebView web
    /// content process died) before answering. Its realm, helper state, and
    /// element refs are gone; the webview is reloading into a new renderer.
    RendererRestarted {
        window: String,
        generation: u64,
    },
    /// A terminated renderer's replacement has not committed a document yet.
    RendererRestarting {
        window: String,
        generation: u64,
    },
    DocumentReplaced {
        window: String,
        document_epoch: u64,
    },
    DocumentLoading {
        window: String,
        document_epoch: u64,
    },
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
            Self::Session((code, message)) => write!(formatter, "{code}: {message}"),
            Self::Rejected(message) => write!(formatter, "webview async evaluation rejected: {message}"),
            Self::RendererRestarted { window, generation } => write!(
                formatter,
                "webview renderer restarted: the {window} web content process terminated before answering (renderer generation {generation}); inspect persisted and external effects before retrying a mutation"
            ),
            Self::RendererRestarting { window, generation } => write!(
                formatter,
                "webview renderer is restarting: the {window} web content process terminated (renderer generation {generation}) and its replacement has not loaded a document yet"
            ),
            Self::DocumentReplaced { window, document_epoch } => write!(
                formatter,
                "webview document replaced in {window} (document epoch {document_epoch}); inspect persisted and external effects before retrying a mutation"
            ),
            Self::DocumentLoading { window, document_epoch } => write!(
                formatter, "webview document is loading in {window} (document epoch {document_epoch})"
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
    document_id: Option<String>,
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
    request_id: Option<String>,
    expires_at: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EvaluateRequest {
    #[serde(default = "default_window")]
    window: String,
    expression: String,
    timeout: Option<u64>,
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
        .route(
            "/api/dev/agent/sessions",
            post(open_client).get(list_clients),
        )
        .route(
            "/api/dev/agent/sessions/{id}",
            axum::routing::delete(revoke_client),
        )
        .route("/api/dev/agent/recover", post(recover_clients))
        .route(
            "/api/dev/agent/session",
            get(client_status).delete(detach_client),
        )
        .route("/api/dev/agent/lease", post(writer_lease))
        .route("/api/dev/agent/helper", post(helper))
}

fn session_error((code, message): sessions::Fault) -> (StatusCode, Json<Value>) {
    let status = if matches!(
        code,
        "window_scope_denied" | "write_scope_denied" | "client_session_required"
    ) {
        StatusCode::FORBIDDEN
    } else {
        StatusCode::CONFLICT
    };
    api_error(status, code, message)
}
fn authorize_client(
    context: &ClientContext,
    window: &str,
) -> Result<(), (StatusCode, Json<Value>)> {
    if sessions::shared() {
        sessions::manager()
            .authorize(context, window)
            .map_err(session_error)
    } else {
        Ok(())
    }
}
/// Observers reuse session authorization on both sides of every async boundary.
async fn observe_client<T>(
    context: &ClientContext,
    window: &str,
    read: impl std::future::Future<Output = T>,
) -> Result<T, (StatusCode, Json<Value>)> {
    if sessions::shared() && matches!(context.identity, Identity::Client(_)) {
        sessions::manager()
            .observe(context, window, read)
            .await
            .map_err(session_error)
    } else {
        Ok(read.await)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenClient {
    windows: Vec<String>,
    #[serde(default)]
    can_write: bool,
    idle_timeout_ms: Option<u64>,
}
async fn open_client(
    State(state): State<SharedState>,
    Extension(context): Extension<ClientContext>,
    Json(request): Json<OpenClient>,
) -> ApiResult {
    if !sessions::shared() {
        return Err(bad_request(
            "shared_mode_required",
            "launch with --shared to attach client sessions",
        ));
    }
    if !matches!(context.identity, Identity::Owner) {
        return Err(bad_request(
            "owner_required",
            "only the launcher owner may issue sessions",
        ));
    }
    for window in &request.windows {
        resolve_webview(&state.app_handle, window)?;
    }
    let mut value = sessions::manager()
        .open_with_timeout(request.windows, request.can_write, request.idle_timeout_ms)
        .map_err(session_error)?;
    value["debugSession"] = session_identity().clone();
    Ok(Json(json!({"ok":true, "session":value})))
}
/// Reuse the helper's session release on lazy native expiry as well as revoke.
/// A failed enqueue stays pending; a later authenticated request retries it.
pub(crate) fn flush_retired(app: &AppHandle) {
    let manager = sessions::manager();
    for id in manager.retired() {
        let encoded = serde_json::to_string(&id).expect("session ID is serializable");
        let script = format!("window.__cogniaAgentDebug?.releaseSession({encoded})");
        if app
            .webviews()
            .values()
            .all(|webview| webview.eval(&script).is_ok())
        {
            manager.retired_dispatched(&id);
        }
    }
}

async fn list_clients() -> ApiResult {
    Ok(Json(
        json!({"ok":true,"sessions":sessions::manager().list(),"control":sessions::manager().status()}),
    ))
}
async fn revoke_client(State(state): State<SharedState>, Path(id): Path<String>) -> ApiResult {
    let result = sessions::manager().revoke(&id);
    flush_retired(&state.app_handle);
    Ok(Json(json!({"ok":true,"result":result})))
}

/// Owner recovery retires every credential and replaces every renderer document.
/// A timeout/cancellation leaves admission quarantined; no old operation is replayed.
async fn recover_clients(State(state): State<SharedState>) -> ApiResult {
    if !sessions::shared() {
        return Err(bad_request(
            "shared_mode_required",
            "recovery requires shared mode",
        ));
    }
    let recovery = sessions::manager().recover().map_err(session_error)?;
    let lifecycle = renderer_lifecycle(&state.app_handle);
    let webviews = state.app_handle.webviews();
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    let mut previous = std::collections::HashMap::new();
    for (label, webview) in &webviews {
        let (health, incarnation) = eval_json_on_renderer_until(
            webview,
            &lifecycle,
            "JSON.stringify(window.__cogniaAgentDebug.health())",
            deadline,
        )
        .await
        .map_err(eval_error)?;
        if !same_incarnation(&incarnation, &lifecycle.state(label))
            || health["documentId"].as_str().is_none()
        {
            return Err(session_error((
                "recovery_unconfirmed",
                "old document identity is unconfirmed",
            )));
        }
        previous.insert(label.clone(), (incarnation, health["documentId"].clone()));
    }
    for webview in webviews.values() {
        webview.reload().map_err(internal_error)?;
    }
    let mut proven = Vec::new();
    for (label, webview) in &webviews {
        wait_navigation(
            webview,
            &lifecycle,
            previous[label].0.document_epoch,
            None,
            deadline,
        )
        .await?;
        let (health, incarnation) = eval_json_on_renderer_until(
            webview,
            &lifecycle,
            "JSON.stringify(window.__cogniaAgentDebug.health())",
            deadline,
        )
        .await
        .map_err(eval_error)?;
        if incarnation.document_epoch == previous[label].0.document_epoch
            || health["heldInput"].as_u64() != Some(0)
            || !replaced_document(&previous[label].1, &health["documentId"])
            || !same_incarnation(&incarnation, &lifecycle.state(label))
        {
            return Err(session_error((
                "recovery_unconfirmed",
                "renderer replacement or input cleanup is unconfirmed",
            )));
        }
        proven.push((label.clone(), incarnation, health["documentId"].clone()));
    }
    // Check the complete target set and every incarnation after the last await.
    let current = state.app_handle.webviews();
    if current.len() != webviews.len()
        || proven.iter().any(|(label, incarnation, _)| {
            !current.contains_key(label) || !same_incarnation(incarnation, &lifecycle.state(label))
        })
    {
        return Err(session_error((
            "recovery_unconfirmed",
            "window set or document changed during recovery",
        )));
    }
    recovery.finish().map_err(session_error)?;
    Ok(Json(
        json!({"ok":true,"pid":std::process::id(),"documents":proven.iter()
        .map(|(label,_,document)| json!({"window":label,"documentId":document})).collect::<Vec<_>>(),
        "control":sessions::manager().status()}),
    ))
}
fn replaced_document(previous: &Value, current: &Value) -> bool {
    previous.as_str().is_some_and(|old| !old.is_empty())
        && current
            .as_str()
            .is_some_and(|new| !new.is_empty() && previous != current)
}

fn same_incarnation(a: &RendererState, b: &RendererState) -> bool {
    a.generation == b.generation
        && a.document_epoch == b.document_epoch
        && !b.document_loading
        && !b.awaiting_load
}

async fn client_status(Extension(context): Extension<ClientContext>) -> ApiResult {
    context.client().map_err(session_error)?;
    Ok(Json(
        json!({"ok":true,"control":sessions::manager().status(),"lease":sessions::manager().owned_lease(&context).map_err(session_error)?}),
    ))
}
async fn detach_client(
    State(state): State<SharedState>,
    Extension(context): Extension<ClientContext>,
) -> ApiResult {
    let id = context.client().map_err(session_error)?.to_string();
    if let Some(lease) = sessions::manager()
        .owned_lease(&context)
        .map_err(session_error)?
    {
        release_writer(&state, &context, &lease.token, lease.fence).await?;
    }
    sessions::manager()
        .detach(&context)
        .map_err(session_error)?;
    let encoded = serde_json::to_string(&id).map_err(internal_error)?;
    for webview in state.app_handle.webviews().values() {
        let _ = webview.eval(format!(
            "window.__cogniaAgentDebug?.releaseSession({encoded})"
        ));
    }
    Ok(Json(json!({"ok":true})))
}
#[derive(Deserialize)]
struct LeaseRequest {
    operation: String,
    token: Option<String>,
    fence: Option<u64>,
}
async fn writer_lease(
    State(state): State<SharedState>,
    Extension(context): Extension<ClientContext>,
    Json(request): Json<LeaseRequest>,
) -> ApiResult {
    let manager = sessions::manager();
    let lease = match request.operation.as_str() {
        "acquire" => Some(manager.acquire(&context).map_err(session_error)?),
        "renew" => Some(
            manager
                .renew(
                    &context,
                    request.token.as_deref().unwrap_or_default(),
                    request.fence.unwrap_or_default(),
                )
                .map_err(session_error)?,
        ),
        "release" => {
            release_writer(
                &state,
                &context,
                request.token.as_deref().unwrap_or_default(),
                request.fence.unwrap_or_default(),
            )
            .await?;
            None
        }
        _ => {
            return Err(bad_request(
                "invalid_lease_operation",
                "expected acquire, renew or release",
            ))
        }
    };
    Ok(Json(json!({"ok":true,"lease":lease})))
}

async fn release_writer(
    state: &SharedState,
    context: &ClientContext,
    token: &str,
    fence: u64,
) -> Result<(), (StatusCode, Json<Value>)> {
    let manager = sessions::manager();
    let _drain = manager
        .drain(context, token, fence)
        .map_err(session_error)?;
    let mut cleanup = context.clone();
    cleanup.writer = Some(sessions::Writer {
        token: token.to_owned(),
        fence,
        operation_id: uuid::Uuid::new_v4().to_string(),
    });
    for label in manager.windows(context).map_err(session_error)? {
        if let Some(webview) = state.app_handle.get_webview(&label) {
            let lifecycle = renderer_lifecycle(&state.app_handle);
            let health = eval_json(
                &webview,
                &lifecycle,
                "JSON.stringify(window.__cogniaAgentDebug.health())",
            )
            .await
            .map_err(eval_error)?;
            if manager.input_dirty(&label) || health["heldInput"].as_u64().unwrap_or(0) > 0 {
                if let Some(writer) = cleanup.writer.as_mut() {
                    writer.operation_id = uuid::Uuid::new_v4().to_string();
                }
                execute_client(&webview, &lifecycle, &cleanup, json!({"helper":"releaseInput","window":label}), "(async()=>JSON.stringify(await window.__cogniaAgentDebug.helper('releaseInput',[],control)))()", EVAL_TIMEOUT, true).await?;
            }
        }
    }
    manager
        .release(context, token, fence)
        .map_err(session_error)?;
    Ok(())
}

/// One desktop adapter for existing eval/locator helpers. A dropped HTTP/native
/// future leaves admission quarantined rather than releasing an unknown writer.
async fn execute_client(
    webview: &Webview,
    lifecycle: &RendererLifecycle,
    context: &ClientContext,
    fingerprint: Value,
    expression: &str,
    timeout: Duration,
    mutation: bool,
) -> Result<Value, (StatusCode, Json<Value>)> {
    if !sessions::shared() {
        return eval_json_async_with_timeout(webview, lifecycle, expression, timeout, None)
            .await
            .map_err(eval_error);
    }
    authorize_client(context, webview.label())?;
    let timeout = timeout.min(Duration::from_millis(context.timeout_ms.unwrap_or(120_000)));
    let deadline = std::time::Instant::now() + timeout;
    let permit = if mutation {
        match sessions::manager()
            .begin(context, &fingerprint)
            .map_err(session_error)?
        {
            Admission::Cached(value) => return Ok(value),
            Admission::Execute(permit) => Some(permit),
        }
    } else {
        None
    };
    let document = match permit
        .as_ref()
        .and_then(|op| op.document.clone())
        .or_else(|| context.expected_document.clone())
    {
        Some(document) => document,
        None => eval_json_on_renderer_until_scoped(
            webview,
            lifecycle,
            "JSON.stringify(window.__cogniaAgentDebug.health().documentId)",
            deadline,
            Some(context),
        )
        .await
        .map_err(eval_error)?
        .0
        .as_str()
        .ok_or_else(|| internal_error("missing document identity"))?
        .to_owned(),
    };
    let document = serde_json::to_string(&document).map_err(internal_error)?;
    let client =
        serde_json::to_string(context.client().map_err(session_error)?).map_err(internal_error)?;
    let script = format!("(async()=>{{control.clientSessionId={client};control.guard=()=>{{if(control.cancelled||Date.now()>=control.expiresAt||window.__cogniaAgentDebug.health().documentId!=={document})throw new Error('debug operation cancelled or document replaced')}};control.guard();return await ({expression})}})()");
    let remaining = deadline.saturating_duration_since(std::time::Instant::now());
    if remaining.is_zero() {
        return Err(session_error((
            "deadline_exceeded",
            "operation deadline elapsed before dispatch",
        )));
    }
    if let Some(permit) = &permit {
        permit.validate().map_err(session_error)?;
    }
    authorize_client(context, webview.label())?;
    let evaluation =
        eval_json_async_with_timeout(webview, lifecycle, &script, remaining, Some(context));
    let result = if permit.is_none() {
        observe_client(context, webview.label(), evaluation).await?
    } else {
        evaluation.await
    };
    let mut value = result.map_err(eval_error)?;
    if let Some(permit) = permit {
        permit.finish(&mut value).map_err(session_error)?;
    }
    Ok(value)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HelperRequest {
    #[serde(default = "default_window")]
    window: String,
    method: String,
    #[serde(default)]
    args: Vec<Value>,
}
async fn helper(
    State(state): State<SharedState>,
    Extension(context): Extension<ClientContext>,
    Json(request): Json<HelperRequest>,
) -> ApiResult {
    authorize_client(&context, &request.window)?;
    const READS: &[&str] = &[
        "health",
        "url",
        "title",
        "content",
        "getDialogs",
        "getNetworkRequests",
    ];
    const WRITES: &[&str] = &["keyboard", "mouse", "historyBack", "historyForward"];
    let mutation = WRITES.contains(&request.method.as_str());
    if !mutation && !READS.contains(&request.method.as_str()) {
        return Err(bad_request(
            "unsupported_shared_helper",
            "helper is unavailable in shared mode",
        ));
    }
    let webview = resolve_webview(&state.app_handle, &request.window)?;
    let method = serde_json::to_string(&request.method).map_err(internal_error)?;
    let args = serde_json::to_string(&request.args).map_err(internal_error)?;
    let script = format!("(async()=>JSON.stringify(await window.__cogniaAgentDebug.helper({method},{args},control)))()");
    let lifecycle = renderer_lifecycle(&state.app_handle);
    if matches!(request.method.as_str(), "historyBack" | "historyForward") && sessions::shared() {
        authorize_client(&context, &request.window)?;
        let permit = match sessions::manager()
            .begin(
                &context,
                &json!({"helper":request.method,"window":request.window}),
            )
            .map_err(session_error)?
        {
            Admission::Cached(value) => return Ok(Json(json!({"ok":true,"value":value}))),
            Admission::Execute(op) => op,
        };
        let deadline = std::time::Instant::now()
            + EVAL_TIMEOUT.min(Duration::from_millis(context.timeout_ms.unwrap_or(120_000)));
        let before = eval_json(
            &webview,
            &lifecycle,
            "JSON.stringify(window.__cogniaAgentDebug.health())",
        )
        .await
        .map_err(eval_error)?;
        let previous = lifecycle.state(&request.window);
        let document = serde_json::to_string(
            &context
                .expected_document
                .clone()
                .unwrap_or_else(|| before["documentId"].as_str().unwrap_or_default().into()),
        )
        .map_err(internal_error)?;
        let expires_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(internal_error)?
            .as_millis()
            + deadline
                .saturating_duration_since(std::time::Instant::now())
                .as_millis();
        let direction = if request.method == "historyBack" {
            "back"
        } else {
            "forward"
        };
        permit.validate().map_err(session_error)?;
        webview.eval(format!("if(Date.now()<{expires_at}&&window.__cogniaAgentDebug.health().documentId==={document})history.{direction}()" )).map_err(internal_error)?;
        wait_navigation(
            &webview,
            &lifecycle,
            previous.document_epoch,
            before["url"].as_str(),
            deadline,
        )
        .await?;
        permit.finish(&mut json!(true)).map_err(session_error)?;
        return Ok(Json(json!({"ok":true,"value":true})));
    }
    let value = execute_client(
        &webview,
        &lifecycle,
        &context,
        json!({"helper":request.method,"args":request.args,"window":request.window}),
        &script,
        EVAL_TIMEOUT,
        mutation,
    )
    .await?;
    Ok(Json(json!({"ok":true,"value":value})))
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

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HealthQuery {
    #[serde(default)]
    native_only: bool,
    #[serde(default = "default_window")]
    window: String,
}

async fn health(
    State(state): State<SharedState>,
    Extension(context): Extension<ClientContext>,
    Query(query): Query<HealthQuery>,
) -> ApiResult {
    if sessions::shared() && matches!(context.identity, Identity::Client(_)) {
        authorize_client(&context, &query.window)?;
    }
    let app = &state.app_handle;
    let lifecycle = renderer_lifecycle(app);
    // Health must stay fast while a renderer is being replaced: report the
    // restart through `renderers` instead of blocking on the reload.
    let mut helper = match app.get_webview(&query.window) {
        Some(webview)
            if !query.native_only
                && !lifecycle.state(&query.window).awaiting_load
                && !lifecycle.state(&query.window).document_loading =>
        {
            observe_client(
                &context,
                &query.window,
                eval_json_on_renderer_until_scoped(
                    &webview,
                    &lifecycle,
                    "JSON.stringify(window.__cogniaAgentDebug.health())",
                    std::time::Instant::now() + EVAL_TIMEOUT,
                    Some(&context),
                ),
            )
            .await?
            .ok()
            .map(|(value, _)| value)
        }
        _ => None,
    };
    if sessions::shared() {
        if let Some(helper) = helper.as_mut() {
            helper["capabilities"]["clientSessions"] = json!(1);
            helper["capabilities"]["sessionScopedRefs"] = json!(1);
            helper["capabilities"]["appWriterLease"] = json!(1);
            helper["capabilities"]["networkMocking"] = json!(false);
            helper["capabilities"]["dialogs"] = json!(false);
        }
    }
    Ok(Json(json!({
        "ok": true,
        "agentDebug": true,
        "sharedMode": sessions::shared(),
        "pid": std::process::id(),
        "debugSession": session_identity(),
        "version": app.package_info().version.to_string(),
        "platform": std::env::consts::OS,
        "helper": helper,
        "renderers": lifecycle.snapshot(),
        "logDir": crate::logging::native_bootstrap::log_dir(),
    })))
}

async fn windows(
    State(state): State<SharedState>,
    Extension(context): Extension<ClientContext>,
) -> ApiResult {
    let scoped = sessions::shared() && matches!(context.identity, Identity::Client(_));
    let allowed = if scoped {
        Some(
            sessions::manager()
                .windows(&context)
                .map_err(session_error)?,
        )
    } else {
        None
    };
    let mut entries = Vec::new();
    let lifecycle = renderer_lifecycle(&state.app_handle);
    for (label, window) in state.app_handle.webview_windows() {
        if allowed
            .as_ref()
            .is_some_and(|windows| !windows.contains(&label))
        {
            continue;
        }
        let document_url = lifecycle.last_url(&label);
        // SPA routing does not produce native page-load events. Read the
        // current route through the guarded JS bridge when a document exists;
        // never ask Wry for the URL of a not-yet-loaded hidden webview.
        let current_url = if document_url.is_some() {
            observe_client(
                &context,
                &label,
                eval_json_on_renderer_until_scoped(
                    window.as_ref(),
                    &lifecycle,
                    "JSON.stringify(location.href)",
                    std::time::Instant::now() + Duration::from_millis(250),
                    Some(&context),
                ),
            )
            .await?
            .ok()
            .and_then(|(value, _)| value.as_str().map(str::to_owned))
        } else {
            None
        };
        entries.push(json!({
            "label": label,
            "url": current_url.or(document_url),
            "title": window.title().ok(),
            "visible": window.is_visible().ok(),
            "focused": window.is_focused().ok(),
        }));
    }
    if scoped {
        sessions::manager()
            .windows(&context)
            .map_err(session_error)?;
    }
    entries.sort_by(|left, right| left["label"].as_str().cmp(&right["label"].as_str()));
    Ok(Json(json!({ "ok": true, "windows": entries })))
}

async fn snapshot(
    State(state): State<SharedState>,
    Extension(context): Extension<ClientContext>,
    Json(request): Json<SnapshotRequest>,
) -> ApiResult {
    authorize_client(&context, &request.window)?;
    let webview = resolve_webview(&state.app_handle, &request.window)?;
    let options = serde_json::to_string(&json!({
        "includeText": request.include_text,
        "includeHidden": request.include_hidden,
        "selector": request.selector,
        "role": request.role,
        "name": request.name,
        "nameExact": request.name_exact,
        "query": request.query,
        "clientSessionId": if sessions::shared() { Some(context.client().map_err(session_error)?) } else { None },
    }))
    .map_err(internal_error)?;
    let capture = if sessions::shared() {
        Some(
            sessions::manager()
                .capture_snapshot(&context)
                .map_err(session_error)?,
        )
    } else {
        None
    };
    let before = capture
        .as_ref()
        .map(|capture| capture.before)
        .unwrap_or_else(|| sessions::manager().snapshot_start());
    let lifecycle = renderer_lifecycle(&state.app_handle);
    let deadline = std::time::Instant::now() + EVAL_TIMEOUT;
    let script = if let Some(active_capture) = &capture {
        let prepared = eval_json_on_renderer_until_scoped(
            &webview,
            &lifecycle,
            "JSON.stringify(window.__cogniaAgentDebug.health().documentId)",
            deadline,
            Some(&context),
        )
        .await;
        let (document, _) = match prepared {
            Ok(value) => value,
            Err(error) => {
                if let Some(capture) = capture {
                    capture.complete();
                }
                return Err(eval_error(error));
            }
        };
        active_capture.validate().map_err(session_error)?;
        let expires = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(internal_error)?
            .as_millis()
            + deadline
                .saturating_duration_since(std::time::Instant::now())
                .as_millis();
        format!("(()=>{{if(Date.now()>={expires}||window.__cogniaAgentDebug.health().documentId!=={document})throw new Error('snapshot document replaced or expired');return JSON.stringify(window.__cogniaAgentDebug.snapshot({options}))}})()")
    } else {
        format!("JSON.stringify(window.__cogniaAgentDebug.snapshot({options}))")
    };
    let evaluation = async {
        if sessions::shared() {
            eval_json_async_with_timeout(
                &webview,
                &lifecycle,
                &script,
                deadline.saturating_duration_since(std::time::Instant::now()),
                Some(&context),
            )
            .await
        } else {
            eval_json_on_renderer_until(&webview, &lifecycle, &script, deadline)
                .await
                .map(|(value, _)| value)
        }
    };
    let result = observe_client(&context, &request.window, evaluation).await?;
    let mut value = match result {
        Ok(value) => value,
        Err(error) => {
            settle_snapshot_error(capture, &error);
            return Err(eval_error(error));
        }
    };
    if sessions::shared() {
        sessions::manager()
            .record_snapshot(&context, &request.window, &mut value, before)
            .map_err(session_error)?;
    }
    if let Some(capture) = capture {
        capture.complete();
    }
    Ok(Json(
        json!({ "ok": true, "window": request.window, "snapshot": value }),
    ))
}

fn settle_snapshot_error(capture: Option<sessions::SnapshotCapture<'_>>, error: &EvalError) {
    // Only a settled renderer rejection proves this snapshot cannot change refs later.
    if matches!(error, EvalError::Rejected(_)) {
        if let Some(capture) = capture {
            capture.complete();
        }
    }
}

async fn inspect(
    State(state): State<SharedState>,
    Extension(context): Extension<ClientContext>,
    Json(request): Json<InspectRequest>,
) -> ApiResult {
    authorize_client(&context, &request.window)?;
    if sessions::shared() && request.operation == "evaluate" {
        return Err(bad_request(
            "unsafe_evaluate_disabled",
            "arbitrary inspection callbacks are unavailable",
        ));
    }
    validate_ref(&request.reference)?;
    validate_inspection(&request.operation)?;
    let webview = resolve_webview(&state.app_handle, &request.window)?;
    let reference = serde_json::to_string(&request.reference).map_err(internal_error)?;
    let operation = serde_json::to_string(&request.operation).map_err(internal_error)?;
    let args = serde_json::to_string(&request.args).map_err(internal_error)?;
    let client = if sessions::shared() {
        serde_json::to_string(context.client().map_err(session_error)?).map_err(internal_error)?
    } else {
        "undefined".into()
    };
    let expected = if sessions::shared() {
        Some(
            sessions::manager()
                .reference_document(&context, &request.window, &request.reference, false)
                .map_err(session_error)?,
        )
    } else {
        None
    };
    let mut context = context;
    context.expected_document = expected.or(context.expected_document);
    let script = format!("(async()=>JSON.stringify(await window.__cogniaAgentDebug.inspect({reference},{operation},{args},{client})))()");
    let lifecycle = renderer_lifecycle(&state.app_handle);
    let value = execute_client(
        &webview,
        &lifecycle,
        &context,
        Value::Null,
        &script,
        EVAL_TIMEOUT,
        false,
    )
    .await?;
    Ok(Json(json!({
        "ok": true,
        "window": request.window,
        "value": value,
    })))
}

async fn locator(
    State(state): State<SharedState>,
    Extension(context): Extension<ClientContext>,
    Json(request): Json<LocatorRequest>,
) -> ApiResult {
    authorize_client(&context, &request.window)?;
    if sessions::shared()
        && (contains_ref_query(&request.query)
            || request.filters.iter().any(contains_ref_query)
            || contains_ref_query(&request.args))
    {
        return Err(bad_request(
            "ref_query_disabled",
            "use the session-validated act/inspect routes for snapshot refs",
        ));
    }
    if sessions::shared()
        && request.operation == "inspect"
        && request.name.as_deref() == Some("evaluate")
    {
        return Err(bad_request(
            "unsafe_evaluate_disabled",
            "arbitrary locator callbacks are unavailable",
        ));
    }
    const OPERATIONS: [&str; 4] = ["query", "inspect", "action", "cancel"];
    if !OPERATIONS.contains(&request.operation.as_str()) {
        return Err(bad_request(
            "unsupported_locator_operation",
            format!("unsupported locator operation: {}", request.operation),
        ));
    }
    if request
        .request_id
        .as_ref()
        .is_some_and(|id| id.is_empty() || id.len() > 128)
        || (request.operation == "cancel" && request.request_id.is_none())
    {
        return Err(bad_request(
            "invalid_request_id",
            "request ID must contain 1 to 128 bytes",
        ));
    }
    let webview = resolve_webview(&state.app_handle, &request.window)?;
    let timeout = Duration::from_millis(
        request
            .options
            .get("timeout")
            .and_then(Value::as_u64)
            .unwrap_or(10_000)
            .clamp(1, 120_000),
    );
    // The renderer also needs an expiry for work queued while its event loop is
    // suspended. Active waiting uses a local monotonic deadline on each side.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(internal_error)?
        .as_millis() as u64;
    let expires_at = now + timeout.as_millis() as u64;
    let expires_at = request
        .expires_at
        .map_or(expires_at, |requested| requested.min(expires_at));
    let timeout = Duration::from_millis(expires_at.saturating_sub(now).max(1));
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
        "requestId": request.request_id.as_ref().map(|id| if sessions::shared() { format!("{}:{id}",context.client().unwrap_or_default()) } else { id.clone() }),
        "clientSessionId": if sessions::shared() { Some(context.client().map_err(session_error)?) } else { None },
        "expiresAt": expires_at,
    }))
    .map_err(internal_error)?;
    let script = format!(
        "(async()=>JSON.stringify(await window.__cogniaAgentDebug.locator({payload},control)))()"
    );
    let lifecycle = renderer_lifecycle(&state.app_handle);
    let fingerprint = json!({"window":request.window,"query":request.query,"index":request.index,"filters":request.filters,"operation":request.operation,"name":request.name,"args":request.args,"strict":request.strict,"options":{"force":request.options["force"],"trial":request.options["trial"],"scroll":request.options["scroll"]},"requirements":request.requirements});
    let value = execute_client(
        &webview,
        &lifecycle,
        &context,
        fingerprint,
        &script,
        timeout,
        request.operation == "action",
    )
    .await?;
    Ok(Json(json!({
        "ok": true,
        "window": request.window,
        "locator": value,
    })))
}

fn contains_ref_query(value: &Value) -> bool {
    match value {
        Value::Object(fields) => {
            fields.get("kind").is_some_and(|kind| kind == "ref")
                || fields.values().any(contains_ref_query)
        }
        Value::Array(values) => values.iter().any(contains_ref_query),
        _ => false,
    }
}

async fn act(
    State(state): State<SharedState>,
    Extension(context): Extension<ClientContext>,
    Json(request): Json<ActRequest>,
) -> ApiResult {
    authorize_client(&context, &request.window)?;
    validate_ref(&request.reference)?;
    validate_action(&request.action)?;
    let webview = resolve_webview(&state.app_handle, &request.window)?;
    let reference = serde_json::to_string(&request.reference).map_err(internal_error)?;
    let action = serde_json::to_string(&request.action).map_err(internal_error)?;
    let args = serde_json::to_string(&request.args).map_err(internal_error)?;
    let script = format!("(async()=>{{const result=await window.__cogniaAgentDebug.act({reference},{action},{args},control);const snapshot=window.__cogniaAgentDebug.snapshot({{includeText:false,clientSessionId:control.clientSessionId}});return JSON.stringify({{result,snapshot}});}})()");
    let lifecycle = renderer_lifecycle(&state.app_handle);
    let value = execute_client(&webview, &lifecycle, &context, json!({"window":request.window,"reference":request.reference,"action":request.action,"args":request.args}), &script, EVAL_TIMEOUT, true).await?;
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
    let value = eval_json_async_with_timeout(
        &webview,
        &lifecycle,
        &script,
        Duration::from_millis(request.timeout.unwrap_or(10_000).clamp(1, 120_000)),
        None,
    )
    .await
    .map_err(eval_error)?;
    Ok(Json(
        json!({ "ok": true, "window": request.window, "value": value }),
    ))
}

async fn console(
    State(state): State<SharedState>,
    Extension(context): Extension<ClientContext>,
    Query(query): Query<DiagnosticQuery>,
) -> ApiResult {
    authorize_client(&context, &query.window)?;
    read_diagnostics(
        &state.app_handle,
        &context,
        &query,
        "readConsole",
        "console",
    )
    .await
}

async fn network(
    State(state): State<SharedState>,
    Extension(context): Extension<ClientContext>,
    Query(query): Query<DiagnosticQuery>,
) -> ApiResult {
    authorize_client(&context, &query.window)?;
    read_diagnostics(
        &state.app_handle,
        &context,
        &query,
        "readNetwork",
        "network",
    )
    .await
}

async fn read_diagnostics(
    app: &AppHandle,
    context: &ClientContext,
    query: &DiagnosticQuery,
    method: &str,
    key: &str,
) -> ApiResult {
    let webview = resolve_webview(app, &query.window)?;
    let script = diagnostic_read_script(query, method);
    let lifecycle = renderer_lifecycle(app);
    let value = execute_client(
        &webview,
        &lifecycle,
        context,
        Value::Null,
        &script,
        EVAL_TIMEOUT,
        false,
    )
    .await?;
    Ok(Json(
        json!({ "ok": true, "window": query.window, (key): value }),
    ))
}

fn diagnostic_read_script(query: &DiagnosticQuery, method: &str) -> String {
    let limit = query.limit.clamp(1, 500);
    let document_id = query
        .document_id
        .as_ref()
        .map(|value| serde_json::to_string(value).expect("document id is serializable"))
        .unwrap_or_else(|| "undefined".into());
    format!(
        "JSON.stringify(window.__cogniaAgentDebug.{method}({}, {limit}, {document_id}))",
        query.after
    )
}

async fn reload(
    State(state): State<SharedState>,
    Extension(context): Extension<ClientContext>,
    Json(request): Json<WindowQuery>,
) -> ApiResult {
    authorize_client(&context, &request.window)?;
    let webview = resolve_webview(&state.app_handle, &request.window)?;
    let lifecycle = renderer_lifecycle(&state.app_handle);
    let previous = lifecycle.state(&request.window);
    let deadline = std::time::Instant::now()
        + EVAL_TIMEOUT.min(Duration::from_millis(context.timeout_ms.unwrap_or(120_000)));
    let permit = if sessions::shared() {
        match sessions::manager()
            .begin(&context, &json!({"reload":request.window}))
            .map_err(session_error)?
        {
            Admission::Cached(value) => return Ok(Json(value)),
            Admission::Execute(op) => Some(op),
        }
    } else {
        None
    };
    if let Some(op) = &permit {
        dispatch_navigation(
            &webview,
            &lifecycle,
            op,
            &context,
            "location.reload()",
            deadline,
        )
        .await?;
    } else {
        webview.reload().map_err(internal_error)?;
    }
    if permit.is_some() {
        wait_navigation(
            &webview,
            &lifecycle,
            previous.document_epoch,
            None,
            deadline,
        )
        .await?;
    }
    let mut value = json!({ "ok": true, "window": request.window });
    if let Some(op) = permit {
        op.finish(&mut value).map_err(session_error)?;
    }
    Ok(Json(value))
}

async fn navigate(
    State(state): State<SharedState>,
    Extension(context): Extension<ClientContext>,
    Json(request): Json<NavigateRequest>,
) -> ApiResult {
    authorize_client(&context, &request.window)?;
    let webview = resolve_webview(&state.app_handle, &request.window)?;
    let target = match url::Url::parse(&request.url) {
        Ok(url) => url,
        Err(url::ParseError::RelativeUrlWithoutBase) => {
            let lifecycle = renderer_lifecycle(&state.app_handle);
            let current = eval_json(&webview, &lifecycle, "JSON.stringify(location.href)")
                .await
                .map_err(eval_error)?;
            url::Url::parse(
                current
                    .as_str()
                    .ok_or_else(|| bad_request("invalid_url", "page URL unavailable"))?,
            )
            .map_err(internal_error)?
            .join(&request.url)
            .map_err(|error| bad_request("invalid_url", error.to_string()))?
        }
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
    let lifecycle = renderer_lifecycle(&state.app_handle);
    let previous = lifecycle.state(&request.window);
    let deadline = std::time::Instant::now()
        + EVAL_TIMEOUT.min(Duration::from_millis(context.timeout_ms.unwrap_or(120_000)));
    let permit = if sessions::shared() {
        match sessions::manager()
            .begin(&context, &json!({"navigate":request.window,"url":target}))
            .map_err(session_error)?
        {
            Admission::Cached(value) => return Ok(Json(value)),
            Admission::Execute(op) => Some(op),
        }
    } else {
        None
    };
    if let Some(op) = &permit {
        let encoded = serde_json::to_string(target.as_str()).map_err(internal_error)?;
        dispatch_navigation(
            &webview,
            &lifecycle,
            op,
            &context,
            &format!("location.assign({encoded})"),
            deadline,
        )
        .await?;
    } else {
        webview.navigate(target.clone()).map_err(internal_error)?;
    }
    if permit.is_some() {
        wait_navigation(
            &webview,
            &lifecycle,
            previous.document_epoch,
            None,
            deadline,
        )
        .await?;
    }
    let mut value = json!({ "ok": true, "window": request.window, "url": target });
    if let Some(op) = permit {
        op.finish(&mut value).map_err(session_error)?;
    }
    Ok(Json(value))
}

async fn dispatch_navigation(
    webview: &Webview,
    lifecycle: &RendererLifecycle,
    operation: &sessions::Operation<'_>,
    context: &ClientContext,
    expression: &str,
    deadline: std::time::Instant,
) -> Result<(), (StatusCode, Json<Value>)> {
    let document = match &context.expected_document {
        Some(document) => json!(document),
        None => {
            eval_json_on_renderer_until(
                webview,
                lifecycle,
                "JSON.stringify(window.__cogniaAgentDebug.health().documentId)",
                deadline,
            )
            .await
            .map_err(eval_error)?
            .0
        }
    };
    operation.validate().map_err(session_error)?;
    let expires = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(internal_error)?
        .as_millis()
        + deadline
            .saturating_duration_since(std::time::Instant::now())
            .as_millis();
    webview.eval(format!("if(Date.now()<{expires}&&window.__cogniaAgentDebug?.health().documentId==={document}){{{expression}}}"))
        .map_err(internal_error)?;
    Ok(())
}

async fn wait_navigation(
    webview: &Webview,
    lifecycle: &RendererLifecycle,
    previous: u64,
    previous_url: Option<&str>,
    deadline: std::time::Instant,
) -> Result<(), (StatusCode, Json<Value>)> {
    while std::time::Instant::now() < deadline {
        let renderer = lifecycle.state(webview.label());
        if !renderer.document_loading && !renderer.awaiting_load {
            if let Ok((value, _)) = eval_json_on_renderer_until(
                webview,
                lifecycle,
                "JSON.stringify(window.__cogniaAgentDebug.health())",
                deadline,
            )
            .await
            {
                if value["readyState"] == "complete"
                    && (renderer.document_epoch != previous
                        || previous_url.is_some_and(|url| value["url"].as_str() != Some(url)))
                {
                    return Ok(());
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    Err(session_error((
        "outcome_unknown",
        "navigation did not settle; app writer remains quarantined",
    )))
}

async fn screenshot(
    State(state): State<SharedState>,
    Extension(context): Extension<ClientContext>,
    Query(query): Query<WindowQuery>,
) -> ApiResult {
    authorize_client(&context, &query.window)?;
    let window = state
        .app_handle
        .get_webview_window(&query.window)
        .ok_or_else(|| {
            not_found(
                "window_not_found",
                format!("webview window not found: {}", query.window),
            )
        })?;
    let lifecycle = renderer_lifecycle(&state.app_handle);
    let before = lifecycle.state(&query.window);
    let region = webview_window_region(&window)?;
    let capture = observe_client(&context, &query.window, async {
        tokio::task::spawn_blocking(move || {
            crate::automation::platform::shared::screenshot::capture_global_region(
                region,
                crate::automation::types::ImageFormat::Png,
            )
        })
        .await
    })
    .await?
    .map_err(internal_error)?;
    if sessions::shared() {
        let current = lifecycle.state(&query.window);
        check_poll_document(&query.window, before, current).map_err(eval_error)?;
        if !same_incarnation(&before, &current) {
            return Err(eval_error(EvalError::DocumentLoading {
                window: query.window.clone(),
                document_epoch: current.document_epoch,
            }));
        }
    }
    let capture = match capture {
        Ok(capture) => capture,
        Err(error) if !sessions::shared() && screenshot_needs_recenter(&error) => {
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
    desktop_region(position.x, position.y, size.width, size.height, scale)
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

/// Evaluate `script` and return its JSON result together with the renderer and
/// document incarnation that produced it.
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
) -> Result<(Value, RendererState), EvalError> {
    eval_json_on_renderer_until(
        webview,
        lifecycle,
        script,
        std::time::Instant::now() + EVAL_TIMEOUT,
    )
    .await
}

async fn eval_json_on_renderer_until(
    webview: &Webview,
    lifecycle: &RendererLifecycle,
    script: &str,
    deadline: std::time::Instant,
) -> Result<(Value, RendererState), EvalError> {
    eval_json_on_renderer_until_scoped(webview, lifecycle, script, deadline, None).await
}

async fn eval_json_on_renderer_until_scoped(
    webview: &Webview,
    lifecycle: &RendererLifecycle,
    script: &str,
    deadline: std::time::Instant,
    context: Option<&ClientContext>,
) -> Result<(Value, RendererState), EvalError> {
    let label = webview.label().to_string();
    let context = context
        .filter(|context| sessions::shared() && matches!(context.identity, Identity::Client(_)));
    let binding = bind_renderer(
        lifecycle,
        &label,
        deadline
            .saturating_duration_since(std::time::Instant::now())
            .min(RENDERER_RELOAD_WAIT),
    );
    let renderer = if let Some(context) = context {
        sessions::manager()
            .observe(context, &label, binding)
            .await
            .map_err(EvalError::Session)?
    } else {
        binding.await
    }?;
    if std::time::Instant::now() >= deadline {
        return Err("webview evaluation timed out".to_string().into());
    }

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

    let answer = await_eval_answer(
        rx,
        lifecycle,
        &label,
        renderer.generation,
        renderer.document_epoch,
        deadline.saturating_duration_since(std::time::Instant::now()),
    );
    let raw = if let Some(context) = context {
        sessions::manager()
            .observe(context, &label, answer)
            .await
            .map_err(EvalError::Session)?
    } else {
        answer.await
    }?;
    let unwrapped = unwrap_js_string(raw);
    if unwrapped.len() > MAX_RESULT_BYTES {
        return Err("webview evaluation result exceeds the 2 MiB limit"
            .to_string()
            .into());
    }
    let value = serde_json::from_str(&unwrapped)
        .map_err(|error| EvalError::Failed(format!("invalid JSON from webview: {error}")))?;
    Ok((value, renderer))
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
    if renderer.awaiting_load || renderer.document_loading {
        renderer = lifecycle.wait_until_loaded(label, wait).await;
        if renderer.awaiting_load {
            return Err(EvalError::RendererRestarting {
                window: label.to_string(),
                generation: renderer.generation,
            });
        }
        if renderer.document_loading {
            return Err(EvalError::DocumentLoading {
                window: label.to_string(),
                document_epoch: renderer.document_epoch,
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
    document_epoch: u64,
    timeout: Duration,
) -> Result<String, EvalError> {
    let outcome: EvalAnswer = tokio::select! {
        result = tokio::time::timeout(timeout, answer) => Some(result),
        () = lifecycle.wait_for_termination(label, generation) => None,
        () = lifecycle.wait_for_document_change(label, document_epoch) => None,
    };
    let now = lifecycle.state(label);
    let answered = matches!(&outcome, Some(Ok(Ok(value))) if !value.is_empty());
    if !answered && now.generation == generation && now.document_epoch != document_epoch {
        return Err(EvalError::DocumentReplaced {
            window: label.to_string(),
            document_epoch: now.document_epoch,
        });
    }
    classify_eval_answer(outcome, label, generation, now.generation)
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

fn check_poll_document(
    label: &str,
    started_on: RendererState,
    polled_on: RendererState,
) -> Result<(), EvalError> {
    check_poll_renderer(label, started_on.generation, polled_on.generation)?;
    if started_on.document_epoch != polled_on.document_epoch {
        return Err(EvalError::DocumentReplaced {
            window: label.to_string(),
            document_epoch: polled_on.document_epoch,
        });
    }
    Ok(())
}

fn unwrap_js_string(raw: String) -> String {
    serde_json::from_str::<String>(&raw).unwrap_or(raw)
}

fn async_eval_start_script(request_id: &str, expression: &str, expires_at: u128) -> String {
    let request_id = serde_json::to_string(request_id).expect("request id is serializable");
    format!(
        "(()=>{{const id={request_id};const results=window.__cogniaAgentDebugAsyncResults||(window.__cogniaAgentDebugAsyncResults=Object.create(null));const now=Date.now();for(const [key,result] of Object.entries(results)){{if(now-Number(result.startedAt||now)>120000){{result.cancelled=true;result.abort?.();delete results[key]}}}}const keys=Object.keys(results).sort((left,right)=>Number(results[left].startedAt||0)-Number(results[right].startedAt||0));if(keys.length>=100)return JSON.stringify({{status:\"capacity\"}});const control={{status:\"pending\",startedAt:now,expiresAt:{expires_at},cancelled:false}};results[id]=control;Promise.resolve().then(async()=>{{if(control.cancelled)return;if(Date.now()>={expires_at}){{Object.assign(control,{{status:\"rejected\",error:\"evaluation deadline exceeded before execution\"}});return}}try{{const value=await ({expression});if(results[id]===control&&!control.cancelled)Object.assign(control,{{status:\"fulfilled\",value}})}}catch(error){{if(results[id]===control&&!control.cancelled)Object.assign(control,{{status:\"rejected\",error:String(error)+String((error&&error.stack)||\"\")}})}}}});return JSON.stringify({{status:\"started\"}})}})()"
    )
}

fn async_eval_poll_script(request_id: &str) -> String {
    let request_id = serde_json::to_string(request_id).expect("request id is serializable");
    format!(
        "(()=>{{const id={request_id};const results=window.__cogniaAgentDebugAsyncResults;const result=results&&results[id];if(!result)return JSON.stringify({{status:\"missing\"}});if(result.status===\"pending\")return JSON.stringify(result);delete results[id];const encoded=JSON.stringify(result);if(new TextEncoder().encode(encoded).byteLength>{MAX_RESULT_BYTES})return JSON.stringify({{status:\"rejected\",error:\"webview evaluation result exceeds the 2 MiB limit\"}});return encoded}})()"
    )
}

fn async_eval_cleanup_script(request_id: &str) -> String {
    let request_id = serde_json::to_string(request_id).expect("request id is serializable");
    format!(
        "(()=>{{const results=window.__cogniaAgentDebugAsyncResults;const control=results&&results[{request_id}];if(control){{control.cancelled=true;control.abort?.();delete results[{request_id}]}}return JSON.stringify({{status:\"cleaned\"}})}})()"
    )
}

fn cleanup_async_eval(webview: &Webview, request_id: &str) {
    // Queue cleanup without adding another callback timeout to the expired
    // request. Locator actions consult the retained control before dispatch.
    let _ = webview.eval(&async_eval_cleanup_script(request_id));
}

async fn eval_json_async_with_timeout(
    webview: &Webview,
    lifecycle: &RendererLifecycle,
    expression: &str,
    timeout: Duration,
    context: Option<&ClientContext>,
) -> Result<Value, EvalError> {
    let label = webview.label().to_string();
    let request_id = uuid::Uuid::new_v4().simple().to_string();
    let deadline = std::time::Instant::now() + timeout;
    let expires_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| EvalError::Failed(error.to_string()))?
        .as_millis()
        + timeout.as_millis();
    let started = eval_json_on_renderer_until_scoped(
        webview,
        lifecycle,
        &async_eval_start_script(&request_id, expression, expires_at),
        deadline,
        context,
    )
    .await;
    let (start, started_on) = match started {
        Ok(result) => result,
        Err(error) => {
            cleanup_async_eval(webview, &request_id);
            return Err(error);
        }
    };
    if start["status"] != "started" {
        return Err("webview async evaluation did not start".to_string().into());
    }
    // The pending promise lives in the realm of generation `started_on`; any
    // later renderer cannot hold its result.

    loop {
        if std::time::Instant::now() >= deadline {
            cleanup_async_eval(webview, &request_id);
            return Err("webview async evaluation timed out".to_string().into());
        }
        let result = match eval_json_on_renderer_until_scoped(
            webview,
            lifecycle,
            &async_eval_poll_script(&request_id),
            deadline,
            context,
        )
        .await
        {
            Ok((result, polled_on)) => {
                if let Err(error) = check_poll_document(&label, started_on, polled_on) {
                    cleanup_async_eval(webview, &request_id);
                    return Err(error);
                }
                result
            }
            Err(error @ EvalError::RendererRestarted { .. })
            | Err(error @ EvalError::RendererRestarting { .. })
            | Err(error @ EvalError::DocumentReplaced { .. })
            | Err(error @ EvalError::DocumentLoading { .. }) => {
                cleanup_async_eval(webview, &request_id);
                return Err(error);
            }
            Err(error) => {
                cleanup_async_eval(webview, &request_id);
                return Err(error);
            }
        };
        match result["status"].as_str() {
            Some("pending") => {
                tokio::time::sleep(
                    Duration::from_millis(25)
                        .min(deadline.saturating_duration_since(std::time::Instant::now())),
                )
                .await
            }
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
                return Err(EvalError::Rejected(
                    result["error"]
                        .as_str()
                        .unwrap_or("webview async evaluation failed")
                        .to_owned(),
                ));
            }
            Some("missing") => {
                check_poll_document(&label, started_on, lifecycle.state(&label))?;
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
    let reference = if let Some((document, reference)) = reference.split_once(':') {
        if !document.starts_with('d')
            || document.len() < 2
            || document.len() > 129
            || !document[1..]
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return Err(bad_request(
                "invalid_ref",
                "invalid document identity in element ref",
            ));
        }
        reference
    } else {
        reference
    };
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

/// The window's frame in the desktop units `capture_global_region` takes:
/// points on macOS, physical pixels elsewhere.
fn desktop_region(
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
    Ok(
        crate::automation::platform::shared::desktop_space::window_frame(
            (physical_x, physical_y),
            (physical_width, physical_height),
            scale,
            crate::automation::platform::shared::desktop_space::DESKTOP_UNITS_ARE_POINTS,
        ),
    )
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
    let rejected = matches!(&error, EvalError::Rejected(_));
    let message = error.to_string();
    let (code, window, generation) = match &error {
        EvalError::Session(fault) => return session_error(*fault),
        EvalError::DocumentReplaced {
            window,
            document_epoch,
        }
        | EvalError::DocumentLoading {
            window,
            document_epoch,
        } => {
            let code = if matches!(&error, EvalError::DocumentLoading { .. }) {
                "webview_document_loading"
            } else {
                "webview_document_replaced"
            };
            return (
                StatusCode::CONFLICT,
                Json(json!({
                    "ok": false, "code": code, "error": message, "window": window,
                    "documentEpoch": document_epoch, "retryable": false, "dispatchState": "unknown",
                })),
            );
        }
        EvalError::RendererRestarted { window, generation } => {
            ("webview_renderer_restarted", window, *generation)
        }
        EvalError::RendererRestarting { window, generation } => {
            ("webview_renderer_restarting", window, *generation)
        }
        EvalError::Failed(error) | EvalError::Rejected(error) => {
            let (status, Json(mut payload)) = api_error(
                StatusCode::UNPROCESSABLE_ENTITY,
                if rejected {
                    "webview_eval_rejected"
                } else {
                    classify_eval_failure(error)
                },
                message,
            );
            payload["dispatchState"] = json!("unknown");
            payload["retryable"] = json!(false);
            return (status, Json(payload));
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
            "retryable": false,
            "dispatchState": "unknown",
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

    #[test]
    fn snapshot_settles_known_rejection_but_retains_unknown_capture() {
        for settled in [false, true] {
            let manager = sessions::Sessions::default();
            let client = manager.open(vec!["main".into()], true).unwrap();
            let mut context = ClientContext {
                identity: Identity::Client(client["clientSessionId"].as_str().unwrap().into()),
                writer: None,
                expected_document: None,
                timeout_ms: None,
            };
            let lease = manager.acquire(&context).unwrap();
            context.writer = Some(sessions::Writer {
                token: lease.token.clone(),
                fence: lease.fence,
                operation_id: "key-down".into(),
            });
            let Admission::Execute(input) = manager
                .begin(&context, &json!({"helper":"keyboard","window":"main"}))
                .unwrap()
            else {
                panic!()
            };
            input.finish(&mut json!(true)).unwrap();
            let capture = manager.capture_snapshot(&context).unwrap();
            let error = if settled {
                EvalError::Rejected("invalid selector".into())
            } else {
                EvalError::Failed("webview evaluation timed out".into())
            };
            settle_snapshot_error(Some(capture), &error);
            if !settled {
                assert_eq!(
                    manager.capture_snapshot(&context).err().unwrap().0,
                    "concurrent_operation"
                );
                assert!(manager.input_dirty("main"));
                continue;
            }
            manager.capture_snapshot(&context).unwrap().complete();
            let _drain = manager.drain(&context, &lease.token, lease.fence).unwrap();
            context.writer.as_mut().unwrap().operation_id = "cleanup".into();
            let Admission::Execute(cleanup) = manager
                .begin(&context, &json!({"helper":"releaseInput","window":"main"}))
                .unwrap()
            else {
                panic!()
            };
            cleanup.finish(&mut json!(true)).unwrap();
            manager
                .release(&context, &lease.token, lease.fence)
                .unwrap();
            assert!(!manager.input_dirty("main"));
            manager.detach(&context).unwrap();
        }
        let (_, Json(value)) = eval_error(EvalError::Rejected("invalid selector".into()));
        assert_eq!(value["code"], "webview_eval_rejected");
    }

    #[test]
    fn recovery_needs_a_new_helper_realm_not_only_a_native_load_event() {
        assert!(!replaced_document(&json!("old"), &json!("old")));
        assert!(!replaced_document(&Value::Null, &json!("new")));
        assert!(!replaced_document(&json!("old"), &json!("")));
        assert!(replaced_document(&json!("old"), &json!("new")));
    }
    #[test]
    fn recovery_proof_rejects_changed_loading_and_restarted_incarnations() {
        let original = RendererState::default();
        assert!(same_incarnation(&original, &original));
        let mut changed = original.clone();
        changed.document_epoch += 1;
        assert!(!same_incarnation(&original, &changed));
        changed = original.clone();
        changed.generation += 1;
        assert!(!same_incarnation(&original, &changed));
        changed = original.clone();
        changed.document_loading = true;
        assert!(!same_incarnation(&original, &changed));
        changed = original.clone();
        changed.awaiting_load = true;
        assert!(!same_incarnation(&original, &changed));
    }
    #[test]
    fn native_health_probe_is_opt_in_and_does_not_require_a_renderer() {
        let normal: HealthQuery = serde_json::from_str("{}").unwrap();
        let native: HealthQuery = serde_json::from_str(r#"{"nativeOnly":true}"#).unwrap();
        assert!(!normal.native_only);
        assert!(native.native_only);
    }

    const AGENT_ROUTES: [&str; 20] = [
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
        "/api/dev/agent/sessions",
        "/api/dev/agent/sessions/{id}",
        "/api/dev/agent/recover",
        "/api/dev/agent/session",
        "/api/dev/agent/lease",
        "/api/dev/agent/helper",
    ];

    #[test]
    fn diagnostic_cursor_scripts_escape_document_identity_and_bound_the_limit() {
        let query: DiagnosticQuery = serde_json::from_value(json!({
            "after": 42,
            "limit": 900,
            "documentId": "old\"document\\identity"
        }))
        .unwrap();
        assert_eq!(
            diagnostic_read_script(&query, "readConsole"),
            "JSON.stringify(window.__cogniaAgentDebug.readConsole(42, 500, \"old\\\"document\\\\identity\"))"
        );
    }

    #[test]
    fn legacy_diagnostic_reads_do_not_request_a_document_reset() {
        let query: DiagnosticQuery = serde_json::from_value(json!({ "after": 7 })).unwrap();
        assert_eq!(
            diagnostic_read_script(&query, "readNetwork"),
            "JSON.stringify(window.__cogniaAgentDebug.readNetwork(7, 500, undefined))"
        );
    }

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
        assert!(validate_ref("ddocument-1:g1e42").is_ok());
        assert!(validate_ref("d:g1e42").is_err());
        assert!(validate_ref("d../escape:g1e42").is_err());
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
    fn converts_window_bounds_to_desktop_units() {
        let rect = desktop_region(200, 100, 1600, 1200, 2.0).unwrap();
        // macOS captures in points; Windows and Linux in physical pixels.
        let expected =
            if crate::automation::platform::shared::desktop_space::DESKTOP_UNITS_ARE_POINTS {
                crate::automation::types::Rect {
                    x: 100,
                    y: 50,
                    width: 800,
                    height: 600,
                }
            } else {
                crate::automation::types::Rect {
                    x: 200,
                    y: 100,
                    width: 1600,
                    height: 1200,
                }
            };
        assert_eq!(rect, expected);
        assert!(desktop_region(0, 0, 0, 100, 1.0).is_err());
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
        let start = async_eval_start_script("request-1", "work()", 12_345);
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
        assert!(cleanup.contains("control.cancelled=true"));
        assert!(cleanup.contains("control.abort?.()"));
        assert!(start.contains("results[id]===control&&!control.cancelled"));
        assert!(start.contains("if(control.cancelled)return"));
        assert!(start.contains("if(Date.now()>=12345)"));
    }

    #[test]
    fn locator_control_and_evaluation_budget_deserialize_additively() {
        let cancel: LocatorRequest = serde_json::from_value(json!({
            "query": {}, "operation": "cancel", "requestId": "action-1",
        }))
        .unwrap();
        assert_eq!(cancel.request_id.as_deref(), Some("action-1"));
        assert_eq!(cancel.window, "main");
        assert!(cancel.expires_at.is_none());
        let evaluate: EvaluateRequest = serde_json::from_value(json!({
            "expression": "true", "timeout": 30_000,
        }))
        .unwrap();
        assert_eq!(evaluate.timeout, Some(30_000));
        let legacy: EvaluateRequest =
            serde_json::from_value(json!({ "expression": "true" })).unwrap();
        assert!(legacy.timeout.is_none());
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
        assert_eq!(restarted["retryable"], false);
        assert_eq!(restarted["dispatchState"], "unknown");
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
            await_eval_answer(rx, &lifecycle, "main", 0, 0, Duration::from_millis(20)).await;
        assert_eq!(
            timed_out,
            Err(EvalError::Failed("webview evaluation timed out".into()))
        );

        let (tx, rx) = tokio::sync::oneshot::channel::<String>();
        drop(tx);
        let closed = await_eval_answer(rx, &lifecycle, "main", 0, 0, Duration::from_secs(5)).await;
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
                await_eval_answer(rx, &lifecycle, "main", 0, 0, Duration::from_secs(30)).await
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
                await_eval_answer(rx, &lifecycle, "main", 0, 0, Duration::from_secs(5)).await
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
        lifecycle.record_page_load_finished("main");

        let renderer = binding.await.unwrap().expect("rebinds after reload");
        assert_eq!(renderer.generation, 1);
        assert!(!renderer.awaiting_load);

        // The next evaluation is tied to the new generation: its answer is
        // accepted, and only a further termination interrupts it.
        let (tx, rx) = tokio::sync::oneshot::channel::<String>();
        tx.send("\"ok\"".into()).unwrap();
        assert_eq!(
            await_eval_answer(
                rx,
                &lifecycle,
                "main",
                renderer.generation,
                renderer.document_epoch,
                EVAL_TIMEOUT
            )
            .await,
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
    fn app_identity_changes_without_changing_the_managed_session() {
        let first = debug_session_identity(
            Some("run-a".into()),
            Some("/repo".into()),
            "app-1".into(),
            101,
        );
        let second = debug_session_identity(
            Some("run-a".into()),
            Some("/repo".into()),
            "app-2".into(),
            202,
        );
        assert_eq!(first["sessionId"], second["sessionId"]);
        assert_eq!(first["workspace"], second["workspace"]);
        assert_ne!(first["appInstanceId"], second["appInstanceId"]);
        assert_ne!(first["pid"], second["pid"]);
    }

    #[tokio::test]
    async fn ordinary_reload_interrupts_a_pending_evaluation_without_a_renderer_crash() {
        let lifecycle = RendererLifecycle::new();
        let (_silent_sender, rx) = tokio::sync::oneshot::channel::<String>();
        let pending = {
            let lifecycle = lifecycle.clone();
            tokio::spawn(async move {
                await_eval_answer(rx, &lifecycle, "main", 0, 0, Duration::from_secs(30)).await
            })
        };
        tokio::task::yield_now().await;
        lifecycle.record_page_load("main");
        let result = tokio::time::timeout(Duration::from_secs(2), pending)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            result,
            Err(EvalError::DocumentReplaced {
                window: "main".into(),
                document_epoch: 1
            })
        );
        assert_eq!(lifecycle.state("main").generation, 0);
    }

    #[tokio::test]
    async fn another_windows_reload_does_not_interrupt_an_evaluation() {
        let lifecycle = RendererLifecycle::new();
        let (tx, rx) = tokio::sync::oneshot::channel::<String>();
        lifecycle.record_page_load("settings");
        tx.send("1".into()).unwrap();
        assert_eq!(
            await_eval_answer(rx, &lifecycle, "main", 0, 0, Duration::from_secs(1)).await,
            Ok("1".into())
        );
    }

    #[test]
    fn async_polling_cannot_collect_a_result_from_another_document_epoch() {
        let started = RendererState::default();
        let replaced = RendererState {
            document_epoch: 1,
            ..started
        };
        assert_eq!(
            check_poll_document("main", started, replaced),
            Err(EvalError::DocumentReplaced {
                window: "main".into(),
                document_epoch: 1
            })
        );
        let (status, Json(payload)) = eval_error(EvalError::DocumentReplaced {
            window: "main".into(),
            document_epoch: 1,
        });
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(payload["code"], "webview_document_replaced");
        assert_eq!(payload["retryable"], false);
        assert_eq!(payload["dispatchState"], "unknown");
    }

    #[tokio::test]
    async fn binding_waits_for_a_normal_reload_to_finish() {
        let lifecycle = RendererLifecycle::new();
        lifecycle.record_page_load("main");
        assert_eq!(
            bind_renderer(&lifecycle, "main", Duration::from_millis(1)).await,
            Err(EvalError::DocumentLoading {
                window: "main".into(),
                document_epoch: 1
            })
        );
        lifecycle.record_page_load_finished("main");
        let bound = bind_renderer(&lifecycle, "main", Duration::from_secs(1))
            .await
            .unwrap();
        assert_eq!(bound.document_epoch, 1);
        assert!(!bound.document_loading);
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

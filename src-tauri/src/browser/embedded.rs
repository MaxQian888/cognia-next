//! Embedded child-webview preview (P1).
//!
//! Renders the dev server *inside* the main window as a side pane that tracks a
//! reserved DOM rect, using Tauri's built-in multi-webview API
//! (`Window::add_child`). That API requires the `tauri/unstable` feature
//! (enabled in `Cargo.toml`) and only exists on desktop, so every body here is
//! `#[cfg(desktop)]` with a stub elsewhere — the command surface stays
//! registrable on all targets (mobile shells just get a clear error).
//!
//! The native child webview always paints above the React layer and is not
//! clipped by CSS, so the frontend drives `set_bounds` on every layout change
//! and `set_visible(false)` to get out of the way of modals/overlays. Visual
//! positioning is verified via `pnpm tauri dev` smoke; the API surface is
//! compiler-verified by the `unstable` build.

use tauri::{AppHandle, Manager, State, WebviewWindow};

use super::commands::{handle_navigation, js_string, validate_external_url};
use super::overlay;
use crate::automation::types::Screenshot;

/// Label of the single embedded preview webview (child of "main").
pub const EMBED_LABEL: &str = "browser-embed";

#[derive(Clone, Debug, PartialEq, Eq)]
struct EmbeddedBrowserOwner {
    token: String,
    window_label: String,
}

#[derive(Default)]
pub struct EmbeddedBrowserLease {
    owner: parking_lot::Mutex<Option<EmbeddedBrowserOwner>>,
    /// `None` means no child WebView has been created. `Some(None)` records a
    /// direct WebView; `Some(Some(url))` records its immutable proxy endpoint.
    webview_proxy_url: parking_lot::Mutex<Option<Option<String>>>,
}

impl EmbeddedBrowserLease {
    /// Reserve the singleton for an invoking window. A renderer reload gets a
    /// new token but keeps the same window label, so it may reclaim its own
    /// orphaned lease; a different Cognia window may not.
    fn claim(&self, owner_token: &str, window_label: &str) -> Result<bool, String> {
        if owner_token.trim().is_empty() {
            return Err("embedded browser owner token is required".to_string());
        }
        let mut owner = self.owner.lock();
        match owner.as_ref() {
            Some(current) if current.window_label != window_label => {
                Err("embedded browser is owned by another Cognia surface".to_string())
            }
            Some(current) if current.token == owner_token => Ok(false),
            _ => {
                *owner = Some(EmbeddedBrowserOwner {
                    token: owner_token.to_string(),
                    window_label: window_label.to_string(),
                });
                Ok(true)
            }
        }
    }

    pub(crate) fn assert_owner(&self, owner_token: &str, window_label: &str) -> Result<(), String> {
        match self.owner.lock().as_ref() {
            Some(current)
                if current.token == owner_token && current.window_label == window_label =>
            {
                Ok(())
            }
            Some(_) => Err("embedded browser owner token does not match".to_string()),
            None => Err("embedded browser has no active owner".to_string()),
        }
    }

    fn release(&self, owner_token: &str, window_label: &str) -> Result<(), String> {
        let mut owner = self.owner.lock();
        match owner.as_ref() {
            Some(current)
                if current.token == owner_token && current.window_label == window_label =>
            {
                *owner = None;
                Ok(())
            }
            Some(_) => Err("embedded browser owner token does not match".to_string()),
            None => Err("embedded browser has no active owner".to_string()),
        }
    }

    fn rollback_claim(&self, owner_token: &str, window_label: &str, newly_claimed: bool) {
        if newly_claimed {
            let _ = self.release(owner_token, window_label);
        }
    }

    fn requires_webview_recreation(&self, next_proxy_url: &Option<url::Url>) -> bool {
        let current = self.webview_proxy_url.lock();
        let next = next_proxy_url.as_ref().map(url::Url::as_str);
        match current.as_ref() {
            Some(current) => current.as_deref() != next,
            None => false,
        }
    }

    fn record_webview_proxy(&self, proxy_url: &Option<url::Url>) {
        *self.webview_proxy_url.lock() =
            Some(proxy_url.as_ref().map(|url| url.as_str().to_string()));
    }

    fn clear_webview_proxy(&self) {
        *self.webview_proxy_url.lock() = None;
    }

    pub(crate) fn release_window(&self, window_label: &str) {
        let released = {
            let mut owner = self.owner.lock();
            if owner
                .as_ref()
                .is_some_and(|current| current.window_label == window_label)
            {
                *owner = None;
                true
            } else {
                false
            }
        };
        if released {
            self.clear_webview_proxy();
        }
    }
}

/// Compute the monitor-relative physical crop for the embedded webview.
/// `window_inner_pos` is the main window content origin (physical px), `embed`
/// is the reserved rect in logical px relative to that content area, `scale` is
/// the monitor scale factor, and `monitor_origin` is the primary monitor's
/// physical top-left. Pure so the coordinate math is unit-tested without a live
/// window. (Capture assumes the window is on the primary monitor — multi-monitor
/// capture is a known follow-up.)
#[cfg(desktop)]
fn compute_embed_capture_region(
    window_inner_pos: (i32, i32),
    embed: (f64, f64, f64, f64),
    scale: f64,
    monitor_origin: (i32, i32),
) -> crate::automation::types::Rect {
    crate::automation::types::Rect {
        x: window_inner_pos.0 + (embed.0 * scale).round() as i32 - monitor_origin.0,
        y: window_inner_pos.1 + (embed.1 * scale).round() as i32 - monitor_origin.1,
        width: (embed.2 * scale).round() as i32,
        height: (embed.3 * scale).round() as i32,
    }
}

#[cfg(desktop)]
fn logical_rect(x: f64, y: f64, width: f64, height: f64) -> tauri::Rect {
    tauri::Rect {
        position: tauri::LogicalPosition::new(x, y).into(),
        size: tauri::LogicalSize::new(width, height).into(),
    }
}

fn resolve_webview_proxy_url(
    target: &url::Url,
    proxy: &crate::proxy_config::ProxyConfig,
) -> Result<Option<url::Url>, String> {
    if proxy.should_bypass(target.as_str()) {
        return Ok(None);
    }
    let Some(proxy_url) = proxy.proxy_url() else {
        return Ok(None);
    };
    let parsed = url::Url::parse(&proxy_url)
        .map_err(|error| format!("invalid browser proxy URL: {error}"))?;
    if !matches!(parsed.scheme(), "http" | "socks5") {
        return Err(format!(
            "embedded browser does not support {} proxy URLs",
            parsed.scheme()
        ));
    }
    Ok(Some(parsed))
}

#[cfg(desktop)]
fn add_embed_webview(
    app: &AppHandle,
    target: url::Url,
    proxy_url: Option<url::Url>,
    bounds: tauri::Rect,
) -> Result<(), String> {
    use tauri::webview::WebviewBuilder;
    use tauri::{Manager, WebviewUrl};

    let window = app
        .get_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let nav_app = app.clone();
    let nav_label = EMBED_LABEL.to_string();
    let mut builder = WebviewBuilder::new(EMBED_LABEL, WebviewUrl::External(target))
        .initialization_script(overlay::OVERLAY_JS)
        .on_navigation(move |url| handle_navigation(&nav_app, &nav_label, url.as_str()));
    if let Some(proxy_url) = proxy_url {
        builder = builder.proxy_url(proxy_url);
    }
    let webview = window
        .add_child(builder, bounds.position, bounds.size)
        .map_err(|error| format!("embed webview: {error}"))?;
    // Bounds are driven explicitly from the reserved-rect observer.
    let _ = webview.set_auto_resize(false);
    Ok(())
}

#[cfg(desktop)]
async fn close_embed_webview(app: &AppHandle) -> Result<(), String> {
    use tauri::Manager;

    if let Some(webview) = app.get_webview(EMBED_LABEL) {
        webview.close().map_err(|error| error.to_string())?;
        for _ in 0..200 {
            if app.get_webview(EMBED_LABEL).is_none() {
                return Ok(());
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        return Err("timed out waiting for embedded browser destruction".to_string());
    }
    Ok(())
}

#[cfg(desktop)]
async fn navigate_existing_embed(
    app: &AppHandle,
    lease: &EmbeddedBrowserLease,
    target: url::Url,
    proxy_url: Option<url::Url>,
) -> Result<(), String> {
    use tauri::Manager;

    let webview = app
        .get_webview(EMBED_LABEL)
        .ok_or_else(|| "embedded preview is not open".to_string())?;
    if !lease.requires_webview_recreation(&proxy_url) {
        return webview.navigate(target).map_err(|error| error.to_string());
    }

    // Proxy configuration is immutable after WebView creation. Keep its
    // current bounds — including the off-screen zero-size parked state — while
    // replacing the native child under the same owner lease.
    let bounds = webview.bounds().map_err(|error| error.to_string())?;
    close_embed_webview(app).await?;
    lease.clear_webview_proxy();
    add_embed_webview(app, target, proxy_url.clone(), bounds)?;
    lease.record_webview_proxy(&proxy_url);
    Ok(())
}

/// Create (or re-navigate) the embedded preview at the given logical bounds.
#[tauri::command]
pub async fn browser_embed_create(
    app: AppHandle,
    invoking_window: WebviewWindow,
    lease: State<'_, EmbeddedBrowserLease>,
    owner_token: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<String, String> {
    let parsed = validate_external_url(&url)?;
    let window_label = invoking_window.label().to_string();
    let newly_claimed = lease.claim(&owner_token, &window_label)?;
    let result: Result<String, String> = async {
        #[cfg(desktop)]
        {
            let proxy_url = resolve_webview_proxy_url(&parsed, &crate::proxy_config::current())?;
            if app.get_webview(EMBED_LABEL).is_some() {
                navigate_existing_embed(&app, lease.inner(), parsed, proxy_url).await?;
            } else {
                add_embed_webview(
                    &app,
                    parsed,
                    proxy_url.clone(),
                    logical_rect(x, y, width, height),
                )?;
                lease.record_webview_proxy(&proxy_url);
            }
            Ok(EMBED_LABEL.to_string())
        }
        #[cfg(not(desktop))]
        {
            let _ = (parsed, x, y, width, height);
            Err("embedded browser preview is only available on desktop".to_string())
        }
    }
    .await;
    if result.is_err() {
        lease.rollback_claim(&owner_token, &window_label, newly_claimed);
    } else if newly_claimed {
        let lease_app = app.clone();
        let lease_window_label = window_label.clone();
        invoking_window.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                lease_app
                    .state::<EmbeddedBrowserLease>()
                    .release_window(&lease_window_label);
            }
        });
    }
    result
}

#[tauri::command]
pub async fn browser_embed_set_bounds(
    app: AppHandle,
    invoking_window: WebviewWindow,
    lease: State<'_, EmbeddedBrowserLease>,
    owner_token: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    lease.assert_owner(&owner_token, invoking_window.label())?;
    #[cfg(desktop)]
    {
        use tauri::Manager;
        let wv = app
            .get_webview(EMBED_LABEL)
            .ok_or_else(|| "embedded preview is not open".to_string())?;
        wv.set_bounds(logical_rect(x, y, width, height))
            .map_err(|e| e.to_string())
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, x, y, width, height);
        Err("desktop only".to_string())
    }
}

/// Show at the given bounds, or hide by parking the webview off-screen with
/// zero size (the native layer cannot be clipped, so this is how it yields to
/// overlapping app UI).
#[tauri::command]
pub async fn browser_embed_set_visible(
    app: AppHandle,
    invoking_window: WebviewWindow,
    lease: State<'_, EmbeddedBrowserLease>,
    owner_token: String,
    visible: bool,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    lease.assert_owner(&owner_token, invoking_window.label())?;
    #[cfg(desktop)]
    {
        use tauri::Manager;
        let wv = app
            .get_webview(EMBED_LABEL)
            .ok_or_else(|| "embedded preview is not open".to_string())?;
        let rect = if visible {
            logical_rect(x, y, width, height)
        } else {
            logical_rect(-32000.0, -32000.0, 0.0, 0.0)
        };
        wv.set_bounds(rect).map_err(|e| e.to_string())
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, visible, x, y, width, height);
        Err("desktop only".to_string())
    }
}

#[cfg(desktop)]
fn eval_embed(app: &AppHandle, js: &str) -> Result<(), String> {
    use tauri::Manager;
    app.get_webview(EMBED_LABEL)
        .ok_or_else(|| "embedded preview is not open".to_string())?
        .eval(js)
        .map_err(|e| e.to_string())
}

/// Build the `window.__cogniaAct(ref, action, args)` call string. `args` is a
/// JSON object string that we pass *as a JS string literal* (double-encoded) so
/// the page can `JSON.parse` it back without quoting hazards.
#[cfg(desktop)]
fn build_act_call(reference: &str, action: &str, args_json: &str) -> Result<String, String> {
    Ok(format!(
        "window.__cogniaAct({}, {}, {})",
        js_string(reference)?,
        js_string(action)?,
        js_string(args_json)?
    ))
}

/// Evaluate JS in the embedded webview and return the JSON-serialized result.
/// Bridges Tauri's callback-style `eval_with_callback` (the only result-bearing
/// eval available on WKWebView/WebView2/WebKitGTK) to an async command via a
/// oneshot channel with a timeout.
#[cfg(desktop)]
pub(crate) async fn eval_embed_with_result(app: &AppHandle, js: &str) -> Result<String, String> {
    use std::sync::{Arc, Mutex};
    use tauri::Manager;
    let wv = app
        .get_webview(EMBED_LABEL)
        .ok_or_else(|| "embedded preview is not open".to_string())?;
    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    let slot = Arc::new(Mutex::new(Some(tx)));
    let cb = slot.clone();
    wv.eval_with_callback(js, move |result| {
        if let Ok(mut guard) = cb.lock() {
            if let Some(sender) = guard.take() {
                let _ = sender.send(result);
            }
        }
    })
    .map_err(|e| e.to_string())?;
    match tokio::time::timeout(std::time::Duration::from_secs(10), rx).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(_)) => Err("embedded eval channel closed".to_string()),
        Err(_) => Err("embedded eval timed out".to_string()),
    }
}

/// wry serializes the JS result into a JSON string before handing it to the
/// callback (tauri `Webview::eval_with_callback`), so a page helper returning a
/// JS *string* arrives here JSON-quoted. Peel exactly one layer.
///
/// Defensive by construction: a value that is not a JSON string literal (a bare
/// `true`, or an already-unwrapped payload) fails to parse and passes through
/// unchanged — so this is correct whether or not the runtime quotes it.
#[cfg(desktop)]
fn unwrap_js_string(raw: String) -> String {
    serde_json::from_str::<String>(&raw).unwrap_or(raw)
}

/// Snapshot the embedded page's accessibility tree (JSON envelope from
/// `__cogniaSnapshot`). `args` is an optional JSON options string
/// (`{"includeText":true}`) forwarded verbatim to the page helper; absent → the
/// lean default (interactive nodes only).
#[tauri::command]
pub async fn browser_embed_snapshot(
    app: AppHandle,
    invoking_window: WebviewWindow,
    lease: State<'_, EmbeddedBrowserLease>,
    owner_token: String,
    args: Option<String>,
) -> Result<String, String> {
    lease.assert_owner(&owner_token, invoking_window.label())?;
    #[cfg(desktop)]
    {
        let opts = args.unwrap_or_else(|| "{}".to_string());
        let call = format!("window.__cogniaSnapshot({})", js_string(&opts)?);
        // `__cogniaSnapshot` returns a JSON *string*; peel wry's quoting so the
        // client's single `JSON.parse` lands on the envelope object.
        Ok(unwrap_js_string(eval_embed_with_result(&app, &call).await?))
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, args);
        Err("desktop only".to_string())
    }
}

/// Pull buffered element selections after the sentinel emitted a small signal.
#[tauri::command]
pub async fn browser_embed_drain_selection(
    app: AppHandle,
    invoking_window: WebviewWindow,
    lease: State<'_, EmbeddedBrowserLease>,
    owner_token: String,
) -> Result<String, String> {
    lease.assert_owner(&owner_token, invoking_window.label())?;
    #[cfg(desktop)]
    {
        let raw = eval_embed_with_result(&app, "window.__cogniaGetSelection()").await?;
        normalize_selection_drain(raw, EMBED_LABEL)
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Err("desktop only".to_string())
    }
}

/// A strict aggregate cap for the complete selection envelope. This is checked
/// before and after pane-id enrichment so a page that replaces the public drain
/// helper cannot make Rust forward an unbounded value to the renderer.
#[cfg(desktop)]
const MAX_SELECTION_DRAIN_BYTES: usize = 200_000;

#[cfg(desktop)]
fn normalize_selection_drain(raw: String, pane_label: &str) -> Result<String, String> {
    let raw = unwrap_js_string(raw);
    if raw.len() > MAX_SELECTION_DRAIN_BYTES {
        return Err("selection drain exceeds byte limit".to_string());
    }
    let mut envelope: serde_json::Value =
        serde_json::from_str(&raw).map_err(|_| "invalid selection drain envelope".to_string())?;
    let selections = envelope
        .get_mut("selections")
        .and_then(serde_json::Value::as_array_mut)
        .ok_or_else(|| "invalid selection drain envelope".to_string())?;
    if selections.len() > 20 {
        return Err("selection drain exceeds item limit".to_string());
    }
    for selection in selections {
        let object = selection
            .as_object_mut()
            .ok_or_else(|| "invalid selection drain payload".to_string())?;
        object.insert(
            "paneId".to_string(),
            serde_json::Value::String(pane_label.to_string()),
        );
    }
    let normalized = serde_json::to_string(&envelope).map_err(|error| error.to_string())?;
    if normalized.len() > MAX_SELECTION_DRAIN_BYTES {
        return Err("selection drain exceeds byte limit".to_string());
    }
    Ok(normalized)
}

/// Cap on the serialized result of `browser_embed_evaluate` so a runaway
/// expression (e.g. `document.documentElement.outerHTML` on a huge page) can't
/// flood the model context.
#[cfg(desktop)]
const MAX_EVAL_RESULT: usize = 200_000;

#[cfg(desktop)]
fn truncate_eval(mut raw: String) -> String {
    if raw.len() > MAX_EVAL_RESULT {
        raw.truncate(MAX_EVAL_RESULT);
        raw.push_str("…(truncated)");
    }
    raw
}

/// Evaluate a JS *expression* in the embedded page and return a JSON envelope
/// `{"ok":true,"value":…}` / `{"ok":false,"error":…}`. The expression is wrapped
/// so its value is JSON-serialized and exceptions become values (never crashing
/// the eval bridge). Trust-tier gating lives in the calling plugin tool — the
/// embedded engine only ever evaluates against the page it was told to.
#[tauri::command]
pub async fn browser_embed_evaluate(
    app: AppHandle,
    invoking_window: WebviewWindow,
    lease: State<'_, EmbeddedBrowserLease>,
    owner_token: String,
    expr: String,
) -> Result<String, String> {
    lease.assert_owner(&owner_token, invoking_window.label())?;
    #[cfg(desktop)]
    {
        let wrapped = format!(
            "(function(){{try{{return JSON.stringify({{ok:true,value:({})}});}}catch(e){{return JSON.stringify({{ok:false,error:String(e)}});}}}})()",
            expr
        );
        let raw = eval_embed_with_result(&app, &wrapped).await?;
        // Unwrap *before* truncating: truncating the JSON-quoted form would
        // leave an unterminated string literal that no longer parses, silently
        // falling back to the quoted payload.
        Ok(truncate_eval(unwrap_js_string(raw)))
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, expr);
        Err("desktop only".to_string())
    }
}

/// Whether the embedded page currently has an element matching `selector`.
#[tauri::command]
pub async fn browser_embed_has_selector(
    app: AppHandle,
    invoking_window: WebviewWindow,
    lease: State<'_, EmbeddedBrowserLease>,
    owner_token: String,
    selector: String,
) -> Result<bool, String> {
    lease.assert_owner(&owner_token, invoking_window.label())?;
    #[cfg(desktop)]
    {
        let call = format!("window.__cogniaHasSelector({})", js_string(&selector)?);
        let raw = eval_embed_with_result(&app, &call).await?;
        Ok(raw.trim() == "true")
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, selector);
        Err("desktop only".to_string())
    }
}

/// In-flight + completed request counters (JSON `{"pending":n,"completed":m}`)
/// used to detect network idle.
#[tauri::command]
pub async fn browser_embed_network_state(
    app: AppHandle,
    invoking_window: WebviewWindow,
    lease: State<'_, EmbeddedBrowserLease>,
    owner_token: String,
) -> Result<String, String> {
    lease.assert_owner(&owner_token, invoking_window.label())?;
    #[cfg(desktop)]
    {
        Ok(unwrap_js_string(
            eval_embed_with_result(&app, "window.__cogniaNetworkState()").await?,
        ))
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Err("desktop only".to_string())
    }
}

/// Perform an act-by-ref (`click`/`type`/`fill`/`select`/`hover`/`focus`).
#[tauri::command]
pub async fn browser_embed_act(
    app: AppHandle,
    invoking_window: WebviewWindow,
    lease: State<'_, EmbeddedBrowserLease>,
    owner_token: String,
    reference: String,
    action: String,
    args: String,
) -> Result<String, String> {
    lease.assert_owner(&owner_token, invoking_window.label())?;
    #[cfg(desktop)]
    {
        let call = build_act_call(&reference, &action, &args)?;
        Ok(unwrap_js_string(eval_embed_with_result(&app, &call).await?))
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, reference, action, args);
        Err("desktop only".to_string())
    }
}

#[tauri::command]
pub async fn browser_embed_drain_console(
    app: AppHandle,
    invoking_window: WebviewWindow,
    lease: State<'_, EmbeddedBrowserLease>,
    owner_token: String,
) -> Result<String, String> {
    lease.assert_owner(&owner_token, invoking_window.label())?;
    #[cfg(desktop)]
    {
        Ok(unwrap_js_string(
            eval_embed_with_result(&app, "window.__cogniaDrainConsole()").await?,
        ))
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Err("desktop only".to_string())
    }
}

#[tauri::command]
pub async fn browser_embed_drain_network(
    app: AppHandle,
    invoking_window: WebviewWindow,
    lease: State<'_, EmbeddedBrowserLease>,
    owner_token: String,
) -> Result<String, String> {
    lease.assert_owner(&owner_token, invoking_window.label())?;
    #[cfg(desktop)]
    {
        Ok(unwrap_js_string(
            eval_embed_with_result(&app, "window.__cogniaDrainNetwork()").await?,
        ))
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Err("desktop only".to_string())
    }
}

/// Build the `window.__cogniaRefFor(selector)` call string.
#[cfg(desktop)]
fn build_ref_for_call(selector: &str) -> Result<String, String> {
    Ok(format!("window.__cogniaRefFor({})", js_string(selector)?))
}

/// Resolve a CSS selector to a snapshot ref so replay can act by ref (ADR-0072).
/// Returns "" when the selector matches nothing.
#[tauri::command]
pub async fn browser_embed_ref_for(
    app: AppHandle,
    invoking_window: WebviewWindow,
    lease: State<'_, EmbeddedBrowserLease>,
    owner_token: String,
    selector: String,
) -> Result<String, String> {
    lease.assert_owner(&owner_token, invoking_window.label())?;
    #[cfg(desktop)]
    {
        let call = build_ref_for_call(&selector)?;
        // `__cogniaRefFor` returns a JS string, so peel wry's quoting: otherwise
        // every `refMap` lookup misses on a quoted ref, and the documented
        // ""-on-no-match arrives as the *truthy* `"\"\""`.
        Ok(unwrap_js_string(eval_embed_with_result(&app, &call).await?))
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, selector);
        Err("desktop only".to_string())
    }
}

/// Arm action recording in the previewed page (ADR-0072). The page keeps the
/// buffer and mirrors it to sessionStorage so it survives a same-origin
/// navigation; the renderer polls `browser_embed_drain_record` and re-arms on
/// `browser://loaded` for the cross-origin case.
#[tauri::command]
pub async fn browser_embed_start_record(
    app: AppHandle,
    invoking_window: WebviewWindow,
    lease: State<'_, EmbeddedBrowserLease>,
    owner_token: String,
) -> Result<String, String> {
    lease.assert_owner(&owner_token, invoking_window.label())?;
    #[cfg(desktop)]
    {
        Ok(unwrap_js_string(
            eval_embed_with_result(&app, "window.__cogniaStartRecord()").await?,
        ))
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Err("desktop only".to_string())
    }
}

/// Re-arm recording after a navigation WITHOUT discarding the page's buffer.
/// See `resumeRecord` in the overlay: on a same-origin navigation the buffer
/// survived in sessionStorage and starting a fresh take would drop the click
/// that caused the navigation.
#[tauri::command]
pub async fn browser_embed_resume_record(
    app: AppHandle,
    invoking_window: WebviewWindow,
    lease: State<'_, EmbeddedBrowserLease>,
    owner_token: String,
) -> Result<String, String> {
    lease.assert_owner(&owner_token, invoking_window.label())?;
    #[cfg(desktop)]
    {
        Ok(unwrap_js_string(
            eval_embed_with_result(&app, "window.__cogniaResumeRecord()").await?,
        ))
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Err("desktop only".to_string())
    }
}

#[tauri::command]
pub async fn browser_embed_stop_record(
    app: AppHandle,
    invoking_window: WebviewWindow,
    lease: State<'_, EmbeddedBrowserLease>,
    owner_token: String,
) -> Result<String, String> {
    lease.assert_owner(&owner_token, invoking_window.label())?;
    #[cfg(desktop)]
    {
        Ok(unwrap_js_string(
            eval_embed_with_result(&app, "window.__cogniaStopRecord()").await?,
        ))
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Err("desktop only".to_string())
    }
}

/// Take the steps buffered since the last drain, as a JSON array.
#[tauri::command]
pub async fn browser_embed_drain_record(
    app: AppHandle,
    invoking_window: WebviewWindow,
    lease: State<'_, EmbeddedBrowserLease>,
    owner_token: String,
) -> Result<String, String> {
    lease.assert_owner(&owner_token, invoking_window.label())?;
    #[cfg(desktop)]
    {
        // `__cogniaDrainRecord` returns a JSON array *as a string*: without this
        // peel the client parses `"[]"` into the 2-char string `[]`, whose
        // `.length === 2` slips past the empty-guard in `recording/recorder.ts`
        // and gets iterated character by character.
        Ok(unwrap_js_string(
            eval_embed_with_result(&app, "window.__cogniaDrainRecord()").await?,
        ))
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Err("desktop only".to_string())
    }
}

#[tauri::command]
pub async fn browser_embed_back(
    app: AppHandle,
    invoking_window: WebviewWindow,
    lease: State<'_, EmbeddedBrowserLease>,
    owner_token: String,
) -> Result<(), String> {
    lease.assert_owner(&owner_token, invoking_window.label())?;
    #[cfg(desktop)]
    {
        eval_embed(&app, "window.history.back()")
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Err("desktop only".to_string())
    }
}

#[tauri::command]
pub async fn browser_embed_forward(
    app: AppHandle,
    invoking_window: WebviewWindow,
    lease: State<'_, EmbeddedBrowserLease>,
    owner_token: String,
) -> Result<(), String> {
    lease.assert_owner(&owner_token, invoking_window.label())?;
    #[cfg(desktop)]
    {
        eval_embed(&app, "window.history.forward()")
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Err("desktop only".to_string())
    }
}

#[tauri::command]
pub async fn browser_embed_stop(
    app: AppHandle,
    invoking_window: WebviewWindow,
    lease: State<'_, EmbeddedBrowserLease>,
    owner_token: String,
) -> Result<(), String> {
    lease.assert_owner(&owner_token, invoking_window.label())?;
    #[cfg(desktop)]
    {
        eval_embed(&app, "window.stop()")
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Err("desktop only".to_string())
    }
}

/// Whether the embedded page's visible text currently contains `text`.
/// (`__cogniaHasText` returns a boolean; `eval_with_callback` serializes it to
/// the JSON literal `true`/`false`.)
#[tauri::command]
pub async fn browser_embed_has_text(
    app: AppHandle,
    invoking_window: WebviewWindow,
    lease: State<'_, EmbeddedBrowserLease>,
    owner_token: String,
    text: String,
) -> Result<bool, String> {
    lease.assert_owner(&owner_token, invoking_window.label())?;
    #[cfg(desktop)]
    {
        let call = format!("window.__cogniaHasText({})", js_string(&text)?);
        let raw = eval_embed_with_result(&app, &call).await?;
        Ok(raw.trim() == "true")
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, text);
        Err("desktop only".to_string())
    }
}

#[tauri::command]
pub async fn browser_embed_get_url(
    app: AppHandle,
    invoking_window: WebviewWindow,
    lease: State<'_, EmbeddedBrowserLease>,
    owner_token: String,
) -> Result<String, String> {
    lease.assert_owner(&owner_token, invoking_window.label())?;
    #[cfg(desktop)]
    {
        Ok(unwrap_js_string(
            eval_embed_with_result(&app, "String(window.location.href)").await?,
        ))
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Err("desktop only".to_string())
    }
}

#[tauri::command]
pub async fn browser_embed_get_title(
    app: AppHandle,
    invoking_window: WebviewWindow,
    lease: State<'_, EmbeddedBrowserLease>,
    owner_token: String,
) -> Result<String, String> {
    lease.assert_owner(&owner_token, invoking_window.label())?;
    #[cfg(desktop)]
    {
        Ok(unwrap_js_string(
            eval_embed_with_result(&app, "String(document.title)").await?,
        ))
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Err("desktop only".to_string())
    }
}

#[tauri::command]
pub async fn browser_embed_navigate(
    app: AppHandle,
    invoking_window: WebviewWindow,
    lease: State<'_, EmbeddedBrowserLease>,
    owner_token: String,
    url: String,
) -> Result<(), String> {
    let parsed = validate_external_url(&url)?;
    lease.assert_owner(&owner_token, invoking_window.label())?;
    #[cfg(desktop)]
    {
        let proxy_url = resolve_webview_proxy_url(&parsed, &crate::proxy_config::current())?;
        navigate_existing_embed(&app, lease.inner(), parsed, proxy_url).await
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, parsed);
        Err("desktop only".to_string())
    }
}

#[tauri::command]
pub async fn browser_embed_reload(
    app: AppHandle,
    invoking_window: WebviewWindow,
    lease: State<'_, EmbeddedBrowserLease>,
    owner_token: String,
) -> Result<(), String> {
    lease.assert_owner(&owner_token, invoking_window.label())?;
    #[cfg(desktop)]
    {
        use tauri::Manager;
        // Native reload for the same robustness as `browser_embed_navigate`.
        app.get_webview(EMBED_LABEL)
            .ok_or_else(|| "embedded preview is not open".to_string())?
            .reload()
            .map_err(|e| e.to_string())
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Err("desktop only".to_string())
    }
}

/// Clamp a requested page zoom factor to the supported range. Non-finite input
/// (NaN / ±∞) falls back to 1.0 (100%).
fn clamp_zoom(zoom: f64) -> f64 {
    if !zoom.is_finite() {
        return 1.0;
    }
    zoom.clamp(0.25, 5.0)
}

#[tauri::command]
pub async fn browser_embed_set_zoom(
    app: AppHandle,
    invoking_window: WebviewWindow,
    lease: State<'_, EmbeddedBrowserLease>,
    owner_token: String,
    zoom: f64,
) -> Result<(), String> {
    lease.assert_owner(&owner_token, invoking_window.label())?;
    let zoom = clamp_zoom(zoom);
    #[cfg(desktop)]
    {
        use tauri::Manager;
        // Native page zoom persists at the webview level across navigations
        // (WKWebView / WebView2 / WebKitGTK all keep it), so this is one call
        // and the reserved rect never changes.
        app.get_webview(EMBED_LABEL)
            .ok_or_else(|| "embedded preview is not open".to_string())?
            .set_zoom(zoom)
            .map_err(|e| e.to_string())
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, zoom);
        Err("desktop only".to_string())
    }
}

#[tauri::command]
pub async fn browser_embed_set_select_mode(
    app: AppHandle,
    invoking_window: WebviewWindow,
    lease: State<'_, EmbeddedBrowserLease>,
    owner_token: String,
    on: bool,
) -> Result<(), String> {
    lease.assert_owner(&owner_token, invoking_window.label())?;
    #[cfg(desktop)]
    {
        eval_embed(&app, &format!("window.__cogniaSetSelectMode({})", on))
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, on);
        Err("desktop only".to_string())
    }
}

/// Tear down the post-selection info panel + outline in the previewed page.
/// Driven by the preview pane when the comment box is cancelled or sent.
#[tauri::command]
pub async fn browser_embed_clear_selection(
    app: AppHandle,
    invoking_window: WebviewWindow,
    lease: State<'_, EmbeddedBrowserLease>,
    owner_token: String,
) -> Result<(), String> {
    lease.assert_owner(&owner_token, invoking_window.label())?;
    #[cfg(desktop)]
    {
        eval_embed(&app, "window.__cogniaClearSelection()")
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Err("desktop only".to_string())
    }
}

/// Build the `window.__cogniaSetPanelLabels(<json>)` call. `labels_json` is a
/// JSON object string passed *as a JS string literal* (double-encoded) so the
/// page can `JSON.parse` it back — the injected overlay can't reach next-intl,
/// so React pushes the localized toggle labels down this channel.
#[cfg(desktop)]
fn build_set_panel_labels_call(labels_json: &str) -> Result<String, String> {
    Ok(format!(
        "window.__cogniaSetPanelLabels({})",
        js_string(labels_json)?
    ))
}

/// Push localized info-panel toggle labels (a `{"details":…,"collapse":…}` JSON
/// string) into the previewed page.
#[tauri::command]
pub async fn browser_embed_set_panel_labels(
    app: AppHandle,
    invoking_window: WebviewWindow,
    lease: State<'_, EmbeddedBrowserLease>,
    owner_token: String,
    labels: String,
) -> Result<(), String> {
    lease.assert_owner(&owner_token, invoking_window.label())?;
    #[cfg(desktop)]
    {
        eval_embed(&app, &build_set_panel_labels_call(&labels)?)
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, labels);
        Err("desktop only".to_string())
    }
}

#[cfg(desktop)]
fn build_set_frozen_call(on: bool) -> String {
    format!("window.__cogniaSetFrozen({on})")
}

#[cfg(desktop)]
fn parse_set_frozen_result(raw: String) -> Result<(), String> {
    let envelope = unwrap_js_string(raw);
    let value: serde_json::Value =
        serde_json::from_str(&envelope).map_err(|e| format!("invalid freeze response: {e}"))?;
    if value.get("ok").and_then(serde_json::Value::as_bool) == Some(true) {
        Ok(())
    } else {
        Err(value
            .get("error")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("freeze failed")
            .to_string())
    }
}

/// Pause page animations and timers around an on-screen embedded capture.
#[tauri::command]
pub async fn browser_embed_set_frozen(
    app: AppHandle,
    invoking_window: WebviewWindow,
    lease: State<'_, EmbeddedBrowserLease>,
    owner_token: String,
    on: bool,
) -> Result<(), String> {
    lease.assert_owner(&owner_token, invoking_window.label())?;
    #[cfg(desktop)]
    {
        let raw = eval_embed_with_result(&app, &build_set_frozen_call(on)).await?;
        parse_set_frozen_result(raw)
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, on);
        Err("desktop only".to_string())
    }
}

/// Capture the embedded preview's on-screen region as a PNG. `x,y,width,height`
/// are the reserved rect (logical px, window-relative). Reuses the automation
/// screenshot pipeline (`capture_primary`) but bypasses its consent/audit gate —
/// this is our own embedded preview, not arbitrary screen content.
#[tauri::command]
pub async fn browser_embed_capture(
    app: AppHandle,
    invoking_window: WebviewWindow,
    lease: State<'_, EmbeddedBrowserLease>,
    owner_token: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<Screenshot, String> {
    lease.assert_owner(&owner_token, invoking_window.label())?;
    #[cfg(desktop)]
    {
        use tauri::Manager;
        let win = app
            .get_webview_window("main")
            .ok_or_else(|| "main window not found".to_string())?;
        let inner = win.inner_position().map_err(|e| e.to_string())?;
        let scale = win.scale_factor().map_err(|e| e.to_string())?;
        let monitor_origin = app
            .primary_monitor()
            .ok()
            .flatten()
            .map(|m| {
                let p = m.position();
                (p.x, p.y)
            })
            .unwrap_or((0, 0));
        let region = compute_embed_capture_region(
            (inner.x, inner.y),
            (x, y, width, height),
            scale,
            monitor_origin,
        );
        let opts = crate::automation::types::ScreenshotOpts {
            region: Some(region),
            format: None,
            monitor_id: None,
        };
        crate::automation::platform::shared::screenshot::capture_primary(&opts)
            .map_err(|e| e.to_string())
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, x, y, width, height);
        Err("desktop only".to_string())
    }
}

#[tauri::command]
pub async fn browser_embed_destroy(
    app: AppHandle,
    invoking_window: WebviewWindow,
    lease: State<'_, EmbeddedBrowserLease>,
    owner_token: String,
) -> Result<(), String> {
    let window_label = invoking_window.label();
    lease.assert_owner(&owner_token, window_label)?;
    #[cfg(desktop)]
    {
        close_embed_webview(&app).await?;
        lease.clear_webview_proxy();
        lease.release(&owner_token, window_label)?;
        Ok(())
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        lease.clear_webview_proxy();
        lease.release(&owner_token, window_label)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embed_label_is_stable() {
        assert_eq!(EMBED_LABEL, "browser-embed");
    }

    #[test]
    fn webview_proxy_routes_baidu_through_the_active_proxy() {
        use crate::proxy_config::{ProxyConfig, ProxyMode, ProxyProtocol};

        let target = url::Url::parse("https://www.baidu.com/").unwrap();
        let proxy = ProxyConfig {
            mode: ProxyMode::Manual,
            protocol: ProxyProtocol::Http,
            host: "127.0.0.1".to_string(),
            port: 7890,
            ..ProxyConfig::default()
        };

        assert_eq!(
            resolve_webview_proxy_url(&target, &proxy)
                .unwrap()
                .map(|url| url.to_string()),
            Some("http://127.0.0.1:7890/".to_string())
        );
    }

    #[test]
    fn webview_proxy_honors_the_target_bypass_list() {
        use crate::proxy_config::{ProxyConfig, ProxyMode, ProxyProtocol};

        let target = url::Url::parse("https://www.baidu.com/").unwrap();
        let proxy = ProxyConfig {
            mode: ProxyMode::Manual,
            protocol: ProxyProtocol::Http,
            host: "127.0.0.1".to_string(),
            port: 7890,
            bypass: vec![".baidu.com".to_string()],
            ..ProxyConfig::default()
        };

        assert_eq!(resolve_webview_proxy_url(&target, &proxy).unwrap(), None);
    }

    #[test]
    fn webview_proxy_rejects_unsupported_https_proxy_endpoints() {
        use crate::proxy_config::{ProxyConfig, ProxyMode, ProxyProtocol};

        let target = url::Url::parse("https://www.baidu.com/").unwrap();
        let proxy = ProxyConfig {
            mode: ProxyMode::Manual,
            protocol: ProxyProtocol::Https,
            host: "proxy.example.com".to_string(),
            port: 8443,
            ..ProxyConfig::default()
        };

        assert_eq!(
            resolve_webview_proxy_url(&target, &proxy).unwrap_err(),
            "embedded browser does not support https proxy URLs"
        );
    }

    #[test]
    fn webview_proxy_skips_inactive_configuration() {
        let target = url::Url::parse("https://www.baidu.com/").unwrap();

        assert_eq!(
            resolve_webview_proxy_url(&target, &crate::proxy_config::ProxyConfig::default())
                .unwrap(),
            None
        );
    }

    #[test]
    fn webview_proxy_accepts_socks5_endpoints() {
        use crate::proxy_config::{ProxyConfig, ProxyMode, ProxyProtocol};

        let target = url::Url::parse("https://www.baidu.com/").unwrap();
        let proxy = ProxyConfig {
            mode: ProxyMode::Manual,
            protocol: ProxyProtocol::Socks5,
            host: "127.0.0.1".to_string(),
            port: 1080,
            ..ProxyConfig::default()
        };

        assert_eq!(
            resolve_webview_proxy_url(&target, &proxy)
                .unwrap()
                .map(|url| url.to_string()),
            Some("socks5://127.0.0.1:1080".to_string())
        );
    }

    #[test]
    fn webview_proxy_rejects_malformed_proxy_urls() {
        use crate::proxy_config::{ProxyConfig, ProxyMode, ProxyProtocol};

        let target = url::Url::parse("https://www.baidu.com/").unwrap();
        let proxy = ProxyConfig {
            mode: ProxyMode::Manual,
            protocol: ProxyProtocol::Http,
            host: "bad host".to_string(),
            port: 7890,
            ..ProxyConfig::default()
        };

        assert!(resolve_webview_proxy_url(&target, &proxy)
            .unwrap_err()
            .starts_with("invalid browser proxy URL:"));
    }

    #[test]
    fn webview_proxy_transition_requires_recreation_after_creation() {
        let lease = EmbeddedBrowserLease::default();
        let direct = None;
        let proxy_a = Some(url::Url::parse("http://127.0.0.1:7890").unwrap());
        let proxy_b = Some(url::Url::parse("socks5://127.0.0.1:1080").unwrap());

        assert!(!lease.requires_webview_recreation(&direct));
        lease.record_webview_proxy(&direct);
        assert!(!lease.requires_webview_recreation(&direct));
        assert!(lease.requires_webview_recreation(&proxy_a));

        lease.record_webview_proxy(&proxy_a);
        assert!(!lease.requires_webview_recreation(&proxy_a));
        assert!(lease.requires_webview_recreation(&direct));
        assert!(lease.requires_webview_recreation(&proxy_b));
    }

    #[test]
    fn embedded_browser_lease_rejects_cross_surface_mutations() {
        let lease = EmbeddedBrowserLease::default();
        assert_eq!(lease.claim("sites:one", "main"), Ok(true));
        assert_eq!(lease.claim("sites:one", "main"), Ok(false));
        assert!(lease.claim("browser:two", "secondary").is_err());
        assert!(lease.assert_owner("browser:two", "secondary").is_err());
        assert!(lease.release("browser:two", "secondary").is_err());
        assert!(lease.release("sites:one", "main").is_ok());
        assert_eq!(lease.claim("browser:two", "secondary"), Ok(true));
    }

    #[test]
    fn embedded_browser_lease_recovers_after_renderer_reload_and_window_close() {
        let lease = EmbeddedBrowserLease::default();
        assert_eq!(lease.claim("sites:old", "main"), Ok(true));
        assert_eq!(lease.claim("sites:new", "main"), Ok(true));
        assert!(lease.assert_owner("sites:old", "main").is_err());
        assert!(lease.assert_owner("sites:new", "main").is_ok());

        lease.release_window("secondary");
        assert!(lease.assert_owner("sites:new", "main").is_ok());
        lease.release_window("main");
        assert_eq!(lease.claim("browser:next", "secondary"), Ok(true));
    }

    #[test]
    fn embedded_browser_lease_release_is_atomic() {
        let lease = EmbeddedBrowserLease::default();
        assert_eq!(lease.claim("sites:one", "main"), Ok(true));
        assert!(lease.release("sites:one", "main").is_ok());
        assert_eq!(lease.claim("sites:two", "main"), Ok(true));
        assert!(lease.release("sites:one", "main").is_err());
        assert!(lease.assert_owner("sites:two", "main").is_ok());
    }

    #[test]
    fn embedded_browser_failed_creation_rolls_back_new_reservation() {
        let lease = EmbeddedBrowserLease::default();
        let newly_claimed = lease.claim("sites:failed", "main").unwrap();
        lease.rollback_claim("sites:failed", "main", newly_claimed);
        assert_eq!(lease.claim("browser:retry", "secondary"), Ok(true));
    }

    #[cfg(desktop)]
    #[test]
    fn logical_rect_maps_fields() {
        let r = logical_rect(10.0, 20.0, 100.0, 40.0);
        // Round-trips through the Logical variants.
        assert!(matches!(r.position, tauri::Position::Logical(_)));
        assert!(matches!(r.size, tauri::Size::Logical(_)));
    }

    #[cfg(desktop)]
    #[test]
    fn embed_capture_region_scales_and_offsets() {
        // Window content origin at physical (100, 50); embed at logical (10, 20)
        // sized 200x100; 2x display; primary monitor at origin.
        let r = compute_embed_capture_region((100, 50), (10.0, 20.0, 200.0, 100.0), 2.0, (0, 0));
        assert_eq!((r.x, r.y, r.width, r.height), (120, 90, 400, 200));
    }

    #[cfg(desktop)]
    #[test]
    fn embed_capture_region_subtracts_monitor_origin() {
        let r = compute_embed_capture_region((1920, 0), (0.0, 0.0, 50.0, 50.0), 1.0, (1920, 0));
        assert_eq!((r.x, r.y, r.width, r.height), (0, 0, 50, 50));
    }

    #[cfg(desktop)]
    #[test]
    fn act_call_is_json_safe() {
        let call = build_act_call("e1", "fill", r#"{"text":"a\"b"}"#).unwrap();
        assert!(call.starts_with("window.__cogniaAct("));
        assert!(call.contains(r#""e1""#));
        assert!(call.contains(r#""fill""#));
        // The args JSON is itself passed as a JS string literal (double-encoded),
        // so the inner quote is escaped twice.
        assert!(call.contains("a\\\\\\\""));
    }

    #[cfg(desktop)]
    #[test]
    fn act_call_escapes_injection_in_ref() {
        let call = build_act_call(r#"e"); alert(1)//"#, "click", "{}").unwrap();
        // The malicious ref is contained inside a JSON string literal.
        assert!(call.contains(r#"alert(1)"#));
        assert!(!call.contains(r#"e"); alert"#));
    }

    #[cfg(desktop)]
    #[test]
    fn panel_labels_call_passes_json_as_a_string_literal() {
        let call = build_set_panel_labels_call(r#"{"details":"详情","collapse":"收起"}"#).unwrap();
        assert!(call.starts_with("window.__cogniaSetPanelLabels("));
        // The JSON is a JS string literal (double-encoded), so its inner quotes
        // are escaped — the page `JSON.parse`s it back.
        assert!(call.contains(r#"\"details\""#));
        assert!(call.contains("详情"));
    }

    #[cfg(desktop)]
    #[test]
    fn set_frozen_call_marshals_the_boolean_literal() {
        assert_eq!(
            build_set_frozen_call(true),
            "window.__cogniaSetFrozen(true)"
        );
        assert_eq!(
            build_set_frozen_call(false),
            "window.__cogniaSetFrozen(false)"
        );
    }

    #[cfg(desktop)]
    #[test]
    fn set_frozen_result_parses_success_and_page_errors() {
        let success = serde_json::to_string(r#"{"ok":true,"error":null,"frozen":true}"#).unwrap();
        let failure =
            serde_json::to_string(r#"{"ok":false,"error":"paint failed","frozen":true}"#).unwrap();
        assert_eq!(parse_set_frozen_result(success), Ok(()));
        assert_eq!(
            parse_set_frozen_result(failure),
            Err("paint failed".to_string())
        );
    }

    #[cfg(desktop)]
    #[test]
    fn set_frozen_result_rejects_malformed_envelopes() {
        assert!(parse_set_frozen_result(r#"\"not-json\""#.to_string())
            .unwrap_err()
            .starts_with("invalid freeze response:"));
    }

    #[cfg(desktop)]
    #[test]
    fn unwrap_js_string_peels_exactly_one_json_layer() {
        // wry hands us the JS string `[]` as the JSON literal `"[]"`.
        assert_eq!(unwrap_js_string(r#""[]""#.to_string()), "[]");
        // A JSON envelope string keeps its inner structure after one peel.
        assert_eq!(
            unwrap_js_string(r#""{\"ok\":true}""#.to_string()),
            r#"{"ok":true}"#
        );
        // Escapes inside the string literal are decoded, not re-escaped.
        assert_eq!(unwrap_js_string(r#""a\"b""#.to_string()), r#"a"b"#);
        // The empty-ref contract: `""` must survive as a *falsy* empty string.
        assert_eq!(unwrap_js_string(r#""""#.to_string()), "");
    }

    #[cfg(desktop)]
    #[test]
    fn unwrap_js_string_passes_through_non_string_json() {
        // JS booleans serialize bare — `has_text`/`has_selector` rely on this.
        assert_eq!(unwrap_js_string("true".to_string()), "true");
        assert_eq!(unwrap_js_string("false".to_string()), "false");
        assert_eq!(unwrap_js_string("null".to_string()), "null");
        assert_eq!(unwrap_js_string("42".to_string()), "42");
    }

    #[cfg(desktop)]
    #[test]
    fn unwrap_js_string_passes_through_already_unwrapped_or_garbage() {
        // Already-unwrapped payloads are not JSON string literals → unchanged.
        assert_eq!(unwrap_js_string("[]".to_string()), "[]");
        assert_eq!(
            unwrap_js_string(r#"{"ok":true}"#.to_string()),
            r#"{"ok":true}"#
        );
        // Garbage / unterminated literals pass through rather than panicking.
        assert_eq!(unwrap_js_string(String::new()), "");
        assert_eq!(
            unwrap_js_string(r#""unterminated"#.to_string()),
            r#""unterminated"#
        );
        assert_eq!(unwrap_js_string("undefined".to_string()), "undefined");
    }

    #[cfg(desktop)]
    #[test]
    fn selection_drain_is_capped_and_enriched() {
        let normalized = normalize_selection_drain(
            r##"{"ok":true,"error":null,"selections":[{"selector":"#go"}]}"##.to_string(),
            "browser-embed",
        )
        .unwrap();
        let value: serde_json::Value = serde_json::from_str(&normalized).unwrap();
        assert_eq!(value["selections"][0]["paneId"], "browser-embed");

        let oversized = format!(
            r#"{{"ok":true,"selections":[{{"text":"{}"}}]}}"#,
            "x".repeat(MAX_SELECTION_DRAIN_BYTES)
        );
        assert_eq!(
            normalize_selection_drain(oversized, "browser-embed").unwrap_err(),
            "selection drain exceeds byte limit"
        );
    }

    #[cfg(desktop)]
    #[test]
    fn ref_for_call_is_json_safe() {
        let call = build_ref_for_call("#login > input[name=\"user\"]").unwrap();
        assert!(call.starts_with("window.__cogniaRefFor("));
        // The selector's own quotes are escaped inside the JS string literal.
        assert!(call.contains(r#"input[name=\"user\"]"#));
    }

    #[cfg(desktop)]
    #[test]
    fn ref_for_call_escapes_injection_in_selector() {
        let call = build_ref_for_call(r#"a"); alert(1)//"#).unwrap();
        // The malicious selector is contained inside a JSON string literal.
        assert!(call.contains(r#"alert(1)"#));
        assert!(!call.contains(r#"a"); alert"#));
    }

    #[cfg(desktop)]
    #[test]
    fn panel_labels_call_escapes_injection() {
        let call = build_set_panel_labels_call(r#"{"x":"a"});alert(1)//"#).unwrap();
        assert!(call.contains("alert(1)"));
        // The break-out attempt stays inside the string literal.
        assert!(!call.contains(r#"a"});alert"#));
    }

    #[test]
    fn clamp_zoom_bounds_and_rejects_non_finite() {
        assert_eq!(clamp_zoom(1.0), 1.0);
        assert_eq!(clamp_zoom(2.5), 2.5);
        // Out-of-range values saturate to the supported bounds.
        assert_eq!(clamp_zoom(0.1), 0.25);
        assert_eq!(clamp_zoom(9.0), 5.0);
        // Non-finite input falls back to 100%.
        assert_eq!(clamp_zoom(f64::NAN), 1.0);
        assert_eq!(clamp_zoom(f64::INFINITY), 1.0);
        assert_eq!(clamp_zoom(f64::NEG_INFINITY), 1.0);
    }
}

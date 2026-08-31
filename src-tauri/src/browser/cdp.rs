use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use tauri::{AppHandle, Manager, State, WebviewWindow};

use super::embedded::{eval_embed_with_result, EmbeddedBrowserLease, EMBED_LABEL};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCdpGrant {
    pub id: String,
    pub session_id: String,
    pub browser_session_id: String,
    pub origin: String,
    pub capabilities: Vec<String>,
    pub expires_at: i64,
}

#[derive(Default)]
pub struct NativeCdpGrants(parking_lot::Mutex<HashMap<String, NativeCdpGrant>>);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCdpResult {
    pub method: String,
    pub value: Value,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn normalized_origin(value: &str) -> Result<String, String> {
    let parsed = url::Url::parse(value).map_err(|_| "invalid CDP origin".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("CDP requires an HTTP(S) origin".to_string());
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "CDP origin requires a host".to_string())?;
    let mut origin = format!("{}://{}", parsed.scheme(), host);
    if let Some(port) = parsed.port() {
        origin.push(':');
        origin.push_str(&port.to_string());
    }
    Ok(origin)
}

fn capability_for_method(method: &str) -> Option<&'static str> {
    match method.split_once('.').map(|value| value.0) {
        Some("DOM") => Some("dom"),
        Some("Runtime") => Some("runtime"),
        // Console / Network / Performance are deliberately absent: this is an
        // eval bridge, not a CDP endpoint, and mapping those families only
        // produced grants whose every method fell through to "not implemented".
        // Console and network output are served by the overlay's push channels
        // instead (`browser://console` / `browser://network`).
        _ => None,
    }
}

fn validate_grant(grant: &NativeCdpGrant) -> Result<(), String> {
    if grant.id.trim().is_empty()
        || grant.session_id.trim().is_empty()
        || grant.browser_session_id.trim().is_empty()
    {
        return Err("CDP grant identity is required".to_string());
    }
    normalized_origin(&grant.origin)?;
    let now = now_ms();
    if grant.expires_at <= now || grant.expires_at > now + 60 * 60 * 1000 {
        return Err("CDP grant expiry must be within one hour".to_string());
    }
    if grant.capabilities.is_empty()
        || grant
            .capabilities
            .iter()
            .any(|value| !matches!(value.as_str(), "dom" | "runtime"))
    {
        return Err("CDP grant contains an unsupported capability".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn browser_cdp_grant(
    invoking_window: WebviewWindow,
    lease: State<'_, EmbeddedBrowserLease>,
    grants: State<'_, NativeCdpGrants>,
    owner_token: String,
    mut grant: NativeCdpGrant,
) -> Result<(), String> {
    lease.assert_owner(&owner_token, invoking_window.label())?;
    validate_grant(&grant)?;
    grant.origin = normalized_origin(&grant.origin)?;
    grants.0.lock().insert(grant.id.clone(), grant);
    Ok(())
}

#[tauri::command]
pub fn browser_cdp_revoke(
    invoking_window: WebviewWindow,
    lease: State<'_, EmbeddedBrowserLease>,
    grants: State<'_, NativeCdpGrants>,
    owner_token: String,
    grant_id: String,
) -> Result<(), String> {
    lease.assert_owner(&owner_token, invoking_window.label())?;
    grants.0.lock().remove(&grant_id);
    Ok(())
}

#[tauri::command]
// Tauri exposes command arguments as individual IPC fields; grouping them
// would change the public invoke payload.
#[allow(clippy::too_many_arguments)]
pub async fn browser_cdp_execute(
    app: AppHandle,
    invoking_window: WebviewWindow,
    lease: State<'_, EmbeddedBrowserLease>,
    grants: State<'_, NativeCdpGrants>,
    owner_token: String,
    grant_id: String,
    session_id: String,
    browser_session_id: String,
    page_url: String,
    capability: String,
    method: String,
    params: Value,
    execution_target: String,
) -> Result<NativeCdpResult, String> {
    lease.assert_owner(&owner_token, invoking_window.label())?;
    if execution_target != "local" {
        return Err("CDP is local-Tauri-only".to_string());
    }
    let grant = grants
        .0
        .lock()
        .get(&grant_id)
        .cloned()
        .ok_or_else(|| "CDP grant is missing".to_string())?;
    let requested_origin = normalized_origin(&page_url)?;
    let current_url = app
        .get_webview(EMBED_LABEL)
        .ok_or_else(|| "embedded preview is not open".to_string())?
        .url()
        .map_err(|error| error.to_string())?
        .as_str()
        .to_string();
    let method_capability =
        capability_for_method(&method).ok_or_else(|| "unsupported CDP method".to_string())?;
    if grant.session_id != session_id
        || grant.browser_session_id != browser_session_id
        || grant.origin != requested_origin
        || requested_origin != normalized_origin(&current_url)?
        || grant.expires_at <= now_ms()
        || method_capability != capability
        || !grant.capabilities.iter().any(|value| value == &capability)
    {
        return Err("CDP grant does not authorize this request".to_string());
    }

    let expression = match method.as_str() {
        "Runtime.evaluate" => params
            .get("expression")
            .and_then(Value::as_str)
            .ok_or_else(|| "Runtime.evaluate requires params.expression".to_string())?
            .to_string(),
        "DOM.getDocument" => {
            "({nodeId:1,nodeName:document.documentElement.nodeName,baseURL:document.baseURI})"
                .to_string()
        }
        _ => return Err(format!("CDP method is not implemented: {method}")),
    };
    let wrapped = format!(
        "(function(){{try{{return JSON.stringify({{ok:true,value:({})}});}}catch(e){{return JSON.stringify({{ok:false,error:String(e)}});}}}})()",
        expression
    );
    let raw = eval_embed_with_result(&app, &wrapped).await?;
    let value = serde_json::from_str(&raw).unwrap_or(Value::String(raw));
    Ok(NativeCdpResult { method, value })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_paths_and_maps_only_known_method_families() {
        assert_eq!(
            normalized_origin("http://localhost:3000/a?q=secret").unwrap(),
            "http://localhost:3000"
        );
        assert_eq!(capability_for_method("Runtime.evaluate"), Some("runtime"));
        assert_eq!(capability_for_method("DOM.getDocument"), Some("dom"));
        assert_eq!(capability_for_method("Storage.getCookies"), None);
    }

    /// Every capability a grant may hold must have at least one method behind
    /// it, or the UI offers authority that no action can ever spend. Console,
    /// network and performance were exactly that until they were dropped.
    #[test]
    fn every_grantable_capability_has_a_method_family() {
        let mut seen: Vec<&str> = ["DOM.getDocument", "Runtime.evaluate"]
            .into_iter()
            .filter_map(capability_for_method)
            .collect();
        seen.sort_unstable();
        assert_eq!(seen, ["dom", "runtime"]);

        for retired in [
            "Log.getEntries",
            "Console.clearMessages",
            "Network.getResponseBody",
            "Performance.getMetrics",
        ] {
            assert_eq!(
                capability_for_method(retired),
                None,
                "{retired} must not map"
            );
            let grant = NativeCdpGrant {
                id: "grant".into(),
                session_id: "session".into(),
                browser_session_id: "browser".into(),
                origin: "http://localhost:3000".into(),
                capabilities: vec![retired.split('.').next().unwrap().to_lowercase()],
                expires_at: now_ms() + 1000,
            };
            assert!(
                validate_grant(&grant).is_err(),
                "{retired} must not be grantable"
            );
        }
    }

    #[test]
    fn rejects_non_http_origins_and_invalid_capabilities() {
        assert!(normalized_origin("file:///tmp/index.html").is_err());
        let grant = NativeCdpGrant {
            id: "grant".into(),
            session_id: "session".into(),
            browser_session_id: "browser".into(),
            origin: "http://localhost:3000".into(),
            capabilities: vec!["storage".into()],
            expires_at: now_ms() + 1000,
        };
        assert!(validate_grant(&grant).is_err());
    }
}

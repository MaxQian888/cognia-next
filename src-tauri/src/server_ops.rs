//! Live operation events for the Servers workspace (ADR-0059).
//!
//! The Ops Controller publishes operation state changes on `GET /v1/events` as
//! Server-Sent Events. The renderer cannot consume that stream itself:
//!
//!   - the controller host is whatever the operator typed, so it is never on
//!     `tauri.conf.json`'s `connect-src` allowlist and a renderer `fetch` is
//!     blocked by CSP before it leaves the process;
//!   - the buffered `proxy_http_request` escape hatch resolves only when the
//!     body ends, and an SSE body never ends — it would deliver nothing at all;
//!   - `EventSource` cannot set `Authorization`, which the controller requires.
//!
//! So the stream lives here: one task per renderer subscription, forwarding
//! each decoded frame as a `server-ops://events/<stream_id>` Tauri event.
//!
//! Reconnection is the renderer's job, not this module's. It owns the OIDC
//! token (which may have been refreshed since the stream opened) and the
//! `Last-Event-ID` cursor, so it closes and reopens with fresh values rather
//! than having a native task retry with stale ones.

use std::sync::OnceLock;
use std::time::Duration;

use cognia_net::request_cancellation::RequestCancellationRegistry;
use cognia_net::sse_stream::{stream_sse_get, SseError, SseEvent};
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION};
use serde::Serialize;
use tauri::Emitter;

/// Bounds a controller that stops writing without closing the connection.
/// The controller's own keep-alive is every 15s, so silence past this is a
/// dead peer rather than a quiet one.
const EVENT_READ_TIMEOUT: Duration = Duration::from_secs(60);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

fn streams() -> &'static RequestCancellationRegistry {
    static STREAMS: OnceLock<RequestCancellationRegistry> = OnceLock::new();
    STREAMS.get_or_init(RequestCancellationRegistry::default)
}

/// One message on `server-ops://events/<stream_id>`.
///
/// `closed` is terminal and always arrives — on a clean end, on a transport
/// failure, and on cancellation — so the renderer's reconnect loop has exactly
/// one signal to wait for instead of inferring the end from silence.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum StreamMessage {
    Open,
    Event {
        #[serde(flatten)]
        event: SseEvent,
    },
    Closed {
        /// `None` on a clean end of stream; the transport error otherwise.
        error: Option<String>,
    },
}

fn stream_channel(stream_id: &str) -> String {
    format!("server-ops://events/{stream_id}")
}

/// Reject targets the controller contract already forbids, before dialling.
///
/// The renderer normalizes the controller URL the same way (`normalizeControllerUrl`
/// in `lib/server-ops/client.ts`), but this command is an outbound network
/// primitive reachable over the companion RPC plane too, so it re-checks rather
/// than trusting its caller. Loopback stays reachable on purpose: a controller
/// on `http://127.0.0.1:8080` is the documented local development target.
fn validate_controller_url(url: &str) -> Result<(), String> {
    let parsed =
        url::Url::parse(url).map_err(|error| format!("invalid controller URL: {error}"))?;
    let host = parsed.host_str().unwrap_or_default();
    // Never a valid controller, always a cloud-credential exfiltration target.
    if host == "169.254.169.254" {
        return Err("the link-local metadata endpoint is not a valid controller".to_string());
    }
    let loopback = matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]");
    match parsed.scheme() {
        "https" => Ok(()),
        "http" if loopback => Ok(()),
        _ => Err("the Ops Controller must use HTTPS outside loopback development".to_string()),
    }
}

fn build_headers(access_token: &str, last_event_id: Option<&str>) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();
    let token = access_token.trim();
    if token.is_empty() {
        return Err("an access token is required".to_string());
    }
    let mut authorization = HeaderValue::from_str(&format!("Bearer {token}"))
        .map_err(|_| "invalid access token for the Authorization header".to_string())?;
    // Keeps the bearer out of `{:?}` renderings of the header map, which is
    // what a `tracing` layer or a panic backtrace would print.
    authorization.set_sensitive(true);
    headers.insert(AUTHORIZATION, authorization);
    if let Some(cursor) = last_event_id.map(str::trim).filter(|id| !id.is_empty()) {
        let value = HeaderValue::from_str(cursor)
            .map_err(|_| "invalid Last-Event-ID cursor".to_string())?;
        headers.insert("last-event-id", value);
    }
    Ok(headers)
}

fn events_client(url: &str) -> Result<reqwest::Client, String> {
    let builder = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(EVENT_READ_TIMEOUT)
        .tcp_keepalive(Duration::from_secs(30));
    let (builder, _) = crate::proxy_config::apply_reqwest_policy(builder, url)
        .map_err(|error| error.to_string())?;
    builder
        .build()
        .map_err(|error| format!("client build failed: {error}"))
}

/// Describe a stream failure for the renderer's toast.
///
/// The controller answers a rejected subscription with its own JSON body
/// (`{"code":"insufficient_scope",…}`); passing that through unchanged is what
/// lets the UI tell an expired token apart from an unreachable host, which are
/// the two failures an operator actually acts on differently.
fn describe(error: SseError) -> String {
    match error {
        SseError::Status { status, body } if !body.trim().is_empty() => {
            format!("controller returned {status}: {body}")
        }
        other => other.to_string(),
    }
}

/// Subscribe to `<controller_url>/v1/events`, forwarding every frame to
/// `server-ops://events/<stream_id>` until the stream ends or
/// [`server_ops_events_close`] cancels it.
///
/// Returns as soon as the subscription is registered — the renderer learns the
/// outcome from the `open` / `closed` messages, so a controller that is slow to
/// answer never blocks the invoke.
#[tauri::command]
pub async fn server_ops_events_open(
    app: tauri::AppHandle,
    stream_id: String,
    controller_url: String,
    access_token: String,
    last_event_id: Option<String>,
) -> Result<(), String> {
    if stream_id.trim().is_empty() {
        return Err("streamId is required".to_string());
    }
    validate_controller_url(&controller_url)?;
    let url = format!("{}/v1/events", controller_url.trim_end_matches('/'));
    let headers = build_headers(&access_token, last_event_id.as_deref())?;
    let client = events_client(&url)?;

    // Registering before the task starts means a `close` racing the open still
    // cancels it, rather than leaking a task the renderer believes it stopped.
    let (generation, cancelled) = streams().register(&stream_id);
    let channel = stream_channel(&stream_id);

    tauri::async_runtime::spawn(async move {
        if let Err(error) = app.emit(&channel, StreamMessage::Open) {
            log::warn!("failed to emit server-ops stream open: {error}");
        }
        let mut on_event = |event: SseEvent| {
            if let Err(error) = app.emit(&channel, StreamMessage::Event { event }) {
                log::warn!("failed to emit server-ops operation event: {error}");
            }
        };
        let outcome = tokio::select! {
            biased;
            _ = cancelled => None,
            result = stream_sse_get(&client, &url, headers, &mut on_event) => {
                Some(result)
            }
        };
        let error = match outcome {
            // Cancelled by the renderer: still terminal, but not a failure.
            None => None,
            Some(Ok(_)) => None,
            Some(Err(error)) => Some(describe(error)),
        };
        streams().finish(&stream_id, generation);
        if let Err(emit_error) = app.emit(&channel, StreamMessage::Closed { error }) {
            log::warn!("failed to emit server-ops stream close: {emit_error}");
        }
    });

    Ok(())
}

/// Cancel a subscription opened by [`server_ops_events_open`].
///
/// Idempotent: closing an already-finished stream is the normal shape of a
/// React effect cleanup racing a server-side disconnect, not an error.
#[tauri::command]
pub async fn server_ops_events_close(stream_id: String) -> Result<bool, String> {
    Ok(streams().cancel(&stream_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_https_and_loopback_http_only() {
        assert!(validate_controller_url("https://ops.example.com").is_ok());
        assert!(validate_controller_url("http://127.0.0.1:8080").is_ok());
        assert!(validate_controller_url("http://localhost:8080").is_ok());
        // Plain HTTP to a routable host would put the bearer token on the wire
        // in clear text.
        assert!(validate_controller_url("http://ops.example.com").is_err());
        assert!(validate_controller_url("ftp://ops.example.com").is_err());
        assert!(validate_controller_url("not a url").is_err());
    }

    #[test]
    fn rejects_the_cloud_metadata_endpoint() {
        // Mirrors the connector HTTP bridge's single SSRF carve-out: this host
        // is never a controller and always a credential-theft target.
        assert!(validate_controller_url("http://169.254.169.254/latest").is_err());
        assert!(validate_controller_url("https://169.254.169.254/latest").is_err());
    }

    #[test]
    fn builds_a_sensitive_bearer_header_and_an_optional_cursor() {
        let headers = build_headers("token-1", Some("42")).unwrap();
        let authorization = headers.get(AUTHORIZATION).unwrap();
        assert_eq!(authorization.to_str().unwrap(), "Bearer token-1");
        assert!(
            authorization.is_sensitive(),
            "the bearer must not print in header-map debug output"
        );
        assert_eq!(headers.get("last-event-id").unwrap(), "42");
    }

    #[test]
    fn omits_a_blank_cursor_and_rejects_a_blank_token() {
        // A blank cursor must be omitted rather than sent empty: the controller
        // parses `Last-Event-ID` as an integer and an empty value would replay
        // the whole backlog on every reconnect.
        assert!(build_headers("token-1", Some("  "))
            .unwrap()
            .get("last-event-id")
            .is_none());
        assert!(build_headers("token-1", None)
            .unwrap()
            .get("last-event-id")
            .is_none());
        assert!(build_headers("   ", None).is_err());
    }

    #[test]
    fn keeps_the_controller_error_body_in_the_failure_description() {
        let described = describe(SseError::Status {
            status: 403,
            body: "{\"code\":\"insufficient_scope\"}".into(),
        });
        assert!(described.contains("403"));
        assert!(described.contains("insufficient_scope"));

        // An empty body has nothing to add, so the plain error text wins.
        let bare = describe(SseError::Status {
            status: 502,
            body: "  ".into(),
        });
        assert!(bare.contains("502"));
    }

    #[test]
    fn scopes_the_event_channel_to_one_stream() {
        assert_eq!(stream_channel("abc"), "server-ops://events/abc");
    }

    #[tokio::test]
    async fn closing_an_unknown_stream_is_not_an_error() {
        assert!(!server_ops_events_close("never-opened".into())
            .await
            .unwrap());
    }
}

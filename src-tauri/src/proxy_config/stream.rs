//! Streaming counterpart to `proxy_http_request`.
//!
//! `proxy_http_request` buffers: it resolves on the last byte and hands the
//! renderer one base64 blob. That is the right shape for a JSON API call and
//! the wrong shape for three things this app does every day —
//!
//!   - **SSE** (`text/event-stream`), whose body never ends. Buffered, it
//!     delivers nothing, ever. This is why the ACP client fell back to a
//!     renderer `EventSource`, which cannot set `Authorization` and is blocked
//!     by the packaged shell's `connect-src` anyway.
//!   - **long-lived NDJSON**, where the whole point is progress before the end.
//!   - **large downloads**, which the buffered path caps at 64 MiB and holds
//!     entirely in memory twice (bytes, then base64) on both sides of the IPC.
//!
//! Rather than one bespoke Rust command per stream — the shape
//! `server_ops_events_*` and `ollama_pull_model_stream` already took, and which
//! does not generalize — this is the generic seam:
//!
//!   `open`   → applies the proxy policy, sends the request, awaits the
//!              response head, and returns status + headers. Body chunks then
//!              arrive on a `tauri::ipc::Channel`.
//!   `ack`    → the renderer reports bytes it has consumed. Without it a fast
//!              origin and a slow consumer would queue the whole body in the
//!              IPC layer, which is the buffered path's memory problem wearing
//!              a stream's clothes.
//!   `cancel` → drops the request. An `AbortSignal` on the TS side calls it.
//!
//! Everything that makes the buffered bridge safe applies here unchanged: the
//! same `apply_reqwest_policy` (so proxy, bypass and fail-closed behave
//! identically), the same reserved-header rejection, the same optional
//! private-host guard, the same redirect modes.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use futures_util::StreamExt as _;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tokio::sync::Notify;

use cognia_net::request_cancellation::RequestCancellationRegistry;

use super::commands::host_is_private;

/// How many delivered-but-unacknowledged body bytes may be outstanding before
/// the reader pauses.
///
/// 4 MiB is two orders of magnitude above a single SSE frame (so an event
/// stream never pauses) and small enough that a renderer which stops reading a
/// 2 GiB download cannot make the host hold the whole thing. The renderer
/// acknowledges from the `ReadableStream`'s pull, so the window tracks actual
/// consumption rather than arrival.
const MAX_UNACKED_BYTES: u64 = 4 * 1024 * 1024;

/// How long the reader waits for the window to open before giving up.
///
/// A renderer that navigated away or crashed mid-stream never acks again. The
/// stream must then fail rather than pin a socket and a task forever; 60s is
/// far longer than any real consumer's pause and short enough that a reload
/// does not accumulate zombies.
const ACK_STALL_TIMEOUT: Duration = Duration::from_secs(60);

/// Largest single chunk handed to the renderer. reqwest yields whatever the
/// transport produced, which for a fast local origin can be hundreds of KiB;
/// splitting keeps one IPC message (and its base64 inflation) bounded.
const MAX_CHUNK_BYTES: usize = 256 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyHttpStreamInput {
    pub request_id: String,
    pub url: String,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub body_base64: Option<String>,
    #[serde(default)]
    pub headers: Option<HashMap<String, String>>,
    /// Bounds the *response head* only. A stream body is unbounded by design,
    /// so this must not become a whole-request timeout the way it is on the
    /// buffered bridge.
    #[serde(default)]
    pub connect_timeout_ms: Option<u64>,
    /// Maximum silence between body chunks. `None` leaves the stream open
    /// indefinitely, which is what a subscription wants; SSE callers set it
    /// above the origin's keep-alive interval.
    #[serde(default)]
    pub read_timeout_ms: Option<u64>,
    #[serde(default)]
    pub redirect: Option<String>,
    #[serde(default)]
    pub block_private: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyHttpStreamOpenOutput {
    pub request_id: String,
    pub status: u16,
    pub headers: HashMap<String, String>,
}

/// One message on the renderer's channel.
///
/// `end` is terminal and always arrives — clean finish, transport failure, and
/// cancellation alike — so the TS side closes its `ReadableStream` on exactly
/// one signal instead of inferring the end from silence. `error` carries the
/// reason and is always followed by `end`.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProxyHttpStreamEvent {
    #[serde(rename_all = "camelCase")]
    Chunk { seq: u64, body_base64: String },
    #[serde(rename_all = "camelCase")]
    Error { message: String },
    #[serde(rename_all = "camelCase")]
    End,
}

// ---------------------------------------------------------------------------
// Flow control
// ---------------------------------------------------------------------------

/// The unacknowledged-byte window for one in-flight stream.
struct FlowWindow {
    outstanding: AtomicU64,
    drained: Notify,
}

impl FlowWindow {
    fn new() -> Self {
        Self {
            outstanding: AtomicU64::new(0),
            drained: Notify::new(),
        }
    }

    fn record_sent(&self, bytes: u64) {
        self.outstanding.fetch_add(bytes, Ordering::AcqRel);
    }

    /// Release `bytes` of the window. Saturates at zero so a renderer that
    /// over-acks (double-delivery after a retry, a buggy caller) cannot wrap
    /// the counter into a permanently-open window.
    fn record_acked(&self, bytes: u64) {
        let mut current = self.outstanding.load(Ordering::Acquire);
        loop {
            let next = current.saturating_sub(bytes);
            match self.outstanding.compare_exchange_weak(
                current,
                next,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => break,
                Err(actual) => current = actual,
            }
        }
        self.drained.notify_waiters();
    }

    fn is_open(&self) -> bool {
        self.outstanding.load(Ordering::Acquire) < MAX_UNACKED_BYTES
    }

    /// Wait until the window reopens. Returns false when the renderer stalled
    /// past `stall_timeout`.
    ///
    /// The timeout is a parameter rather than a read of [`ACK_STALL_TIMEOUT`]
    /// so the stall path is testable in milliseconds; production passes the
    /// constant. (Tokio's paused clock would be the alternative, but it needs
    /// the `test-util` feature enabled workspace-wide.)
    async fn wait_for_room(&self, stall_timeout: Duration) -> bool {
        loop {
            if self.is_open() {
                return true;
            }
            // Subscribe before re-checking: an ack landing between the check
            // above and the await would otherwise be missed and the reader
            // would sleep the full timeout with an open window.
            let notified = self.drained.notified();
            if self.is_open() {
                return true;
            }
            if tokio::time::timeout(stall_timeout, notified).await.is_err()
            {
                return false;
            }
        }
    }
}

/// Windows are keyed by request id and tagged with the cancellation
/// generation that owns them, so a reused id whose newer stream is live keeps
/// its own window when the older one finishes.
type WindowRegistry = Mutex<HashMap<String, (u64, Arc<FlowWindow>)>>;

fn windows() -> &'static WindowRegistry {
    static WINDOWS: OnceLock<WindowRegistry> = OnceLock::new();
    WINDOWS.get_or_init(Default::default)
}

fn cancellations() -> &'static RequestCancellationRegistry {
    static CANCELLATIONS: OnceLock<RequestCancellationRegistry> = OnceLock::new();
    CANCELLATIONS.get_or_init(Default::default)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

fn parse_redirect(mode: Option<&str>) -> Result<reqwest::redirect::Policy, String> {
    Ok(match mode.unwrap_or("follow") {
        "follow" => reqwest::redirect::Policy::limited(10),
        "manual" => reqwest::redirect::Policy::none(),
        "error" => reqwest::redirect::Policy::custom(|attempt| attempt.error("redirect blocked")),
        value => return Err(format!("invalid redirect mode: {value}")),
    })
}

/// Open a streaming request and return its response head.
///
/// Resolves once the origin has answered with status and headers — before a
/// single body byte — so the caller can reject a 401 without draining a body
/// it will discard.
#[tauri::command]
pub async fn proxy_http_stream_open(
    input: ProxyHttpStreamInput,
    on_event: Channel<ProxyHttpStreamEvent>,
) -> Result<ProxyHttpStreamOpenOutput, String> {
    if input.request_id.trim().is_empty() {
        return Err("requestId is required".to_string());
    }
    if input.block_private == Some(true) && host_is_private(&input.url) {
        return Err(format!(
            "refusing to fetch a private/loopback address: {}",
            input.url
        ));
    }

    let mut builder = reqwest::Client::builder().redirect(parse_redirect(input.redirect.as_deref())?);
    if let Some(ms) = input.connect_timeout_ms {
        builder = builder.connect_timeout(Duration::from_millis(ms));
    }
    if let Some(ms) = input.read_timeout_ms {
        builder = builder.read_timeout(Duration::from_millis(ms));
    }
    let (builder, _route) = super::apply_reqwest_policy(builder, &input.url)
        .map_err(|error| serde_json::to_string(&error).unwrap_or_else(|_| error.to_string()))?;
    let client = builder
        .build()
        .map_err(|error| format!("client build failed: {error}"))?;

    let method = input
        .method
        .as_deref()
        .unwrap_or("GET")
        .parse::<reqwest::Method>()
        .map_err(|error| format!("invalid HTTP method: {error}"))?;

    let mut request = client.request(method, &input.url);
    if let Some(headers) = &input.headers {
        for (name, value) in headers {
            if name.eq_ignore_ascii_case("proxy-authorization") {
                return Err(
                    "Proxy-Authorization is reserved for the native proxy connector".into(),
                );
            }
            request = request.header(name.as_str(), value.as_str());
        }
    }
    if let Some(body) = input.body_base64 {
        let bytes = B64
            .decode(body)
            .map_err(|_| "request body is not valid base64".to_string())?;
        request = request.body(bytes);
    }

    // Registering before the send means a `cancel` racing a slow origin still
    // aborts, rather than leaking a task the renderer believes it stopped.
    let (generation, mut cancelled) = cancellations().register(&input.request_id);
    let window = Arc::new(FlowWindow::new());
    windows()
        .lock()
        .expect("proxy stream window registry poisoned")
        .insert(input.request_id.clone(), (generation, Arc::clone(&window)));

    // `&mut` rather than by value: `oneshot::Receiver` is `Unpin`, so the same
    // receiver covers the head and then moves into the body task. Re-registering
    // for the second phase would mint a new generation and desynchronize the
    // window registry from the cancellation registry.
    let response = tokio::select! {
        biased;
        _ = &mut cancelled => {
            finish(&input.request_id, generation);
            return Err("request cancelled".to_string());
        }
        result = request.send() => result,
    };
    let response = match response {
        Ok(response) => response,
        Err(error) => {
            finish(&input.request_id, generation);
            return Err(format!("request failed: {}", error.without_url()));
        }
    };

    let status = response.status().as_u16();
    let headers: HashMap<String, String> = response
        .headers()
        .iter()
        .filter_map(|(name, value)| Some((name.as_str().to_string(), value.to_str().ok()?.to_string())))
        .collect();

    let request_id = input.request_id.clone();
    tauri::async_runtime::spawn(async move {
        let error = pump_body(response, &on_event, &window, cancelled).await;
        finish(&request_id, generation);
        if let Some(message) = error {
            let _ = on_event.send(ProxyHttpStreamEvent::Error { message });
        }
        let _ = on_event.send(ProxyHttpStreamEvent::End);
    });

    Ok(ProxyHttpStreamOpenOutput {
        request_id: input.request_id,
        status,
        headers,
    })
}

/// Drain the body onto the channel. Returns the failure message, if any.
async fn pump_body(
    response: reqwest::Response,
    on_event: &Channel<ProxyHttpStreamEvent>,
    window: &FlowWindow,
    mut cancelled: tokio::sync::oneshot::Receiver<()>,
) -> Option<String> {
    let mut stream = response.bytes_stream();
    let mut seq: u64 = 0;

    loop {
        let next = tokio::select! {
            biased;
            // Cancellation is not an error: the renderer asked, and it still
            // gets the terminal `end` below.
            _ = &mut cancelled => return None,
            next = stream.next() => next,
        };
        // `?` on the `Option`: a `None` from the stream is a clean end of body.
        let chunk = next?;
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(error) => return Some(format!("read body failed: {error}")),
        };

        for slice in chunk.chunks(MAX_CHUNK_BYTES) {
            if !window.wait_for_room(ACK_STALL_TIMEOUT).await {
                return Some(
                    "the renderer stopped acknowledging stream chunks; aborting to release the connection"
                        .to_string(),
                );
            }
            window.record_sent(slice.len() as u64);
            if on_event
                .send(ProxyHttpStreamEvent::Chunk {
                    seq,
                    body_base64: B64.encode(slice),
                })
                .is_err()
            {
                // The channel is gone — the renderer navigated or reloaded.
                // Nothing left to report it to, so end quietly.
                return None;
            }
            seq = seq.wrapping_add(1);
        }
    }
}

/// Release both registrations for one finished stream.
///
/// The window is dropped only when this generation still owns the id: a
/// renderer that reused the id for a new stream while the old one was winding
/// down must keep the new stream's window.
fn finish(request_id: &str, generation: u64) {
    cancellations().finish(request_id, generation);
    if let Ok(mut registry) = windows().lock() {
        if registry
            .get(request_id)
            .is_some_and(|(owner, _)| *owner == generation)
        {
            registry.remove(request_id);
        }
    }
}

/// Acknowledge `bytes` of consumed body, reopening the flow-control window.
///
/// Returns false for an unknown id, which is the normal shape of an ack racing
/// the terminal `end` — not an error.
#[tauri::command]
pub fn proxy_http_stream_ack(request_id: String, bytes: u64) -> bool {
    let window = windows()
        .lock()
        .ok()
        .and_then(|registry| registry.get(&request_id).map(|(_, window)| Arc::clone(window)));
    match window {
        Some(window) => {
            window.record_acked(bytes);
            true
        }
        None => false,
    }
}

/// Cancel an in-flight stream. Idempotent.
#[tauri::command]
pub fn proxy_http_stream_cancel(request_id: String) -> bool {
    let cancelled = cancellations().cancel(&request_id);
    if let Ok(mut registry) = windows().lock() {
        // Wake a reader parked on the window so it observes the cancellation
        // immediately instead of after the stall timeout.
        if let Some((_, window)) = registry.remove(&request_id) {
            window.record_acked(MAX_UNACKED_BYTES);
        }
    }
    cancelled
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redirect_modes_mirror_the_buffered_bridge() {
        assert!(parse_redirect(None).is_ok());
        assert!(parse_redirect(Some("follow")).is_ok());
        assert!(parse_redirect(Some("manual")).is_ok());
        assert!(parse_redirect(Some("error")).is_ok());
        assert!(parse_redirect(Some("sideways")).is_err());
    }

    #[test]
    fn the_window_closes_once_the_unacked_budget_is_spent() {
        let window = FlowWindow::new();
        assert!(window.is_open());

        window.record_sent(MAX_UNACKED_BYTES - 1);
        assert!(window.is_open());

        window.record_sent(1);
        assert!(!window.is_open(), "a full window must pause the reader");

        window.record_acked(1);
        assert!(window.is_open());
    }

    #[test]
    fn over_acking_saturates_at_zero_instead_of_wrapping() {
        let window = FlowWindow::new();
        window.record_sent(16);

        // A renderer that acks more than it was sent must not underflow the
        // counter into `u64::MAX`, which would leave the window permanently
        // open and defeat back-pressure entirely.
        window.record_acked(u64::MAX);
        assert_eq!(window.outstanding.load(Ordering::Acquire), 0);
        assert!(window.is_open());

        window.record_sent(MAX_UNACKED_BYTES);
        assert!(!window.is_open());
    }

    #[tokio::test]
    async fn wait_for_room_returns_immediately_when_the_window_is_open() {
        let window = FlowWindow::new();
        assert!(window.wait_for_room(ACK_STALL_TIMEOUT).await);
    }

    #[tokio::test]
    async fn wait_for_room_resumes_when_an_ack_lands() {
        let window = Arc::new(FlowWindow::new());
        window.record_sent(MAX_UNACKED_BYTES);

        let acker = Arc::clone(&window);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            acker.record_acked(MAX_UNACKED_BYTES);
        });

        // A generous stall budget: the assertion is that the ack wakes the
        // waiter, not that it beats a deadline.
        assert!(window.wait_for_room(Duration::from_secs(5)).await);
    }

    #[tokio::test]
    async fn wait_for_room_gives_up_on_a_renderer_that_stopped_acking() {
        let window = FlowWindow::new();
        window.record_sent(MAX_UNACKED_BYTES);

        // A renderer that navigated away never acks again. Parking forever
        // would pin the socket and the task for the life of the process.
        assert!(!window.wait_for_room(Duration::from_millis(20)).await);
    }

    #[test]
    fn acking_an_unknown_stream_is_not_an_error() {
        // The normal shape of an ack racing the terminal `end` message.
        assert!(!proxy_http_stream_ack("never-opened".into(), 128));
    }

    #[test]
    fn cancelling_an_unknown_stream_is_not_an_error() {
        assert!(!proxy_http_stream_cancel("never-opened".into()));
    }

    #[test]
    fn ack_reopens_a_registered_window() {
        let id = "ack-reopens-window";
        let window = Arc::new(FlowWindow::new());
        window.record_sent(MAX_UNACKED_BYTES);
        windows()
            .lock()
            .unwrap()
            .insert(id.to_string(), (7, Arc::clone(&window)));

        assert!(proxy_http_stream_ack(id.into(), MAX_UNACKED_BYTES));
        assert!(window.is_open());

        windows().lock().unwrap().remove(id);
    }

    #[test]
    fn cancel_drops_the_window_and_wakes_a_parked_reader() {
        let id = "cancel-drops-window";
        let window = Arc::new(FlowWindow::new());
        window.record_sent(MAX_UNACKED_BYTES);
        let (generation, _cancelled) = cancellations().register(id);
        windows()
            .lock()
            .unwrap()
            .insert(id.to_string(), (generation, Arc::clone(&window)));

        assert!(proxy_http_stream_cancel(id.into()));

        assert!(!windows().lock().unwrap().contains_key(id));
        // The reader still holds its Arc; cancel must open its window so it
        // observes the cancellation now rather than after the stall timeout.
        assert!(window.is_open());
    }

    #[test]
    fn finish_keeps_a_window_a_newer_stream_took_over() {
        let id = "finish-generation-guard";
        let old = Arc::new(FlowWindow::new());
        let new = Arc::new(FlowWindow::new());

        windows()
            .lock()
            .unwrap()
            .insert(id.to_string(), (1, Arc::clone(&old)));
        // The renderer reused the id: a newer generation now owns it.
        windows()
            .lock()
            .unwrap()
            .insert(id.to_string(), (2, Arc::clone(&new)));

        // The older stream winding down must not evict the live one.
        finish(id, 1);
        assert!(windows().lock().unwrap().contains_key(id));

        finish(id, 2);
        assert!(!windows().lock().unwrap().contains_key(id));
    }

    #[test]
    fn the_private_host_guard_is_the_buffered_bridge_s_own() {
        // Shared helper, not a second copy: a stream that skipped the SSRF
        // check would be a hole the buffered bridge does not have.
        assert!(host_is_private("http://169.254.169.254/latest/meta-data"));
        assert!(host_is_private("http://127.0.0.1:8080/stream"));
        assert!(!host_is_private("https://api.anthropic.com/v1/messages"));
    }

    #[test]
    fn chunking_keeps_one_ipc_message_bounded() {
        let payload = vec![0u8; MAX_CHUNK_BYTES * 2 + 5];
        let pieces: Vec<_> = payload.chunks(MAX_CHUNK_BYTES).collect();
        assert_eq!(pieces.len(), 3);
        assert!(pieces.iter().all(|piece| piece.len() <= MAX_CHUNK_BYTES));
        assert_eq!(
            pieces.iter().map(|piece| piece.len()).sum::<usize>(),
            payload.len()
        );
    }

    #[test]
    fn stream_events_serialize_with_a_discriminated_kind() {
        let chunk = serde_json::to_value(ProxyHttpStreamEvent::Chunk {
            seq: 3,
            body_base64: "aGk=".into(),
        })
        .unwrap();
        assert_eq!(chunk["kind"], "chunk");
        assert_eq!(chunk["seq"], 3);
        assert_eq!(chunk["bodyBase64"], "aGk=");

        let error = serde_json::to_value(ProxyHttpStreamEvent::Error {
            message: "read body failed".into(),
        })
        .unwrap();
        assert_eq!(error["kind"], "error");
        assert_eq!(error["message"], "read body failed");

        assert_eq!(
            serde_json::to_value(ProxyHttpStreamEvent::End).unwrap()["kind"],
            "end"
        );
    }
}

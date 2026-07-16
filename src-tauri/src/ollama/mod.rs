//! Streaming model pull for Ollama — the one local-provider call that cannot
//! ride the shared `proxy_http_request` escape hatch.
//!
//! Every other Ollama management call (status, tags, show, delete, ps, copy,
//! embeddings) is a plain request/response and goes through
//! `proxy_http_request` from the renderer. That command returns a fully
//! buffered `body: String`, which is exactly wrong for `/api/pull`: the
//! response is NDJSON held open for the entire download, so a buffered caller
//! would see nothing for minutes and then receive every progress line at once,
//! after the download it was reporting on had already finished.
//!
//! Hence one command, not eight. This module deliberately does NOT re-add the
//! `ollama_get_status` / `ollama_list_models` / … commands that the TypeScript
//! used to invoke: those never existed, and `proxy_http_request` already does
//! their job.
//!
//! ## Cancellation
//!
//! There is no cancel command here, and that is not an omission. Ollama's
//! server cannot cancel a pull: aborting the HTTP connection does not stop the
//! transfer, which runs to completion server-side regardless
//! (<https://github.com/ollama/ollama/issues/13142>, still open). The only real
//! stop is killing the process. A `ollama_cancel_pull` command would therefore
//! be a lie in the API surface — the front-end detaches its listener instead
//! and tells the user the download continues in the background.

use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::Emitter;

use cognia_net::ndjson_stream::stream_ndjson_post;

/// Event name carrying pull progress to the renderer. Mirrors the literal in
/// `packages/provider-core/src/providers/ollama-pull.ts`.
const PULL_PROGRESS_EVENT: &str = "ollama-pull-progress";

/// One `/api/pull` NDJSON line, plus the `pull_id` the renderer filters on.
///
/// EVERY field is optional, including `status`, and that is load-bearing.
/// Ollama streams two different shapes down one connection:
///   - progress: `{"status":"pulling manifest"}` … `{"status":"downloading",
///     "digest":"sha256:…","total":N,"completed":M}` (upstream `ProgressResponse`)
///   - failure:  `{"error":"…"}` — with NO `status` key at all (upstream sends
///     a bare `gin.H{"error": …}`, a different type entirely)
///
/// A required `status` would make the error line fail to deserialize, and
/// `stream_ndjson_post` skips unparsable lines — so the one line that explains
/// why the pull died would be silently dropped and the UI would just stop.
///
/// The failure line is only in-band when the stream had already started; an
/// early failure (bad model name, before any chunk is flushed) arrives as a
/// real non-200 and surfaces via `NdjsonError::Status`. Both paths need
/// handling, which is why this covers one and `pull_client`'s error mapping
/// covers the other.
/// Ref: <https://docs.ollama.com/api/errors> — "If an error occurs mid-stream,
/// the error will be returned as an object in the application/x-ndjson format
/// with an error property. Since the response has already started, the status
/// code of the response will not be changed."
///
/// Serializing as a struct (not a tuple) keeps this a JSON object on the wire;
/// a tuple would arrive as an array and silently break the TS payload shape.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OllamaPullProgress {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed: Option<u64>,
    /// Ollama's in-band failure line. See the note above — this arrives on a
    /// line that carries nothing else.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Scopes an event to ONE `pullModel` call. Without it two concurrent
    /// pulls would each receive the other's progress. Set by this command, not
    /// by Ollama — hence `skip_deserializing`, which also stops a server from
    /// spoofing another pull's stream by echoing an id.
    #[serde(default, rename = "pullId", skip_deserializing)]
    pub pull_id: String,
}

/// How long the stream may go silent before we call it dead.
///
/// NOT an overall timeout — that would kill a legitimate 40GB pull mid-transfer.
/// This bounds INACTIVITY BETWEEN READS, so a healthy slow download resets it on
/// every chunk while a silently-dead connection (laptop slept, VPN flipped,
/// container paused) cannot pend forever. Generous on purpose: Ollama goes quiet
/// during "verifying sha256 digest" on a large model.
const PULL_READ_TIMEOUT: Duration = Duration::from_secs(300);

/// Build a client for a long-running streamed download.
///
/// No overall `timeout()`: a pull legitimately runs for many minutes on a large
/// model, and a request timeout would kill it mid-transfer. `connect_timeout`
/// bounds the "is anything listening?" case (server not started — the failure
/// users actually hit), and `read_timeout` bounds the far nastier one: a
/// connection that dies without an FIN. Without it `stream.next().await` pends
/// forever, the task leaks, and the renderer's `invoke()` promise never settles
/// — unrecoverable, since by design there is no cancel command and the abort
/// path only detaches the progress listener.
fn pull_client(url: &str) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(PULL_READ_TIMEOUT)
        .tcp_keepalive(Duration::from_secs(30));

    let cfg = crate::proxy_config::current();
    if !cfg.should_bypass(url) {
        if let Some(proxy) = cfg.build_reqwest_proxy() {
            builder = builder.proxy(proxy);
        }
    }

    builder.build().map_err(|e| format!("client build failed: {e}"))
}

/// Pull `model_name`, emitting one `ollama-pull-progress` event per NDJSON line.
///
/// Resolves `true` once the stream ends. Deliberately NOT spawned as a detached
/// task: the renderer awaits this invoke to learn when the pull finished, and a
/// detached task would both drop that signal and outlive the test harness.
///
/// `base_url` is whatever the user configured — this is a loopback address in
/// practice, so there is no private-host guard here. That is the point: a local
/// inference server IS the target. `proxy_http_request`'s `blockPrivate` guard
/// is opt-in for the same reason.
#[tauri::command]
pub async fn ollama_pull_model_stream(
    app: tauri::AppHandle,
    base_url: String,
    model_name: String,
    pull_id: String,
) -> Result<bool, String> {
    let url = format!("{}/api/pull", base_url.trim_end_matches('/'));
    let client = pull_client(&url)?;
    let body = serde_json::json!({ "name": model_name, "stream": true });

    // A mid-stream failure arrives as a line, not a status code, so the last
    // one seen decides the outcome. Without this the command would emit the
    // error to the UI and then still return Ok(true) — reporting a pull that
    // failed as a success.
    let mut in_band_error: Option<String> = None;
    // Ollama's stream ends with `{"status":"success"}`. Seeing it is the only
    // positive proof the download completed — see the zero-progress note below.
    let mut saw_success = false;

    // Emitting from the callback keeps progress flowing as it arrives rather
    // than batching at the end. `app.emit` is cheap and non-blocking; a failed
    // emit (renderer gone) must not abort the download.
    let mut on_line = |mut progress: OllamaPullProgress| {
        if let Some(err) = progress.error.clone() {
            // Do NOT emit this line. It carries no `status`, but the renderer's
            // `OllamaPullProgress` types `status` as required and formats it
            // unconditionally — emitting would render a literal "undefined" in
            // the progress row. No TS consumer reads `.error` either, so the
            // line has nothing to offer the UI. `in_band_error` carries it to
            // the caller as a proper Err instead.
            in_band_error = Some(err);
            return;
        }
        if progress.status.as_deref() == Some("success") {
            saw_success = true;
        }
        progress.pull_id = pull_id.clone();
        if let Err(err) = app.emit(PULL_PROGRESS_EVENT, &progress) {
            log::warn!("failed to emit ollama pull progress: {err}");
        }
    };

    // Two distinct failure shapes, both real: a pre-stream failure (bad model
    // name) is a genuine non-200 and lands here; a mid-stream failure keeps
    // HTTP 200 and is caught by `in_band_error` below.
    let delivered = stream_ndjson_post::<OllamaPullProgress, _>(&client, &url, &body, &mut on_line)
        .await
        .map_err(|e| format!("ollama pull failed: {e}"))?;

    decide_pull_outcome(&url, delivered, in_band_error, saw_success)
}

/// Decide whether a finished stream actually pulled the model.
///
/// Split out from the command so it can be tested: the command itself needs a
/// live `tauri::AppHandle`, which is why every failure rule below would
/// otherwise ship uncovered — and each one exists to stop the UI reporting a
/// success that did not happen.
fn decide_pull_outcome(
    url: &str,
    delivered: u64,
    in_band_error: Option<String>,
    saw_success: bool,
) -> Result<bool, String> {
    if let Some(err) = in_band_error {
        return Err(format!("ollama pull failed: {err}"));
    }

    // A 200 that carried no parsable progress is NOT a completed pull. Reaching
    // something that isn't Ollama — wrong port, a reverse proxy's HTML error
    // page, a captive portal — parses nothing, and `stream_ndjson_post` skips
    // what it cannot parse by design. Returning Ok here would tell the user
    // "pull complete" about a model that was never downloaded.
    if delivered == 0 {
        return Err(format!(
            "ollama pull failed: {url} returned no progress — is an Ollama server listening there?"
        ));
    }

    // Ollama's stream ends with `{"status":"success"}` (docs/api.md, "Pull a
    // Model"). A stream that delivered progress but never that line stopped
    // early — a dropped connection mid-download. Report it rather than claiming
    // a model the user does not have.
    if !saw_success {
        return Err(
            "ollama pull failed: the stream ended before the download completed".to_string(),
        );
    }

    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_serializes_as_an_object_with_a_camel_case_pull_id() {
        let progress = OllamaPullProgress {
            status: Some("downloading".into()),
            digest: Some("sha256:abc".into()),
            total: Some(100),
            completed: Some(42),
            error: None,
            pull_id: "pull-1".into(),
        };
        let json = serde_json::to_value(&progress).unwrap();

        // An object, not an array — a tuple struct would cross the IPC boundary
        // as `["downloading", ...]` and break every field read on the TS side.
        assert!(json.is_object());
        assert_eq!(json["status"], "downloading");
        assert_eq!(json["completed"], 42);
        // The renderer filters on this exact key.
        assert_eq!(json["pullId"], "pull-1");
        // Absent optionals stay off the wire rather than arriving as null.
        assert!(json.get("error").is_none());
    }

    #[test]
    fn deserializes_ollamas_early_lines_that_carry_no_byte_counts() {
        // "pulling manifest" is the real first line of every pull and has only
        // a status. A struct requiring totals would reject it, and
        // stream_ndjson_post skips what it cannot parse — so the whole opening
        // of the stream would vanish.
        let progress: OllamaPullProgress =
            serde_json::from_str(r#"{"status":"pulling manifest"}"#).unwrap();
        assert_eq!(progress.status.as_deref(), Some("pulling manifest"));
        assert!(progress.total.is_none());
        assert!(progress.completed.is_none());
    }

    /// Ollama's mid-stream failure line is a bare `{"error": "..."}` with NO
    /// `status` key — upstream sends `gin.H{"error": …}`, a different type from
    /// `ProgressResponse`. A required `status` field would make this line
    /// unparsable, and unparsable lines are skipped, so the single line that
    /// explains why a pull died would be swallowed and the UI would just stall.
    #[test]
    fn deserializes_a_status_less_in_band_error_line() {
        let progress: OllamaPullProgress =
            serde_json::from_str(r#"{"error":"model not found"}"#).unwrap();
        assert_eq!(progress.error.as_deref(), Some("model not found"));
        assert!(progress.status.is_none());
    }

    #[test]
    fn incoming_lines_never_carry_a_pull_id_from_the_server() {
        // `pull_id` is ours, not Ollama's. If a server echoed one it must be
        // ignored, or a peer could spoof another pull's progress stream.
        let progress: OllamaPullProgress =
            serde_json::from_str(r#"{"status":"ok","pullId":"spoofed"}"#).unwrap();
        assert_eq!(progress.pull_id, "");
    }

    #[test]
    fn a_completed_stream_succeeds() {
        assert_eq!(decide_pull_outcome("http://x", 5, None, true), Ok(true));
    }

    #[test]
    fn an_in_band_error_fails_the_pull_and_carries_the_servers_message() {
        // HTTP 200 all the way; the failure exists only as a line in the body.
        // Reporting Ok here would call a failed pull a success.
        let err = decide_pull_outcome("http://x", 3, Some("model not found".into()), false)
            .unwrap_err();
        assert!(err.contains("model not found"), "got: {err}");
    }

    /// The headline false-success case: something answered 200 but was not
    /// Ollama (wrong port, reverse-proxy HTML, captive portal). Nothing parses,
    /// every line is skipped by design, and the naive read of that is "done".
    #[test]
    fn a_stream_with_no_parsable_progress_is_not_a_completed_pull() {
        let err = decide_pull_outcome("http://localhost:9999", 0, None, false).unwrap_err();
        assert!(err.contains("no progress"), "got: {err}");
        assert!(err.contains("localhost:9999"), "should name the URL: {err}");
    }

    #[test]
    fn a_stream_that_ends_before_the_success_line_is_a_failure() {
        // Progress arrived, then the connection died — no terminal
        // `{"status":"success"}`. The model is not on disk.
        let err = decide_pull_outcome("http://x", 42, None, false).unwrap_err();
        assert!(err.contains("ended before"), "got: {err}");
    }

    #[test]
    fn an_in_band_error_outranks_a_success_line() {
        // Defensive ordering: if both somehow appear, the error wins.
        assert!(decide_pull_outcome("http://x", 9, Some("boom".into()), true).is_err());
    }
}

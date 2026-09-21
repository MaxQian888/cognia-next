//! The `cognia/*` virtual models (ADR-0188 D13, B3).
//!
//! A caller can ask `/v1/chat/completions` for a routing MODE rather than a
//! model: `cognia/auto`, `cognia/direct`, `cognia/cascade`, `cognia/panel`.
//! These names never reach a provider — they name work Router + Fusion decides
//! and runs — so the gateway recognises them before the ordinary model
//! resolution does.
//!
//! What a request naming one gets:
//!
//! - the switch is off (the default) → `403 ROUTER_FUSION_DISABLED`, because a
//!   caller that explicitly asked for Router + Fusion is never quietly served by
//!   the ordinary router instead (D38);
//! - `cognia/delegate` → `422`: delegate has an approval step and a workspace,
//!   which a chat completion cannot express. It exists only on `/v1/runs`;
//! - any other endpoint (`/v1/messages`, `/v1/responses`) → `422`: the compat
//!   subset is chat completions only (DESIGN §15);
//! - otherwise the request becomes a run. The brain validates it against the
//!   strict compat subset (unknown parameters, tools and `n > 1` are refused
//!   with 422, never ignored), creates the run, and the gateway waits for it.
//!   A streaming caller gets SSE comment heartbeats and nothing else until the
//!   answer is verified — never a draft a cascade or a panel may still replace
//!   (DESIGN §22, SSE-02) — then the verified text as standard deltas.
//!
//! A caller that goes away does not cancel the run (SSE-03): it carries on in
//! the brain, and `GET /v1/runs/{id}` (the id is in `x-cognia-run-id`) reads
//! the result.
//!
//! Every refusal of a virtual model, on any endpoint, is the Run API
//! contract's `ErrorResponse` with the code in `code` — never the legacy
//! OpenAI or Anthropic error object with the code squeezed into `type`. The
//! waits themselves are capped per gateway ([`MAX_COMPAT_WAITERS`]); a caller
//! past the cap is told so before any run is created.

use std::convert::Infallible;
use std::time::Duration;

use axum::http::{HeaderValue, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};

use crate::brain_bridge::{command, BrainBridgeError};
use crate::runs::{
    accepted_response, bridge_error, bridge_failure, error_body, error_response, missing_scope,
    scope, unreadable_answer, RunActor, RunsState, MAX_COMPAT_WAITERS, RUN_ID_HEADER,
    SSE_KEEPALIVE_INTERVAL,
};

/// What the gateway should do with a request naming this model.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VirtualModelVerdict {
    /// Not a virtual model: ordinary resolution continues.
    NotVirtual,
    /// A mode the compat subset serves.
    Serve { mode: String },
    /// A virtual model this request may not have, with the reason.
    Refuse {
        status: u16,
        code: String,
        message: String,
    },
}

/// The documented prefix. `cognia/*` is ours on every path: with the switch off
/// it is refused with the switch to turn on, which no upstream model shadows.
const OWN_PREFIX: &str = "cognia/";
/// The spec's own spelling, accepted as an alias so a client written against
/// the contract works unchanged. Only while runs are on: an upstream model may
/// carry this prefix, and with the switch off it resolves as it always did
/// (ADR-0188 D37).
const ALIAS_PREFIX: &str = "router/";

/// The virtual models a caller can list and ask for.
pub const VIRTUAL_MODELS: [&str; 4] = [
    "cognia/auto",
    "cognia/direct",
    "cognia/cascade",
    "cognia/panel",
];

/// How long past its own deadline a run is waited for before the caller is
/// told to read it later: long enough for the seal after a last-moment answer.
pub const RUN_WAIT_GRACE: Duration = Duration::from_secs(30);
/// The deadline a request that names none is waited for (the policy default).
pub const DEFAULT_RUN_DEADLINE: Duration = Duration::from_secs(120);
/// The longest deadline the contract allows.
pub const MAX_RUN_DEADLINE: Duration = Duration::from_secs(3_600);
/// Characters per content delta once the answer is verified.
pub const ANSWER_CHUNK_CHARS: usize = 512;

/// The mode part of a virtual model name, lowercased; `None` when the name is
/// not a virtual model at all.
pub fn virtual_mode_name(model: &str) -> Option<String> {
    let lowered = model.trim().to_ascii_lowercase();
    [OWN_PREFIX, ALIAS_PREFIX]
        .iter()
        .find_map(|prefix| lowered.strip_prefix(prefix))
        .map(str::to_string)
}

pub fn is_virtual_model(model: &str) -> bool {
    virtual_mode_name(model).is_some()
}

fn refuse(status: u16, code: &str, message: &str) -> VirtualModelVerdict {
    VirtualModelVerdict::Refuse {
        status,
        code: code.to_string(),
        message: message.to_string(),
    }
}

/// Decide what a request naming `model` gets. `runs_enabled` is the
/// `gatewayRuns` surface switch as the brain last pushed it.
pub fn classify(model: &str, runs_enabled: bool) -> VirtualModelVerdict {
    let Some(mode) = virtual_mode_name(model) else {
        return VirtualModelVerdict::NotVirtual;
    };
    if !runs_enabled && !model.trim().to_ascii_lowercase().starts_with(OWN_PREFIX) {
        return VirtualModelVerdict::NotVirtual;
    }
    if !runs_enabled {
        return refuse(
            403,
            "ROUTER_FUSION_DISABLED",
            "Router + Fusion runs are switched off for this host, so cognia/* models are not served",
        );
    }
    match mode.as_str() {
        "auto" | "direct" | "cascade" | "panel" => VirtualModelVerdict::Serve { mode },
        "delegate" => refuse(
            422,
            "DELEGATE_REQUIRES_RUN_API",
            "delegate needs a workspace and an approval step; it is available only through /v1/runs",
        ),
        other => refuse(
            422,
            "UNKNOWN_VIRTUAL_MODEL",
            &format!("cognia/{other} is not a Router + Fusion mode"),
        ),
    }
}

/// The refusal for a virtual model on an endpoint other than chat completions.
pub fn chat_completions_only() -> VirtualModelVerdict {
    refuse(
        422,
        "VIRTUAL_MODEL_CHAT_COMPLETIONS_ONLY",
        "cognia/* models are served on /v1/chat/completions only",
    )
}

/// What an endpoint that does NOT serve the compat subset (`/v1/messages`,
/// `/v1/responses`, `/v1/embeddings`, `/v1/messages/count_tokens`) does with
/// a request naming `model`: carry on (`NotVirtual`), or refuse. A mode that
/// `/v1/chat/completions` would serve is refused as chat-completions-only.
pub fn verdict_off_compat(model: &str, runs_enabled: bool) -> VirtualModelVerdict {
    match classify(model, runs_enabled) {
        VirtualModelVerdict::Serve { .. } => chat_completions_only(),
        other => other,
    }
}

/// A refused virtual model as the contract's `ErrorResponse`, naming the model
/// the caller asked for. A status that is not an error is answered as `400`.
pub fn refusal_response(model: &str, status: u16, code: &str, message: &str) -> Response {
    let status = StatusCode::from_u16(status)
        .ok()
        .filter(|s| s.is_client_error() || s.is_server_error())
        .unwrap_or(StatusCode::BAD_REQUEST);
    error_response(status, code, message, Some(json!({ "model": model })))
}

/// `429 RUN_WAITERS_EXHAUSTED`: every compat wait slot on this gateway is
/// taken. Retryable, and answered before any run exists.
pub fn waiters_exhausted() -> Response {
    let mut response = error_response(
        StatusCode::TOO_MANY_REQUESTS,
        "RUN_WAITERS_EXHAUSTED",
        "too many cognia/* callers are already waiting for their answers on this gateway; try again shortly",
        Some(json!({ "limit": MAX_COMPAT_WAITERS })),
    );
    response.headers_mut().insert(
        axum::http::header::RETRY_AFTER,
        HeaderValue::from_static("1"),
    );
    response
}

/// `/v1/models` entries for the virtual models, for a key that may use them.
pub fn model_documents(runs_enabled: bool, actor: &RunActor) -> Vec<Value> {
    if !runs_enabled || !actor.has(scope::CREATE) || !actor.has(scope::READ) {
        return Vec::new();
    }
    VIRTUAL_MODELS
        .iter()
        .map(|id| json!({ "id": id, "object": "model", "owned_by": "cognia", "created": 0 }))
        .collect()
}

/// The `/v1/models/cognia/{mode}` document for `id`, under exactly the rule
/// the list follows: the switch is on and the key may create and read runs.
/// `None` for a name the list would not show.
pub fn model_document(id: &str, runs_enabled: bool, actor: &RunActor) -> Option<Value> {
    model_documents(runs_enabled, actor)
        .into_iter()
        .find(|document| document["id"].as_str() == Some(id))
}

/// How long to wait for the run this body creates.
pub fn wait_budget(body: &Value) -> Duration {
    let deadline = body["routing"]["deadline_ms"]
        .as_u64()
        .map(Duration::from_millis)
        .unwrap_or(DEFAULT_RUN_DEADLINE)
        .min(MAX_RUN_DEADLINE);
    deadline + RUN_WAIT_GRACE
}

/// Split a verified answer into content deltas on character boundaries.
pub fn answer_chunks(answer: &str, chars: usize) -> Vec<String> {
    let chars = chars.max(1);
    let mut chunks = Vec::new();
    let mut current = String::new();
    for (count, ch) in answer.chars().enumerate() {
        if count > 0 && count % chars == 0 {
            chunks.push(std::mem::take(&mut current));
        }
        current.push(ch);
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

/// The `chat.completion.chunk` frames of a verified `ChatResponse`: the role,
/// the content, then the finish with the run's usage and routing.
pub fn completion_chunks(response: &Value) -> Vec<Value> {
    let base = |choice: Value| {
        json!({
            "id": response["id"],
            "object": "chat.completion.chunk",
            "created": response["created"],
            "model": response["model"],
            "choices": [choice],
        })
    };
    let answer = response["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("");
    let mut frames = vec![base(
        json!({ "index": 0, "delta": { "role": "assistant" }, "finish_reason": null }),
    )];
    for piece in answer_chunks(answer, ANSWER_CHUNK_CHARS) {
        frames.push(base(
            json!({ "index": 0, "delta": { "content": piece }, "finish_reason": null }),
        ));
    }
    let mut last = base(json!({
        "index": 0,
        "delta": {},
        "finish_reason": response["choices"][0]["finish_reason"],
    }));
    last["usage"] = response["usage"].clone();
    last["routing"] = response["routing"].clone();
    frames.push(last);
    frames
}

enum Outcome {
    Answer(Value),
    Failed(StatusCode, String, String, Option<Value>),
    TimedOut,
}

/// The first pause between answer reads, and the longest one: a quick answer
/// is picked up quickly, and a long run is not read four times a second.
const ANSWER_POLL_FIRST: Duration = Duration::from_millis(250);
const ANSWER_POLL_MAX: Duration = Duration::from_secs(2);

/// Told the tokens a served answer consumed, so the calling key's quota draws
/// down exactly as a passthrough request's does.
pub type UsageSink = Box<dyn FnOnce(u64) + Send>;

/// The tokens a compat answer reports, `prompt + completion` when the total is
/// missing.
fn answer_tokens(response: &Value) -> u64 {
    let usage = &response["usage"];
    usage["total_tokens"].as_u64().unwrap_or_else(|| {
        usage["prompt_tokens"]
            .as_u64()
            .unwrap_or(0)
            .saturating_add(usage["completion_tokens"].as_u64().unwrap_or(0))
    })
}

/// Ask for the run's compat answer until it has one, it ended without one, or
/// the wait is over. A brain that drops away mid-wait is asked again within
/// the budget: the run is durable, only the read failed.
async fn wait_for_answer(
    runs: &RunsState,
    actor: &RunActor,
    run_id: &str,
    model: &str,
    budget: Duration,
) -> Outcome {
    let started = tokio::time::Instant::now();
    let mut pause = ANSWER_POLL_FIRST;
    loop {
        let answer = runs
            .bridge()
            .call(
                command::CHAT_RESULT,
                json!({ "actor": actor.as_payload(), "runId": run_id, "model": model }),
            )
            .await;
        match answer {
            Ok(value) => {
                match value.get("state").and_then(Value::as_str) {
                    Some("succeeded") => {
                        return match value.get("response").filter(|v| v.is_object()) {
                        Some(response) => Outcome::Answer(response.clone()),
                        None => Outcome::Failed(
                            StatusCode::SERVICE_UNAVAILABLE,
                            "BRAIN_ANSWER_UNREADABLE".into(),
                            "the brain's answer to a chat result is not in a shape this gateway reads".into(),
                            Some(json!({ "run_id": run_id })),
                        ),
                    };
                    }
                    Some("pending") => {}
                    _ => return Outcome::Failed(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "BRAIN_ANSWER_UNREADABLE".into(),
                        "the brain's answer to a chat result is not in a shape this gateway reads"
                            .into(),
                        Some(json!({ "run_id": run_id })),
                    ),
                }
            }
            Err(BrainBridgeError::Unavailable(_)) if started.elapsed() + pause < budget => {}
            Err(error) => {
                let unavailable = matches!(error, BrainBridgeError::Unavailable(_));
                let (status, code, message, details) = bridge_failure(error);
                // The run is the brain's: say which one, so the caller can read
                // it once the brain is back.
                let details = if unavailable {
                    Some(json!({ "run_id": run_id }))
                } else {
                    details
                };
                return Outcome::Failed(status, code, message, details);
            }
        }
        if started.elapsed() >= budget {
            return Outcome::TimedOut;
        }
        tokio::time::sleep(pause).await;
        pause = (pause * 2).min(ANSWER_POLL_MAX);
    }
}

fn still_running(run_id: &str) -> (StatusCode, &'static str, String, Value) {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        "RUN_STILL_RUNNING",
        "the run has not finished within its deadline; read it later with GET /v1/runs/{run_id}"
            .to_string(),
        json!({ "run_id": run_id }),
    )
}

fn with_run_id(mut response: Response, run_id: &str) -> Response {
    if let Ok(value) = HeaderValue::from_str(run_id) {
        response.headers_mut().insert(RUN_ID_HEADER, value);
    }
    response
}

/// Serve one chat completion for a virtual model: create the run, wait for its
/// verified answer, and answer in the compat shape. `on_usage` hears the
/// answer's tokens once, when there is an answer.
pub async fn serve_chat(
    runs: &RunsState,
    actor: &RunActor,
    body: Value,
    idempotency_key: Option<String>,
    on_usage: UsageSink,
) -> Response {
    // A compat call both creates the run and reads its answer.
    for needed in [scope::CREATE, scope::READ] {
        if !actor.has(needed) {
            return missing_scope(needed);
        }
    }
    // A slot to wait in comes before the run: a caller that could not wait
    // for its answer must not leave a run behind that nobody reads.
    let Some(waiter) = runs.try_compat_waiter() else {
        return waiters_exhausted();
    };
    let stream = body["stream"].as_bool() == Some(true);
    let model = body["model"].as_str().unwrap_or("cognia/auto").to_string();
    let budget = wait_budget(&body);

    let created = runs
        .bridge()
        .call(
            command::CHAT_CREATE,
            json!({ "actor": actor.as_payload(), "body": body, "idempotencyKey": idempotency_key }),
        )
        .await;
    let created = match created {
        Ok(value) => value,
        Err(error) => return bridge_error(error),
    };
    let Some((_, run_id)) = accepted_response(&created) else {
        return unreadable_answer("a chat completion");
    };

    if !stream {
        // Held until the answer (or the refusal) is built, then released.
        let _waiter = waiter;
        let response = match wait_for_answer(runs, actor, &run_id, &model, budget).await {
            Outcome::Answer(answer) => {
                on_usage(answer_tokens(&answer));
                Json(answer).into_response()
            }
            Outcome::Failed(status, code, message, details) => {
                error_response(status, &code, &message, details)
            }
            Outcome::TimedOut => {
                let (status, code, message, details) = still_running(&run_id);
                error_response(status, code, &message, Some(details))
            }
        };
        return with_run_id(response, &run_id);
    }

    let heartbeat = Event::default().comment(format!(
        "cognia run {run_id} accepted; the answer is sent once it is verified"
    ));
    let runs = runs.clone();
    let actor = actor.clone();
    let waiting_run = run_id.clone();
    let answer = futures_util::stream::once(async move {
        // The slot travels with the stream: released once the answer is
        // produced, or when the caller drops the stream mid-wait.
        let _waiter = waiter;
        let frames: Vec<Event> = match wait_for_answer(&runs, &actor, &waiting_run, &model, budget)
            .await
        {
            Outcome::Answer(response) => {
                on_usage(answer_tokens(&response));
                completion_chunks(&response)
                    .into_iter()
                    .map(|chunk| Event::default().data(chunk.to_string()))
                    .collect()
            }
            Outcome::Failed(status, code, message, details) => {
                vec![Event::default().data(error_body(status, &code, &message, details).to_string())]
            }
            Outcome::TimedOut => {
                let (status, code, message, details) = still_running(&waiting_run);
                vec![Event::default()
                    .data(error_body(status, code, &message, Some(details)).to_string())]
            }
        };
        futures_util::stream::iter(
            frames
                .into_iter()
                .chain(std::iter::once(Event::default().data("[DONE]")))
                .map(Ok::<Event, Infallible>),
        )
    });
    let stream = futures_util::StreamExt::chain(
        futures_util::stream::iter([Ok::<Event, Infallible>(heartbeat)]),
        futures_util::StreamExt::flatten(answer),
    );
    let response = Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(SSE_KEEPALIVE_INTERVAL))
        .into_response();
    with_run_id(response, &run_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::brain_bridge::RecordingBrainBridge;
    use futures_util::StreamExt;
    use std::sync::Arc;

    fn actor(scopes: &[&str]) -> RunActor {
        RunActor {
            key_id: Some("key-a".into()),
            key_name: "CI robot".into(),
            scopes: scopes.iter().map(|s| s.to_string()).collect(),
        }
    }

    fn runs_with(bridge: &RecordingBrainBridge) -> RunsState {
        let runs = RunsState::new(Arc::new(bridge.clone()));
        runs.switches.write().runs_enabled = true;
        runs
    }

    fn created(run_id: &str) -> Value {
        json!({
            "accepted": {
                "schema_version": "1.0.0",
                "run_id": run_id,
                "session_id": "22222222-2222-4222-8222-222222222222",
                "session_version": 0,
                "status": "queued",
                "version": 1,
                "created_at": "2026-09-16T08:00:00.000Z"
            },
            "replayed": false
        })
    }

    fn chat_response(run_id: &str, answer: &str) -> Value {
        json!({
            "id": format!("chatcmpl-{run_id}"),
            "object": "chat.completion",
            "created": 1_800_000_000,
            "model": "cognia/panel",
            "choices": [{ "index": 0, "message": { "role": "assistant", "content": answer }, "finish_reason": "stop" }],
            "usage": { "prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15 },
            "routing": { "run_id": run_id, "mode_executed": "panel", "degraded": false, "billing": {} }
        })
    }

    fn body(stream: bool) -> Value {
        json!({
            "model": "cognia/panel",
            "stream": stream,
            "messages": [{ "role": "user", "content": "What is the 2025 steel tariff?" }],
            "routing": {
                "profile": "balanced",
                "budget": { "max_cost_usd": "1.000000", "mode": "tracked" },
                "deadline_ms": 120000,
                "allow_degraded": false
            }
        })
    }

    async fn text_of(response: Response) -> String {
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        String::from_utf8_lossy(&bytes).to_string()
    }

    #[test]
    fn an_ordinary_model_is_left_alone() {
        for model in ["gpt-5-mini", "claude-opus-5", "fast", "anthropic/claude"] {
            assert_eq!(
                classify(model, true),
                VirtualModelVerdict::NotVirtual,
                "{model}"
            );
            assert!(!is_virtual_model(model));
        }
    }

    #[test]
    fn the_spec_spelling_is_accepted_beside_the_documented_one() {
        assert_eq!(virtual_mode_name("router/auto").as_deref(), Some("auto"));
        assert_eq!(virtual_mode_name("Cognia/Auto").as_deref(), Some("auto"));
        assert_eq!(
            virtual_mode_name("  cognia/panel ").as_deref(),
            Some("panel")
        );
        assert_eq!(virtual_mode_name("gpt-5"), None);
    }

    #[test]
    fn a_switched_off_host_refuses_rather_than_routing_the_request_itself() {
        for model in ["cognia/auto", "cognia/panel", "cognia/delegate"] {
            match classify(model, false) {
                VirtualModelVerdict::Refuse { status, code, .. } => {
                    assert_eq!(status, 403, "{model}");
                    assert_eq!(code, "ROUTER_FUSION_DISABLED", "{model}");
                }
                other => panic!("unexpected for {model}: {other:?}"),
            }
        }
    }

    #[test]
    fn a_switched_off_host_leaves_the_spec_alias_to_ordinary_resolution() {
        // D37: an upstream model named `router/...` resolved before this
        // feature existed, and still does while runs are off.
        for model in ["router/auto", "Router/panel", "router/some-upstream-model"] {
            assert_eq!(
                classify(model, false),
                VirtualModelVerdict::NotVirtual,
                "{model}"
            );
        }
    }

    #[test]
    fn the_four_modes_are_served_once_the_switch_is_on() {
        for (model, mode) in [
            ("cognia/auto", "auto"),
            ("cognia/direct", "direct"),
            ("router/cascade", "cascade"),
            ("cognia/panel", "panel"),
        ] {
            assert_eq!(
                classify(model, true),
                VirtualModelVerdict::Serve {
                    mode: mode.to_string()
                },
                "{model}"
            );
        }
    }

    #[test]
    fn delegate_names_where_it_does_live_and_an_invented_mode_is_named() {
        match classify("cognia/delegate", true) {
            VirtualModelVerdict::Refuse {
                status,
                code,
                message,
            } => {
                assert_eq!(status, 422);
                assert_eq!(code, "DELEGATE_REQUIRES_RUN_API");
                assert!(message.contains("/v1/runs"));
            }
            other => panic!("unexpected: {other:?}"),
        }
        match classify("cognia/telepathy", true) {
            VirtualModelVerdict::Refuse { code, message, .. } => {
                assert_eq!(code, "UNKNOWN_VIRTUAL_MODEL");
                assert!(message.contains("telepathy"));
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn the_models_list_shows_the_virtual_models_only_to_a_key_that_can_use_them() {
        let able = actor(&[scope::CREATE, scope::READ]);
        let ids: Vec<Value> = model_documents(true, &able)
            .iter()
            .map(|m| m["id"].clone())
            .collect();
        assert_eq!(
            ids,
            VIRTUAL_MODELS
                .iter()
                .map(|id| json!(id))
                .collect::<Vec<_>>()
        );
        assert!(model_documents(false, &able).is_empty());
        assert!(model_documents(true, &actor(&[scope::CREATE])).is_empty());
        assert!(model_documents(true, &RunActor::default()).is_empty());
    }

    #[test]
    fn an_endpoint_without_the_compat_subset_refuses_every_virtual_name() {
        for (model, enabled, code) in [
            ("cognia/auto", true, "VIRTUAL_MODEL_CHAT_COMPLETIONS_ONLY"),
            ("router/panel", true, "VIRTUAL_MODEL_CHAT_COMPLETIONS_ONLY"),
            ("cognia/delegate", true, "DELEGATE_REQUIRES_RUN_API"),
            ("cognia/telepathy", true, "UNKNOWN_VIRTUAL_MODEL"),
            ("cognia/auto", false, "ROUTER_FUSION_DISABLED"),
        ] {
            match verdict_off_compat(model, enabled) {
                VirtualModelVerdict::Refuse { code: got, .. } => assert_eq!(got, code, "{model}"),
                other => panic!("unexpected for {model}: {other:?}"),
            }
        }
        // D37: ordinary names, and `router/*` while runs are off, carry on.
        assert_eq!(
            verdict_off_compat("gpt-5-mini", true),
            VirtualModelVerdict::NotVirtual
        );
        assert_eq!(
            verdict_off_compat("router/auto", false),
            VirtualModelVerdict::NotVirtual
        );
    }

    #[tokio::test]
    async fn a_refusal_is_the_contracts_error_with_the_code_in_code() {
        let response = refusal_response("cognia/auto", 422, "X_CODE", "why");
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let parsed: Value = serde_json::from_str(&text_of(response).await).unwrap();
        assert_eq!(parsed["error"]["code"], "X_CODE");
        assert_eq!(parsed["error"]["message"], "why");
        assert_eq!(parsed["error"]["retryable"], false);
        assert_eq!(parsed["error"]["details"]["model"], "cognia/auto");
        assert!(parsed["error"].get("type").is_none());
        // A status that is not an error never reaches the caller as one.
        assert_eq!(
            refusal_response("cognia/auto", 200, "X", "m").status(),
            StatusCode::BAD_REQUEST
        );
    }

    #[test]
    fn a_single_model_document_follows_the_lists_rule() {
        let able = actor(&[scope::CREATE, scope::READ]);
        assert_eq!(
            model_document("cognia/cascade", true, &able).unwrap()["owned_by"],
            "cognia"
        );
        assert!(model_document("cognia/cascade", false, &able).is_none());
        assert!(model_document("cognia/cascade", true, &actor(&[scope::READ])).is_none());
        assert!(model_document("cognia/delegate", true, &able).is_none());
        assert!(model_document("cognia/telepathy", true, &able).is_none());
    }

    #[tokio::test]
    async fn a_caller_past_the_waiter_cap_is_turned_away_before_a_run_exists() {
        let bridge = RecordingBrainBridge::new();
        let runs = runs_with(&bridge);
        let held: Vec<_> = (0..MAX_COMPAT_WAITERS)
            .map(|_| runs.try_compat_waiter().unwrap())
            .collect();
        let response = serve_chat(
            &runs,
            &actor(&[scope::CREATE, scope::READ]),
            body(false),
            None,
            Box::new(|_| {}),
        )
        .await;
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(
            response
                .headers()
                .get(axum::http::header::RETRY_AFTER)
                .unwrap(),
            "1"
        );
        let parsed: Value = serde_json::from_str(&text_of(response).await).unwrap();
        assert_eq!(parsed["error"]["code"], "RUN_WAITERS_EXHAUSTED");
        assert_eq!(parsed["error"]["retryable"], true);
        assert_eq!(parsed["error"]["details"]["limit"], MAX_COMPAT_WAITERS);
        // Nothing was created: the brain was never asked.
        assert!(bridge.calls().is_empty());
        drop(held);
        assert_eq!(runs.idle_compat_waiters(), MAX_COMPAT_WAITERS);
    }

    #[tokio::test(start_paused = true)]
    async fn a_waiter_slot_is_held_while_waiting_and_released_with_the_answer() {
        let bridge = RecordingBrainBridge::new();
        let run_id = "11111111-1111-4111-8111-111111111111";
        bridge.ok(command::CHAT_CREATE, created(run_id));
        bridge.ok(
            command::CHAT_RESULT,
            json!({ "state": "succeeded", "response": chat_response(run_id, "4%.") }),
        );
        let runs = runs_with(&bridge);
        let response = serve_chat(
            &runs,
            &actor(&[scope::CREATE, scope::READ]),
            body(false),
            None,
            Box::new(|_| {}),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(runs.idle_compat_waiters(), MAX_COMPAT_WAITERS);

        // A streaming wait holds its slot inside the stream…
        bridge.ok(command::CHAT_CREATE, created(run_id));
        for _ in 0..4 {
            bridge.ok(
                command::CHAT_RESULT,
                json!({ "state": "pending", "status": "running", "lastSeq": 1 }),
            );
        }
        let response = serve_chat(
            &runs,
            &actor(&[scope::CREATE, scope::READ]),
            body(true),
            None,
            Box::new(|_| {}),
        )
        .await;
        assert_eq!(runs.idle_compat_waiters(), MAX_COMPAT_WAITERS - 1);
        let mut stream = response.into_body().into_data_stream();
        stream.next().await.expect("a heartbeat").expect("readable");
        assert_eq!(runs.idle_compat_waiters(), MAX_COMPAT_WAITERS - 1);
        // …and a caller that goes away gives it back.
        drop(stream);
        assert_eq!(runs.idle_compat_waiters(), MAX_COMPAT_WAITERS);
    }

    #[test]
    fn the_wait_follows_the_requests_own_deadline_within_the_contracts_bound() {
        assert_eq!(
            wait_budget(&body(false)),
            Duration::from_secs(120) + RUN_WAIT_GRACE
        );
        assert_eq!(
            wait_budget(&json!({})),
            DEFAULT_RUN_DEADLINE + RUN_WAIT_GRACE
        );
        assert_eq!(
            wait_budget(&json!({ "routing": { "deadline_ms": 99_999_999u64 } })),
            MAX_RUN_DEADLINE + RUN_WAIT_GRACE
        );
    }

    #[test]
    fn an_answer_is_split_on_character_boundaries_and_rebuilds_exactly() {
        let answer = "价格上涨了4%。🙂".repeat(3);
        let chunks = answer_chunks(&answer, 4);
        assert!(chunks.iter().all(|chunk| chunk.chars().count() <= 4));
        assert_eq!(chunks.concat(), answer);
        assert!(answer_chunks("", 4).is_empty());
    }

    #[tokio::test]
    async fn a_key_that_cannot_read_its_answer_is_refused_before_a_run_exists() {
        let bridge = RecordingBrainBridge::new();
        let response = serve_chat(
            &runs_with(&bridge),
            &actor(&[scope::CREATE]),
            body(false),
            None,
            Box::new(|_| {}),
        )
        .await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert!(bridge.calls().is_empty());
    }

    #[tokio::test]
    async fn api_04_the_brains_compat_refusal_is_the_callers_422() {
        // [ACC:API-04] The subset is enforced where the contract lives: the brain.
        let bridge = RecordingBrainBridge::new();
        bridge.refuse(command::CHAT_CREATE, 422, "UNSUPPORTED_PARAMETER");
        let mut with_tools = body(false);
        with_tools["tools"] = json!([]);
        let response = serve_chat(
            &runs_with(&bridge),
            &actor(&[scope::CREATE, scope::READ]),
            with_tools,
            None,
            Box::new(|_| {}),
        )
        .await;
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let text = text_of(response).await;
        let parsed: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(parsed["error"]["code"], "UNSUPPORTED_PARAMETER");
        // The caller's body reached the brain untouched, tools included.
        assert_eq!(
            bridge.payloads_for(command::CHAT_CREATE)[0]["body"]["tools"],
            json!([])
        );
        assert!(bridge.payloads_for(command::CHAT_RESULT).is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn a_non_streaming_call_waits_for_the_verified_answer() {
        let bridge = RecordingBrainBridge::new();
        let run_id = "11111111-1111-4111-8111-111111111111";
        bridge.ok(command::CHAT_CREATE, created(run_id));
        bridge.ok(
            command::CHAT_RESULT,
            json!({ "state": "pending", "status": "running", "lastSeq": 3 }),
        );
        bridge.ok(
            command::CHAT_RESULT,
            json!({ "state": "succeeded", "response": chat_response(run_id, "4%.") }),
        );
        let tokens = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let heard = tokens.clone();
        let response = serve_chat(
            &runs_with(&bridge),
            &actor(&[scope::CREATE, scope::READ]),
            body(false),
            Some("k1".into()),
            Box::new(move |tokens| heard.lock().push(tokens)),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers().get(RUN_ID_HEADER).unwrap(), run_id);
        let parsed: Value = serde_json::from_str(&text_of(response).await).unwrap();
        assert_eq!(parsed, chat_response(run_id, "4%."));
        assert_eq!(
            bridge.payloads_for(command::CHAT_CREATE)[0]["idempotencyKey"],
            "k1"
        );
        let results = bridge.payloads_for(command::CHAT_RESULT);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0]["runId"], run_id);
        assert_eq!(results[0]["model"], "cognia/panel");
        // The key's quota hears the answer's tokens once.
        assert_eq!(*tokens.lock(), vec![15]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_brain_that_drops_away_mid_wait_is_asked_again_within_the_budget() {
        let bridge = RecordingBrainBridge::new();
        let run_id = "11111111-1111-4111-8111-111111111111";
        bridge.ok(command::CHAT_CREATE, created(run_id));
        for _ in 0..2 {
            bridge.answer(
                command::CHAT_RESULT,
                Err(BrainBridgeError::unavailable(
                    "window reloading".to_string(),
                )),
            );
        }
        bridge.ok(
            command::CHAT_RESULT,
            json!({ "state": "succeeded", "response": chat_response(run_id, "4%.") }),
        );
        let started = tokio::time::Instant::now();
        let response = serve_chat(
            &runs_with(&bridge),
            &actor(&[scope::CREATE, scope::READ]),
            body(false),
            None,
            Box::new(|_| {}),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(bridge.payloads_for(command::CHAT_RESULT).len(), 3);
        // The pauses back off: 250 ms, then 500 ms.
        assert_eq!(started.elapsed(), Duration::from_millis(750));
    }

    #[test]
    fn an_answer_without_a_total_counts_its_parts() {
        assert_eq!(answer_tokens(&json!({ "usage": { "total_tokens": 9 } })), 9);
        assert_eq!(
            answer_tokens(&json!({ "usage": { "prompt_tokens": 4, "completion_tokens": 3 } })),
            7
        );
        assert_eq!(answer_tokens(&json!({})), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn a_run_that_ends_without_an_answer_is_its_own_error() {
        let bridge = RecordingBrainBridge::new();
        let run_id = "11111111-1111-4111-8111-111111111111";
        bridge.ok(command::CHAT_CREATE, created(run_id));
        bridge.answer(
            command::CHAT_RESULT,
            Err(BrainBridgeError::Refused {
                status: 422,
                code: "VERIFICATION_FAILED".into(),
                message: "withheld".into(),
                details: Some(json!({ "run_id": run_id, "run_status": "failed" })),
            }),
        );
        let response = serve_chat(
            &runs_with(&bridge),
            &actor(&[scope::CREATE, scope::READ]),
            body(false),
            None,
            Box::new(|_| {}),
        )
        .await;
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let parsed: Value = serde_json::from_str(&text_of(response).await).unwrap();
        assert_eq!(parsed["error"]["code"], "VERIFICATION_FAILED");
        assert_eq!(parsed["error"]["details"]["run_id"], run_id);
    }

    #[tokio::test(start_paused = true)]
    async fn a_run_that_outlives_its_deadline_is_left_to_be_read_later() {
        let bridge = RecordingBrainBridge::new();
        let run_id = "11111111-1111-4111-8111-111111111111";
        bridge.ok(command::CHAT_CREATE, created(run_id));
        let polls = ((Duration::from_secs(2) + RUN_WAIT_GRACE).as_millis()
            / ANSWER_POLL_FIRST.as_millis()) as usize
            + 2;
        for _ in 0..polls {
            bridge.ok(
                command::CHAT_RESULT,
                json!({ "state": "pending", "status": "running", "lastSeq": 1 }),
            );
        }
        let mut short = body(false);
        short["routing"]["deadline_ms"] = json!(2000);
        let response = serve_chat(
            &runs_with(&bridge),
            &actor(&[scope::CREATE, scope::READ]),
            short,
            None,
            Box::new(|_| {}),
        )
        .await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let parsed: Value = serde_json::from_str(&text_of(response).await).unwrap();
        assert_eq!(parsed["error"]["code"], "RUN_STILL_RUNNING");
        assert_eq!(parsed["error"]["retryable"], true);
        assert_eq!(parsed["error"]["details"]["run_id"], run_id);
        // Waiting never became cancelling.
        assert!(bridge
            .calls()
            .iter()
            .all(|(name, _)| name != command::RUN_CANCEL));
    }

    #[tokio::test(start_paused = true)]
    async fn sse_02_a_stream_holds_only_comments_until_the_answer_is_verified() {
        // [ACC:SSE-02]
        let bridge = RecordingBrainBridge::new();
        let run_id = "11111111-1111-4111-8111-111111111111";
        let answer = "The 2025 steel tariff is 4%. ".repeat(40);
        bridge.ok(command::CHAT_CREATE, created(run_id));
        for _ in 0..3 {
            bridge.ok(
                command::CHAT_RESULT,
                json!({ "state": "pending", "status": "running", "lastSeq": 2 }),
            );
        }
        bridge.ok(
            command::CHAT_RESULT,
            json!({ "state": "succeeded", "response": chat_response(run_id, &answer) }),
        );
        let response = serve_chat(
            &runs_with(&bridge),
            &actor(&[scope::CREATE, scope::READ]),
            body(true),
            None,
            Box::new(|_| {}),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers().get(RUN_ID_HEADER).unwrap(), run_id);
        assert_eq!(
            response
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok()),
            Some("text/event-stream")
        );
        let text = text_of(response).await;
        let lines: Vec<&str> = text.lines().filter(|line| !line.is_empty()).collect();
        let first_data = lines
            .iter()
            .position(|line| line.starts_with("data: "))
            .unwrap();
        // Before the verified answer: comments only, no token of any draft.
        assert!(
            lines[..first_data].iter().all(|line| line.starts_with(':')),
            "{text}"
        );
        let data: Vec<&str> = lines
            .iter()
            .filter_map(|line| line.strip_prefix("data: "))
            .collect();
        assert_eq!(*data.last().unwrap(), "[DONE]");
        let chunks: Vec<Value> = data[..data.len() - 1]
            .iter()
            .map(|frame| serde_json::from_str(frame).unwrap())
            .collect();
        assert_eq!(chunks[0]["choices"][0]["delta"]["role"], "assistant");
        let content: String = chunks
            .iter()
            .filter_map(|chunk| chunk["choices"][0]["delta"]["content"].as_str())
            .collect();
        assert_eq!(content, answer);
        assert!(chunks.len() > 3, "the answer arrives in several deltas");
        let last = chunks.last().unwrap();
        assert_eq!(last["choices"][0]["finish_reason"], "stop");
        assert_eq!(last["usage"]["total_tokens"], 15);
        assert_eq!(last["routing"]["run_id"], run_id);
        assert!(chunks
            .iter()
            .all(|chunk| chunk["object"] == "chat.completion.chunk"));
    }

    #[tokio::test(start_paused = true)]
    async fn a_stream_whose_run_fails_ends_with_the_error_and_done() {
        let bridge = RecordingBrainBridge::new();
        let run_id = "11111111-1111-4111-8111-111111111111";
        bridge.ok(command::CHAT_CREATE, created(run_id));
        bridge.refuse(command::CHAT_RESULT, 409, "RUN_BUDGET_EXHAUSTED");
        let response = serve_chat(
            &runs_with(&bridge),
            &actor(&[scope::CREATE, scope::READ]),
            body(true),
            None,
            Box::new(|_| {}),
        )
        .await;
        let text = text_of(response).await;
        let data: Vec<&str> = text
            .lines()
            .filter_map(|line| line.strip_prefix("data: "))
            .collect();
        assert_eq!(data.len(), 2, "{text}");
        let error: Value = serde_json::from_str(data[0]).unwrap();
        assert_eq!(error["error"]["code"], "RUN_BUDGET_EXHAUSTED");
        assert_eq!(data[1], "[DONE]");
    }

    #[tokio::test(start_paused = true)]
    async fn sse_03_a_caller_that_drops_the_stream_does_not_cancel_the_run() {
        // [ACC:SSE-03]
        let bridge = RecordingBrainBridge::new();
        let run_id = "11111111-1111-4111-8111-111111111111";
        bridge.ok(command::CHAT_CREATE, created(run_id));
        for _ in 0..4 {
            bridge.ok(
                command::CHAT_RESULT,
                json!({ "state": "pending", "status": "running", "lastSeq": 1 }),
            );
        }
        let response = serve_chat(
            &runs_with(&bridge),
            &actor(&[scope::CREATE, scope::READ, scope::CANCEL]),
            body(true),
            None,
            Box::new(|_| {}),
        )
        .await;
        let mut stream = response.into_body().into_data_stream();
        let heartbeat = stream.next().await.expect("a heartbeat").expect("readable");
        assert!(String::from_utf8_lossy(&heartbeat).starts_with(':'));
        drop(stream);
        tokio::task::yield_now().await;
        assert!(bridge
            .calls()
            .iter()
            .all(|(name, _)| name != command::RUN_CANCEL));
    }
}

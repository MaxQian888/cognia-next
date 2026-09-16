//! Reserving and settling the gateway's passthrough lane (ADR-0188 D13/D27, B2).
//!
//! A passthrough request is the gateway doing what it has always done: the
//! caller named a concrete model or one of the user's aliases, and the bytes
//! travel unchanged in both directions, tools included. D13 changes nothing
//! about that. It adds one thing: with the `gatewayPassthroughLedger` switch on,
//! each upstream attempt is reserved against the account's budget before it is
//! sent and settled from the usage the gateway already reads out of the answer,
//! so proxied traffic stops being the one lane that spends invisibly.
//!
//! Three rules this module exists to keep (D38):
//!
//! - **A ledger fault never costs the caller their answer.** Passthrough is
//!   ordinary traffic. If the brain does not answer within
//!   [`RESERVE_TIMEOUT`], the request proceeds on the legacy path and says so
//!   in `x-cognia-ledger: bypassed`.
//! - **A refusal is not a fault.** The budget saying no is a real answer and
//!   is never bypassed: the request is refused with the brain's own code.
//! - **Settling never blocks the response.** The caller's bytes are already on
//!   their way; the bill is written behind them.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use crate::brain_bridge::{BrainBridge, BrainBridgeError};

/// Commands this lane sends, mirroring `ROUTER_FUSION_PASSTHROUGH_COMMANDS` in
/// `lib/router-fusion/gate/passthrough-bridge.ts`.
pub mod command {
    pub const RESERVE: &str = "router_fusion_passthrough_reserve";
    pub const SETTLE: &str = "router_fusion_passthrough_settle";
}

/// How long a reservation may hold the request up.
///
/// Much shorter than the Run API's ten seconds, and for the opposite reason: a
/// `/v1/runs` caller asked for Router + Fusion and can wait for it, while this
/// caller asked for a proxy and is paying for the wait in latency on every
/// request. Two seconds is long enough for a busy renderer to answer and short
/// enough that a wedged brain costs a noticeable-but-survivable delay once,
/// after which the breaker takes the lane out.
pub const RESERVE_TIMEOUT: Duration = Duration::from_secs(2);

/// Settling is behind the caller's response, so it may wait longer — but not
/// forever: the task holds a bridge slot.
pub const SETTLE_TIMEOUT: Duration = Duration::from_secs(10);

/// What the ledger said about one upstream attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReserveVerdict {
    /// Reserved. Settle it with [`settle`] when the attempt resolves.
    Ledgered { run_id: String, attempt_id: String },
    /// Not ledgered, and that is fine: send the request anyway. `reason` is what
    /// `x-cognia-ledger` reports — `surface_off`, `breaker_tripped`,
    /// `ledger_unavailable`, `brain_unavailable`.
    Bypassed { reason: String },
    /// The ledger refused. The request is NOT sent.
    Refused { code: String, reasons: Vec<String> },
}

/// Why an attempt failed, in the ledger's own vocabulary (`RoleCallErrorClass`
/// in `packages/router-fusion/src/workflows/ports.ts`). The class decides what
/// the ledger does with the reservation, so it is named precisely rather than
/// folded into one "provider error".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureClass {
    /// Connect, DNS or TLS failure: nothing left this machine.
    NotSent,
    /// 429 or an overload refusal before any processing.
    RateLimited,
    /// A 5xx answer: nothing billable was produced.
    ServerError,
    /// 401 / 403.
    Auth,
    /// Any other 4xx.
    InvalidRequest,
}

impl FailureClass {
    /// The class an upstream HTTP status belongs to.
    pub fn of_status(status: u16) -> Self {
        match status {
            429 => Self::RateLimited,
            401 | 403 => Self::Auth,
            500..=599 => Self::ServerError,
            _ => Self::InvalidRequest,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::NotSent => "not_sent",
            Self::RateLimited => "rate_limited",
            Self::ServerError => "server_error",
            Self::Auth => "auth",
            Self::InvalidRequest => "invalid_request",
        }
    }
}

/// How the attempt ended, as the gateway can see it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AttemptOutcome {
    Succeeded,
    Failed(FailureClass),
    /// Sent, no answer: a stalled stream, a dropped connection. The money stays
    /// held on purpose — the bill exists and is not knowable yet.
    Unknown,
}

impl AttemptOutcome {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Succeeded => "succeeded",
            Self::Failed(_) => "failed",
            Self::Unknown => "unknown",
        }
    }
}

/// The token counts the gateway sniffs out of the answer for its own accounting.
///
/// Every field is optional because an upstream that reported nothing must stay
/// "nothing reported": a zero here would be a claim about the bill.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AttemptUsage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cache_read_tokens: Option<u64>,
    pub cache_write_tokens: Option<u64>,
}

impl AttemptUsage {
    pub fn is_empty(&self) -> bool {
        self.input_tokens.is_none() && self.output_tokens.is_none()
    }

    fn to_json(&self) -> Option<Value> {
        if self.is_empty() {
            return None;
        }
        let mut value = json!({});
        if let Some(v) = self.input_tokens {
            value["inputTokens"] = json!(v);
        }
        if let Some(v) = self.output_tokens {
            value["outputTokens"] = json!(v);
        }
        if let Some(v) = self.cache_read_tokens {
            value["cacheReadTokens"] = json!(v);
        }
        if let Some(v) = self.cache_write_tokens {
            value["cacheWriteTokens"] = json!(v);
        }
        Some(value)
    }
}

/// Everything one attempt needs reserving against.
#[derive(Debug, Clone)]
pub struct ReserveRequest {
    /// The gateway's own request id: one request, one run, however many attempts.
    pub request_id: String,
    /// 0-based candidate index. Each attempt is its own logical step.
    pub attempt: usize,
    pub provider_id: String,
    pub model_id: String,
    /// What the caller asked for — an alias or a concrete name.
    pub requested_model: String,
    pub key_id: Option<String>,
    pub key_name: String,
    pub estimated_input_tokens: u64,
    pub max_output_tokens: Option<u64>,
}

/// The reservation an attempt carries until it settles.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LedgeredAttempt {
    pub run_id: String,
    pub attempt_id: String,
}

fn bypass(reason: &str) -> ReserveVerdict {
    ReserveVerdict::Bypassed {
        reason: reason.to_string(),
    }
}

/// Read the brain's answer. Anything unrecognised is a bypass, never a guess:
/// inventing a reservation id would settle a call nothing reserved.
fn verdict_of(raw: Value) -> ReserveVerdict {
    match raw["status"].as_str() {
        Some("ledgered") => {
            let run_id = raw["runId"].as_str().unwrap_or_default().to_string();
            let attempt_id = raw["attemptId"].as_str().unwrap_or_default().to_string();
            if run_id.is_empty() || attempt_id.is_empty() {
                return bypass("ledger_unavailable");
            }
            ReserveVerdict::Ledgered { run_id, attempt_id }
        }
        Some("refused") => ReserveVerdict::Refused {
            code: raw["code"]
                .as_str()
                .unwrap_or("ROUTER_FUSION_REFUSED")
                .to_string(),
            reasons: raw["reasons"]
                .as_array()
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default(),
        },
        Some("bypassed") => bypass(raw["code"].as_str().unwrap_or("ledger_unavailable")),
        _ => bypass("ledger_unavailable"),
    }
}

/// Reserve one upstream attempt.
///
/// `enabled` is the switch as the brain last pushed it; with it off nothing is
/// asked at all, so a host that never turns the lane on pays no latency and
/// opens no bridge.
pub async fn reserve(
    bridge: Arc<dyn BrainBridge>,
    enabled: bool,
    request: ReserveRequest,
) -> ReserveVerdict {
    if !enabled {
        return bypass("surface_off");
    }
    let mut payload = json!({
        "requestId": request.request_id,
        "attempt": request.attempt,
        "providerId": request.provider_id,
        "modelId": request.model_id,
        "requestedModel": request.requested_model,
        "keyId": request.key_id,
        "keyName": request.key_name,
        "estimatedInputTokens": request.estimated_input_tokens,
    });
    if let Some(max_output) = request.max_output_tokens {
        payload["maxOutputTokens"] = json!(max_output);
    }
    match tokio::time::timeout(RESERVE_TIMEOUT, bridge.call(command::RESERVE, payload)).await {
        Ok(Ok(raw)) => verdict_of(raw),
        // The brain reached its own refusal path but answered with a throw
        // rather than a value. Ordinary traffic is never stopped by that.
        Ok(Err(BrainBridgeError::Refused { code, .. })) => ReserveVerdict::Refused {
            code,
            reasons: Vec::new(),
        },
        Ok(Err(BrainBridgeError::Unavailable(_))) => bypass("brain_unavailable"),
        Err(_) => bypass("brain_timeout"),
    }
}

/// Settle one attempt. Fire-and-forget: the caller's response is already on its
/// way, and the bill is written behind it.
pub fn settle(
    bridge: Arc<dyn BrainBridge>,
    attempt: LedgeredAttempt,
    outcome: AttemptOutcome,
    usage: AttemptUsage,
    reason: Option<String>,
    final_attempt: bool,
) {
    let mut payload = json!({
        "runId": attempt.run_id,
        "attemptId": attempt.attempt_id,
        "outcome": outcome.as_str(),
        "final": final_attempt,
    });
    if let AttemptOutcome::Failed(class) = outcome {
        payload["errorClass"] = json!(class.as_str());
    }
    if let Some(usage) = usage.to_json() {
        payload["usage"] = usage;
    }
    if let Some(reason) = reason {
        payload["reason"] = json!(reason);
    }
    tokio::spawn(async move {
        let _ = tokio::time::timeout(SETTLE_TIMEOUT, bridge.call(command::SETTLE, payload)).await;
    });
}

/// The value of `x-cognia-ledger` for a whole request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LedgerHeader {
    Ledgered,
    Bypassed(String),
}

impl LedgerHeader {
    pub fn value(&self) -> String {
        match self {
            Self::Ledgered => "ledgered".to_string(),
            Self::Bypassed(reason) => format!("bypassed:{reason}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::brain_bridge::RecordingBrainBridge;

    fn request() -> ReserveRequest {
        ReserveRequest {
            request_id: "req-1".to_string(),
            attempt: 0,
            provider_id: "openai".to_string(),
            model_id: "gpt-5-mini".to_string(),
            requested_model: "fast".to_string(),
            key_id: Some("key-a".to_string()),
            key_name: "CI robot".to_string(),
            estimated_input_tokens: 800,
            max_output_tokens: Some(4096),
        }
    }

    #[tokio::test]
    async fn a_switched_off_lane_asks_nothing_at_all() {
        let bridge = Arc::new(RecordingBrainBridge::default());
        let verdict = reserve(bridge.clone(), false, request()).await;
        assert_eq!(
            verdict,
            ReserveVerdict::Bypassed {
                reason: "surface_off".to_string()
            }
        );
        // The whole point of the off path: no bridge traffic, no latency.
        assert!(bridge.calls().is_empty());
    }

    #[tokio::test]
    async fn a_reservation_carries_the_run_the_request_bills_to() {
        let bridge = Arc::new(RecordingBrainBridge::default());
        bridge.answer(
            command::RESERVE,
            Ok(json!({ "status": "ledgered", "runId": "gwpt:req-1", "attemptId": "a1" })),
        );
        let verdict = reserve(bridge.clone(), true, request()).await;
        assert_eq!(
            verdict,
            ReserveVerdict::Ledgered {
                run_id: "gwpt:req-1".to_string(),
                attempt_id: "a1".to_string()
            }
        );
        let calls = bridge.calls();
        assert_eq!(calls[0].0, command::RESERVE);
        assert_eq!(calls[0].1["requestId"], "req-1");
        assert_eq!(calls[0].1["maxOutputTokens"], 4096);
    }

    #[tokio::test]
    async fn a_refusal_stops_the_request_rather_than_being_bypassed() {
        // The budget saying no is a real answer. Proxying anyway would spend
        // money the user already said no to — the failure this lane exists for.
        let bridge = Arc::new(RecordingBrainBridge::default());
        bridge.answer(
            command::RESERVE,
            Ok(json!({ "status": "refused", "code": "BUDGET_EXCEEDED", "reasons": ["cap"] })),
        );
        assert_eq!(
            reserve(bridge, true, request()).await,
            ReserveVerdict::Refused {
                code: "BUDGET_EXCEEDED".to_string(),
                reasons: vec!["cap".to_string()],
            }
        );
    }

    #[tokio::test]
    async fn an_absent_brain_lets_the_request_through() {
        let bridge = Arc::new(RecordingBrainBridge::default());
        bridge.answer(
            command::RESERVE,
            Err(BrainBridgeError::unavailable("no window")),
        );
        assert_eq!(
            reserve(bridge, true, request()).await,
            ReserveVerdict::Bypassed {
                reason: "brain_unavailable".to_string()
            }
        );
    }

    #[tokio::test]
    async fn an_answer_it_cannot_read_is_a_bypass_rather_than_a_guess() {
        // Inventing a reservation id would settle a call nothing reserved.
        for raw in [
            json!({ "status": "ledgered", "runId": "gwpt:req-1" }),
            json!({ "status": "who knows" }),
            json!(null),
        ] {
            let bridge = Arc::new(RecordingBrainBridge::default());
            bridge.answer(command::RESERVE, Ok(raw));
            assert!(matches!(
                reserve(bridge, true, request()).await,
                ReserveVerdict::Bypassed { .. }
            ));
        }
    }

    #[test]
    fn an_upstream_status_names_the_failure_the_ledger_acts_on() {
        assert_eq!(FailureClass::of_status(429), FailureClass::RateLimited);
        assert_eq!(FailureClass::of_status(503), FailureClass::ServerError);
        assert_eq!(FailureClass::of_status(401), FailureClass::Auth);
        assert_eq!(FailureClass::of_status(403), FailureClass::Auth);
        assert_eq!(FailureClass::of_status(400), FailureClass::InvalidRequest);
        assert_eq!(FailureClass::NotSent.as_str(), "not_sent");
    }

    #[tokio::test]
    async fn a_settled_failure_carries_its_class() {
        let bridge = Arc::new(RecordingBrainBridge::default());
        bridge.answer(command::SETTLE, Ok(json!({ "status": "ledgered" })));
        settle(
            bridge.clone(),
            LedgeredAttempt {
                run_id: "gwpt:req-1".to_string(),
                attempt_id: "a1".to_string(),
            },
            AttemptOutcome::Failed(FailureClass::RateLimited),
            AttemptUsage::default(),
            Some("HTTP 429".to_string()),
            false,
        );
        // Settling is spawned; give the task its turn.
        for _ in 0..20 {
            if !bridge.payloads_for(command::SETTLE).is_empty() {
                break;
            }
            tokio::task::yield_now().await;
        }
        let sent = bridge.payloads_for(command::SETTLE);
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0]["outcome"], "failed");
        assert_eq!(sent[0]["errorClass"], "rate_limited");
        assert_eq!(sent[0]["final"], false);
        assert!(sent[0].get("usage").is_none());
    }

    #[test]
    fn usage_nobody_reported_stays_absent() {
        assert!(AttemptUsage::default().to_json().is_none());
        let partial = AttemptUsage {
            input_tokens: Some(800),
            ..Default::default()
        };
        let json = partial.to_json().expect("some usage");
        assert_eq!(json["inputTokens"], 800);
        assert!(json.get("outputTokens").is_none());
    }

    #[test]
    fn the_header_names_why_a_request_was_not_ledgered() {
        assert_eq!(LedgerHeader::Ledgered.value(), "ledgered");
        assert_eq!(
            LedgerHeader::Bypassed("brain_timeout".to_string()).value(),
            "bypassed:brain_timeout"
        );
    }
}

//! The one long-running operation document (ADR-0175 B3, after AIP-151).
//!
//! A command the durable ledger is still running answers 202 with an
//! `Operation` whose `done` is false. `GET /api/operations/{id}` and
//! `GET /internal/operations/{id}` answer the same document, built from the
//! ledger's `OperationSummary`: once done it carries either `result` or an
//! `error` that is the same problem document a synchronous refusal would have
//! been. The `status` word is the ledger's own and is kept for operators, but
//! a client branches on `done`, `error` and `result`.

use cognia_problem::Problem;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::security_store::OperationSummary;

/// The ledger states that mean the operation will not change again.
pub const TERMINAL_STATUSES: &[&str] = &["succeeded", "failed", "cancelled"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Operation {
    pub id: String,
    /// False while the ledger may still change the outcome.
    pub done: bool,
    /// The ledger's own state word.
    pub status: String,
    /// Present when the operation finished by failing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<Problem>,
    /// Present when the operation finished with a value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    pub metadata: OperationMetadata,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OperationMetadata {
    /// Unix seconds.
    pub created_at: i64,
    /// Unix seconds.
    pub updated_at: i64,
    /// The request that started the operation, when the answer is the 202
    /// itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

impl Operation {
    /// The 202 answer for a command the ledger has accepted and is running.
    pub fn running(id: impl Into<String>, request_id: impl Into<String>) -> Self {
        let now = unix_seconds();
        Self {
            id: id.into(),
            done: false,
            status: "running".to_string(),
            error: None,
            result: None,
            metadata: OperationMetadata {
                created_at: now,
                updated_at: now,
                request_id: Some(request_id.into()),
            },
        }
    }
}

impl From<OperationSummary> for Operation {
    fn from(summary: OperationSummary) -> Self {
        let done = TERMINAL_STATUSES.contains(&summary.status.as_str());
        let (result, error) = match (done, summary.receipt) {
            (true, Some(receipt)) => split_receipt(receipt, &summary.operation_id),
            _ => (None, None),
        };
        Self {
            id: summary.operation_id,
            done,
            status: summary.status,
            error,
            result,
            metadata: OperationMetadata {
                created_at: summary.created_at,
                updated_at: summary.updated_at,
                request_id: None,
            },
        }
    }
}

/// A receipt is what `remote_execution` persisted: `{result}` for a value,
/// `{httpStatus, error}` for a refusal, or the older `{body}` wrapper around
/// either. Anything else is kept as the result so nothing is lost.
fn split_receipt(receipt: Value, operation_id: &str) -> (Option<Value>, Option<Problem>) {
    let status = receipt
        .get("httpStatus")
        .and_then(Value::as_u64)
        .and_then(|value| u16::try_from(value).ok())
        .unwrap_or(500);
    if let Some(error) = receipt
        .get("error")
        .or_else(|| receipt.get("body").and_then(|body| body.get("error")))
    {
        let problem = Problem::parse(error, status)
            .unwrap_or_else(|| {
                Problem::new(
                    status,
                    "operation_failed",
                    "the operation failed and its receipt carries no readable error",
                )
            })
            .with_operation_id(operation_id);
        return (None, Some(problem));
    }
    if let Some(result) = receipt.get("result") {
        return (Some(result.clone()), None);
    }
    if let Some(body) = receipt.get("body") {
        return (Some(body.clone()), None);
    }
    (Some(receipt), None)
}

fn unix_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn summary(status: &str, receipt: Option<Value>) -> OperationSummary {
        OperationSummary {
            operation_id: "op-1".to_string(),
            status: status.to_string(),
            receipt,
            created_at: 100,
            updated_at: 200,
        }
    }

    #[test]
    fn a_running_answer_is_not_done_and_names_its_request() {
        let operation = Operation::running("op-1", "req-1");
        let value = serde_json::to_value(&operation).unwrap();
        assert_eq!(value["id"], "op-1");
        assert_eq!(value["done"], false);
        assert_eq!(value["status"], "running");
        assert_eq!(value["metadata"]["requestId"], "req-1");
        assert!(value.get("error").is_none());
        assert!(value.get("result").is_none());
        let back: Operation = serde_json::from_value(value).unwrap();
        assert_eq!(back, operation);
    }

    #[test]
    fn ledger_states_map_onto_done_result_and_error() {
        let running = Operation::from(summary("running", None));
        assert!(!running.done);
        assert_eq!(running.metadata.created_at, 100);

        let succeeded = Operation::from(summary(
            "succeeded",
            Some(json!({ "result": { "ok": true } })),
        ));
        assert!(succeeded.done);
        assert_eq!(succeeded.result, Some(json!({ "ok": true })));
        assert_eq!(succeeded.error, None);

        let failed = Operation::from(summary(
            "failed",
            Some(json!({
                "httpStatus": 403,
                "error": {
                    "type": "https://cognia.dev/problems/missing_capability",
                    "title": "Forbidden",
                    "status": 403,
                    "detail": "no",
                    "code": "missing_capability",
                    "requestId": "req-9",
                    "retryable": false,
                    "details": {}
                }
            })),
        ));
        assert!(failed.done);
        assert_eq!(failed.result, None);
        let error = failed.error.expect("error");
        assert_eq!(error.code, "missing_capability");
        assert_eq!(error.status, 403);
        assert_eq!(error.operation_id.as_deref(), Some("op-1"));

        // Older receipts wrote the flat envelope. They still read.
        let legacy = Operation::from(summary(
            "failed",
            Some(
                json!({ "httpStatus": 500, "error": { "code": "boom", "message": "x", "retryable": false } }),
            ),
        ));
        assert_eq!(
            legacy.error.map(|error| error.code),
            Some("boom".to_string())
        );

        // A cancelled operation with no receipt is done with neither.
        let cancelled = Operation::from(summary("cancelled", None));
        assert!(cancelled.done);
        assert_eq!(cancelled.result, None);
        assert_eq!(cancelled.error, None);

        // A running operation ignores whatever partial receipt it may carry.
        let partial = Operation::from(summary("running", Some(json!({ "result": 1 }))));
        assert_eq!(partial.result, None);
    }

    #[test]
    fn receipts_without_a_known_member_are_kept_whole() {
        let odd = Operation::from(summary("succeeded", Some(json!({ "something": 1 }))));
        assert_eq!(odd.result, Some(json!({ "something": 1 })));
        let body = Operation::from(summary("succeeded", Some(json!({ "body": [1, 2] }))));
        assert_eq!(body.result, Some(json!([1, 2])));
    }
}

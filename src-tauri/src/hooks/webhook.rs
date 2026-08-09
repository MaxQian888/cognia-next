// Webhook hook handler — HTTP POST the JSON event payload to a configured URL
// and interpret the response with the SAME decision protocol as command
// handlers (`super::command::parse_zero_exit_output`):
//
//   2xx + JSON body  → permissionDecision / additionalContext drive the outcome
//   2xx + plain text → AllowWithContext (the text becomes additional context)
//   2xx + empty      → Allow
//   non-2xx          → soft-allow with a warning (a broken endpoint must not
//                      lock the user out of the tool)
//   timeout / error  → TimedOut / InternalError (both soft-allow)
//
// Timeouts honour the per-hook `timeout` (seconds) capped at the shared hard
// cap, defaulting to 5s — identical to command handlers.

use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;

use regex::Regex;

use super::types::HookOutcome;

const DEFAULT_TIMEOUT_SECS: u64 = 5;
const HARD_TIMEOUT_CAP_SECS: u64 = 30;
pub const HOOK_PII_BLOCK_REASON: &str = "Hook data blocked by the PII redaction gate";

fn contains_sensitive_data(value: &str) -> bool {
    static SENSITIVE: OnceLock<Regex> = OnceLock::new();
    SENSITIVE
        .get_or_init(|| {
            Regex::new(concat!(
                r"(?i)(?:",
                r"[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}",
                r"|\b\d{3}-\d{2}-\d{4}\b",
                r"|\b\d{17}[0-9x]\b",
                r"|\b(?:sk-(?:ant-|proj-)?[a-z0-9_-]{16,}|gh[ops]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|xox[abprs]-[a-z0-9-]{10,}|akia[a-z0-9]{16})\b",
                r"|\beyj[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+\b",
                r"|-----begin (?:[a-z0-9]+ )*private key-----",
                r#"|\b(?:api[_-]?key|apikey|secret|token|bearer|password)\b\s*[:=]\s*["']?[^\s"']{20,}"#,
                r")"
            ))
            .expect("static hook PII regex")
        })
        .is_match(value)
}

/// POST `payload_json` to `url` with the configured `headers` and `timeout`,
/// returning the merged hook outcome.
pub async fn run_webhook_handler(
    url: &str,
    headers: &HashMap<String, String>,
    configured_timeout: Option<u64>,
    payload_json: &str,
) -> HookOutcome {
    // Rust-hosted external-agent hooks must enforce the same fail-closed
    // outbound boundary as the SDK-native sidecar runner. The payload is the
    // complete serialized JSON tree, so scanning it covers every string leaf.
    if contains_sensitive_data(payload_json) {
        return HookOutcome::Block {
            reason: HOOK_PII_BLOCK_REASON.to_string(),
        };
    }

    let timeout_secs = configured_timeout
        .unwrap_or(DEFAULT_TIMEOUT_SECS)
        .min(HARD_TIMEOUT_CAP_SECS);

    let builder = reqwest::Client::builder().timeout(Duration::from_secs(timeout_secs));
    let (builder, _) = match crate::proxy_config::apply_reqwest_policy(builder, url) {
        Ok(policy) => policy,
        Err(error) => {
            return HookOutcome::InternalError {
                reason: error.to_string(),
            };
        }
    };
    let client = match builder.build() {
        Ok(c) => c,
        Err(e) => {
            return HookOutcome::InternalError {
                reason: format!("webhook client build failed: {e}"),
            };
        }
    };

    let mut req = client
        .post(url)
        .header("content-type", "application/json")
        .body(payload_json.to_string());
    for (k, v) in headers {
        req = req.header(k.as_str(), v.as_str());
    }

    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) if e.is_timeout() => {
            return HookOutcome::TimedOut {
                duration_ms: timeout_secs * 1000,
            };
        }
        Err(e) => {
            return HookOutcome::InternalError {
                reason: format!("webhook request failed: {e}"),
            };
        }
    };

    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();

    if !status.is_success() {
        // Non-blocking failure: surface the status as a warning, soft-allow.
        return HookOutcome::InternalError {
            reason: format!("webhook returned HTTP {}", status.as_u16()),
        };
    }

    // Reuse the command-handler body parser so JSON `permissionDecision` /
    // `additionalContext` semantics are identical across handler types.
    super::command::parse_zero_exit_output(&body)
}

#[cfg(test)]
mod tests {
    use super::*;

    // The networked path is exercised via integration; here we assert the
    // body-decision protocol reuse is wired (a deny JSON body blocks).
    #[test]
    fn body_parser_reuse_blocks_on_deny() {
        let outcome = super::super::command::parse_zero_exit_output(
            r#"{"permissionDecision":"deny","decisionReason":"nope"}"#,
        );
        assert!(matches!(outcome, HookOutcome::Block { .. }));
    }

    #[test]
    fn body_parser_reuse_plain_text_is_context() {
        let outcome = super::super::command::parse_zero_exit_output("extra ctx");
        match outcome {
            HookOutcome::AllowWithContext { additional_context } => {
                assert_eq!(additional_context, "extra ctx");
            }
            _ => panic!("expected AllowWithContext"),
        }
    }

    #[test]
    fn blocks_sensitive_payload_before_network_io() {
        assert!(contains_sensitive_data(
            r#"{"prompt":"contact alice@example.com"}"#
        ));
        assert!(contains_sensitive_data(
            r#"{"token":"sk-proj-abcdefghijklmnop"}"#
        ));
        assert!(!contains_sensitive_data(
            r#"{"prompt":"summarize the local design"}"#
        ));
    }
}

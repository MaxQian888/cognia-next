// Spawn a shell command with the JSON event payload piped to its stdin.
//
// Exit code semantics (per Claude Code docs):
//   0  → success; stdout *may* be JSON with `permissionDecision`,
//        `additionalContext`, etc.
//   2  → blocking error; stderr is shown to the user as the block reason
//   *  → non-blocking; first line of stderr forwarded as a warning
//
// We honour a default 5s timeout, configurable per-hook via `timeout` in
// settings.json. On timeout, the spawned process is killed and we emit a
// `TimedOut` outcome (soft-allow); a broken hook must not block tools.

use std::process::Stdio;
use std::time::Duration;

use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::time::{timeout, Instant};

use super::types::HookOutcome;

const DEFAULT_TIMEOUT_SECS: u64 = 5;
const HARD_TIMEOUT_CAP_SECS: u64 = 30;

/// Run one `command` handler. `payload_json` is the serialized event payload;
/// it is written verbatim to the child's stdin.
pub async fn run_command_handler(
    command: &str,
    configured_timeout: Option<u64>,
    payload_json: &str,
) -> HookOutcome {
    let timeout_secs = configured_timeout
        .unwrap_or(DEFAULT_TIMEOUT_SECS)
        .min(HARD_TIMEOUT_CAP_SECS);
    let timeout_dur = Duration::from_secs(timeout_secs);

    // Use the platform shell so users can write `bash -c`-style inline commands
    // without re-quoting. On Windows that's `cmd /C`, elsewhere `sh -c`.
    #[cfg(windows)]
    let mut cmd = {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(command);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = Command::new("sh");
        c.arg("-c").arg(command);
        c
    };

    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.kill_on_drop(true);

    // Suppress Windows console flash for hook execution. tokio::process::Command
    // exposes `creation_flags` directly on Windows, no trait import required.
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let started = Instant::now();
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return HookOutcome::InternalError {
                reason: format!("spawn failed: {e}"),
            };
        }
    };

    // Pipe the payload to stdin in the background.
    if let Some(mut stdin) = child.stdin.take() {
        let payload = payload_json.to_string();
        tokio::spawn(async move {
            // Best-effort write; ignore errors (the child may have exited early).
            let _ = stdin.write_all(payload.as_bytes()).await;
            let _ = stdin.shutdown().await;
        });
    }

    // Wait with timeout.
    let result = timeout(timeout_dur, child.wait_with_output()).await;
    let elapsed = started.elapsed().as_millis() as u64;

    let output = match result {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => {
            return HookOutcome::InternalError {
                reason: format!("wait failed: {e}"),
            };
        }
        Err(_) => {
            // Timed out — child is killed via kill_on_drop when we drop it next.
            return HookOutcome::TimedOut {
                duration_ms: elapsed,
            };
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let exit_code = output.status.code().unwrap_or(-1);

    match exit_code {
        2 => {
            let reason = first_nonempty_line(&stderr)
                .or_else(|| first_nonempty_line(&stdout))
                .unwrap_or_else(|| "hook denied (no message)".to_string());
            HookOutcome::Block { reason }
        }
        0 => parse_zero_exit_output(&stdout),
        _ => {
            // Non-blocking failure. CC emits the first line of stderr as a warning.
            let warning = first_nonempty_line(&stderr)
                .unwrap_or_else(|| format!("hook exited with code {exit_code}"));
            HookOutcome::InternalError { reason: warning }
        }
    }
}

/// Parse the stdout of a zero-exit handler. JSON output overrides default
/// behaviour; plain stdout is treated as additional context.
fn parse_zero_exit_output(stdout: &str) -> HookOutcome {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return HookOutcome::Allow;
    }
    match serde_json::from_str::<Value>(trimmed) {
        Ok(json) => extract_decision(&json),
        Err(_) => HookOutcome::AllowWithContext {
            additional_context: trimmed.to_string(),
        },
    }
}

fn extract_decision(json: &Value) -> HookOutcome {
    // Format documented in Claude Code hooks: an object with an optional
    // `permissionDecision` (deny|allow|ask), `additionalContext`, etc.
    if let Some(decision) = json.get("permissionDecision").and_then(|v| v.as_str()) {
        if decision.eq_ignore_ascii_case("deny") || decision.eq_ignore_ascii_case("block") {
            let reason = json
                .get("decisionReason")
                .or_else(|| json.get("permissionDecisionReason"))
                .or_else(|| json.get("reason"))
                .and_then(|v| v.as_str())
                .unwrap_or("hook returned permissionDecision=deny")
                .to_string();
            return HookOutcome::Block { reason };
        }
    }
    if let Some(decision) = json.get("decision").and_then(|v| v.as_str()) {
        if decision.eq_ignore_ascii_case("block") {
            let reason = json
                .get("reason")
                .and_then(|v| v.as_str())
                .unwrap_or("hook returned decision=block")
                .to_string();
            return HookOutcome::Block { reason };
        }
    }
    if let Some(ctx) = json.get("additionalContext").and_then(|v| v.as_str()) {
        return HookOutcome::AllowWithContext {
            additional_context: ctx.to_string(),
        };
    }
    HookOutcome::Allow
}

fn first_nonempty_line(s: &str) -> Option<String> {
    for line in s.lines() {
        let t = line.trim();
        if !t.is_empty() {
            return Some(t.to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extract_decision_deny() {
        let v = json!({"permissionDecision": "deny", "decisionReason": "nope"});
        let outcome = extract_decision(&v);
        matches!(outcome, HookOutcome::Block { .. });
    }

    #[test]
    fn extract_decision_additional_context() {
        let v = json!({"additionalContext": "extra info"});
        match extract_decision(&v) {
            HookOutcome::AllowWithContext { additional_context } => {
                assert_eq!(additional_context, "extra info");
            }
            _ => panic!("expected AllowWithContext"),
        }
    }

    #[test]
    fn extract_decision_allow_default() {
        let v = json!({"foo": 1});
        matches!(extract_decision(&v), HookOutcome::Allow);
    }

    #[test]
    fn parse_plain_stdout_becomes_context() {
        match parse_zero_exit_output("hello world") {
            HookOutcome::AllowWithContext { additional_context } => {
                assert_eq!(additional_context, "hello world");
            }
            _ => panic!("expected context"),
        }
    }
}

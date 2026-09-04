//! ADR-0028, host-neutral one-shot sandboxed executor.
//!
//! The desktop reaches the T1 OS sandbox through the `sandbox_exec` Tauri
//! command. Every other host, the standalone `cognia-agent` CLI, the supervised
//! headless brain, a deploy agent, has no Tauri IPC and therefore had no way in
//! at all: `transport.call("sandbox_exec")` throws `unsupported command` on the
//! CLI's stdio transport. The consequence was not a degraded sandbox but an
//! absent one, while `sandbox/status` still answered "enabled" from a persisted
//! policy. This binary closes that. It is the same dispatcher body, minus the
//! Tauri plumbing.
//!
//! It calls `sandbox::run_confined`, which is the single confined-execution
//! path shared with the Tauri command, so the confinement a CLI session gets is
//! byte-identical to the desktop's: availability gate, path canonicalization,
//! forbidden-root rejection, env scrubbing, unenforceable-network downgrade,
//! filtering proxy, then the per-platform backend (bwrap / sandbox-exec /
//! Windows runner) with seccomp, rlimits and capped output.
//!
//! Protocol (JSON, one document in, one document out):
//!
//! ```text
//!   stdin  {"tool":"bash","command":{...SandboxCommand},"request":{...PolicyRequest}}
//!   stdout {"ok":true,"result":{...SandboxResult}}
//!        | {"ok":false,"error":{"kind":"invalid_policy","reason":"..."}}
//! ```
//!
//! The request arrives on **stdin, never argv**: a sandboxed command carries the
//! caller's environment, which routinely holds tokens, and argv is world-readable
//! through `ps` on every platform this runs on.
//!
//! Exit code is 0 whenever a JSON envelope was produced, including a refusal,
//! and including a child that exited non-zero. A non-zero exit means the
//! protocol itself failed (unreadable stdin, unparseable request) and stdout may
//! be empty. Callers must not read a missing envelope as "ran fine".
//!
//! Auxiliary modes mirror the two read-only Tauri commands so a host can render
//! the same status surface the desktop does:
//!
//! ```text
//!   --health  {"ok":true,"health":{...SandboxHealth}}     (cheap, no spawn)
//!   --probe   {"ok":true,"probe":{...ProbeReport}}        (spawns real commands)
//! ```

use std::io::Read;

use cognia_automation::sandbox::policy::{policy_for, PolicyRequest};
use cognia_automation::sandbox::types::{SandboxCommand, SandboxError};
use serde::{Deserialize, Serialize};

/// One sandboxed execution request. Field-for-field the `sandbox_exec` Tauri
/// command's arguments, so the renderer-side `MicrovmExecPayload` the
/// `cognia-sandboxed-tools` plugin already builds serialises straight into it.
///
/// `ceiling` is accepted and ignored on purpose: the payload the plugin emits
/// carries it for the microVM tier, and rejecting an unknown field would make a
/// shared payload shape impossible. The ceiling is applied renderer-side by
/// `clampPolicyRequest` before the request is built, so honouring it here would
/// only re-apply an already-applied clamp.
#[derive(Debug, Deserialize)]
struct ExecRequest {
    tool: String,
    command: SandboxCommand,
    #[serde(default)]
    request: PolicyRequest,
    #[serde(default)]
    #[allow(dead_code)]
    ceiling: Option<serde_json::Value>,
}

/// Response envelope. Tagged rather than bare so a caller distinguishes "the
/// sandbox refused" from "the child failed" without inspecting exit codes, and
/// so a refusal keeps the structured `SandboxError` shape the renderer already
/// renders.
#[derive(Debug, Serialize)]
#[serde(untagged)]
enum Envelope {
    Exec {
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<cognia_automation::sandbox::types::SandboxResult>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<SandboxError>,
    },
    Health {
        ok: bool,
        health: cognia_automation::sandbox::types::SandboxHealth,
    },
    Probe {
        ok: bool,
        probe: cognia_automation::sandbox::types::ProbeReport,
    },
}

#[derive(Debug, PartialEq, Eq)]
enum Mode {
    Exec,
    Health,
    Probe,
}

fn parse_mode(raw: impl IntoIterator<Item = String>) -> Result<Mode, String> {
    let mut mode = Mode::Exec;
    let mut seen = false;
    for arg in raw {
        let next = match arg.as_str() {
            "--exec" => Mode::Exec,
            "--health" => Mode::Health,
            "--probe" => Mode::Probe,
            other => return Err(format!("unknown argument: {other}")),
        };
        // Two modes in one invocation is a caller bug, and silently keeping the
        // last one would run a spawn the caller may not have wanted.
        if seen && next != mode {
            return Err("only one of --exec / --health / --probe may be given".into());
        }
        mode = next;
        seen = true;
    }
    Ok(mode)
}

fn read_stdin() -> Result<String, String> {
    let mut buf = String::new();
    std::io::stdin()
        .read_to_string(&mut buf)
        .map_err(|error| format!("failed to read the request from stdin: {error}"))?;
    if buf.trim().is_empty() {
        return Err("empty request: expected one JSON document on stdin".into());
    }
    Ok(buf)
}

fn parse_request(raw: &str) -> Result<ExecRequest, String> {
    serde_json::from_str::<ExecRequest>(raw)
        .map_err(|error| format!("malformed sandbox request: {error}"))
}

/// Run one request. Refusals are values, not errors: an unknown tool, an empty
/// writable set or an unavailable backend all come back as `ok: false` with the
/// structured reason, because the caller must be able to tell the model WHY the
/// sandbox refused rather than seeing a dead process.
async fn run_exec(req: ExecRequest) -> Envelope {
    let stripped = req
        .tool
        .strip_prefix("sandbox_")
        .unwrap_or(&req.tool)
        .to_string();
    let policy = match policy_for(&stripped, req.request) {
        Ok(policy) => policy,
        Err(error) => {
            return Envelope::Exec {
                ok: false,
                result: None,
                error: Some(error),
            }
        }
    };
    match cognia_automation::sandbox::run_confined(req.command, policy).await {
        Ok(result) => Envelope::Exec {
            ok: true,
            result: Some(result),
            error: None,
        },
        Err(error) => Envelope::Exec {
            ok: false,
            result: None,
            error: Some(error),
        },
    }
}

async fn run(mode: Mode) -> Result<Envelope, String> {
    match mode {
        Mode::Exec => {
            let raw = read_stdin()?;
            Ok(run_exec(parse_request(&raw)?).await)
        }
        Mode::Health => Ok(Envelope::Health {
            ok: true,
            health: cognia_automation::sandbox::current_backend().health(),
        }),
        Mode::Probe => Ok(Envelope::Probe {
            ok: true,
            probe: cognia_automation::sandbox::current_backend()
                .probe_confinement()
                .await,
        }),
    }
}

fn main() {
    let mode = match parse_mode(std::env::args().skip(1)) {
        Ok(mode) => mode,
        Err(error) => {
            eprintln!("cognia-sandbox-exec: {error}");
            std::process::exit(2);
        }
    };
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("cognia-sandbox-exec: failed to start the async runtime: {error}");
            std::process::exit(2);
        }
    };
    match runtime.block_on(run(mode)) {
        Ok(envelope) => match serde_json::to_string(&envelope) {
            Ok(json) => println!("{json}"),
            Err(error) => {
                eprintln!("cognia-sandbox-exec: failed to encode the response: {error}");
                std::process::exit(2);
            }
        },
        Err(error) => {
            eprintln!("cognia-sandbox-exec: {error}");
            std::process::exit(2);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn defaults_to_exec_and_parses_each_mode() {
        assert_eq!(parse_mode(args(&[])).unwrap(), Mode::Exec);
        assert_eq!(parse_mode(args(&["--exec"])).unwrap(), Mode::Exec);
        assert_eq!(parse_mode(args(&["--health"])).unwrap(), Mode::Health);
        assert_eq!(parse_mode(args(&["--probe"])).unwrap(), Mode::Probe);
    }

    #[test]
    fn rejects_unknown_and_conflicting_modes() {
        assert!(parse_mode(args(&["--wat"])).is_err());
        assert!(parse_mode(args(&["--health", "--probe"])).is_err());
        // Repeating the same mode is harmless, it names one intention.
        assert_eq!(
            parse_mode(args(&["--probe", "--probe"])).unwrap(),
            Mode::Probe
        );
    }

    #[test]
    fn parses_the_renderer_payload_shape_verbatim() {
        // Exactly what `executeOsSandbox` posts today: camelCase policy fields,
        // stdin as a byte array, timeout in seconds, plus the microVM `ceiling`
        // the shared payload carries.
        let raw = r#"{
          "tool": "sandbox_bash",
          "command": {
            "argv": ["bash", "-lc", "echo hi"],
            "cwd": "/workspace",
            "env": { "PATH": "/usr/bin" },
            "stdin": [104, 105],
            "timeout": 30
          },
          "request": {
            "writable": ["/workspace"],
            "readable": ["/usr"],
            "targetFiles": [],
            "maxCpuSeconds": 10,
            "maxMemoryMb": 512,
            "network": "off",
            "networkHosts": []
          },
          "ceiling": { "network": "off" }
        }"#;
        let req = parse_request(raw).unwrap();
        assert_eq!(req.tool, "sandbox_bash");
        assert_eq!(req.command.argv, ["bash", "-lc", "echo hi"]);
        assert_eq!(req.command.timeout, std::time::Duration::from_secs(30));
        assert_eq!(req.command.stdin.as_deref(), Some(&b"hi"[..]));
        assert_eq!(req.request.max_memory_mb, 512);
        assert_eq!(
            req.request.writable,
            [std::path::PathBuf::from("/workspace")]
        );
    }

    #[test]
    fn rejects_malformed_and_empty_requests() {
        assert!(parse_request("not json").is_err());
        assert!(parse_request("{}").is_err());
    }

    #[tokio::test]
    async fn unknown_tool_refuses_as_a_value_not_a_process_failure() {
        let req = parse_request(
            r#"{"tool":"rm","command":{"argv":["rm"],"cwd":"/tmp","env":{},"timeout":5},"request":{}}"#,
        )
        .unwrap();
        match run_exec(req).await {
            Envelope::Exec { ok, error, result } => {
                assert!(!ok);
                assert!(result.is_none());
                assert!(matches!(error, Some(SandboxError::InvalidPolicy { .. })));
            }
            other => panic!("expected an exec envelope, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn bash_without_a_writable_root_refuses_before_any_spawn() {
        let req = parse_request(
            r#"{"tool":"bash","command":{"argv":["bash","-lc","true"],"cwd":"/tmp","env":{},"timeout":5},"request":{}}"#,
        )
        .unwrap();
        match run_exec(req).await {
            Envelope::Exec { ok, error, .. } => {
                assert!(!ok);
                let message = error.expect("a refusal reason").to_string();
                assert!(message.contains("writable"), "unexpected reason: {message}");
            }
            other => panic!("expected an exec envelope, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_forbidden_writable_root_is_refused_before_any_spawn() {
        // The floor `run_confined` enforces regardless of what the caller asks
        // for, proving this binary inherits it rather than re-deriving it.
        let req = parse_request(
            r#"{"tool":"bash","command":{"argv":["bash","-lc","true"],"cwd":"/tmp","env":{},"timeout":5},
                "request":{"writable":["/etc"]}}"#,
        )
        .unwrap();
        match run_exec(req).await {
            Envelope::Exec { ok, error, .. } => {
                assert!(!ok);
                let message = error.expect("a refusal reason").to_string();
                // Either the backend is missing on this host (SetupRequired) or
                // the forbidden root is rejected, never a successful run.
                assert!(
                    message.contains("protected") || message.contains("sandbox"),
                    "unexpected reason: {message}"
                );
            }
            other => panic!("expected an exec envelope, got {other:?}"),
        }
    }

    #[test]
    fn envelopes_serialize_to_the_documented_shape() {
        let refusal = Envelope::Exec {
            ok: false,
            result: None,
            error: Some(SandboxError::InvalidPolicy {
                reason: "no writable dir".into(),
            }),
        };
        let json = serde_json::to_value(&refusal).unwrap();
        assert_eq!(json["ok"], serde_json::json!(false));
        assert_eq!(json["error"]["kind"], serde_json::json!("invalid_policy"));
        assert!(
            json.get("result").is_none(),
            "absent result must be omitted"
        );
    }

    #[tokio::test]
    async fn health_mode_reports_a_backend_without_spawning() {
        match run(Mode::Health).await.unwrap() {
            Envelope::Health { ok, health } => {
                assert!(ok);
                assert!(!health.backend.is_empty());
            }
            other => panic!("expected a health envelope, got {other:?}"),
        }
    }
}

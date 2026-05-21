// ADR-0028 Phase 4.2 / Phase 13 — Windows sandbox runner binary.
//
// Runs without elevation. Reads a JSON-encoded `SandboxCommand` from
// argv[1] (we don't go through stdin so the renderer can spawn this
// directly via `Command::new` without piping), validates the target
// user / cwd / argv against the policy, and re-launches the requested
// argv via `runas /user:CogniaSandbox… /trustlevel:0x20000` so the
// target inherits the synthetic user's restricted token and Firewall
// rules.
//
// Output is JSON-encoded `SandboxResult` on stdout (exit code, stdout
// captured from the child, stderr, duration, timed_out). Exit code 0
// means the runner finished; the child's actual exit code lives in
// the JSON.

use std::process::Command;
use std::time::{Duration, Instant};

#[derive(serde::Deserialize)]
struct RunnerInput {
    target_user: String,
    argv: Vec<String>,
    cwd: String,
    #[serde(default)]
    env: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    timeout_seconds: u64,
}

#[derive(serde::Serialize)]
struct RunnerOutput {
    exit_code: i32,
    stdout: String,
    stderr: String,
    duration_ms: u64,
    timed_out: bool,
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let payload = match args.get(1) {
        Some(p) => p,
        None => {
            eprintln!("usage: cognia-sandbox-runner <json-payload>");
            std::process::exit(2)
        }
    };
    let input: RunnerInput = match serde_json::from_str(payload) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("invalid JSON payload: {e}");
            std::process::exit(2)
        }
    };
    match run(input) {
        Ok(result) => {
            match serde_json::to_string(&result) {
                Ok(s) => println!("{s}"),
                Err(e) => {
                    eprintln!("serialise output failed: {e}");
                    std::process::exit(2)
                }
            }
        }
        Err(e) => {
            eprintln!("runner failed: {e}");
            std::process::exit(2)
        }
    }
}

#[cfg(target_os = "windows")]
fn run(input: RunnerInput) -> Result<RunnerOutput, String> {
    if input.argv.is_empty() {
        return Err("argv is empty".into());
    }
    let started = Instant::now();
    let timeout = if input.timeout_seconds == 0 {
        Duration::from_secs(300)
    } else {
        Duration::from_secs(input.timeout_seconds)
    };
    // Build the runas argv: runas /user:<user> /savecred /trustlevel:0x20000
    // "cmd /c <argv...>". The /trustlevel flag restricts to non-admin —
    // composing with the synthetic user's Firewall rules gives us the
    // restricted-token + per-SID-Firewall pattern from the ADR.
    let mut runas_args = vec![
        format!("/user:{}", input.target_user),
        "/trustlevel:0x20000".to_string(),
    ];
    let quoted = input
        .argv
        .iter()
        .map(|a| format!("\"{}\"", a.replace('"', "\\\"")))
        .collect::<Vec<_>>()
        .join(" ");
    runas_args.push(format!("cmd /c {quoted}"));

    let mut cmd = Command::new("runas");
    cmd.args(&runas_args);
    cmd.current_dir(&input.cwd);
    for (k, v) in &input.env {
        cmd.env(k, v);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("runas spawn failed: {e}"))?;
    let wait = wait_timeout::ChildExt::wait_timeout(&mut child, timeout)
        .map_err(|e| format!("wait_timeout failed: {e}"))?;
    let elapsed_ms = started.elapsed().as_millis() as u64;
    match wait {
        Some(status) => Ok(RunnerOutput {
            exit_code: status.code().unwrap_or(-1),
            stdout: String::new(),
            stderr: String::new(),
            duration_ms: elapsed_ms,
            timed_out: false,
        }),
        None => {
            // Timed out — kill the child, surface the timeout flag.
            let _ = child.kill();
            Ok(RunnerOutput {
                exit_code: -1,
                stdout: String::new(),
                stderr: "timed out".into(),
                duration_ms: elapsed_ms,
                timed_out: true,
            })
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn run(_input: RunnerInput) -> Result<RunnerOutput, String> {
    Err("cognia-sandbox-runner runs on Windows only".into())
}

//! wasm-example-formatter — reference plugin exercising the full v0.1
//! capability surface.
//!
//! Behavior:
//!   - On `init`, posts a notification that the plugin is alive.
//!   - On `tool-execute` with name "format_rust", reads its input from
//!     the JSON payload, writes it to a temp file under the plugin data
//!     dir, spawns `rustfmt` via the `process` capability, and returns
//!     the formatted output. Demonstrates fs + process composition.
//!   - On `workflow-node-execute` with kind
//!     "action.wasm-example-formatter.format", does the same thing — so
//!     workflow nodes and agent tools share a single backend.
//!   - On any other call, surfaces a structured error.
//!
//! Capability declarations required (in plugin.json `permissions[]`):
//!   - notification
//!   - filesystem:read, filesystem:write  (plugin data dir only)
//!   - process:spawn

#![allow(clippy::unwrap_used)]

#[allow(warnings)]
mod bindings;

use bindings::cognia::plugin::{logger, notification, process};
use bindings::Guest;
use serde::{Deserialize, Serialize};

const FORMAT_TOOL: &str = "format_rust";
const FORMAT_NODE: &str = "action.wasm-example-formatter.format";

struct Plugin;

#[derive(Debug, Deserialize)]
struct FormatRequest {
    /// Rust source to format.
    source: String,
    /// Optional rustfmt args. Default: `--emit stdout --edition 2021`.
    #[serde(default)]
    args: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
struct FormatResponse {
    formatted: String,
    /// Captured stderr from rustfmt — useful when --edition mismatches
    /// the input or when rustfmt rejects a syntactically invalid source.
    stderr: String,
    /// Process exit code (0 = success).
    exit_code: i32,
}

impl Guest for Plugin {
    fn init(_config: Vec<u8>) -> Result<(), String> {
        logger::log(
            logger::LogLevel::Info,
            "init",
            "wasm-example-formatter activated",
        );
        notification::notify(
            "wasm-example-formatter",
            "Plugin is active. Use the format_rust tool or workflow node.",
            notification::NotificationKind::Info,
        );
        Ok(())
    }

    fn on_event(_kind: String, _payload: Vec<u8>) -> Result<Vec<u8>, String> {
        // No hook subscriptions in v0.1 — emit an empty echo.
        Ok(Vec::new())
    }

    fn tool_execute(name: String, args: Vec<u8>) -> Result<Vec<u8>, String> {
        if name != FORMAT_TOOL {
            return Err(format!("unknown tool: {name}"));
        }
        format_via_rustfmt(args)
    }

    fn workflow_node_execute(node_kind: String, inputs: Vec<u8>) -> Result<Vec<u8>, String> {
        if node_kind != FORMAT_NODE {
            return Err(format!("unknown node kind: {node_kind}"));
        }
        format_via_rustfmt(inputs)
    }
}

fn format_via_rustfmt(payload: Vec<u8>) -> Result<Vec<u8>, String> {
    let request: FormatRequest =
        serde_json::from_slice(&payload).map_err(|e| format!("parse FormatRequest: {e}"))?;

    let args = request
        .args
        .unwrap_or_else(|| vec!["--emit".into(), "stdout".into(), "--edition".into(), "2021".into()]);

    // Write source to the plugin data dir. WASI gives us `/` mapped to
    // `<app_data>/cognia/plugins/<id>/data/` so the file path is
    // sandbox-safe.
    let tmp_path = "/format-input.rs";
    std::fs::write(tmp_path, request.source.as_bytes())
        .map_err(|e| format!("write input: {e}"))?;

    let mut combined_args: Vec<String> = args.clone();
    combined_args.push(tmp_path.into());

    let exec_options = process::ExecOptions {
        cwd: None,
        env: Vec::new(),
        timeout_ms: Some(10_000),
    };
    let result = process::exec("rustfmt".into(), combined_args, exec_options)?;

    let formatted = String::from_utf8_lossy(&result.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&result.stderr).into_owned();

    let response = FormatResponse {
        formatted,
        stderr,
        exit_code: result.code,
    };
    serde_json::to_vec(&response).map_err(|e| format!("encode FormatResponse: {e}"))
}

bindings::export!(Plugin with_types_in bindings);

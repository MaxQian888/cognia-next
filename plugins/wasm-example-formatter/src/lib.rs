//! wasm-example-formatter — reference plugin exercising the full v0.1
//! capability surface.
//!
//! Behavior:
//!   - On `init`, posts a notification that the plugin is alive.
//!   - On `tool-execute` with name "format_rust", reads its input from
//!     the JSON payload, writes it to a temp file under the plugin data
//!     dir, spawns `rustfmt` via the `process` capability, and returns
//!     the formatted output. Demonstrates fs + process composition.
//!
//! Known limitation (cognia:plugin@0.2.0): `rustfmt` runs as a HOST
//! process, but the file this guest writes lives at a WASI guest path
//! (`/format-input.rs` → the plugin data dir), which the host process
//! cannot open, and `process.exec` has no stdin channel to pipe the
//! source through instead. rustfmt therefore reports the input missing;
//! `format_via_rustfmt` recognises that and returns an actionable
//! `HOST_UNAVAILABLE` error rather than an empty "formatted" result. The
//! fix is a WIT change (a `stdin` field on `exec-options`), not a guest one.
//!   - On `workflow-node-execute` with kind
//!     "action.wasm-example-formatter.format", does the same thing — so
//!     workflow nodes and agent tools share a single backend.
//!   - On any other call, surfaces a structured error.
//!
//! Capability declarations required (in plugin.json `permissions[]`):
//!   - notification
//!   - filesystem:read, filesystem:write  (plugin data dir only)
//!   - process:spawn
//!
//! plus `"shellCommands": ["rustfmt"]` — `process.exec` is deny-by-default
//! and refuses any program the manifest does not name.

#![allow(clippy::unwrap_used)]

#[allow(warnings)]
mod bindings;

use bindings::cognia::plugin::{logger, notification, process};
use bindings::Guest;
use serde::{Deserialize, Serialize};

const FORMAT_TOOL: &str = "format_rust";
const FORMAT_NODE: &str = "action.wasm-example-formatter.format";

/// Where the source is written, as the GUEST sees it. WASI maps `/` to
/// `<app_data>/cognia/plugins/<id>/data/`, so the write is sandbox-safe —
/// but the path means nothing to a process the host spawns.
const INPUT_GUEST_PATH: &str = "/format-input.rs";

struct Plugin;

/// Fixed rustfmt arguments. The caller supplies only the source: rustfmt runs
/// as a HOST process, where a caller-chosen `--emit files` or
/// `--print-config default <path>` would write wherever it names.
const RUSTFMT_ARGS: [&str; 4] = ["--emit", "stdout", "--edition", "2021"];

#[derive(Debug, Deserialize)]
struct FormatRequest {
    /// Rust source to format.
    source: String,
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
        // v0.2: `notify` returns `result<_, string>`, so a denial or a missing
        // notification backend is observable. Activation should still succeed
        // without it, so log and continue.
        if let Err(error) = notification::notify(
            "wasm-example-formatter",
            "Plugin is active. Use the format_rust tool or workflow node.",
            notification::NotificationKind::Info,
        ) {
            logger::log(logger::LogLevel::Warn, "init", &format!("notify: {error}"));
        }
        Ok(())
    }

    fn on_event(_kind: String, _payload: Vec<u8>) -> Result<Vec<u8>, String> {
        // No hook subscriptions — emit an empty echo.
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
        // The workflow envelope differs from the tool envelope. `tool-execute`
        // gets the arguments spread FLAT (`{ name, ...args }`), so parsing a
        // `FormatRequest` straight off the payload works there. The node path
        // gets `{ kind, params, upstream }` (see `buildWasmNodeDefs` in
        // lib/plugin/core/wasm-loader.ts), so the request lives under `params`
        // — reading the payload directly failed every invocation with
        // "parse FormatRequest: missing field `source`".
        let envelope: NodeEnvelope =
            serde_json::from_slice(&inputs).map_err(|e| format!("parse node envelope: {e}"))?;
        let params = serde_json::to_vec(&envelope.params)
            .map_err(|e| format!("re-encode node params: {e}"))?;
        format_via_rustfmt(params)
    }
}

/// Workflow-node invocation envelope produced by the host.
#[derive(Debug, Deserialize)]
struct NodeEnvelope {
    #[serde(default)]
    params: serde_json::Value,
}

fn format_via_rustfmt(payload: Vec<u8>) -> Result<Vec<u8>, String> {
    let request: FormatRequest =
        serde_json::from_slice(&payload).map_err(|e| format!("parse FormatRequest: {e}"))?;

    // Write source to the plugin data dir (the fs half of the demo).
    std::fs::write(INPUT_GUEST_PATH, request.source.as_bytes())
        .map_err(|e| format!("write input: {e}"))?;

    let mut combined_args: Vec<String> = RUSTFMT_ARGS.iter().map(|a| a.to_string()).collect();
    combined_args.push(INPUT_GUEST_PATH.into());

    let exec_options = process::ExecOptions {
        cwd: None,
        env: Vec::new(),
        timeout_ms: Some(10_000),
    };
    let result = process::exec("rustfmt", &combined_args, &exec_options)
        .map_err(|e| explain_exec_error(&e))?;

    let formatted = String::from_utf8_lossy(&result.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&result.stderr).into_owned();

    if input_unreachable(result.code, &stderr) {
        return Err(input_unreachable_message(&stderr));
    }

    let response = FormatResponse {
        formatted,
        stderr,
        exit_code: result.code,
    };
    serde_json::to_vec(&response).map_err(|e| format!("encode FormatResponse: {e}"))
}

/// rustfmt exited non-zero because it could not open the guest path — the
/// 0.2 contract's missing stdin channel, not a problem with the source.
fn input_unreachable(code: i32, stderr: &str) -> bool {
    code != 0 && stderr.contains(INPUT_GUEST_PATH)
}

fn input_unreachable_message(stderr: &str) -> String {
    format!(
        "HOST_UNAVAILABLE: format_rust cannot hand the source to rustfmt on this host. \
         rustfmt runs as a host process, and cognia:plugin/process@0.2.0 gives it neither \
         stdin nor a path it can open: `{INPUT_GUEST_PATH}` exists only inside this plugin's \
         WASI sandbox (its data directory). The source was saved there. Formatting needs a \
         `stdin` field on `process.exec-options` — a WIT contract change, not something the \
         guest can work around. rustfmt said: {}",
        stderr.trim()
    )
}

/// Turn the host's `process.exec` refusals into the step that fixes them.
fn explain_exec_error(error: &str) -> String {
    if error.contains("shellCommands") {
        format!(
            "{error} — declare \"shellCommands\": [\"rustfmt\"] in plugin.json and reinstall the plugin."
        )
    } else if error.contains("process:spawn") {
        format!(
            "{error} — grant process:spawn to wasm-example-formatter in the Plugins page \
             (plugin details → Permissions)."
        )
    } else if error.starts_with("spawn rustfmt") {
        format!(
            "{error} — rustfmt could not be started on the host. Install it with \
             `rustup component add rustfmt`; the host starts the child with an empty \
             environment, so rustfmt must be resolvable without your shell's PATH."
        )
    } else {
        error.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_guest_path_is_the_known_limitation() {
        let stderr = format!("Error: file `{INPUT_GUEST_PATH}` does not exist\n");
        assert!(input_unreachable(1, &stderr));
        let message = input_unreachable_message(&stderr);
        assert!(message.starts_with("HOST_UNAVAILABLE: "));
        assert!(message.contains("stdin"));
        assert!(message.contains("does not exist"));
    }

    #[test]
    fn a_rustfmt_diagnostic_about_the_source_is_not_the_limitation() {
        assert!(!input_unreachable(1, "error: expected one of `;` or `}`"));
        assert!(!input_unreachable(0, INPUT_GUEST_PATH));
    }

    #[test]
    fn caller_args_never_reach_rustfmt() {
        // A request still carrying the old `args` field parses, and the field
        // has nowhere to go: rustfmt only ever gets the fixed stdout-mode args.
        let request: FormatRequest =
            serde_json::from_str(r#"{"source":"fn main(){}","args":["--emit","files"]}"#).unwrap();
        assert_eq!(request.source, "fn main(){}");
        assert_eq!(RUSTFMT_ARGS, ["--emit", "stdout", "--edition", "2021"]);
    }

    #[test]
    fn exec_refusals_name_the_fix() {
        let denied = "process exec: program `rustfmt` is not in plugin `wasm-example-formatter`'s declared shellCommands allowlist";
        assert!(explain_exec_error(denied).contains("\"shellCommands\": [\"rustfmt\"]"));
        let ungranted = "CAPABILITY_DENIED: capability `process:spawn` not granted to plugin `x`";
        assert!(explain_exec_error(ungranted).contains("Permissions"));
        let missing = "spawn rustfmt: No such file or directory (os error 2)";
        assert!(explain_exec_error(missing).contains("rustup component add rustfmt"));
        assert_eq!(explain_exec_error("TIMEOUT: slow"), "TIMEOUT: slow");
    }
}

bindings::export!(Plugin with_types_in bindings);

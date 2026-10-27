//! wasm-example-formatter — reference for the v0.2.1 process stdin operation.
//!
//! Tool and workflow calls save source inside the WASI data directory, then
//! pipe its bytes to host rustfmt. Guest filesystem paths never become host
//! command arguments. A configured rustfmtProgram can select an absolute host
//! binary without inheriting the host environment or accepting caller argv.
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

static RUSTFMT_PROGRAM: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct FormatterConfig {
    rustfmt_program: Option<String>,
}

fn configured_program(config: &[u8]) -> Result<String, String> {
    let config: FormatterConfig = serde_json::from_slice(config)
        .map_err(|e| format!("INVALID_REQUEST: formatter config: {e}"))?;
    match config.rustfmt_program {
        None => Ok("rustfmt".into()),
        Some(program) if !program.trim().is_empty() && !program.contains('\0') => Ok(program),
        Some(_) => Err("INVALID_REQUEST: rustfmtProgram must name an executable".into()),
    }
}

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
    fn init(config: Vec<u8>) -> Result<(), String> {
        *RUSTFMT_PROGRAM.lock().unwrap() = Some(configured_program(&config)?);
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

    let combined_args: Vec<String> = RUSTFMT_ARGS.iter().map(|a| a.to_string()).collect();

    let exec_options = process::ExecOptions {
        cwd: None,
        env: Vec::new(),
        timeout_ms: Some(10_000),
    };
    let program = RUSTFMT_PROGRAM
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_else(|| "rustfmt".into());
    let result = process::exec_with_stdin(
        &program,
        &combined_args,
        &exec_options,
        request.source.as_bytes(),
    )
    .map_err(|e| explain_exec_error(&e))?;

    let formatted = String::from_utf8_lossy(&result.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&result.stderr).into_owned();

    let response = FormatResponse {
        formatted,
        stderr,
        exit_code: result.code,
    };
    serde_json::to_vec(&response).map_err(|e| format!("encode FormatResponse: {e}"))
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
    } else if error.contains("spawn ") && error.contains("rustfmt") {
        format!(
            "{error} — rustfmt could not be started on the host. Install it with \
             `rustup component add rustfmt`. If rustfmt is a rustup shim, set rustfmtProgram \
             to the absolute binary printed by `rustup which rustfmt`; the child inherits no host environment."
        )
    } else {
        error.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formatter_config_defaults_and_rejects_invalid_executables() {
        assert_eq!(configured_program(b"{}").unwrap(), "rustfmt");
        assert_eq!(
            configured_program(br#"{"rustfmtProgram":"/toolchain/bin/rustfmt"}"#).unwrap(),
            "/toolchain/bin/rustfmt"
        );
        assert!(configured_program(br#"{"rustfmtProgram":" "}"#)
            .unwrap_err()
            .starts_with("INVALID_REQUEST:"));
        assert!(configured_program(b"invalid JSON").is_err());
    }

    #[test]
    fn workflow_source_is_preserved_in_the_host_envelope() {
        let envelope: NodeEnvelope = serde_json::from_value(serde_json::json!({
            "kind": FORMAT_NODE, "params": {"source":"fn main(){println!(\"你好\");}"}, "upstream": {}
        })).unwrap();
        let request: FormatRequest = serde_json::from_value(envelope.params).unwrap();
        assert_eq!(request.source, "fn main(){println!(\"你好\");}");
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

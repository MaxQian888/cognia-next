//! cognia-plugin-template — a hello-world WASM plugin.
//!
//! Demonstrates every guest export the cognia v0.1 WIT contract defines.
//! On activation it sends a notification through the host; the
//! `tool-execute` and `workflow-node-execute` exports echo their inputs.
//! Copy this file as the starting point for your own plugin.

#![allow(clippy::unwrap_used)] // bindings is generated; keep template lean

// `cargo-component` generates this module at build time from the WIT in
// `wit/`. Re-exporting keeps the rest of the file readable.
#[allow(warnings)]
mod bindings;

use bindings::cognia::plugin::{logger, notification};
use bindings::Guest;

struct Plugin;

impl Guest for Plugin {
    /// One-shot setup at install/enable time. `config` carries the
    /// JSON-encoded `defaultConfig` merged with any user overrides — for
    /// the template we simply log that we booted and pop a notification.
    fn init(config: Vec<u8>) -> Result<(), String> {
        logger::log(
            logger::LogLevel::Info,
            "init",
            &format!("hello from template! config_bytes={}", config.len()),
        );
        // v0.2: `notify` returns `result<_, string>`. A failure here is not
        // fatal to activation — a denied or unavailable notification surface
        // should not stop the plugin booting — so log it and carry on. If your
        // plugin genuinely needs the notification to land, propagate with `?`.
        if let Err(error) = notification::notify(
            "cognia-plugin-template",
            "Hello from the template plugin!",
            notification::NotificationKind::Info,
        ) {
            logger::log(logger::LogLevel::Warn, "init", &format!("notify: {error}"));
        }
        Ok(())
    }

    /// Generic hook dispatch. `kind` carries the host hook name; `payload`
    /// is JSON-encoded. Return value is JSON-encoded too — the host
    /// sends it back to whoever invoked the call.
    fn on_event(kind: String, payload: Vec<u8>) -> Result<Vec<u8>, String> {
        logger::log(
            logger::LogLevel::Debug,
            "on-event",
            &format!("kind={} payload_bytes={}", kind, payload.len()),
        );
        Ok(payload) // echo
    }

    /// `tool-execute` lets the cognia agent invoke a tool you registered
    /// via `manifest.tools[]`. The template just echoes the args.
    fn tool_execute(name: String, args: Vec<u8>) -> Result<Vec<u8>, String> {
        logger::log(
            logger::LogLevel::Info,
            "tool-execute",
            &format!("tool={} args_bytes={}", name, args.len()),
        );
        Ok(serde_json::to_vec(&serde_json::json!({
            "tool": name,
            "args_byte_count": args.len(),
        }))
        .map_err(|e| e.to_string())?)
    }

    /// `workflow-node-execute` lets a visual workflow drop your custom
    /// node onto the canvas. `node_kind` is the namespaced kind the
    /// workflow runtime dispatches with.
    fn workflow_node_execute(node_kind: String, inputs: Vec<u8>) -> Result<Vec<u8>, String> {
        logger::log(
            logger::LogLevel::Info,
            "workflow-node-execute",
            &format!("kind={} inputs_bytes={}", node_kind, inputs.len()),
        );
        Ok(serde_json::to_vec(&serde_json::json!({
            "node_kind": node_kind,
            "inputs_byte_count": inputs.len(),
        }))
        .map_err(|e| e.to_string())?)
    }
}

bindings::export!(Plugin with_types_in bindings);

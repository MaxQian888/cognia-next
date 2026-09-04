//! cognia-plugin-template, a hello-world WASM plugin.
//!
//! Demonstrates every guest export the cognia v0.2 WIT contract defines, and
//! the imports an author reaches for first. On activation it reads an optional
//! secret and sends a notification through the host. `tool-execute` and
//! `workflow-node-execute` answer the tool and the workflow node the manifest
//! declares. Copy this file as the starting point for your own plugin.

#![allow(clippy::unwrap_used)] // bindings is generated, keep template lean

// `cargo-component` generates this module at build time from the WIT in
// `wit/`. Re-exporting keeps the rest of the file readable.
#[allow(warnings)]
mod bindings;

use bindings::cognia::plugin::{logger, notification, secrets};
use bindings::Guest;

/// Split a host error into its machine-readable code and its human text.
///
/// Every `result<..., string>` in the contract carries `"<CODE>: <message>"`,
/// with a fixed set of codes (`CAPABILITY_DENIED`, `HOST_UNAVAILABLE`,
/// `TIMEOUT`, and the rest). The codes are stable for the life of the 0.2
/// contract and the text is not, so branch on the code, never on the message.
fn split_host_error(error: &str) -> (&str, &str) {
    error.split_once(": ").unwrap_or(("", error))
}

struct Plugin;

impl Guest for Plugin {
    /// One-shot setup at install/enable time. `config` carries the
    /// JSON-encoded `defaultConfig` merged with any user overrides.
    fn init(config: Vec<u8>) -> Result<(), String> {
        logger::log(
            logger::LogLevel::Info,
            "init",
            &format!("hello from template! config_bytes={}", config.len()),
        );

        // Secrets are namespaced per plugin, so this key cannot collide with
        // another plugin's. `Ok(None)` means "not set yet", which is a normal
        // first-run state and not an error.
        match secrets::get("api-token") {
            Ok(Some(_)) => logger::log(logger::LogLevel::Info, "init", "api token present"),
            Ok(None) => logger::log(logger::LogLevel::Info, "init", "no api token stored yet"),
            Err(error) => {
                let (code, message) = split_host_error(&error);
                // CAPABILITY_DENIED means the user did not grant
                // `secrets:read`. Degrade, do not fail activation over it.
                logger::log(
                    logger::LogLevel::Warn,
                    "init",
                    &format!("secrets::get {code}: {message}"),
                );
            }
        }

        // v0.2: `notify` returns `result<_, string>`. A failure here is not
        // fatal to activation, because a denied or unavailable notification
        // surface should not stop the plugin booting. Log it and carry on. If
        // your plugin genuinely needs the notification to land, propagate the
        // error with `?` instead.
        if let Err(error) = notification::notify(
            "cognia-plugin-template",
            "Hello from the template plugin!",
            notification::NotificationKind::Info,
        ) {
            let (code, message) = split_host_error(&error);
            logger::log(
                logger::LogLevel::Warn,
                "init",
                &format!("notify {code}: {message}"),
            );
        }
        Ok(())
    }

    /// Generic hook dispatch. `kind` carries the host hook name and `payload`
    /// is JSON-encoded. The return value is JSON-encoded too, and the host
    /// sends it back to whoever invoked the call.
    fn on_event(kind: String, payload: Vec<u8>) -> Result<Vec<u8>, String> {
        logger::log(
            logger::LogLevel::Debug,
            "on-event",
            &format!("kind={} payload_bytes={}", kind, payload.len()),
        );
        Ok(payload) // echo
    }

    /// `tool-execute` lets the cognia agent invoke a tool you registered via
    /// `manifest.tools[]`. `args` is the JSON object the model produced against
    /// that tool's `parametersSchema`.
    fn tool_execute(name: String, args: Vec<u8>) -> Result<Vec<u8>, String> {
        logger::log(
            logger::LogLevel::Info,
            "tool-execute",
            &format!("tool={} args_bytes={}", name, args.len()),
        );
        // One export serves every declared tool, so dispatch on the name. An
        // unknown name is an error rather than a silent echo, because the agent
        // needs to hear that the call did not happen.
        if name != "template_echo" {
            return Err(format!("INVALID_REQUEST: unknown tool '{name}'"));
        }
        let parsed: serde_json::Value =
            serde_json::from_slice(&args).map_err(|e| format!("INVALID_REQUEST: {e}"))?;
        let message = parsed
            .get("message")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        serde_json::to_vec(&serde_json::json!({ "ok": true, "echoed": message }))
            .map_err(|e| e.to_string())
    }

    /// `workflow-node-execute` runs the custom node this plugin declares in
    /// `manifest.workflows.nodes[]`. `node_kind` is the namespaced kind the
    /// workflow runtime dispatches with, so it carries the plugin id and the
    /// suffix is what to match on. `inputs` is the resolved params object.
    fn workflow_node_execute(node_kind: String, inputs: Vec<u8>) -> Result<Vec<u8>, String> {
        logger::log(
            logger::LogLevel::Info,
            "workflow-node-execute",
            &format!("kind={} inputs_bytes={}", node_kind, inputs.len()),
        );
        if !node_kind.ends_with(".echo") {
            return Err(format!("INVALID_REQUEST: unknown node kind '{node_kind}'"));
        }
        let parsed: serde_json::Value =
            serde_json::from_slice(&inputs).map_err(|e| format!("INVALID_REQUEST: {e}"))?;
        let message = parsed
            .get("message")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        serde_json::to_vec(&serde_json::json!({ "output": { "message": message } }))
            .map_err(|e| e.to_string())
    }
}

bindings::export!(Plugin with_types_in bindings);

#[cfg(test)]
mod tests {
    use super::split_host_error;

    #[test]
    fn splits_a_prefixed_host_error() {
        assert_eq!(
            split_host_error("CAPABILITY_DENIED: secrets:read was not granted"),
            ("CAPABILITY_DENIED", "secrets:read was not granted")
        );
    }

    #[test]
    fn leaves_an_unprefixed_error_as_its_own_message() {
        assert_eq!(split_host_error("something broke"), ("", "something broke"));
    }
}

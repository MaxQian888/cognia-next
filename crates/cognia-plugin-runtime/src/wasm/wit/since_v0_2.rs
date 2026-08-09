//! Host-side bindings + capability impls for cognia-plugin **v0.2.0**.
//!
//! Bridges the WIT contract in `src-tauri/wit/cognia-plugin.wit` to the rest of
//! the runtime. Three responsibilities:
//!
//! 1. **Generate** the host trait scaffolding via
//!    `wasmtime::component::bindgen!`.
//! 2. **Implement** each generated `Host` trait against the live `HostState`.
//! 3. **Expose** a single `build_linker` wiring WASI Preview 2 and the
//!    cognia-specific imports into one `Linker<HostState>`.
//!
//! # What changed from v0.1
//!
//! v0.1 shipped clipboard, AI, notification, and workflow as stubs for one
//! structural reason: `HostState` carried no handle to anything outside the
//! sandbox. `HostState::services` is that handle, so all four are now real.
//!
//! - `notification.notify` returns `result<_, string>`, so a denial or a
//!   native failure is observable. v0.1 returned nothing and logged the
//!   title and body at info level — that payload leak does not come across.
//! - Clipboard and notifications are served **in-process**. Only AI and
//!   workflow pay a renderer round trip, because the provider chain, the PII
//!   gate, and the workflow trigger registry live in TypeScript.
//! - `ai.generate-text` is gated on `ai:chat`, not `network:fetch`.
//! - `workflow.emit-event` is gated on `extension:workflow`, previously ungated.
//!
//! # Ordering is a security property
//!
//! Every host import runs the same ladder, and the order is asserted by tests:
//!
//! ```text
//! capability check -> input validation -> service lookup -> dispatch
//! ```
//!
//! Nothing is allocated, emitted, or invoked until the whole ladder passes. A
//! denied plugin learns only that it was denied — not whether its inputs would
//! otherwise have been acceptable.
//!
//! When v0.3 lands, copy this file to `since_v0_3.rs`, register it from
//! `wit/mod.rs`, and add the matching arm in `host.rs::version_linker`. Freeze
//! this one under `frozen/v0_2/` at the same time.

use std::time::Duration;

use wasmtime::component::Linker;
use wasmtime_wasi::p2::add_to_linker_async;

use super::super::bridge::{effective_timeout_ms, WasmBridgeOperation};
use super::super::capabilities::{ai, clipboard, logger, notification, process, secrets, workflow};
use super::super::services::host_unavailable;
use super::super::store::HostState;

wasmtime::component::bindgen!({
    // The canonical WIT stays at src-tauri/wit/ (the sync/gate scripts treat
    // that path as the source of truth); this crate reaches it relative to its
    // own manifest dir (ADR-0067 extraction).
    path: "../../src-tauri/wit/cognia-plugin.wit",
    world: "cognia-plugin",
    imports: { default: async },
    exports: { default: async },
});

// =============================================================================
// Logger — ungated: the host owns the transport and bounds both arguments.
// =============================================================================

impl cognia::plugin::logger::Host for HostState {
    async fn log(
        &mut self,
        level: cognia::plugin::logger::LogLevel,
        scope: String,
        message: String,
    ) {
        let mapped = match level {
            cognia::plugin::logger::LogLevel::Trace => logger::WasmLogLevel::Trace,
            cognia::plugin::logger::LogLevel::Debug => logger::WasmLogLevel::Debug,
            cognia::plugin::logger::LogLevel::Info => logger::WasmLogLevel::Info,
            cognia::plugin::logger::LogLevel::Warn => logger::WasmLogLevel::Warn,
            cognia::plugin::logger::LogLevel::Error => logger::WasmLogLevel::Error,
        };
        logger::log(self, mapped, &scope, &message);
    }
}

// =============================================================================
// Notification — in-process via the host's native notification service.
// =============================================================================

impl cognia::plugin::notification::Host for HostState {
    async fn notify(
        &mut self,
        title: String,
        body: String,
        kind: cognia::plugin::notification::NotificationKind,
    ) -> Result<(), String> {
        let mapped = match kind {
            cognia::plugin::notification::NotificationKind::Info => {
                notification::NotificationKind::Info
            }
            cognia::plugin::notification::NotificationKind::Success => {
                notification::NotificationKind::Success
            }
            cognia::plugin::notification::NotificationKind::Warning => {
                notification::NotificationKind::Warning
            }
            cognia::plugin::notification::NotificationKind::Error => {
                notification::NotificationKind::Error
            }
        };
        // Capability + validation first; both are inside `prepare`.
        let pending = notification::prepare(self, title, body, mapped)?;

        let service = self
            .services
            .as_ref()
            .and_then(|s| s.notifications())
            .ok_or_else(|| host_unavailable("notification.notify"))?;

        service.notify(&pending).map_err(|e| e.to_wire())
    }
}

// =============================================================================
// Secrets — per-plugin service id, stored via the shared `secret_store`
// (single OS-keyring master key) so plugin secrets don't add Keychain prompts.
// =============================================================================

impl cognia::plugin::secrets::Host for HostState {
    async fn get(&mut self, key: String) -> Result<Option<String>, String> {
        secrets::check_read(self)?;
        let service = secrets::service_id(&self.plugin_id);
        cognia_secrets::secret_store::get(&service, &key)
    }

    async fn set(&mut self, key: String, value: String) -> Result<(), String> {
        secrets::check_write(self)?;
        let service = secrets::service_id(&self.plugin_id);
        cognia_secrets::secret_store::set(&service, &key, &value)
    }

    async fn delete(&mut self, key: String) -> Result<(), String> {
        secrets::check_write(self)?;
        let service = secrets::service_id(&self.plugin_id);
        cognia_secrets::secret_store::delete(&service, &key)
    }
}

// =============================================================================
// Process — std::process::Command behind `process:spawn` / `shell:execute`.
// Unchanged from v0.1 apart from the coded capability-denial strings.
// =============================================================================

impl cognia::plugin::process::Host for HostState {
    async fn exec(
        &mut self,
        program: String,
        args: Vec<String>,
        options: cognia::plugin::process::ExecOptions,
    ) -> Result<cognia::plugin::process::ExecResult, String> {
        process::check(self)?;
        process::validate(&program, &args)?;
        // DENY-by-default: the program must be in the plugin's declared
        // `shellCommands` allowlist — parity with the TS `shell:execute` gate.
        process::check_program_allowed(self, &program)?;
        let timeout_ms = options.timeout_ms.unwrap_or(self.call_timeout_ms as u32);

        let mut cmd = std::process::Command::new(&program);
        cmd.args(&args);
        if let Some(cwd) = options.cwd.as_deref() {
            cmd.current_dir(cwd);
        }
        // Environment: we *replace* the env so plugin code can't read
        // arbitrary host secrets through e.g. AWS_PROFILE or ANTHROPIC_API_KEY.
        cmd.env_clear();
        for (k, v) in options.env.iter() {
            cmd.env(k, v);
        }
        // Run sync on a blocking pool so async hosts stay responsive.
        let timeout = Duration::from_millis(timeout_ms as u64);
        let plugin_id = self.plugin_id.clone();
        let out = tokio::task::spawn_blocking(move || -> Result<_, String> {
            let mut child = cmd
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .map_err(|e| format!("spawn {program}: {e}"))?;

            match wait_timeout::ChildExt::wait_timeout(&mut child, timeout)
                .map_err(|e| format!("wait_timeout: {e}"))?
            {
                Some(status) => {
                    let mut stdout = Vec::new();
                    let mut stderr = Vec::new();
                    if let Some(mut s) = child.stdout.take() {
                        std::io::Read::read_to_end(&mut s, &mut stdout).ok();
                    }
                    if let Some(mut s) = child.stderr.take() {
                        std::io::Read::read_to_end(&mut s, &mut stderr).ok();
                    }
                    Ok((status.code().unwrap_or(-1), stdout, stderr))
                }
                None => {
                    let _ = child.kill();
                    Err(format!(
                        "process exec timed out after {}ms (plugin {plugin_id})",
                        timeout.as_millis()
                    ))
                }
            }
        })
        .await
        .map_err(|e| format!("blocking task join: {e}"))??;

        Ok(cognia::plugin::process::ExecResult {
            code: out.0,
            stdout: out.1,
            stderr: out.2,
        })
    }
}

// =============================================================================
// Clipboard — in-process via the host's native clipboard service.
// =============================================================================

impl cognia::plugin::clipboard::Host for HostState {
    async fn read_text(&mut self) -> Result<String, String> {
        clipboard::check_read(self)?;
        let service = self
            .services
            .as_ref()
            .and_then(|s| s.clipboard())
            .ok_or_else(|| host_unavailable("clipboard.read-text"))?;
        service.read_text().map_err(|e| e.to_wire())
    }

    async fn write_text(&mut self, value: String) -> Result<(), String> {
        clipboard::check_write(self)?;
        clipboard::validate_write(&value)?;
        let service = self
            .services
            .as_ref()
            .and_then(|s| s.clipboard())
            .ok_or_else(|| host_unavailable("clipboard.write-text"))?;
        service.write_text(&value).map_err(|e| e.to_wire())
    }
}

// =============================================================================
// AI — routed through the renderer bridge to the user's provider chain.
// =============================================================================

impl cognia::plugin::ai::Host for HostState {
    async fn generate_text(
        &mut self,
        prompt: String,
        options: cognia::plugin::ai::GenerateOptions,
    ) -> Result<String, String> {
        let opts = ai::GenerateOptions {
            max_tokens: options.max_tokens,
            temperature: options.temperature,
            model: options.model,
        };
        // Capability, then validation — both before any allocation.
        ai::check(self)?;
        ai::validate(&prompt, &opts)?;

        let bridge = self
            .services
            .as_ref()
            .and_then(|s| s.renderer_bridge())
            .ok_or_else(|| host_unavailable("ai.generate-text"))?;

        // The renderer speaks the plugin AI API's message shape, so a single
        // prompt becomes one user turn. Keeping the translation here rather
        // than in the renderer means the WIT contract stays one-shot even if
        // the TS side later grows multi-turn support.
        let mut payload = serde_json::json!({
            "messages": [{ "role": "user", "content": prompt }],
        });
        if let Some(model) = opts.model.as_deref() {
            payload["model"] = serde_json::Value::String(model.to_string());
        }
        if let Some(temperature) = opts.temperature {
            payload["temperature"] = serde_json::json!(temperature);
        }
        if let Some(max_tokens) = opts.max_tokens {
            payload["maxTokens"] = serde_json::json!(max_tokens);
        }

        let timeout = Duration::from_millis(effective_timeout_ms(self.call_timeout_ms));
        let value = bridge
            .dispatch(
                &self.plugin_id,
                WasmBridgeOperation::AiGenerateText,
                payload,
                timeout,
            )
            .await
            .map_err(|e| e.to_wire())?;

        value
            .get("text")
            .and_then(|t| t.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| {
                super::super::errors::coded(
                    super::super::errors::WasmErrorCode::ProviderError,
                    "ai.generate-text: renderer response had no `text` field",
                )
            })
    }
}

// =============================================================================
// Workflow — routed through the renderer bridge into the trigger runtime.
// =============================================================================

impl cognia::plugin::workflow::Host for HostState {
    async fn emit_event(
        &mut self,
        workflow_id: String,
        kind: String,
        payload: Vec<u8>,
    ) -> Result<(), String> {
        // Capability + validation live in `prepare`, so both run before the
        // service lookup and before anything is allocated.
        let event = workflow::prepare(self, workflow_id, kind, payload)?;

        let bridge = self
            .services
            .as_ref()
            .and_then(|s| s.renderer_bridge())
            .ok_or_else(|| host_unavailable("workflow.emit-event"))?;

        // The guest hands us opaque bytes. Forward them as parsed JSON when
        // they are JSON, and as a base64-free byte array otherwise, so the
        // renderer never has to guess an encoding.
        let parsed: serde_json::Value =
            serde_json::from_slice(&event.payload).unwrap_or_else(|_| serde_json::Value::Null);

        let body = serde_json::json!({
            "workflowId": event.workflow_id,
            "kind": event.kind,
            "payload": parsed,
        });

        let timeout = Duration::from_millis(effective_timeout_ms(self.call_timeout_ms));
        bridge
            .dispatch(
                &self.plugin_id,
                WasmBridgeOperation::WorkflowEmitEvent,
                body,
                timeout,
            )
            .await
            .map(|_| ())
            .map_err(|e| e.to_wire())
    }
}

// =============================================================================
// Linker
// =============================================================================

/// Build the v0.2.0 linker: WASI Preview 2 plus the cognia-specific interfaces
/// above. Called by `host.rs::version_linker` after the api-version section is
/// parsed from the component binary.
pub fn build_linker() -> wasmtime::Result<Linker<HostState>> {
    let engine = super::super::engine::engine();
    let mut linker: Linker<HostState> = Linker::new(engine);
    // Standard WASI 0.2 — clocks, random, io, cli, filesystem, stdio.
    add_to_linker_async(&mut linker)?;
    // cognia-specific imports, each wired against the typed Host trait.
    CogniaPlugin::add_to_linker::<_, wasmtime::component::HasSelf<_>>(
        &mut linker,
        |s: &mut HostState| s,
    )?;
    Ok(linker)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::wasm::bridge::{
        CancelReason, WasmRendererBridge, WasmRendererResponse, MAX_BODY_BYTES, REQUEST_EVENT,
    };
    use crate::wasm::errors::WasmErrorCode;
    use crate::wasm::services::test_support::{
        RecordingClipboard, RecordingNotifications, RecordingWasmBridgeTransport,
        RecordingWasmHostServices,
    };
    use crate::wasm::store::{test_host_state, test_host_state_with};

    use cognia::plugin::ai::Host as AiHost;
    use cognia::plugin::clipboard::Host as ClipboardHost;
    use cognia::plugin::notification::Host as NotificationHost;
    use cognia::plugin::workflow::Host as WorkflowHost;

    fn wit_kind(
        k: notification::NotificationKind,
    ) -> cognia::plugin::notification::NotificationKind {
        match k {
            notification::NotificationKind::Info => {
                cognia::plugin::notification::NotificationKind::Info
            }
            notification::NotificationKind::Success => {
                cognia::plugin::notification::NotificationKind::Success
            }
            notification::NotificationKind::Warning => {
                cognia::plugin::notification::NotificationKind::Warning
            }
            notification::NotificationKind::Error => {
                cognia::plugin::notification::NotificationKind::Error
            }
        }
    }

    #[test]
    fn build_linker_succeeds() {
        assert!(build_linker().is_ok());
    }

    // -------------------------------------------------------------------------
    // Notification
    // -------------------------------------------------------------------------

    #[tokio::test]
    async fn notify_requires_the_notification_capability() {
        // Denied even with a working backend installed.
        let services = Arc::new(RecordingWasmHostServices::full());
        let mut st = test_host_state_with("demo", &[], Some(services), 30_000);
        let err = st
            .notify(
                "T".into(),
                "B".into(),
                wit_kind(notification::NotificationKind::Info),
            )
            .await
            .unwrap_err();
        assert!(err.starts_with("CAPABILITY_DENIED: "));
    }

    #[tokio::test]
    async fn notify_without_a_backend_is_host_unavailable() {
        let mut st = test_host_state("demo", &["notification"]);
        let err = st
            .notify(
                "T".into(),
                "B".into(),
                wit_kind(notification::NotificationKind::Info),
            )
            .await
            .unwrap_err();
        assert!(err.starts_with("HOST_UNAVAILABLE: "));
        assert!(err.contains("notification.notify"));
    }

    #[tokio::test]
    async fn a_missing_notification_backend_does_not_disable_clipboard() {
        // The whole point of per-surface Options: one absent surface must not
        // take the others down with it.
        let clipboard = Arc::new(RecordingClipboard::with_contents("hello"));
        let services =
            Arc::new(RecordingWasmHostServices::empty().with_clipboard(clipboard.clone()));
        let mut st = test_host_state_with(
            "demo",
            &["notification", "clipboard:read"],
            Some(services),
            30_000,
        );

        let notify_err = st
            .notify(
                "T".into(),
                "B".into(),
                wit_kind(notification::NotificationKind::Info),
            )
            .await
            .unwrap_err();
        assert!(notify_err.starts_with("HOST_UNAVAILABLE: "));

        // Clipboard still works.
        assert_eq!(st.read_text().await.unwrap(), "hello");
    }

    #[tokio::test]
    async fn notify_goes_in_process_and_emits_no_bridge_frame() {
        let notifications = Arc::new(RecordingNotifications::new());
        let transport = Arc::new(RecordingWasmBridgeTransport::new());
        let bridge = WasmRendererBridge::new(transport.clone());
        let services = Arc::new(
            RecordingWasmHostServices::empty()
                .with_notifications(notifications.clone())
                .with_bridge(bridge),
        );
        let mut st = test_host_state_with("demo", &["notification"], Some(services), 30_000);

        st.notify(
            "Title".into(),
            "Body".into(),
            wit_kind(notification::NotificationKind::Warning),
        )
        .await
        .unwrap();

        let sent = notifications.sent();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].title, "Title");
        assert_eq!(sent[0].kind, notification::NotificationKind::Warning);
        // No renderer round trip for a native surface.
        assert_eq!(transport.frame_count(), 0);
    }

    #[tokio::test]
    async fn notify_surfaces_native_failures_to_the_guest() {
        // The reason v0.2 changed the signature: in v0.1 this was unobservable.
        let services = Arc::new(
            RecordingWasmHostServices::empty()
                .with_notifications(Arc::new(RecordingNotifications::failing())),
        );
        let mut st = test_host_state_with("demo", &["notification"], Some(services), 30_000);
        let err = st
            .notify(
                "T".into(),
                "B".into(),
                wit_kind(notification::NotificationKind::Info),
            )
            .await
            .unwrap_err();
        assert!(err.starts_with("PROVIDER_ERROR: "));
        assert!(err.contains("permission denied"));
    }

    // -------------------------------------------------------------------------
    // Clipboard
    // -------------------------------------------------------------------------

    #[tokio::test]
    async fn clipboard_read_and_write_route_to_the_service() {
        let clipboard = Arc::new(RecordingClipboard::with_contents("seed"));
        let services =
            Arc::new(RecordingWasmHostServices::empty().with_clipboard(clipboard.clone()));
        let mut st = test_host_state_with(
            "demo",
            &["clipboard:read", "clipboard:write"],
            Some(services),
            30_000,
        );

        assert_eq!(st.read_text().await.unwrap(), "seed");
        st.write_text("next".into()).await.unwrap();
        assert_eq!(clipboard.writes(), vec!["next".to_string()]);
        assert_eq!(st.read_text().await.unwrap(), "next");
    }

    #[tokio::test]
    async fn clipboard_denial_precedes_host_unavailable() {
        // No capability AND no backend — the guest must be told the actionable
        // thing (it needs a grant), not that the host is broken.
        let mut st = test_host_state("demo", &[]);
        let err = st.read_text().await.unwrap_err();
        assert!(err.starts_with("CAPABILITY_DENIED: "));
    }

    #[tokio::test]
    async fn clipboard_without_a_backend_is_host_unavailable() {
        let mut st = test_host_state("demo", &["clipboard:read", "clipboard:write"]);
        assert!(st
            .read_text()
            .await
            .unwrap_err()
            .starts_with("HOST_UNAVAILABLE: "));
        assert!(st
            .write_text("x".into())
            .await
            .unwrap_err()
            .starts_with("HOST_UNAVAILABLE: "));
    }

    #[tokio::test]
    async fn clipboard_write_is_size_capped_before_touching_the_service() {
        let clipboard = Arc::new(RecordingClipboard::new());
        let services =
            Arc::new(RecordingWasmHostServices::empty().with_clipboard(clipboard.clone()));
        let mut st = test_host_state_with("demo", &["clipboard:write"], Some(services), 30_000);

        let big = "x".repeat(clipboard::MAX_TEXT_BYTES + 1);
        let err = st.write_text(big).await.unwrap_err();
        assert!(err.starts_with("PAYLOAD_TOO_LARGE: "));
        assert!(
            clipboard.writes().is_empty(),
            "the service must not be reached"
        );
    }

    // -------------------------------------------------------------------------
    // AI
    // -------------------------------------------------------------------------

    #[tokio::test]
    async fn generate_text_requires_ai_chat_not_network_fetch() {
        // Requirement 3's regression anchor.
        let services = Arc::new(RecordingWasmHostServices::full());
        let mut st = test_host_state_with("demo", &["network:fetch"], Some(services), 30_000);
        let err = st
            .generate_text(
                "hi".into(),
                cognia::plugin::ai::GenerateOptions {
                    max_tokens: None,
                    temperature: None,
                    model: None,
                },
            )
            .await
            .unwrap_err();
        assert!(err.starts_with("CAPABILITY_DENIED: "));
        assert!(err.contains("ai:chat"));
    }

    #[tokio::test]
    async fn generate_text_validates_before_touching_the_bridge() {
        let transport = Arc::new(RecordingWasmBridgeTransport::new());
        let bridge = WasmRendererBridge::new(transport.clone());
        let services = Arc::new(RecordingWasmHostServices::empty().with_bridge(bridge.clone()));
        let mut st = test_host_state_with("demo", &["ai:chat"], Some(services), 30_000);

        let big = "x".repeat(ai::MAX_PROMPT_BYTES + 1);
        let err = st
            .generate_text(
                big,
                cognia::plugin::ai::GenerateOptions {
                    max_tokens: None,
                    temperature: None,
                    model: None,
                },
            )
            .await
            .unwrap_err();

        assert!(err.starts_with("PAYLOAD_TOO_LARGE: "));
        assert_eq!(transport.frame_count(), 0, "nothing may be emitted");
        assert_eq!(bridge.pending_count(), 0, "nothing may be allocated");
    }

    #[tokio::test]
    async fn generate_text_without_a_bridge_is_host_unavailable() {
        let mut st = test_host_state("demo", &["ai:chat"]);
        let err = st
            .generate_text(
                "hi".into(),
                cognia::plugin::ai::GenerateOptions {
                    max_tokens: None,
                    temperature: None,
                    model: None,
                },
            )
            .await
            .unwrap_err();
        assert!(err.starts_with("HOST_UNAVAILABLE: "));
    }

    #[tokio::test]
    async fn generate_text_timeout_is_capped_by_call_timeout_ms() {
        let transport = Arc::new(RecordingWasmBridgeTransport::new());
        let bridge = WasmRendererBridge::new(transport.clone());
        let services = Arc::new(RecordingWasmHostServices::empty().with_bridge(bridge));

        for (call_timeout, expected) in [(5_000u64, 5_000u64), (120_000, 30_000)] {
            let transport = transport.clone();
            let mut st =
                test_host_state_with("demo", &["ai:chat"], Some(services.clone()), call_timeout);
            tokio::spawn(async move {
                let _ = st
                    .generate_text(
                        "hi".into(),
                        cognia::plugin::ai::GenerateOptions {
                            max_tokens: None,
                            temperature: None,
                            model: None,
                        },
                    )
                    .await;
            });
            tokio::time::sleep(Duration::from_millis(20)).await;
            let frames = transport.frames_for(REQUEST_EVENT);
            let last = frames.last().expect("a frame was emitted");
            assert_eq!(last["timeoutMs"], serde_json::json!(expected));
        }
    }

    #[tokio::test]
    async fn generate_text_drains_the_renderer_text_field() {
        let transport = Arc::new(RecordingWasmBridgeTransport::new());
        let bridge = WasmRendererBridge::new(transport.clone());
        let services = Arc::new(RecordingWasmHostServices::empty().with_bridge(bridge.clone()));
        let mut st = test_host_state_with("demo", &["ai:chat"], Some(services), 30_000);

        let handle = tokio::spawn(async move {
            st.generate_text(
                "hi".into(),
                cognia::plugin::ai::GenerateOptions {
                    max_tokens: Some(256),
                    temperature: Some(0.4),
                    model: Some("m".into()),
                },
            )
            .await
        });
        tokio::time::sleep(Duration::from_millis(20)).await;

        let frame = transport.frames_for(REQUEST_EVENT).remove(0);
        assert_eq!(frame["operation"], serde_json::json!("ai.generate-text"));
        assert_eq!(
            frame["payload"]["messages"][0]["content"],
            serde_json::json!("hi")
        );
        assert_eq!(frame["payload"]["model"], serde_json::json!("m"));
        assert_eq!(frame["payload"]["maxTokens"], serde_json::json!(256));

        bridge.resolve(WasmRendererResponse {
            request_id: frame["requestId"].as_str().unwrap().to_string(),
            plugin_id: "demo".into(),
            result: Some(serde_json::json!({ "text": "generated" })),
            error: None,
        });

        assert_eq!(handle.await.unwrap().unwrap(), "generated");
    }

    #[tokio::test]
    async fn generate_text_rejects_a_response_without_text() {
        let transport = Arc::new(RecordingWasmBridgeTransport::new());
        let bridge = WasmRendererBridge::new(transport.clone());
        let services = Arc::new(RecordingWasmHostServices::empty().with_bridge(bridge.clone()));
        let mut st = test_host_state_with("demo", &["ai:chat"], Some(services), 30_000);

        let handle = tokio::spawn(async move {
            st.generate_text(
                "hi".into(),
                cognia::plugin::ai::GenerateOptions {
                    max_tokens: None,
                    temperature: None,
                    model: None,
                },
            )
            .await
        });
        tokio::time::sleep(Duration::from_millis(20)).await;

        let frame = transport.frames_for(REQUEST_EVENT).remove(0);
        bridge.resolve(WasmRendererResponse {
            request_id: frame["requestId"].as_str().unwrap().to_string(),
            plugin_id: "demo".into(),
            result: Some(serde_json::json!({ "notText": "oops" })),
            error: None,
        });

        let err = handle.await.unwrap().unwrap_err();
        assert!(err.starts_with("PROVIDER_ERROR: "));
    }

    #[tokio::test]
    async fn generate_text_reports_cancellation_when_the_plugin_is_torn_down() {
        let transport = Arc::new(RecordingWasmBridgeTransport::new());
        let bridge = WasmRendererBridge::new(transport.clone());
        let services = Arc::new(RecordingWasmHostServices::empty().with_bridge(bridge.clone()));
        let mut st = test_host_state_with("demo", &["ai:chat"], Some(services), 30_000);

        let handle = tokio::spawn(async move {
            st.generate_text(
                "hi".into(),
                cognia::plugin::ai::GenerateOptions {
                    max_tokens: None,
                    temperature: None,
                    model: None,
                },
            )
            .await
        });
        tokio::time::sleep(Duration::from_millis(20)).await;

        assert_eq!(bridge.cancel_plugin("demo", CancelReason::Deactivate), 1);
        let err = handle.await.unwrap().unwrap_err();
        assert!(err.starts_with("CANCELLED: "));
    }

    // -------------------------------------------------------------------------
    // Workflow
    // -------------------------------------------------------------------------

    #[tokio::test]
    async fn emit_event_requires_the_workflow_capability() {
        let services = Arc::new(RecordingWasmHostServices::full());
        let mut st = test_host_state_with("demo", &[], Some(services), 30_000);
        let err = st
            .emit_event("wf".into(), "tick".into(), b"{}".to_vec())
            .await
            .unwrap_err();
        assert!(err.starts_with("CAPABILITY_DENIED: "));
        assert!(err.contains("extension:workflow"));
    }

    #[tokio::test]
    async fn emit_event_validates_before_dispatch() {
        let transport = Arc::new(RecordingWasmBridgeTransport::new());
        let bridge = WasmRendererBridge::new(transport.clone());
        let services = Arc::new(RecordingWasmHostServices::empty().with_bridge(bridge.clone()));
        let mut st = test_host_state_with("demo", &["extension:workflow"], Some(services), 30_000);

        let blank = st
            .emit_event("".into(), "tick".into(), b"{}".to_vec())
            .await
            .unwrap_err();
        assert!(blank.starts_with("INVALID_REQUEST: "));

        let oversize = st
            .emit_event(
                "wf".into(),
                "tick".into(),
                vec![0u8; workflow::MAX_PAYLOAD_BYTES + 1],
            )
            .await
            .unwrap_err();
        assert!(oversize.starts_with("PAYLOAD_TOO_LARGE: "));

        assert_eq!(transport.frame_count(), 0);
        assert_eq!(bridge.pending_count(), 0);
    }

    #[tokio::test]
    async fn emit_event_maps_renderer_rejection_to_workflow_rejected() {
        let transport = Arc::new(RecordingWasmBridgeTransport::new());
        let bridge = WasmRendererBridge::new(transport.clone());
        let services = Arc::new(RecordingWasmHostServices::empty().with_bridge(bridge.clone()));
        let mut st = test_host_state_with("demo", &["extension:workflow"], Some(services), 30_000);

        let handle = tokio::spawn(async move {
            st.emit_event("wf".into(), "tick".into(), br#"{"n":1}"#.to_vec())
                .await
        });
        tokio::time::sleep(Duration::from_millis(20)).await;

        let frame = transport.frames_for(REQUEST_EVENT).remove(0);
        assert_eq!(frame["payload"]["workflowId"], serde_json::json!("wf"));
        assert_eq!(frame["payload"]["payload"]["n"], serde_json::json!(1));

        bridge.resolve(WasmRendererResponse {
            request_id: frame["requestId"].as_str().unwrap().to_string(),
            plugin_id: "demo".into(),
            result: None,
            error: Some(crate::wasm::bridge::WasmRendererErrorBody {
                code: WasmErrorCode::WorkflowRejected.as_str().to_string(),
                message: "not-registered".into(),
            }),
        });

        let err = handle.await.unwrap().unwrap_err();
        assert!(err.starts_with("WORKFLOW_REJECTED: "));
        assert!(err.contains("not-registered"));
    }

    #[tokio::test]
    async fn emit_event_succeeds_on_an_ok_bridge_result() {
        let transport = Arc::new(RecordingWasmBridgeTransport::new());
        let bridge = WasmRendererBridge::new(transport.clone());
        let services = Arc::new(RecordingWasmHostServices::empty().with_bridge(bridge.clone()));
        let mut st = test_host_state_with("demo", &["extension:workflow"], Some(services), 30_000);

        let handle = tokio::spawn(async move {
            st.emit_event("wf".into(), "tick".into(), b"{}".to_vec())
                .await
        });
        tokio::time::sleep(Duration::from_millis(20)).await;

        let frame = transport.frames_for(REQUEST_EVENT).remove(0);
        bridge.resolve(WasmRendererResponse {
            request_id: frame["requestId"].as_str().unwrap().to_string(),
            plugin_id: "demo".into(),
            result: Some(serde_json::json!({ "ok": true, "prefixedKind": "demo:tick" })),
            error: None,
        });

        assert!(handle.await.unwrap().is_ok());
    }

    #[tokio::test]
    async fn emit_event_forwards_non_json_payloads_as_null() {
        // Opaque bytes are legal on the WIT side; the renderer must not be
        // handed a half-parsed value it has to guess about.
        let transport = Arc::new(RecordingWasmBridgeTransport::new());
        let bridge = WasmRendererBridge::new(transport.clone());
        let services = Arc::new(RecordingWasmHostServices::empty().with_bridge(bridge));
        let mut st = test_host_state_with("demo", &["extension:workflow"], Some(services), 30_000);

        tokio::spawn(async move {
            let _ = st
                .emit_event("wf".into(), "tick".into(), vec![0xff, 0xfe])
                .await;
        });
        tokio::time::sleep(Duration::from_millis(20)).await;

        let frame = transport.frames_for(REQUEST_EVENT).remove(0);
        assert_eq!(frame["payload"]["payload"], serde_json::Value::Null);
    }

    #[tokio::test]
    async fn emit_event_without_a_bridge_is_host_unavailable() {
        let mut st = test_host_state("demo", &["extension:workflow"]);
        let err = st
            .emit_event("wf".into(), "tick".into(), b"{}".to_vec())
            .await
            .unwrap_err();
        assert!(err.starts_with("HOST_UNAVAILABLE: "));
    }

    #[test]
    fn max_body_bytes_is_looser_than_every_per_surface_cap() {
        // The generic envelope limit must never be the binding constraint —
        // otherwise a surface's own, stricter check would be unreachable.
        assert!(ai::MAX_PROMPT_BYTES < MAX_BODY_BYTES);
        assert!(clipboard::MAX_TEXT_BYTES <= MAX_BODY_BYTES);
        assert!(notification::MAX_FIELD_BYTES < MAX_BODY_BYTES);
    }
}

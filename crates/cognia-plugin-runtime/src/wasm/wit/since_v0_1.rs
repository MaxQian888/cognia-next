//! Host-side bindings + capability impls for cognia-plugin **v0.1.0**.
//!
//! This file is the bridge between the WIT contract in
//! `src-tauri/wit/cognia-plugin.wit` and the rest of the runtime in
//! `super::super::capabilities::*`. Three responsibilities:
//!
//! 1. **Generate** the host trait scaffolding via
//!    `wasmtime::component::bindgen!` — types like `Cognia`, the
//!    per-interface `Host` traits, the `add_to_linker` helpers.
//! 2. **Implement** each generated `Host` trait against the live
//!    `HostState`. Each trait method consults the
//!    `CapabilityGranter` snapshot before delegating to the matching
//!    helper in `capabilities/`.
//! 3. **Expose** a single `build_linker` that wires both WASI Preview 2
//!    (filesystem / clocks / random / io / cli / stdio) and the
//!    cognia-specific imports into the same `Linker<HostState>`. The
//!    version router in `host.rs` calls this for v0.x.y plugins.
//!
//! When v0.2 lands, copy this file to `since_v0_2.rs`, register it from
//! `wit/mod.rs`, and add the matching arm in `host.rs::version_linker`.

use wasmtime::component::Linker;
use wasmtime_wasi::add_to_linker_async;

use super::super::capabilities::{ai, clipboard, logger, notification, process, secrets, workflow};
use super::super::store::HostState;

wasmtime::component::bindgen!({
    // The canonical WIT stays at src-tauri/wit/ (the plugin-sdk sync/gate
    // scripts treat that path as the source of truth); this crate reaches it
    // relative to its own manifest dir (ADR-0067 extraction).
    path: "../../src-tauri/wit/cognia-plugin.wit",
    world: "cognia-plugin",
    async: true,
});

// =============================================================================
// Logger
// =============================================================================

#[async_trait::async_trait]
impl cognia::plugin::logger::Host for HostState {
    async fn log(
        &mut self,
        level: cognia::plugin::logger::LogLevel,
        scope: String,
        message: String,
    ) -> () {
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
// Notification
// =============================================================================

#[async_trait::async_trait]
impl cognia::plugin::notification::Host for HostState {
    async fn notify(
        &mut self,
        title: String,
        body: String,
        kind: cognia::plugin::notification::NotificationKind,
    ) -> () {
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
        match notification::prepare(self, title, body, mapped) {
            Ok(pending) => {
                // v0.1 publishes notifications through the host's existing
                // log surface (the same path the `plugin_api/notification`
                // command uses for TS plugins). M2 wires this through
                // `tauri-plugin-notification` so real OS toasts appear.
                log::info!(
                    "[plugin:{}] notify({:?}): {} — {}",
                    pending.plugin_id,
                    pending.kind,
                    pending.title,
                    pending.body
                );
            }
            Err(message) => {
                // Capability denied or invalid input. We can't return an
                // error from a `func` that returns nothing, so we surface
                // the denial via the log channel; the guest will still see
                // the call complete but the host audit log records the
                // denial for the user.
                log::warn!("[plugin:{}] notify denied: {}", self.plugin_id, message);
            }
        }
    }
}

// =============================================================================
// Secrets — per-plugin service id, stored via the shared `secret_store`
// (single OS-keyring master key) so plugin secrets don't add Keychain prompts.
// =============================================================================

#[async_trait::async_trait]
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
// =============================================================================

#[async_trait::async_trait]
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
        // arbitrary host secrets through e.g. AWS_PROFILE or
        // ANTHROPIC_API_KEY.
        cmd.env_clear();
        for (k, v) in options.env.iter() {
            cmd.env(k, v);
        }
        // Run sync on a blocking pool so async hosts stay responsive.
        let timeout = std::time::Duration::from_millis(timeout_ms as u64);
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
// Clipboard — currently logs the intent; v0.2 wires `arboard`.
// =============================================================================

#[async_trait::async_trait]
impl cognia::plugin::clipboard::Host for HostState {
    async fn read_text(&mut self) -> Result<String, String> {
        clipboard::check_read(self)?;
        // The `tauri-plugin-clipboard-manager`-backed bridge to the renderer's
        // clipboard is not wired in v0.1. Returning `Ok("")` here would look
        // like an empty clipboard to the guest; instead surface a typed
        // not-implemented error (over the WIT `result` channel) so the guest
        // can branch. The capability gate above still runs first, so a denial
        // is reported before this.
        Err(super::super::not_implemented_error(
            "clipboard.read-text",
            "the host clipboard bridge is not wired in api-version 0.1",
        ))
    }

    async fn write_text(&mut self, _value: String) -> Result<(), String> {
        clipboard::check_write(self)?;
        // Same as `read_text`: no clipboard backend in v0.1. A silent `Ok(())`
        // would tell the guest the write succeeded; return typed not-implemented.
        Err(super::super::not_implemented_error(
            "clipboard.write-text",
            "the host clipboard bridge is not wired in api-version 0.1",
        ))
    }
}

// =============================================================================
// AI — provider chain stub for v0.1. v0.2 routes to lib/ai/* via IPC.
// =============================================================================

#[async_trait::async_trait]
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
        ai::check(self)?;
        ai::validate(&prompt, &opts)?;
        // Honest failure rather than a plausible-looking stub. The real
        // provider chain (user-configured models, quotas, and the PII
        // redaction gate) lives in the renderer/TS layer; reaching it from
        // the WASM host needs an AppHandle + request/response IPC bridge that
        // `HostState` does not yet carry. Until that bridge lands, returning
        // fake text would silently corrupt guest output, so we surface a
        // clear error the guest can branch on (the permission + validation
        // gates above still run, so capability denial is reported first).
        let _ = &opts;
        Err(super::super::not_implemented_error(
            "ai.generate-text",
            "the host provider bridge (models, quotas, PII gate) is not wired in api-version 0.1",
        ))
    }
}

// =============================================================================
// Workflow — forward emit-event into the host log; bridge to runtime is
// the responsibility of the workflow plugin layer in TS.
// =============================================================================

#[async_trait::async_trait]
impl cognia::plugin::workflow::Host for HostState {
    async fn emit_event(
        &mut self,
        workflow_id: String,
        kind: String,
        payload: Vec<u8>,
    ) -> Result<(), String> {
        let event = workflow::prepare(self, workflow_id, kind, payload)?;
        log::info!(
            "[plugin:{}] workflow.emit_event workflow={} kind={} payload_bytes={}",
            event.plugin_id,
            event.workflow_id,
            event.kind,
            event.payload.len()
        );
        Ok(())
    }
}

// =============================================================================
// Linker
// =============================================================================

/// Build the v0.1.0 linker: WASI Preview 2 plus the cognia-specific
/// interfaces above. Called by `host.rs::version_linker` after the api-
/// version section is parsed from the component binary.
pub fn build_linker() -> wasmtime::Result<Linker<HostState>> {
    let engine = super::super::engine::engine();
    let mut linker: Linker<HostState> = Linker::new(engine);
    // Standard WASI 0.2 — clocks, random, io, cli, filesystem, stdio.
    add_to_linker_async(&mut linker)?;
    // cognia-specific imports, each wired against the typed Host trait.
    CogniaPlugin::add_to_linker(&mut linker, |s: &mut HostState| s)?;
    Ok(linker)
}

#[cfg(test)]
mod tests {
    use super::super::super::store::CapabilitySet;
    use super::*;
    use wasmtime_wasi::{ResourceTable, WasiCtxBuilder};

    fn host(caps: &[&str]) -> HostState {
        HostState {
            plugin_id: "demo".into(),
            capabilities: CapabilitySet::from_iter(caps.iter().map(|s| (*s).to_string())),
            shell_allowlist: Vec::new(),
            call_timeout_ms: 30_000,
            limits: wasmtime::StoreLimitsBuilder::new().build(),
            table: ResourceTable::new(),
            wasi: WasiCtxBuilder::new().build(),
        }
    }

    fn gen_opts() -> cognia::plugin::ai::GenerateOptions {
        cognia::plugin::ai::GenerateOptions {
            max_tokens: Some(128),
            temperature: None,
            model: None,
        }
    }

    #[test]
    fn build_linker_succeeds() {
        let linker = build_linker().expect("v0.1 linker builds");
        // Sanity check — the linker compiles even before any component
        // instantiation, since `add_to_linker` only registers function
        // signatures. Real round-trip checks land in M1.4 integration
        // tests once a fixture .wasm exists.
        let _ = linker;
    }

    #[tokio::test]
    async fn generate_text_fails_honestly_instead_of_returning_fake_output() {
        use cognia::plugin::ai::Host as _;
        // Capability granted + valid prompt: the call must NOT fabricate
        // plausible text. It returns a clear "not wired" error so a guest
        // can branch instead of consuming corrupted output.
        let mut state = host(&["network:fetch"]);
        let result = state
            .generate_text("summarize this".into(), gen_opts())
            .await;
        let err = result.expect_err("ai.generate_text must not return fake content");
        assert!(
            err.starts_with(super::super::super::NOT_IMPLEMENTED_CODE),
            "must carry the stable not-implemented code the guest branches on: {err}"
        );
        assert!(
            !err.contains("stub"),
            "must not leak a stub marker into guest output: {err}"
        );
    }

    #[tokio::test]
    async fn clipboard_read_text_returns_typed_not_implemented() {
        use cognia::plugin::clipboard::Host as _;
        // With the capability granted, a stubbed read must NOT masquerade as an
        // empty clipboard — it returns the typed not-implemented code so the
        // guest can tell "no backend" from "clipboard was empty".
        let mut state = host(&["clipboard:read"]);
        let err = state
            .read_text()
            .await
            .expect_err("clipboard.read-text must not return fake empty text");
        assert!(
            err.starts_with(super::super::super::NOT_IMPLEMENTED_CODE),
            "unexpected message: {err}"
        );
    }

    #[tokio::test]
    async fn clipboard_write_text_returns_typed_not_implemented() {
        use cognia::plugin::clipboard::Host as _;
        let mut state = host(&["clipboard:write"]);
        let err = state
            .write_text("hello".into())
            .await
            .expect_err("clipboard.write-text must not claim a fake success");
        assert!(
            err.starts_with(super::super::super::NOT_IMPLEMENTED_CODE),
            "unexpected message: {err}"
        );
    }

    #[tokio::test]
    async fn clipboard_reports_capability_denial_before_not_implemented() {
        use cognia::plugin::clipboard::Host as _;
        // Without the capability the denial fires first — the guest sees a
        // capability error, not the not-implemented code.
        let mut state = host(&[]);
        let err = state
            .read_text()
            .await
            .expect_err("missing capability must error");
        assert!(err.contains("clipboard:read"), "unexpected message: {err}");
        assert!(
            !err.starts_with(super::super::super::NOT_IMPLEMENTED_CODE),
            "denial must not be masked by not-implemented: {err}"
        );
    }

    #[tokio::test]
    async fn generate_text_reports_capability_denial_first() {
        use cognia::plugin::ai::Host as _;
        // Without `network:fetch`, the capability gate fires before the
        // not-wired error — denial is reported, not the provider gap.
        let mut state = host(&[]);
        let err = state
            .generate_text("hello".into(), gen_opts())
            .await
            .expect_err("missing capability must error");
        assert!(err.contains("network:fetch"), "unexpected message: {err}");
    }
}

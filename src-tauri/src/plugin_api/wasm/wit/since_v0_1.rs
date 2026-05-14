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
    path: "wit/cognia-plugin.wit",
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
                log::warn!(
                    "[plugin:{}] notify denied: {}",
                    self.plugin_id,
                    message
                );
            }
        }
    }
}

// =============================================================================
// Secrets — wraps the existing `keyring` crate via per-plugin service id.
// =============================================================================

#[async_trait::async_trait]
impl cognia::plugin::secrets::Host for HostState {
    async fn get(&mut self, key: String) -> Result<Option<String>, String> {
        secrets::check_read(self)?;
        let service = secrets::service_id(&self.plugin_id);
        let entry = keyring::Entry::new(&service, &key)
            .map_err(|e| format!("keyring open: {e}"))?;
        match entry.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("keyring read: {e}")),
        }
    }

    async fn set(&mut self, key: String, value: String) -> Result<(), String> {
        secrets::check_write(self)?;
        let service = secrets::service_id(&self.plugin_id);
        let entry = keyring::Entry::new(&service, &key)
            .map_err(|e| format!("keyring open: {e}"))?;
        entry
            .set_password(&value)
            .map_err(|e| format!("keyring write: {e}"))
    }

    async fn delete(&mut self, key: String) -> Result<(), String> {
        secrets::check_write(self)?;
        let service = secrets::service_id(&self.plugin_id);
        let entry = keyring::Entry::new(&service, &key)
            .map_err(|e| format!("keyring open: {e}"))?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("keyring delete: {e}")),
        }
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
        // v0.1 returns empty; the real implementation lands when we ship
        // `tauri-plugin-clipboard-manager`-backed access to the renderer's
        // clipboard. Returning Ok(empty) keeps guest contract stable.
        Ok(String::new())
    }

    async fn write_text(&mut self, _value: String) -> Result<(), String> {
        clipboard::check_write(self)?;
        log::info!("[plugin:{}] clipboard.write_text (stubbed)", self.plugin_id);
        Ok(())
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
        // v0.1 surface: the guest sees `ai.generate-text` succeed but
        // receives a deterministic stub. v0.2 will dispatch to the host's
        // configured provider chain through a Tauri event back to the TS
        // side so the user's provider settings + quotas are honored.
        Ok(format!(
            "[cognia:ai:generate-text:stub] {} tokens requested for prompt of len {}",
            opts.max_tokens.unwrap_or(0),
            prompt.len()
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
    use super::*;

    #[test]
    fn build_linker_succeeds() {
        let linker = build_linker().expect("v0.1 linker builds");
        // Sanity check — the linker compiles even before any component
        // instantiation, since `add_to_linker` only registers function
        // signatures. Real round-trip checks land in M1.4 integration
        // tests once a fixture .wasm exists.
        let _ = linker;
    }
}

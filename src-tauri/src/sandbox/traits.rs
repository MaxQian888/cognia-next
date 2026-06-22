// ADR-0028 — `SandboxedExec` trait. The single abstraction every backend
// implements: take a `SandboxCommand` + `SandboxPolicy`, produce a
// `SandboxResult` or `SandboxError`.
//
// `run` / `is_available` / `first_time_setup` go live in Phase 4.2+ (real
// per-platform backend invocations) and Phase 4.5 (dispatcher consumes the
// trait via the `sandbox_exec` Tauri command). `health` is already live
// today via `sandbox_health_probe` in `mod.rs`.
#![allow(dead_code)]
//
// Lives in its own file so backends (`mock`, `uninstalled`, future
// `windows` / `macos` / `linux`) can `use crate::sandbox::traits::*` without
// pulling in the dispatcher / Tauri command surface that lives in `mod.rs`.

use async_trait::async_trait;

use crate::sandbox::types::{
    SandboxCommand, SandboxError, SandboxHealth, SandboxPolicy, SandboxResult,
};

#[async_trait]
pub trait SandboxedExec: Send + Sync {
    /// Run `command` under `policy`. Backends MUST enforce the policy at
    /// the OS layer (restricted tokens / ACLs / SBPL / bwrap flags); the
    /// dispatcher does NOT pre-check.
    async fn run(
        &self,
        command: SandboxCommand,
        policy: SandboxPolicy,
    ) -> Result<SandboxResult, SandboxError>;

    /// Cheap availability check. False when first-time setup is needed
    /// (Windows synthetic-user creation, bwrap binary missing, etc.).
    /// Renderer polls this for the Settings → Sandbox status badge; the
    /// strict-mode policy then refuses tool calls when this is false.
    fn is_available(&self) -> bool;

    /// One-time setup. Windows triggers UAC to create the synthetic user
    /// + Firewall rules. macOS / Linux are no-ops (the binaries are
    /// bundled at install time). The mock backend uses this as a test
    /// hook.
    async fn first_time_setup(&self) -> Result<(), SandboxError>;

    /// Diagnostic snapshot for the renderer's Settings → Sandbox tab.
    fn health(&self) -> SandboxHealth;
}

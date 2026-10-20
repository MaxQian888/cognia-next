//! Per-spawn routing into runtime environment sandboxes (ADR-0182/0183).
//!
//! A spawn that carries a [`SandboxPlacement`] runs in the project's own image
//! with the agent bundle injected; one that carries none runs exactly where it
//! always did. [`SandboxRoutingBackend`] makes that choice per spawn, in front
//! of whatever execution path this host already had — the local process
//! manager, the legacy runner containers, or the workspace runtime router.
//!
//! It is only installed when the deployment turned the sandbox pool on. With
//! the pool off there is no router at all, and `spawn_with_events` handles a
//! stray placement itself (see [`crate::exec_backend`]).
//!
//! # Faults and refusals
//!
//! A sandbox that cannot start fails in one of two ways, and the difference
//! is the ADR's fault rule:
//!
//! - **Refused** — the spec was not admitted, the image cannot host the agent,
//!   the command is not in the bundle. Running somewhere else would silently do
//!   less than was asked, so the spawn fails.
//! - **Fault** — the infrastructure is down: the daemon, the bundle, the pool
//!   switch. The run falls back to the existing path with a visible
//!   `sandbox_fallback_*` reason, unless isolation is mandatory (the project
//!   asked for it, or the Host is multi-tenant), in which case it is refused.
//!
//! The router emits where each agent ended up on `external-agent://placement`
//! and repeats it in `get_info`, so the UI can say what actually ran.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::exec_backend::ExecBackend;
use crate::process::{ExternalAgentEventSink, ExternalAgentProcessState, ExternalAgentSpawnConfig};

/// Where a spawn asks to run. Tagged so the Kubernetes pool (ADR-0184) can add
/// a lease-backed variant without changing this one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum SandboxPlacement {
    /// One container per agent, built from a spec the brain resolved (Step ①).
    #[serde(rename_all = "camelCase")]
    Container {
        /// The sealed `EnvironmentSpec`. The Host re-admits it; nothing in it
        /// is trusted because the brain sent it.
        spec: Value,
        /// The brain's half of the fault rule: the project set
        /// `requireSandbox` or named a minimum tier. The Host adds its own
        /// half (a multi-tenant baseline), and either one refuses a fallback.
        /// A client can only make its own run stricter with this.
        isolation_mandatory: bool,
        /// Opaque, live Host-side tool leases; never part of the sealed spec.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        hosted_tool_host_lease_ids: Vec<String>,
        /// Which member of the Host's provider set runs this sandbox
        /// (ADR-0221). Absent: the Host's local driver, exactly as before
        /// providers existed. A Host that predates providers rejects the
        /// field (`deny_unknown_fields`), so a remote request can never run
        /// locally by accident.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider: Option<String>,
        /// Where a remote sandbox gets its workspace (ADR-0221). A local
        /// driver mounts the Host's checkout and refuses this field; a remote
        /// provider requires it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        workspace: Option<RemoteWorkspaceSource>,
    },
}

/// The repository a remote sandbox clones and pushes its branch back to
/// (ADR-0221). The sandbox never sees `credential`: the Host's git proxy adds
/// it to upstream requests, and only for this one repository.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteWorkspaceSource {
    /// `https://` clone URL of the upstream repository, credential-free.
    pub remote_url: String,
    /// The ref the workspace starts from (a branch or tag name).
    pub base_ref: String,
    /// The only branch the sandbox may push (`refs/heads/<branch>`).
    pub branch: String,
    /// Upstream credential (a token), resolved by the dispatching client.
    /// Never serialized back out, never in audit lines or events.
    #[serde(default, skip_serializing)]
    pub credential: Option<String>,
}

impl std::fmt::Debug for RemoteWorkspaceSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RemoteWorkspaceSource")
            .field("remote_url", &self.remote_url)
            .field("base_ref", &self.base_ref)
            .field("branch", &self.branch)
            .field("credential", &self.credential.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

/// `[a-z0-9][a-z0-9-]{0,31}`: what a provider id may look like.
pub fn is_provider_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 32
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

/// The provider id a placement without one means.
pub const LOCAL_PROVIDER_ID: &str = "local";

impl SandboxPlacement {
    pub fn hosted_tool_host_lease_ids(&self) -> &[String] {
        match self {
            Self::Container {
                hosted_tool_host_lease_ids,
                ..
            } => hosted_tool_host_lease_ids,
        }
    }

    /// The provider this placement names, or [`LOCAL_PROVIDER_ID`].
    pub fn provider(&self) -> &str {
        match self {
            Self::Container { provider, .. } => {
                provider.as_deref().unwrap_or(LOCAL_PROVIDER_ID)
            }
        }
    }

    /// The remote workspace source, when the placement carries one.
    pub fn workspace(&self) -> Option<&RemoteWorkspaceSource> {
        match self {
            Self::Container { workspace, .. } => workspace.as_ref(),
        }
    }
    pub fn spec(&self) -> &Value {
        match self {
            Self::Container { spec, .. } => spec,
        }
    }

    pub fn isolation_mandatory(&self) -> bool {
        match self {
            Self::Container {
                isolation_mandatory,
                ..
            } => *isolation_mandatory,
        }
    }

    /// The digest the spec claims, for audit lines. Admission recomputes it.
    pub fn claimed_spec_digest(&self) -> Option<&str> {
        self.spec().get("specDigest").and_then(Value::as_str)
    }

    /// What the spawn audit line records about this request (ADR-0182).
    ///
    /// The line is written before admission, so every value is the client's
    /// claim: the log says what was asked for, and `external-agent://placement`
    /// says what ran. A value is kept only in the shape a valid spec has, so
    /// the audit log cannot be used to store arbitrary text; anything else is
    /// `null`.
    pub fn audit_fields(&self) -> Value {
        let spec = self.spec();
        let claimed = |pointer: &str, valid: fn(&str) -> bool| {
            spec.pointer(pointer)
                .and_then(Value::as_str)
                .filter(|value| valid(value))
        };
        let mut fields = json!({
            "kind": "container",
            "spec_digest": claimed("/specDigest", is_spec_digest),
            "project_id": claimed("/projectId", is_spec_id),
            "image_digest": claimed("/image/digest", is_image_digest),
            "catalog_entry_id": claimed("/image/catalogEntryId", is_catalog_id),
            "isolation_mandatory": self.isolation_mandatory(),
        });
        // Only a placement that names a provider or a remote workspace adds
        // these, so a local placement's audit line keeps its exact shape.
        let Self::Container {
            provider,
            workspace,
            ..
        } = self;
        if let Some(provider) = provider {
            fields["provider"] = json!(Some(provider.as_str()).filter(|id| is_provider_id(id)));
        }
        if let Some(workspace) = workspace {
            fields["workspace_branch"] =
                json!(Some(workspace.branch.as_str()).filter(|branch| is_spec_id(branch)));
        }
        fields
    }
}

// The four rules below mirror `cognia-environment`'s spec validation, which
// this crate cannot depend on (it sits below the environment crate).

/// `validate_hex64`: 64 lowercase hex digits.
fn is_spec_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `image::validate_digest`: `sha256:` and 64 hex digits of either case.
fn is_image_digest(value: &str) -> bool {
    value
        .strip_prefix("sha256:")
        .is_some_and(|hex| hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// `validate_id`: 1–256 bytes, not blank, no control characters.
fn is_spec_id(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
}

/// `is_valid_catalog_id`: `[a-z0-9][a-z0-9._-]{0,63}`.
fn is_catalog_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes.iter().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-')
        })
}

/// Whether a failed sandbox start may fall back. See the module docs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SandboxErrorKind {
    Refused,
    Fault,
}

/// Why a sandbox did not start. `code` is stable and localized by the UI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SandboxSpawnError {
    pub kind: SandboxErrorKind,
    pub code: String,
    pub message: String,
}

impl SandboxSpawnError {
    pub fn refused(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            kind: SandboxErrorKind::Refused,
            code: code.into(),
            message: message.into(),
        }
    }

    pub fn fault(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            kind: SandboxErrorKind::Fault,
            code: code.into(),
            message: message.into(),
        }
    }

    /// The reason shown when this fault falls back: `sandbox_driver_unavailable`
    /// becomes `sandbox_fallback_driver_unavailable`, `bundle_unavailable`
    /// becomes `sandbox_fallback_bundle_unavailable` — the codes the brain's
    /// resolver already uses for the faults it can see itself.
    pub fn fallback_code(&self) -> String {
        format!(
            "sandbox_fallback_{}",
            self.code.strip_prefix("sandbox_").unwrap_or(&self.code)
        )
    }
}

impl std::fmt::Display for SandboxSpawnError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

/// The `external-agent://placement` payload for an agent that fell back.
pub fn fallback_placement(code: &str, message: &str) -> Value {
    json!({ "kind": "fallback", "code": code, "message": message })
}

/// An execution backend that can start agents in sandboxes. The Docker driver
/// (`cognia-sandbox-pool`) is the one implementation in Step ①.
#[async_trait]
pub trait SandboxExecBackend: ExecBackend {
    /// Start `config` (which carries a placement) in a sandbox. Emits the
    /// placement on the sink before returning.
    async fn spawn_sandboxed(
        &self,
        config: ExternalAgentSpawnConfig,
        sink: Arc<dyn ExternalAgentEventSink>,
    ) -> Result<String, SandboxSpawnError>;

    /// This Host forces sandboxes (a multi-tenant baseline): a spawn without
    /// a placement is refused and a fault never falls back.
    fn multi_tenant(&self) -> bool;

    /// The environment-owning driver applies the shared fault_disposition
    /// policy. Keeping that call behind this existing boundary avoids adding
    /// cognia-environment (and its network/store stack) to this leaf crate.
    /// `isolation_mandatory` is the brain's folded requireSandbox/minimum rule.
    fn fault_allows_fallback(&self, isolation_mandatory: bool) -> bool;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Owner {
    Existing,
    Sandbox,
}

/// How a Host whose existing path confines what it runs re-confines a spawn
/// that falls back onto it. The desktop rewrites a launch into its OS
/// sandbox launcher before it reaches the process table; a placement spawn
/// skips that (the container is the stronger confinement), so a fallback
/// has to be wrapped here, after the sandbox refused it, or it would run
/// unconfined.
pub type FallbackConfinement =
    Arc<dyn Fn(ExternalAgentSpawnConfig) -> Result<ExternalAgentSpawnConfig, String> + Send + Sync>;

/// Routes each spawn to a sandbox or to the host's existing path.
pub struct SandboxRoutingBackend {
    existing: Arc<dyn ExecBackend>,
    sandbox: Arc<dyn SandboxExecBackend>,
    confine_fallback: Option<FallbackConfinement>,
    owners: Mutex<HashMap<String, Owner>>,
    pending: Arc<Mutex<HashMap<String, tokio::sync::watch::Sender<bool>>>>,
}

struct RoutingReservation {
    id: String,
    pending: Arc<Mutex<HashMap<String, tokio::sync::watch::Sender<bool>>>>,
    armed: bool,
}

impl Drop for RoutingReservation {
    fn drop(&mut self) {
        if self.armed {
            self.pending.lock().remove(&self.id);
        }
    }
}

impl SandboxRoutingBackend {
    pub fn new(existing: Arc<dyn ExecBackend>, sandbox: Arc<dyn SandboxExecBackend>) -> Arc<Self> {
        Self::with_fallback_confinement(existing, sandbox, None)
    }

    /// A router whose fallbacks pass through `confine` before they reach the
    /// existing path (see [`FallbackConfinement`]). A confinement that fails
    /// fails the spawn: running unconfined is not a fallback.
    pub fn with_fallback_confinement(
        existing: Arc<dyn ExecBackend>,
        sandbox: Arc<dyn SandboxExecBackend>,
        confine_fallback: Option<FallbackConfinement>,
    ) -> Arc<Self> {
        Arc::new(Self {
            existing,
            sandbox,
            confine_fallback,
            owners: Mutex::new(HashMap::new()),
            pending: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    fn backend(&self, owner: Owner) -> Arc<dyn ExecBackend> {
        match owner {
            Owner::Existing => Arc::clone(&self.existing),
            Owner::Sandbox => self.sandbox.clone(),
        }
    }

    async fn owner(&self, id: &str) -> Result<Arc<dyn ExecBackend>, String> {
        let owner = self.owners.lock().get(id).copied();
        if let Some(owner) = owner {
            return Ok(self.backend(owner));
        }
        // Cancelled child creation can retain a registry entry without ever
        // returning success to publish an owner here. Keep status and cleanup
        // reachable for that entry, without guessing if both sides claim it.
        let existing = self.existing.status(id).await.is_some();
        let sandbox = self.sandbox.status(id).await.is_some();
        match (existing, sandbox) {
            (true, false) => Ok(self.backend(Owner::Existing)),
            (false, true) => Ok(self.backend(Owner::Sandbox)),
            (true, true) => Err(format!("Agent {id} has conflicting backend owners")),
            (false, false) => Err(format!("Agent {id} not found")),
        }
    }

    /// Refuse an id that is still running on either side. An owner entry
    /// whose agent has exited is stale, not a conflict: each backend forgets
    /// an agent when it exits, and this map only learns that on the next use.
    async fn ensure_free(&self, id: &str) -> Result<(), String> {
        // A cancelled child can retain its id while daemon cleanup finishes
        // before a successful spawn ever publishes an owner in this router.
        // Both registries are authoritative; the routing cache alone is not.
        if self.existing.status(id).await.is_some() || self.sandbox.status(id).await.is_some() {
            return Err(format!("Agent {id} already exists"));
        }
        self.owners.lock().remove(id);
        Ok(())
    }
}

#[async_trait]
impl ExecBackend for SandboxRoutingBackend {
    async fn delete_retained_gateway_task(
        &self,
        task_id: &str,
        device: Option<&str>,
    ) -> Result<(), String> {
        self.sandbox
            .delete_retained_gateway_task(task_id, device)
            .await?;
        self.existing
            .delete_retained_gateway_task(task_id, device)
            .await
    }
    async fn spawn(
        &self,
        config: ExternalAgentSpawnConfig,
        sink: Arc<dyn ExternalAgentEventSink>,
    ) -> Result<String, String> {
        let id = config.id.clone();
        let mut cancellation = {
            let mut pending = self.pending.lock();
            if pending.contains_key(&id) {
                return Err(format!("Agent {id} already exists"));
            }
            let (sender, receiver) = tokio::sync::watch::channel(false);
            pending.insert(id.clone(), sender);
            receiver
        };
        let mut reservation = RoutingReservation {
            id: id.clone(),
            pending: Arc::clone(&self.pending),
            armed: true,
        };
        let result = tokio::select! {
            biased;
            _ = cancellation.wait_for(|cancelled| *cancelled) => Err(format!("Agent {id} creation cancelled")),
            result = self.spawn_routed(config, sink) => result,
        };
        if result.is_ok() {
            // Publish the owner and finish cancellation admission atomically.
            // A kill before this point cancels creation; one after it reaches
            // the adopted runner through the owner map.
            let cancelled = {
                let mut pending = self.pending.lock();
                let cancelled = *cancellation.borrow();
                if !cancelled {
                    pending.remove(&id);
                    reservation.armed = false;
                }
                cancelled
            };
            if cancelled {
                let owner = self.owner(&id).await?;
                let cleanup_id = id.clone();
                tokio::spawn(async move {
                    let _reservation = reservation;
                    if let Err(error) = owner.kill(&cleanup_id).await {
                        log::warn!("cancelled routed runner {cleanup_id} kill failed: {error}");
                    }
                });
                return Err(format!("Agent {id} creation cancelled"));
            }
        }
        result
    }

    async fn send(&self, id: &str, message: &str) -> Result<(), String> {
        self.owner(id).await?.send(id, message).await
    }

    async fn kill(&self, id: &str) -> Result<(), String> {
        let cancelled_pending = {
            let pending = self.pending.lock();
            if let Some(cancelled) = pending.get(id) {
                cancelled.send_replace(true);
                true
            } else {
                false
            }
        };
        // An attempted duplicate may be awaiting the existing owner's status.
        // Cancelling that attempt must not consume a kill of the live agent.
        if let Ok(owner) = self.owner(id).await {
            if owner.status(id).await.is_some() {
                return owner.kill(id).await;
            }
        }
        if cancelled_pending {
            return Ok(());
        }
        self.owner(id).await?.kill(id).await
    }

    async fn kill_all(&self) -> Result<(), String> {
        for cancelled in self.pending.lock().values() {
            cancelled.send_replace(true);
        }
        let existing = self.existing.kill_all().await;
        let sandbox = self.sandbox.kill_all().await;
        match (existing, sandbox) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(error), Ok(())) | (Ok(()), Err(error)) => Err(error),
            (Err(first), Err(second)) => Err(format!("{first}; {second}")),
        }
    }

    async fn status(&self, id: &str) -> Option<ExternalAgentProcessState> {
        if let Some(cancelled) = self.pending.lock().get(id) {
            return Some(if *cancelled.borrow() {
                ExternalAgentProcessState::Stopping
            } else {
                ExternalAgentProcessState::Starting
            });
        }
        self.owner(id).await.ok()?.status(id).await
    }

    async fn list(&self) -> Vec<String> {
        let mut ids = self.existing.list().await;
        ids.extend(self.sandbox.list().await);
        ids.extend(self.pending.lock().keys().cloned());
        ids.sort();
        ids.dedup();
        ids
    }

    async fn is_running(&self, id: &str) -> Result<bool, String> {
        if self.pending.lock().contains_key(id) {
            return Ok(false);
        }
        self.owner(id).await?.is_running(id).await
    }

    async fn get_info(&self, id: &str) -> Result<Value, String> {
        self.owner(id).await?.get_info(id).await
    }

    async fn set_running(&self, id: &str) -> Result<(), String> {
        self.owner(id).await?.set_running(id).await
    }

    async fn set_failed(&self, id: &str) -> Result<(), String> {
        self.owner(id).await?.set_failed(id).await
    }

    fn kind(&self) -> &'static str {
        self.existing.kind()
    }

    fn routes_sandboxes(&self) -> bool {
        true
    }

    async fn reap_orphans(&self) -> Result<Vec<String>, String> {
        let existing = self.existing.reap_orphans().await;
        let sandbox = self.sandbox.reap_orphans().await;
        match (existing, sandbox) {
            (Ok(mut reaped), Ok(more)) => {
                reaped.extend(more);
                reaped.sort();
                reaped.dedup();
                Ok(reaped)
            }
            (Ok(reaped), Err(error)) | (Err(error), Ok(reaped)) => {
                log::warn!("orphan sweep incomplete: {error}");
                Ok(reaped)
            }
            (Err(first), Err(second)) => Err(format!("{first}; {second}")),
        }
    }
}

impl SandboxRoutingBackend {
    /// Local-only payloads (a managed gateway task, an isolated Devin MCP
    /// configuration) reach their agent either through a sandbox bridge or as
    /// a local process. A fault on a Host whose existing path is anything
    /// else cannot fall back without handing the payload to a path that
    /// cannot honour it, so such a spawn fails with the fault instead.
    fn fallback_can_carry(&self, config: &ExternalAgentSpawnConfig) -> bool {
        let local_only = config.env.contains_key(crate::gateway_task::PAYLOAD_ENV)
            || config
                .env
                .contains_key(crate::devin_mcp_config::PAYLOAD_ENV);
        !local_only || self.existing.kind() == "local-process"
    }

    async fn spawn_routed(
        &self,
        config: ExternalAgentSpawnConfig,
        sink: Arc<dyn ExternalAgentEventSink>,
    ) -> Result<String, String> {
        let id = config.id.clone();
        self.ensure_free(&id).await?;

        let Some(placement) = config.sandbox.clone() else {
            if self.sandbox.multi_tenant() {
                return Err(SandboxSpawnError::refused(
                    "sandbox_placement_required",
                    "this Host runs every agent in a runtime environment sandbox",
                )
                .to_string());
            }
            let spawned = self.existing.spawn(config, sink).await?;
            self.owners.lock().insert(spawned.clone(), Owner::Existing);
            return Ok(spawned);
        };

        // A private state root names a path on this Host, which no sandbox
        // can reach; the key stays on `config` for a fallback that runs here.
        let mut boxed = config.clone();
        crate::state_isolation::strip_state_key(&mut boxed);
        match self.sandbox.spawn_sandboxed(boxed, Arc::clone(&sink)).await {
            Ok(spawned) => {
                self.owners.lock().insert(spawned.clone(), Owner::Sandbox);
                Ok(spawned)
            }
            Err(error)
                if error.kind == SandboxErrorKind::Fault
                    // The brain folded requireSandbox and any explicit minimum
                    // into isolation_mandatory. Placement no longer retains
                    // their separate origins; preserve that combined decision.
                    && self.sandbox.fault_allows_fallback(placement.isolation_mandatory())
                    && self.fallback_can_carry(&config) =>
            {
                log::warn!("sandbox for agent {id} fell back to the existing path: {error}");
                sink.sandbox_placement(
                    &id,
                    &fallback_placement(&error.fallback_code(), &error.message),
                );
                let mut existing = config;
                existing.sandbox = None;
                if let Some(confine) = self.confine_fallback.as_ref() {
                    existing = confine(existing)?;
                }
                let spawned = self.existing.spawn(existing, sink).await?;
                self.owners.lock().insert(spawned.clone(), Owner::Existing);
                Ok(spawned)
            }
            Err(error) => Err(error.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec_backend::test_support::RecordingAgentEmitter;
    use crate::exec_backend::{EmitterEventSink, PLACEMENT_CHANNEL};

    /// A backend that records what it was asked to spawn.
    #[derive(Default)]
    struct Recording {
        kind: &'static str,
        spawned: Mutex<Vec<ExternalAgentSpawnConfig>>,
        running: Mutex<Vec<String>>,
        sandbox_result: Mutex<Option<SandboxSpawnError>>,
        multi_tenant: bool,
        start_gate: Mutex<Option<Arc<tokio::sync::Semaphore>>>,
        start_entered: tokio::sync::Notify,
        status_gate: Mutex<Option<Arc<tokio::sync::Semaphore>>>,
        status_entered: tokio::sync::Notify,
    }

    impl Recording {
        fn new(kind: &'static str) -> Arc<Self> {
            Arc::new(Self {
                kind,
                ..Default::default()
            })
        }
    }

    #[async_trait]
    impl ExecBackend for Recording {
        async fn spawn(
            &self,
            config: ExternalAgentSpawnConfig,
            _sink: Arc<dyn ExternalAgentEventSink>,
        ) -> Result<String, String> {
            let id = config.id.clone();
            self.spawned.lock().push(config);
            self.running.lock().push(id.clone());
            Ok(id)
        }
        async fn send(&self, _id: &str, _message: &str) -> Result<(), String> {
            Ok(())
        }
        async fn kill(&self, id: &str) -> Result<(), String> {
            self.running.lock().retain(|running| running != id);
            Ok(())
        }
        async fn kill_all(&self) -> Result<(), String> {
            self.running.lock().clear();
            Ok(())
        }
        async fn status(&self, id: &str) -> Option<ExternalAgentProcessState> {
            let gate = self.status_gate.lock().clone();
            if let Some(gate) = gate {
                self.status_entered.notify_one();
                gate.acquire().await.unwrap().forget();
            }
            self.running
                .lock()
                .contains(&id.to_string())
                .then_some(ExternalAgentProcessState::Running)
        }
        async fn list(&self) -> Vec<String> {
            self.running.lock().clone()
        }
        async fn is_running(&self, id: &str) -> Result<bool, String> {
            Ok(self.status(id).await.is_some())
        }
        async fn get_info(&self, id: &str) -> Result<Value, String> {
            Ok(json!({ "id": id, "kind": self.kind }))
        }
        async fn set_running(&self, _id: &str) -> Result<(), String> {
            Ok(())
        }
        async fn set_failed(&self, _id: &str) -> Result<(), String> {
            Ok(())
        }
        fn kind(&self) -> &'static str {
            self.kind
        }
    }

    #[async_trait]
    impl SandboxExecBackend for Recording {
        async fn spawn_sandboxed(
            &self,
            config: ExternalAgentSpawnConfig,
            sink: Arc<dyn ExternalAgentEventSink>,
        ) -> Result<String, SandboxSpawnError> {
            let gate = self.start_gate.lock().clone();
            if let Some(gate) = gate {
                self.start_entered.notify_one();
                gate.acquire().await.unwrap().forget();
            }
            if let Some(error) = self.sandbox_result.lock().clone() {
                return Err(error);
            }
            let id = config.id.clone();
            sink.sandbox_placement(&id, &json!({ "kind": "sandbox" }));
            self.spawned.lock().push(config);
            self.running.lock().push(id.clone());
            Ok(id)
        }
        fn multi_tenant(&self) -> bool {
            self.multi_tenant
        }
        fn fault_allows_fallback(&self, mandatory: bool) -> bool {
            // Fake driver's answer; production drivers call the shared policy.
            !self.multi_tenant && !mandatory
        }
    }

    fn config(id: &str, placement: Option<SandboxPlacement>) -> ExternalAgentSpawnConfig {
        ExternalAgentSpawnConfig {
            id: id.into(),
            command: "codex-acp".into(),
            args: vec![],
            env: HashMap::from([("OPENAI_API_KEY".into(), "sk-test".into())]),
            cwd: Some("/workspaces/ws-1".into()),
            framing: Default::default(),
            sandbox_policy: Default::default(),
            sandbox: placement,
        }
    }

    fn placement(isolation_mandatory: bool) -> SandboxPlacement {
        SandboxPlacement::Container {
            hosted_tool_host_lease_ids: Vec::new(),
            provider: None,
            workspace: None,
            spec: json!({ "specDigest": "a".repeat(64) }),
            isolation_mandatory,
        }
    }

    fn router(
        sandbox: Arc<Recording>,
    ) -> (
        Arc<Recording>,
        Arc<SandboxRoutingBackend>,
        Arc<RecordingAgentEmitter>,
    ) {
        let existing = Recording::new("local-process");
        let router = SandboxRoutingBackend::new(existing.clone(), sandbox);
        (existing, router, RecordingAgentEmitter::new())
    }

    fn placements(emitter: &RecordingAgentEmitter) -> Vec<Value> {
        emitter
            .events()
            .into_iter()
            .filter(|(channel, _)| channel == PLACEMENT_CHANNEL)
            .map(|(_, payload)| payload)
            .collect()
    }

    #[test]
    fn placements_parse_closed_and_tagged() {
        let parsed: SandboxPlacement = serde_json::from_value(json!({
            "kind": "container",
            "spec": { "specDigest": "b".repeat(64) },
            "isolationMandatory": true
        }))
        .unwrap();
        assert!(parsed.isolation_mandatory());
        assert_eq!(parsed.claimed_spec_digest(), Some("b".repeat(64).as_str()));

        for invalid in [
            json!({ "kind": "container", "spec": {}, "isolationMandatory": false, "extra": 1 }),
            json!({ "kind": "pool", "sandboxId": "s" }),
            json!({ "kind": "container", "spec": {} }),
        ] {
            assert!(
                serde_json::from_value::<SandboxPlacement>(invalid.clone()).is_err(),
                "{invalid}"
            );
        }
    }

    #[test]
    fn audit_fields_record_the_claim_in_the_shape_a_spec_has() {
        let image_digest = format!("sha256:{}", "c".repeat(64));
        let placement = SandboxPlacement::Container {
            hosted_tool_host_lease_ids: Vec::new(),
            provider: None,
            workspace: None,
            spec: json!({
                "specDigest": "b".repeat(64),
                "projectId": "proj-1",
                "image": { "digest": image_digest, "catalogEntryId": "node-22" },
                "containerEnv": { "SECRET": "never logged" },
            }),
            isolation_mandatory: true,
        };
        assert_eq!(
            placement.audit_fields(),
            json!({
                "kind": "container",
                "spec_digest": "b".repeat(64),
                "project_id": "proj-1",
                "image_digest": image_digest,
                "catalog_entry_id": "node-22",
                "isolation_mandatory": true,
            })
        );
    }

    // The line is written before admission, so a malformed claim must not
    // reach the log as free text.
    #[test]
    fn audit_fields_drop_values_no_valid_spec_could_hold() {
        let placement = SandboxPlacement::Container {
            hosted_tool_host_lease_ids: Vec::new(),
            provider: None,
            workspace: None,
            spec: json!({
                "specDigest": "B".repeat(64),
                "projectId": "x".repeat(257),
                "image": { "digest": "sha256:short", "catalogEntryId": "line\nbreak" },
            }),
            isolation_mandatory: false,
        };
        assert_eq!(
            placement.audit_fields(),
            json!({
                "kind": "container",
                "spec_digest": null,
                "project_id": null,
                "image_digest": null,
                "catalog_entry_id": null,
                "isolation_mandatory": false,
            })
        );

        let empty = SandboxPlacement::Container {
            hosted_tool_host_lease_ids: Vec::new(),
            provider: None,
            workspace: None,
            spec: json!({ "projectId": "   ", "image": "not an object" }),
            isolation_mandatory: false,
        };
        let fields = empty.audit_fields();
        assert_eq!(fields["project_id"], Value::Null);
        assert_eq!(fields["image_digest"], Value::Null);

        // A catalog id is a slug, not any id: a valid project id is not one.
        let not_a_slug = SandboxPlacement::Container {
            hosted_tool_host_lease_ids: Vec::new(),
            provider: None,
            workspace: None,
            spec: json!({ "image": { "catalogEntryId": "Node 22" } }),
            isolation_mandatory: false,
        };
        assert_eq!(not_a_slug.audit_fields()["catalog_entry_id"], Value::Null);
    }

    // Each rule accepts exactly what the spec validation accepts, so a spec
    // the Host would admit is never logged with a hole in it.
    #[test]
    fn audit_fields_keep_every_value_a_valid_spec_can_hold() {
        let upper = format!("sha256:{}", "AB".repeat(32));
        let placement = SandboxPlacement::Container {
            hosted_tool_host_lease_ids: Vec::new(),
            provider: None,
            workspace: None,
            spec: json!({
                "projectId": "x".repeat(256),
                "image": { "digest": upper, "catalogEntryId": format!("9{}", "._-".repeat(21)) },
            }),
            isolation_mandatory: false,
        };
        let fields = placement.audit_fields();
        assert_eq!(fields["image_digest"], upper);
        assert_eq!(fields["project_id"], "x".repeat(256));
        assert_eq!(fields["catalog_entry_id"], format!("9{}", "._-".repeat(21)));
        assert!(!is_catalog_id(&"a".repeat(65)));
        assert!(!is_catalog_id("-leading-dash"));
    }

    #[test]
    fn a_config_without_a_placement_serializes_as_it_always_did() {
        let json = serde_json::to_value(config("a", None)).unwrap();
        assert!(json.get("sandbox").is_none());
        let back: ExternalAgentSpawnConfig = serde_json::from_value(json!({
            "id": "a", "command": "codex-acp"
        }))
        .unwrap();
        assert_eq!(back.sandbox, None);
    }

    #[test]
    fn fallback_codes_follow_the_resolver_convention() {
        assert_eq!(
            SandboxSpawnError::fault("sandbox_driver_unavailable", "x").fallback_code(),
            "sandbox_fallback_driver_unavailable"
        );
        assert_eq!(
            SandboxSpawnError::fault("bundle_unavailable", "x").fallback_code(),
            "sandbox_fallback_bundle_unavailable"
        );
        assert_eq!(
            SandboxSpawnError::refused("probe_no_shell", "no /bin/sh").to_string(),
            "probe_no_shell: no /bin/sh"
        );
    }

    #[tokio::test]
    async fn a_spawn_without_a_placement_takes_the_existing_path_untouched() {
        let sandbox = Recording::new("sandbox");
        let (existing, router, emitter) = router(sandbox.clone());
        let sink = EmitterEventSink::new(emitter.clone());
        router.spawn(config("plain", None), sink).await.unwrap();

        assert_eq!(existing.spawned.lock().len(), 1);
        assert_eq!(existing.spawned.lock()[0].env["OPENAI_API_KEY"], "sk-test");
        assert!(sandbox.spawned.lock().is_empty());
        assert!(placements(&emitter).is_empty());
        assert_eq!(router.kind(), "local-process");
        assert!(router.routes_sandboxes());
        assert_eq!(
            router.get_info("plain").await.unwrap()["kind"],
            "local-process"
        );
    }

    #[tokio::test]
    async fn a_placement_runs_in_the_sandbox_and_is_routed_afterwards() {
        let sandbox = Recording::new("sandbox");
        let (existing, router, emitter) = router(sandbox.clone());
        let sink = EmitterEventSink::new(emitter.clone());
        router
            .spawn(config("boxed", Some(placement(false))), sink)
            .await
            .unwrap();
        assert!(existing.spawned.lock().is_empty());
        assert_eq!(placements(&emitter)[0]["placement"]["kind"], "sandbox");
        assert_eq!(router.get_info("boxed").await.unwrap()["kind"], "sandbox");
        router.kill("boxed").await.unwrap();
        assert!(sandbox.running.lock().is_empty());
    }

    /// The desktop's fallback runs under its OS sandbox launcher: the hook
    /// sees the fallback (and only the fallback), and a hook that cannot
    /// confine fails the spawn instead of running it bare.
    #[tokio::test]
    async fn a_fallback_is_confined_before_it_reaches_the_existing_path() {
        let sandbox = Recording::new("sandbox");
        *sandbox.sandbox_result.lock() = Some(SandboxSpawnError::fault(
            "sandbox_provider_unreachable",
            "the provider did not answer",
        ));
        let existing = Recording::new("local-process");
        let confined = Arc::new(Mutex::new(Vec::<String>::new()));
        let seen = confined.clone();
        let router = SandboxRoutingBackend::with_fallback_confinement(
            existing.clone(),
            sandbox.clone(),
            Some(Arc::new(move |mut config: ExternalAgentSpawnConfig| {
                if config.id == "unconfinable" {
                    return Err("the sandbox launcher is unavailable".into());
                }
                seen.lock().push(config.id.clone());
                config.command = "/opt/launcher".into();
                Ok(config)
            })),
        );
        let sink = EmitterEventSink::new(RecordingAgentEmitter::new());

        router.spawn(config("plain", None), sink.clone()).await.unwrap();
        router
            .spawn(config("soft", Some(placement(false))), sink.clone())
            .await
            .unwrap();
        assert_eq!(*confined.lock(), vec!["soft".to_string()]);
        let spawned = existing.spawned.lock().clone();
        assert_ne!(spawned[0].command, "/opt/launcher", "a plain spawn is not re-wrapped");
        assert_eq!(spawned[1].command, "/opt/launcher");

        let error = router
            .spawn(config("unconfinable", Some(placement(false))), sink)
            .await
            .expect_err("an unconfinable fallback does not run");
        assert!(error.contains("launcher is unavailable"), "{error}");
        assert_eq!(existing.spawned.lock().len(), 2);
    }

    /// A private state root is a Host path: the sandbox never sees its key,
    /// and a fallback onto this Host still carries it.
    #[tokio::test]
    async fn the_state_key_reaches_a_fallback_but_never_a_sandbox() {
        let key = crate::state_isolation::AGENT_STATE_KEY_ENV;
        let sandbox = Recording::new("sandbox");
        let (existing, router, emitter) = router(sandbox.clone());
        let sink = EmitterEventSink::new(emitter);
        let mut boxed = config("boxed", Some(placement(false)));
        boxed.env.insert(key.into(), "work".into());
        router.spawn(boxed, sink.clone()).await.unwrap();
        assert!(!sandbox.spawned.lock()[0].env.contains_key(key));

        *sandbox.sandbox_result.lock() = Some(SandboxSpawnError::fault(
            "sandbox_driver_unavailable",
            "docker info failed",
        ));
        let mut soft = config("soft", Some(placement(false)));
        soft.env.insert(key.into(), "work".into());
        router.spawn(soft, sink).await.unwrap();
        assert_eq!(existing.spawned.lock()[0].env[key], "work");
    }

    #[tokio::test]
    async fn a_fault_falls_back_with_a_reason_unless_isolation_is_mandatory() {
        let sandbox = Recording::new("sandbox");
        *sandbox.sandbox_result.lock() = Some(SandboxSpawnError::fault(
            "sandbox_driver_unavailable",
            "docker info failed",
        ));
        let (existing, router, emitter) = router(sandbox.clone());
        let sink = EmitterEventSink::new(emitter.clone());

        router
            .spawn(config("soft", Some(placement(false))), sink.clone())
            .await
            .unwrap();
        let fell_back = existing.spawned.lock()[0].clone();
        assert_eq!(
            fell_back.sandbox, None,
            "the existing path never sees a placement"
        );
        assert_eq!(
            placements(&emitter)[0]["placement"],
            json!({
                "kind": "fallback",
                "code": "sandbox_fallback_driver_unavailable",
                "message": "docker info failed"
            })
        );

        let refused = router
            .spawn(config("hard", Some(placement(true))), sink)
            .await
            .unwrap_err();
        assert_eq!(refused, "sandbox_driver_unavailable: docker info failed");
        assert_eq!(existing.spawned.lock().len(), 1);
    }

    #[tokio::test]
    async fn a_refusal_never_falls_back() {
        let sandbox = Recording::new("sandbox");
        *sandbox.sandbox_result.lock() = Some(SandboxSpawnError::refused(
            "probe_glibc_too_old",
            "glibc 2.17 is older than the required 2.28",
        ));
        let (existing, router, emitter) = router(sandbox);
        let error = router
            .spawn(
                config("old", Some(placement(false))),
                EmitterEventSink::new(emitter.clone()),
            )
            .await
            .unwrap_err();
        assert!(error.starts_with("probe_glibc_too_old: "), "{error}");
        assert!(existing.spawned.lock().is_empty());
        assert!(placements(&emitter).is_empty());
    }

    #[tokio::test]
    async fn egress_unenforceable_refusal_never_falls_back_with_optional_isolation() {
        let sandbox = Recording::new("sandbox");
        *sandbox.sandbox_result.lock() = Some(SandboxSpawnError::refused(
            "sandbox_egress_unenforceable",
            "bundle egress protocol or proxy handshake failed",
        ));
        let (existing, router, emitter) = router(sandbox.clone());
        let error = router
            .spawn(
                config("allowlist", Some(placement(false))),
                EmitterEventSink::new(emitter.clone()),
            )
            .await
            .unwrap_err();
        assert_eq!(
            error,
            "sandbox_egress_unenforceable: bundle egress protocol or proxy handshake failed"
        );
        assert!(existing.spawned.lock().is_empty());
        assert!(sandbox.spawned.lock().is_empty());
        assert!(placements(&emitter).is_empty());
        assert!(router.list().await.is_empty());
    }

    #[tokio::test]
    async fn a_multi_tenant_host_requires_a_placement_and_never_falls_back() {
        let sandbox = Arc::new(Recording {
            kind: "sandbox",
            multi_tenant: true,
            ..Default::default()
        });
        *sandbox.sandbox_result.lock() = Some(SandboxSpawnError::fault(
            "sandbox_driver_unavailable",
            "down",
        ));
        let (existing, router, emitter) = router(sandbox);
        let sink = EmitterEventSink::new(emitter);

        let unplaced = router
            .spawn(config("a", None), sink.clone())
            .await
            .unwrap_err();
        assert!(
            unplaced.starts_with("sandbox_placement_required: "),
            "{unplaced}"
        );
        let faulted = router
            .spawn(config("b", Some(placement(false))), sink)
            .await
            .unwrap_err();
        assert!(
            faulted.starts_with("sandbox_driver_unavailable: "),
            "{faulted}"
        );
        assert!(existing.spawned.lock().is_empty());
    }

    #[tokio::test]
    async fn a_pending_sandbox_blocks_the_same_id_on_the_other_backend_and_cancels() {
        let sandbox = Recording::new("sandbox");
        *sandbox.start_gate.lock() = Some(Arc::new(tokio::sync::Semaphore::new(0)));
        let (existing, router, emitter) = router(sandbox.clone());
        let first = tokio::spawn({
            let router = router.clone();
            let emitter = emitter.clone();
            async move {
                router
                    .spawn(
                        config("pending", Some(placement(false))),
                        EmitterEventSink::new(emitter),
                    )
                    .await
            }
        });
        sandbox.start_entered.notified().await;
        assert_eq!(
            router.status("pending").await,
            Some(ExternalAgentProcessState::Starting)
        );
        assert_eq!(router.is_running("pending").await, Ok(false));
        assert_eq!(router.list().await, vec!["pending".to_string()]);
        let duplicate = router
            .spawn(
                config("pending", None),
                EmitterEventSink::new(emitter.clone()),
            )
            .await
            .unwrap_err();
        assert!(duplicate.contains("already exists"));
        assert!(existing.spawned.lock().is_empty());
        router.kill_all().await.unwrap();
        assert!(first.await.unwrap().unwrap_err().contains("cancelled"));
        assert!(router.list().await.is_empty());
        router
            .spawn(config("pending", None), EmitterEventSink::new(emitter))
            .await
            .unwrap();
        router.kill_all().await.unwrap();
    }

    #[tokio::test]
    async fn aborting_a_routed_creation_releases_the_id() {
        let sandbox = Recording::new("sandbox");
        *sandbox.start_gate.lock() = Some(Arc::new(tokio::sync::Semaphore::new(0)));
        let (_, router, emitter) = router(sandbox.clone());
        let first = tokio::spawn({
            let router = router.clone();
            let emitter = emitter.clone();
            async move {
                router
                    .spawn(
                        config("pending", Some(placement(false))),
                        EmitterEventSink::new(emitter),
                    )
                    .await
            }
        });
        sandbox.start_entered.notified().await;
        first.abort();
        assert!(first.await.unwrap_err().is_cancelled());
        router
            .spawn(config("pending", None), EmitterEventSink::new(emitter))
            .await
            .unwrap();
        router.kill_all().await.unwrap();
    }

    #[tokio::test]
    async fn a_cancelled_child_still_cleaning_up_blocks_reuse_on_the_other_backend() {
        let sandbox = Recording::new("sandbox");
        let (existing, router, emitter) = router(sandbox.clone());
        // A cancelled spawn has returned before its owned daemon worker
        // finishes. No routed owner was published, but the child still owns
        // the id until its resource cleanup completes.
        sandbox.running.lock().push("cleanup".into());
        assert_eq!(
            router.status("cleanup").await,
            Some(ExternalAgentProcessState::Running)
        );
        assert_eq!(router.get_info("cleanup").await.unwrap()["kind"], "sandbox");
        let result = router
            .spawn(
                config("cleanup", None),
                EmitterEventSink::new(emitter.clone()),
            )
            .await;
        assert!(result.unwrap_err().contains("already exists"));
        assert!(existing.spawned.lock().is_empty());
        router.kill("cleanup").await.unwrap();
        assert!(sandbox.running.lock().is_empty());
        assert_eq!(router.status("cleanup").await, None);
        router
            .spawn(config("cleanup", None), EmitterEventSink::new(emitter))
            .await
            .unwrap();
        assert_eq!(existing.spawned.lock().len(), 1);
        router.kill_all().await.unwrap();
    }

    #[tokio::test]
    async fn conflicting_unpublished_child_owners_are_not_guessed() {
        let sandbox = Recording::new("sandbox");
        let (existing, router, _) = router(sandbox.clone());
        existing.running.lock().push("conflict".into());
        sandbox.running.lock().push("conflict".into());
        assert!(router
            .get_info("conflict")
            .await
            .unwrap_err()
            .contains("conflicting backend owners"));
        assert!(router
            .kill("conflict")
            .await
            .unwrap_err()
            .contains("conflicting backend owners"));
        assert_eq!(existing.running.lock().len(), 1);
        assert_eq!(sandbox.running.lock().len(), 1);
    }

    #[tokio::test]
    async fn a_duplicate_pending_owner_check_does_not_consume_the_live_agents_kill() {
        let sandbox = Recording::new("sandbox");
        let (existing, router, emitter) = router(sandbox);
        router
            .spawn(config("live", None), EmitterEventSink::new(emitter.clone()))
            .await
            .unwrap();
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        *existing.status_gate.lock() = Some(gate.clone());
        let duplicate = tokio::spawn({
            let router = router.clone();
            async move {
                router
                    .spawn(config("live", None), EmitterEventSink::new(emitter))
                    .await
            }
        });
        existing.status_entered.notified().await;
        let kill = tokio::spawn({
            let router = router.clone();
            async move { router.kill("live").await }
        });
        existing.status_entered.notified().await;
        gate.add_permits(2);
        kill.await.unwrap().unwrap();
        assert!(duplicate.await.unwrap().is_err());
        assert!(existing.running.lock().is_empty());
    }

    #[tokio::test]
    async fn an_id_is_refused_while_running_and_free_again_after_it_exits() {
        let sandbox = Recording::new("sandbox");
        let (existing, router, emitter) = router(sandbox.clone());
        let sink = EmitterEventSink::new(emitter);
        router
            .spawn(config("same", Some(placement(false))), sink.clone())
            .await
            .unwrap();
        let duplicate = router
            .spawn(config("same", None), sink.clone())
            .await
            .unwrap_err();
        assert!(duplicate.contains("already exists"), "{duplicate}");

        // The sandboxed agent exits; its id is reusable on the other path.
        sandbox.running.lock().clear();
        router.spawn(config("same", None), sink).await.unwrap();
        assert_eq!(existing.spawned.lock().len(), 1);
        assert_eq!(router.list().await, vec!["same".to_string()]);
    }

    #[test]
    fn a_placement_names_its_provider_and_remote_workspace() {
        let parsed: SandboxPlacement = serde_json::from_value(json!({
            "kind": "container",
            "spec": { "specDigest": "b".repeat(64) },
            "isolationMandatory": false,
            "provider": "e2b",
            "workspace": {
                "remoteUrl": "https://github.com/acme/app.git",
                "baseRef": "main",
                "branch": "cognia/task-1",
                "credential": "ghs_secret"
            }
        }))
        .unwrap();
        assert_eq!(parsed.provider(), "e2b");
        let workspace = parsed.workspace().expect("a remote workspace");
        assert_eq!(workspace.branch, "cognia/task-1");
        assert_eq!(workspace.credential.as_deref(), Some("ghs_secret"));

        // The credential never leaves again: not serialized, not in Debug,
        // not in the audit line.
        let echoed = serde_json::to_value(&parsed).unwrap();
        assert!(echoed["workspace"].get("credential").is_none());
        assert!(!format!("{parsed:?}").contains("ghs_secret"));
        let audit = parsed.audit_fields();
        assert_eq!(audit["provider"], "e2b");
        assert_eq!(audit["workspace_branch"], "cognia/task-1");
        assert!(!audit.to_string().contains("ghs_secret"));

        // No provider means the Host's local driver, exactly as before.
        assert_eq!(placement(false).provider(), LOCAL_PROVIDER_ID);
        assert!(placement(false).workspace().is_none());
        assert!(serde_json::to_value(placement(false))
            .unwrap()
            .get("provider")
            .is_none());

        // The workspace source is closed like the placement around it.
        assert!(serde_json::from_value::<SandboxPlacement>(json!({
            "kind": "container",
            "spec": {},
            "isolationMandatory": false,
            "workspace": { "remoteUrl": "u", "baseRef": "b", "branch": "c", "path": "/x" }
        }))
        .is_err());
    }

    #[test]
    fn provider_ids_are_short_lowercase_slugs() {
        for valid in ["local", "e2b", "k8s-prod", "0"] {
            assert!(is_provider_id(valid), "{valid}");
        }
        for invalid in ["", "E2B", "-k8s", "k8s_prod", "a/b", &"x".repeat(33)] {
            assert!(!is_provider_id(invalid), "{invalid}");
        }
        let forged = SandboxPlacement::Container {
            hosted_tool_host_lease_ids: Vec::new(),
            provider: Some("Not A Slug".into()),
            workspace: None,
            spec: json!({}),
            isolation_mandatory: false,
        };
        assert_eq!(forged.audit_fields()["provider"], Value::Null);
    }

    /// A managed gateway task reaches a sandbox through the driver's bridge,
    /// so a routed placement carries it (ADR-0221).
    #[tokio::test]
    async fn a_routed_placement_carries_a_managed_gateway_task() {
        let sandbox = Recording::new("sandbox");
        let (_, router, emitter) = router(sandbox.clone());
        let mut placed = config("gateway", Some(placement(true)));
        placed
            .env
            .insert(crate::gateway_task::PAYLOAD_ENV.into(), "{}".into());
        crate::exec_backend::spawn_with_events(router.as_ref(), emitter, placed)
            .await
            .unwrap();
        assert_eq!(sandbox.spawned.lock().len(), 1);
    }

    /// A fault may not hand a local-only payload to a path that is not a
    /// local process: the spawn fails with the fault instead of falling back.
    #[tokio::test]
    async fn a_local_only_payload_never_falls_back_onto_a_non_local_path() {
        let sandbox = Recording::new("sandbox");
        *sandbox.sandbox_result.lock() = Some(SandboxSpawnError::fault(
            "sandbox_provider_unreachable",
            "the provider did not answer",
        ));
        let existing = Recording::new("container");
        let router = SandboxRoutingBackend::new(existing.clone(), sandbox);
        let sink = EmitterEventSink::new(RecordingAgentEmitter::new());
        for payload in [
            crate::gateway_task::PAYLOAD_ENV,
            crate::devin_mcp_config::PAYLOAD_ENV,
        ] {
            let mut placed = config(payload, Some(placement(false)));
            placed.env.insert(payload.into(), "{}".into());
            let error = router.spawn(placed, sink.clone()).await.unwrap_err();
            assert!(
                error.starts_with("sandbox_provider_unreachable:"),
                "{payload}: {error}"
            );
        }
        assert!(existing.spawned.lock().is_empty());

        // Without such a payload the same fault falls back as before.
        router
            .spawn(config("plain", Some(placement(false))), sink)
            .await
            .unwrap();
        assert_eq!(existing.spawned.lock().len(), 1);
    }
}

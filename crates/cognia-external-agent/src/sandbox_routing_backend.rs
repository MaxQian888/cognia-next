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
    },
}

impl SandboxPlacement {
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
        json!({
            "kind": "container",
            "spec_digest": claimed("/specDigest", is_spec_digest),
            "project_id": claimed("/projectId", is_spec_id),
            "image_digest": claimed("/image/digest", is_image_digest),
            "catalog_entry_id": claimed("/image/catalogEntryId", is_catalog_id),
            "isolation_mandatory": self.isolation_mandatory(),
        })
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
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Owner {
    Existing,
    Sandbox,
}

/// Routes each spawn to a sandbox or to the host's existing path.
pub struct SandboxRoutingBackend {
    existing: Arc<dyn ExecBackend>,
    sandbox: Arc<dyn SandboxExecBackend>,
    owners: Mutex<HashMap<String, Owner>>,
}

impl SandboxRoutingBackend {
    pub fn new(existing: Arc<dyn ExecBackend>, sandbox: Arc<dyn SandboxExecBackend>) -> Arc<Self> {
        Arc::new(Self {
            existing,
            sandbox,
            owners: Mutex::new(HashMap::new()),
        })
    }

    fn backend(&self, owner: Owner) -> Arc<dyn ExecBackend> {
        match owner {
            Owner::Existing => Arc::clone(&self.existing),
            Owner::Sandbox => self.sandbox.clone(),
        }
    }

    fn owner(&self, id: &str) -> Result<Arc<dyn ExecBackend>, String> {
        let owner = self
            .owners
            .lock()
            .get(id)
            .copied()
            .ok_or_else(|| format!("Agent {id} not found"))?;
        Ok(self.backend(owner))
    }

    /// Refuse an id that is still running on either side. An owner entry
    /// whose agent has exited is stale, not a conflict: each backend forgets
    /// an agent when it exits, and this map only learns that on the next use.
    async fn ensure_free(&self, id: &str) -> Result<(), String> {
        let owner = self.owners.lock().get(id).copied();
        if let Some(owner) = owner {
            if self.backend(owner).status(id).await.is_some() {
                return Err(format!("Agent {id} already exists"));
            }
            self.owners.lock().remove(id);
        }
        Ok(())
    }
}

#[async_trait]
impl ExecBackend for SandboxRoutingBackend {
    async fn spawn(
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

        match self
            .sandbox
            .spawn_sandboxed(config.clone(), Arc::clone(&sink))
            .await
        {
            Ok(spawned) => {
                self.owners.lock().insert(spawned.clone(), Owner::Sandbox);
                Ok(spawned)
            }
            Err(error)
                if error.kind == SandboxErrorKind::Fault
                    && !placement.isolation_mandatory()
                    && !self.sandbox.multi_tenant() =>
            {
                log::warn!("sandbox for agent {id} fell back to the existing path: {error}");
                sink.sandbox_placement(
                    &id,
                    &fallback_placement(&error.fallback_code(), &error.message),
                );
                let mut existing = config;
                existing.sandbox = None;
                let spawned = self.existing.spawn(existing, sink).await?;
                self.owners.lock().insert(spawned.clone(), Owner::Existing);
                Ok(spawned)
            }
            Err(error) => Err(error.to_string()),
        }
    }

    async fn send(&self, id: &str, message: &str) -> Result<(), String> {
        self.owner(id)?.send(id, message).await
    }

    async fn kill(&self, id: &str) -> Result<(), String> {
        self.owner(id)?.kill(id).await
    }

    async fn kill_all(&self) -> Result<(), String> {
        let existing = self.existing.kill_all().await;
        let sandbox = self.sandbox.kill_all().await;
        match (existing, sandbox) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(error), Ok(())) | (Ok(()), Err(error)) => Err(error),
            (Err(first), Err(second)) => Err(format!("{first}; {second}")),
        }
    }

    async fn status(&self, id: &str) -> Option<ExternalAgentProcessState> {
        self.owner(id).ok()?.status(id).await
    }

    async fn list(&self) -> Vec<String> {
        let mut ids = self.existing.list().await;
        ids.extend(self.sandbox.list().await);
        ids.sort();
        ids.dedup();
        ids
    }

    async fn is_running(&self, id: &str) -> Result<bool, String> {
        self.owner(id)?.is_running(id).await
    }

    async fn get_info(&self, id: &str) -> Result<Value, String> {
        self.owner(id)?.get_info(id).await
    }

    async fn set_running(&self, id: &str) -> Result<(), String> {
        self.owner(id)?.set_running(id).await
    }

    async fn set_failed(&self, id: &str) -> Result<(), String> {
        self.owner(id)?.set_failed(id).await
    }

    /// The host's own kind: logs, health and every `kind() ==
    /// "local-process"` check keep describing the path a spawn without a
    /// placement takes, which is exactly what they described before.
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
    }

    fn config(id: &str, placement: Option<SandboxPlacement>) -> ExternalAgentSpawnConfig {
        ExternalAgentSpawnConfig {
            id: id.into(),
            command: "codex-acp".into(),
            args: vec![],
            env: HashMap::from([("OPENAI_API_KEY".into(), "sk-test".into())]),
            cwd: Some("/workspaces/ws-1".into()),
            framing: Default::default(),
            sandbox: placement,
        }
    }

    fn placement(isolation_mandatory: bool) -> SandboxPlacement {
        SandboxPlacement::Container {
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
            spec: json!({ "projectId": "   ", "image": "not an object" }),
            isolation_mandatory: false,
        };
        let fields = empty.audit_fields();
        assert_eq!(fields["project_id"], Value::Null);
        assert_eq!(fields["image_digest"], Value::Null);

        // A catalog id is a slug, not any id: a valid project id is not one.
        let not_a_slug = SandboxPlacement::Container {
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
}

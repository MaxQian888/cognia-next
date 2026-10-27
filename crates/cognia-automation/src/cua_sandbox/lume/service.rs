//! Native ownership service. Long operations return handles; stop never waits
//! for the lifecycle writer. Uncertain outcomes remain durably quarantined.
use super::{cli, contracts::*, journal::*};
use cognia_desktop_guest::lume::{self, Envelope, FileOperation, Request};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{process::Child, sync::Mutex};

#[cfg(test)]
type HelperPeer = dyn Fn(&Envelope) -> Result<Vec<u8>, String> + Send + Sync;

type ActiveOperations = HashMap<String, (Option<String>, Arc<AtomicBool>)>;

const BINDING_TTL: Duration = Duration::from_secs(15);
pub struct OperationApproval {
    pub(crate) allowed: bool,
    pub(crate) driver_identity: Option<lume::DriverIdentity>,
}
impl From<bool> for OperationApproval {
    fn from(allowed: bool) -> Self {
        Self {
            allowed,
            driver_identity: None,
        }
    }
}
struct BindingLease {
    valid: AtomicBool,
    deadline: parking_lot::Mutex<std::time::Instant>,
}
impl BindingLease {
    fn new() -> Self {
        Self {
            valid: AtomicBool::new(true),
            deadline: parking_lot::Mutex::new(std::time::Instant::now() + BINDING_TTL),
        }
    }
    fn load(&self, ordering: Ordering) -> bool {
        self.valid.load(ordering) && std::time::Instant::now() < *self.deadline.lock()
    }
    fn store(&self, valid: bool, ordering: Ordering) {
        self.valid.store(valid, ordering);
    }
    fn renew(&self) -> Result<(), String> {
        let mut deadline = self.deadline.lock();
        if !self.valid.load(Ordering::SeqCst) || std::time::Instant::now() >= *deadline {
            return Err("lume_binding_expired".into());
        }
        *deadline = std::time::Instant::now() + BINDING_TTL;
        Ok(())
    }
}

pub struct Service {
    pub(crate) journal: Mutex<Journal>,
    writer: Mutex<()>,
    // Only spawn/registration and Stop settlement share this gate. Stop never
    // queues behind the long-running lifecycle writer.
    spawn_gate: Mutex<()>,
    active: Mutex<ActiveOperations>,
    children: Mutex<HashMap<String, Child>>,
    leases: Mutex<HashMap<String, std::time::Instant>>,
    epochs: parking_lot::Mutex<HashMap<String, Arc<std::sync::atomic::AtomicU64>>>,
    binding_tokens: parking_lot::Mutex<HashMap<String, Arc<BindingLease>>>,
    account: Option<String>,
    principal: Arc<parking_lot::RwLock<Option<super::NativePrincipal>>>,
    account_generation: Mutex<Option<String>>,
    reviews: Mutex<HashMap<String, (ResourceRef, cognia_task_workspace::RevisionPatch)>>,
    #[cfg(test)]
    helper_peer: parking_lot::Mutex<Option<Arc<HelperPeer>>>,
}

fn fresh_cancel() -> Arc<AtomicBool> {
    Arc::new(AtomicBool::new(false))
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GuestExecReceipt {
    exit_code: i32,
    stdout: String,
    stderr: String,
    duration_ms: u64,
    timed_out: bool,
    stdout_truncated: bool,
    stderr_truncated: bool,
}
fn normal_exec_receipt(value: serde_json::Value) -> Result<(serde_json::Value, bool), String> {
    let receipt: GuestExecReceipt =
        serde_json::from_value(value).map_err(|_| "lume_exec_receipt_invalid")?;
    if receipt.stdout.len() > 16 * 1024 || receipt.stderr.len() > 16 * 1024 {
        return Err("lume_exec_receipt_invalid".into());
    }
    let timed_out = receipt.timed_out;
    let mut result = serde_json::to_value(receipt).map_err(|_| "lume_exec_receipt_invalid")?;
    if !timed_out {
        result["executionGroupRetained"] = serde_json::json!(true);
    }
    Ok((result, timed_out))
}

fn journal_commit_failed(status: &mut OperationStatus) {
    if status
        .output
        .as_ref()
        .is_some_and(|output| output["effectCommitted"] == true)
    {
        status.error_code = Some("lume_effect_committed_journal_recovery_required".into());
        if let Some(output) = &mut status.output {
            output["journalRecoveryRequired"] = serde_json::json!(true);
        }
    } else {
        status.state = "failed".into();
        status.error_code = Some("lume_journal_commit_failed".into());
        status.output = None;
    }
}

fn desktop_operation_error(error: crate::automation::types::AutomationError) -> String {
    use crate::automation::types::AutomationError;
    match error {
        AutomationError::BackendError { message } => message,
        AutomationError::PreemptedBeforeSend => "lume_preempted_before_send".into(),
        _ => "lume_desktop_control_unavailable".into(),
    }
}

fn file_refused_before_publication(code: &str) -> bool {
    matches!(
        code,
        "lume_preempted_before_send"
            | "lume_guest_file_conflict"
            | "lume_guest_file_exists"
            | "lume_guest_file_missing"
            | "lume_guest_file_encoding"
            | "lume_guest_replace_ambiguous"
            | "lume_guest_line_invalid"
            | "lume_guest_file_limit"
            | "lume_guest_path_refused"
            | "lume_guest_path_escape"
            | "lume_guest_file_type_or_limit"
    )
}

async fn hash_binary(binary: PathBuf) -> Result<String, String> {
    tokio::task::spawn_blocking(move || cli::binary_hash(&binary))
        .await
        .map_err(|_| "lume_binary_hash_task".to_string())?
}

impl Service {
    pub fn open(root: PathBuf) -> Result<Arc<Self>, String> {
        Self::open_with_principal(root, None, Default::default())
    }

    pub(crate) fn open_owned(
        root: PathBuf,
        account: String,
        principal: Arc<parking_lot::RwLock<Option<super::NativePrincipal>>>,
    ) -> Result<Arc<Self>, String> {
        Self::open_with_principal(root, Some(account), principal)
    }
    fn open_with_principal(
        root: PathBuf,
        account: Option<String>,
        principal: Arc<parking_lot::RwLock<Option<super::NativePrincipal>>>,
    ) -> Result<Arc<Self>, String> {
        Ok(Arc::new(Self {
            journal: Mutex::new(Journal::open(root)?),
            writer: Mutex::new(()),
            spawn_gate: Mutex::new(()),
            active: Mutex::new(HashMap::new()),
            children: Mutex::new(HashMap::new()),
            leases: Mutex::new(HashMap::new()),
            epochs: parking_lot::Mutex::new(HashMap::new()),
            binding_tokens: parking_lot::Mutex::new(HashMap::new()),
            account,
            principal,
            account_generation: Mutex::new(None),
            reviews: Mutex::new(HashMap::new()),
            #[cfg(test)]
            helper_peer: parking_lot::Mutex::new(None),
        }))
    }
    fn actor(&self) -> Result<Option<super::NativePrincipal>, String> {
        if let Some(account) = &self.account {
            let principal = self
                .principal
                .read()
                .clone()
                .filter(|principal| {
                    &principal.account_id == account && !principal.revoked.load(Ordering::SeqCst)
                })
                .ok_or("lume_account_locked")?;
            Ok(Some(principal))
        } else {
            Ok(None)
        }
    }
    pub(crate) async fn activate_generation(&self, generation: &str) -> Result<(), String> {
        let mut current = self.account_generation.lock().await;
        if self.account.is_some()
            && self
                .actor()?
                .as_ref()
                .is_none_or(|actor| actor.generation != generation)
        {
            return Err("lume_account_changed".into());
        }
        if current.as_deref() == Some(generation) {
            return Ok(());
        }
        if current.is_some() {
            self.shutdown().await;
        }
        let mut journal = self.journal.lock().await;
        journal.data.bindings.clear();
        if self.account.is_some()
            && self
                .actor()?
                .as_ref()
                .is_none_or(|actor| actor.generation != generation)
        {
            return Err("lume_account_changed".into());
        }
        for token in self.binding_tokens.lock().values() {
            token.store(false, Ordering::SeqCst);
        }
        for owned in journal.data.resources.values_mut() {
            self.epoch(&owned.projection.reference.resource_id)
                .fetch_add(1, Ordering::SeqCst);
            owned.projection.reference.boot_epoch = uuid::Uuid::new_v4().to_string();
            owned.projection.readiness = Readiness::default();
            if owned.projection.state != "stopped" && owned.projection.state != "uninitialized" {
                owned.projection.quarantine = true;
            }
        }
        journal.save_async().await?;
        *current = Some(generation.into());
        Ok(())
    }

    pub(crate) async fn shutdown_generation(&self, generation: &str) {
        let current = self.account_generation.lock().await;
        if current.as_deref() == Some(generation) {
            self.shutdown().await;
        }
    }

    fn epoch(&self, id: &str) -> Arc<std::sync::atomic::AtomicU64> {
        self.epochs.lock().entry(id.into()).or_default().clone()
    }

    pub(crate) fn send_fence(
        &self,
        reference: &ResourceRef,
        binding: Option<&BindingRef>,
    ) -> Arc<dyn Fn() -> bool + Send + Sync> {
        let epoch = self.epoch(&reference.resource_id);
        let expected = epoch.load(Ordering::SeqCst);
        let token = binding.map(|binding| {
            self.binding_tokens
                .lock()
                .get(&binding.binding_id)
                .cloned()
                .unwrap_or_else(|| {
                    let token = BindingLease::new();
                    token.store(false, Ordering::SeqCst);
                    Arc::new(token)
                })
        });
        let principal = self.actor().ok().flatten();
        let requires_account = self.account.is_some();
        Arc::new(move || {
            (!requires_account
                || principal
                    .as_ref()
                    .is_some_and(|p| !p.revoked.load(Ordering::SeqCst)))
                && epoch.load(Ordering::SeqCst) == expected
                && token
                    .as_ref()
                    .is_none_or(|token| token.load(Ordering::SeqCst))
        })
    }

    pub async fn configure(&self, binary: PathBuf, enabled: bool) -> Result<(), String> {
        let actor = self.actor()?;
        if !enabled {
            let mut journal = self.journal.lock().await;
            if actor
                .as_ref()
                .is_some_and(|actor| actor.revoked.load(Ordering::SeqCst))
            {
                return Err("lume_account_changed".into());
            }
            journal.data.enabled = false;
            for resource in journal.data.resources.values_mut() {
                self.epoch(&resource.projection.reference.resource_id)
                    .fetch_add(1, Ordering::SeqCst);
                resource.projection.readiness = Readiness::default();
            }
            // Revoke admission immediately, but keep the records and invalid
            // tokens until their watchdogs retire the last session and Stop.
            // Removing them here would discard cleanup of retained guest work.
            for token in self.binding_tokens.lock().values() {
                token.store(false, Ordering::SeqCst);
            }
            for (_, flag) in self.active.lock().await.values() {
                flag.store(true, Ordering::SeqCst);
            }
            return journal.save_async().await;
        }
        if !cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            return Err("lume_platform_unsupported".into());
        }
        let hash = hash_binary(binary.clone()).await?;
        let version = cli::cli(
            &binary,
            &["--version".into()],
            Duration::from_secs(10),
            fresh_cancel(),
        )
        .await?;
        if String::from_utf8_lossy(&version).trim() != LUME_VERSION {
            return Err("lume_version_unsupported".into());
        }
        let mut journal = self.journal.lock().await;
        if actor
            .as_ref()
            .is_some_and(|actor| actor.revoked.load(Ordering::SeqCst))
        {
            return Err("lume_account_changed".into());
        }
        journal.data.binary = Some(binary);
        journal.data.binary_hash = Some(hash);
        journal.data.enabled = enabled;
        journal.save_async().await
    }

    pub async fn snapshot(&self) -> serde_json::Value {
        let journal = self.journal.lock().await;
        serde_json::json!({"contractVersion":CONTRACT_VERSION,"lumeVersion":LUME_VERSION,"platformSupported":cfg!(all(target_os="macos",target_arch="aarch64")),"enabled":journal.data.enabled,"resources":journal.data.resources.values().map(|r| r.projection.clone()).collect::<Vec<_>>()})
    }

    async fn binary(&self, recovery: bool) -> Result<(PathBuf, PathBuf), String> {
        if !recovery {
            self.actor()?;
        }
        let (binary, expected, storage) = {
            let journal = self.journal.lock().await;
            if !recovery && !journal.data.enabled {
                return Err("lume_feature_disabled".into());
            }
            (
                journal
                    .data
                    .binary
                    .clone()
                    .ok_or("lume_binary_unconfigured")?,
                journal.data.binary_hash.clone(),
                journal.root.join("vms"),
            )
        };
        if Some(hash_binary(binary.clone()).await?) != expected {
            return Err("lume_binary_changed".into());
        }
        Ok((binary, storage))
    }

    pub async fn begin<F, A>(
        self: &Arc<Self>,
        request_key: String,
        mut operation: Operation,
        approval: F,
        registry: Option<super::super::CuaSandboxRegistry>,
    ) -> Result<OperationStatus, String>
    where
        F: std::future::Future<Output = A> + Send + 'static,
        A: Into<OperationApproval> + Send + 'static,
    {
        let actor = self.actor()?;
        if request_key.is_empty() || request_key.len() > 128 {
            return Err("lume_request_key".into());
        }
        let hash =
            lume::content_hash(&serde_json::to_vec(&operation).map_err(|_| "lume_request_schema")?);
        let mut journal = self.journal.lock().await;
        if actor
            .as_ref()
            .is_some_and(|actor| actor.revoked.load(Ordering::SeqCst))
        {
            return Err("lume_account_changed".into());
        }
        if let Some(previous) = journal
            .data
            .operations
            .values()
            .find(|op| op.request_key == request_key)
        {
            if previous.request_hash != hash {
                return Err("lume_idempotency_conflict".into());
            }
            return Ok(previous.clone());
        }
        if journal.data.operations.len() >= 256 {
            let retired: Vec<_> = journal
                .data
                .operations
                .iter()
                .filter(|(_, op)| op.state != "running")
                .take(128)
                .map(|(id, _)| id.clone())
                .collect();
            for id in retired {
                journal.data.operations.remove(&id);
            }
            if journal.data.operations.len() >= 256 {
                return Err("lume_operation_history_full".into());
            }
        }
        if let Operation::Stop { reference } = &mut operation {
            let current = journal
                .data
                .resources
                .get(&reference.resource_id)
                .ok_or("lume_resource_missing")?;
            if current.projection.reference.generation != reference.generation {
                return Err("lume_stale_resource".into());
            }
            *reference = current.projection.reference.clone();
        }
        let resource = operation
            .reference()
            .map(|reference| journal.resource(reference).map(|r| r.projection.clone()))
            .transpose()?;
        let status = OperationStatus {
            id: uuid::Uuid::new_v4().to_string(),
            request_key,
            request_hash: hash,
            state: "running".into(),
            stage: if operation.needs_consent() {
                "awaitingConsent"
            } else {
                "queued"
            }
            .into(),
            resource,
            error_code: None,
            output: None,
        };
        let cancelled = fresh_cancel();
        if let Some(actor) = actor {
            actor.register_cancel(&cancelled);
        }
        // Register cancellation before exposing the handle, including provisioning.
        self.active.lock().await.insert(
            status.id.clone(),
            (
                operation.reference().map(|r| r.resource_id.clone()),
                cancelled.clone(),
            ),
        );
        self.leases
            .lock()
            .await
            .insert(status.id.clone(), std::time::Instant::now());
        journal
            .data
            .operations
            .insert(status.id.clone(), status.clone());
        if let Err(code) = journal.save_async().await {
            if !matches!(&operation, Operation::Stop { .. }) {
                journal.data.operations.remove(&status.id);
                drop(journal);
                self.active.lock().await.remove(&status.id);
                self.leases.lock().await.remove(&status.id);
                return Err(code);
            }
        }
        drop(journal);
        let service = self.clone();
        let id = status.id.clone();
        let watcher = self.clone();
        let watched = id.clone();
        let stop_flag = cancelled.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(1)).await;
                let lease = watcher.leases.lock().await.get(&watched).copied();
                match lease {
                    None => break,
                    Some(last) if last.elapsed() > Duration::from_secs(15) => {
                        stop_flag.store(true, Ordering::Release);
                        break;
                    }
                    _ => {}
                }
            }
        });
        tokio::spawn(async move {
            let setup = matches!(&operation, Operation::Setup { .. });
            let approval = tokio::select! { allowed=approval=>allowed.into(), _=async {while !cancelled.load(Ordering::Acquire){tokio::time::sleep(Duration::from_millis(25)).await;}}=>OperationApproval::from(false) };
            if let Operation::Qualify {
                approved_identity, ..
            } = &mut operation
            {
                *approved_identity = approval.driver_identity;
            }
            let result = if cancelled.load(Ordering::SeqCst) {
                Err("lume_operation_cancelled".into())
            } else if !approval.allowed {
                Err("lume_authorization_denied".into())
            } else {
                if let Some(status) = service.journal.lock().await.data.operations.get_mut(&id) {
                    status.stage = "running".into();
                }
                if cancelled.load(Ordering::SeqCst) {
                    Err("lume_operation_cancelled".into())
                } else {
                    service
                        .dispatch_guarded(&id, operation, cancelled, registry)
                        .await
                }
            };
            if setup {
                if let Ok((Some(resource), _)) = &result {
                    let owner = service.clone();
                    let reference = resource.reference.clone();
                    tokio::spawn(async move {
                        owner.monitor_setup(reference).await;
                    });
                }
            }
            let mut journal = service.journal.lock().await;
            let mut total = journal
                .data
                .operations
                .values()
                .filter_map(|op| op.output.as_ref())
                .map(|value| value.to_string().len())
                .sum::<usize>();
            if total > 16 * 1024 * 1024 {
                for operation in journal.data.operations.values_mut() {
                    if let Some(output) = operation.output.take() {
                        total = total.saturating_sub(output.to_string().len());
                    }
                    if total <= 8 * 1024 * 1024 {
                        break;
                    }
                }
            }
            if let Some(status) = journal.data.operations.get_mut(&id) {
                status.stage = "finished".into();
                match result {
                    Ok((resource, output)) => {
                        status.state = "succeeded".into();
                        status.resource = resource;
                        status.output = output;
                    }
                    Err(code) => {
                        status.state = "failed".into();
                        status.error_code = Some(code);
                    }
                }
            }
            if journal.save_async().await.is_err() {
                if let Some(status) = journal.data.operations.get_mut(&id) {
                    journal_commit_failed(status);
                }
            }
            drop(journal);
            service.active.lock().await.remove(&id);
            service.leases.lock().await.remove(&id);
        });
        Ok(status)
    }

    pub async fn poll(&self, id: &str) -> Result<OperationStatus, String> {
        if let Some(lease) = self.leases.lock().await.get_mut(id) {
            *lease = std::time::Instant::now();
        }
        self.journal
            .lock()
            .await
            .data
            .operations
            .get(id)
            .cloned()
            .ok_or_else(|| "lume_operation_missing".into())
    }

    pub async fn cancel(&self, id: &str) -> Result<(), String> {
        let active = self.active.lock().await;
        let (_, flag) = active.get(id).ok_or("lume_operation_inactive")?;
        flag.store(true, Ordering::Release);
        Ok(())
    }

    pub(crate) async fn verify(
        &self,
        reference: &ResourceRef,
        cancel: Arc<AtomicBool>,
    ) -> Result<(OwnedResource, cli::Inspection), String> {
        let result: Result<(OwnedResource, cli::Inspection), String> = async {
            let (binary, storage) = self.binary(true).await?;
            let owned = self.journal.lock().await.resource(reference)?.clone();
            let inspected =
                cli::inspect(&binary, &storage, &owned.projection.vm_name, cancel).await?;
            let vm = storage.join(&owned.projection.vm_name);
            if vm
                .symlink_metadata()
                .map_err(|_| "lume_identity_missing")?
                .file_type()
                .is_symlink()
            {
                return Err("lume_identity_symlink".into());
            }
            if owned.disk.as_ref() != Some(&identity(&vm.join("disk.img"))?)
                || owned.nvram.as_ref() != Some(&identity(&vm.join("nvram.bin"))?)
                || owned.immutable_config_hash.as_ref() != Some(&inspected.config_hash()?)
            {
                return Err("lume_identity_changed".into());
            }
            Ok((owned, inspected))
        }
        .await;
        if let Err(code) = &result {
            let _ = self.quarantine(reference, code).await;
        }
        result
    }

    pub async fn quarantine(&self, reference: &ResourceRef, code: &str) -> Result<(), String> {
        let mut journal = self.journal.lock().await;
        journal.resource(reference)?;
        self.epoch(&reference.resource_id)
            .fetch_add(1, Ordering::SeqCst);
        let resource = journal
            .data
            .resources
            .get_mut(&reference.resource_id)
            .ok_or("lume_resource_missing")?;
        resource.projection.quarantine = true;
        resource.projection.readiness = Readiness::default();
        resource.projection.last_error_code = Some(code.into());
        journal
            .data
            .bindings
            .retain(|_, b| b.reference.resource.resource_id != reference.resource_id);
        journal.save_async().await
    }

    async fn store(&self, owned: OwnedResource) -> Result<Resource, String> {
        let result = owned.projection.clone();
        let mut journal = self.journal.lock().await;
        if journal
            .data
            .resources
            .get(&result.reference.resource_id)
            .is_some_and(|current| current.projection.reference != result.reference)
        {
            return Err("lume_stale_resource".into());
        }
        journal
            .data
            .resources
            .insert(result.reference.resource_id.clone(), owned);
        journal.save_async().await?;
        Ok(result)
    }

    async fn rotate_epoch(&self, reference: &ResourceRef) -> Result<OwnedResource, String> {
        self.epoch(&reference.resource_id)
            .fetch_add(1, Ordering::SeqCst);
        let mut journal = self.journal.lock().await;
        journal.resource(reference)?;
        journal
            .data
            .bindings
            .retain(|_, binding| binding.reference.resource.resource_id != reference.resource_id);
        let owned = journal
            .data
            .resources
            .get_mut(&reference.resource_id)
            .unwrap();
        owned.projection.reference.boot_epoch = uuid::Uuid::new_v4().to_string();
        owned.projection.readiness = Readiness::default();
        let owned = owned.clone();
        journal.save_async().await?;
        Ok(owned)
    }

    async fn dispatch_guarded(
        &self,
        id: &str,
        operation: Operation,
        cancel: Arc<AtomicBool>,
        registry: Option<super::super::CuaSandboxRegistry>,
    ) -> Result<(Option<Resource>, Option<serde_json::Value>), String> {
        let target = match &operation {
            Operation::Execute { request } => Some((
                request.binding.resource.clone(),
                Some(request.binding.clone()),
                format!("lume-binding:{}", request.binding.binding_id),
            )),
            Operation::File { binding, .. } => Some((
                binding.resource.clone(),
                Some(binding.clone()),
                format!("lume-binding:{}", binding.binding_id),
            )),
            Operation::ImportWorkspace { reference, .. }
            | Operation::ReviewWorkspace { reference }
            | Operation::AdoptWorkspace { reference, .. } => {
                let connection = self
                    .journal
                    .lock()
                    .await
                    .resource(reference)?
                    .projection
                    .connection_id
                    .clone();
                Some((reference.clone(), None, connection))
            }
            _ => None,
        };
        if let Some((reference, binding, target)) = target {
            let registry = registry.ok_or("lume_control_domain_required")?;
            let mut desktop = registry
                .agent_guard(&target)
                .await
                .map_err(|_| "lume_desktop_control_unavailable")?;
            let preempt = desktop.preempt.clone();
            let epoch = desktop.agent_epoch;
            let native = self.send_fence(&reference, binding.as_ref());
            let admission: Arc<dyn Fn() -> bool + Send + Sync> =
                Arc::new(move || native() && preempt.epoch.load(Ordering::SeqCst) == epoch);
            if matches!(&operation, Operation::Execute { .. }) {
                desktop.retained_execution_group = true;
            }
            let result = desktop
                .run_mutation(async {
                    self.dispatch(id, operation, cancel, Some(admission))
                        .await
                        .map_err(|code| {
                            if code == "lume_preempted_before_send" {
                                crate::automation::types::AutomationError::PreemptedBeforeSend
                            } else {
                                crate::automation::types::AutomationError::BackendError {
                                    message: code,
                                }
                            }
                        })
                })
                .await;
            return result.map_err(desktop_operation_error);
        }
        self.dispatch(id, operation, cancel, None).await
    }

    async fn dispatch(
        &self,
        id: &str,
        operation: Operation,
        cancel: Arc<AtomicBool>,
        admission: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
    ) -> Result<(Option<Resource>, Option<serde_json::Value>), String> {
        match operation {
            Operation::ImportWorkspace {
                reference,
                host_root,
            } => Ok((
                None,
                Some(
                    self.import_workspace(&reference, host_root, cancel, admission)
                        .await?,
                ),
            )),
            Operation::ReviewWorkspace { reference } => Ok((
                None,
                Some(self.review_workspace(&reference, cancel, admission).await?),
            )),
            Operation::AdoptWorkspace {
                reference,
                review_id,
            } => Ok((
                None,
                Some(
                    self.adopt_workspace(id, &reference, &review_id, cancel)
                        .await?,
                ),
            )),
            Operation::Configure { binary, enabled } => {
                self.configure(PathBuf::from(binary), enabled).await?;
                Ok((None, Some(self.snapshot().await)))
            }
            Operation::PrepareSsh { reference } => {
                let _writer = self.writer.lock().await;
                Ok((None, Some(self.prepare_ssh(&reference, cancel).await?)))
            }
            Operation::TrustSsh {
                reference,
                host_key,
                user,
            } => {
                let _writer = self.writer.lock().await;
                Ok((
                    Some(self.trust_ssh(&reference, host_key, user, cancel).await?),
                    None,
                ))
            }
            Operation::Qualify {
                reference,
                helper_hash,
                driver_version,
                approved_identity,
            } => {
                let _writer = self.writer.lock().await;
                Ok((
                    Some(
                        self.qualify(
                            &reference,
                            &helper_hash,
                            &driver_version,
                            cancel,
                            approved_identity.as_ref(),
                        )
                        .await?,
                    ),
                    None,
                ))
            }
            Operation::Execute { request } => {
                Ok((None, Some(self.execute(request, cancel, admission).await?)))
            }
            Operation::File {
                binding,
                operation,
                data_base64,
            } => {
                use base64::Engine;
                if data_base64.len() > 12 * 1024 * 1024 {
                    return Err("lume_file_limit".into());
                }
                let data = base64::engine::general_purpose::STANDARD
                    .decode(data_base64)
                    .map_err(|_| "lume_file_encoding")?;
                Ok((
                    None,
                    Some(
                        self.file(binding, operation, data, cancel, admission)
                            .await?,
                    ),
                ))
            }
            operation => {
                let deleting = matches!(&operation, Operation::Delete { .. });
                let resource = self.perform(id, operation, cancel).await?;
                let output = (deleting && resource.state == "uninitialized").then(|| serde_json::json!({
                    "status":"deleted", "effectCommitted":true,
                    "journalRecoveryRequired":resource.last_error_code.as_deref().is_some_and(|code| code.contains("recovery_required"))
                }));
                Ok((Some(resource), output))
            }
        }
    }

    async fn perform(
        &self,
        id: &str,
        operation: Operation,
        cancel: Arc<AtomicBool>,
    ) -> Result<Resource, String> {
        if let Operation::Stop { reference } = operation {
            return self.stop_inner(&reference, None, true).await;
        }
        let setup = matches!(&operation, Operation::Setup { .. });
        let _writer = self.writer.lock().await;
        if cancel.load(Ordering::Acquire) {
            return Err("lume_operation_cancelled".into());
        }
        let (binary, storage) = self.binary(operation.recovery()).await?;
        std::fs::create_dir_all(&storage).map_err(|_| "lume_storage_directory")?;
        match operation {
            Operation::Provision {
                connection_id,
                source,
            } => {
                if connection_id.is_empty() || connection_id.len() > 128 {
                    return Err("lume_connection_id".into());
                }
                if self.journal.lock().await.data.resources.values().any(|r| {
                    r.projection.connection_id == connection_id
                        && r.projection.state != "uninitialized"
                }) {
                    return Err("lume_connection_already_owned".into());
                }
                if fs2::available_space(&storage).map_err(|_| "lume_capacity_unknown")?
                    < 60 * 1024 * 1024 * 1024
                {
                    return Err("lume_capacity_disk".into());
                }
                let resource_id = uuid::Uuid::new_v4().to_string();
                let name = format!("cognia-{}", resource_id.replace('-', ""));
                let mut owned = OwnedResource {
                    projection: Resource {
                        reference: ResourceRef {
                            resource_id: resource_id.clone(),
                            generation: 1,
                            boot_epoch: uuid::Uuid::new_v4().to_string(),
                        },
                        connection_id,
                        vm_name: name.clone(),
                        state: "creating".into(),
                        readiness: Readiness::default(),
                        quarantine: true,
                        memory_mb: 0,
                        last_error_code: None,
                        group_id: None,
                        workspace_revision: None,
                    },
                    disk: None,
                    nvram: None,
                    immutable_config_hash: None,
                    ssh_host_key: None,
                    ssh_user: None,
                    instance_nonce: None,
                    driver_version: None,
                    driver_schema_hash: None,
                    driver_identity: None,
                    driver_identity_epoch: None,
                    helper_hash: None,
                    approved_session_id: None,
                    unmanaged_writers: false,
                    workspace: None,
                };
                let args = match source {
                    Provision::Create {
                        ipsw,
                        cpu,
                        memory_mb,
                        disk_gb,
                    } => {
                        let ipsw = PathBuf::from(ipsw);
                        if !ipsw.is_absolute()
                            || !ipsw.is_file()
                            || !(2..=32).contains(&cpu)
                            || !(4096..=65536).contains(&memory_mb)
                            || !(50..=512).contains(&disk_gb)
                        {
                            return Err("lume_create_profile".into());
                        }
                        vec![
                            "create".into(),
                            name.clone(),
                            "--ipsw".into(),
                            ipsw.to_string_lossy().into_owned(),
                            "--cpu".into(),
                            cpu.to_string(),
                            "--memory".into(),
                            format!("{memory_mb}MB"),
                            "--disk-size".into(),
                            format!("{disk_gb}GB"),
                            "--storage".into(),
                            storage.to_string_lossy().into_owned(),
                            "--no-display".into(),
                        ]
                    }
                    Provision::Clone {
                        seed_name,
                        seed_storage,
                    } => {
                        cli::validate_name(&seed_name)?;
                        let seed_storage = PathBuf::from(seed_storage)
                            .canonicalize()
                            .map_err(|_| "lume_seed_storage")?;
                        let seed = cli::inspect(&binary, &seed_storage, &seed_name, cancel.clone())
                            .await?;
                        if seed.status != "stopped" {
                            return Err("lume_seed_must_be_stopped".into());
                        }
                        vec![
                            "clone".into(),
                            seed_name,
                            name.clone(),
                            "--source-storage".into(),
                            seed_storage.to_string_lossy().into_owned(),
                            "--dest-storage".into(),
                            storage.to_string_lossy().into_owned(),
                        ]
                    }
                    Provision::Attach { vm_name } => {
                        cli::validate_name(&vm_name)?;
                        if self
                            .journal
                            .lock()
                            .await
                            .data
                            .resources
                            .values()
                            .any(|resource| {
                                resource.projection.vm_name == vm_name
                                    && resource.projection.state != "uninitialized"
                            })
                        {
                            return Err("lume_vm_already_owned".into());
                        }
                        if !vm_name.starts_with("cognia-") {
                            return Err("lume_attach_requires_owned_storage".into());
                        }
                        let inspected =
                            cli::inspect(&binary, &storage, &vm_name, cancel.clone()).await?;
                        if inspected.status != "stopped" {
                            return Err("lume_attach_must_be_stopped".into());
                        }
                        owned.projection.vm_name = vm_name;
                        vec![]
                    }
                };
                self.store(owned.clone()).await?;
                if let Some(active) = self.active.lock().await.get_mut(id) {
                    active.0 = Some(resource_id);
                }
                {
                    let mut journal = self.journal.lock().await;
                    if let Some(op) = journal.data.operations.get_mut(id) {
                        op.resource = Some(owned.projection.clone());
                        op.stage = "provisioning".into();
                    }
                    journal.save_async().await?;
                }
                if !args.is_empty() {
                    if let Err(code) =
                        cli::cli(&binary, &args, Duration::from_secs(1800), cancel.clone()).await
                    {
                        self.quarantine(&owned.projection.reference, &code).await?;
                        return Err(code);
                    }
                }
                let inspected =
                    cli::inspect(&binary, &storage, &owned.projection.vm_name, cancel).await?;
                let vm = storage.join(&owned.projection.vm_name);
                owned.disk = Some(identity(&vm.join("disk.img"))?);
                owned.nvram = Some(identity(&vm.join("nvram.bin"))?);
                owned.immutable_config_hash = Some(inspected.config_hash()?);
                owned.projection.memory_mb = inspected.memory_size / 1024 / 1024;
                owned.projection.state = inspected.status;
                owned.projection.quarantine = false;
                self.store(owned).await
            }
            Operation::Start { reference } | Operation::Setup { reference } => {
                let (mut owned, inspected) = self.verify(&reference, cancel.clone()).await?;
                if owned.projection.quarantine {
                    return Err("lume_quarantined".into());
                }
                if inspected.status != "stopped" {
                    return Err("lume_start_requires_stopped".into());
                }
                let disk = fs2::available_space(&storage).map_err(|_| "lume_capacity_unknown")?;
                let available = tokio::task::spawn_blocking(|| {
                    let mut system = sysinfo::System::new();
                    system.refresh_memory();
                    system.available_memory() / 1024 / 1024
                })
                .await
                .map_err(|_| "lume_capacity_unknown")?;
                require_start_capacity(
                    available,
                    owned.projection.memory_mb,
                    self.running_vm_count().await,
                    disk,
                )?;
                owned = self.rotate_epoch(&reference).await?;
                owned.projection.state = "starting".into();
                self.store(owned.clone()).await?;
                if setup && owned.projection.group_id.is_some() {
                    return Err("lume_setup_bound_resource".into());
                }
                owned.projection.quarantine = setup;
                self.store(owned.clone()).await?;
                self.spawn_vm(&binary, &storage, &owned, setup, cancel.clone())
                    .await?;
                let deadline = tokio::time::Instant::now() + Duration::from_secs(180);
                loop {
                    let exited = self
                        .children
                        .lock()
                        .await
                        .get_mut(&reference.resource_id)
                        .is_some_and(|child| child.try_wait().ok().flatten().is_some());
                    if exited {
                        let _ = self.stop(&owned.projection.reference).await;
                        return Err("lume_boot_process_exited".into());
                    }
                    if cancel.load(Ordering::Acquire) || tokio::time::Instant::now() >= deadline {
                        let _ = self.stop(&owned.projection.reference).await;
                        return Err("lume_boot_interrupted".into());
                    }
                    if let Ok(inspected) =
                        cli::inspect(&binary, &storage, &owned.projection.vm_name, cancel.clone())
                            .await
                    {
                        if inspected.status == "running" {
                            owned.projection.state = "running".into();
                            owned.projection.readiness.vm = true;
                            return self.store(owned).await;
                        }
                    }
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
            }
            Operation::Connect { reference } | Operation::Health { reference } => {
                let (mut owned, inspected) = self.verify(&reference, cancel.clone()).await?;
                owned.projection.state = inspected.status.clone();
                owned.projection.readiness.vm = inspected.status == "running";
                owned.projection.readiness.ssh = false;
                owned.projection.readiness.helper = false;
                owned.projection.readiness.gui = false;
                if inspected.status == "running"
                    && !owned.projection.quarantine
                    && self.journal.lock().await.data.enabled
                {
                    if let (Some(hash), Some(version)) =
                        (owned.helper_hash.clone(), owned.driver_version.clone())
                    {
                        match self
                            .qualify(
                                &reference,
                                &hash,
                                &version,
                                cancel,
                                owned.driver_identity.as_ref(),
                            )
                            .await
                        {
                            Ok(resource) => return Ok(resource),
                            Err(code) => {
                                owned = self.journal.lock().await.resource(&reference)?.clone();
                                owned.projection.last_error_code = Some(code);
                            }
                        }
                    }
                }
                self.store(owned).await
            }
            Operation::Delete { reference } => {
                if let Some(retired) = self.retire_absent(&reference, true).await? {
                    return Ok(retired);
                }
                let stopped = self.stop_inner(&reference, Some(id), false).await?;
                let reference = stopped.reference;
                let (mut owned, _) = self.verify(&reference, fresh_cancel()).await?;
                owned.projection.state = "deleting".into();
                owned.projection.quarantine = true;
                owned.projection.last_error_code = Some("lume_delete_in_progress".into());
                // Persist intent before a destructive CLI call. A later Host
                // can reconcile absence without adopting an unverified disk.
                self.store(owned.clone()).await?;
                let deletion = cli::cli(
                    &binary,
                    &[
                        "delete".into(),
                        owned.projection.vm_name.clone(),
                        "--force".into(),
                        "--storage".into(),
                        storage.to_string_lossy().into_owned(),
                    ],
                    Duration::from_secs(30),
                    cancel,
                )
                .await;
                if let Some(retired) = self.retire_absent(&reference, true).await? {
                    return Ok(retired);
                }
                let code = deletion
                    .err()
                    .unwrap_or_else(|| "lume_delete_unconfirmed".into());
                let _ = self.quarantine(&reference, &code).await;
                Err(code)
            }
            _ => unreachable!("non-lifecycle operations are handled by dispatch"),
        }
    }

    pub async fn stop(&self, reference: &ResourceRef) -> Result<Resource, String> {
        self.stop_inner(reference, None, false).await
    }

    async fn running_vm_count(&self) -> usize {
        let mut children = self.children.lock().await;
        // A guest may shut itself down after boot. Retain unknown/live owners,
        // but do not spend capacity forever on reaped foreground processes.
        children.retain(|_, child| !matches!(child.try_wait(), Ok(Some(_))));
        children.len()
    }

    async fn spawn_vm(
        &self,
        binary: &std::path::Path,
        storage: &std::path::Path,
        owned: &OwnedResource,
        setup: bool,
        cancel: Arc<AtomicBool>,
    ) -> Result<(), String> {
        let _spawn = self.spawn_gate.lock().await;
        if cancel.load(Ordering::SeqCst)
            || self
                .journal
                .lock()
                .await
                .resource(&owned.projection.reference)
                .is_err()
        {
            return Err("lume_boot_interrupted".into());
        }
        let child = cli::run_vm(binary, &owned.projection.vm_name, storage, setup)?;
        self.children
            .lock()
            .await
            .insert(owned.projection.reference.resource_id.clone(), child);
        Ok(())
    }

    async fn retire_absent(
        &self,
        reference: &ResourceRef,
        lifecycle_settled: bool,
    ) -> Result<Option<Resource>, String> {
        let mut journal = self.journal.lock().await;
        let owned = journal.resource(reference)?;
        let intent = owned.projection.state == "deleting"
            || (owned.projection.state == "creating"
                && owned.disk.is_none()
                && owned.nvram.is_none()
                && owned.immutable_config_hash.is_none())
            || (owned.projection.state == "uninitialized"
                && matches!(
                    owned.projection.last_error_code.as_deref(),
                    Some(
                        "lume_deleted_journal_recovery_required"
                            | "lume_ssh_secret_recovery_required"
                    )
                ));
        if !intent {
            return Ok(None);
        }
        if !lifecycle_settled && matches!(owned.projection.state.as_str(), "creating" | "deleting")
        {
            return Err("lume_lifecycle_cleanup_pending".into());
        }
        cli::validate_name(&owned.projection.vm_name)?;
        if !owned.projection.vm_name.starts_with("cognia-") {
            return Err("lume_ownership_required".into());
        }
        match journal
            .root
            .join("vms")
            .join(&owned.projection.vm_name)
            .symlink_metadata()
        {
            // A dangling symlink is still present. Only ENOENT establishes the
            // absent postcondition; partial disks remain owned and quarantined.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Ok(_) => return Ok(None),
            Err(_) => return Err("lume_delete_unconfirmed".into()),
        }
        self.epoch(&reference.resource_id)
            .fetch_add(1, Ordering::SeqCst);
        for binding in journal
            .data
            .bindings
            .values()
            .filter(|b| b.reference.resource.resource_id == reference.resource_id)
        {
            if let Some(token) = self
                .binding_tokens
                .lock()
                .remove(&binding.reference.binding_id)
            {
                token.store(false, Ordering::SeqCst);
            }
        }
        journal
            .data
            .bindings
            .retain(|_, binding| binding.reference.resource.resource_id != reference.resource_id);
        let retired = journal
            .data
            .resources
            .get_mut(&reference.resource_id)
            .unwrap();
        retired.projection.reference.boot_epoch = uuid::Uuid::new_v4().to_string();
        retired.projection.state = "uninitialized".into();
        retired.projection.readiness = Readiness::default();
        retired.projection.quarantine = false;
        retired.projection.last_error_code = None;
        retired.projection.group_id = None;
        retired.projection.workspace_revision = None;
        retired.workspace = None;
        retired.disk = None;
        retired.nvram = None;
        retired.immutable_config_hash = None;
        retired.ssh_host_key = None;
        retired.ssh_user = None;
        retired.instance_nonce = None;
        retired.helper_hash = None;
        retired.approved_session_id = None;
        retired.unmanaged_writers = false;
        retired.driver_version = None;
        retired.driver_schema_hash = None;
        retired.driver_identity = None;
        retired.driver_identity_epoch = None;
        if cognia_secrets::keyring_secrets::clear("lume-ssh", &reference.resource_id).is_err() {
            retired.projection.quarantine = true;
            retired.projection.last_error_code = Some("lume_ssh_secret_recovery_required".into());
        }
        if journal.save_async().await.is_err() {
            let retired = journal
                .data
                .resources
                .get_mut(&reference.resource_id)
                .unwrap();
            retired.projection.quarantine = true;
            retired.projection.last_error_code =
                Some("lume_deleted_journal_recovery_required".into());
        }
        Ok(Some(
            journal.data.resources[&reference.resource_id]
                .projection
                .clone(),
        ))
    }

    async fn stop_inner(
        &self,
        reference: &ResourceRef,
        except: Option<&str>,
        emergency: bool,
    ) -> Result<Resource, String> {
        // Validate and preempt under one journal lock: a delayed old-boot
        // cleanup must not cancel a newly admitted operation before refusing.
        // Explicit emergency Stop retains its same-generation recovery scope.
        {
            let journal = self.journal.lock().await;
            if emergency {
                journal
                    .data
                    .resources
                    .get(&reference.resource_id)
                    .filter(|owned| owned.projection.reference.generation == reference.generation)
                    .ok_or("lume_stale_resource")?;
            } else {
                journal.resource(reference)?;
            }
            for (id, (resource, flag)) in self.active.lock().await.iter() {
                if Some(id.as_str()) != except
                    && resource.as_deref() == Some(&reference.resource_id)
                {
                    flag.store(true, Ordering::Release);
                }
            }
        }
        let _spawn = self.spawn_gate.lock().await;
        let current;
        let reference = if emergency {
            current = self
                .journal
                .lock()
                .await
                .data
                .resources
                .get(&reference.resource_id)
                .filter(|owned| owned.projection.reference.generation == reference.generation)
                .ok_or("lume_stale_resource")?
                .projection
                .reference
                .clone();
            &current
        } else {
            reference
        };
        // Cancellation is only a request until the lifecycle writer releases
        // its child after kill/wait. Never attest absence while it can still
        // create or finish replacing VM files.
        let idle_writer = self.writer.try_lock().ok();
        if let Some(retired) = self.retire_absent(reference, idle_writer.is_some()).await? {
            return Ok(retired);
        }
        drop(idle_writer);
        let previous = self
            .journal
            .lock()
            .await
            .resource(reference)?
            .projection
            .reference
            .clone();
        // Revocation must survive a full disk: rotate_epoch updates memory and
        // the send fence before attempting its durable write.
        let durable_error = self.rotate_epoch(&previous).await.err();
        let rotated = self
            .journal
            .lock()
            .await
            .data
            .resources
            .get(&previous.resource_id)
            .cloned()
            .ok_or("lume_resource_missing")?;
        let reference = &rotated.projection.reference;
        let quarantine_error = self
            .quarantine(reference, "lume_stop_in_progress")
            .await
            .err();
        let (binary, storage) = self.binary(true).await?;
        let (mut owned, inspected) = self.verify(reference, fresh_cancel()).await?;
        if inspected.status != "stopped" {
            cli::cli(
                &binary,
                &[
                    "stop".into(),
                    owned.projection.vm_name.clone(),
                    "--force".into(),
                    "--storage".into(),
                    storage.to_string_lossy().into_owned(),
                ],
                Duration::from_secs(15),
                fresh_cancel(),
            )
            .await?;
        }
        let inspected =
            cli::inspect(&binary, &storage, &owned.projection.vm_name, fresh_cancel()).await?;
        if inspected.status != "stopped" {
            return Err("lume_stop_unconfirmed".into());
        }
        if let Some(mut child) = self.children.lock().await.remove(&reference.resource_id) {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        owned.projection.state = "stopped".into();
        owned.projection.readiness = Readiness::default();
        owned.projection.quarantine = false;
        owned.projection.last_error_code = None;
        // A stopped guest can retain startup jobs or app state that writes on
        // its next boot. Only a fresh resource clears writer exposure.
        let durability_failed = durable_error.is_some() || quarantine_error.is_some();
        if durability_failed {
            owned.projection.quarantine = true;
            owned.projection.last_error_code =
                Some("lume_stopped_journal_recovery_required".into());
        }
        let result = match self.store(owned).await {
            Ok(resource) => resource,
            Err(_) => {
                let mut journal = self.journal.lock().await;
                if let Some(resource) = journal.data.resources.get_mut(&reference.resource_id) {
                    resource.projection.quarantine = true;
                    resource.projection.last_error_code =
                        Some("lume_stopped_journal_recovery_required".into());
                }
                return Err("lume_stopped_journal_recovery_required".into());
            }
        };
        if durability_failed {
            return Err("lume_stopped_journal_recovery_required".into());
        }
        Ok(result)
    }

    async fn import_workspace(
        &self,
        reference: &ResourceRef,
        host_root: String,
        cancel: Arc<AtomicBool>,
        admission: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
    ) -> Result<serde_json::Value, String> {
        let _writer = self.writer.lock().await;
        let mut owned = self.journal.lock().await.resource(reference)?.clone();
        if owned.projection.group_id.is_some() || owned.workspace.is_some() {
            return Err("lume_workspace_already_assigned".into());
        }
        if !self.journal.lock().await.data.enabled
            || !owned.projection.readiness.helper
            || owned.projection.quarantine
        {
            return Err("lume_not_ready".into());
        }
        let (source, body) = tokio::task::spawn_blocking(move || {
            super::workspace::prepare(std::path::Path::new(&host_root))
        })
        .await
        .map_err(|_| "lume_workspace_task")??;
        if cancel.load(Ordering::SeqCst) || admission.as_ref().is_some_and(|f| !f()) {
            return Err("lume_preempted_before_send".into());
        }
        let result = self
            .helper_call(
                reference,
                "workspace-import",
                Request::WorkspaceImport {
                    files: source.files.clone(),
                },
                &body,
                cli::HelperExecution {
                    timeout: Duration::from_secs(120),
                    cancel,
                    admission,
                },
            )
            .await;
        if let Err(code) = result {
            return Err(self.contain_uncertain(reference, &code).await);
        }
        owned.projection.workspace_revision = Some(source.revision.clone());
        let output = serde_json::json!({"sourceRevision":source.revision,"fileCount":source.files.len(),"bytes":body.len()});
        owned.workspace = Some(source);
        // A failed journal write must not turn an unrecorded replica into an
        // admitted source. Keep recovery explicit after a partial import.
        if self.store(owned).await.is_err() {
            return Err(self
                .contain_uncertain(reference, "lume_workspace_commit_failed")
                .await);
        }
        Ok(output)
    }

    async fn review_workspace(
        &self,
        reference: &ResourceRef,
        cancel: Arc<AtomicBool>,
        admission: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
    ) -> Result<serde_json::Value, String> {
        let owned = self.journal.lock().await.resource(reference)?.clone();
        if !self.journal.lock().await.data.enabled
            || !owned.projection.readiness.helper
            || owned.projection.quarantine
        {
            return Err("lume_not_ready".into());
        }
        let source = owned
            .workspace
            .as_ref()
            .filter(|s| !s.adopted)
            .ok_or("lume_workspace_import_required")?;
        let (reply, body) = match self
            .helper_call(
                reference,
                "workspace-review",
                Request::WorkspaceExport,
                &[],
                cli::HelperExecution {
                    timeout: Duration::from_secs(120),
                    cancel,
                    admission,
                },
            )
            .await
        {
            Ok(reply) => reply,
            Err(code) => return Err(self.contain_uncertain(reference, &code).await),
        };
        let files =
            serde_json::from_value::<Vec<lume::WorkspaceFile>>(reply.result["files"].clone())
                .map_err(|_| "lume_workspace_manifest")?;
        let patch = super::workspace::changes(source, &files, &body)?;
        let id = uuid::Uuid::new_v4().to_string();
        let digest =
            lume::content_hash(&serde_json::to_vec(&patch).map_err(|_| "lume_workspace_encode")?);
        let mut reviews = self.reviews.lock().await;
        if reviews.len() >= 8 {
            reviews.clear();
        }
        reviews.insert(id.clone(), (reference.clone(), patch.clone()));
        Ok(serde_json::json!({"reviewId":id,"sha256":digest,"hostRoot":source.root,"patch":patch}))
    }

    #[cfg(feature = "tauri-host")]
    pub(super) async fn workspace_consent(
        &self,
        reference: &ResourceRef,
        review_id: &str,
    ) -> Result<String, String> {
        let root = self
            .journal
            .lock()
            .await
            .resource(reference)?
            .workspace
            .as_ref()
            .ok_or("lume_workspace_import_required")?
            .root
            .clone();
        let reviews = self.reviews.lock().await;
        let (review_ref, patch) = reviews
            .get(review_id)
            .ok_or("lume_workspace_review_expired")?;
        if review_ref != reference {
            return Err("lume_workspace_review_stale".into());
        }
        let digest =
            lume::content_hash(&serde_json::to_vec(patch).map_err(|_| "lume_workspace_encode")?);
        Ok(format!("Stop this VM and adopt the {} reviewed file changes into {}. Review {review_id}, SHA-256 {digest}. No files are written if the imported source revision changed. The guest disk is preserved.",patch.files.len(),root.display()))
    }

    async fn adopt_workspace(
        &self,
        id: &str,
        reference: &ResourceRef,
        review_id: &str,
        cancel: Arc<AtomicBool>,
    ) -> Result<serde_json::Value, String> {
        let _writer = self.writer.lock().await;
        let actor = self.actor()?;
        let owned = self.journal.lock().await.resource(reference)?.clone();
        let source = owned
            .workspace
            .as_ref()
            .filter(|s| !s.adopted)
            .ok_or("lume_workspace_import_required")?;
        let (review_ref, patch) = self
            .reviews
            .lock()
            .await
            .get(review_id)
            .cloned()
            .ok_or("lume_workspace_review_expired")?;
        if review_ref != *reference || patch.base_revision != source.revision {
            return Err("lume_workspace_review_stale".into());
        }
        if !self.journal.lock().await.data.enabled || cancel.load(Ordering::SeqCst) {
            return Err("lume_operation_cancelled".into());
        }
        let stopped = self.stop_inner(reference, Some(id), false).await?;
        let source = source.clone();
        let outcome = tokio::task::spawn_blocking(move || {
            if cancel.load(Ordering::SeqCst)
                || actor
                    .as_ref()
                    .is_some_and(|a| a.revoked.load(Ordering::SeqCst))
            {
                return Err("lume_operation_cancelled".to_string());
            }
            super::workspace::adopt(&source, &patch)
        })
        .await
        .map_err(|_| "lume_workspace_task")??;
        self.finish_workspace_adoption(&stopped.reference, review_id, outcome)
            .await
    }

    async fn finish_workspace_adoption(
        &self,
        reference: &ResourceRef,
        review_id: &str,
        outcome: cognia_task_workspace::RevisionApplyOutcome,
    ) -> Result<serde_json::Value, String> {
        let mut receipt = serde_json::to_value(&outcome).map_err(|_| "lume_workspace_encode")?;
        if outcome.status == cognia_task_workspace::RevisionApplyStatus::Applied {
            receipt["effectCommitted"] = serde_json::json!(true);
            let mut journal = self.journal.lock().await;
            // Publication cannot be undone by a concurrent Stop, account epoch
            // change or a failed journal write. Update only the current entry;
            // never store the stale pre-publication projection over a new epoch.
            let mut recovery = true;
            if let Some(resource) = journal.data.resources.get_mut(&reference.resource_id) {
                if resource.projection.reference.generation == reference.generation {
                    if let Some(source) = resource.workspace.as_mut() {
                        source.adopted = true;
                        recovery = resource.projection.reference != *reference;
                    }
                }
            }
            recovery |= journal.save_async().await.is_err();
            if recovery {
                if let Some(resource) = journal.data.resources.get_mut(&reference.resource_id) {
                    resource.projection.quarantine = true;
                    resource.projection.readiness = Readiness::default();
                    resource.projection.last_error_code =
                        Some("lume_workspace_adopted_journal_recovery_required".into());
                }
                receipt["journalRecoveryRequired"] = serde_json::json!(true);
                // Best effort durability; the committed receipt stays intact
                // even if this recovery snapshot also cannot reach disk.
                let _ = journal.save_async().await;
            }
            drop(journal);
            self.reviews.lock().await.remove(review_id);
        }
        Ok(receipt)
    }

    pub async fn bind<F>(
        self: &Arc<Self>,
        reference: ResourceRef,
        session_id: String,
        mut policy: BindingPolicy,
        approval: F,
    ) -> Result<BindingRef, String>
    where
        F: std::future::Future<Output = bool> + Send,
    {
        if session_id.is_empty()
            || session_id.len() > 128
            || session_id.chars().any(char::is_control)
        {
            return Err("lume_binding_identity".into());
        }
        let actor = self.actor()?;
        if !approval.await {
            return Err("lume_authorization_denied".into());
        }
        if actor
            .as_ref()
            .is_some_and(|actor| actor.revoked.load(Ordering::SeqCst))
        {
            return Err("lume_account_changed".into());
        }
        let root = PathBuf::from(&policy.workspace_root)
            .canonicalize()
            .map_err(|_| "lume_workspace_root")?;
        let mut journal = self.journal.lock().await;
        let owned = journal.resource(&reference)?;
        let source = owned
            .workspace
            .as_ref()
            .ok_or("lume_workspace_import_required")?;
        super::workspace::verify_root(source)?;
        if source.root != root || source.adopted {
            return Err("lume_workspace_source_mismatch".into());
        }
        policy.validate(&owned.projection)?;
        if !journal.data.enabled
            || owned.projection.quarantine
            || !owned.projection.readiness.helper
        {
            return Err("lume_not_ready".into());
        }
        // Caller-supplied group names never confer membership. This profile
        // admits one explicitly approved session for the resource's lifetime.
        if owned
            .approved_session_id
            .as_deref()
            .is_some_and(|approved| approved != session_id)
            || (owned.projection.group_id.is_some() && owned.approved_session_id.is_none())
        {
            return Err("lume_group_retired".into());
        }
        let group = owned
            .projection
            .group_id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        policy.group_id = group.clone();
        if actor
            .as_ref()
            .is_some_and(|actor| actor.revoked.load(Ordering::SeqCst))
        {
            return Err("lume_account_changed".into());
        }
        let account_generation = actor
            .as_ref()
            .map(|actor| actor.generation.clone())
            .unwrap_or_default();
        let binding = BindingRef {
            resource: reference.clone(),
            binding_id: uuid::Uuid::new_v4().to_string(),
            session_id: session_id.clone(),
        };
        let resource = journal
            .data
            .resources
            .get_mut(&reference.resource_id)
            .unwrap();
        resource.projection.group_id = Some(group);
        resource.approved_session_id = Some(session_id.clone());
        journal.data.bindings.insert(
            binding.binding_id.clone(),
            Binding {
                reference: binding.clone(),
                session_id,
                policy,
                account_generation,
            },
        );
        journal.save_async().await?;
        if actor
            .as_ref()
            .is_some_and(|actor| actor.revoked.load(Ordering::SeqCst))
        {
            return Err("lume_account_changed".into());
        }
        self.binding_tokens
            .lock()
            .insert(binding.binding_id.clone(), Arc::new(BindingLease::new()));
        drop(journal);
        let weak = Arc::downgrade(self);
        let watched = binding.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(1)).await;
                let Some(service) = weak.upgrade() else {
                    return;
                };
                let live = service
                    .binding_tokens
                    .lock()
                    .get(&watched.binding_id)
                    .map(|token| token.load(Ordering::SeqCst));
                match live {
                    None => return,
                    Some(true) => {}
                    Some(false) => {
                        let _ = service.unbind(&watched).await;
                        return;
                    }
                }
            }
        });
        Ok(binding)
    }

    pub async fn renew_binding(&self, binding: &BindingRef) -> Result<(), String> {
        self.bound_identity(binding, false).await?;
        self.binding_tokens
            .lock()
            .get(&binding.binding_id)
            .ok_or("lume_binding_revoked")?
            .renew()
    }

    async fn prepare_ssh(
        &self,
        reference: &ResourceRef,
        cancel: Arc<AtomicBool>,
    ) -> Result<serde_json::Value, String> {
        let (mut owned, _) = self.verify(reference, cancel.clone()).await?;
        if owned.projection.group_id.is_some() {
            return Err("lume_prepare_bound_resource".into());
        }
        let directory = tempfile::tempdir().map_err(|_| "lume_key_directory")?;
        let key = directory.path().join("id_ed25519");
        cli::cli(
            std::path::Path::new("/usr/bin/ssh-keygen"),
            &[
                "-q".into(),
                "-t".into(),
                "ed25519".into(),
                "-N".into(),
                "".into(),
                "-C".into(),
                "cognia-lume".into(),
                "-f".into(),
                key.to_string_lossy().into_owned(),
            ],
            Duration::from_secs(10),
            cancel.clone(),
        )
        .await?;
        let private = std::fs::read_to_string(&key).map_err(|_| "lume_key_read")?;
        let public =
            std::fs::read_to_string(key.with_extension("pub")).map_err(|_| "lume_key_read")?;
        self.invalidate_qualification(reference).await?;
        if cancel.load(Ordering::SeqCst) {
            return Err("lume_operation_cancelled".into());
        }
        self.actor()?;
        cognia_secrets::keyring_secrets::set("lume-ssh", &reference.resource_id, &private)?;
        let nonce = uuid::Uuid::new_v4().to_string();
        owned.instance_nonce = Some(nonce.clone());
        owned.ssh_host_key = None;
        owned.ssh_user = None;
        owned.helper_hash = None;
        owned.driver_version = None;
        owned.driver_schema_hash = None;
        owned.driver_identity = None;
        owned.driver_identity_epoch = None;
        owned.projection.readiness = Readiness::default();
        self.store(owned).await?;
        Ok(
            serde_json::json!({"clientPublicKey":public.trim(),"instanceNonce":nonce,"helperPath":"/usr/local/libexec/cognia-lume-guest","guestConfigPath":"~/.config/cognia-lume/guest.json","contractVersion":CONTRACT_VERSION}),
        )
    }

    async fn trust_ssh(
        &self,
        reference: &ResourceRef,
        host_key: String,
        user: String,
        cancel: Arc<AtomicBool>,
    ) -> Result<Resource, String> {
        let host_key = cli::canonical_host_key(&host_key)?;
        let (mut owned, _) = self.verify(reference, cancel.clone()).await?;
        if owned.instance_nonce.is_none() || owned.projection.group_id.is_some() {
            return Err("lume_prepare_required".into());
        }
        if self.journal.lock().await.data.resources.values().any(|r| {
            r.projection.reference.resource_id != reference.resource_id
                && r.ssh_host_key
                    .as_deref()
                    .and_then(|key| cli::canonical_host_key(key).ok())
                    .as_deref()
                    == Some(&host_key)
        }) {
            return Err("lume_clone_host_key_reused".into());
        }
        let files = cli::SshFiles::new("validation-only", &host_key)?;
        let _ = files.command("127.0.0.1".parse().unwrap(), &user, cli::HELPER_COMMAND)?;
        self.invalidate_qualification(reference).await?;
        if cancel.load(Ordering::SeqCst) {
            return Err("lume_operation_cancelled".into());
        }
        owned.ssh_host_key = Some(host_key);
        owned.ssh_user = Some(user);
        owned.projection.readiness = Readiness::default();
        self.store(owned).await
    }

    async fn invalidate_qualification(&self, reference: &ResourceRef) -> Result<(), String> {
        let mut journal = self.journal.lock().await;
        journal.resource(reference)?;
        self.epoch(&reference.resource_id)
            .fetch_add(1, Ordering::SeqCst);
        // Keep frozen bindings for retirement/Stop, but they cannot regain
        // authority when a later qualification succeeds.
        for binding in journal
            .data
            .bindings
            .values()
            .filter(|b| b.reference.resource == *reference)
        {
            if let Some(token) = self
                .binding_tokens
                .lock()
                .get(&binding.reference.binding_id)
            {
                token.store(false, Ordering::SeqCst);
            }
        }
        let owned = journal
            .data
            .resources
            .get_mut(&reference.resource_id)
            .unwrap();
        owned.projection.readiness = Readiness::default();
        owned.projection.last_error_code = Some("lume_qualification_required".into());
        // Retain the approved schema pin across failed probes. An automatic
        // Health must never treat failure as permission to accept a new schema.
        journal.save_async().await
    }

    async fn qualify(
        &self,
        reference: &ResourceRef,
        helper_hash: &str,
        driver_version: &str,
        cancel: Arc<AtomicBool>,
        approved_identity: Option<&lume::DriverIdentity>,
    ) -> Result<Resource, String> {
        if helper_hash.len() != 64
            || !helper_hash.bytes().all(|b| b.is_ascii_hexdigit())
            || driver_version.is_empty()
            || driver_version.len() > 80
        {
            return Err("lume_qualification_version".into());
        }
        if cancel.load(Ordering::SeqCst) {
            return Err("lume_operation_cancelled".into());
        }
        let result = self
            .probe_qualification(
                reference,
                helper_hash,
                driver_version,
                cancel,
                approved_identity,
            )
            .await;
        if let Err(code) = &result {
            let _ = self.quarantine(reference, code).await;
        }
        result
    }

    async fn probe_qualification(
        &self,
        reference: &ResourceRef,
        helper_hash: &str,
        driver_version: &str,
        cancel: Arc<AtomicBool>,
        approved_identity: Option<&lume::DriverIdentity>,
    ) -> Result<Resource, String> {
        {
            let mut journal = self.journal.lock().await;
            journal.resource(reference)?;
            let owned = journal
                .data
                .resources
                .get_mut(&reference.resource_id)
                .unwrap();
            owned.projection.readiness = Readiness::default();
            owned.projection.last_error_code = Some("lume_qualification_required".into());
            journal.save_async().await?;
        }
        let admission = self.send_fence(reference, None);
        let (mut owned, _) = self.verify(reference, cancel.clone()).await?;
        if owned.projection.quarantine {
            return Err("lume_quarantined".into());
        }
        let (reply, _) = self
            .helper_call(
                reference,
                "qualification",
                Request::Hello,
                &[],
                cli::HelperExecution {
                    timeout: Duration::from_secs(10),
                    cancel: cancel.clone(),
                    admission: None,
                },
            )
            .await?;
        if reply.result["version"] != lume::VERSION
            || reply.result["helperHash"] != helper_hash
            || reply.result["platform"] != "darwin"
        {
            return Err("lume_helper_unqualified".into());
        }
        owned.helper_hash = Some(helper_hash.into());
        owned.driver_version = Some(driver_version.into());
        owned.projection.readiness.vm = true;
        owned.projection.readiness.ssh = true;
        owned.projection.readiness.helper = true;
        // GUI qualification is set only after the Driver conformance/capture probe.
        let profile = self
            .helper_call(
                reference,
                "qualification",
                Request::GuiProfile,
                &[],
                cli::HelperExecution {
                    timeout: Duration::from_secs(20),
                    cancel: cancel.clone(),
                    admission: None,
                },
            )
            .await;
        let identity = match profile.as_ref() {
            Ok((reply, _)) if gui_profile_ready(&reply.result) => {
                Some(profile_identity(&reply.result)?)
            }
            _ => None,
        };
        if let (Some(previous), Some(identity)) =
            (owned.driver_identity.as_ref(), identity.as_ref())
        {
            if !previous.same_artifact(identity)
                || (owned.driver_identity_epoch.as_deref() == Some(reference.boot_epoch.as_str())
                    && previous != identity)
            {
                return Err("lume_driver_identity_changed".into());
            }
        }
        let profile_ready = identity.as_ref().is_some_and(|identity| {
            approved_identity.is_some_and(|approved| {
                approved == identity
                    || (owned.driver_identity.as_ref() == Some(approved)
                        && owned.driver_identity_epoch.as_deref()
                            != Some(reference.boot_epoch.as_str())
                        && approved.same_artifact(identity))
            })
        });
        let schema = if profile_ready {
            self.driver_probe(
                reference,
                driver_version,
                cancel.clone(),
                identity.as_ref().ok_or("lume_driver_identity_missing")?,
            )
            .await
            .ok()
        } else {
            None
        };
        owned.projection.readiness.gui = schema.is_some();
        if schema.is_some() {
            if self.observe_driver_identity(reference).await.as_ref().ok() != identity.as_ref() {
                return Err("lume_driver_identity_changed".into());
            }
            owned.driver_schema_hash = schema;
            owned.driver_identity = identity;
            owned.driver_identity_epoch = Some(reference.boot_epoch.clone());
        }
        owned.projection.last_error_code = if owned.projection.readiness.gui {
            None
        } else {
            Some("lume_gui_unqualified".into())
        };
        if cancel.load(Ordering::SeqCst) {
            return Err("lume_operation_cancelled".into());
        }
        self.actor()?;
        self.commit_qualification(owned, cancel, admission).await
    }

    async fn commit_qualification(
        &self,
        owned: OwnedResource,
        cancel: Arc<AtomicBool>,
        admission: Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> Result<Resource, String> {
        let result = owned.projection.clone();
        let mut journal = self.journal.lock().await;
        journal.resource(&result.reference)?;
        if cancel.load(Ordering::SeqCst) {
            return Err("lume_operation_cancelled".into());
        }
        if !admission() || journal.resource(&result.reference)?.projection.quarantine {
            return Err("lume_qualification_revoked".into());
        }
        journal
            .data
            .resources
            .insert(result.reference.resource_id.clone(), owned);
        journal.save_async().await?;
        Ok(result)
    }

    pub(crate) async fn live_gui_profile(&self, reference: &ResourceRef) -> Result<(), String> {
        let result = self
            .helper_call(
                reference,
                "gui-profile",
                Request::GuiProfile,
                &[],
                cli::HelperExecution {
                    timeout: Duration::from_secs(20),
                    cancel: fresh_cancel(),
                    admission: Some(self.send_fence(reference, None)),
                },
            )
            .await;
        let expected = self
            .journal
            .lock()
            .await
            .resource(reference)?
            .driver_identity
            .clone();
        if !result.is_ok_and(|(reply, _)| {
            gui_profile_ready(&reply.result)
                && profile_identity(&reply.result)
                    .ok()
                    .as_ref()
                    .is_some_and(|identity| Some(identity) == expected.as_ref())
        }) {
            let _ = self.quarantine(reference, "lume_gui_profile_changed").await;
            return Err("lume_gui_profile_changed".into());
        }
        Ok(())
    }

    pub(crate) async fn observe_driver_identity(
        &self,
        reference: &ResourceRef,
    ) -> Result<lume::DriverIdentity, String> {
        let (reply, _) = self
            .helper_call(
                reference,
                "qualification-identity",
                Request::GuiProfile,
                &[],
                cli::HelperExecution {
                    timeout: Duration::from_secs(20),
                    cancel: fresh_cancel(),
                    admission: Some(self.send_fence(reference, None)),
                },
            )
            .await?;
        if !gui_profile_ready(&reply.result) {
            return Err("lume_gui_unqualified".into());
        }
        profile_identity(&reply.result)
    }

    pub async fn unbind(&self, binding: &BindingRef) -> Result<(), String> {
        let mut journal = self.journal.lock().await;
        let removed = journal
            .data
            .bindings
            .get(&binding.binding_id)
            .is_some_and(|b| b.reference == *binding);
        if removed {
            if let Some(token) = self.binding_tokens.lock().remove(&binding.binding_id) {
                token.store(false, Ordering::SeqCst);
            }
            journal.data.bindings.remove(&binding.binding_id);
        }
        let retirement = removed
            && !journal.data.bindings.values().any(|active| {
                active.reference.resource.resource_id == binding.resource.resource_id
            });
        let persistence = journal.save_async().await;
        drop(journal);
        if retirement {
            self.stop(&binding.resource).await?;
        }
        persistence
    }

    pub(crate) async fn bound(
        &self,
        reference: &BindingRef,
    ) -> Result<(OwnedResource, Binding), String> {
        self.bound_identity(reference, true).await
    }

    async fn bound_identity(
        &self,
        reference: &BindingRef,
        require_ready: bool,
    ) -> Result<(OwnedResource, Binding), String> {
        let journal = self.journal.lock().await;
        let owned = journal.resource(&reference.resource)?;
        let binding = journal
            .data
            .bindings
            .get(&reference.binding_id)
            .ok_or("lume_binding_revoked")?;
        if self
            .actor()?
            .map(|actor| actor.generation)
            .unwrap_or_default()
            != binding.account_generation
        {
            return Err("lume_account_changed".into());
        }
        if binding.reference != *reference
            || binding.session_id != reference.session_id
            || owned.approved_session_id.as_deref() != Some(reference.session_id.as_str())
            || !self
                .binding_tokens
                .lock()
                .get(&reference.binding_id)
                .is_some_and(|token| token.load(Ordering::SeqCst))
            || !journal.data.enabled
            || owned.projection.quarantine
            || (require_ready && !owned.projection.readiness.helper)
        {
            return Err("lume_binding_unavailable".into());
        }
        Ok((owned.clone(), binding.clone()))
    }

    async fn helper_call(
        &self,
        reference: &ResourceRef,
        binding_id: &str,
        request: Request,
        payload: &[u8],
        execution: cli::HelperExecution,
    ) -> Result<(lume::Reply, Vec<u8>), String> {
        let cli::HelperExecution {
            timeout,
            cancel,
            admission,
        } = execution;
        let (owned, inspected) = self.verify(reference, cancel.clone()).await?;
        if inspected.status != "running" {
            return Err("lume_vm_not_running".into());
        }
        let envelope = Envelope {
            version: lume::VERSION,
            operation_id: uuid::Uuid::new_v4().to_string(),
            instance_nonce: owned.instance_nonce.ok_or("lume_guest_identity_missing")?,
            binding_id: binding_id.into(),
            generation: reference.generation,
            boot_epoch: reference.boot_epoch.clone(),
            payload_len: payload.len(),
            request,
        };
        #[cfg(test)]
        {
            let peer = self.helper_peer.lock().clone();
            if let Some(peer) = peer {
                if cancel.load(Ordering::SeqCst) {
                    return Err("lume_process_cancelled".into());
                }
                if admission.as_ref().is_some_and(|check| !check()) {
                    return Err("lume_preempted_before_send".into());
                }
                return cli::decode_reply(&envelope, &peer(&envelope)?);
            }
        }
        let key = cognia_secrets::keyring_secrets::get("lume-ssh", &reference.resource_id)?
            .ok_or("lume_ssh_key_missing")?;
        let files = cli::SshFiles::new(
            &key,
            owned
                .ssh_host_key
                .as_deref()
                .ok_or("lume_ssh_trust_required")?,
        )?;
        cli::helper(
            &files,
            inspected.ip_address.ok_or("lume_guest_ip_missing")?,
            owned.ssh_user.as_deref().ok_or("lume_ssh_user_missing")?,
            &envelope,
            payload,
            cli::HelperExecution {
                timeout,
                cancel,
                admission,
            },
        )
        .await
    }

    pub(crate) async fn resolve_target(
        &self,
        target: &str,
    ) -> Result<Option<(ResourceRef, Option<BindingRef>, String)>, String> {
        let journal = self.journal.lock().await;
        if let Some(id) = target.strip_prefix("lume-binding:") {
            let binding = journal
                .data
                .bindings
                .get(id)
                .ok_or("lume_binding_revoked")?;
            let owned = journal.resource(&binding.reference.resource)?;
            return Ok(Some((
                owned.projection.reference.clone(),
                Some(binding.reference.clone()),
                owned.projection.connection_id.clone(),
            )));
        }
        Ok(journal
            .data
            .resources
            .values()
            .find(|r| r.projection.connection_id == target && r.projection.state != "uninitialized")
            .map(|r| {
                (
                    r.projection.reference.clone(),
                    None,
                    r.projection.connection_id.clone(),
                )
            }))
    }

    pub async fn execute(
        &self,
        request: ExecRequest,
        cancel: Arc<AtomicBool>,
        admission: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
    ) -> Result<serde_json::Value, String> {
        let (owned, binding) = self.bound(&request.binding).await?;
        let root = self.journal.lock().await.root.clone();
        if fs2::available_space(root).map_err(|_| "lume_capacity_unknown")?
            < 10 * 1024 * 1024 * 1024
        {
            return Err("lume_capacity_disk".into());
        }
        if request.network != "on"
            || request.max_cpu_seconds != 0
            || (request.max_memory_mb != 0 && owned.projection.memory_mb > request.max_memory_mb)
        {
            return Err("lume_policy_unsupported".into());
        }
        let within = |path: &str, roots: &[String]| {
            roots.iter().any(|root| {
                root == "."
                    || path == root
                    || path
                        .strip_prefix(root)
                        .is_some_and(|rest| rest.starts_with('/'))
            })
        };
        if binding.policy.readable.iter().any(|path| path != ".")
            || request.readable.iter().any(|path| path != ".")
        {
            return Err("lume_strict_read_scope_unqualified".into());
        }
        if request
            .readable
            .iter()
            .any(|path| !within(path, &binding.policy.readable))
            || request
                .writable
                .iter()
                .any(|path| !within(path, &binding.policy.writable))
        {
            return Err("lume_exec_scope".into());
        }
        if request.argv.is_empty()
            || request.argv.len() > 256
            || request.timeout_ms == 0
            || request.timeout_ms > 600_000
        {
            return Err("lume_exec_limits".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        self.retain_workspace_writers(&request.binding.resource)
            .await?;
        self.active.lock().await.insert(
            id.clone(),
            (
                Some(owned.projection.reference.resource_id.clone()),
                cancel.clone(),
            ),
        );
        let result = self
            .helper_call(
                &request.binding.resource,
                &request.binding.binding_id,
                Request::Exec {
                    argv: request.argv,
                    cwd: request.cwd,
                    env: request.env,
                    timeout_ms: request.timeout_ms,
                    readable: request.readable,
                    writable: request.writable,
                },
                request.stdin.as_deref().unwrap_or("").as_bytes(),
                cli::HelperExecution {
                    timeout: Duration::from_millis(request.timeout_ms + 2000),
                    cancel,
                    admission,
                },
            )
            .await;
        self.active.lock().await.remove(&id);
        match result {
            Ok((reply, _)) => {
                // Normal completion retains the exclusive execution group,
                // including background jobs. Only retirement/uncertainty
                // promises a descendant barrier, by confirming VM Stop.
                match normal_exec_receipt(reply.result) {
                    Ok((result, false)) => Ok(result),
                    Ok((_, true)) => Err(self
                        .contain_uncertain(
                            &owned.projection.reference,
                            "lume_exec_timeout_vm_stopped",
                        )
                        .await),
                    Err(code) => Err(self
                        .contain_uncertain(&owned.projection.reference, &code)
                        .await),
                }
            }
            Err(code) => {
                if code != "lume_preempted_before_send" {
                    return Err(self
                        .contain_uncertain(&owned.projection.reference, &code)
                        .await);
                }
                Err(code)
            }
        }
    }

    pub async fn file(
        &self,
        binding: BindingRef,
        operation: FileOperation,
        payload: Vec<u8>,
        cancel: Arc<AtomicBool>,
        admission: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
    ) -> Result<serde_json::Value, String> {
        let (owned, bound) = self.bound(&binding).await?;
        if operation.writes() && owned.unmanaged_writers {
            return Err("lume_workspace_writers_active".into());
        }
        let allowed = if operation.writes() {
            &bound.policy.writable
        } else {
            &bound.policy.readable
        };
        if !allowed.iter().any(|root| {
            root == "."
                || operation.path() == root
                || operation
                    .path()
                    .strip_prefix(root)
                    .is_some_and(|rest| rest.starts_with('/'))
        }) {
            return Err("lume_file_scope".into());
        }
        let result = self
            .helper_call(
                &binding.resource,
                &binding.binding_id,
                Request::File { operation },
                &payload,
                cli::HelperExecution {
                    timeout: Duration::from_secs(30),
                    cancel,
                    admission,
                },
            )
            .await;
        let (reply, payload) = match result {
            Ok(reply) => reply,
            Err(code) => {
                if !file_refused_before_publication(&code) {
                    return Err(self.contain_uncertain(&binding.resource, &code).await);
                }
                return Err(code);
            }
        };
        use base64::Engine;
        Ok(
            serde_json::json!({"result":reply.result,"dataBase64":base64::engine::general_purpose::STANDARD.encode(payload)}),
        )
    }

    pub async fn shutdown(&self) {
        let refs: Vec<_> = self
            .journal
            .lock()
            .await
            .data
            .resources
            .values()
            .filter(|r| r.projection.state != "uninitialized" && r.projection.state != "stopped")
            .map(|r| r.projection.reference.clone())
            .collect();
        for reference in refs {
            let _ = self.stop(&reference).await;
        }
    }

    pub(crate) async fn retain_workspace_writers(
        &self,
        reference: &ResourceRef,
    ) -> Result<(), String> {
        let mut journal = self.journal.lock().await;
        journal.resource(reference)?;
        journal
            .data
            .resources
            .get_mut(&reference.resource_id)
            .unwrap()
            .unmanaged_writers = true;
        journal.save_async().await
    }

    async fn monitor_setup(&self, reference: ResourceRef) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15 * 60);
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            if self.journal.lock().await.resource(&reference).is_err() {
                return;
            }
            let exited = self
                .children
                .lock()
                .await
                .get_mut(&reference.resource_id)
                .is_none_or(|child| child.try_wait().ok().flatten().is_some());
            if exited || tokio::time::Instant::now() >= deadline {
                let _ = self.stop(&reference).await;
                return;
            }
        }
    }

    async fn contain_uncertain(&self, reference: &ResourceRef, code: &str) -> String {
        let _ = self.quarantine(reference, code).await;
        match self.stop(reference).await {
            Ok(_) => code.into(),
            Err(error) if error == "lume_stopped_journal_recovery_required" => error,
            Err(_) => "lume_cleanup_unconfirmed".into(),
        }
    }

    pub(crate) async fn transfer_file(
        &self,
        reference: &ResourceRef,
        path: &str,
        bytes: Option<Vec<u8>>,
        admission: Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> Result<Vec<u8>, String> {
        let logical = path
            .strip_prefix("/workspace/")
            .ok_or("lume_transfer_workspace_path")?;
        let owned = {
            let journal = self.journal.lock().await;
            if !journal.data.enabled {
                return Err("lume_feature_disabled".into());
            }
            journal.resource(reference)?.clone()
        };
        if !owned.projection.readiness.helper || owned.projection.quarantine {
            return Err("lume_helper_unqualified".into());
        }
        if bytes.is_some() && owned.unmanaged_writers {
            return Err("lume_workspace_writers_active".into());
        }
        let operation = if bytes.is_some() {
            FileOperation::WriteNew {
                path: logical.into(),
            }
        } else {
            FileOperation::Read {
                path: logical.into(),
            }
        };
        let result = self
            .helper_call(
                reference,
                "human-transfer",
                Request::File { operation },
                bytes.as_deref().unwrap_or_default(),
                cli::HelperExecution {
                    timeout: Duration::from_secs(10),
                    cancel: fresh_cancel(),
                    admission: Some(admission),
                },
            )
            .await;
        match result {
            Ok((_, payload)) => Ok(payload),
            Err(code) => {
                if !file_refused_before_publication(&code) {
                    let _ = self.quarantine(reference, &code).await;
                    let _ = self.stop(reference).await;
                }
                Err(code)
            }
        }
    }
}

fn gui_profile_ready(profile: &serde_json::Value) -> bool {
    profile["consoleUidMatches"] == true
        && profile["autoLoginMatches"] == true
        && profile["fileVaultOff"] == true
        && profile["locked"] == false
        && profile["autoLaunch"] == true
        && profile["permissions"]["accessibility"] == true
        && profile["permissions"]["screen_recording"] == true
        && profile["permissions"]["source"]["attribution"] == "driver-daemon"
}

fn profile_identity(profile: &serde_json::Value) -> Result<lume::DriverIdentity, String> {
    let identity: lume::DriverIdentity = serde_json::from_value(profile["driverIdentity"].clone())
        .map_err(|_| "lume_driver_identity_missing")?;
    identity
        .validate()
        .map_err(|_| "lume_driver_identity_invalid")?;
    if profile["permissions"]["source"]["bundle_id"] != "com.trycua.driver"
        || profile["permissions"]["source"]["executable"] != lume::DRIVER_EXECUTABLE
    {
        return Err("lume_driver_daemon_identity".into());
    }
    Ok(identity)
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    fn driver_identity_fixture() -> lume::DriverIdentity {
        lume::DriverIdentity {
            executable: lume::DRIVER_EXECUTABLE.into(),
            executable_hash: "1".repeat(64),
            team_id: "TEAM123456".into(),
            designated_requirement: "identifier \"com.trycua.driver\" and anchor apple generic"
                .into(),
            code_hash: "2".repeat(40),
            daemon_pid: 42,
            daemon_uid: 501,
        }
    }
    #[cfg(unix)]
    async fn bound_fixture() -> (
        tempfile::TempDir,
        tempfile::TempDir,
        Arc<Service>,
        ResourceRef,
        BindingRef,
    ) {
        let (root, service, reference) = lifecycle_fixture().await;
        let source_root = tempfile::tempdir().unwrap();
        std::fs::write(source_root.path().join("a"), "original").unwrap();
        let (source, _) = super::super::workspace::prepare(source_root.path()).unwrap();
        service
            .journal
            .lock()
            .await
            .data
            .resources
            .get_mut(&reference.resource_id)
            .unwrap()
            .workspace = Some(source);
        let policy = BindingPolicy {
            group_id: "caller-group".into(),
            workspace_root: source_root.path().to_string_lossy().into(),
            network: "on".into(),
            max_cpu_seconds: 0,
            max_memory_mb: 0,
            readable: vec![".".into()],
            writable: vec![".".into()],
        };
        let binding = service
            .bind(
                reference.clone(),
                "session".into(),
                policy,
                std::future::ready(true),
            )
            .await
            .unwrap();
        (root, source_root, service, reference, binding)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stop_settlement_rejects_a_late_spawn_with_an_old_epoch() {
        let (_root, service, reference) = lifecycle_fixture().await;
        let owned = service
            .journal
            .lock()
            .await
            .resource(&reference)
            .unwrap()
            .clone();
        let (binary, storage) = service.binary(true).await.unwrap();
        service.stop(&reference).await.unwrap();
        assert_eq!(
            service
                .spawn_vm(&binary, &storage, &owned, false, fresh_cancel())
                .await
                .unwrap_err(),
            "lume_boot_interrupted"
        );
        assert!(service.children.lock().await.is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stop_preempts_a_spawn_waiting_at_the_registration_gate() {
        let (_root, service, reference) = lifecycle_fixture().await;
        let owned = service
            .journal
            .lock()
            .await
            .resource(&reference)
            .unwrap()
            .clone();
        let (binary, storage) = service.binary(true).await.unwrap();
        let gate = service.spawn_gate.lock().await;
        let cancel = fresh_cancel();
        service.active.lock().await.insert(
            "start".into(),
            (Some(reference.resource_id.clone()), cancel.clone()),
        );
        let spawn = {
            let service = service.clone();
            let cancel = cancel.clone();
            tokio::spawn(async move {
                service
                    .spawn_vm(&binary, &storage, &owned, false, cancel)
                    .await
            })
        };
        tokio::task::yield_now().await;
        let stop = {
            let service = service.clone();
            tokio::spawn(async move { service.stop(&reference).await })
        };
        tokio::time::timeout(Duration::from_secs(2), async {
            while !cancel.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        drop(gate);
        assert_eq!(spawn.await.unwrap().unwrap_err(), "lume_boot_interrupted");
        assert_eq!(stop.await.unwrap().unwrap().state, "stopped");
        assert!(service.children.lock().await.is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn binding_requires_native_approval_and_rejects_self_asserted_group_membership() {
        let (_root, source, service, reference, binding) = bound_fixture().await;
        let policy = service.journal.lock().await.data.bindings[&binding.binding_id]
            .policy
            .clone();
        assert_ne!(policy.group_id, "caller-group");
        assert_eq!(
            service
                .bind(
                    reference.clone(),
                    "session".into(),
                    policy.clone(),
                    std::future::ready(false)
                )
                .await
                .unwrap_err(),
            "lume_authorization_denied"
        );
        assert_eq!(
            service
                .bind(
                    reference,
                    "other-session".into(),
                    policy,
                    std::future::ready(true)
                )
                .await
                .unwrap_err(),
            "lume_group_retired"
        );
        let mut borrowed = binding.clone();
        borrowed.session_id = "other-session".into();
        assert!(service.bound(&borrowed).await.is_err());
        service.unbind(&borrowed).await.unwrap();
        assert!(service.bound(&binding).await.is_ok());
        assert!(source.path().join("a").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn binding_watchdog_stops_retained_work_after_heartbeat_loss() {
        let (root, _source, service, reference, binding) = bound_fixture().await;
        service.retain_workspace_writers(&reference).await.unwrap();
        service.renew_binding(&binding).await.unwrap();
        let fence = service.send_fence(&reference, Some(&binding));
        *service.binding_tokens.lock()[&binding.binding_id]
            .deadline
            .lock() = std::time::Instant::now() - Duration::from_secs(1);
        assert!(!fence());
        assert!(service.bound(&binding).await.is_err());
        assert!(service.renew_binding(&binding).await.is_err());
        tokio::time::timeout(Duration::from_secs(4), async {
            while !root.path().join("stop-called").exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert!(service.journal.lock().await.data.bindings.is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn qualification_readiness_does_not_expire_a_live_session_lease() {
        let (_root, _source, service, reference, binding) = bound_fixture().await;
        service
            .journal
            .lock()
            .await
            .data
            .resources
            .get_mut(&reference.resource_id)
            .unwrap()
            .projection
            .readiness = Readiness::default();
        assert!(service.bound(&binding).await.is_err());
        service.renew_binding(&binding).await.unwrap();
        assert!(service.send_fence(&reference, Some(&binding))());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn retained_writers_refuse_typed_mutation_and_upload_before_any_guest_send() {
        let (root, _source, service, reference, binding) = bound_fixture().await;
        service.retain_workspace_writers(&reference).await.unwrap();
        *service.helper_peer.lock() = Some(Arc::new(|_| {
            panic!("a retained writer must exclude typed writes")
        }));
        let operation = FileOperation::Replace {
            path: "a".into(),
            expected_hash: lume::content_hash(b"original"),
            old: "original".into(),
            new: "typed".into(),
        };
        assert_eq!(
            service
                .file(binding, operation, vec![], fresh_cancel(), None)
                .await
                .unwrap_err(),
            "lume_workspace_writers_active"
        );
        assert_eq!(
            service
                .transfer_file(
                    &reference,
                    "/workspace/a",
                    Some(b"upload".to_vec()),
                    Arc::new(|| true)
                )
                .await
                .unwrap_err(),
            "lume_workspace_writers_active"
        );
        std::fs::write(root.path().join("refuse-stop"), "1").unwrap();
        assert!(service.stop(&reference).await.is_err());
        assert!(
            service.journal.lock().await.data.resources[&reference.resource_id].unmanaged_writers
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn shell_dispatch_durably_marks_writers_before_send_and_excludes_typed_writes() {
        let (root, _source, service, reference, binding) = bound_fixture().await;
        let journal_path = root.path().join("journal.json");
        let resource_id = reference.resource_id.clone();
        let sends = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let sent = sends.clone();
        *service.helper_peer.lock() = Some(Arc::new(move |request| {
            assert!(matches!(request.request, Request::Exec { .. }));
            let durable: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&journal_path).unwrap()).unwrap();
            assert_eq!(
                durable["resources"][&resource_id]["unmanaged_writers"],
                true
            );
            sent.fetch_add(1, Ordering::SeqCst);
            let reply = lume::Reply {
                version: lume::VERSION,
                operation_id: request.operation_id.clone(),
                payload_len: 0,
                result: serde_json::json!({"exitCode":0,"stdout":"","stderr":"","durationMs":0,"timedOut":false,"stdoutTruncated":false,"stderrTruncated":false}),
                error_code: None,
            };
            let mut bytes = vec![];
            lume::write_frame(&mut bytes, &reply, &[])?;
            Ok(bytes)
        }));
        service
            .execute(
                ExecRequest {
                    binding: binding.clone(),
                    argv: vec!["/bin/true".into()],
                    cwd: ".".into(),
                    env: Default::default(),
                    stdin: None,
                    timeout_ms: 1000,
                    network: "on".into(),
                    max_cpu_seconds: 0,
                    max_memory_mb: 0,
                    readable: vec![".".into()],
                    writable: vec![".".into()],
                },
                fresh_cancel(),
                None,
            )
            .await
            .unwrap();
        assert_eq!(
            service
                .file(
                    binding,
                    FileOperation::Write {
                        path: "a".into(),
                        expected_hash: Some(lume::content_hash(b"original"))
                    },
                    b"typed".to_vec(),
                    fresh_cancel(),
                    None,
                )
                .await
                .unwrap_err(),
            "lume_workspace_writers_active"
        );
        assert_eq!(
            service
                .transfer_file(
                    &reference,
                    "/workspace/new",
                    Some(vec![]),
                    Arc::new(|| true)
                )
                .await
                .unwrap_err(),
            "lume_workspace_writers_active"
        );
        assert_eq!(sends.load(Ordering::SeqCst), 1);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn confirmed_stop_preserves_retained_writers_that_may_restart_on_boot() {
        let (_root, _source, service, reference, _binding) = bound_fixture().await;
        service.retain_workspace_writers(&reference).await.unwrap();
        let stopped = service.stop(&reference).await.unwrap();
        assert_eq!(stopped.state, "stopped");
        assert!(
            service.journal.lock().await.data.resources[&reference.resource_id].unmanaged_writers
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stale_cleanup_cannot_cancel_current_boot_but_explicit_stop_can() {
        let (_root, _source, service, previous, _binding) = bound_fixture().await;
        let current = service
            .rotate_epoch(&previous)
            .await
            .unwrap()
            .projection
            .reference;
        let cancelled = fresh_cancel();
        service.active.lock().await.insert(
            "current-operation".into(),
            (Some(current.resource_id.clone()), cancelled.clone()),
        );
        assert_eq!(
            service.stop(&previous).await.unwrap_err(),
            "lume_stale_resource"
        );
        assert!(!cancelled.load(Ordering::SeqCst));
        let stopped = service.stop_inner(&previous, None, true).await.unwrap();
        assert_eq!(stopped.state, "stopped");
        assert!(cancelled.load(Ordering::SeqCst));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn disabling_preserves_watchdog_cleanup_for_retained_work() {
        for refuses_stop in [false, true] {
            let (root, _source, service, reference, binding) = bound_fixture().await;
            service.retain_workspace_writers(&reference).await.unwrap();
            assert!(service.active.lock().await.is_empty());
            if refuses_stop {
                std::fs::write(root.path().join("refuse-stop"), "1").unwrap();
            }
            service
                .configure(PathBuf::from("/missing/lume"), false)
                .await
                .unwrap();
            assert!(service.renew_binding(&binding).await.is_err());
            tokio::time::timeout(Duration::from_secs(4), async {
                loop {
                    let journal = service.journal.lock().await;
                    let resource = &journal.data.resources[&reference.resource_id].projection;
                    if root.path().join("stop-called").exists()
                        && if refuses_stop {
                            resource.quarantine
                        } else {
                            resource.state == "stopped"
                        }
                    {
                        break;
                    }
                    drop(journal);
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("disabling must retain the native cleanup owner");
            let journal = service.journal.lock().await;
            assert!(journal.data.bindings.is_empty());
            assert_eq!(
                journal.data.resources[&reference.resource_id]
                    .projection
                    .quarantine,
                refuses_stop
            );
            let durable: serde_json::Value =
                serde_json::from_slice(&std::fs::read(root.path().join("journal.json")).unwrap())
                    .unwrap();
            assert_eq!(
                durable["resources"][&reference.resource_id]["projection"]["quarantine"],
                refuses_stop
            );
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn post_publication_guest_error_requires_confirmed_stop_for_files_and_uploads() {
        for upload in [false, true] {
            let (root, _source, service, reference, binding) = bound_fixture().await;
            *service.helper_peer.lock() = Some(Arc::new(|request| {
                let reply = lume::Reply {
                    version: lume::VERSION,
                    operation_id: request.operation_id.clone(),
                    payload_len: 0,
                    result: serde_json::Value::Null,
                    error_code: Some("file_sync".into()),
                };
                let mut bytes = vec![];
                lume::write_frame(&mut bytes, &reply, &[])?;
                Ok(bytes)
            }));
            let code = if upload {
                service
                    .transfer_file(&reference, "/workspace/a", Some(vec![]), Arc::new(|| true))
                    .await
                    .unwrap_err()
            } else {
                service
                    .file(
                        binding,
                        FileOperation::Write {
                            path: "a".into(),
                            expected_hash: None,
                        },
                        vec![],
                        fresh_cancel(),
                        None,
                    )
                    .await
                    .unwrap_err()
            };
            assert_eq!(code, "lume_guest_file_sync");
            assert!(root.path().join("stop-called").exists());
            assert_eq!(service.snapshot().await["resources"][0]["state"], "stopped");
        }
    }

    #[test]
    fn post_publication_errors_are_not_safe_guest_refusals() {
        assert!(file_refused_before_publication("lume_guest_file_conflict"));
        for code in [
            "lume_guest_file_sync",
            "lume_guest_unknown",
            "lume_helper_protocol",
        ] {
            assert!(!file_refused_before_publication(code));
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn live_gui_identity_change_revokes_before_input_even_with_unchanged_permissions() {
        let (_root, _source, service, reference, binding) = bound_fixture().await;
        let mut profile = serde_json::json!({"consoleUidMatches":true,"autoLoginMatches":true,"fileVaultOff":true,"locked":false,"autoLaunch":true,
            "permissions":{"accessibility":true,"screen_recording":true,"source":{"attribution":"driver-daemon","bundle_id":"com.trycua.driver","executable":lume::DRIVER_EXECUTABLE}},"driverIdentity":driver_identity_fixture()});
        let shared = Arc::new(parking_lot::Mutex::new(profile.clone()));
        {
            let shared = shared.clone();
            *service.helper_peer.lock() = Some(Arc::new(move |request| {
                let reply = lume::Reply {
                    version: lume::VERSION,
                    operation_id: request.operation_id.clone(),
                    payload_len: 0,
                    result: shared.lock().clone(),
                    error_code: None,
                };
                let mut bytes = vec![];
                lume::write_frame(&mut bytes, &reply, &[])?;
                Ok(bytes)
            }));
        }
        service
            .journal
            .lock()
            .await
            .data
            .resources
            .get_mut(&reference.resource_id)
            .unwrap()
            .driver_identity = Some(driver_identity_fixture());
        service.live_gui_profile(&reference).await.unwrap();
        profile["driverIdentity"]["executableHash"] = serde_json::json!("f".repeat(64));
        *shared.lock() = profile;
        assert_eq!(
            service.live_gui_profile(&reference).await.unwrap_err(),
            "lume_gui_profile_changed"
        );
        assert!(service.bound(&binding).await.is_err());
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn revoked_spawn_never_launches_a_foreground_vm() {
        let (_root, service, reference) = lifecycle_fixture().await;
        let owned = service
            .journal
            .lock()
            .await
            .resource(&reference)
            .unwrap()
            .clone();
        let (binary, storage) = service.binary(true).await.unwrap();
        let cancel = Arc::new(AtomicBool::new(true));
        assert_eq!(
            service
                .spawn_vm(&binary, &storage, &owned, false, cancel)
                .await
                .unwrap_err(),
            "lume_boot_interrupted"
        );
        assert!(service.children.lock().await.is_empty());
    }
    #[cfg(unix)]
    pub(crate) async fn lifecycle_fixture() -> (tempfile::TempDir, Arc<Service>, ResourceRef) {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let binary = root.path().join("fake-lume");
        std::fs::write(
            &binary,
            br##"#!/bin/sh
root=$(dirname "$0")
case "$1" in
get)
  if [ -e "$root/block-get" ]; then
    touch "$root/get-entered"
    while [ ! -e "$root/release-get" ]; do sleep 0.02; done
  fi
  [ -d "$root/vms/cognia-test" ] || exit 1
  cat "$root/inspection.json";;
stop)
  touch "$root/stop-called"
  [ -e "$root/refuse-stop" ] || cp "$root/stopped.json" "$root/inspection.json";;
delete)
  touch "$root/delete-called"
  [ -e "$root/retain-delete" ] || rm -rf "$root/vms/cognia-test"
  [ ! -e "$root/delete-error" ] || exit 1;;
*) exit 2;;
esac
"##,
        )
        .unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        let inspection = serde_json::json!([{"name":"cognia-test","status":"running","memorySize":8589934592u64,"cpuCount":4,"display":"1024x768","machineIdentifier":"machine","macAddress":"aa:bb","ipAddress":null}]);
        std::fs::write(root.path().join("inspection.json"), inspection.to_string()).unwrap();
        let mut stopped = inspection.clone();
        stopped[0]["status"] = serde_json::json!("stopped");
        std::fs::write(root.path().join("stopped.json"), stopped.to_string()).unwrap();
        let service = Service::open(root.path().into()).unwrap();
        let vm = root.path().join("vms/cognia-test");
        std::fs::create_dir_all(&vm).unwrap();
        std::fs::write(vm.join("disk.img"), b"disk").unwrap();
        std::fs::write(vm.join("nvram.bin"), b"nvram").unwrap();
        let mut owned = test_resource();
        owned.disk = Some(identity(&vm.join("disk.img")).unwrap());
        owned.nvram = Some(identity(&vm.join("nvram.bin")).unwrap());
        owned.immutable_config_hash = Some(
            serde_json::from_value::<Vec<cli::Inspection>>(inspection).unwrap()[0]
                .config_hash()
                .unwrap(),
        );
        owned.instance_nonce = Some("nonce".into());
        owned.helper_hash = Some("0".repeat(64));
        owned.driver_version = Some("approved".into());
        owned.driver_schema_hash = Some("schema".into());
        let reference = owned.projection.reference.clone();
        {
            let mut journal = service.journal.lock().await;
            journal.data.enabled = true;
            journal.data.binary_hash = Some(cli::binary_hash(&binary).unwrap());
            journal.data.binary = Some(binary);
            journal
                .data
                .resources
                .insert(reference.resource_id.clone(), owned);
            journal.save_async().await.unwrap();
        }
        (root, service, reference)
    }
    #[tokio::test]
    async fn stale_cleanup_cannot_quarantine_a_new_boot() {
        let root = tempfile::tempdir().unwrap();
        let service = Service::open(root.path().into()).unwrap();
        let resource = test_resource();
        let reference = resource.projection.reference.clone();
        service.store(resource).await.unwrap();
        let fence = service.send_fence(&reference, None);
        let old = ResourceRef {
            boot_epoch: "older-boot".into(),
            ..reference.clone()
        };
        assert_eq!(
            service
                .quarantine(&old, "lume_driver_interrupted")
                .await
                .unwrap_err(),
            "lume_stale_resource"
        );
        assert!(fence());
        let journal = service.journal.lock().await;
        assert!(
            journal
                .resource(&reference)
                .unwrap()
                .projection
                .readiness
                .gui
        );
        assert!(!journal.resource(&reference).unwrap().projection.quarantine);
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn failed_requalification_revokes_the_previous_ready_receipt() {
        let (_root, service, reference) = lifecycle_fixture().await;
        let fence = service.send_fence(&reference, None);
        assert!(service
            .qualify(
                &reference,
                &"0".repeat(64),
                "approved",
                fresh_cancel(),
                None
            )
            .await
            .is_err());
        assert!(!fence());
        let journal = service.journal.lock().await;
        let resource = journal.resource(&reference).unwrap();
        assert!(!resource.projection.readiness.helper);
        assert!(!resource.projection.readiness.gui);
        assert_eq!(resource.driver_schema_hash.as_deref(), Some("schema"));
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn healthy_shell_rechecks_preserve_bindings_and_failed_gui_probes_keep_the_schema_pin() {
        let (_root, service, reference) = lifecycle_fixture().await;
        let source_root = tempfile::tempdir().unwrap();
        std::fs::write(source_root.path().join("a"), b"source").unwrap();
        let (source, _) = super::super::workspace::prepare(source_root.path()).unwrap();
        let policy = BindingPolicy {
            group_id: "task".into(),
            workspace_root: source.root.to_string_lossy().into_owned(),
            network: "on".into(),
            max_cpu_seconds: 0,
            max_memory_mb: 0,
            readable: vec![".".into()],
            writable: vec![".".into()],
        };
        service
            .journal
            .lock()
            .await
            .data
            .resources
            .get_mut("r")
            .unwrap()
            .workspace = Some(source);
        let binding = service
            .bind(
                reference.clone(),
                "session".into(),
                policy,
                std::future::ready(true),
            )
            .await
            .unwrap();
        let fence = service.send_fence(&reference, Some(&binding));
        let gui_ready = Arc::new(AtomicBool::new(false));
        let wrong_hash = Arc::new(AtomicBool::new(false));
        let gui = gui_ready.clone();
        let wrong = wrong_hash.clone();
        *service.helper_peer.lock() = Some(Arc::new(move |request| {
            let result = match request.request {
                Request::Hello => {
                    serde_json::json!({"version":lume::VERSION,"helperHash":if wrong.load(Ordering::SeqCst) {"1".repeat(64)} else {"0".repeat(64)},"platform":"darwin"})
                }
                Request::GuiProfile => {
                    serde_json::json!({"consoleUidMatches":true,"autoLoginMatches":true,"fileVaultOff":true,"locked":false,"autoLaunch":true,"permissions":{"accessibility":true,"screen_recording":gui.load(Ordering::SeqCst),"source":{"attribution":"driver-daemon","bundle_id":"com.trycua.driver","executable":lume::DRIVER_EXECUTABLE}},"driverIdentity":driver_identity_fixture()})
                }
                _ => return Err("unexpected_fixture_request".into()),
            };
            let reply = lume::Reply {
                version: lume::VERSION,
                operation_id: request.operation_id.clone(),
                payload_len: 0,
                result,
                error_code: None,
            };
            let mut bytes = Vec::new();
            lume::write_frame(&mut bytes, &reply, &[])?;
            Ok(bytes)
        }));
        for operation in [
            Operation::Health {
                reference: reference.clone(),
            },
            Operation::Connect {
                reference: reference.clone(),
            },
        ] {
            let result = service
                .perform("recheck", operation, fresh_cancel())
                .await
                .unwrap();
            assert!(result.readiness.helper);
            assert!(!result.readiness.gui);
            assert!(service.bound(&binding).await.is_ok());
            assert!(fence());
            assert_eq!(
                service
                    .journal
                    .lock()
                    .await
                    .resource(&reference)
                    .unwrap()
                    .driver_schema_hash
                    .as_deref(),
                Some("schema")
            );
            // The second recheck reaches Driver negotiation; this fixture has
            // no SSH credential/IP, so that probe fails without a network call.
            gui_ready.store(true, Ordering::SeqCst);
        }
        wrong_hash.store(true, Ordering::SeqCst);
        assert_eq!(
            service
                .qualify(
                    &reference,
                    &"0".repeat(64),
                    "approved",
                    fresh_cancel(),
                    None
                )
                .await
                .unwrap_err(),
            "lume_helper_unqualified"
        );
        assert!(!fence());
        assert!(service.bound(&binding).await.is_err());
        assert_eq!(
            service
                .journal
                .lock()
                .await
                .resource(&reference)
                .unwrap()
                .driver_schema_hash
                .as_deref(),
            Some("schema")
        );
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn qualification_commit_rechecks_cancellation_and_quarantine_inside_the_lock() {
        for revoked in [false, true] {
            let (_root, service, reference) = lifecycle_fixture().await;
            let owned = service
                .journal
                .lock()
                .await
                .resource(&reference)
                .unwrap()
                .clone();
            let admission = service.send_fence(&reference, None);
            if revoked {
                service
                    .quarantine(&reference, "lume_gui_profile_changed")
                    .await
                    .unwrap();
            }
            let mut journal = service.journal.lock().await;
            journal
                .data
                .resources
                .get_mut("r")
                .unwrap()
                .projection
                .readiness = Readiness::default();
            let cancel = fresh_cancel();
            let work = {
                let service = service.clone();
                let cancel = cancel.clone();
                tokio::spawn(
                    async move { service.commit_qualification(owned, cancel, admission).await },
                )
            };
            tokio::task::yield_now().await;
            if !revoked {
                cancel.store(true, Ordering::SeqCst);
            }
            drop(journal);
            assert_eq!(
                work.await.unwrap().unwrap_err(),
                if revoked {
                    "lume_qualification_revoked"
                } else {
                    "lume_operation_cancelled"
                }
            );
            assert!(
                !service
                    .journal
                    .lock()
                    .await
                    .resource(&reference)
                    .unwrap()
                    .projection
                    .readiness
                    .helper
            );
        }
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn stop_never_retires_absence_until_the_lifecycle_child_is_settled() {
        let (root, service, reference) = lifecycle_fixture().await;
        std::fs::remove_dir_all(root.path().join("vms/cognia-test")).unwrap();
        {
            let mut journal = service.journal.lock().await;
            let reservation = journal.data.resources.get_mut("r").unwrap();
            reservation.projection.state = "creating".into();
            reservation.projection.quarantine = true;
            reservation.disk = None;
            reservation.nvram = None;
            reservation.immutable_config_hash = None;
        }
        let writer = service.writer.lock().await;
        assert_eq!(
            service.stop(&reference).await.unwrap_err(),
            "lume_lifecycle_cleanup_pending"
        );
        assert_eq!(
            service.snapshot().await["resources"][0]["state"],
            "creating"
        );
        drop(writer);
        assert_eq!(
            service.stop(&reference).await.unwrap().state,
            "uninitialized"
        );
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn running_qualification_observes_cancellation_before_readiness_commit() {
        let (root, service, reference) = lifecycle_fixture().await;
        std::fs::write(root.path().join("block-get"), b"1").unwrap();
        let cancel = fresh_cancel();
        let work = {
            let service = service.clone();
            let reference = reference.clone();
            let cancel = cancel.clone();
            tokio::spawn(async move {
                service
                    .qualify(&reference, &"0".repeat(64), "approved", cancel, None)
                    .await
            })
        };
        tokio::time::timeout(Duration::from_secs(2), async {
            while !root.path().join("get-entered").exists() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        cancel.store(true, Ordering::SeqCst);
        let result = tokio::time::timeout(Duration::from_secs(2), work)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.unwrap_err(), "lume_process_cancelled");
        let journal = service.journal.lock().await;
        assert!(
            !journal
                .resource(&reference)
                .unwrap()
                .projection
                .readiness
                .helper
        );
        assert!(
            !journal
                .resource(&reference)
                .unwrap()
                .projection
                .readiness
                .gui
        );
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn failed_live_profile_revokes_gui_authority_before_any_input() {
        let (_root, service, reference) = lifecycle_fixture().await;
        let fence = service.send_fence(&reference, None);
        assert_eq!(
            service.live_gui_profile(&reference).await.unwrap_err(),
            "lume_gui_profile_changed"
        );
        assert!(!fence());
        let journal = service.journal.lock().await;
        assert!(journal.resource(&reference).unwrap().projection.quarantine);
        assert!(
            !journal
                .resource(&reference)
                .unwrap()
                .projection
                .readiness
                .gui
        );
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn failed_vm_inspection_revokes_the_last_ready_receipt() {
        let (root, service, reference) = lifecycle_fixture().await;
        let fence = service.send_fence(&reference, None);
        std::fs::write(root.path().join("inspection.json"), b"invalid json").unwrap();
        assert_eq!(
            service
                .perform(
                    "health",
                    Operation::Health {
                        reference: reference.clone()
                    },
                    fresh_cancel()
                )
                .await
                .unwrap_err(),
            "lume_inspect_schema"
        );
        assert!(!fence());
        let journal = service.journal.lock().await;
        assert!(journal.resource(&reference).unwrap().projection.quarantine);
        assert!(
            !journal
                .resource(&reference)
                .unwrap()
                .projection
                .readiness
                .gui
        );
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn equivalent_ssh_host_keys_cannot_be_reused_by_a_clone() {
        use base64::Engine;
        let (_root, service, reference) = lifecycle_fixture().await;
        let mut wire = vec![0, 0, 0, 11];
        wire.extend_from_slice(b"ssh-ed25519");
        wire.extend_from_slice(&[0, 0, 0, 32]);
        wire.extend_from_slice(&[7; 32]);
        let key = base64::engine::general_purpose::STANDARD.encode(wire);
        let mut other = test_resource();
        other.projection.reference.resource_id = "other".into();
        other.ssh_host_key = Some(format!("ssh-ed25519 {key}"));
        service.store(other).await.unwrap();
        assert_eq!(
            service
                .trust_ssh(
                    &reference,
                    format!("  ssh-ed25519\t{key}  "),
                    "lume".into(),
                    fresh_cancel()
                )
                .await
                .unwrap_err(),
            "lume_clone_host_key_reused"
        );
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn interrupted_delete_reconciles_a_confirmed_absent_vm() {
        let (root, service, reference) = lifecycle_fixture().await;
        std::fs::write(root.path().join("delete-error"), b"1").unwrap();
        let result = service
            .perform("delete", Operation::Delete { reference }, fresh_cancel())
            .await
            .unwrap();
        assert_eq!(result.state, "uninitialized");
        assert!(!root.path().join("vms/cognia-test").exists());
        assert!(service.resolve_target("c").await.unwrap().is_none());
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn exited_foreground_children_do_not_consume_vm_slots() {
        let root = tempfile::tempdir().unwrap();
        let service = Service::open(root.path().into()).unwrap();
        for id in ["first", "second"] {
            let mut child = cli::command(std::path::Path::new("/usr/bin/true"), &[])
                .spawn()
                .unwrap();
            child.wait().await.unwrap();
            service.children.lock().await.insert(id.into(), child);
        }
        assert_eq!(service.running_vm_count().await, 0);
        assert!(service.children.lock().await.is_empty());
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn absence_without_intent_and_dangling_vm_symlinks_never_retire_ownership() {
        for dangling in [false, true] {
            let (root, service, reference) = lifecycle_fixture().await;
            let vm = root.path().join("vms/cognia-test");
            std::fs::remove_dir_all(&vm).unwrap();
            if dangling {
                service
                    .journal
                    .lock()
                    .await
                    .data
                    .resources
                    .get_mut("r")
                    .unwrap()
                    .projection
                    .state = "deleting".into();
                std::os::unix::fs::symlink(root.path().join("missing"), &vm).unwrap();
            }
            assert!(service
                .perform("delete", Operation::Delete { reference }, fresh_cancel())
                .await
                .is_err());
            assert_ne!(
                service.snapshot().await["resources"][0]["state"],
                "uninitialized"
            );
            assert!(!root.path().join("delete-called").exists());
            if dangling {
                assert!(vm.symlink_metadata().unwrap().file_type().is_symlink());
            }
        }
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn delete_refuses_an_unconfirmed_stop_or_remaining_disk() {
        for retain in [false, true] {
            let (root, service, reference) = lifecycle_fixture().await;
            std::fs::write(
                root.path().join(if retain {
                    "retain-delete"
                } else {
                    "refuse-stop"
                }),
                b"1",
            )
            .unwrap();
            let code = service
                .perform("delete", Operation::Delete { reference }, fresh_cancel())
                .await
                .unwrap_err();
            assert_eq!(
                code,
                if retain {
                    "lume_delete_unconfirmed"
                } else {
                    "lume_stop_unconfirmed"
                }
            );
            assert_eq!(root.path().join("delete-called").exists(), retain);
            let journal = service.journal.lock().await;
            assert_ne!(
                journal.data.resources["r"].projection.state,
                "uninitialized"
            );
            assert!(journal.data.resources["r"].projection.quarantine);
            assert!(root.path().join("vms/cognia-test/disk.img").exists());
        }
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn failed_creation_can_retire_only_a_confirmed_absent_reservation() {
        for partial in [false, true] {
            let (root, service, reference) = lifecycle_fixture().await;
            {
                let mut journal = service.journal.lock().await;
                let resource = journal.data.resources.get_mut("r").unwrap();
                resource.projection.state = "creating".into();
                resource.projection.quarantine = true;
                resource.disk = None;
                resource.nvram = None;
                resource.immutable_config_hash = None;
            }
            if !partial {
                std::fs::remove_dir_all(root.path().join("vms/cognia-test")).unwrap();
            }
            let result = service
                .perform("retire", Operation::Delete { reference }, fresh_cancel())
                .await;
            if partial {
                assert!(result.is_err());
                assert!(root.path().join("vms/cognia-test/disk.img").exists());
                assert!(!root.path().join("delete-called").exists());
            } else {
                assert_eq!(result.unwrap().state, "uninitialized");
                assert!(!root.path().join("delete-called").exists());
            }
        }
    }
    #[test]
    fn desktop_dispatch_preserves_stable_codes_without_exposing_permission_details() {
        use crate::automation::types::AutomationError;
        assert_eq!(
            desktop_operation_error(AutomationError::BackendError {
                message: "lume_workspace_limit".into()
            }),
            "lume_workspace_limit"
        );
        assert_eq!(
            desktop_operation_error(AutomationError::PreemptedBeforeSend),
            "lume_preempted_before_send"
        );
        assert_eq!(
            desktop_operation_error(AutomationError::PermissionDenied {
                reason: "private path".into()
            }),
            "lume_desktop_control_unavailable"
        );
    }
    #[tokio::test]
    async fn pending_approval_cancellation_reports_cancelled_without_dispatch() {
        let root = tempfile::tempdir().unwrap();
        let service = Service::open(root.path().into()).unwrap();
        let operation = service
            .begin(
                "cancel-approval".into(),
                Operation::Configure {
                    binary: "/missing/lume".into(),
                    enabled: true,
                },
                std::future::pending::<bool>(),
                None,
            )
            .await
            .unwrap();
        assert_eq!(operation.stage, "awaitingConsent");
        service.cancel(&operation.id).await.unwrap();
        let terminal = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let status = service.poll(&operation.id).await.unwrap();
                if status.state != "running" {
                    break status;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            terminal.error_code.as_deref(),
            Some("lume_operation_cancelled")
        );
        assert_eq!(terminal.stage, "finished");
        assert!(!service.journal.lock().await.data.enabled);
    }
    #[tokio::test]
    async fn cancellation_while_stage_transition_is_blocked_refuses_dispatch() {
        let root = tempfile::tempdir().unwrap();
        let service = Service::open(root.path().into()).unwrap();
        service.journal.lock().await.data.enabled = true;
        let (allow, approved) = tokio::sync::oneshot::channel();
        let approval_ready = fresh_cancel();
        let ready = approval_ready.clone();
        let operation = service
            .begin(
                "cancel-before-dispatch".into(),
                Operation::Configure {
                    binary: "/missing/lume".into(),
                    enabled: false,
                },
                async move {
                    approved.await.unwrap();
                    ready.store(true, Ordering::SeqCst);
                    true
                },
                None,
            )
            .await
            .unwrap();
        let journal = service.journal.lock().await;
        allow.send(()).unwrap();
        // This current-thread runtime runs approval through to its blocked
        // stage lock before the test can observe this marker.
        while !approval_ready.load(Ordering::SeqCst) {
            tokio::task::yield_now().await;
        }
        service.cancel(&operation.id).await.unwrap();
        drop(journal);
        let terminal = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let status = service.poll(&operation.id).await.unwrap();
                if status.state != "running" {
                    break status;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            terminal.error_code.as_deref(),
            Some("lume_operation_cancelled")
        );
        assert!(service.journal.lock().await.data.enabled);
    }
    #[tokio::test]
    async fn source_publication_survives_epoch_rotation_before_bookkeeping() {
        let journal_root = tempfile::tempdir().unwrap();
        let source_root = tempfile::tempdir().unwrap();
        std::fs::write(source_root.path().join("a"), b"old").unwrap();
        let (source, _) = super::super::workspace::prepare(source_root.path()).unwrap();
        let (files, body) = lume::pack_workspace(vec![("a".into(), b"new".to_vec())]).unwrap();
        let patch = super::super::workspace::changes(&source, &files, &body).unwrap();
        let service = Service::open(journal_root.path().into()).unwrap();
        let mut owned = super::super::journal::test_resource();
        owned.workspace = Some(source.clone());
        owned.projection.state = "stopped".into();
        let reference = owned.projection.reference.clone();
        service.store(owned).await.unwrap();
        service
            .reviews
            .lock()
            .await
            .insert("review".into(), (reference.clone(), patch.clone()));
        let outcome = super::super::workspace::adopt(&source, &patch).unwrap();
        assert_eq!(
            outcome.status,
            cognia_task_workspace::RevisionApplyStatus::Applied
        );
        // Urgent Stop bypasses the writer. Rotate exactly after real source
        // publication, before the same completion path used by adoption.
        let rotated = service.rotate_epoch(&reference).await.unwrap();
        let receipt = service
            .finish_workspace_adoption(&reference, "review", outcome)
            .await
            .unwrap();
        assert_eq!(std::fs::read(source_root.path().join("a")).unwrap(), b"new");
        assert_eq!(receipt["effectCommitted"], true);
        assert_eq!(receipt["journalRecoveryRequired"], true);
        assert_eq!(receipt["status"], "applied");
        let journal = service.journal.lock().await;
        let current = journal.resource(&rotated.projection.reference).unwrap();
        assert!(current.projection.quarantine);
        assert!(current.workspace.as_ref().unwrap().adopted);
        assert!(!service.reviews.lock().await.contains_key("review"));
    }
    #[tokio::test]
    async fn source_publication_survives_failed_ownership_write() {
        let journal_root = tempfile::tempdir().unwrap();
        let source_root = tempfile::tempdir().unwrap();
        std::fs::write(source_root.path().join("a"), b"old").unwrap();
        let (source, _) = super::super::workspace::prepare(source_root.path()).unwrap();
        let (files, body) = lume::pack_workspace(vec![("a".into(), b"new".to_vec())]).unwrap();
        let patch = super::super::workspace::changes(&source, &files, &body).unwrap();
        let service = Service::open(journal_root.path().into()).unwrap();
        let mut owned = super::super::journal::test_resource();
        owned.workspace = Some(source.clone());
        let reference = owned.projection.reference.clone();
        service.store(owned).await.unwrap();
        let outcome = super::super::workspace::adopt(&source, &patch).unwrap();
        std::fs::create_dir(journal_root.path().join("journal.pending")).unwrap();
        let receipt = service
            .finish_workspace_adoption(&reference, "review", outcome)
            .await
            .unwrap();
        assert_eq!(std::fs::read(source_root.path().join("a")).unwrap(), b"new");
        assert_eq!(receipt["status"], "applied");
        assert_eq!(receipt["effectCommitted"], true);
        assert_eq!(receipt["journalRecoveryRequired"], true);
        let journal = service.journal.lock().await;
        let current = journal.resource(&reference).unwrap();
        assert!(current.workspace.as_ref().unwrap().adopted);
        assert!(current.projection.quarantine);
    }
    #[test]
    fn failed_journal_commit_preserves_an_already_applied_source_receipt() {
        let mut status:OperationStatus=serde_json::from_value(serde_json::json!({"id":"op","requestKey":"key","requestHash":"hash","state":"succeeded","stage":"finished","resource":null,"errorCode":null,"output":{"status":"applied","effectCommitted":true,"written":["a"]}})).unwrap();
        journal_commit_failed(&mut status);
        assert_eq!(status.state, "succeeded");
        assert_eq!(
            status.output.as_ref().unwrap()["written"],
            serde_json::json!(["a"])
        );
        assert_eq!(
            status.output.as_ref().unwrap()["journalRecoveryRequired"],
            true
        );
        status.output = Some(serde_json::json!({"stdout":"not a Host commit"}));
        journal_commit_failed(&mut status);
        assert_eq!(status.state, "failed");
        assert!(status.output.is_none());
    }
    #[test]
    fn normal_completion_retains_group_without_claiming_cleanup_and_malformed_reply_refuses() {
        let value = serde_json::json!({"exitCode":0,"stdout":"ok","stderr":"","durationMs":1,"timedOut":false,"stdoutTruncated":false,"stderrTruncated":false});
        let (receipt, timed_out) = normal_exec_receipt(value.clone()).unwrap();
        assert!(!timed_out);
        assert_eq!(receipt["executionGroupRetained"], true);
        assert!(receipt.get("vmStopped").is_none());
        let mut invalid = value.clone();
        invalid["timedOut"] = serde_json::Value::Null;
        assert!(normal_exec_receipt(invalid).is_err());
        let mut timeout = value;
        timeout["timedOut"] = serde_json::json!(true);
        let (receipt, timed_out) = normal_exec_receipt(timeout).unwrap();
        assert!(timed_out);
        assert!(receipt.get("executionGroupRetained").is_none());
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn unbind_and_boot_rotation_revoke_queued_sends() {
        let root = tempfile::tempdir().unwrap();
        let service = Service::open(root.path().to_path_buf()).unwrap();
        let mut owned = test_resource();
        let source_root = tempfile::tempdir().unwrap();
        owned.workspace = Some(
            super::super::workspace::prepare(source_root.path())
                .unwrap()
                .0,
        );
        let reference = owned.projection.reference.clone();
        {
            let mut journal = service.journal.lock().await;
            journal.data.enabled = true;
            journal.data.resources.insert("r".into(), owned);
        }
        let policy = BindingPolicy {
            group_id: "group".into(),
            workspace_root: source_root.path().to_string_lossy().into_owned(),
            network: "on".into(),
            max_cpu_seconds: 0,
            max_memory_mb: 0,
            readable: vec![".".into()],
            writable: vec![".".into()],
        };
        let binding = service
            .bind(
                reference.clone(),
                "session".into(),
                policy,
                std::future::ready(true),
            )
            .await
            .unwrap();
        let fence = service.send_fence(&reference, Some(&binding));
        assert!(fence());
        assert_eq!(
            service.unbind(&binding).await.unwrap_err(),
            "lume_binary_unconfigured"
        );
        assert!(!fence());
        assert!(service.bound(&binding).await.is_err());
        let current = service.journal.lock().await.data.resources["r"]
            .projection
            .reference
            .clone();
        let resource_fence = service.send_fence(&current, None);
        service.rotate_epoch(&current).await.unwrap();
        assert!(!resource_fence());
        assert_eq!(
            super::super::validate_transfer_reference(
                "lume:r:1:boot",
                &service.journal.lock().await.data.resources["r"]
                    .projection
                    .reference
            )
            .unwrap_err(),
            "lume_stale_transfer_target"
        );
    }

    #[tokio::test]
    async fn disabled_binary_upload_is_refused_before_transport() {
        let root = tempfile::tempdir().unwrap();
        let service = Service::open(root.path().to_path_buf()).unwrap();
        let resource = test_resource();
        let reference = resource.projection.reference.clone();
        service
            .journal
            .lock()
            .await
            .data
            .resources
            .insert("r".into(), resource);
        assert_eq!(
            service
                .transfer_file(
                    &reference,
                    "/workspace/file",
                    Some(vec![1]),
                    Arc::new(|| true)
                )
                .await
                .unwrap_err(),
            "lume_feature_disabled"
        );
    }

    #[tokio::test]
    async fn disabling_does_not_need_a_working_cli_and_revokes_queued_work() {
        let root = tempfile::tempdir().unwrap();
        let service = Service::open(root.path().to_path_buf()).unwrap();
        let resource = test_resource();
        let reference = resource.projection.reference.clone();
        {
            let mut journal = service.journal.lock().await;
            journal.data.enabled = true;
            journal.data.resources.insert("r".into(), resource);
        }
        let fence = service.send_fence(&reference, None);
        let cancelled = fresh_cancel();
        service
            .active
            .lock()
            .await
            .insert("operation".into(), (Some("r".into()), cancelled.clone()));
        service
            .configure(PathBuf::from("/missing/lume"), false)
            .await
            .unwrap();
        assert!(!fence());
        assert!(cancelled.load(Ordering::SeqCst));
        assert_eq!(service.snapshot().await["enabled"], false);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn urgent_stop_reaches_verified_vm_when_journal_writes_fail() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let binary = root.path().join("fake-lume");
        std::fs::write(&binary,b"#!/bin/sh\ncase \"$1\" in\nget) cat \"$(dirname \"$0\")/inspection.json\";;\nstop) cp \"$(dirname \"$0\")/stopped.json\" \"$(dirname \"$0\")/inspection.json\"; touch \"$(dirname \"$0\")/stop-called\";;\n*) exit 2;;\nesac\n").unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        let inspection = serde_json::json!([{"name":"cognia-test","status":"running","memorySize":8589934592u64,"cpuCount":4,"display":"1024x768","machineIdentifier":"machine","macAddress":"aa:bb","ipAddress":null}]);
        std::fs::write(root.path().join("inspection.json"), inspection.to_string()).unwrap();
        let mut stopped = inspection.clone();
        stopped[0]["status"] = serde_json::json!("stopped");
        std::fs::write(root.path().join("stopped.json"), stopped.to_string()).unwrap();
        let service = Service::open(root.path().to_path_buf()).unwrap();
        let vm = root.path().join("vms/cognia-test");
        std::fs::create_dir_all(&vm).unwrap();
        std::fs::write(vm.join("disk.img"), b"disk").unwrap();
        std::fs::write(vm.join("nvram.bin"), b"nvram").unwrap();
        let mut owned = test_resource();
        owned.disk = Some(identity(&vm.join("disk.img")).unwrap());
        owned.nvram = Some(identity(&vm.join("nvram.bin")).unwrap());
        owned.immutable_config_hash = Some(
            serde_json::from_value::<Vec<cli::Inspection>>(inspection).unwrap()[0]
                .config_hash()
                .unwrap(),
        );
        let reference = owned.projection.reference.clone();
        {
            let mut journal = service.journal.lock().await;
            journal.data.binary_hash = Some(cli::binary_hash(&binary).unwrap());
            journal.data.binary = Some(binary);
            journal.data.resources.insert("r".into(), owned);
            journal.save_async().await.unwrap();
        }
        std::fs::create_dir(root.path().join("journal.pending")).unwrap();
        let fence = service.send_fence(&reference, None);
        assert_eq!(
            service.stop(&reference).await.unwrap_err(),
            "lume_stopped_journal_recovery_required"
        );
        assert!(root.path().join("stop-called").exists());
        assert!(!fence());
        let journal = service.journal.lock().await;
        assert_eq!(journal.data.resources["r"].projection.state, "stopped");
        assert!(journal.data.resources["r"].projection.quarantine);
        let current = journal.data.resources["r"].projection.reference.clone();
        drop(journal);
        assert_eq!(
            service
                .contain_uncertain(&current, "lume_process_timeout")
                .await,
            "lume_stopped_journal_recovery_required"
        );
        assert!(std::fs::read_to_string(root.path().join("inspection.json"))
            .unwrap()
            .contains("stopped"));
    }
    #[tokio::test]
    async fn disabled_service_is_observable_and_idempotency_rejects_payload_changes() {
        let root = tempfile::tempdir().unwrap();
        let service = Service::open(root.path().to_path_buf()).unwrap();
        assert_eq!(service.snapshot().await["enabled"], false);
        let operation = Operation::Provision {
            connection_id: "c".into(),
            source: Provision::Attach {
                vm_name: "cognia-x".into(),
            },
        };
        let first = service
            .begin(
                "same".into(),
                operation.clone(),
                std::future::pending::<bool>(),
                None,
            )
            .await
            .unwrap();
        let second = service
            .begin("same".into(), operation, std::future::ready(true), None)
            .await
            .unwrap();
        assert_eq!(first.id, second.id);
        assert!(service
            .begin(
                "same".into(),
                Operation::Provision {
                    connection_id: "other".into(),
                    source: Provision::Attach {
                        vm_name: "cognia-x".into()
                    }
                },
                std::future::ready(true),
                None
            )
            .await
            .is_err());
        service.cancel(&first.id).await.unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            while service.poll(&first.id).await.unwrap().state == "running" {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
}

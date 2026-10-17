//! ADR-0233 P4 authenticated evidence access. No command creates a desktop or
//! grants acceptance delegation. Owner and decision principals are Host-derived.
use std::path::Path;
use base64::Engine;
use cognia_automation::cua_sandbox::managed::{evidence::*, *};
use cognia_sandbox_pool::provenance::SourceStore;
use serde::Deserialize;
use serde_json::Value;

pub const COMMANDS: &[&str] = &[
    "managed_desktop_results_get_results", "managed_desktop_results_get_result",
    "managed_desktop_results_read_evidence", "managed_desktop_results_approve",
    "managed_desktop_results_capture", "managed_desktop_results_complete",
    "managed_desktop_results_prepare_delete", "managed_desktop_results_commit_delete",
    "managed_desktop_results_abort_delete",
];
pub const PRODUCTION_ACCEPTANCE_ENABLED: bool = false;
// A retry that arrives while a frame is being sampled waits for its durable
// publication, then reads the same artifact without capturing another frame.
static CAPTURE_PUBLICATION: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn disk<T: Send + 'static>(directory: &Path,
    operation: impl FnOnce(EvidenceStore) -> std::result::Result<T, String> + Send + 'static) -> Result<T> {
    let directory = directory.to_owned();
    tokio::task::spawn_blocking(move || operation(EvidenceStore::new(&directory)))
        .await.map_err(|_| refused("managed_desktop_evidence_unavailable"))?
        .map_err(|error| refused(&error))
}
async fn guarded_disk<T: Send + 'static>(directory: &Path,
    admission: std::sync::Arc<dyn Fn() -> bool + Send + Sync>,
    operation: impl FnOnce(EvidenceStore) -> std::result::Result<T, String> + Send + 'static) -> Result<T> {
    disk(directory, move |store| operation(store.with_admission(admission))).await
}

fn decode<T: serde::de::DeserializeOwned>(args: Value) -> Result<T> {
    serde_json::from_value(args).map_err(|_| refused("managed_desktop_invalid_request"))
}
fn encode<T: serde::Serialize>(value: T) -> Result<Value> {
    serde_json::to_value(value).map_err(|_| refused("managed_desktop_evidence_unavailable"))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Id { acceptance_id: String }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Read { acceptance_id: String, artifact_id: String }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Approval { acceptance_id: String, expected_revision: u64, decision: ApprovalDecision, idempotency_key: String }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Capture { acceptance_id: String, artifact_id: String, criterion_id: String, kind: CaptureKind }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Complete { acceptance_id: String, idempotency_key: String, outcome: AcceptanceOutcome,
    criteria: Vec<CriterionResult>, summary: String }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PrepareDelete { operation_id: String, #[serde(default)] conversation_ids: Vec<String>,
    #[serde(default)] task_ids: Vec<String>, #[serde(default)] acceptance_ids: Vec<String> }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Operation { operation_id: String }

fn require_agent(p: &ManagedDesktopPrincipal, row: &AcceptanceResult) -> Result<()> {
    if p.authority != ManagedDesktopAuthority::Agent
        || row.binding.agent_principal_id.as_deref() != Some(p.principal_id.as_str()) {
        return Err(refused("managed_desktop_acceptance_delegation_required"));
    }
    // No configuration/browser flag can enable delegation before provider smoke.
    if !PRODUCTION_ACCEPTANCE_ENABLED { return Err(refused("managed_desktop_acceptance_unqualified")); }
    Ok(())
}
async fn current_source(directory: &Path, p: &ManagedDesktopPrincipal, row: &AcceptanceResult) -> Result<()> {
    let directory = directory.to_owned(); let principal = p.clone(); let binding = row.binding.clone();
    tokio::task::spawn_blocking(move || {
        let source = SourceStore::new(&directory).authorize(&binding.source_id, &principal.owner_principal_id, &principal.host_id)
            .map_err(|_| refused("managed_desktop_handoff_source_unavailable"))?;
        if source.task_id != binding.task_id || source.conversation_id != binding.session_id
            || source.coding_run_id != binding.parent_run_id {
            return Err(refused("managed_desktop_handoff_source_unavailable"));
        }
        Ok(())
    }).await.map_err(|_| refused("managed_desktop_evidence_unavailable"))?
}

pub async fn dispatch(directory: &Path, service: &ManagedDesktopService,
    p: &ManagedDesktopPrincipal, authority: &dyn ManagedControlAuthority, name: &str, args: Value) -> Result<Value> {
    authority.revalidate(p).await?;
    let owner = p.owner_principal_id.clone(); let host = p.host_id.clone();
    let value = match name {
        "managed_desktop_results_get_results" => {
            let filter: ResultFilter = decode(args)?;
            encode(disk(directory, move |s| s.list(&owner, &host, filter)).await?)?
        }
        "managed_desktop_results_get_result" => {
            let a: Id = decode(args)?;
            encode(disk(directory, move |s| s.get(&owner, &host, &a.acceptance_id)).await?)?
        }
        "managed_desktop_results_read_evidence" => {
            let a: Read = decode(args)?;
            let (artifact, bytes) = disk(directory, move |s| s.read_image(&owner, &host, &a.acceptance_id, &a.artifact_id)).await?;
            serde_json::json!({"mimeType":artifact.mime_type,"sha256":artifact.sha256,
                "base64":base64::engine::general_purpose::STANDARD.encode(bytes),"cacheControl":"no-store"})
        }
        "managed_desktop_results_approve" => {
            p.require_human()?;
            let a: Approval = decode(args)?;
            let input = HumanApprovalInput { expected_revision:a.expected_revision, idempotency_key:a.idempotency_key,
                principal_id:p.principal_id.clone(), decision:a.decision };
            encode(guarded_disk(directory, authority.input_admission(p), move |s| s.approve(&owner, &host, &a.acceptance_id, input)).await?)?
        }
        "managed_desktop_results_capture" => {
            let a: Capture = decode(args)?;
            let _capture = CAPTURE_PUBLICATION.lock().await;
            authority.revalidate(p).await?;
            let id = a.acceptance_id.clone(); let read_owner = owner.clone(); let read_host = host.clone();
            let row = disk(directory, move |s| s.get(&read_owner, &read_host, &id)).await?;
            if p.authority == ManagedDesktopAuthority::Agent { require_agent(p, &row)?; } else { p.require_human()?; }
            current_source(directory, p, &row).await?;
            let input = CaptureInput { artifact_id:a.artifact_id, criterion_id:a.criterion_id, kind:a.kind,
                explicitly_requested:p.authority != ManagedDesktopAuthority::Agent, sensitive_human_input:false };
            let retry_owner = owner.clone(); let retry_host = host.clone();
            let retry_id = a.acceptance_id.clone(); let retry_input = input.clone();
            let previous = guarded_disk(directory, authority.input_admission(p), move |s|
                s.captured(&retry_owner, &retry_host, &retry_id, &retry_input)).await?;
            if let Some(previous) = previous {
                authority.revalidate(p).await?;
                return encode(previous);
            }
            // Capture comes from the bound desktop, never caller-supplied pixels.
            let frame = service.control_frame(p, &row.binding.desktop_id, row.binding.desktop_generation, authority).await?;
            authority.revalidate(p).await?;
            current_source(directory, p, &row).await?;
            let bytes = base64::engine::general_purpose::STANDARD.decode(&frame.screenshot.bytes)
                .map_err(|_| refused("managed_desktop_evidence_invalid_image"))?;
            encode(guarded_disk(directory, authority.input_admission(p), move |s| s.capture(&owner, &host, &a.acceptance_id, input, &bytes)).await?)?
        }
        "managed_desktop_results_complete" => {
            let a: Complete = decode(args)?;
            let id = a.acceptance_id.clone(); let read_owner = owner.clone(); let read_host = host.clone();
            let row = disk(directory, move |s| s.get(&read_owner, &read_host, &id)).await?;
            require_agent(p, &row)?;
            current_source(directory, p, &row).await?;
            let input = AgentVerdictInput { idempotency_key:a.idempotency_key, principal_id:p.principal_id.clone(),
                outcome:a.outcome, criteria:a.criteria, summary:a.summary };
            encode(guarded_disk(directory, authority.input_admission(p), move |s| s.complete(&owner, &host, &a.acceptance_id, input)).await?)?
        }
        "managed_desktop_results_prepare_delete" => {
            p.require_human()?;
            let a: PrepareDelete = decode(args)?;
            deletion_receipt(directory, guarded_disk(directory, authority.input_admission(p), move |s| s.prepare_delete(&owner, &host, &a.operation_id,
                DeletionScope { session_ids:a.conversation_ids, task_ids:a.task_ids, acceptance_ids:a.acceptance_ids })).await?).await?
        }
        "managed_desktop_results_commit_delete" => {
            p.require_human()?;
            let a: Operation = decode(args)?;
            deletion_receipt(directory, guarded_disk(directory, authority.input_admission(p), move |s| s.commit_delete(&owner, &host, &a.operation_id)).await?).await?
        }
        "managed_desktop_results_abort_delete" => {
            p.require_human()?;
            let a: Operation = decode(args)?;
            deletion_receipt(directory, guarded_disk(directory, authority.input_admission(p), move |s| s.abort_delete(&owner, &host, &a.operation_id)).await?).await?
        }
        _ => return Err(refused("managed_desktop_invalid_request")),
    };
    authority.revalidate(p).await?;
    Ok(value)
}

static TASK_BACKEND: once_cell::sync::Lazy<parking_lot::RwLock<Option<std::sync::Arc<dyn cognia_external_agent::exec_backend::ExecBackend>>>> = once_cell::sync::Lazy::new(Default::default);
pub fn install_task_cleanup_backend(backend: std::sync::Arc<dyn cognia_external_agent::exec_backend::ExecBackend>) {
    *TASK_BACKEND.write() = Some(backend);
}

static NATIVE_TASK_DELETE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Wrap the actual, already-authorized native history removal. The evidence
/// intent is durable before removal and committed only after success. Startup
/// resolves an interrupted native intent against the owning native task store.
pub async fn delete_task_history(
    directory: &Path, owner: Option<String>, host: String, task: String, device: Option<String>,
    admission: std::sync::Arc<dyn Fn() -> bool + Send + Sync>,
    delete: impl std::future::Future<Output = std::result::Result<(), String>>,
) -> std::result::Result<(), String> {
    let _serial = NATIVE_TASK_DELETE.lock().await;
    let root = directory.to_owned(); let lookup = task.clone();
    let sourced = tokio::task::spawn_blocking(move || SourceStore::new(&root).has_task(&lookup))
        .await.map_err(|_| "delivery_source_unavailable".to_string())??;
    if !sourced { return delete.await; }
    let owner = owner.ok_or_else(|| "delivery_source_account_required".to_string())?;
    let root = directory.to_owned(); let lookup = task.clone(); let expected_owner = owner.clone(); let expected_host = host.clone();
    tokio::task::spawn_blocking(move || SourceStore::new(&root).verify_task_owner(&expected_owner, &expected_host, &lookup))
        .await.map_err(|_| "delivery_source_unavailable".to_string())??;
    let operation = uuid::Uuid::new_v4().to_string();
    let scope_owner = owner.clone(); let scope_host = host.clone(); let scope_operation = operation.clone();
    guarded_disk(directory, admission.clone(), move |s| s.prepare_native_task_delete(&scope_owner, &scope_host, &scope_operation, &task, device))
        .await.map_err(|e| e.code)?;
    if !admission() {
        disk(directory, move |s| s.abort_delete(&owner, &host, &operation)).await.map_err(|e| e.code)?;
        return Err("evidence_authority_expired".into());
    }
    let result = delete.await;
    // A backend can fail after removing part of retained history. Leave the
    // prepared journal fenced and replay the exact canonical deletion on retry.
    if result.is_ok() {
        disk(directory, move |s| s.commit_delete(&owner, &host, &operation)).await.map_err(|e| e.code)?;
    }
    result
}

async fn reconcile_native_tasks(directory: &Path) -> Result<()> {
    let Some(backend) = TASK_BACKEND.read().clone() else { return Ok(()); };
    reconcile_native_tasks_with_backend(directory, backend.as_ref()).await
}

async fn reconcile_native_tasks_with_backend(directory: &Path,
    backend: &dyn cognia_external_agent::exec_backend::ExecBackend) -> Result<()> {
    let _serial = NATIVE_TASK_DELETE.lock().await;
    let intents = disk(directory, |s| s.list_native_task_deletions()).await?;
    for (intent, device) in intents {
        let Some(task) = intent.scope.task_ids.first().cloned() else { continue; };
        let root = directory.to_owned(); let owner = intent.owner_account_id.clone(); let host = intent.host_id.clone(); let check_task = task.clone();
        tokio::task::spawn_blocking(move || SourceStore::new(&root).verify_task_owner(&owner,&host,&check_task))
            .await.map_err(|_| refused("managed_desktop_evidence_unavailable"))?.map_err(|e| refused(&e))?;
        if cognia_external_agent::gateway_task::delete_gateway_task_for_device(&task, backend, device.as_deref()).await.is_err() {
            continue;
        }
        disk(directory, move |s| s.commit_delete(&intent.owner_account_id, &intent.host_id, &intent.id)).await?;
    }
    Ok(())
}

async fn deletion_receipt(directory: &Path, intent: DeletionIntent) -> Result<Value> {
    let directory = directory.to_owned();
    tokio::task::spawn_blocking(move || {
        let mut tasks = SourceStore::new(&directory).tasks_for_conversations(&intent.owner_account_id, &intent.host_id, &intent.scope.session_ids)
            .map_err(|e| refused(&e))?;
        tasks.extend(intent.scope.task_ids);
        tasks.sort(); tasks.dedup();
        Ok(serde_json::json!({"operationId":intent.id,"state":intent.state,"cleanupPending":intent.cleanup_pending,"taskIds":tasks}))
    }).await.map_err(|_| refused("managed_desktop_evidence_unavailable"))?
}

/// Runs from both desktop and headless Host startup, independently of renderer,
/// release qualification and account UI. Only durable deletion targets authorize
/// destruction; bytes are reclaimed even while provider cleanup is unavailable.
pub async fn reconcile(directory: &Path, service: &ManagedDesktopService, host_id: &str) -> Result<()> {
    reconcile_native_tasks(directory).await?;
    disk(directory, |s| s.reconcile()).await?;
    let targets = disk(directory, |s| s.list_cleanup_targets()).await?;
    for target in targets {
        if target.host_id != host_id { continue; }
        let principal = ManagedDesktopPrincipal { owner_principal_id:target.owner_account_id.clone(),
            host_id:target.host_id.clone(), principal_id:"acceptance-deletion-worker".into(),
            authority:ManagedDesktopAuthority::Administrator };
        let deleted = service.delete(&principal, &target.desktop_id, target.desktop_generation).await;
        if deleted.is_ok_and(|row| row.state == ManagedDesktopState::Destroyed) {
            disk(directory, move |s| s.mark_desktop_cleaned(&target.owner_account_id, &target.host_id, &target.acceptance_id)).await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn binding(source: &cognia_external_agent::spawn_authority::DeliverySource) -> AcceptanceBinding {
        AcceptanceBinding { acceptance_id:uuid::Uuid::new_v4().to_string(), owner_account_id:"owner".into(),
            host_id:"host".into(), source_id:source.id.clone(), session_id:source.conversation_id.clone(), task_id:source.task_id.clone(),
            parent_run_id:source.coding_run_id.clone(), origin_run_ref:Some(source.origin_run_ref.clone()), delivery_id:"delivery".into(),
            delivery_revision:1, commit:"a".repeat(40), desktop_id:"desktop".into(), desktop_generation:1,
            manifest_digest:"b".repeat(64), agent_principal_id:None,
            criteria:vec![AcceptanceCriterion { id:"first".into(), text:"Page loads".into(), required_evidence:true }] }
    }
    #[tokio::test]
    async fn native_task_failure_preserves_evidence_and_success_persists_deletion() {
        let root = tempfile::tempdir().unwrap();
        let source = SourceStore::new(root.path()).admit("owner","host","task","device",
            cognia_external_agent::spawn_authority::DeliverySourceDeclaration { conversation_id:"chat".into(), origin_run_ref:"run".into() },
            "https://example.com/repo.git","main","task/branch",None).unwrap();
        let binding = binding(&source); let id = binding.acceptance_id.clone();
        let store = EvidenceStore::new(root.path());
        store.register("owner","host",binding).unwrap();
        let error = delete_task_history(root.path(),Some("owner".into()),"host".into(),"task".into(), None, std::sync::Arc::new(|| true), async {
            assert!(store.get("owner","host",&id).is_err(), "prepared intent fences concurrent reads");
            Err("native delete refused".into())
        }).await;
        assert_eq!(error.unwrap_err(), "native delete refused");
        assert!(store.get("owner","host",&id).is_err(), "ambiguous deletion remains fenced and retained for canonical retry");
        assert_eq!(store.list_native_task_deletions().unwrap().len(),1);
        delete_task_history(root.path(),Some("owner".into()),"host".into(),"task".into(),None,std::sync::Arc::new(|| true),async { Ok(()) }).await.unwrap();
        assert!(store.get("owner","host",&id).is_err());
        assert_eq!(store.list_cleanup_targets().unwrap().len(),1);
    }
    #[tokio::test]
    async fn admission_expiring_after_prepare_never_polls_the_delete_future() {
        use std::sync::{Arc, atomic::{AtomicBool, AtomicUsize, Ordering}};
        let root = tempfile::tempdir().unwrap();
        let source = SourceStore::new(root.path()).admit("owner","host","task","device",
            cognia_external_agent::spawn_authority::DeliverySourceDeclaration { conversation_id:"chat".into(), origin_run_ref:"run".into() },
            "https://example.com/repo.git","main","task/branch",None).unwrap();
        let store = EvidenceStore::new(root.path());
        let row = store.register("owner","host",binding(&source)).unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let admission = Arc::new(move || calls.fetch_add(1, Ordering::SeqCst) == 0);
        let polled = AtomicBool::new(false);
        let error = delete_task_history(root.path(),Some("owner".into()),"host".into(),"task".into(),Some("device".into()),admission,async {
            polled.store(true, Ordering::SeqCst);
            Ok(())
        }).await.unwrap_err();
        assert_eq!(error,"evidence_authority_expired");
        assert!(!polled.load(Ordering::SeqCst));
        assert!(store.get("owner","host",&row.binding.acceptance_id).is_ok());
        assert!(store.list_native_task_deletions().unwrap().is_empty());
    }

    struct CleanupBackend {
        fail: std::sync::atomic::AtomicBool,
        calls: parking_lot::Mutex<Vec<(String, Option<String>)>>,
    }
    #[async_trait::async_trait]
    impl cognia_external_agent::exec_backend::ExecBackend for CleanupBackend {
        async fn spawn(&self, _: cognia_external_agent::process::ExternalAgentSpawnConfig,
            _: std::sync::Arc<dyn cognia_external_agent::process::ExternalAgentEventSink>) -> std::result::Result<String,String> { unreachable!() }
        async fn send(&self, _: &str, _: &str) -> std::result::Result<(),String> { unreachable!() }
        async fn kill(&self, _: &str) -> std::result::Result<(),String> { unreachable!() }
        async fn kill_all(&self) -> std::result::Result<(),String> { unreachable!() }
        async fn status(&self, _: &str) -> Option<cognia_external_agent::process::ExternalAgentProcessState> { unreachable!() }
        async fn list(&self) -> Vec<String> { Vec::new() }
        async fn is_running(&self, _: &str) -> std::result::Result<bool,String> { unreachable!() }
        async fn get_info(&self, _: &str) -> std::result::Result<Value,String> { unreachable!() }
        async fn set_running(&self, _: &str) -> std::result::Result<(),String> { unreachable!() }
        async fn set_failed(&self, _: &str) -> std::result::Result<(),String> { unreachable!() }
        fn kind(&self) -> &'static str { "local-process" }
        async fn delete_retained_gateway_task(&self, task: &str, device: Option<&str>) -> std::result::Result<(),String> {
            self.calls.lock().push((task.into(),device.map(str::to_owned)));
            if self.fail.load(std::sync::atomic::Ordering::SeqCst) { Err("sandbox offline".into()) } else { Ok(()) }
        }
    }
    #[tokio::test]
    async fn restart_replays_canonical_backend_with_original_device_and_commits_only_success() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let root = tempfile::tempdir().unwrap();
        let task = uuid::Uuid::new_v4().to_string();
        let source = SourceStore::new(root.path()).admit("owner","host",&task,"paired-device",
            cognia_external_agent::spawn_authority::DeliverySourceDeclaration { conversation_id:"chat".into(), origin_run_ref:"run".into() },
            "https://example.com/repo.git","main","task/branch",None).unwrap();
        let store = EvidenceStore::new(root.path());
        store.register("owner","host",binding(&source)).unwrap();
        let operation = uuid::Uuid::new_v4().to_string();
        store.prepare_native_task_delete("owner","host",&operation,&task,Some("paired-device".into())).unwrap();
        let backend = CleanupBackend { fail:AtomicBool::new(true),calls:Default::default() };
        reconcile_native_tasks_with_backend(root.path(),&backend).await.unwrap();
        assert_eq!(store.list_native_task_deletions().unwrap().len(),1);
        backend.fail.store(false,Ordering::SeqCst);
        reconcile_native_tasks_with_backend(root.path(),&backend).await.unwrap();
        assert!(store.list_native_task_deletions().unwrap().is_empty());
        assert_eq!(*backend.calls.lock(),vec![(task.clone(),Some("paired-device".into())),(task,Some("paired-device".into()))]);
        assert_eq!(store.commit_delete("owner","host",&operation).unwrap().state,DeletionState::Committed);
    }

    #[test]
    fn human_or_unqualified_agent_cannot_publish_an_agent_verdict() {
        let source = cognia_external_agent::spawn_authority::DeliverySource {
            version:1,id:"source".into(),owner_account_id:"owner".into(),host_id:"host".into(),task_id:"task".into(),
            device_id:"device".into(),conversation_id:"chat".into(),coding_run_id:"parent".into(),origin_run_ref:"origin".into(),
            repository_url:"https://example.com/repo.git".into(),base_ref:"main".into(),branch:"branch".into(),credential_ref:None,
        };
        let root = tempfile::tempdir().unwrap(); let store = EvidenceStore::new(root.path());
        let mut binding = binding(&source); binding.agent_principal_id = Some("agent".into());
        let row = store.register("owner","host",binding).unwrap();
        let mut p = ManagedDesktopPrincipal { owner_principal_id:"owner".into(),host_id:"host".into(),principal_id:"agent".into(),authority:ManagedDesktopAuthority::Human };
        assert_eq!(require_agent(&p,&row).unwrap_err().code,"managed_desktop_acceptance_delegation_required");
        p.authority = ManagedDesktopAuthority::Agent;
        assert_eq!(require_agent(&p,&row).unwrap_err().code,"managed_desktop_acceptance_unqualified");
    }
    #[test]
    fn caller_cannot_supply_decision_identity_or_pixels() {
        assert!(decode::<Approval>(serde_json::json!({"acceptanceId":"a","expectedRevision":0,"decision":"approved","idempotencyKey":"k","principalId":"forged"})).is_err());
        assert!(decode::<Capture>(serde_json::json!({"acceptanceId":"a","artifactId":"b","criterionId":"c","kind":"checkpoint","bytes":"forged"})).is_err());
        assert!(decode::<Complete>(serde_json::json!({"acceptanceId":"a","idempotencyKey":"k","outcome":"passed","criteria":[],"summary":"ok","principalId":"forged"})).is_err());
        assert!(!PRODUCTION_ACCEPTANCE_ENABLED);
    }
}

//! Explicit native P3 diagnostic. Not registered in RPC, and never produces a
//! qualification receipt or agent verdict. P4 retains a private checkpoint and
//! system inconclusive outcome; every desktop is destroyed.
use base64::Engine;
use cognia_automation::cua_sandbox::managed::evidence::*;
use std::{fs, io::Write, path::{Path, PathBuf}, sync::Arc, time::Duration};
use cognia_automation::cua_sandbox::managed::{
    handoff::{self, HandoffBudget, RecoverySource, TrustedHandoffSource}, *,
};
use cognia_sandbox_pool::git_proxy::{GitProxy, GitProxyConfig};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use crate::managed_desktop_handoff::{resolve, PrepareHandoff, TransferMode};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiagnosticRequest { operation_id: String, request: PrepareHandoff }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChildAcceptanceRun {
    version: u32, id: String, parent_run_id: String, origin_run_ref: String,
    session_id: String, task_id: String, source_id: String,
    owner_account_id: String, host_id: String, delivery_id: String, delivery_revision: u64,
    commit: String, mode: TransferMode, criteria: Vec<String>,
    desktop_id: Option<String>, desktop_generation: Option<u64>,
    manifest_digest: Option<String>, transfer_manifest_digest: Option<String>,
    launch_argv: Vec<String>, acceptance_files: Vec<String>, deadline_at: Option<i64>,
    state: String, cleanup_pending: bool,
}
fn manifest_digest(row: &ChildAcceptanceRun) -> Result<String> {
    let value = serde_json::json!({
        "version":row.version, "acceptanceRunId":row.id, "parentRunId":row.parent_run_id,
        "originRunRef":row.origin_run_ref, "sessionId":row.session_id, "taskId":row.task_id,
        "sourceId":row.source_id, "ownerAccountId":row.owner_account_id, "hostId":row.host_id,
        "deliveryId":row.delivery_id, "deliveryRevision":row.delivery_revision,
        "commit":row.commit, "mode":row.mode, "criteria":row.criteria,
        "desktopId":row.desktop_id, "desktopGeneration":row.desktop_generation,
        "deadlineAt":row.deadline_at, "launchArgv":row.launch_argv, "cwd":".",
        "acceptanceFiles":row.acceptance_files, "transferManifestDigest":row.transfer_manifest_digest,
    });
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(&value).map_err(|_| refused("managed_desktop_invalid_request"))?)))
}
fn load(path: &Path) -> Result<DiagnosticRequest> {
    let metadata = fs::symlink_metadata(path).map_err(|_| refused("managed_desktop_handoff_request_unavailable"))?;
    if !metadata.is_file() || metadata.len() > 128 * 1024 { return Err(refused("managed_desktop_handoff_invalid_request")); }
    let bytes = fs::read(path).map_err(|_| refused("managed_desktop_handoff_request_unavailable"))?;
    let request: DiagnosticRequest = serde_json::from_slice(&bytes).map_err(|_| refused("managed_desktop_handoff_invalid_request"))?;
    let id = uuid::Uuid::parse_str(&request.operation_id).map_err(|_| refused("managed_desktop_handoff_invalid_request"))?;
    if id.to_string() != request.operation_id { return Err(refused("managed_desktop_handoff_invalid_request")); }
    request.request.validate()?;
    Ok(request)
}
fn persist(path: &Path, row: &ChildAcceptanceRun) -> Result<()> {
    let root = path.parent().ok_or_else(|| refused("managed_desktop_storage_unavailable"))?;
    let mut tmp = tempfile::NamedTempFile::new_in(root).map_err(|_| refused("managed_desktop_storage_unavailable"))?;
    // The encrypted evidence store is the sole durable owner of source/test
    // content. This duplicate-spend diagnostic retains only an opaque operation
    // ID and cleanup state, including failures before evidence registration.
    let receipt = serde_json::json!({"version":1,"id":row.id,"state":row.state,"cleanupPending":row.cleanup_pending});
    tmp.write_all(&serde_json::to_vec(&receipt).map_err(|_| refused("managed_desktop_storage_unavailable"))?)
        .and_then(|_| tmp.as_file().sync_all()).map_err(|_| refused("managed_desktop_storage_unavailable"))?;
    tmp.persist(path).map_err(|_| refused("managed_desktop_storage_unavailable"))?;
    fs::File::open(root).and_then(|f| f.sync_all()).map_err(|_| refused("managed_desktop_storage_unavailable"))
}
async fn persist_async(path: &Path, row: &ChildAcceptanceRun) -> Result<()> {
    let path = path.to_owned(); let row = row.clone();
    tokio::task::spawn_blocking(move || persist(&path, &row)).await
        .map_err(|_| refused("managed_desktop_storage_unavailable"))?
}
async fn claim_operation(directory: &Path, operation_id: &str) -> Result<PathBuf> {
    let directory = directory.to_owned(); let operation_id = operation_id.to_owned();
    tokio::task::spawn_blocking(move || {
        let reports = directory.join("managed-desktop-handoffs");
        fs::create_dir_all(&reports).map_err(|_| refused("managed_desktop_storage_unavailable"))?;
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&reports, fs::Permissions::from_mode(0o700)).map_err(|_| refused("managed_desktop_storage_unavailable"))?;
        }
        let claim = reports.join(format!("{operation_id}.claim"));
        let file = fs::OpenOptions::new().write(true).create_new(true).open(claim)
            .map_err(|error| refused(if error.kind() == std::io::ErrorKind::AlreadyExists { "managed_desktop_handoff_duplicate_operation" } else { "managed_desktop_storage_unavailable" }))?;
        file.sync_all().map_err(|_| refused("managed_desktop_storage_unavailable"))?;
        fs::File::open(&reports).and_then(|f| f.sync_all()).map_err(|_| refused("managed_desktop_storage_unavailable"))?;
        Ok(reports.join(format!("{operation_id}.json")))
    }).await.map_err(|_| refused("managed_desktop_storage_unavailable"))?
}
struct SourceWatcher { task: tokio::task::JoinHandle<()> }
impl Drop for SourceWatcher { fn drop(&mut self) { self.task.abort(); } }

pub async fn run(
    host: &dyn ManagedDesktopSmokeHost, p: &ManagedDesktopPrincipal,
    directory: &Path, config_id: &str, request_path: PathBuf,
    _permit: ExplicitPaidSmokeAuthorization,
) -> Result<serde_json::Value> {
    p.require_admin()?;
    let input = tokio::task::spawn_blocking(move || load(&request_path)).await
        .map_err(|_| refused("managed_desktop_storage_unavailable"))??;
    if input.request.provider_config_id != config_id { return Err(refused("managed_desktop_handoff_config_mismatch")); }
    let directory = directory.to_owned();
    let root = directory.clone(); let principal = p.clone(); let request = input.request.clone();
    let (delivery, source) = tokio::task::spawn_blocking(move || resolve(&root, &principal, &request)).await
        .map_err(|_| refused("managed_desktop_storage_unavailable"))??;
    let service = host.open(host.provider())?;
    let mut row = ChildAcceptanceRun {
        version:1, id:input.operation_id.clone(), parent_run_id:source.coding_run_id.clone(),
        origin_run_ref:source.origin_run_ref.clone(), session_id:source.conversation_id.clone(),
        task_id:source.task_id.clone(), source_id:source.id.clone(), owner_account_id:p.owner_principal_id.clone(),
        host_id:p.host_id.clone(), delivery_id:delivery.id.clone(), delivery_revision:delivery.revision,
        commit:delivery.commit.clone().ok_or_else(|| refused("managed_desktop_handoff_delivery_unavailable"))?,
        mode:input.request.mode, criteria:input.request.criteria.clone(), desktop_id:None,
        desktop_generation:None, manifest_digest:None, transfer_manifest_digest:None,
        launch_argv:input.request.argv.clone(), acceptance_files:input.request.acceptance_files.clone(),
        deadline_at:None, state:"preparing".into(), cleanup_pending:false,
    };
    // An operation is claimed before any transfer/spend. An interrupted operation
    // can only be inspected/cleaned up, never silently create another desktop.
    let report = claim_operation(&directory, &input.operation_id).await?;
    persist_async(&report, &row).await?;
    let (cancel, cancelled) = tokio::sync::watch::channel(false);
    let check_root = directory.clone(); let check_principal = p.clone(); let check_request = input.request.clone();
    let check: Arc<dyn Fn() -> bool + Send + Sync> = Arc::new(move || resolve(&check_root, &check_principal, &check_request).is_ok());
    let watcher_check = check.clone(); let revoke = cancel.clone();
    let _watcher = SourceWatcher { task:tokio::spawn(async move {
        loop {
            let check = watcher_check.clone();
            if !tokio::task::spawn_blocking(move || check()).await.unwrap_or(false) { let _ = revoke.send(true); break; }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }) };
    let budget = HandoffBudget { deadline_at_ms: chrono::Utc::now().timestamp_millis().saturating_add(10 * 60 * 1000), cancel:cancelled };
    let mut native_receipt = None;
    let outcome: Result<()> = async {
        let upstream = url::Url::parse(&source.repository_url).map_err(|_| refused("managed_desktop_handoff_source_unavailable"))?;
        let credential = if let Some(reference) = source.credential_ref.clone().filter(|value| value.starts_with("git-helper:")) {
            if reference != format!("git-helper:{}", hex::encode(Sha256::digest(source.repository_url.as_bytes()))) {
                return Err(refused("managed_desktop_handoff_source_unavailable"));
            }
            cognia_sandbox_pool::git_proxy::host_credential(&upstream).await
        } else if let Some(reference) = source.credential_ref.clone() {
            tokio::task::spawn_blocking(move || cognia_secrets::secret_store::get("cognia-delivery-sources", &reference))
                .await.map_err(|_| refused("managed_desktop_secret_unavailable"))?
                .map_err(|_| refused("managed_desktop_secret_unavailable"))?
                .ok_or_else(|| refused("managed_desktop_secret_unavailable"))?.into()
        } else { None };
        let proxy = GitProxy::start_read_only(GitProxyConfig { upstream, credential, branch:source.branch.clone() }).await
            .map_err(|_| refused("managed_desktop_handoff_source_unavailable"))?;
        let recovery = if input.request.mode == TransferMode::Bundle {
            Some(RecoverySource { path:PathBuf::from(delivery.publish["recovery"]["bundle"].as_str()
                .ok_or_else(|| refused("managed_desktop_handoff_delivery_unavailable"))?),
                trusted_root:directory.join("sandbox-recovery"), expected_sha256:None })
        } else { None };
        let prepared = handoff::prepare_source(&TrustedHandoffSource { commit:row.commit.clone(), readonly_proxy_port:proxy.port(), recovery }, &input.request.acceptance_files, &budget)
            .await.map_err(|_| refused("managed_desktop_handoff_transfer_failed"))?;
        row.transfer_manifest_digest = Some(prepared.manifest_digest().into());
        let quote = service.quote(p, config_id, input.request.lifetime_seconds).await?;
        eprintln!("Handoff transfers the pinned repository and its Git history, plus the selected acceptance files. It does not sanitize committed content. This diagnostic records no acceptance verdict and always destroys its desktop.");
        host.approve_quote(&quote, AuthorizationPurpose::Smoke).await?;
        let current = check.clone();
        if !tokio::task::spawn_blocking(move || current()).await.unwrap_or(false) { return Err(refused("managed_desktop_handoff_source_unavailable")); }
        budget.check().map_err(|_| refused("managed_desktop_handoff_deadline"))?;
        let authorization = service.authorize(p, config_id, &quote.id, AuthorizationPurpose::Smoke, Some(format!("handoff:{}",input.operation_id))).await?;
        row.state = "creating".into(); row.cleanup_pending = true; persist_async(&report, &row).await?;
        let mut desktop = service.create_smoke(p, CreateManagedDesktop { provider_config_id:config_id.into(), quote_id:quote.id, authorization_id:authorization.id, idempotency_key:input.operation_id.clone() }).await?;
        row.desktop_id = Some(desktop.id.clone()); row.desktop_generation = Some(desktop.generation);
        while desktop.state == ManagedDesktopState::Creating {
            budget.check().map_err(|_| refused("managed_desktop_handoff_deadline"))?;
            if chrono::Utc::now().timestamp_millis() >= desktop.deadline_at {
                return Err(refused("managed_desktop_handoff_deadline"));
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
            desktop = service.connect(p, &desktop.id, desktop.generation).await?;
        }
        row.deadline_at = Some(desktop.deadline_at);
        row.manifest_digest = Some(manifest_digest(&row)?);
        row.state = "transferring".into(); persist_async(&report, &row).await?;
        let binding = AcceptanceBinding {
            acceptance_id:row.id.clone(), owner_account_id:row.owner_account_id.clone(), host_id:row.host_id.clone(),
            source_id:row.source_id.clone(), session_id:row.session_id.clone(), task_id:row.task_id.clone(),
            parent_run_id:row.parent_run_id.clone(), origin_run_ref:Some(row.origin_run_ref.clone()),
            delivery_id:row.delivery_id.clone(), delivery_revision:row.delivery_revision, commit:row.commit.clone(),
            desktop_id:desktop.id.clone(), desktop_generation:desktop.generation,
            manifest_digest:row.manifest_digest.clone().ok_or_else(|| refused("managed_desktop_handoff_invalid_request"))?,
            agent_principal_id:None,
            criteria:row.criteria.iter().enumerate().map(|(i,text)| AcceptanceCriterion {
                id:format!("criterion-{i}"), text:text.clone(), required_evidence:true,
            }).collect(),
        };
        evidence_write(&directory, p, move |s,owner,host| s.register(owner,host,binding).map(|_| ())).await?;
        let launch = handoff::parse_launch(&input.request.argv).map_err(|_| refused("managed_desktop_handoff_invalid_launch"))?;
        let installed = service.install_handoff_smoke(p, &desktop, &prepared, &input.operation_id, launch.as_ref(), &budget, check.clone()).await?;
        // Reopen the same exclusive Host journal before reconnecting. This
        // proves persisted generation admission rather than a cloned cache.
        drop(service);
        let service = host.open(host.provider())?;
        let reconnected = service.connect(p, &desktop.id, desktop.generation).await?;
        if reconnected.state != ManagedDesktopState::Running || reconnected.deadline_at != desktop.deadline_at {
            return Err(refused("managed_desktop_handoff_reconnect_failed"));
        }
        let boundary = service.validate_live_boundary(p, &reconnected).await?;
        handoff::validate_installed_boundary(&installed, &boundary.observation)
            .map_err(|_| refused("managed_desktop_boundary_mismatch"))?;
        native_receipt = Some(serde_json::json!({"evidenceVersion":2,"mode":input.request.mode,
            "hostBoundary":boundary,"installed":installed,"restartReconnectVerified":true}));
        let screenshot = service.capture_handoff_smoke(p, &desktop, &input.operation_id).await?;
        let current = check.clone();
        if !tokio::task::spawn_blocking(move || current()).await.unwrap_or(false) { return Err(refused("managed_desktop_handoff_source_unavailable")); }
        let bytes = base64::engine::general_purpose::STANDARD.decode(&screenshot.bytes)
            .map_err(|_| refused("managed_desktop_evidence_invalid_image"))?;
        let acceptance_id = row.id.clone();
        evidence_write(&directory, p, move |s,owner,host| s.capture(owner,host,&acceptance_id,
            CaptureInput { artifact_id:uuid::Uuid::new_v4().to_string(), criterion_id:"criterion-0".into(),
                kind:CaptureKind::Checkpoint, explicitly_requested:true, sensitive_human_input:false }, &bytes).map(|_| ())).await?;
        row.state = "diagnosticCompleted".into();
        Ok(())
    }.await;
    let _ = cancel.send(true);
    if outcome.is_err() { row.state = "failed".into(); }
    let cleanup = async {
        // A failed reopen must still persist cleanupPending below. Never
        // short-circuit the durable outcome after a billed create.
        let service = host.open(host.provider())?;
        service.cleanup_handoff_smoke(p, &input.operation_id).await
    };
    let diagnostic = finish_diagnostic(&report, &mut row, outcome, cleanup).await;
    if row.manifest_digest.is_some() {
        let id = row.id.clone(); let pending = row.cleanup_pending;
        let reason = if diagnostic.is_ok() { "diagnostic_no_agent_verdict" } else { "diagnostic_incomplete" };
        evidence_write(&directory, p, move |s,owner,host| {
            s.finish_system(owner,host,&id,AcceptanceOutcome::Inconclusive,reason)?;
            s.set_cleanup_pending(owner,host,&id,pending).map(|_| ())
        }).await?;
    }
    diagnostic?;
    // A human-operated smoke is not an agent verdict or human acceptance approval.
    Ok(serde_json::json!({"childRunId":row.id,"parentRunId":row.parent_run_id,"deliveryId":row.delivery_id,"commit":row.commit,"manifestDigest":row.manifest_digest,"state":row.state,"cleanupPending":row.cleanup_pending,"executionEnabled":false,"nativeHandoffEvidence":native_receipt}))
}

async fn evidence_write(directory: &Path, p: &ManagedDesktopPrincipal,
    write: impl FnOnce(EvidenceStore, &str, &str) -> std::result::Result<(), String> + Send + 'static) -> Result<()> {
    let directory = directory.to_owned(); let owner = p.owner_principal_id.clone(); let host = p.host_id.clone();
    tokio::task::spawn_blocking(move || write(EvidenceStore::new(&directory), &owner, &host))
        .await.map_err(|_| refused("managed_desktop_evidence_unavailable"))?.map_err(|e| refused(&e))
}

// Failure does not short-circuit cleanup; its durable status is published even
// when provider deletion must be retried by the normal lifecycle reconciler.
async fn finish_diagnostic(path: &Path, row: &mut ChildAcceptanceRun, outcome: Result<()>,
    cleanup: impl std::future::Future<Output = Result<()>>) -> Result<()> {
    let cleanup = cleanup.await;
    row.cleanup_pending = cleanup.is_err();
    if outcome.is_err() { row.state = "failed".into(); }
    persist_async(path, row).await?;
    outcome?; cleanup
}

#[cfg(test)]
mod tests {
    use super::*;
    fn row() -> ChildAcceptanceRun {
        ChildAcceptanceRun { version:1, id:uuid::Uuid::new_v4().to_string(), parent_run_id:"parent".into(),
            origin_run_ref:"origin".into(), session_id:"chat".into(), task_id:"task".into(), source_id:"source".into(),
            owner_account_id:"owner".into(), host_id:"host".into(), delivery_id:"delivery".into(), delivery_revision:1,
            commit:"a".repeat(40), mode:TransferMode::Commit, criteria:vec!["loads".into()], desktop_id:Some("desktop".into()),
            desktop_generation:Some(1), manifest_digest:None, transfer_manifest_digest:Some("digest".into()),
            launch_argv:vec![], acceptance_files:vec![], deadline_at:Some(1234), state:"transferring".into(), cleanup_pending:true }
    }
    #[tokio::test]
    async fn failed_revoked_or_expired_transfer_still_cleans_up_and_persists_pending_destroy() {
        let root = tempfile::tempdir().unwrap(); let path = root.path().join("child.json");
        for error in ["managed_desktop_handoff_transfer_failed", "managed_desktop_handoff_source_unavailable", "managed_desktop_handoff_deadline"] {
            let mut child = row(); let called = std::sync::atomic::AtomicBool::new(false);
            let result = finish_diagnostic(&path, &mut child, Err(refused(error)), async {
                called.store(true, std::sync::atomic::Ordering::SeqCst);
                Err(refused("managed_desktop_handoff_cleanup_pending"))
            }).await;
            assert_eq!(result.unwrap_err().code, error);
            assert!(called.load(std::sync::atomic::Ordering::SeqCst));
            let persisted: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            assert_eq!(persisted["cleanupPending"], true); assert_eq!(persisted["state"], "failed");
            assert_eq!(persisted.as_object().unwrap().len(),4);
            assert!(persisted.get("parentRunId").is_none());
            assert!(persisted.get("criteria").is_none());
        }
        let mut child = row(); child.state = "diagnosticCompleted".into();
        finish_diagnostic(&path, &mut child, Ok(()), async { Ok(()) }).await.unwrap();
        assert!(!child.cleanup_pending);
    }
    #[test]
    fn manifest_binds_source_criteria_launch_deadline_and_transfer_content() {
        let child = row(); let original = manifest_digest(&child).unwrap();
        let mut changed = child.clone(); changed.criteria.push("another criterion".into());
        assert_ne!(original, manifest_digest(&changed).unwrap());
        let mut changed = child.clone(); changed.parent_run_id = "other".into();
        assert_ne!(original, manifest_digest(&changed).unwrap());
        let mut changed = child.clone(); changed.desktop_generation = Some(2);
        assert_ne!(original, manifest_digest(&changed).unwrap());
        let mut changed = child.clone(); changed.deadline_at = Some(9999);
        assert_ne!(original, manifest_digest(&changed).unwrap());
        let mut changed = child; changed.transfer_manifest_digest = Some("other".into());
        assert_ne!(original, manifest_digest(&changed).unwrap());
    }
    #[tokio::test]
    async fn operation_claim_survives_restart_and_never_repeats_spend() {
        let root = tempfile::tempdir().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let report = claim_operation(root.path(), &id).await.unwrap();
        assert_eq!(report.file_stem().unwrap().to_str().unwrap(), id);
        assert_eq!(claim_operation(root.path(), &id).await.unwrap_err().code, "managed_desktop_handoff_duplicate_operation");
    }
    #[test]
    fn operator_request_is_bounded_and_cannot_supply_source_credentials() {
        let dir = tempfile::tempdir().unwrap(); let file = dir.path().join("request.json");
        fs::write(&file, vec![b' '; 128 * 1024 + 1]).unwrap(); assert!(load(&file).is_err());
        fs::write(&file, br#"{"operationId":"x","request":{},"credential":"secret"}"#).unwrap(); assert!(load(&file).is_err());
    }
}

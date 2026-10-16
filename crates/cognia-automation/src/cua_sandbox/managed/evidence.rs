//! ADR-0228 P4: encrypted, source-bound acceptance evidence and deletion journal.
//!
//! All methods perform blocking disk/crypto work; callers must use spawn_blocking.
//! The authenticated Host supplies principals and validates current source authority.
//! No method accepts filesystem paths or creates a desktop, share, or model upload.
use aes_gcm::{aead::{Aead, KeyInit, Payload}, Aes256Gcm, Key, Nonce};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::{BTreeMap, BTreeSet}, fs::{self, File, OpenOptions}, io::{Read, Write}, path::{Path, PathBuf}};

pub const MAX_SCREENSHOTS: u32 = 100;
pub const MAX_TOTAL_BYTES: u64 = 100 * 1024 * 1024;
pub const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;
const MAX_INDEX_BYTES: usize = 32 * 1024 * 1024;
const ROOT: &str = "managed-desktop-evidence";
type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcceptanceCriterion {
    pub id: String,
    pub text: String,
    pub required_evidence: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcceptanceBinding {
    pub acceptance_id: String,
    pub owner_account_id: String,
    pub host_id: String,
    pub source_id: String,
    pub session_id: String,
    pub task_id: String,
    pub parent_run_id: String,
    pub origin_run_ref: Option<String>,
    pub delivery_id: String,
    pub delivery_revision: u64,
    pub commit: String,
    pub desktop_id: String,
    pub desktop_generation: u64,
    pub manifest_digest: String,
    /// Assigned only by authenticated Host delegation, never by the renderer.
    pub agent_principal_id: Option<String>,
    pub criteria: Vec<AcceptanceCriterion>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureKind { Checkpoint, Failure }
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureInput {
    pub artifact_id: String,
    pub criterion_id: String,
    pub kind: CaptureKind,
    /// The caller must suppress automatic capture during sensitive human input.
    pub explicitly_requested: bool,
    pub sensitive_human_input: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceArtifact {
    pub id: String,
    pub criterion_id: String,
    pub kind: CaptureKind,
    pub mime_type: String,
    pub sha256: String,
    pub bytes: u64,
    pub width: u32,
    pub height: u32,
    pub captured_at: i64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AcceptanceOutcome { Passed, Failed, Inconclusive, Cancelled }
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CriterionOutcome { Passed, Failed, Incomplete }
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CriterionResult {
    pub criterion_id: String,
    pub outcome: CriterionOutcome,
    pub artifact_ids: Vec<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentVerdictInput {
    pub idempotency_key: String,
    pub principal_id: String,
    pub outcome: AcceptanceOutcome,
    pub criteria: Vec<CriterionResult>,
    pub summary: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentVerdict {
    pub input: AgentVerdictInput,
    pub recorded_at: i64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemOutcome {
    pub outcome: AcceptanceOutcome,
    pub reason_code: String,
    pub recorded_at: i64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalDecision { Approved, Rejected }
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HumanApprovalInput {
    pub expected_revision: u64,
    pub idempotency_key: String,
    pub principal_id: String,
    pub decision: ApprovalDecision,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HumanApproval {
    pub revision: u64,
    pub input: HumanApprovalInput,
    pub recorded_at: i64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceptanceResult {
    pub binding: AcceptanceBinding,
    pub created_at: i64,
    pub artifacts: Vec<EvidenceArtifact>,
    pub agent_verdict: Option<AgentVerdict>,
    pub system_outcome: Option<SystemOutcome>,
    pub human_approvals: Vec<HumanApproval>,
    pub cleanup_pending: bool,
    pub evidence_limit_reached: bool,
    pub capture_attempts: u32,
    pub reserved_bytes: u64,
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResultFilter {
    pub run_id: Option<String>,
    pub conversation_id: Option<String>,
    pub task_id: Option<String>,
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeletionScope {
    #[serde(default)] pub session_ids: Vec<String>,
    #[serde(default)] pub task_ids: Vec<String>,
    #[serde(default)] pub acceptance_ids: Vec<String>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeletionState { Prepared, Committed, Aborted }
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletionIntent {
    pub id: String,
    pub owner_account_id: String,
    pub host_id: String,
    pub scope: DeletionScope,
    pub acceptance_ids: Vec<String>,
    pub state: DeletionState,
    pub cleanup_pending: bool,
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileReport {
    pub removed_files: u32,
    pub pending_deletions: u32,
    pub prepared_deletions: u32,
}
#[derive(Clone)]
pub struct EvidenceStore {
    root: PathBuf,
    admission: Option<std::sync::Arc<dyn Fn() -> bool + Send + Sync>>,
    #[cfg(test)] test_key: Option<[u8; 32]>,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Index {
    version: u32,
    records: BTreeMap<String, AcceptanceResult>,
    intents: BTreeMap<String, DeletionIntent>,
    /// Reservations are published before blob writes. Failed writes keep quota consumed.
    pending_artifacts: BTreeMap<String, Vec<String>>,
    cleanup_targets: BTreeMap<String, CleanupTarget>,
    /// Only canonical native task deletion has a Host-readable source-of-truth.
    #[serde(default)]
    native_task_deletions: BTreeSet<String>,
    /// A present None explicitly denotes local authority; a missing entry is unsafe.
    #[serde(default)]
    native_task_devices: BTreeMap<String, Option<String>>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupTarget {
    pub acceptance_id: String,
    pub owner_account_id: String,
    pub host_id: String,
    pub desktop_id: String,
    pub desktop_generation: u64,
}
struct LockedStore { _lock: File, key: [u8; 32], index: Index }

impl EvidenceStore {
    pub fn new(data_dir: &Path) -> Self {
        Self { root: data_dir.join(ROOT), admission: None, #[cfg(test)] test_key: None }
    }
    /// RPC callers attach their live authority fence before offloading work.
    /// Recheck after obtaining the file lock so queued work cannot use a lease
    /// that expired while another storage operation held the lock.
    pub fn with_admission(mut self, admission: std::sync::Arc<dyn Fn() -> bool + Send + Sync>) -> Self {
        self.admission = Some(admission);
        self
    }
    pub fn register(&self, owner: &str, host: &str, binding: AcceptanceBinding) -> Result<AcceptanceResult> {
        validate_binding(&binding)?;
        check_owner(&binding, owner, host)?;
        let mut state = self.lock()?;
        check_fence(&state.index, &binding)?;
        if let Some(previous) = state.index.records.get(&binding.acceptance_id) {
            return if previous.binding == binding { Ok(previous.clone()) } else { Err("acceptance_identity_conflict".into()) };
        }
        let row = AcceptanceResult {
            binding, created_at: now(), artifacts: vec![], agent_verdict: None,
            system_outcome: None, human_approvals: vec![], cleanup_pending: false,
            evidence_limit_reached: false, capture_attempts: 0, reserved_bytes: 0,
        };
        state.index.records.insert(row.binding.acceptance_id.clone(), row.clone());
        self.save(&state)?;
        Ok(row)
    }
    pub fn list(&self, owner: &str, host: &str, filter: ResultFilter) -> Result<Vec<AcceptanceResult>> {
        let state = self.lock()?;
        Ok(state.index.records.values().filter(|r| {
            check_owner(&r.binding, owner, host).is_ok()
                && check_fence(&state.index, &r.binding).is_ok()
                && filter.conversation_id.as_ref().is_none_or(|id| *id == r.binding.session_id)
                && filter.task_id.as_ref().is_none_or(|id| *id == r.binding.task_id)
                && filter.run_id.as_ref().is_none_or(|id| *id == r.binding.acceptance_id
                    || *id == format!("execution:managed-desktop:{}", r.binding.acceptance_id)
                    || *id == r.binding.parent_run_id || r.binding.origin_run_ref.as_ref() == Some(id))
        }).cloned().collect())
    }
    pub fn get(&self, owner: &str, host: &str, id: &str) -> Result<AcceptanceResult> {
        let state = self.lock()?;
        Ok(authorized(&state.index, owner, host, id)?.clone())
    }
    pub fn read_image(&self, owner: &str, host: &str, id: &str, artifact_id: &str) -> Result<(EvidenceArtifact, Vec<u8>)> {
        let state = self.lock()?;
        let record = authorized(&state.index, owner, host, id)?;
        let artifact = record.artifacts.iter().find(|a| a.id == artifact_id).ok_or("evidence_not_found")?;
        let bytes = self.read_artifact(&state, id, artifact)?;
        Ok((artifact.clone(), bytes))
    }
    /// Resolve a semantic capture retry before touching the desktop again.
    /// The artifact identifier names one capture, not a new sample of pixels.
    /// Owner, deletion fences and durable image integrity still apply to retries.
    pub fn captured(&self, owner: &str, host: &str, id: &str, input: &CaptureInput) -> Result<Option<EvidenceArtifact>> {
        canonical_id(&input.artifact_id)?;
        let state = self.lock()?;
        let record = authorized(&state.index, owner, host, id)?;
        if input.sensitive_human_input && !input.explicitly_requested { return Err("sensitive_capture_requires_request".into()); }
        if !record.binding.criteria.iter().any(|c| c.id == input.criterion_id) { return Err("evidence_criterion_invalid".into()); }
        if let Some(previous) = record.artifacts.iter().find(|a| a.id == input.artifact_id) {
            if previous.criterion_id != input.criterion_id || previous.kind != input.kind {
                return Err("evidence_idempotency_conflict".into());
            }
            self.read_artifact(&state, id, previous)?;
            return Ok(Some(previous.clone()));
        }
        if terminal(record) { return Err("acceptance_terminal".into()); }
        if state.index.pending_artifacts.get(id).is_some_and(|ids| ids.contains(&input.artifact_id)) {
            return Err("evidence_capture_previously_incomplete".into());
        }
        Ok(None)
    }
    pub fn capture(&self, owner: &str, host: &str, id: &str, input: CaptureInput, bytes: &[u8]) -> Result<EvidenceArtifact> {
        canonical_id(&input.artifact_id)?;
        let mut state = self.lock()?;
        let record = authorized(&state.index, owner, host, id)?;
        if input.sensitive_human_input && !input.explicitly_requested { return Err("sensitive_capture_requires_request".into()); }
        if !record.binding.criteria.iter().any(|c| c.id == input.criterion_id) { return Err("evidence_criterion_invalid".into()); }
        let hash = digest(bytes);
        if let Some(previous) = record.artifacts.iter().find(|a| a.id == input.artifact_id) {
            return if previous.criterion_id == input.criterion_id && previous.kind == input.kind {
                // Concurrent publication keeps the original capture, even if a second
                // sampler already observed newer pixels. Verify the retained bytes.
                self.read_artifact(&state, id, previous)?;
                Ok(previous.clone())
            } else { Err("evidence_idempotency_conflict".into()) };
        }
        if terminal(record) { return Err("acceptance_terminal".into()); }
        if state.index.pending_artifacts.get(id).is_some_and(|ids| ids.contains(&input.artifact_id)) {
            return Err("evidence_capture_previously_incomplete".into());
        }
        if record.capture_attempts >= MAX_SCREENSHOTS || bytes.len() > MAX_IMAGE_BYTES
            || record.reserved_bytes.saturating_add(bytes.len() as u64) > MAX_TOTAL_BYTES {
            state.index.records.get_mut(id).unwrap().evidence_limit_reached = true;
            self.save(&state)?;
            return Err("evidence_limit_reached".into());
        }
        // Reserve first: malformed images and interrupted publication consume quota too.
        let record = state.index.records.get_mut(id).unwrap();
        record.capture_attempts += 1;
        record.reserved_bytes += bytes.len() as u64;
        state.index.pending_artifacts.entry(id.into()).or_default().push(input.artifact_id.clone());
        self.save(&state)?;
        let (mime_type, width, height) = image_info(bytes)?;
        let artifact = EvidenceArtifact { id: input.artifact_id, criterion_id: input.criterion_id,
            kind: input.kind, mime_type, sha256: hash, bytes: bytes.len() as u64,
            width, height, captured_at: now() };
        let directory = self.run_directory(id)?;
        private_directory(&directory)?;
        let encoded = encrypt(&state.key, bytes, &blob_aad(id, &artifact.id))?;
        atomic_write(&directory.join(&artifact.id), &encoded)?;
        state.index.records.get_mut(id).unwrap().artifacts.push(artifact.clone());
        state.index.pending_artifacts.get_mut(id).unwrap().retain(|a| *a != artifact.id);
        self.save(&state)?;
        Ok(artifact)
    }
    pub fn complete(&self, owner: &str, host: &str, id: &str, input: AgentVerdictInput) -> Result<AcceptanceResult> {
        text(&input.idempotency_key, 256)?;
        text(&input.principal_id, 256)?;
        if input.summary.len() > 8192 { return Err("acceptance_summary_limit".into()); }
        let mut state = self.lock()?;
        let record = authorized(&state.index, owner, host, id)?;
        if record.binding.agent_principal_id.as_ref() != Some(&input.principal_id) {
            return Err("acceptance_agent_authority_required".into());
        }
        if let Some(previous) = &record.agent_verdict {
            return if previous.input == input { Ok(record.clone()) } else { Err("acceptance_verdict_immutable".into()) };
        }
        if record.system_outcome.is_some() { return Err("acceptance_terminal".into()); }
        let mut ids = BTreeSet::new();
        for result in &input.criteria {
            if !ids.insert(&result.criterion_id) || !record.binding.criteria.iter().any(|c| c.id == result.criterion_id) {
                return Err("acceptance_criteria_invalid".into());
            }
            let mut artifacts = BTreeSet::new();
            for artifact_id in &result.artifact_ids {
                if !artifacts.insert(artifact_id) { return Err("acceptance_criteria_invalid".into()); }
                let artifact = record.artifacts.iter().find(|a| a.id == *artifact_id && a.criterion_id == result.criterion_id)
                    .ok_or("acceptance_evidence_missing")?;
                self.read_artifact(&state, id, artifact)?;
            }
        }
        if input.outcome == AcceptanceOutcome::Passed {
            if record.evidence_limit_reached || input.criteria.len() != record.binding.criteria.len()
                || input.criteria.iter().any(|r| r.outcome != CriterionOutcome::Passed)
                || record.binding.criteria.iter().any(|criterion| criterion.required_evidence && !input.criteria.iter()
                    .any(|r| r.criterion_id == criterion.id && !r.artifact_ids.is_empty())) {
                return Err("acceptance_pass_requires_complete_evidence".into());
            }
        }
        if input.outcome == AcceptanceOutcome::Failed && !input.criteria.iter().any(|c| c.outcome == CriterionOutcome::Failed) {
            return Err("acceptance_failed_criterion_required".into());
        }
        state.index.records.get_mut(id).unwrap().agent_verdict = Some(AgentVerdict { input, recorded_at: now() });
        self.save(&state)?;
        Ok(state.index.records[id].clone())
    }
    /// A diagnostic/provisioning failure is not an agent's verdict.
    pub fn finish_system(&self, owner: &str, host: &str, id: &str, outcome: AcceptanceOutcome, reason_code: &str) -> Result<AcceptanceResult> {
        if !matches!(outcome, AcceptanceOutcome::Inconclusive | AcceptanceOutcome::Cancelled)
            || reason_code.is_empty() || reason_code.len() > 128
            || !reason_code.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_') {
            return Err("acceptance_system_outcome_invalid".into());
        }
        let mut state = self.lock()?;
        let row = authorized(&state.index, owner, host, id)?;
        if let Some(previous) = &row.system_outcome {
            return if previous.outcome == outcome && previous.reason_code == reason_code { Ok(row.clone()) }
                else { Err("acceptance_verdict_immutable".into()) };
        }
        if row.agent_verdict.is_some() { return Err("acceptance_terminal".into()); }
        state.index.records.get_mut(id).unwrap().system_outcome = Some(SystemOutcome { outcome, reason_code: reason_code.into(), recorded_at: now() });
        self.save(&state)?;
        Ok(state.index.records[id].clone())
    }
    pub fn approve(&self, owner: &str, host: &str, id: &str, input: HumanApprovalInput) -> Result<AcceptanceResult> {
        text(&input.idempotency_key, 256)?;
        text(&input.principal_id, 256)?;
        let mut state = self.lock()?;
        let row = authorized(&state.index, owner, host, id)?;
        if !terminal(row) { return Err("acceptance_result_pending".into()); }
        if let Some(previous) = row.human_approvals.iter().find(|r| r.input.idempotency_key == input.idempotency_key) {
            return if previous.input == input { Ok(row.clone()) } else { Err("acceptance_approval_conflict".into()) };
        }
        let revision = row.human_approvals.last().map_or(0, |r| r.revision);
        if revision != input.expected_revision { return Err("acceptance_approval_revision_conflict".into()); }
        if revision >= 1000 { return Err("acceptance_approval_limit".into()); }
        state.index.records.get_mut(id).unwrap().human_approvals.push(HumanApproval { revision: revision + 1, input, recorded_at: now() });
        self.save(&state)?;
        Ok(state.index.records[id].clone())
    }
    pub fn set_cleanup_pending(&self, owner: &str, host: &str, id: &str, pending: bool) -> Result<AcceptanceResult> {
        let mut state = self.lock()?;
        authorized(&state.index, owner, host, id)?;
        state.index.records.get_mut(id).unwrap().cleanup_pending = pending;
        self.save(&state)?;
        Ok(state.index.records[id].clone())
    }
    pub fn prepare_delete(&self, owner: &str, host: &str, id: &str, scope: DeletionScope) -> Result<DeletionIntent> {
        self.prepare_delete_inner(owner, host, id, scope, None)
    }
    /// The marker and prepare fence are one encrypted journal publication. Only
    /// the canonical native task deletion wrapper may call this method.
    pub fn prepare_native_task_delete(&self, owner: &str, host: &str, id: &str, task_id: &str, device: Option<String>) -> Result<DeletionIntent> {
        self.prepare_delete_inner(owner, host, id, DeletionScope {
            task_ids: vec![task_id.into()], ..Default::default()
        }, Some(device))
    }
    /// The Host resolves these against its native task authority after restart.
    /// Ordinary renderer/database scopes must never be inferred from task absence.
    pub fn list_native_task_deletions(&self) -> Result<Vec<(DeletionIntent, Option<String>)>> {
        if !self.root.try_exists().map_err(|_| "evidence_storage_unavailable")? { return Ok(vec![]); }
        let state = self.lock()?;
        state.index.native_task_deletions.iter().filter_map(|id| state.index.intents.get(id))
            .filter(|intent| intent.state == DeletionState::Prepared).map(|intent| {
                let device = state.index.native_task_devices.get(&intent.id)
                    .ok_or("evidence_native_deletion_device_missing")?;
                Ok((intent.clone(), device.clone()))
            }).collect()
    }
    fn prepare_delete_inner(&self, owner: &str, host: &str, id: &str, scope: DeletionScope, native_device: Option<Option<String>>) -> Result<DeletionIntent> {
        canonical_id(id)?;
        validate_scope(&scope)?;
        if let Some(Some(device)) = &native_device { text(device, 256)?; }
        text(owner, 256)?;
        text(host, 256)?;
        let mut state = self.lock()?;
        if let Some(previous) = state.index.intents.get(id) {
            check_intent_owner(previous, owner, host)?;
            if previous.scope != scope || previous.state == DeletionState::Aborted {
                return Err("evidence_deletion_conflict".into());
            }
            let receipt = previous.clone();
            if let Some(device) = native_device {
                if let Some(previous_device) = state.index.native_task_devices.get(id) {
                    if previous_device != &device { return Err("evidence_deletion_device_conflict".into()); }
                } else if state.index.native_task_deletions.contains(id) {
                    // Old prepared native markers cannot acquire broader authority on retry.
                    return Err("evidence_native_deletion_device_missing".into());
                }
                if receipt.state == DeletionState::Prepared && state.index.native_task_deletions.insert(id.into()) {
                    state.index.native_task_devices.insert(id.into(), device);
                    self.save(&state)?;
                }
            }
            return Ok(receipt);
        }
        let acceptance_ids = state.index.records.values().filter(|row| {
            check_owner(&row.binding, owner, host).is_ok() && matches_scope(&scope, &row.binding)
        }).map(|row| row.binding.acceptance_id.clone()).collect();
        let intent = DeletionIntent { id: id.into(), owner_account_id: owner.into(), host_id: host.into(), scope,
            acceptance_ids, state: DeletionState::Prepared, cleanup_pending: false };
        state.index.intents.insert(id.into(), intent.clone());
        if let Some(device) = native_device {
            state.index.native_task_deletions.insert(id.into());
            state.index.native_task_devices.insert(id.into(), device);
        }
        self.save(&state)?;
        Ok(intent)
    }
    pub fn commit_delete(&self, owner: &str, host: &str, id: &str) -> Result<DeletionIntent> {
        let mut state = self.lock()?;
        let intent = state.index.intents.get(id).ok_or("evidence_deletion_missing")?;
        check_intent_owner(intent, owner, host)?;
        if intent.state == DeletionState::Aborted { return Err("evidence_deletion_aborted".into()); }
        if intent.state != DeletionState::Committed {
            let ids = intent.acceptance_ids.clone();
            for acceptance_id in &ids {
                if let Some(row) = state.index.records.get(acceptance_id) {
                    let b = &row.binding;
                    state.index.cleanup_targets.insert(acceptance_id.clone(), CleanupTarget {
                        acceptance_id: acceptance_id.clone(), owner_account_id: b.owner_account_id.clone(),
                        host_id: b.host_id.clone(), desktop_id: b.desktop_id.clone(), desktop_generation: b.desktop_generation,
                    });
                }
            }
            let intent = state.index.intents.get_mut(id).unwrap();
            intent.state = DeletionState::Committed;
            intent.cleanup_pending = !ids.is_empty();
            // This acknowledgement is durable before bytes are released.
            state.index.native_task_deletions.remove(id);
            state.index.native_task_devices.remove(id);
            self.save(&state)?;
        }
        self.gc_locked(&mut state)?;
        Ok(state.index.intents[id].clone())
    }
    pub fn abort_delete(&self, owner: &str, host: &str, id: &str) -> Result<DeletionIntent> {
        let mut state = self.lock()?;
        canonical_id(id)?;
        text(owner, 256)?;
        text(host, 256)?;
        // An outbox can be replayed after its prepare request was lost. Remember
        // the abort so that a delayed prepare cannot later freeze this history.
        let intent = state.index.intents.entry(id.into()).or_insert_with(|| DeletionIntent {
            id: id.into(), owner_account_id: owner.into(), host_id: host.into(),
            scope: DeletionScope::default(), acceptance_ids: vec![], state: DeletionState::Aborted, cleanup_pending: false,
        });
        check_intent_owner(intent, owner, host)?;
        if intent.state == DeletionState::Committed { return Err("evidence_deletion_committed".into()); }
        intent.state = DeletionState::Aborted;
        intent.cleanup_pending = false;
        let result = intent.clone();
        state.index.native_task_deletions.remove(id);
        state.index.native_task_devices.remove(id);
        self.save(&state)?;
        Ok(result)
    }
    /// Host startup invokes this even when acceptance creation is disabled.
    /// Prepared intents deliberately remain frozen until the canonical outbox resolves them.
    pub fn reconcile(&self) -> Result<ReconcileReport> {
        if !self.root.try_exists().map_err(|_| "evidence_storage_unavailable")? { return Ok(ReconcileReport::default()); }
        let mut state = self.lock()?;
        self.gc_locked(&mut state)
    }
    pub fn list_cleanup_targets(&self) -> Result<Vec<CleanupTarget>> {
        if !self.root.try_exists().map_err(|_| "evidence_storage_unavailable")? { return Ok(vec![]); }
        Ok(self.lock()?.index.cleanup_targets.values().cloned().collect())
    }
    pub fn mark_desktop_cleaned(&self, owner: &str, host: &str, id: &str) -> Result<()> {
        let mut state = self.lock()?;
        if let Some(target) = state.index.cleanup_targets.get(id) {
            if target.owner_account_id != owner || target.host_id != host { return Err("evidence_not_found".into()); }
            state.index.cleanup_targets.remove(id);
            self.save(&state)?;
        }
        self.gc_locked(&mut state)?;
        Ok(())
    }
    fn gc_locked(&self, state: &mut LockedStore) -> Result<ReconcileReport> {
        let mut report = ReconcileReport::default();
        let mut modified = false;
        let committed: BTreeSet<String> = state.index.intents.values()
            .filter(|intent| intent.state == DeletionState::Committed)
            .flat_map(|intent| intent.acceptance_ids.clone()).collect();
        for id in &committed {
            let path = self.run_directory(id)?;
            match remove_run_directory(&path) {
                Ok(count) => {
                    report.removed_files = report.removed_files.saturating_add(count);
                    modified |= state.index.records.remove(id).is_some();
                    modified |= state.index.pending_artifacts.remove(id).is_some();
                }
                Err(_) => { /* The committed intent remains the durable retry queue. */ }
            }
        }
        // Interrupted captures are known reservations, not free quota. Clean their
        // partial blobs while retaining reservation IDs to prevent retry resurrection.
        for (id, artifacts) in &state.index.pending_artifacts {
            let directory = self.run_directory(id)?;
            if no_symlink_directory(&directory).is_err() { continue; }
            for artifact in artifacts {
                canonical_id(artifact)?;
                let path = directory.join(artifact);
                if remove_private_file(&path).is_ok_and(|removed| removed) {
                    report.removed_files = report.removed_files.saturating_add(1);
                }
            }
        }
        // Every staging filename is created under this owned tree. A crash before
        // rename can leave it; remove only this implementation's staging prefix.
        sweep_staging(&self.root, &mut report.removed_files)?;
        let records = &state.index.records;
        let cleanup_targets = &state.index.cleanup_targets;
        for intent in state.index.intents.values_mut() {
            if intent.state == DeletionState::Committed {
                let pending = intent.acceptance_ids.iter().any(|id| {
                    records.contains_key(id) || cleanup_targets.contains_key(id)
                });
                modified |= pending != intent.cleanup_pending;
                intent.cleanup_pending = pending;
                report.pending_deletions += u32::from(intent.cleanup_pending);
            } else if intent.state == DeletionState::Prepared {
                report.prepared_deletions += 1;
            }
        }
        if modified { self.save(state)?; }
        Ok(report)
    }
    fn run_directory(&self, id: &str) -> Result<PathBuf> {
        canonical_id(id)?;
        Ok(self.root.join(id))
    }
    fn lock(&self) -> Result<LockedStore> {
        private_directory(&self.root)?;
        let lock_path = self.root.join("store.lock");
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true);
        #[cfg(unix)] {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        let lock = options.open(lock_path).map_err(|_| "evidence_storage_unavailable")?;
        if !lock.metadata().map_err(|_| "evidence_storage_unavailable")?.is_file() { return Err("evidence_storage_invalid".into()); }
        lock.lock_exclusive().map_err(|_| "evidence_storage_busy")?;
        if self.admission.as_ref().is_some_and(|admitted| !admitted()) {
            return Err("evidence_authority_expired".into());
        }
        let path = self.root.join("index.enc");
        let key = self.key(path.exists())?;
        let index = match read_private(&path, MAX_INDEX_BYTES + 28)? {
            Some(bytes) => {
                let plaintext = decrypt(&key, &bytes, b"cognia-managed-evidence-index-v1")?;
                let index: Index = serde_json::from_slice(&plaintext).map_err(|_| "evidence_storage_corrupt")?;
                if index.version != 1 { return Err("evidence_storage_version".into()); }
                index
            }
            None => Index { version: 1, ..Default::default() },
        };
        Ok(LockedStore { _lock: lock, key, index })
    }
    fn key(&self, existing: bool) -> Result<[u8; 32]> {
        #[cfg(test)] if let Some(key) = self.test_key { return Ok(key); }
        let identity = digest(self.root.to_string_lossy().as_bytes());
        let service = "cognia-managed-desktop-evidence";
        match cognia_secrets::secret_store::get(service, &identity)? {
            Some(raw) => {
                let bytes = hex::decode(raw).map_err(|_| "evidence_key_invalid")?;
                bytes.try_into().map_err(|_| "evidence_key_invalid".into())
            }
            None if existing => Err("evidence_key_unavailable".into()),
            None => {
                let mut key = [0u8; 32];
                rand::fill(&mut key);
                cognia_secrets::secret_store::set(service, &identity, &hex::encode(key))?;
                Ok(key)
            }
        }
    }
    fn save(&self, state: &LockedStore) -> Result<()> {
        let bytes = serde_json::to_vec(&state.index).map_err(|_| "evidence_storage_invalid")?;
        if bytes.len() > MAX_INDEX_BYTES { return Err("evidence_storage_limit".into()); }
        atomic_write(&self.root.join("index.enc"), &encrypt(&state.key, &bytes, b"cognia-managed-evidence-index-v1")?)
    }
    fn read_artifact(&self, state: &LockedStore, id: &str, artifact: &EvidenceArtifact) -> Result<Vec<u8>> {
        canonical_id(&artifact.id)?;
        let directory = self.run_directory(id)?;
        no_symlink_directory(&directory)?;
        let blob = read_private(&directory.join(&artifact.id), MAX_IMAGE_BYTES + 28)?.ok_or("evidence_not_found")?;
        let bytes = decrypt(&state.key, &blob, &blob_aad(id, &artifact.id))?;
        if bytes.len() as u64 != artifact.bytes || digest(&bytes) != artifact.sha256 { return Err("evidence_integrity_failed".into()); }
        Ok(bytes)
    }
}

fn now() -> i64 { chrono::Utc::now().timestamp_millis() }
fn digest(bytes: &[u8]) -> String { hex::encode(Sha256::digest(bytes)) }
fn text(value: &str, max: usize) -> Result<()> {
    if value.trim().is_empty() || value.len() > max || value.chars().any(char::is_control) {
        Err("acceptance_input_invalid".into())
    } else { Ok(()) }
}
fn canonical_id(value: &str) -> Result<()> {
    if uuid::Uuid::parse_str(value).ok().is_some_and(|id| id.hyphenated().to_string() == value) { Ok(()) }
    else { Err("evidence_identifier_invalid".into()) }
}
fn validate_binding(binding: &AcceptanceBinding) -> Result<()> {
    canonical_id(&binding.acceptance_id)?;
    for value in [&binding.owner_account_id, &binding.host_id, &binding.source_id,
        &binding.session_id, &binding.task_id, &binding.parent_run_id, &binding.delivery_id, &binding.desktop_id] { text(value, 256)?; }
    if let Some(value) = &binding.origin_run_ref { text(value, 256)?; }
    if let Some(value) = &binding.agent_principal_id { text(value, 256)?; }
    if !matches!(binding.commit.len(), 40 | 64) || !binding.commit.bytes().all(|b| b.is_ascii_hexdigit())
        || binding.manifest_digest.len() != 64 || !binding.manifest_digest.bytes().all(|b| b.is_ascii_hexdigit())
        || binding.criteria.is_empty() || binding.criteria.len() > 50 {
        return Err("acceptance_binding_invalid".into());
    }
    let mut ids = BTreeSet::new();
    for criterion in &binding.criteria {
        text(&criterion.id, 128)?;
        text(&criterion.text, 1024)?;
        if !ids.insert(&criterion.id) { return Err("acceptance_criteria_invalid".into()); }
    }
    Ok(())
}
fn validate_scope(scope: &DeletionScope) -> Result<()> {
    let total = scope.session_ids.len() + scope.task_ids.len() + scope.acceptance_ids.len();
    if total == 0 || total > 1000 { return Err("evidence_deletion_scope_invalid".into()); }
    for value in scope.session_ids.iter().chain(&scope.task_ids).chain(&scope.acceptance_ids) { text(value, 256)?; }
    for value in &scope.acceptance_ids { canonical_id(value)?; }
    Ok(())
}
fn check_owner(binding: &AcceptanceBinding, owner: &str, host: &str) -> Result<()> {
    if binding.owner_account_id == owner && binding.host_id == host { Ok(()) } else { Err("evidence_not_found".into()) }
}
fn check_intent_owner(intent: &DeletionIntent, owner: &str, host: &str) -> Result<()> {
    if intent.owner_account_id == owner && intent.host_id == host { Ok(()) } else { Err("evidence_not_found".into()) }
}
fn matches_scope(scope: &DeletionScope, binding: &AcceptanceBinding) -> bool {
    scope.session_ids.contains(&binding.session_id) || scope.task_ids.contains(&binding.task_id)
        || scope.acceptance_ids.contains(&binding.acceptance_id)
}
fn check_fence(index: &Index, binding: &AcceptanceBinding) -> Result<()> {
    if index.intents.values().any(|intent| intent.state != DeletionState::Aborted
        && intent.owner_account_id == binding.owner_account_id && intent.host_id == binding.host_id
        && matches_scope(&intent.scope, binding)) { Err("evidence_deleted_or_deleting".into()) } else { Ok(()) }
}
fn authorized<'a>(index: &'a Index, owner: &str, host: &str, id: &str) -> Result<&'a AcceptanceResult> {
    let record = index.records.get(id).ok_or("evidence_not_found")?;
    check_owner(&record.binding, owner, host)?;
    check_fence(index, &record.binding)?;
    Ok(record)
}
fn terminal(row: &AcceptanceResult) -> bool { row.agent_verdict.is_some() || row.system_outcome.is_some() }
fn blob_aad(id: &str, artifact: &str) -> Vec<u8> { format!("cognia-managed-evidence-v1:{id}:{artifact}").into_bytes() }
fn encrypt(key: &[u8; 32], bytes: &[u8], aad: &[u8]) -> Result<Vec<u8>> {
    let cipher = Aes256Gcm::new(&Key::<Aes256Gcm>::from(*key));
    let mut nonce_bytes = [0u8; 12];
    rand::fill(&mut nonce_bytes);
    let nonce = Nonce::from(nonce_bytes);
    let ciphertext = cipher.encrypt(&nonce, Payload { msg: bytes, aad }).map_err(|_| "evidence_encryption_failed")?;
    let mut result = nonce_bytes.to_vec();
    result.extend(ciphertext);
    Ok(result)
}
fn decrypt(key: &[u8; 32], bytes: &[u8], aad: &[u8]) -> Result<Vec<u8>> {
    if bytes.len() < 28 { return Err("evidence_integrity_failed".into()); }
    let cipher = Aes256Gcm::new(&Key::<Aes256Gcm>::from(*key));
    let nonce = Nonce::try_from(&bytes[..12]).map_err(|_| "evidence_integrity_failed")?;
    cipher.decrypt(&nonce, Payload { msg: &bytes[12..], aad }).map_err(|_| "evidence_integrity_failed".into())
}
fn image_info(bytes: &[u8]) -> Result<(String, u32, u32)> {
    let mut reader = xcap::image::ImageReader::new(std::io::Cursor::new(bytes)).with_guessed_format()
        .map_err(|_| "evidence_image_invalid")?;
    let mime = match reader.format() {
        Some(xcap::image::ImageFormat::Png) => "image/png",
        Some(xcap::image::ImageFormat::Jpeg) => "image/jpeg",
        _ => return Err("evidence_image_format_unsupported".into()),
    };
    let mut limits = xcap::image::Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    let image = reader.decode().map_err(|_| "evidence_image_invalid")?;
    if image.width() == 0 || image.height() == 0 { return Err("evidence_image_invalid".into()); }
    Ok((mime.into(), image.width(), image.height()))
}
fn no_symlink_directory(path: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(path).map_err(|_| "evidence_storage_unavailable")?;
    if !meta.is_dir() || meta.file_type().is_symlink() { return Err("evidence_storage_invalid".into()); }
    Ok(())
}
fn private_directory(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(_) => no_symlink_directory(path)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => fs::create_dir(path).map_err(|_| "evidence_storage_unavailable")?,
        Err(_) => return Err("evidence_storage_unavailable".into()),
    }
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|_| "evidence_storage_unavailable")?;
    }
    Ok(())
}
fn read_private(path: &Path, maximum: usize) -> Result<Option<Vec<u8>>> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)] {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let mut file = match options.open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("evidence_storage_unavailable".into()),
    };
    let meta = file.metadata().map_err(|_| "evidence_storage_unavailable")?;
    if !meta.is_file() || meta.len() > maximum as u64 { return Err("evidence_storage_invalid".into()); }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file).take(maximum as u64 + 1).read_to_end(&mut bytes).map_err(|_| "evidence_storage_unavailable")?;
    if bytes.len() > maximum { return Err("evidence_storage_invalid".into()); }
    Ok(Some(bytes))
}
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().ok_or("evidence_storage_invalid")?;
    no_symlink_directory(parent)?;
    let mut file = tempfile::Builder::new().prefix(".evidence-stage-").tempfile_in(parent).map_err(|_| "evidence_storage_unavailable")?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        file.as_file().set_permissions(fs::Permissions::from_mode(0o600)).map_err(|_| "evidence_storage_unavailable")?;
    }
    file.write_all(bytes).and_then(|_| file.as_file().sync_all()).map_err(|_| "evidence_storage_unavailable")?;
    file.persist(path).map_err(|_| "evidence_storage_unavailable")?;
    File::open(parent).and_then(|directory| directory.sync_all()).map_err(|_| "evidence_storage_unavailable")?;
    Ok(())
}
fn remove_private_file(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_file() || meta.file_type().is_symlink() => {
            fs::remove_file(path).map_err(|_| "evidence_storage_unavailable")?;
            Ok(true)
        }
        Ok(_) => Err("evidence_storage_invalid".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err("evidence_storage_unavailable".into()),
    }
}
fn remove_run_directory(path: &Path) -> Result<u32> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(_) => return Err("evidence_storage_unavailable".into()),
        Ok(meta) if meta.file_type().is_symlink() => { remove_private_file(path)?; return Ok(1); }
        Ok(meta) if !meta.is_dir() => return Err("evidence_storage_invalid".into()),
        _ => {}
    }
    let mut removed = 0;
    for entry in fs::read_dir(path).map_err(|_| "evidence_storage_unavailable")? {
        let entry = entry.map_err(|_| "evidence_storage_unavailable")?;
        if remove_private_file(&entry.path())? { removed += 1; }
    }
    fs::remove_dir(path).map_err(|_| "evidence_storage_unavailable")?;
    if let Some(parent) = path.parent() { File::open(parent).and_then(|f| f.sync_all()).map_err(|_| "evidence_storage_unavailable")?; }
    Ok(removed)
}
fn sweep_staging(root: &Path, removed: &mut u32) -> Result<()> {
    no_symlink_directory(root)?;
    for entry in fs::read_dir(root).map_err(|_| "evidence_storage_unavailable")? {
        let entry = entry.map_err(|_| "evidence_storage_unavailable")?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let kind = entry.file_type().map_err(|_| "evidence_storage_unavailable")?;
        if name.starts_with(".evidence-stage-") && (kind.is_file() || kind.is_symlink()) {
            if remove_private_file(&entry.path())? { *removed += 1; }
        } else if canonical_id(&name).is_ok() && kind.is_dir() {
            sweep_staging(&entry.path(), removed)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, EvidenceStore, AcceptanceBinding) {
        let temp = tempfile::tempdir().unwrap();
        let mut store = EvidenceStore::new(temp.path());
        store.test_key = Some([7; 32]);
        let binding = AcceptanceBinding {
            acceptance_id: uuid::Uuid::new_v4().to_string(), owner_account_id: "owner".into(), host_id: "host".into(),
            source_id: "source".into(), session_id: "session".into(), task_id: "task".into(), parent_run_id: "coding-run".into(),
            origin_run_ref: Some("conversation-run".into()), delivery_id: "delivery".into(), delivery_revision: 2,
            commit: "a".repeat(40), desktop_id: "desktop".into(), desktop_generation: 3, manifest_digest: "b".repeat(64),
            agent_principal_id: Some("agent:delegated".into()),
            criteria: vec![AcceptanceCriterion { id: "criterion-1".into(), text: "The button opens its dialog".into(), required_evidence: true }],
        };
        store.register("owner", "host", binding.clone()).unwrap();
        (temp, store, binding)
    }
    fn png() -> Vec<u8> {
        let image = xcap::image::DynamicImage::new_rgb8(2, 2);
        let mut cursor = std::io::Cursor::new(Vec::new());
        image.write_to(&mut cursor, xcap::image::ImageFormat::Png).unwrap();
        cursor.into_inner()
    }
    fn capture() -> CaptureInput {
        CaptureInput { artifact_id: uuid::Uuid::new_v4().to_string(), criterion_id: "criterion-1".into(),
            kind: CaptureKind::Checkpoint, explicitly_requested: false, sensitive_human_input: false }
    }
    fn verdict(artifact_ids: Vec<String>) -> AgentVerdictInput {
        AgentVerdictInput { idempotency_key: "completion".into(), principal_id: "agent:delegated".into(),
            outcome: AcceptanceOutcome::Passed, criteria: vec![CriterionResult { criterion_id: "criterion-1".into(),
                outcome: CriterionOutcome::Passed, artifact_ids }], summary: "The dialog opened".into() }
    }
    fn scope() -> DeletionScope { DeletionScope { session_ids: vec!["session".into()], ..Default::default() } }
    #[test]
    fn encrypted_round_trip_owner_scope_and_history_lookup_survive_restart() {
        let (temp, store, binding) = fixture();
        let input = capture();
        let bytes = png();
        let artifact = store.capture("owner", "host", &binding.acceptance_id, input.clone(), &bytes).unwrap();
        assert_eq!(store.capture("owner", "host", &binding.acceptance_id, input, &bytes).unwrap(), artifact);
        assert_eq!(store.get("owner", "host", &binding.acceptance_id).unwrap().capture_attempts, 1);
        let encrypted = fs::read(store.root.join(&binding.acceptance_id).join(&artifact.id)).unwrap();
        assert_ne!(encrypted, bytes);
        assert!(!fs::read(store.root.join("index.enc")).unwrap().windows(7).any(|w| w == b"session"));
        let mut reopened = EvidenceStore::new(temp.path());
        reopened.test_key = Some([7; 32]);
        assert_eq!(reopened.read_image("owner", "host", &binding.acceptance_id, &artifact.id).unwrap().1, bytes);
        for run in [&binding.acceptance_id, &binding.parent_run_id, binding.origin_run_ref.as_ref().unwrap()] {
            assert_eq!(reopened.list("owner", "host", ResultFilter { run_id: Some(run.clone()), ..Default::default() }).unwrap().len(), 1);
        }
        assert!(reopened.get("other", "host", &binding.acceptance_id).is_err());
        assert!(reopened.read_image("owner", "other-host", &binding.acceptance_id, &artifact.id).is_err());
        assert!(reopened.list("other", "host", ResultFilter::default()).unwrap().is_empty());
    }
    #[test]
    fn concurrent_capture_retry_retains_first_sample_and_deletion_fences_its_lookup() {
        let (_temp, store, binding) = fixture();
        let id = binding.acceptance_id.clone();
        let input = capture();
        assert!(store.captured("owner", "host", &id, &input).unwrap().is_none());
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let first = png();
        let mut other = std::io::Cursor::new(Vec::new());
        xcap::image::DynamicImage::new_rgb8(3, 3).write_to(&mut other, xcap::image::ImageFormat::Png).unwrap();
        let handles: Vec<_> = [first, other.into_inner()].into_iter().map(|bytes| {
            let store = store.clone(); let id = id.clone(); let input = input.clone(); let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                store.capture("owner", "host", &id, input, &bytes).unwrap()
            })
        }).collect();
        let artifacts: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert_eq!(artifacts[0], artifacts[1]);
        assert_eq!(store.get("owner", "host", &id).unwrap().capture_attempts, 1);
        assert_eq!(store.captured("owner", "host", &id, &input).unwrap(), Some(artifacts[0].clone()));
        let mut conflict = input.clone(); conflict.kind = CaptureKind::Failure;
        assert_eq!(store.captured("owner", "host", &id, &conflict).unwrap_err(), "evidence_idempotency_conflict");
        assert_eq!(store.capture("owner", "host", &id, conflict, &png()).unwrap_err(), "evidence_idempotency_conflict");
        let deletion = uuid::Uuid::new_v4().to_string();
        store.prepare_delete("owner", "host", &deletion, scope()).unwrap();
        assert!(store.captured("owner", "host", &id, &input).is_err());
        store.commit_delete("owner", "host", &deletion).unwrap();
        assert!(store.captured("owner", "host", &id, &input).is_err());
    }

    #[test]
    fn agent_verdict_requires_assigned_principal_and_complete_durable_evidence() {
        let (_temp, store, binding) = fixture();
        let id = &binding.acceptance_id;
        assert!(store.complete("owner", "host", id, verdict(vec![])).is_err());
        let artifact = store.capture("owner", "host", id, capture(), &png()).unwrap();
        let valid = verdict(vec![artifact.id.clone()]);
        let mut spoofed = valid.clone(); spoofed.principal_id = "human:owner".into();
        assert!(store.complete("owner", "host", id, spoofed).is_err());
        let mut duplicate = valid.clone(); duplicate.criteria.push(duplicate.criteria[0].clone());
        assert!(store.complete("owner", "host", id, duplicate).is_err());
        let result = store.complete("owner", "host", id, valid.clone()).unwrap();
        assert_eq!(result.agent_verdict.as_ref().unwrap().input.outcome, AcceptanceOutcome::Passed);
        assert_eq!(store.complete("owner", "host", id, valid).unwrap(), result);
        let mut overwrite = verdict(vec![artifact.id]); overwrite.summary = "changed".into();
        assert!(store.complete("owner", "host", id, overwrite).is_err());
        assert!(store.capture("owner", "host", id, capture(), &png()).is_err());
    }
    #[test]
    fn missing_corrupt_and_substituted_blob_cannot_complete_passed() {
        let (_temp, store, binding) = fixture();
        let artifact = store.capture("owner", "host", &binding.acceptance_id, capture(), &png()).unwrap();
        let path = store.root.join(&binding.acceptance_id).join(&artifact.id);
        fs::write(&path, b"broken").unwrap();
        assert!(store.complete("owner", "host", &binding.acceptance_id, verdict(vec![artifact.id.clone()])).is_err());
        fs::remove_file(&path).unwrap();
        assert!(store.complete("owner", "host", &binding.acceptance_id, verdict(vec![artifact.id])).is_err());
    }
    #[test]
    fn human_approval_is_separate_revisioned_and_idempotent() {
        let (_temp, store, binding) = fixture();
        let id = &binding.acceptance_id;
        let approval = HumanApprovalInput { expected_revision: 0, idempotency_key: "approval-1".into(),
            principal_id: "human:owner".into(), decision: ApprovalDecision::Approved };
        assert!(store.approve("owner", "host", id, approval.clone()).is_err());
        store.finish_system("owner", "host", id, AcceptanceOutcome::Inconclusive, "diagnostic_no_agent_verdict").unwrap();
        let result = store.approve("owner", "host", id, approval.clone()).unwrap();
        assert!(result.agent_verdict.is_none());
        assert_eq!(result.system_outcome.as_ref().unwrap().outcome, AcceptanceOutcome::Inconclusive);
        assert_eq!(store.approve("owner", "host", id, approval).unwrap(), result);
        let stale = HumanApprovalInput { expected_revision: 0, idempotency_key: "approval-2".into(),
            principal_id: "human:owner".into(), decision: ApprovalDecision::Rejected };
        assert!(store.approve("owner", "host", id, stale.clone()).is_err());
        let changed = store.approve("owner", "host", id, HumanApprovalInput { expected_revision: 1, ..stale }).unwrap();
        assert_eq!(changed.human_approvals.len(), 2);
        assert_eq!(changed.human_approvals[1].revision, 2);
        assert!(changed.agent_verdict.is_none());
    }
    #[test]
    fn malformed_and_oversized_capture_are_bounded_and_reservation_survives_restart() {
        let (temp, store, binding) = fixture();
        for _ in 0..MAX_SCREENSHOTS {
            assert!(store.capture("owner", "host", &binding.acceptance_id, capture(), b"invalid").is_err());
        }
        let mut reopened = EvidenceStore::new(temp.path()); reopened.test_key = Some([7; 32]);
        assert_eq!(reopened.capture("owner", "host", &binding.acceptance_id, capture(), &png()).unwrap_err(), "evidence_limit_reached");
        let result = reopened.get("owner", "host", &binding.acceptance_id).unwrap();
        assert_eq!(result.capture_attempts, MAX_SCREENSHOTS);
        assert_eq!(result.reserved_bytes, 7 * MAX_SCREENSHOTS as u64);
        assert!(result.evidence_limit_reached);
        assert!(result.artifacts.is_empty());
        assert!(image_info(b"GIF89a").is_err());
        let image = xcap::image::DynamicImage::new_rgb8(4097, 1);
        let mut bytes = std::io::Cursor::new(Vec::new()); image.write_to(&mut bytes, xcap::image::ImageFormat::Png).unwrap();
        assert!(image_info(&bytes.into_inner()).is_err());
    }
    #[test]
    fn per_image_and_total_byte_limits_do_not_discard_earlier_evidence() {
        let (_temp, store, binding) = fixture();
        let artifact = store.capture("owner", "host", &binding.acceptance_id, capture(), &png()).unwrap();
        assert_eq!(store.capture("owner", "host", &binding.acceptance_id, capture(), &vec![0; MAX_IMAGE_BYTES + 1]).unwrap_err(), "evidence_limit_reached");
        { let mut state = store.lock().unwrap(); state.index.records.get_mut(&binding.acceptance_id).unwrap().reserved_bytes = MAX_TOTAL_BYTES; store.save(&state).unwrap(); }
        assert_eq!(store.capture("owner", "host", &binding.acceptance_id, capture(), &png()).unwrap_err(), "evidence_limit_reached");
        assert!(store.read_image("owner", "host", &binding.acceptance_id, &artifact.id).is_ok());
    }
    #[test]
    fn sensitive_capture_requires_explicit_request_and_rejects_path_substitution() {
        let (_temp, store, binding) = fixture();
        let mut input = capture(); input.sensitive_human_input = true;
        assert!(store.capture("owner", "host", &binding.acceptance_id, input.clone(), &png()).is_err());
        input.explicitly_requested = true;
        assert!(store.capture("owner", "host", &binding.acceptance_id, input, &png()).is_ok());
        let mut path = capture(); path.artifact_id = "../secret".into();
        assert!(store.capture("owner", "host", &binding.acceptance_id, path, &png()).is_err());
    }
    #[test]
    fn prepared_deletion_freezes_without_removal_and_abort_restores() {
        let (_temp, store, binding) = fixture();
        let artifact = store.capture("owner", "host", &binding.acceptance_id, capture(), &png()).unwrap();
        let operation = uuid::Uuid::new_v4().to_string();
        let receipt = store.prepare_delete("owner", "host", &operation, scope()).unwrap();
        assert_eq!(receipt.state, DeletionState::Prepared);
        store.reconcile().unwrap();
        assert!(store.root.join(&binding.acceptance_id).join(&artifact.id).exists());
        assert!(store.capture("owner", "host", &binding.acceptance_id, capture(), &png()).is_err());
        assert!(store.get("owner", "host", &binding.acceptance_id).is_err());
        store.abort_delete("owner", "host", &operation).unwrap();
        assert!(store.read_image("owner", "host", &binding.acceptance_id, &artifact.id).is_ok());
        assert!(store.commit_delete("owner", "host", &operation).is_err());
    }
    #[test]
    fn committed_deletion_survives_restart_denies_late_writes_and_retains_cleanup_target() {
        let (temp, store, binding) = fixture();
        store.capture("owner", "host", &binding.acceptance_id, capture(), &png()).unwrap();
        let operation = uuid::Uuid::new_v4().to_string();
        store.prepare_delete("owner", "host", &operation, scope()).unwrap();
        let receipt = store.commit_delete("owner", "host", &operation).unwrap();
        assert!(receipt.cleanup_pending);
        assert!(!store.root.join(&binding.acceptance_id).exists());
        let mut reopened = EvidenceStore::new(temp.path()); reopened.test_key = Some([7; 32]);
        assert!(reopened.get("owner", "host", &binding.acceptance_id).is_err());
        assert!(reopened.register("owner", "host", binding.clone()).is_err());
        let mut late = binding.clone(); late.acceptance_id = uuid::Uuid::new_v4().to_string();
        assert!(reopened.register("owner", "host", late).is_err());
        let target = reopened.list_cleanup_targets().unwrap().pop().unwrap();
        assert_eq!(target.desktop_generation, binding.desktop_generation);
        assert!(reopened.mark_desktop_cleaned("other", "host", &binding.acceptance_id).is_err());
        reopened.mark_desktop_cleaned("owner", "host", &binding.acceptance_id).unwrap();
        assert!(!reopened.commit_delete("owner", "host", &operation).unwrap().cleanup_pending);
        assert!(reopened.abort_delete("owner", "host", &operation).is_err());
        assert!(reopened.register("owner", "host", binding).is_err());
    }
    #[test]
    fn interrupted_file_deletion_retries_and_missing_files_are_safe() {
        let (_temp, store, binding) = fixture();
        store.capture("owner", "host", &binding.acceptance_id, capture(), &png()).unwrap();
        let blocker = store.root.join(&binding.acceptance_id).join("unexpected-directory");
        fs::create_dir(&blocker).unwrap();
        let operation = uuid::Uuid::new_v4().to_string();
        store.prepare_delete("owner", "host", &operation, scope()).unwrap();
        assert!(store.commit_delete("owner", "host", &operation).unwrap().cleanup_pending);
        assert!(store.get("owner", "host", &binding.acceptance_id).is_err());
        fs::remove_dir(blocker).unwrap();
        store.reconcile().unwrap();
        assert!(!store.root.join(&binding.acceptance_id).exists());
        store.reconcile().unwrap();
        store.mark_desktop_cleaned("owner", "host", &binding.acceptance_id).unwrap();
        assert_eq!(store.reconcile().unwrap().pending_deletions, 0);
    }
    #[test]
    fn native_prepare_restart_markers_are_separate_from_renderer_intents() {
        let (temp, store, binding) = fixture();
        let native = uuid::Uuid::new_v4().to_string();
        store.prepare_native_task_delete("owner", "host", &native, &binding.task_id, Some("remote-device".into())).unwrap();
        let renderer = uuid::Uuid::new_v4().to_string();
        store.prepare_delete("owner", "host", &renderer, scope()).unwrap();
        let mut reopened = EvidenceStore::new(temp.path()); reopened.test_key = Some([7; 32]);
        let pending = reopened.list_native_task_deletions().unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].0.id, native);
        assert_eq!(pending[0].0.scope.task_ids, vec![binding.task_id]);
        assert_eq!(pending[0].1.as_deref(), Some("remote-device"));
        reopened.abort_delete("owner", "host", &native).unwrap();
        assert!(reopened.list_native_task_deletions().unwrap().is_empty());
        assert_eq!(reopened.reconcile().unwrap().prepared_deletions, 1);
        reopened.abort_delete("owner", "host", &renderer).unwrap();
        assert!(reopened.get("owner", "host", &binding.acceptance_id).is_ok());
    }
    #[test]
    fn native_deletion_preserves_explicit_local_device_and_refuses_missing_or_changed_constraint() {
        let (temp, store, binding) = fixture();
        let operation = uuid::Uuid::new_v4().to_string();
        store.prepare_native_task_delete("owner", "host", &operation, &binding.task_id, None).unwrap();
        let mut reopened = EvidenceStore::new(temp.path()); reopened.test_key = Some([7; 32]);
        let pending = reopened.list_native_task_deletions().unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].1, None);
        assert!(reopened.prepare_native_task_delete("owner", "host", &operation, &binding.task_id, Some("other-device".into())).is_err());
        {
            let mut state = reopened.lock().unwrap();
            state.index.native_task_devices.remove(&operation);
            reopened.save(&state).unwrap();
        }
        assert_eq!(reopened.list_native_task_deletions().unwrap_err(), "evidence_native_deletion_device_missing");
        assert_eq!(reopened.prepare_native_task_delete("owner", "host", &operation, &binding.task_id, None).unwrap_err(), "evidence_native_deletion_device_missing");
    }
    #[test]
    fn queued_capture_rechecks_revoked_admission_after_acquiring_storage_lock() {
        use std::sync::{atomic::{AtomicBool, Ordering}, Arc, mpsc};
        let (_temp, store, binding) = fixture();
        let admitted = Arc::new(AtomicBool::new(true));
        let gate = admitted.clone();
        let queued = store.clone().with_admission(Arc::new(move || gate.load(Ordering::SeqCst)));
        let held = store.lock().unwrap();
        let (started, ready) = mpsc::channel();
        let id = binding.acceptance_id.clone();
        let worker = std::thread::spawn(move || {
            started.send(()).unwrap();
            queued.capture("owner", "host", &id, capture(), &png())
        });
        ready.recv().unwrap();
        admitted.store(false, Ordering::SeqCst);
        drop(held);
        assert_eq!(worker.join().unwrap().unwrap_err(), "evidence_authority_expired");
        let row = store.get("owner", "host", &binding.acceptance_id).unwrap();
        assert_eq!(row.capture_attempts, 0);
        assert!(row.artifacts.is_empty());
        assert_eq!(row.reserved_bytes, 0);
    }
    #[test]
    fn lost_prepare_abort_is_durable_and_cannot_be_reordered_into_prepare() {
        let (temp, store, _binding) = fixture();
        let operation = uuid::Uuid::new_v4().to_string();
        assert_eq!(store.abort_delete("owner", "host", &operation).unwrap().state, DeletionState::Aborted);
        let mut reopened = EvidenceStore::new(temp.path()); reopened.test_key = Some([7; 32]);
        assert_eq!(reopened.abort_delete("owner", "host", &operation).unwrap().state, DeletionState::Aborted);
        assert!(reopened.prepare_delete("owner", "host", &operation, scope()).is_err());
        assert!(reopened.commit_delete("owner", "host", &operation).is_err());
        assert_eq!(reopened.list("owner", "host", ResultFilter::default()).unwrap().len(), 1);
    }
    #[test]
    fn uninitialized_startup_is_inert_and_diagnostic_cannot_claim_agent_success() {
        let temp = tempfile::tempdir().unwrap();
        let store = EvidenceStore::new(temp.path());
        assert_eq!(store.reconcile().unwrap(), ReconcileReport::default());
        assert!(store.list_cleanup_targets().unwrap().is_empty());
        assert!(!store.root.exists());
        let (_temp, store, mut binding) = fixture();
        binding.acceptance_id = uuid::Uuid::new_v4().to_string();
        binding.agent_principal_id = None;
        store.register("owner", "host", binding.clone()).unwrap();
        assert!(store.complete("owner", "host", &binding.acceptance_id, verdict(vec![])).is_err());
        assert!(store.finish_system("owner", "host", &binding.acceptance_id, AcceptanceOutcome::Passed, "diagnostic").is_err());
        let result = store.finish_system("owner", "host", &binding.acceptance_id, AcceptanceOutcome::Inconclusive, "diagnostic_no_agent_verdict").unwrap();
        assert!(result.agent_verdict.is_none());
    }
    #[cfg(unix)]
    #[test]
    fn symlinked_evidence_is_never_followed_and_files_are_private() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let (temp, store, binding) = fixture();
        let artifact = store.capture("owner", "host", &binding.acceptance_id, capture(), &png()).unwrap();
        let path = store.root.join(&binding.acceptance_id).join(&artifact.id);
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(fs::metadata(&store.root).unwrap().permissions().mode() & 0o777, 0o700);
        fs::remove_file(&path).unwrap();
        let outside = temp.path().join("outside"); fs::write(&outside, "keep").unwrap(); symlink(&outside, &path).unwrap();
        assert!(store.read_image("owner", "host", &binding.acceptance_id, &artifact.id).is_err());
        let operation = uuid::Uuid::new_v4().to_string(); store.prepare_delete("owner", "host", &operation, scope()).unwrap();
        store.commit_delete("owner", "host", &operation).unwrap();
        assert_eq!(fs::read_to_string(outside).unwrap(), "keep");
    }
}

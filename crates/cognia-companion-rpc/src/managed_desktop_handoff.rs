//! ADR-0233 P3 metadata admission. Production execution stays dormant until
//! durable results/deletion and provider qualification ship. No RPC spends.
use std::path::Path;
use cognia_automation::cua_sandbox::managed::{
    handoff::{parse_launch, validate_acceptance_paths}, refused, ManagedDesktopPrincipal, ManagedDesktopQuote,
    ManagedDesktopService, Result,
};
use cognia_external_agent::spawn_authority::DeliverySource;
use cognia_sandbox_pool::{delivery::{DeliveryStore, PublishState, TaskDeliveryRecord}, provenance::SourceStore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const DORMANT_REASON: &str = "managed_desktop_handoff_requires_results_qualification";
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TransferMode { Commit, Bundle }
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrepareHandoff {
    pub delivery_id: String,
    pub delivery_revision: u64,
    pub mode: TransferMode,
    pub provider_config_id: String,
    pub lifetime_seconds: u64,
    pub criteria: Vec<String>,
    pub acceptance_files: Vec<String>,
    pub argv: Vec<String>,
}
impl PrepareHandoff {
    pub fn validate(&self) -> Result<()> {
        if self.delivery_id.is_empty() || self.delivery_id.len() > 128
            || self.criteria.is_empty() || self.criteria.len() > 50
            || self.criteria.iter().any(|s| s.trim().is_empty() || s.len() > 1024 || s.contains('\0'))
            || self.acceptance_files.len() > 100 {
            return Err(refused("managed_desktop_handoff_invalid_request"));
        }
        validate_acceptance_paths(&self.acceptance_files).map_err(|_| refused("managed_desktop_handoff_invalid_file"))?;
        parse_launch(&self.argv).map_err(|_| refused("managed_desktop_handoff_invalid_launch"))?;
        Ok(())
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffDelivery {
    id: String, revision: u64, commit: String, branch: String,
    modes: Vec<TransferMode>, created_at: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffProposal {
    id: String, delivery_id: String, delivery_revision: u64, mode: TransferMode,
    commit: String, quote: ManagedDesktopQuote, expires_at: i64,
    /// Always false in P3. No renderer flag can lift the P4/qualification gate.
    execution_enabled: bool,
    dormant_reason: &'static str,
}
fn modes(record: &TaskDeliveryRecord) -> Vec<TransferMode> {
    let Some(commit) = &record.commit else { return vec![] };
    if !valid_commit(commit) { return vec![]; }
    match record.publish_state {
        PublishState::Pushed => vec![TransferMode::Commit],
        PublishState::SavedBundle if record.publish["recovery"]["bundle"].as_str().is_some() => vec![TransferMode::Bundle],
        _ => vec![],
    }
}
fn valid_commit(commit: &str) -> bool {
    matches!(commit.len(), 40 | 64) && commit.bytes().all(|b| b.is_ascii_hexdigit())
}
pub fn resolve(directory: &Path, p: &ManagedDesktopPrincipal, request: &PrepareHandoff)
    -> Result<(TaskDeliveryRecord, DeliverySource)> {
    request.validate()?;
    let (record, source) = DeliveryStore::new(directory)
        .authorize(&request.delivery_id, request.delivery_revision, &p.owner_principal_id, &p.host_id)
        .map_err(|_| refused("managed_desktop_handoff_source_unavailable"))?;
    if !modes(&record).contains(&request.mode) {
        return Err(refused("managed_desktop_handoff_delivery_unavailable"));
    }
    Ok((record, source))
}
pub async fn list(directory: &Path, p: &ManagedDesktopPrincipal) -> Result<Vec<HandoffDelivery>> {
    let directory = directory.to_owned(); let p = p.clone();
    tokio::task::spawn_blocking(move || {
        let rows = DeliveryStore::new(&directory).list_authorized(&p.owner_principal_id, &p.host_id)
            .map_err(|_| refused("managed_desktop_handoff_source_unavailable"))?;
        Ok(rows.into_iter().filter_map(|record| {
            let modes = modes(&record);
            if modes.is_empty() { return None; }
            Some(HandoffDelivery { id: record.id, revision: record.revision,
                commit: record.commit?, branch: record.branch, modes, created_at: record.created_at })
        }).collect())
    }).await.map_err(|_| refused("managed_desktop_storage_unavailable"))?
}
pub async fn prepare(directory: &Path, service: &ManagedDesktopService, p: &ManagedDesktopPrincipal, request: PrepareHandoff) -> Result<HandoffProposal> {
    let config = request.provider_config_id.clone(); let lifetime = request.lifetime_seconds;
    prepare_quoted(directory, p, request, async { service.quote(p, &config, lifetime).await }).await
}

// Keep the read -> asynchronous quote -> reauthorization boundary explicit so
// deletion/revision races can be exercised without a live provider or secrets.
async fn prepare_quoted(directory: &Path, p: &ManagedDesktopPrincipal, request: PrepareHandoff,
    quote: impl std::future::Future<Output = Result<ManagedDesktopQuote>>) -> Result<HandoffProposal> {
    p.require_human()?;
    let root = directory.to_owned(); let principal = p.clone(); let check = request.clone();
    let (record, source) = tokio::task::spawn_blocking(move || resolve(&root, &principal, &check))
        .await.map_err(|_| refused("managed_desktop_storage_unavailable"))??;
    let quote = quote.await?;
    // Quote can yield to deletion/account invalidation. Reauthorize the same
    // immutable delivery revision before returning any source-bearing metadata.
    let root = directory.to_owned(); let principal = p.clone(); let check = request.clone();
    tokio::task::spawn_blocking(move || resolve(&root, &principal, &check))
        .await.map_err(|_| refused("managed_desktop_storage_unavailable"))??;
    let bytes = serde_json::to_vec(&(&request, &source.id, &quote.id))
        .map_err(|_| refused("managed_desktop_invalid_request"))?;
    Ok(HandoffProposal { id: hex::encode(Sha256::digest(bytes)), delivery_id: record.id,
        delivery_revision: record.revision, mode: request.mode, commit: record.commit.unwrap_or_default(),
        expires_at: quote.expires_at, quote, execution_enabled: false, dormant_reason: DORMANT_REASON })
}
pub async fn revoke(directory: &Path, p: &ManagedDesktopPrincipal, ids: Vec<String>) -> Result<()> {
    if ids.is_empty() || ids.len() > 1000 || ids.iter().any(|id| id.is_empty() || id.len() > 256) {
        return Err(refused("managed_desktop_handoff_invalid_request"));
    }
    let directory = directory.to_owned(); let p = p.clone();
    tokio::task::spawn_blocking(move || {
        let store = SourceStore::new(&directory);
        for id in ids { store.revoke_conversation(&p.owner_principal_id, &p.host_id, &id)
            .map_err(|_| refused("managed_desktop_handoff_source_unavailable"))?; }
        Ok(())
    }).await.map_err(|_| refused("managed_desktop_storage_unavailable"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> PrepareHandoff {
        PrepareHandoff { delivery_id:"delivery".into(), delivery_revision:1, mode:TransferMode::Commit,
            provider_config_id:"e2b".into(), lifetime_seconds:60, criteria:vec!["Page loads".into()],
            acceptance_files:vec!["tests/acceptance.js".into()], argv:vec![] }
    }
    fn persisted_source() -> (tempfile::TempDir, ManagedDesktopPrincipal, PrepareHandoff) {
        use cognia_external_agent::spawn_authority::DeliverySourceDeclaration;
        let directory = tempfile::tempdir().unwrap();
        let source = SourceStore::new(directory.path()).admit("owner", "host", "task", "device",
            DeliverySourceDeclaration { conversation_id:"chat".into(), origin_run_ref:"origin-run".into() },
            "https://example.com/repo.git", "main", "branch", None).unwrap();
        let mut record = TaskDeliveryRecord::running("delivery".into(), "agent".into(), Some("task".into()), "provider".into(), "instance".into(), "branch".into());
        record.source_id = Some(source.id); record.revision = 1;
        record.commit = Some("a".repeat(40)); record.publish_state = PublishState::Pushed;
        let records = directory.path().join(cognia_sandbox_pool::delivery::DELIVERY_DIR);
        std::fs::create_dir_all(&records).unwrap();
        std::fs::write(records.join("delivery.json"), serde_json::to_vec(&record).unwrap()).unwrap();
        let principal = ManagedDesktopPrincipal { owner_principal_id:"owner".into(), host_id:"host".into(), principal_id:"device".into(), authority: cognia_automation::cua_sandbox::managed::ManagedDesktopAuthority::Human };
        (directory, principal, request())
    }
    #[tokio::test]
    async fn only_owned_persisted_source_is_visible_and_reauthorization_catches_deletion() {
        let (directory, principal, request) = persisted_source();
        let path = directory.path().join(cognia_sandbox_pool::delivery::DELIVERY_DIR).join("delivery.json");
        let before = std::fs::read(&path).unwrap();
        assert!(resolve(directory.path(), &principal, &request).is_ok());
        assert_eq!(list(directory.path(), &principal).await.unwrap().len(), 1);
        let mut foreign = principal.clone(); foreign.owner_principal_id = "other".into();
        assert!(resolve(directory.path(), &foreign, &request).is_err());
        assert!(list(directory.path(), &foreign).await.unwrap().is_empty());
        foreign = principal.clone(); foreign.host_id = "other".into();
        assert!(resolve(directory.path(), &foreign, &request).is_err());
        let mut stale = request.clone(); stale.delivery_revision = 0;
        assert!(resolve(directory.path(), &principal, &stale).is_err());
        revoke(directory.path(), &principal, vec!["chat".into()]).await.unwrap();
        assert!(resolve(directory.path(), &principal, &request).is_err());
        assert!(list(directory.path(), &principal).await.unwrap().is_empty());
        assert_eq!(std::fs::read(path).unwrap(), before, "acceptance never mutates source delivery");
    }
    fn quote() -> ManagedDesktopQuote {
        ManagedDesktopQuote { id:"quote".into(), provider_config_id:"e2b".into(), config_revision:1,
            lifetime_seconds:60, expires_at:99999, currency:"USD".into(), hourly_rate_micros:1,
            maximum_compute_cost_micros:1, price_observed_at:1, region:None, cpu_count:2,
            memory_mb:4096, binding_digest:"digest".into(), owner_principal_id:"owner".into() }
    }
    #[tokio::test]
    async fn quote_yield_reauthorizes_revocation_and_revision_without_enabling_execution() {
        let (directory, principal, request) = persisted_source();
        let proposal = prepare_quoted(directory.path(), &principal, request.clone(), async { Ok(quote()) }).await.unwrap();
        assert!(!proposal.execution_enabled);
        let denied = prepare_quoted(directory.path(), &principal, request.clone(), async {
            SourceStore::new(directory.path()).revoke_conversation("owner", "host", "chat").unwrap();
            Ok(quote())
        }).await;
        assert!(denied.is_err());
        let (directory, principal, request) = persisted_source();
        let denied = prepare_quoted(directory.path(), &principal, request, async {
            let path = directory.path().join(cognia_sandbox_pool::delivery::DELIVERY_DIR).join("delivery.json");
            let mut record: TaskDeliveryRecord = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            record.revision += 1;
            std::fs::write(path, serde_json::to_vec(&record).unwrap()).unwrap();
            Ok(quote())
        }).await;
        assert!(denied.is_err());
    }
    #[tokio::test]
    async fn agent_cannot_prepare_or_even_poll_a_quote() {
        let (directory, mut principal, request) = persisted_source();
        principal.authority = cognia_automation::cua_sandbox::managed::ManagedDesktopAuthority::Agent;
        assert!(prepare_quoted(directory.path(), &principal, request, async { panic!("agent must not poll quote") }).await.is_err());
    }
    #[test]
    fn request_rejects_source_authority_and_unsupported_modes() {
        for (key, value) in [("ownerAccountId", serde_json::json!("owner")), ("mode", serde_json::json!("livePreview")), ("cwd", serde_json::json!("/tmp"))] {
            let mut input = serde_json::to_value(request()).unwrap(); input[key] = value;
            assert!(serde_json::from_value::<PrepareHandoff>(input).is_err());
        }
        assert_eq!(DORMANT_REASON, "managed_desktop_handoff_requires_results_qualification");
    }
    #[test]
    fn proposal_bounds_files_criteria_and_commands_before_any_io() {
        assert!(request().validate().is_ok());
        for path in ["../secret", "/etc/passwd", "tests/.env", "a\\b", "a//b"] {
            let mut input = request(); input.acceptance_files = vec![path.into()]; assert!(input.validate().is_err());
        }
        let mut input = request(); input.criteria.clear(); assert!(input.validate().is_err());
        let mut input = request(); input.argv = vec!["sh".into(), "-c".into(), "secret".into()]; assert!(input.validate().is_err());
    }
    #[test]
    fn legacy_or_unfinished_delivery_never_has_a_transfer_mode() {
        let mut record = TaskDeliveryRecord::running("id".into(), "agent".into(), None, "provider".into(), "instance".into(), "branch".into());
        assert!(modes(&record).is_empty()); record.commit = Some("a".repeat(40));
        assert!(modes(&record).is_empty()); record.publish_state = PublishState::Pushed;
        assert_eq!(modes(&record), vec![TransferMode::Commit]);
        record.commit = Some("main".into()); assert!(modes(&record).is_empty());
    }
}

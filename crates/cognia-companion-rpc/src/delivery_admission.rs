//! Original authenticated spawn admission. Secret bytes stay in the Host store;
//! the durable source records only a Host-owned lookup reference.
use cognia_external_agent::{process::ExternalAgentSpawnConfig, spawn_authority::{DeliverySource, DeliverySourceDeclaration, DELIVERY_SOURCE_ENV}};
use cognia_sandbox_pool::provenance::{normalize_repository, SourceStore};
use std::path::Path;
use sha2::{Digest, Sha256};

static ADMISSION: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub const SECRET_SERVICE: &str = "cognia-delivery-sources";

pub fn consume(
    directory: &Path, owner: &str, host: &str, device: &str, task: &str,
    config: &mut ExternalAgentSpawnConfig,
) -> Result<Option<DeliverySource>, String> {
    // Remove before any validation can return, so source metadata never reaches
    // a subprocess or is interpreted by a sandbox as authority.
    let Some(raw) = config.env.remove(DELIVERY_SOURCE_ENV) else { return Ok(None); };
    let declaration: DeliverySourceDeclaration = serde_json::from_str(&raw)
        .map_err(|_| "delivery_source_invalid_declaration")?;
    let workspace = config.sandbox.as_ref().and_then(|placement| placement.workspace())
        .ok_or("delivery_source_requires_remote_workspace")?;
    let repository = normalize_repository(&workspace.remote_url)?;
    let _guard = ADMISSION.lock().map_err(|_| "delivery_source_admission_unavailable")?;
    // The immutable source assignment is persisted before any billed/remote work.
    // Hash only nonsecret identity; retries address the same Host-owned key.
    let credential_ref = Some(if workspace.credential.as_ref().is_some_and(|secret| !secret.is_empty()) {
        let identity = serde_json::to_vec(&(owner, host, task, &declaration.origin_run_ref, &repository))
            .expect("string tuples serialize");
        format!("delivery-source:{}", hex::encode(Sha256::digest(identity)))
    } else {
        // Explicit authority to consult the Host Git helper for this exact
        // admitted repository after restart; never an arbitrary browser URL.
        format!("git-helper:{}", hex::encode(Sha256::digest(repository.as_bytes())))
    });
    let mut inserted = false;
    if let (Some(reference), Some(secret)) = (&credential_ref, workspace.credential.as_ref().filter(|secret| !secret.is_empty())) {
        match cognia_secrets::secret_store::get(SECRET_SERVICE, reference)
            .map_err(|_| "delivery_source_credential_unavailable")? {
            Some(existing) if &existing != secret => return Err("delivery_source_credential_binding_conflict".into()),
            Some(_) => {},
            None => {
                cognia_secrets::secret_store::set(SECRET_SERVICE, reference, secret)
                    .map_err(|_| "delivery_source_credential_unavailable")?;
                inserted = true;
            }
        }
    }
    let admitted = SourceStore::new(directory).admit(owner, host, task, device, declaration,
        &repository, &workspace.base_ref, &workspace.branch, credential_ref.clone());
    if admitted.is_err() && inserted {
        if let Some(reference) = credential_ref {
            let _ = cognia_secrets::secret_store::delete(SECRET_SERVICE, &reference);
        }
    }
    admitted.map(Some)
}

/// The durable ordering shared by local and RPC task deletion. Failed read-only
/// preflight cannot revoke authority; failed persistence cannot remove history.
pub async fn delete_with_source_fence<P, R, D, E>(preflight: P, revoke: R, delete: D) -> Result<(), E>
where
    P: std::future::Future<Output = Result<(), E>>,
    R: std::future::Future<Output = Result<(), E>>,
    D: std::future::Future<Output = Result<(), E>>,
{
    preflight.await?;
    revoke.await?;
    delete.await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn remote_config(run: &str, secret: Option<&str>) -> ExternalAgentSpawnConfig {
        serde_json::from_value(serde_json::json!({
            "id":"agent", "command":"agent", "args":[],
            "env": {"COGNIA_DELIVERY_SOURCE": serde_json::json!({"conversationId":"conversation", "originRunRef":run}).to_string()},
            "sandbox": {"kind":"container", "spec":{}, "isolationMandatory":true, "provider":"cloud",
                "workspace":{"remoteUrl":"https://example.com/repo.git", "baseRef":"main", "branch":"task/branch", "credential":secret}}
        })).unwrap()
    }

    #[test]
    fn successful_admission_is_restart_safe_and_keeps_secret_only_in_host_store() {
        let directory = tempfile::tempdir().unwrap();
        let run = uuid::Uuid::new_v4().to_string();
        let mut config = remote_config(&run, Some("fixture-secret"));
        let source = consume(directory.path(), "owner", "host", "device", "task", &mut config).unwrap().unwrap();
        assert!(!config.env.contains_key(DELIVERY_SOURCE_ENV));
        let reference = source.credential_ref.as_ref().unwrap();
        assert!(reference.starts_with("delivery-source:"));
        assert_eq!(cognia_secrets::secret_store::get(SECRET_SERVICE, reference).unwrap().as_deref(), Some("fixture-secret"));
        assert!(!serde_json::to_string(&source).unwrap().contains("fixture-secret"));
        assert_eq!(SourceStore::new(directory.path()).authorize(&source.id, "owner", "host").unwrap(), source);
        let retry = consume(directory.path(), "owner", "host", "device", "task", &mut remote_config(&run, Some("fixture-secret"))).unwrap().unwrap();
        assert_eq!(retry, source);
        assert!(consume(directory.path(), "owner", "host", "device", "task", &mut remote_config(&run, Some("different-secret"))).is_err());
        assert_eq!(cognia_secrets::secret_store::get(SECRET_SERVICE, reference).unwrap().as_deref(), Some("fixture-secret"));
        cognia_secrets::secret_store::delete(SECRET_SERVICE, reference).unwrap();
    }

    #[test]
    fn revoked_admission_rolls_back_new_secret_and_helper_reference_is_explicit() {
        let directory = tempfile::tempdir().unwrap();
        let run = uuid::Uuid::new_v4().to_string();
        let store = SourceStore::new(directory.path());
        store.revoke_conversation("owner", "host", "conversation").unwrap();
        assert!(consume(directory.path(), "owner", "host", "device", "task", &mut remote_config(&run, Some("fixture-secret"))).is_err());
        let identity = serde_json::to_vec(&("owner", "host", "task", &run, "https://example.com/repo.git")).unwrap();
        let reference = format!("delivery-source:{}", hex::encode(Sha256::digest(identity)));
        assert!(cognia_secrets::secret_store::get(SECRET_SERVICE, &reference).unwrap().is_none());
        let fresh = tempfile::tempdir().unwrap();
        let source = consume(fresh.path(), "owner", "host", "device", "task", &mut remote_config(&run, None)).unwrap().unwrap();
        assert_eq!(source.credential_ref.as_deref(), Some(format!("git-helper:{}", hex::encode(Sha256::digest(b"https://example.com/repo.git"))).as_str()));
    }

    #[test]
    fn payload_owner_and_host_are_rejected_and_source_environment_is_consumed() {
        let directory = tempfile::tempdir().unwrap();
        let mut config: ExternalAgentSpawnConfig = serde_json::from_value(serde_json::json!({
            "id":"agent", "command":"agent", "args":[], "env":{
                "COGNIA_DELIVERY_SOURCE":"{\"conversationId\":\"chat\",\"originRunRef\":\"run\",\"ownerAccountId\":\"forged\"}"
            }
        })).unwrap();
        assert!(consume(directory.path(), "owner", "host", "device", "task", &mut config).is_err());
        assert!(!config.env.contains_key(DELIVERY_SOURCE_ENV));
        assert!(!directory.path().join("sandbox-sources").exists());
    }
    #[test]
    fn source_less_spawn_does_not_backfill_from_current_account() {
        let directory = tempfile::tempdir().unwrap();
        let mut config: ExternalAgentSpawnConfig = serde_json::from_value(serde_json::json!({
            "id":"agent", "command":"agent", "args":[], "env":{}
        })).unwrap();
        assert!(consume(directory.path(), "owner", "host", "device", "task", &mut config).unwrap().is_none());
    }
    #[tokio::test]
    async fn rejected_preflight_leaves_source_authority_untouched_and_success_fences_first() {
        let directory = tempfile::tempdir().unwrap();
        let store = SourceStore::new(directory.path());
        let source = store.admit("owner", "host", "task", "device", DeliverySourceDeclaration {
            conversation_id: "conversation".into(), origin_run_ref: "origin".into(),
        }, "https://example.com/repo.git", "main", "task/branch", None).unwrap();
        for reason in ["Stop the gateway task before deleting its state", "Gateway task belongs to another paired device"] {
            let result = delete_with_source_fence(
                async { Err::<(), String>(reason.into()) },
                async { store.revoke_owned_task("owner", "host", "task", Some("device")) },
                async { assert!(false, "rejected preflight cannot remove history"); Ok::<(), String>(()) },
            ).await;
            assert!(result.is_err());
            assert!(store.authorize(&source.id, "owner", "host").is_ok());
        }
        delete_with_source_fence(
            async { Ok::<(), String>(()) },
            async { store.revoke_owned_task("owner", "host", "task", Some("device")) },
            async { assert!(store.authorize(&source.id, "owner", "host").is_err()); Ok(()) },
        ).await.unwrap();
    }

}

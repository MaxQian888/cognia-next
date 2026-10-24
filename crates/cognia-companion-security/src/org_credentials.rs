//! Organization-owned credentials, separate from every operator/device secret namespace.
//! Kept here because this layer already owns tenant identity and SHA-256.
use cognia_secrets::{host_secrets::{self, HostSecretKind}, secret_store};
use cognia_tenant_auth::OrgId;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const VALUE_SERVICE: &str = "com.cognia.host-org-provider-credentials/v1";
const INDEX_SERVICE: &str = "com.cognia.host-org-provider-index/v1";
static LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

/// Generic keyring RPCs must neither export org values nor bypass the dedicated
/// validation/approval/audit path, even for the loopback service principal.
pub fn reserved_namespace(namespace: &str) -> bool {
    let service = format!("com.cognia.{namespace}/v1");
    [VALUE_SERVICE, INDEX_SERVICE, crate::org_agent_policy::SERVICE, "com.cognia.host-org-member-usage/v1"].contains(&service.as_str())
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialMetadata {
    pub provider: String,
    pub fingerprint: String,
    pub set_at: i64,
    /// Verified user id; `operator` denotes the authenticated loopback operator.
    pub set_by: String,
}

pub fn validate_org(org: &str) -> Result<(), String> {
    OrgId::parse(org).map(|_| ()).map_err(|_| "invalid organization id".into())
}

fn fingerprint(key: &str) -> String {
    hex::encode(Sha256::digest(key.as_bytes()))[..12].into()
}

fn account(org: &str, provider: &str) -> Result<String, String> {
    validate_org(org)?;
    host_secrets::validate_name(HostSecretKind::Provider, provider)
        .map_err(|_| "invalid provider name".to_string())?;
    Ok(format!("{org}/{provider}"))
}

/// Host-internal org secret boundary. Only P6c partition ticket brokerage reads
/// values, bound to a verified person/org. Device commands may
/// use metadata and mutations only, never `org_provider_key`. There is no
/// registration in `host_secrets`: operator overlays and device revocation cannot
/// enumerate or cascade these org-owned keys.
pub struct OrgCredentials;

impl OrgCredentials {
    pub fn set(org: &str, provider: &str, key: &str, user: &str, now: i64) -> Result<CredentialMetadata, String> {
        let account = account(org, provider)?;
        if key.trim().is_empty() || key.len() > 64 * 1024 {
            return Err("invalid API key length".into());
        }
        if user != "operator" && cognia_tenant_auth::UserId::parse(user).is_err() {
            return Err("invalid credential writer".into());
        }
        let metadata = CredentialMetadata {
            provider: provider.into(), fingerprint: fingerprint(key),
            set_at: now, set_by: user.into(),
        };
        let index = serde_json::to_string(&metadata).map_err(|_| "cannot encode credential metadata")?;
        let unavailable = || "organization credential store unavailable".to_string();
        let _guard = LOCK.lock();
        // Two writes, value first. A failed index write restores the previous
        // value; a crash between them leaves a value whose fingerprint no
        // index vouches for, which `org_provider_key` refuses (fail closed).
        let previous = secret_store::get(VALUE_SERVICE, &account).map_err(|_| unavailable())?;
        secret_store::set(VALUE_SERVICE, &account, key).map_err(|_| unavailable())?;
        if secret_store::set(INDEX_SERVICE, &account, &index).is_err() {
            let _ = match previous {
                Some(value) => secret_store::set(VALUE_SERVICE, &account, &value),
                None => secret_store::delete(VALUE_SERVICE, &account),
            };
            return Err(unavailable());
        }
        Ok(metadata)
    }

    pub fn delete(org: &str, provider: &str) -> Result<(), String> {
        let account = account(org, provider)?;
        let _guard = LOCK.lock();
        // Value first: a failed index delete leaves a listed row with no key
        // behind it (retry is idempotent), never a usable key nobody can see.
        secret_store::delete(VALUE_SERVICE, &account)
            .and_then(|()| secret_store::delete(INDEX_SERVICE, &account))
            .map_err(|_| "organization credential store unavailable".into())
    }

    /// Reads only the separate metadata service, never credential values.
    pub fn list(org: &str) -> Result<Vec<CredentialMetadata>, String> {
        validate_org(org)?;
        let _guard = LOCK.lock();
        let prefix = format!("{org}/");
        let mut entries = Vec::new();
        for account in secret_store::list_accounts(INDEX_SERVICE)? {
            if !account.starts_with(&prefix) { continue; }
            let raw = secret_store::get(INDEX_SERVICE, &account)?.ok_or("credential index unavailable")?;
            let entry: CredentialMetadata = serde_json::from_str(&raw).map_err(|_| "invalid credential metadata")?;
            if account != format!("{prefix}{}", entry.provider) { return Err("invalid credential metadata".into()); }
            entries.push(entry);
        }
        entries.sort_by(|a, b| a.provider.cmp(&b.provider));
        Ok(entries)
    }

    /// Host-internal P6c ticket broker only. Never expose values through RPC or CLI.
    /// Answers a key only when the metadata an admin can see vouches for it.
    pub fn org_provider_key(org: &str, provider: &str) -> Result<Option<String>, String> {
        let account = account(org, provider)?;
        let unavailable = |_| "organization credential store unavailable".to_string();
        let _guard = LOCK.lock();
        let Some(value) = secret_store::get(VALUE_SERVICE, &account).map_err(unavailable)? else { return Ok(None) };
        let Some(raw) = secret_store::get(INDEX_SERVICE, &account).map_err(unavailable)? else { return Ok(None) };
        let vouched = serde_json::from_str::<CredentialMetadata>(&raw)
            .is_ok_and(|entry| entry.fingerprint == fingerprint(&value));
        Ok(vouched.then_some(value))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const ORG: &str = "org_p6a00000000000000000000";
    const USER: &str = "usr_p6a00000000000000000000";

    #[test]
    fn p6b_usage_namespace_is_closed_to_generic_keyring_commands() {
        assert!(reserved_namespace("host-org-member-usage"));
        assert!(!reserved_namespace("org-member-usage"));
    }

    #[test]
    fn p6a_org_keys_are_metadata_only_and_never_operator_or_device_secrets() {
        let provider = "p6a-isolation";
        let key = "p6a-never-disclose-secret";
        let entry = OrgCredentials::set(ORG, provider, key, USER, 123).unwrap();
        assert_eq!(entry.fingerprint, hex::encode(Sha256::digest(key))[..12]);
        assert_eq!(entry.set_by, USER);
        let metadata = OrgCredentials::list(ORG).unwrap();
        assert!(metadata.contains(&entry));
        assert!(!serde_json::to_string(&metadata).unwrap().contains(key));
        assert!(!host_secrets::list().unwrap().iter().any(|row| row.name == provider));
        assert!(!host_secrets::provider_keys().unwrap().iter().any(|(id, _)| id == provider));
        host_secrets::forget_device(USER).unwrap();
        assert_eq!(OrgCredentials::org_provider_key(ORG, provider).unwrap().as_deref(), Some(key));
        assert!(OrgCredentials::list("org_p6b00000000000000000000").unwrap().is_empty());
        OrgCredentials::delete(ORG, provider).unwrap();
        assert!(OrgCredentials::org_provider_key(ORG, provider).unwrap().is_none());
    }

    #[test]
    fn p6a_org_validation_and_atomic_metadata() {
        for namespace in ["host-org-provider-credentials", "host-org-provider-index", "host-org-agent-policy"] { assert!(reserved_namespace(namespace)); }
        for namespace in ["host-provider-credentials", "host-secret-index", "other"] { assert!(!reserved_namespace(namespace)); }
        assert!(OrgCredentials::set("../bad", "openai", "secret", USER, 1).is_err());
        assert!(OrgCredentials::set(ORG, "\n", "secret", USER, 1).is_err());
        assert!(OrgCredentials::set(ORG, "openai", " ", USER, 1).is_err());
        // A value no index vouches for (a crash between the two writes, or a
        // stale index after an interrupted update) is never handed out.
        let provider = "p6a-unvouched";
        let account = account(ORG, provider).unwrap();
        secret_store::set(VALUE_SERVICE, &account, "orphan-value").unwrap();
        assert!(OrgCredentials::org_provider_key(ORG, provider).unwrap().is_none());
        OrgCredentials::set(ORG, provider, "vouched-value", USER, 1).unwrap();
        secret_store::set(VALUE_SERVICE, &account, "swapped-value").unwrap();
        assert!(OrgCredentials::org_provider_key(ORG, provider).unwrap().is_none());
        OrgCredentials::delete(ORG, provider).unwrap();
        assert!(OrgCredentials::list(ORG).unwrap().iter().all(|entry| entry.provider != provider));
    }

    #[test]
    fn p6c_value_reader_has_only_the_partition_ticket_caller() {
        let p6c = include_str!("../../cognia-companion-rpc/src/person_model.rs");
        assert_eq!(p6c.matches("::org_provider_key(").count(), 1);
        for source in [include_str!("../../cognia-companion-rpc/src/rpc.rs"),
            include_str!("../../cognia-companion-rpc/src/rpc/chat.rs"),
            include_str!("../../cognia-companion-rpc/src/rpc/service_plane.rs"),
            include_str!("../../cognia-companion-rpc/src/rpc/gateway_plane.rs"),
            include_str!("../../cognia-companion-rpc/src/provider_admin.rs"),
            include_str!("../../cognia-server/src/main.rs"),
            include_str!("../../cognia-companion/src/org_policy.rs")] {
            assert!(!source.contains("::org_provider_key("));
        }
    }
}

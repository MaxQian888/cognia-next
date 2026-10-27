//! Secrets a paired device keeps on this host (ADR-0224 A6).
//!
//! An always-on host runs work nobody is watching, so the credentials that
//! work needs have to live on it: model provider keys for unattended runs,
//! the connector credentials a moved connection brings, and git tokens for
//! the repositories it clones. All three are sealed in [`crate::secret_store`]
//! under the host's master key, each kind under its own service:
//!
//! | Kind        | Service                                  | Account                     |
//! | ----------- | ---------------------------------------- | --------------------------- |
//! | `provider`  | `com.cognia.host-provider-credentials/v1` | provider id                 |
//! | `git`       | `com.cognia.host-git-credentials/v1`      | git host (`github.com`)     |
//! | `connector` | `com.cognia.platforms`                    | `<adapterId>:<credential>`  |
//!
//! The provider service is the `keyring_secrets` namespace
//! `host-provider-credentials`, so the host's own TypeScript reads a key with
//! the ordinary `secret_store_get` it already uses for namespaced secrets. The
//! connector service is the one `cognia-connectors::keyring` has always
//! written; this module only indexes it.
//!
//! # The index: who wrote what, and when
//!
//! Every write a paired device makes is recorded in a fourth service,
//! `com.cognia.host-secret-index/v1`, as `{ setAt, setBy }` keyed by
//! `<kind>/<name>`. It is metadata only and carries no value. Two things read
//! it: [`list`], which is what "Secrets on this host" shows, and
//! [`forget_device`], which deletes every secret a device wrote when that
//! device is revoked, so a lost phone does not leave keys behind on a host it
//! can no longer reach. A secret this host wrote for itself (its own renderer,
//! loopback service calls) is indexed with no writer and is never cascaded.
//!
//! Values never leave through this module except to the host itself:
//! [`get`] and [`provider_keys`] are for the process that runs the work, and
//! no device-plane command returns them.

use serde::{Deserialize, Serialize};

use crate::secret_store::{self, SecretMutation};

/// Model provider API keys, keyed by provider id.
pub const PROVIDER_SERVICE: &str = "com.cognia.host-provider-credentials/v1";
/// Git access tokens, keyed by git host.
pub const GIT_SERVICE: &str = "com.cognia.host-git-credentials/v1";
/// Connector credentials (`cognia-connectors::keyring::SERVICE`).
pub const CONNECTOR_SERVICE: &str = "com.cognia.platforms";
/// Who wrote each secret above, and when. Never holds a value.
const INDEX_SERVICE: &str = "com.cognia.host-secret-index/v1";
// Index updates and credential-owned cleanup share one lock. Dependent
// subsystems acquire their own lock before this one, never in reverse.
static INDEX_LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

/// A name is shown to people and used as a store account; keep it short and
/// printable so neither the list nor the store has to escape anything.
const MAX_NAME_LEN: usize = 200;
/// Large enough for a GCP service-account JSON pasted as a key; small enough
/// that a mistaken paste of a whole file is refused rather than sealed.
const MAX_VALUE_LEN: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HostSecretKind {
    Provider,
    Git,
    Connector,
}

impl HostSecretKind {
    pub const ALL: [HostSecretKind; 3] = [Self::Provider, Self::Git, Self::Connector];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Provider => "provider",
            Self::Git => "git",
            Self::Connector => "connector",
        }
    }

    fn service(self) -> &'static str {
        match self {
            Self::Provider => PROVIDER_SERVICE,
            Self::Git => GIT_SERVICE,
            Self::Connector => CONNECTOR_SERVICE,
        }
    }

    fn parse(raw: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.as_str() == raw)
    }
}

/// The paired device that wrote a secret.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretWriter {
    pub device_id: String,
    /// The device's name on this host when it wrote the secret.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// One secret as "Secrets on this host" lists it: never its value.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostSecretEntry {
    pub kind: HostSecretKind,
    pub name: String,
    /// Unix milliseconds. `None` for a secret written before the index existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub set_at: Option<i64>,
    /// `None` when this host wrote it for itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub set_by: Option<SecretWriter>,
}

/// Internal store references owned by one credential. These never appear in
/// HostSecretEntry or a public RPC DTO.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretDependency {
    pub service: String,
    pub account: String,
    /// Generation markers are invalidated by an actual credential write;
    /// retained work is only removed by credential deletion/revocation.
    #[serde(default)]
    pub reset_on_write: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IndexRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    set_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    set_by: Option<SecretWriter>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    dependent_secrets: Vec<SecretDependency>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    revision: Option<String>,
}

/// Host-only value and its exact credential-write generation. Never log this
/// DTO or expose it through a device-admin secrets listing.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostSecretSnapshot {
    pub value: String,
    pub revision: String,
}

fn index_account(kind: HostSecretKind, name: &str) -> String {
    format!("{}/{}", kind.as_str(), name)
}

fn parse_index_account(account: &str) -> Option<(HostSecretKind, &str)> {
    let (kind, name) = account.split_once('/')?;
    Some((HostSecretKind::parse(kind)?, name))
}

/// Refuse a name the list could not show or the store could not key.
pub fn validate_name(kind: HostSecretKind, name: &str) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err(format!("{} secret name is required", kind.as_str()));
    }
    if name.len() > MAX_NAME_LEN {
        return Err(format!(
            "{} secret name is longer than {MAX_NAME_LEN} bytes",
            kind.as_str()
        ));
    }
    if name.chars().any(char::is_control) {
        return Err(format!(
            "{} secret name contains a control character",
            kind.as_str()
        ));
    }
    Ok(())
}

fn validate_value(value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err("secret value is empty".to_string());
    }
    if value.len() > MAX_VALUE_LEN {
        return Err(format!("secret value is larger than {MAX_VALUE_LEN} bytes"));
    }
    Ok(())
}

/// The git host a token is for, from what a person types or a remote URL:
/// `github.com`, `https://github.com/`, `https://github.com/acme/repo.git`
/// and `GitHub.com` all name `github.com`. Only HTTPS remotes take a token,
/// and a host carrying credentials (`user@host`) is refused.
pub fn normalize_git_host(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    let rest = match trimmed.split_once("://") {
        Some((scheme, rest)) if scheme.eq_ignore_ascii_case("https") => rest,
        Some((scheme, _)) => {
            return Err(format!("git tokens are for https remotes, not {scheme}://"))
        }
        None => trimmed,
    };
    let host = rest
        .split('/')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if host.is_empty() {
        return Err("git host is required".to_string());
    }
    if host.contains('@') {
        return Err("a git host must not carry credentials".to_string());
    }
    if !host
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '[' | ']'))
    {
        return Err(format!("{host} is not a git host name"));
    }
    validate_name(HostSecretKind::Git, &host)?;
    Ok(host)
}

fn record(
    kind: HostSecretKind,
    name: &str,
    writer: Option<SecretWriter>,
    now_ms: i64,
) -> Result<(), String> {
    let _guard = INDEX_LOCK.lock();
    let mut record = load_record(kind, name)?.unwrap_or_default();
    record.set_at = Some(now_ms);
    record.set_by = writer;
    write_record(kind, name, &record)
}

fn write_record(kind: HostSecretKind, name: &str, record: &IndexRecord) -> Result<(), String> {
    let value =
        serde_json::to_string(record).map_err(|error| format!("host secret index: {error}"))?;
    secret_store::set(INDEX_SERVICE, &index_account(kind, name), &value)
}

fn read_record(kind: HostSecretKind, name: &str) -> Option<IndexRecord> {
    load_record(kind, name).ok().flatten()
}

fn load_record(kind: HostSecretKind, name: &str) -> Result<Option<IndexRecord>, String> {
    let Some(raw) = secret_store::get(INDEX_SERVICE, &index_account(kind, name))? else {
        return Ok(None);
    };
    serde_json::from_str(&raw)
        .map(Some)
        .map_err(|_| "host secret index is unreadable".to_string())
}

/// Associate internal state with an existing credential, then execute its
/// narrow store operation under the same index lock as delete/revocation.
/// Callers must recheck any captured credential inside `operation`.
pub fn with_secret_dependencies<T>(
    kind: HostSecretKind,
    name: &str,
    dependencies: &[SecretDependency],
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    with_secret_dependency_group(kind, name, dependencies, &[], operation)
}

/// Register optional credentials that also fence the same operation. Missing
/// members still retain their dependency metadata, so create/delete ABA cannot
/// reuse an earlier generation. Only `required_name` must currently exist.
pub fn with_secret_dependency_group<T>(
    kind: HostSecretKind,
    required_name: &str,
    dependencies: &[SecretDependency],
    optional_members: &[(&str, &[SecretDependency])],
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    validate_name(kind, required_name)?;
    for (name, _) in optional_members {
        validate_name(kind, name)?;
    }
    let _guard = INDEX_LOCK.lock();
    if secret_store::get(kind.service(), required_name)?.is_none() {
        return Err("credential no longer exists".to_string());
    }
    register_dependencies(kind, required_name, dependencies)?;
    for (name, dependencies) in optional_members {
        register_dependencies(kind, name, dependencies)?;
    }
    operation()
}

fn register_dependencies(
    kind: HostSecretKind,
    name: &str,
    dependencies: &[SecretDependency],
) -> Result<(), String> {
    let mut record = load_record(kind, name)?.unwrap_or_default();
    let mut changed = false;
    for dependency in dependencies {
        if let Some(existing) = record.dependent_secrets.iter_mut().find(|existing| {
            existing.service == dependency.service && existing.account == dependency.account
        }) {
            if dependency.reset_on_write && !existing.reset_on_write {
                existing.reset_on_write = true;
                changed = true;
            }
        } else {
            record.dependent_secrets.push(dependency.clone());
            changed = true;
        }
    }
    if changed {
        write_record(kind, name, &record)?;
    }
    Ok(())
}

/// Seal `value` under `kind`/`name` and record who wrote it.
///
/// Connector credentials use this same transaction through
/// `cognia-connectors::keyring`, which owns their account format.
pub fn set(
    kind: HostSecretKind,
    name: &str,
    value: &str,
    writer: Option<SecretWriter>,
    now_ms: i64,
) -> Result<(), String> {
    validate_name(kind, name)?;
    validate_value(value)?;
    let _guard = INDEX_LOCK.lock();
    let mut record = load_record(kind, name)?.unwrap_or_default();
    record.set_at = Some(now_ms);
    record.set_by = writer;
    // Every actual write is a generation, even when the value is unchanged.
    record.revision = Some(new_revision());
    let index_name = index_account(kind, name);
    let encoded =
        serde_json::to_string(&record).map_err(|error| format!("host secret index: {error}"))?;
    let mut mutations: Vec<_> = record
        .dependent_secrets
        .iter()
        .filter(|dependency| dependency.reset_on_write)
        .map(|dependency| SecretMutation::Delete {
            service: &dependency.service,
            account: &dependency.account,
        })
        .collect();
    mutations.push(SecretMutation::Set {
        service: kind.service(),
        account: name,
        value,
    });
    mutations.push(SecretMutation::Set {
        service: INDEX_SERVICE,
        account: &index_name,
        value: &encoded,
    });
    secret_store::apply_batch(&mutations)
}

/// Record a secret another module sealed (a connector credential).
pub fn note_written(
    kind: HostSecretKind,
    name: &str,
    writer: Option<SecretWriter>,
    now_ms: i64,
) -> Result<(), String> {
    validate_name(kind, name)?;
    record(kind, name, writer, now_ms)
}

fn new_revision() -> String {
    hex::encode(secret_store::generate_master_key())
}

/// Atomically capture a host-only credential and its persisted write revision.
/// Existing legacy credentials acquire a revision once; metadata updates keep
/// it, while any actual write/delete/recreate changes it.
pub fn snapshot(kind: HostSecretKind, name: &str) -> Result<Option<HostSecretSnapshot>, String> {
    validate_name(kind, name)?;
    let _guard = INDEX_LOCK.lock();
    let Some(value) = secret_store::get(kind.service(), name)? else {
        return Ok(None);
    };
    let mut record = load_record(kind, name)?.unwrap_or_default();
    let revision = match record.revision.as_ref() {
        Some(revision) => revision.clone(),
        None => {
            let revision = new_revision();
            record.revision = Some(revision.clone());
            write_record(kind, name, &record)?;
            revision
        }
    };
    Ok(Some(HostSecretSnapshot { value, revision }))
}

/// Read a value for the host's own use. Never return it to a device.
pub fn get(kind: HostSecretKind, name: &str) -> Result<Option<String>, String> {
    secret_store::get(kind.service(), name)
}

/// Delete a secret and its index record. Idempotent.
pub fn delete(kind: HostSecretKind, name: &str) -> Result<(), String> {
    let _guard = INDEX_LOCK.lock();
    delete_record_and_dependencies(kind, name, load_record(kind, name)?)
}

/// Drop the index record of a secret another module deleted.
pub fn note_deleted(kind: HostSecretKind, name: &str) -> Result<(), String> {
    let _guard = INDEX_LOCK.lock();
    // The deleting RPC may arrive here after a replacement credential was
    // written. Its dependent state belongs to that replacement now.
    if secret_store::get(kind.service(), name)?.is_some() {
        return Ok(());
    }
    delete_record_and_dependencies(kind, name, load_record(kind, name)?)
}

fn delete_record_and_dependencies(
    kind: HostSecretKind,
    name: &str,
    record: Option<IndexRecord>,
) -> Result<(), String> {
    let index_name = index_account(kind, name);
    let mut mutations = vec![
        SecretMutation::Delete {
            service: kind.service(),
            account: name,
        },
        SecretMutation::Delete {
            service: INDEX_SERVICE,
            account: &index_name,
        },
    ];
    if let Some(record) = record.as_ref() {
        for dependency in &record.dependent_secrets {
            mutations.push(SecretMutation::Delete {
                service: &dependency.service,
                account: &dependency.account,
            });
        }
    }
    secret_store::apply_batch(&mutations)
}

/// Every secret on this host, by kind then name, without values.
///
/// Read from the stores themselves rather than the index alone, so a
/// connector credential this host's own settings wrote (never indexed by a
/// device) is still listed, and an index record whose secret is gone is not.
pub fn list() -> Result<Vec<HostSecretEntry>, String> {
    let mut entries = Vec::new();
    for kind in HostSecretKind::ALL {
        for name in secret_store::list_accounts(kind.service())? {
            let record = read_record(kind, &name);
            entries.push(HostSecretEntry {
                kind,
                set_at: record.as_ref().and_then(|record| record.set_at),
                set_by: record.and_then(|record| record.set_by),
                name,
            });
        }
    }
    entries.sort_by(|a, b| (a.kind, &a.name).cmp(&(b.kind, &b.name)));
    Ok(entries)
}

/// Delete every secret `device_id` wrote, with its index record.
///
/// Run when a device is revoked. Returns what was removed, for the audit
/// line. A secret whose deletion fails stays indexed, so the next revoke
/// sweep (or a person) can still find it.
pub fn forget_device(device_id: &str) -> Result<Vec<(HostSecretKind, String)>, String> {
    let _guard = INDEX_LOCK.lock();
    let mut removed = Vec::new();
    for account in secret_store::list_accounts(INDEX_SERVICE)? {
        let Some((kind, name)) = parse_index_account(&account) else {
            continue;
        };
        let Some(record) = read_record(kind, name) else {
            continue;
        };
        if record
            .set_by
            .as_ref()
            .is_some_and(|writer| writer.device_id == device_id)
        {
            let name = name.to_string();
            delete_record_and_dependencies(kind, &name, Some(record))?;
            removed.push((kind, name));
        }
    }
    Ok(removed)
}

/// Every device that has a secret indexed under it.
///
/// For the revocation sweep: a device revoked while this process was not the
/// one that revoked it (the `cognia-server devices` CLI next to a running
/// server, whose cache would write the deleted entries back) is found here.
pub fn writer_device_ids() -> Result<std::collections::BTreeSet<String>, String> {
    let mut writers = std::collections::BTreeSet::new();
    for account in secret_store::list_accounts(INDEX_SERVICE)? {
        let Some((kind, name)) = parse_index_account(&account) else {
            continue;
        };
        if let Some(writer) = read_record(kind, name).and_then(|record| record.set_by) {
            writers.insert(writer.device_id);
        }
    }
    Ok(writers)
}

/// Every provider key on this host, for the host's own unattended runs.
pub fn provider_keys() -> Result<Vec<(String, String)>, String> {
    let mut keys = Vec::new();
    for provider_id in secret_store::list_accounts(PROVIDER_SERVICE)? {
        if let Some(value) = secret_store::get(PROVIDER_SERVICE, &provider_id)? {
            keys.push((provider_id, value));
        }
    }
    keys.sort();
    Ok(keys)
}

/// The token stored for the git host a remote URL points at, if any.
pub fn git_token_for_remote(remote_url: &str) -> Result<Option<String>, String> {
    let Ok(host) = normalize_git_host(remote_url) else {
        return Ok(None);
    };
    secret_store::get(GIT_SERVICE, &host)
}

#[cfg(test)]
mod tests {
    use super::*;

    // The store is a process-global in tests, shared by every test thread, so
    // each test uses names and device ids no other test touches.

    fn writer(device: &str) -> Option<SecretWriter> {
        Some(SecretWriter {
            device_id: device.to_string(),
            label: Some(format!("{device} phone")),
        })
    }

    fn entry(kind: HostSecretKind, name: &str) -> Option<HostSecretEntry> {
        list()
            .unwrap()
            .into_iter()
            .find(|entry| entry.kind == kind && entry.name == name)
    }

    #[test]
    fn failed_index_write_does_not_replace_the_credential_owner_revision_or_epoch() {
        let kind = HostSecretKind::Connector;
        let name = "atomic-index-write:token";
        set(kind, name, "old-value", writer("atomic-index-old-owner"), 1).unwrap();
        let captured = snapshot(kind, name).unwrap().unwrap();
        let dependency = SecretDependency {
            service: "test.atomic-index".into(),
            account: "epoch".into(),
            reset_on_write: true,
        };
        with_secret_dependencies(kind, name, &[dependency], || {
            secret_store::set("test.atomic-index", "epoch", "old-epoch")
        })
        .unwrap();
        secret_store::fail_next_mutation_for_test(INDEX_SERVICE, &index_account(kind, name));
        assert!(set(
            kind,
            name,
            "replacement",
            writer("atomic-index-new-owner"),
            2
        )
        .is_err());
        let surviving = snapshot(kind, name).unwrap().unwrap();
        assert_eq!(surviving.value, "old-value");
        assert_eq!(surviving.revision, captured.revision);
        assert_eq!(
            entry(kind, name).unwrap().set_by,
            writer("atomic-index-old-owner")
        );
        assert_eq!(
            secret_store::get("test.atomic-index", "epoch")
                .unwrap()
                .as_deref(),
            Some("old-epoch")
        );
    }

    #[test]
    fn failed_dependent_delete_keeps_the_credential_and_ownership_index() {
        let kind = HostSecretKind::Connector;
        let name = "atomic-delete:token";
        set(kind, name, "old-value", writer("atomic-delete-owner"), 1).unwrap();
        let captured = snapshot(kind, name).unwrap().unwrap();
        let dependency = SecretDependency {
            service: "test.atomic-delete".into(),
            account: "pending".into(),
            reset_on_write: false,
        };
        with_secret_dependencies(kind, name, &[dependency], || {
            secret_store::set("test.atomic-delete", "pending", "accepted")
        })
        .unwrap();
        secret_store::fail_next_mutation_for_test("test.atomic-delete", "pending");
        assert!(forget_device("atomic-delete-owner").is_err());
        let surviving = snapshot(kind, name).unwrap().unwrap();
        assert_eq!(surviving.value, "old-value");
        assert_eq!(surviving.revision, captured.revision);
        assert_eq!(
            entry(kind, name).unwrap().set_by,
            writer("atomic-delete-owner")
        );
        assert_eq!(
            secret_store::get("test.atomic-delete", "pending")
                .unwrap()
                .as_deref(),
            Some("accepted")
        );
        forget_device("atomic-delete-owner").unwrap();
        assert!(snapshot(kind, name).unwrap().is_none());
    }

    #[test]
    fn credential_snapshots_fence_same_value_aba_and_preserve_metadata_only_updates() {
        let kind = HostSecretKind::Connector;
        let name = "revision-snapshot:token";
        assert!(snapshot(kind, name).unwrap().is_none());
        set(kind, name, "same", writer("revision-first"), 1).unwrap();
        let first = snapshot(kind, name).unwrap().unwrap();
        assert_eq!(first.value, "same");
        note_written(kind, name, writer("revision-metadata"), 2).unwrap();
        assert_eq!(
            snapshot(kind, name).unwrap().unwrap().revision,
            first.revision
        );
        set(kind, name, "same", writer("revision-second"), 3).unwrap();
        let second = snapshot(kind, name).unwrap().unwrap();
        assert_ne!(first.revision, second.revision);
        // Revoking the earlier writer cannot remove the replacement.
        forget_device("revision-first").unwrap();
        forget_device("revision-metadata").unwrap();
        assert_eq!(
            snapshot(kind, name).unwrap().unwrap().revision,
            second.revision
        );
        delete(kind, name).unwrap();
        assert!(snapshot(kind, name).unwrap().is_none());
        set(kind, name, "same", None, 4).unwrap();
        assert_ne!(
            snapshot(kind, name).unwrap().unwrap().revision,
            second.revision
        );
    }

    #[test]
    fn legacy_snapshot_revision_is_persisted_once_without_losing_dependency_metadata() {
        let kind = HostSecretKind::Connector;
        let name = "revision-legacy:token";
        secret_store::set(CONNECTOR_SERVICE, name, "legacy").unwrap();
        let dependency = SecretDependency {
            service: "test.revision-legacy".into(),
            account: "pending".into(),
            reset_on_write: false,
        };
        with_secret_dependencies(kind, name, std::slice::from_ref(&dependency), || Ok(())).unwrap();
        let first = snapshot(kind, name).unwrap().unwrap();
        assert_eq!(
            snapshot(kind, name).unwrap().unwrap().revision,
            first.revision
        );
        assert_eq!(
            load_record(kind, name).unwrap().unwrap().dependent_secrets,
            vec![dependency]
        );
        assert_eq!(serde_json::to_value(first).unwrap()["value"], "legacy");
    }

    #[test]
    fn dependency_group_tracks_absent_members_and_invalidates_their_generation() {
        let kind = HostSecretKind::Connector;
        let required = "dependency-group-required:token";
        let optional = "dependency-group-optional:appId";
        let generation = SecretDependency {
            service: "test.dependency-group".into(),
            account: "generation".into(),
            reset_on_write: true,
        };
        secret_store::set(CONNECTOR_SERVICE, required, "required").unwrap();
        with_secret_dependency_group(kind, required, &[], &[(optional, &[generation])], || {
            secret_store::set("test.dependency-group", "generation", "captured")
        })
        .unwrap();
        set(kind, optional, "new", writer("dependency-group-device"), 1).unwrap();
        assert_eq!(
            secret_store::get("test.dependency-group", "generation").unwrap(),
            None
        );
        assert!(get(kind, required).unwrap().is_some());
        secret_store::set("test.dependency-group", "generation", "fresh").unwrap();
        forget_device("dependency-group-device").unwrap();
        assert_eq!(
            secret_store::get("test.dependency-group", "generation").unwrap(),
            None
        );
        assert!(get(kind, required).unwrap().is_some());
    }

    #[test]
    fn unreadable_optional_member_index_prevents_the_group_operation() {
        let kind = HostSecretKind::Connector;
        let required = "dependency-group-corrupt:token";
        let optional = "dependency-group-corrupt:appId";
        secret_store::set(CONNECTOR_SERVICE, required, "required").unwrap();
        secret_store::set(INDEX_SERVICE, &index_account(kind, optional), "corrupt").unwrap();
        let mut called = false;
        let result = with_secret_dependency_group(kind, required, &[], &[(optional, &[])], || {
            called = true;
            Ok(())
        });
        assert!(result.is_err());
        assert!(!called);
        assert_eq!(
            secret_store::get(INDEX_SERVICE, &index_account(kind, optional))
                .unwrap()
                .as_deref(),
            Some("corrupt")
        );
    }

    #[test]
    fn a_provider_key_round_trips_and_lists_without_its_value() {
        set(
            HostSecretKind::Provider,
            "rt-deepseek",
            "sk-rt",
            writer("dev-rt"),
            1_000,
        )
        .unwrap();
        assert_eq!(
            get(HostSecretKind::Provider, "rt-deepseek")
                .unwrap()
                .as_deref(),
            Some("sk-rt")
        );
        let listed = entry(HostSecretKind::Provider, "rt-deepseek").unwrap();
        assert_eq!(listed.set_at, Some(1_000));
        assert_eq!(listed.set_by, writer("dev-rt"));
        let shown = serde_json::to_string(&list().unwrap()).unwrap();
        assert!(!shown.contains("sk-rt"), "{shown}");
        assert!(provider_keys()
            .unwrap()
            .contains(&("rt-deepseek".to_string(), "sk-rt".to_string())));

        delete(HostSecretKind::Provider, "rt-deepseek").unwrap();
        assert_eq!(get(HostSecretKind::Provider, "rt-deepseek").unwrap(), None);
        assert!(entry(HostSecretKind::Provider, "rt-deepseek").is_none());
        // Deleting again is not an error.
        delete(HostSecretKind::Provider, "rt-deepseek").unwrap();
    }

    #[test]
    fn dependent_refs_survive_legacy_metadata_and_writer_updates_without_public_expansion() {
        let name = "oa-dependent-legacy:token";
        let kind = HostSecretKind::Connector;
        secret_store::set(CONNECTOR_SERVICE, name, "token").unwrap();
        secret_store::set("test.dependent-oa", "legacy-queue", "retained").unwrap();
        let legacy = serde_json::json!({"setAt":1,"setBy":{"deviceId":"dev-dependency-old"}});
        secret_store::set(
            INDEX_SERVICE,
            &index_account(kind, name),
            &legacy.to_string(),
        )
        .unwrap();
        with_secret_dependencies(
            kind,
            name,
            &[SecretDependency {
                service: "test.dependent-oa".to_string(),
                account: "legacy-queue".to_string(),
                reset_on_write: false,
            }],
            || Ok(()),
        )
        .unwrap();
        note_written(kind, name, writer("dev-dependency-new"), 2).unwrap();
        let public = entry(kind, name).unwrap();
        assert_eq!(public.set_at, Some(2));
        assert_eq!(public.set_by, writer("dev-dependency-new"));
        let shown = serde_json::to_string(&public).unwrap();
        assert!(!shown.contains("dependentSecrets"));
        assert!(!shown.contains("legacy-queue"));
        assert!(forget_device("dev-dependency-old").unwrap().is_empty());
        assert!(secret_store::get("test.dependent-oa", "legacy-queue")
            .unwrap()
            .is_some());
        delete(kind, name).unwrap();
        assert_eq!(
            secret_store::get("test.dependent-oa", "legacy-queue").unwrap(),
            None
        );
        assert!(read_record(kind, name).is_none());
    }

    #[test]
    fn forgetting_device_removes_credential_owned_dependent_secrets() {
        let name = "oa-dependent-revoke:token";
        secret_store::set(CONNECTOR_SERVICE, name, "token").unwrap();
        secret_store::set("test.dependent-oa", "queue-owned", "private callback").unwrap();
        secret_store::set("test.dependent-oa", "epoch-owned", "epoch").unwrap();
        secret_store::set("test.dependent-oa", "queue-unrelated", "untouched").unwrap();
        let metadata = serde_json::json!({
            "setAt": 1,
            "setBy": {"deviceId":"dev-dependent-revoke"},
            "dependentSecrets": [
                {"service":"test.dependent-oa","account":"queue-owned"},
                {"service":"test.dependent-oa","account":"epoch-owned"}
            ]
        });
        secret_store::set(
            INDEX_SERVICE,
            &index_account(HostSecretKind::Connector, name),
            &metadata.to_string(),
        )
        .unwrap();
        forget_device("dev-dependent-revoke").unwrap();
        assert_eq!(
            secret_store::get("test.dependent-oa", "queue-owned").unwrap(),
            None
        );
        assert_eq!(
            secret_store::get("test.dependent-oa", "epoch-owned").unwrap(),
            None
        );
        assert_eq!(
            secret_store::get("test.dependent-oa", "queue-unrelated")
                .unwrap()
                .as_deref(),
            Some("untouched")
        );
    }

    #[test]
    fn revoking_a_device_removes_what_it_wrote_and_nothing_else() {
        set(HostSecretKind::Provider, "rv-a", "k1", writer("dev-rv"), 1).unwrap();
        set(
            HostSecretKind::Git,
            "rv.example.com",
            "t1",
            writer("dev-rv"),
            2,
        )
        .unwrap();
        secret_store::set(CONNECTOR_SERVICE, "rv-tg:botToken", "b1").unwrap();
        note_written(
            HostSecretKind::Connector,
            "rv-tg:botToken",
            writer("dev-rv"),
            3,
        )
        .unwrap();
        set(
            HostSecretKind::Provider,
            "rv-b",
            "k2",
            writer("dev-other"),
            4,
        )
        .unwrap();
        set(HostSecretKind::Provider, "rv-local", "k3", None, 5).unwrap();

        let mut removed = forget_device("dev-rv").unwrap();
        removed.sort();
        assert_eq!(
            removed,
            vec![
                (HostSecretKind::Provider, "rv-a".to_string()),
                (HostSecretKind::Git, "rv.example.com".to_string()),
                (HostSecretKind::Connector, "rv-tg:botToken".to_string()),
            ]
        );
        assert_eq!(get(HostSecretKind::Provider, "rv-a").unwrap(), None);
        assert_eq!(get(HostSecretKind::Git, "rv.example.com").unwrap(), None);
        assert_eq!(
            secret_store::get(CONNECTOR_SERVICE, "rv-tg:botToken").unwrap(),
            None
        );
        assert_eq!(
            get(HostSecretKind::Provider, "rv-b").unwrap().as_deref(),
            Some("k2")
        );
        assert_eq!(
            get(HostSecretKind::Provider, "rv-local")
                .unwrap()
                .as_deref(),
            Some("k3")
        );
        assert!(forget_device("dev-rv").unwrap().is_empty());
        let writers = writer_device_ids().unwrap();
        assert!(!writers.contains("dev-rv"));
        assert!(writers.contains("dev-other"));
    }

    #[test]
    fn a_connector_credential_this_host_wrote_itself_is_listed_unattributed() {
        secret_store::set(CONNECTOR_SERVICE, "self-tg:botToken", "b").unwrap();
        let listed = entry(HostSecretKind::Connector, "self-tg:botToken").unwrap();
        assert_eq!(listed.set_at, None);
        assert_eq!(listed.set_by, None);
    }

    #[test]
    fn git_hosts_normalize_from_what_people_type_and_from_remotes() {
        for input in [
            "github.com",
            "GitHub.com",
            "https://github.com",
            "https://github.com/",
            "https://github.com/acme/repo.git",
        ] {
            assert_eq!(normalize_git_host(input).unwrap(), "github.com", "{input}");
        }
        assert_eq!(
            normalize_git_host("https://git.example.com:8443/a/b").unwrap(),
            "git.example.com:8443"
        );
        assert!(normalize_git_host("ssh://git@github.com/a/b").is_err());
        assert!(normalize_git_host("https://me:pw@github.com/a").is_err());
        assert!(normalize_git_host("").is_err());
        assert!(normalize_git_host("bad host").is_err());
    }

    #[test]
    fn a_remote_finds_the_token_for_its_host() {
        set(HostSecretKind::Git, "gt.example.org", "ghp_gt", None, 1).unwrap();
        assert_eq!(
            git_token_for_remote("https://gt.example.org/acme/app.git")
                .unwrap()
                .as_deref(),
            Some("ghp_gt")
        );
        assert_eq!(
            git_token_for_remote("https://other.example.org/a").unwrap(),
            None
        );
        assert_eq!(
            git_token_for_remote("git@gt.example.org:acme/app").unwrap(),
            None
        );
    }

    #[test]
    fn empty_oversized_and_unprintable_input_is_refused() {
        assert!(set(HostSecretKind::Provider, "", "v", None, 1).is_err());
        assert!(set(HostSecretKind::Provider, "p\u{7}", "v", None, 1).is_err());
        assert!(set(HostSecretKind::Provider, &"p".repeat(201), "v", None, 1).is_err());
        assert!(set(HostSecretKind::Provider, "ok-empty", "  ", None, 1).is_err());
        assert!(set(
            HostSecretKind::Provider,
            "ok-big",
            &"v".repeat(MAX_VALUE_LEN + 1),
            None,
            1
        )
        .is_err());
        assert_eq!(get(HostSecretKind::Provider, "ok-empty").unwrap(), None);
    }
}

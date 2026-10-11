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

use crate::secret_store;

/// Model provider API keys, keyed by provider id.
pub const PROVIDER_SERVICE: &str = "com.cognia.host-provider-credentials/v1";
/// Git access tokens, keyed by git host.
pub const GIT_SERVICE: &str = "com.cognia.host-git-credentials/v1";
/// Connector credentials (`cognia-connectors::keyring::SERVICE`).
pub const CONNECTOR_SERVICE: &str = "com.cognia.platforms";
/// Who wrote each secret above, and when. Never holds a value.
const INDEX_SERVICE: &str = "com.cognia.host-secret-index/v1";

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

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IndexRecord {
    set_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    set_by: Option<SecretWriter>,
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
            return Err(format!(
                "git tokens are for https remotes, not {scheme}://"
            ))
        }
        None => trimmed,
    };
    let host = rest.split('/').next().unwrap_or_default().to_ascii_lowercase();
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
    let value = serde_json::to_string(&IndexRecord {
        set_at: now_ms,
        set_by: writer,
    })
    .map_err(|error| format!("host secret index: {error}"))?;
    secret_store::set(INDEX_SERVICE, &index_account(kind, name), &value)
}

fn read_record(kind: HostSecretKind, name: &str) -> Option<IndexRecord> {
    let raw = secret_store::get(INDEX_SERVICE, &index_account(kind, name)).ok()??;
    serde_json::from_str(&raw).ok()
}

/// Seal `value` under `kind`/`name` and record who wrote it.
///
/// Connector credentials are written by `cognia-connectors::keyring`, which
/// owns their account format; call [`note_written`] after that write instead.
pub fn set(
    kind: HostSecretKind,
    name: &str,
    value: &str,
    writer: Option<SecretWriter>,
    now_ms: i64,
) -> Result<(), String> {
    validate_name(kind, name)?;
    validate_value(value)?;
    secret_store::set(kind.service(), name, value)?;
    record(kind, name, writer, now_ms)
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

/// Read a value for the host's own use. Never return it to a device.
pub fn get(kind: HostSecretKind, name: &str) -> Result<Option<String>, String> {
    secret_store::get(kind.service(), name)
}

/// Delete a secret and its index record. Idempotent.
pub fn delete(kind: HostSecretKind, name: &str) -> Result<(), String> {
    secret_store::delete(kind.service(), name)?;
    note_deleted(kind, name)
}

/// Drop the index record of a secret another module deleted.
pub fn note_deleted(kind: HostSecretKind, name: &str) -> Result<(), String> {
    secret_store::delete(INDEX_SERVICE, &index_account(kind, name))
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
                set_at: record.as_ref().map(|record| record.set_at),
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
            secret_store::delete(kind.service(), &name)?;
            secret_store::delete(INDEX_SERVICE, &account)?;
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
            get(HostSecretKind::Provider, "rt-deepseek").unwrap().as_deref(),
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
    fn revoking_a_device_removes_what_it_wrote_and_nothing_else() {
        set(HostSecretKind::Provider, "rv-a", "k1", writer("dev-rv"), 1).unwrap();
        set(HostSecretKind::Git, "rv.example.com", "t1", writer("dev-rv"), 2).unwrap();
        secret_store::set(CONNECTOR_SERVICE, "rv-tg:botToken", "b1").unwrap();
        note_written(HostSecretKind::Connector, "rv-tg:botToken", writer("dev-rv"), 3).unwrap();
        set(HostSecretKind::Provider, "rv-b", "k2", writer("dev-other"), 4).unwrap();
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
        assert_eq!(secret_store::get(CONNECTOR_SERVICE, "rv-tg:botToken").unwrap(), None);
        assert_eq!(get(HostSecretKind::Provider, "rv-b").unwrap().as_deref(), Some("k2"));
        assert_eq!(get(HostSecretKind::Provider, "rv-local").unwrap().as_deref(), Some("k3"));
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
        assert_eq!(git_token_for_remote("https://other.example.org/a").unwrap(), None);
        assert_eq!(git_token_for_remote("git@gt.example.org:acme/app").unwrap(), None);
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

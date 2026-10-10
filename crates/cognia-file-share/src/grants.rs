//! Grant lifecycle (ADR-0222 §4, §8.3 for the parts P2 owns).
//!
//! These functions change the store and return what the caller must still do
//! outside it — deprovision a provider account, drop live connections — so
//! the service can run those effects without holding the store.
//!
//! - **Create**: the policy allows it; every path normalizes, lies in a synced,
//!   available mount of an active conversation, is not on the sensitive floor,
//!   and exists; write is refused on a read-only mount; nested paths collapse
//!   into their ancestor. One credential is issued per protocol.
//! - **Revoke** is final and revokes the credentials.
//! - **Suspend / resume**: a pause the owner can lift. Resuming a `stale`
//!   grant is the owner reconfirming it: its paths re-bind to the mounts as
//!   they are now.
//! - **Maintenance** expires grants, suspends those the policy no longer
//!   allows (and resumes them when it allows them again), and follows the
//!   conversation's archive and delete state from the mount table.

use std::collections::BTreeSet;

use crate::audit::{self, Event, Outcome};
use crate::credentials::{self, SshKey};
use crate::error::{FileShareError, FileShareResult};
use crate::model::{
    status_reason, Backing, CreateGrantRequest, CreatedBy, CredentialView, Grant, GrantPath,
    GrantStatus, IssuedCredential, MountRecord, Permission, Protocol, ProviderKind, SessionState,
};
use crate::paths;
use crate::policy::PolicySnapshot;
use crate::store::{CredentialRow, Store};

/// Most paths one grant may name.
pub const MAX_GRANT_PATHS: usize = 50;
/// Longest label.
pub const MAX_LABEL_CHARS: usize = 120;

/// A freshly created grant, before provider provisioning.
#[derive(Debug, Clone)]
pub struct Created {
    pub grant: Grant,
    pub credentials: Vec<IssuedCredential>,
    pub rows: Vec<CredentialRow>,
}

/// Effects of a state change the service must carry out.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Effects {
    /// Grants whose live connections must be dropped.
    pub disconnect: Vec<String>,
    /// Credentials whose provider accounts must be removed.
    pub deprovision: Vec<CredentialRow>,
    /// Credentials whose provider accounts must be disabled (still resumable).
    pub disable: Vec<CredentialRow>,
    /// Credentials whose provider accounts must be enabled again.
    pub enable: Vec<CredentialRow>,
}

impl Effects {
    pub fn merge(&mut self, other: Effects) {
        self.disconnect.extend(other.disconnect);
        self.deprovision.extend(other.deprovision);
        self.disable.extend(other.disable);
        self.enable.extend(other.enable);
    }

    pub fn is_empty(&self) -> bool {
        self.disconnect.is_empty()
            && self.deprovision.is_empty()
            && self.disable.is_empty()
            && self.enable.is_empty()
    }
}

fn locate<'a>(mounts: &'a [MountRecord], path: &str) -> Option<(&'a MountRecord, String)> {
    mounts
        .iter()
        .filter(|mount| paths::is_within(path, &mount.virtual_path))
        .max_by_key(|mount| mount.virtual_path.len())
        .and_then(|mount| {
            paths::relative_to(path, &mount.virtual_path).map(|rel| (mount, rel.to_string()))
        })
}

fn resolve_paths(
    store: &Store,
    session_id: &str,
    requested: &[String],
    write: bool,
) -> FileShareResult<Vec<GrantPath>> {
    if requested.is_empty() || requested.len() > MAX_GRANT_PATHS {
        return Err(FileShareError::invalid(format!(
            "a live share names between 1 and {MAX_GRANT_PATHS} paths"
        )));
    }
    let mounts = store.mounts_for_session(session_id)?;
    if mounts.is_empty() {
        return Err(FileShareError::new(
            "mount_not_synced",
            "this conversation's files have not reached the host yet",
        ));
    }
    let mut normalized: Vec<String> = Vec::with_capacity(requested.len());
    for raw in requested {
        let path = paths::normalize(raw)
            .ok_or_else(|| FileShareError::new("invalid_path", format!("not a FileSpace path: {raw}")))?;
        normalized.push(path);
    }
    normalized.sort();
    normalized.dedup();
    let mut out: Vec<GrantPath> = Vec::new();
    for path in normalized {
        if out
            .iter()
            .any(|kept| kept.is_dir && paths::is_within(&path, &kept.virtual_path))
        {
            continue;
        }
        let (mount, rel) = locate(&mounts, &path).ok_or_else(|| {
            FileShareError::new("invalid_path", format!("{path} is not inside a mount"))
        })?;
        match mount.session_state {
            SessionState::Active => {}
            _ => {
                return Err(FileShareError::new(
                    "session_inactive",
                    "an archived or deleted conversation cannot be shared live",
                ))
            }
        }
        if mount.status != "available" {
            return Err(FileShareError::new(
                "mount_unavailable",
                format!("{} is {}", mount.virtual_path, mount.status),
            ));
        }
        if write && !mount.writable {
            return Err(FileShareError::new(
                "mount_read_only",
                format!("{} cannot be written", mount.virtual_path),
            ));
        }
        if crate::gateway::is_sensitive_rel(&rel) {
            return Err(FileShareError::new(
                "sensitive_path",
                format!("{path} holds credentials or keys and is never shared live"),
            ));
        }
        let is_dir = match mount.backing {
            Backing::Dexie => {
                if rel.is_empty() {
                    true
                } else if rel.contains('/')
                    || store.asset(session_id, &mount.mount_id, &rel)?.is_none()
                {
                    return Err(FileShareError::not_found(format!("{path} does not exist")));
                } else {
                    false
                }
            }
            Backing::Disk => {
                let host = mount.host_path.as_deref().ok_or_else(|| {
                    FileShareError::new("mount_unavailable", "the folder has no directory")
                })?;
                let (_, abs) = cognia_files::files::resolve_confined_workspace_path(host, &rel, true)
                    .map_err(|_| FileShareError::not_found(format!("{path} does not exist")))?;
                std::fs::metadata(&abs)
                    .map_err(|_| FileShareError::not_found(format!("{path} does not exist")))?
                    .is_dir()
            }
        };
        // A directory added after its descendants replaces them.
        if is_dir {
            out.retain(|kept| !paths::is_within(&kept.virtual_path, &path));
        }
        out.push(GrantPath {
            mount_id: mount.mount_id.clone(),
            rel_path: rel,
            is_dir,
            mount_fingerprint: mount.fingerprint.clone(),
            virtual_path: path,
        });
    }
    Ok(out)
}

fn normalized_permissions(requested: &[Permission]) -> FileShareResult<Vec<Permission>> {
    let set: BTreeSet<Permission> = requested.iter().copied().collect();
    if !set.contains(&Permission::Read) {
        return Err(FileShareError::invalid("a live share always allows reading"));
    }
    Ok(set.into_iter().collect())
}

fn normalized_protocols(requested: &[Protocol]) -> FileShareResult<Vec<Protocol>> {
    let set: BTreeSet<Protocol> = requested.iter().copied().collect();
    if set.is_empty() {
        return Err(FileShareError::invalid("choose WebDAV, SFTP or both"));
    }
    Ok(set.into_iter().collect())
}

fn mint_username(store: &Store) -> FileShareResult<String> {
    for _ in 0..8 {
        let candidate = credentials::new_username();
        if !store.username_taken(&candidate)? {
            return Ok(candidate);
        }
    }
    Err(FileShareError::new(
        "credential_conflict",
        "could not pick an unused username",
    ))
}

/// Create a grant and its credentials.
pub fn create(
    store: &Store,
    policy: &PolicySnapshot,
    request: &CreateGrantRequest,
    creator_principal: &str,
    now: i64,
) -> FileShareResult<Created> {
    let permissions = normalized_permissions(&request.permissions)?;
    let protocols = normalized_protocols(&request.protocols)?;
    policy.check_create(&permissions, request.expires_in_seconds)?;
    let label = request
        .label
        .as_deref()
        .map(str::trim)
        .filter(|label| !label.is_empty())
        .map(|label| label.chars().take(MAX_LABEL_CHARS).collect::<String>());
    let ssh_key: Option<SshKey> = match request.ssh_public_key.as_deref().map(str::trim) {
        Some(key) if !key.is_empty() => {
            if !protocols.contains(&Protocol::Sftp) {
                return Err(FileShareError::invalid(
                    "an SSH public key only applies to SFTP",
                ));
            }
            Some(credentials::parse_ssh_public_key(key)?)
        }
        _ => None,
    };
    let grant_paths = resolve_paths(
        store,
        &request.session_id,
        &request.paths,
        permissions.contains(&Permission::Write),
    )?;

    let grant_id = credentials::new_id("fg_");
    let mut issued = Vec::with_capacity(protocols.len());
    let mut rows = Vec::with_capacity(protocols.len());
    for protocol in &protocols {
        let password = credentials::new_password();
        let password_hash = match request.provider {
            ProviderKind::Builtin => Some(credentials::hash_password(&password)?),
            // SFTPGo receives the password once and keeps its own hash.
            ProviderKind::Sftpgo => None,
        };
        let key = ssh_key.as_ref().filter(|_| *protocol == Protocol::Sftp);
        let username = mint_username(store)?;
        let view = CredentialView {
            id: credentials::new_id("fc_"),
            grant_id: grant_id.clone(),
            protocol: *protocol,
            provider: request.provider,
            username: username.clone(),
            ssh_key_fingerprint: key.map(|key| key.fingerprint.clone()),
            created_at: now,
            rotated_at: None,
            revoked_at: None,
        };
        rows.push(CredentialRow {
            view: view.clone(),
            password_hash,
            ssh_public_key: key.map(|key| key.openssh.clone()),
            provider_account_id: (request.provider == ProviderKind::Sftpgo).then_some(username),
        });
        issued.push(IssuedCredential {
            credential: view,
            password,
        });
    }
    let grant = Grant {
        id: grant_id,
        session_id: request.session_id.clone(),
        label,
        created_by: CreatedBy::User,
        creator_principal: creator_principal.to_string(),
        protocols,
        provider: request.provider,
        permissions,
        status: GrantStatus::Active,
        status_reason: None,
        expires_at: now + request.expires_in_seconds * 1000,
        policy_revision: policy.revision,
        created_at: now,
        updated_at: now,
        revoked_at: None,
        paths: grant_paths,
    };
    store.insert_grant(&grant, &rows)?;
    audit::record(
        store,
        now,
        Event {
            session_id: Some(&grant.session_id),
            grant_id: Some(&grant.id),
            principal: creator_principal,
            action: "grant.create",
            ..Event::default()
        },
    );
    for row in &rows {
        audit::record(
            store,
            now,
            Event {
                session_id: Some(&grant.session_id),
                grant_id: Some(&grant.id),
                principal: creator_principal,
                action: "credential.issue",
                path: Some(row.view.protocol.as_str()),
                ..Event::default()
            },
        );
    }
    Ok(Created {
        grant,
        credentials: issued,
        rows,
    })
}

fn require_grant(store: &Store, grant_id: &str) -> FileShareResult<Grant> {
    store
        .grant(grant_id)?
        .ok_or_else(|| FileShareError::not_found(format!("no live share {grant_id}")))
}

fn transition(
    store: &Store,
    grant: &Grant,
    status: GrantStatus,
    reason: &str,
    action: &str,
    principal: &str,
    now: i64,
) -> FileShareResult<bool> {
    let changed = store.set_grant_status(&grant.id, status, Some(reason), now)?;
    if changed {
        audit::record(
            store,
            now,
            Event {
                session_id: Some(&grant.session_id),
                grant_id: Some(&grant.id),
                principal,
                action,
                reason: Some(reason),
                ..Event::default()
            },
        );
    }
    Ok(changed)
}

fn live_credentials(store: &Store, grant_id: &str) -> FileShareResult<Vec<CredentialRow>> {
    Ok(store
        .credentials_for_grant(grant_id)?
        .into_iter()
        .filter(|row| row.view.revoked_at.is_none())
        .collect())
}

/// Revoke a grant for good.
pub fn revoke(
    store: &Store,
    grant_id: &str,
    reason: &str,
    principal: &str,
    now: i64,
) -> FileShareResult<Effects> {
    let grant = require_grant(store, grant_id)?;
    if grant.status == GrantStatus::Revoked {
        return Ok(Effects::default());
    }
    transition(store, &grant, GrantStatus::Revoked, reason, "grant.revoke", principal, now)?;
    let revoked = store.revoke_credentials_for_grant(grant_id, now)?;
    Ok(Effects {
        disconnect: vec![grant.id],
        deprovision: revoked,
        ..Effects::default()
    })
}

/// Pause a grant.
pub fn suspend(
    store: &Store,
    grant_id: &str,
    reason: &str,
    principal: &str,
    now: i64,
) -> FileShareResult<Effects> {
    let grant = require_grant(store, grant_id)?;
    if grant.status != GrantStatus::Active {
        return Err(FileShareError::new(
            "grant_not_active",
            format!("this share is {}", grant.status.as_str()),
        ));
    }
    transition(store, &grant, GrantStatus::Suspended, reason, "grant.suspend", principal, now)?;
    Ok(Effects {
        disconnect: vec![grant.id.clone()],
        disable: live_credentials(store, &grant.id)?,
        ..Effects::default()
    })
}

/// Lift a pause, or reconfirm a stale grant against the mounts as they are.
pub fn resume(
    store: &Store,
    policy: &PolicySnapshot,
    grant_id: &str,
    principal: &str,
    now: i64,
) -> FileShareResult<Effects> {
    let grant = require_grant(store, grant_id)?;
    if !matches!(grant.status, GrantStatus::Suspended | GrantStatus::Stale) {
        return Err(FileShareError::new(
            "grant_not_resumable",
            format!("a {} share cannot be resumed", grant.status.as_str()),
        ));
    }
    if grant.expires_at <= now {
        transition(store, &grant, GrantStatus::Expired, status_reason::EXPIRED, "grant.expire", "system", now)?;
        return Err(FileShareError::new("grant_expired", "this share has expired"));
    }
    if let Some(reason) = policy.exceeded_by(&grant) {
        return Err(FileShareError::new(
            "policy_exceeded",
            format!("the file-sharing policy no longer allows this share ({reason})"),
        ));
    }
    if grant.status == GrantStatus::Stale {
        for path in &grant.paths {
            let mount = store
                .mount(&grant.session_id, &path.mount_id)?
                .filter(MountRecord::is_available)
                .ok_or_else(|| {
                    FileShareError::new(
                        "mount_unavailable",
                        format!("{} is not available to reconfirm", path.virtual_path),
                    )
                })?;
            store.set_grant_path_fingerprint(&grant.id, &path.mount_id, &path.rel_path, &mount.fingerprint)?;
        }
    } else if store.session_state(&grant.session_id)? != Some(SessionState::Active) {
        return Err(FileShareError::new(
            "session_inactive",
            "the conversation is archived or deleted",
        ));
    }
    transition(store, &grant, GrantStatus::Active, status_reason::OWNER, "grant.resume", principal, now)?;
    Ok(Effects {
        enable: live_credentials(store, &grant.id)?,
        ..Effects::default()
    })
}

/// Issue a new password for a credential.
pub fn rotate(
    store: &Store,
    credential_id: &str,
    principal: &str,
    now: i64,
) -> FileShareResult<(IssuedCredential, CredentialRow)> {
    let row = store
        .credential(credential_id)?
        .ok_or_else(|| FileShareError::not_found(format!("no credential {credential_id}")))?;
    if row.view.revoked_at.is_some() {
        return Err(FileShareError::new("credential_revoked", "this credential was revoked"));
    }
    let grant = require_grant(store, &row.view.grant_id)?;
    if grant.status.is_terminal() {
        return Err(FileShareError::new(
            "grant_not_active",
            format!("this share is {}", grant.status.as_str()),
        ));
    }
    let password = credentials::new_password();
    let hash = match row.view.provider {
        ProviderKind::Builtin => Some(credentials::hash_password(&password)?),
        ProviderKind::Sftpgo => None,
    };
    store.rotate_credential(credential_id, hash.as_deref(), now)?;
    audit::record(
        store,
        now,
        Event {
            session_id: Some(&grant.session_id),
            grant_id: Some(&grant.id),
            principal,
            action: "credential.rotate",
            path: Some(row.view.protocol.as_str()),
            ..Event::default()
        },
    );
    let mut view = row.view.clone();
    view.rotated_at = Some(now);
    Ok((IssuedCredential { credential: view, password }, row))
}

/// One maintenance pass: expiry, policy and conversation state.
pub fn maintain(store: &Store, policy: &PolicySnapshot, now: i64) -> FileShareResult<Effects> {
    let mut effects = Effects::default();
    for grant in store.list_grants(None)? {
        match grant.status {
            GrantStatus::Expired | GrantStatus::Revoked => continue,
            _ => {}
        }
        if grant.expires_at <= now {
            transition(store, &grant, GrantStatus::Expired, status_reason::EXPIRED, "grant.expire", "system", now)?;
            effects.disconnect.push(grant.id.clone());
            effects.deprovision.extend(store.revoke_credentials_for_grant(&grant.id, now)?);
            continue;
        }
        let session_state = store.session_state(&grant.session_id)?;
        if session_state == Some(SessionState::Deleted) {
            effects.merge(revoke(store, &grant.id, status_reason::SESSION_DELETED, "system", now)?);
            continue;
        }
        let reason = grant.status_reason.as_deref();
        match grant.status {
            GrantStatus::Active => {
                let pause = if session_state == Some(SessionState::Archived) {
                    Some(status_reason::SESSION_ARCHIVED)
                } else if policy.exceeded_by(&grant).is_some() {
                    Some(status_reason::POLICY)
                } else {
                    None
                };
                if let Some(pause) = pause {
                    effects.merge(suspend(store, &grant.id, pause, "system", now)?);
                }
            }
            GrantStatus::Suspended
                if reason == Some(status_reason::POLICY)
                    || reason == Some(status_reason::SESSION_ARCHIVED) =>
            {
                let still_paused = session_state == Some(SessionState::Archived)
                    || policy.exceeded_by(&grant).is_some();
                if !still_paused && session_state == Some(SessionState::Active) {
                    transition(store, &grant, GrantStatus::Active, status_reason::OWNER, "grant.resume", "system", now)?;
                    effects.enable.extend(live_credentials(store, &grant.id)?);
                }
            }
            _ => {}
        }
    }
    Ok(effects)
}

/// Record an auth failure or success against a credential, for the audit log.
pub fn audit_auth(
    store: &Store,
    now: i64,
    username: &str,
    channel: audit::Channel,
    remote: Option<&str>,
    outcome: Outcome,
    reason: Option<&str>,
) {
    let row = store.credential_by_username(username).ok().flatten();
    let grant = row
        .as_ref()
        .and_then(|row| store.grant(&row.view.grant_id).ok().flatten());
    audit::record(
        store,
        now,
        Event {
            session_id: grant.as_ref().map(|grant| grant.session_id.as_str()),
            grant_id: row.as_ref().map(|row| row.view.grant_id.as_str()),
            principal: &audit::credential_principal(username),
            channel: Some(channel),
            action: if outcome == Outcome::Allowed { "auth.ok" } else { "auth.fail" },
            outcome: Some(outcome),
            reason,
            remote,
            ..Event::default()
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gateway::tests::{fixture, open_policy, Fixture};

    /// The gateway fixture without its own grant, so only the grants a test
    /// creates are in play.
    fn fresh() -> Fixture {
        let f = fixture(vec![Permission::Read], vec![]);
        revoke(&f.store, "fg_1", status_reason::REVOKED, "owner", 0).unwrap();
        f
    }

    fn request(paths: &[&str], permissions: &[Permission]) -> CreateGrantRequest {
        CreateGrantRequest {
            session_id: "s1".into(),
            paths: paths.iter().map(|p| p.to_string()).collect(),
            permissions: permissions.to_vec(),
            protocols: vec![Protocol::Webdav, Protocol::Sftp],
            provider: ProviderKind::Builtin,
            expires_in_seconds: 3600,
            label: Some("  Design review  ".into()),
            ssh_public_key: None,
        }
    }

    #[test]
    fn create_issues_one_hashed_credential_per_protocol() {
            let f = fresh();
        let created = create(
            &f.store,
            &open_policy(),
            &request(&["/workspace/src", "/workspace/src/a.txt", "/uploads/photo.png"], &[Permission::Download, Permission::Read]),
            "owner",
            1_000,
        )
        .unwrap();
        let grant = &created.grant;
        assert_eq!(grant.label.as_deref(), Some("Design review"));
        assert_eq!(grant.permissions, vec![Permission::Read, Permission::Download]);
        assert_eq!(grant.expires_at, 1_000 + 3_600_000);
        assert_eq!(grant.policy_revision, 1);
        assert_eq!(
            grant.paths.iter().map(|p| p.virtual_path.as_str()).collect::<Vec<_>>(),
            vec!["/uploads/photo.png", "/workspace/src"],
            "the nested file folds into its folder"
        );
        assert!(grant.paths[1].is_dir);
        assert!(!grant.paths[0].is_dir);
        assert_eq!(created.credentials.len(), 2);
        for (issued, row) in created.credentials.iter().zip(&created.rows) {
            let hash = row.password_hash.as_deref().unwrap();
            assert!(credentials::verify_password(&issued.password, hash));
            assert!(credentials::is_username(&issued.credential.username));
        }
        let stored = f.store.grant(&grant.id).unwrap().unwrap();
        assert_eq!(&stored, grant);
        let audit = f.store.list_audit(Some("s1"), Some(&grant.id), None, 10).unwrap();
        assert_eq!(audit.iter().filter(|r| r.action == "credential.issue").count(), 2);
        assert!(audit.iter().any(|r| r.action == "grant.create"));
    }

    #[test]
    fn create_refuses_what_policy_paths_and_mounts_do_not_allow() {
            let f = fresh();
        let policy = open_policy();
        let code = |req: CreateGrantRequest, policy: &PolicySnapshot| {
            create(&f.store, policy, &req, "owner", 1_000).unwrap_err().code
        };
        assert_eq!(code(request(&["/workspace/src/.env"], &[Permission::Read]), &policy), "sensitive_path");
        assert_eq!(code(request(&["/workspace/.git"], &[Permission::Read]), &policy), "sensitive_path");
        assert_eq!(code(request(&["/workspace/nope"], &[Permission::Read]), &policy), "not_found");
        assert_eq!(code(request(&["/elsewhere"], &[Permission::Read]), &policy), "invalid_path");
        assert_eq!(code(request(&["/"], &[Permission::Read]), &policy), "invalid_path");
        assert_eq!(code(request(&["/workspace/../x"], &[Permission::Read]), &policy), "invalid_path");
        assert_eq!(code(request(&["/uploads"], &[Permission::Read, Permission::Write]), &policy), "mount_read_only");
        assert_eq!(code(request(&[], &[Permission::Read]), &policy), "invalid_request");
        assert_eq!(code(request(&["/workspace"], &[Permission::Download]), &policy), "invalid_request");
        let mut no_protocol = request(&["/workspace"], &[Permission::Read]);
        no_protocol.protocols.clear();
        assert_eq!(code(no_protocol, &policy), "invalid_request");
        let mut too_long = request(&["/workspace"], &[Permission::Read]);
        too_long.expires_in_seconds = 30 * 24 * 3600;
        assert_eq!(code(too_long, &policy), "ttl_exceeds_policy");
        assert_eq!(
            code(request(&["/workspace"], &[Permission::Read]), &PolicySnapshot::default()),
            "policy_credentials_disabled"
        );
        let mut webdav_with_key = request(&["/workspace"], &[Permission::Read]);
        webdav_with_key.protocols = vec![Protocol::Webdav];
        webdav_with_key.ssh_public_key = Some("ssh-ed25519 AAAA".into());
        assert_eq!(code(webdav_with_key, &policy), "invalid_request");
        let mut other_session = request(&["/workspace"], &[Permission::Read]);
        other_session.session_id = "s2".into();
        assert_eq!(code(other_session, &policy), "mount_not_synced");
        f.store.set_session_state("s1", SessionState::Archived, 2).unwrap();
        assert_eq!(code(request(&["/workspace"], &[Permission::Read]), &policy), "session_inactive");
    }

    #[test]
    fn an_sftp_key_is_kept_with_its_fingerprint() {
            let f = fresh();
        let mut req = request(&["/workspace/src"], &[Permission::Read]);
        req.ssh_public_key = Some("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIHnXLB2/rV5vjoZMTLHHGlIIitsmvAND8BNBOQoMilv x".into());
        let created = create(&f.store, &open_policy(), &req, "owner", 1).unwrap();
        let sftp = created.rows.iter().find(|r| r.view.protocol == Protocol::Sftp).unwrap();
        let webdav = created.rows.iter().find(|r| r.view.protocol == Protocol::Webdav).unwrap();
        assert!(sftp.ssh_public_key.is_some());
        assert!(sftp.view.ssh_key_fingerprint.as_deref().unwrap().starts_with("SHA256:"));
        assert!(webdav.ssh_public_key.is_none());
    }

    #[test]
    fn sftpgo_credentials_keep_no_password_hash() {
            let f = fresh();
        let mut req = request(&["/workspace/src"], &[Permission::Read]);
        req.provider = ProviderKind::Sftpgo;
        let created = create(&f.store, &open_policy(), &req, "owner", 1).unwrap();
        assert!(created.rows.iter().all(|row| row.password_hash.is_none()));
        assert!(created
            .rows
            .iter()
            .all(|row| row.provider_account_id.as_deref() == Some(row.view.username.as_str())));
    }

    #[test]
    fn revoke_suspend_resume_and_rotate() {
            let f = fresh();
        let policy = open_policy();
        let created = create(&f.store, &policy, &request(&["/workspace/src"], &[Permission::Read]), "owner", 1).unwrap();
        let id = created.grant.id.clone();

        let effects = suspend(&f.store, &id, status_reason::OWNER, "owner", 2).unwrap();
        assert_eq!(effects.disconnect, vec![id.clone()]);
        assert_eq!(effects.disable.len(), 2);
        assert_eq!(suspend(&f.store, &id, "owner", "owner", 3).unwrap_err().code, "grant_not_active");
        let effects = resume(&f.store, &policy, &id, "owner", 4).unwrap();
        assert_eq!(effects.enable.len(), 2);
        assert_eq!(f.store.grant(&id).unwrap().unwrap().status, GrantStatus::Active);

        let (issued, _) = rotate(&f.store, &created.rows[0].view.id, "owner", 5).unwrap();
        let row = f.store.credential(&created.rows[0].view.id).unwrap().unwrap();
        assert!(credentials::verify_password(&issued.password, row.password_hash.as_deref().unwrap()));
        assert!(!credentials::verify_password(&created.credentials[0].password, row.password_hash.as_deref().unwrap()));

        let effects = revoke(&f.store, &id, status_reason::REVOKED, "owner", 6).unwrap();
        assert_eq!(effects.deprovision.len(), 2);
        assert!(revoke(&f.store, &id, status_reason::REVOKED, "owner", 7).unwrap().is_empty());
        assert_eq!(resume(&f.store, &policy, &id, "owner", 8).unwrap_err().code, "grant_not_resumable");
        assert_eq!(rotate(&f.store, &created.rows[0].view.id, "owner", 9).unwrap_err().code, "credential_revoked");
    }

    #[test]
    fn a_stale_grant_is_reconfirmed_against_the_current_mount() {
            let f = fresh();
        let policy = open_policy();
        let created = create(&f.store, &policy, &request(&["/workspace/src"], &[Permission::Read]), "owner", 1).unwrap();
        let id = created.grant.id.clone();
        let mut mounts = f.store.mounts_for_session("s1").unwrap();
        let workspace = mounts.iter_mut().find(|m| m.mount_id == "workspace").unwrap();
        workspace.fingerprint = "retargeted".into();
        f.store.replace_session_mounts("s1", &mounts, &[]).unwrap();
        f.store.set_grant_status(&id, GrantStatus::Stale, Some("mount_changed"), 2).unwrap();
        resume(&f.store, &policy, &id, "owner", 3).unwrap();
        let grant = f.store.grant(&id).unwrap().unwrap();
        assert_eq!(grant.status, GrantStatus::Active);
        assert_eq!(grant.paths[0].mount_fingerprint, "retargeted");
    }

    #[test]
    fn maintenance_follows_expiry_policy_and_conversation_state() {
            let f = fresh();
        let policy = open_policy();
        let a = create(&f.store, &policy, &request(&["/workspace/src"], &[Permission::Read]), "owner", 1_000).unwrap().grant.id;

        // Policy turns network drives off → suspended, then back on → resumed.
        let off = PolicySnapshot::default();
        let effects = maintain(&f.store, &off, 2_000).unwrap();
        assert_eq!(effects.disconnect, vec![a.clone()]);
        let grant = f.store.grant(&a).unwrap().unwrap();
        assert_eq!((grant.status, grant.status_reason.as_deref()), (GrantStatus::Suspended, Some("policy")));
        let effects = maintain(&f.store, &policy, 3_000).unwrap();
        assert_eq!(effects.enable.len(), 2);
        assert_eq!(f.store.grant(&a).unwrap().unwrap().status, GrantStatus::Active);

        // An owner's pause is not lifted by maintenance.
        suspend(&f.store, &a, status_reason::OWNER, "owner", 3_500).unwrap();
        assert!(maintain(&f.store, &policy, 3_600).unwrap().enable.is_empty());
        resume(&f.store, &policy, &a, "owner", 3_700).unwrap();

        // Archive suspends; unarchive resumes.
        f.store.set_session_state("s1", SessionState::Archived, 4_000).unwrap();
        maintain(&f.store, &policy, 4_000).unwrap();
        assert_eq!(f.store.grant(&a).unwrap().unwrap().status_reason.as_deref(), Some("session_archived"));
        f.store.set_session_state("s1", SessionState::Active, 5_000).unwrap();
        maintain(&f.store, &policy, 5_000).unwrap();
        assert_eq!(f.store.grant(&a).unwrap().unwrap().status, GrantStatus::Active);

        // Expiry is final and revokes the credentials.
        let effects = maintain(&f.store, &policy, 1_000 + 3_600_000).unwrap();
        assert_eq!(effects.deprovision.len(), 2);
        assert_eq!(f.store.grant(&a).unwrap().unwrap().status, GrantStatus::Expired);

        // Deleting the conversation revokes.
        let b = create(&f.store, &policy, &request(&["/workspace/src"], &[Permission::Read]), "owner", 10_000_000).unwrap().grant.id;
        f.store.set_session_state("s1", SessionState::Deleted, 10_000_001).unwrap();
        maintain(&f.store, &policy, 10_000_002).unwrap();
        let grant = f.store.grant(&b).unwrap().unwrap();
        assert_eq!((grant.status, grant.status_reason.as_deref()), (GrantStatus::Revoked, Some("session_deleted")));
    }
}

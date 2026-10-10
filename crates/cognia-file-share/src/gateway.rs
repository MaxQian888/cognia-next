//! The file gateway (ADR-0222 §7.2): the one authority every live operation
//! goes through, whichever protocol carried it.
//!
//! [`authorize`] checks, in order:
//!
//! 1. the grant — it exists, is `active`, is unexpired, its credential is not
//!    revoked, and its permissions cover the operation (`read` for listing and
//!    metadata, `download` for bytes, `write` for every mutation);
//! 2. the effective policy at its current revision, so a tightened policy
//!    applies to the very next request;
//! 3. the path — normalized with the FileSpace grammar, inside one of the
//!    grant's paths (or an ancestor of one, which is a list-only virtual
//!    directory), never the sensitive-file floor;
//! 4. the mount — the conversation is active, the mount available, and its
//!    fingerprint the one the grant recorded (otherwise the grant goes
//!    `stale`, audited, and nothing is served);
//! 5. confinement on disk through `cognia-files` (canonical containment, no
//!    write through a symlinked final component).
//!
//! Every denial is audited. Allowed listings and transfers are audited by the
//! protocol layer once it knows the byte count ([`record_transfer`]).
//!
//! A credential's view of the FileSpace is its grant: the root lists only
//! the top segments of the granted paths, and an ancestor of a granted path is
//! a directory that contains only what leads to grants.

use std::collections::BTreeMap;
use std::path::PathBuf;

use crate::audit::{self, Channel, Event, Outcome};
use crate::model::{
    AssetEntry, Audience, Backing, CollabRole, Grant, GrantStatus, MountRecord, Permission, Protocol,
    SessionState,
};
use crate::paths;
use crate::policy::PolicySnapshot;
use crate::store::Store;

/// What a caller wants to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    List,
    Stat,
    Read,
    Write,
    Mkdir,
    Delete,
    Rename,
}

impl Op {
    pub fn action(self) -> &'static str {
        match self {
            Op::List => "fs.list",
            Op::Stat => "fs.stat",
            Op::Read => "fs.read",
            Op::Write => "fs.write",
            Op::Mkdir => "fs.mkdir",
            Op::Delete => "fs.delete",
            Op::Rename => "fs.rename",
        }
    }

    pub fn needs(self) -> Permission {
        match self {
            Op::List | Op::Stat => Permission::Read,
            Op::Read => Permission::Download,
            Op::Write | Op::Mkdir | Op::Delete | Op::Rename => Permission::Write,
        }
    }

    pub fn mutates(self) -> bool {
        self.needs() == Permission::Write
    }

    /// Whether the target must already exist.
    fn must_exist(self) -> bool {
        matches!(self, Op::List | Op::Stat | Op::Read | Op::Delete | Op::Rename)
    }
}

/// Who holds the access a caller presents.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Holder {
    /// A WebDAV/SFTP credential of a credential grant.
    Credential {
        credential_id: String,
        username: String,
        protocol: Protocol,
    },
    /// A member of a shared conversation, asking through a request the
    /// collaboration server relayed to this host's registration
    /// (`org_id`, `collab_session_id`). The server vouches for the user and
    /// role; the grant decides whether they are admitted.
    Member {
        org_id: String,
        collab_session_id: String,
        user_id: String,
        role: CollabRole,
    },
}

/// An authenticated caller.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Caller {
    pub grant_id: String,
    pub holder: Holder,
    pub channel: Channel,
    /// Client address (the `CF-Connecting-IP` behind a tunnel); none for a
    /// member, whose address only the collaboration server saw.
    pub remote: Option<String>,
}

impl Caller {
    pub fn principal(&self) -> String {
        match &self.holder {
            Holder::Credential { username, .. } => audit::credential_principal(username),
            Holder::Member { user_id, .. } => audit::member_principal(user_id),
        }
    }

    /// The credential's username, for a credential holder.
    pub fn username(&self) -> Option<&str> {
        match &self.holder {
            Holder::Credential { username, .. } => Some(username),
            Holder::Member { .. } => None,
        }
    }
}

/// Why an operation was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Denial {
    pub reason: &'static str,
    pub message: String,
}

impl Denial {
    fn new(reason: &'static str, message: impl Into<String>) -> Self {
        Self {
            reason,
            message: message.into(),
        }
    }

    /// Whether the client should see "no such file" rather than "forbidden".
    /// Paths outside the grant are reported as missing so a credential cannot
    /// probe for what exists beyond it.
    pub fn is_not_found(&self) -> bool {
        matches!(self.reason, "not_found" | "outside_grant")
    }
}

/// One name inside a virtual directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VirtualChild {
    pub name: String,
    pub is_dir: bool,
}

/// What an authorized path resolved to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    /// The credential's root, or an ancestor of granted paths.
    Virtual {
        path: String,
        children: Vec<VirtualChild>,
    },
    /// A file or directory on a disk mount.
    Disk {
        session_id: String,
        grant_id: String,
        path: String,
        mount_id: String,
        root: PathBuf,
        rel: String,
        abs: PathBuf,
    },
    /// A Dexie mount's directory.
    AssetDir {
        session_id: String,
        grant_id: String,
        path: String,
        mount_id: String,
        entries: Vec<AssetEntry>,
    },
    /// One Dexie-backed file.
    Asset {
        session_id: String,
        grant_id: String,
        path: String,
        mount_id: String,
        entry: AssetEntry,
    },
}

impl Target {
    pub fn path(&self) -> &str {
        match self {
            Target::Virtual { path, .. }
            | Target::Disk { path, .. }
            | Target::AssetDir { path, .. }
            | Target::Asset { path, .. } => path,
        }
    }

    pub fn session_id(&self) -> Option<&str> {
        match self {
            Target::Virtual { .. } => None,
            Target::Disk { session_id, .. }
            | Target::AssetDir { session_id, .. }
            | Target::Asset { session_id, .. } => Some(session_id),
        }
    }
}

/// What [`authorize`] reads.
pub struct Context<'a> {
    pub store: &'a Store,
    pub policy: &'a PolicySnapshot,
    pub now: i64,
}

/// Authorize `op` on `raw_path` for `caller`.
pub fn authorize(
    ctx: &Context<'_>,
    caller: &Caller,
    op: Op,
    raw_path: &str,
) -> Result<Target, Denial> {
    let mut session_for_audit: Option<String> = None;
    let result = authorize_inner(ctx, caller, op, raw_path, &mut session_for_audit);
    match &result {
        Err(denial) => {
            audit::record(
                ctx.store,
                ctx.now,
                Event {
                    session_id: session_for_audit.as_deref(),
                    grant_id: Some(&caller.grant_id),
                    principal: &caller.principal(),
                    channel: Some(caller.channel),
                    action: op.action(),
                    path: Some(raw_path),
                    outcome: Some(Outcome::Denied),
                    reason: Some(denial.reason),
                    remote: caller.remote.as_deref(),
                    ..Event::default()
                },
            );
        }
        Ok(target) if matches!(op, Op::Mkdir | Op::Delete | Op::Rename) => {
            // Mutations without a byte count are audited here; reads, writes
            // and listings by the protocol layer once they finish.
            record_transfer(ctx.store, ctx.now, caller, op, target, None, Outcome::Allowed, None);
        }
        Ok(_) => {}
    }
    result
}

fn authorize_inner(
    ctx: &Context<'_>,
    caller: &Caller,
    op: Op,
    raw_path: &str,
    session_for_audit: &mut Option<String>,
) -> Result<Target, Denial> {
    let path = paths::normalize(raw_path)
        .ok_or_else(|| Denial::new("invalid_path", format!("not a FileSpace path: {raw_path}")))?;
    let grant = load_live_grant(ctx, caller)?;
    *session_for_audit = Some(grant.session_id.clone());
    if !grant.allows(op.needs()) {
        return Err(Denial::new(
            "permission",
            format!("this share does not allow {}", op.needs().as_str()),
        ));
    }
    if let Holder::Member { role, .. } = &caller.holder {
        if op.mutates() && !role.may_write() {
            return Err(Denial::new("permission", "a viewer may not change files"));
        }
    }
    if let Some(reason) = ctx.policy.exceeded_by(&grant) {
        return Err(Denial::new(
            "policy",
            format!("the file-sharing policy no longer allows this grant ({reason})"),
        ));
    }

    // Inside a granted path?
    let covering = grant.paths.iter().find(|granted| {
        if granted.is_dir {
            paths::is_within(&path, &granted.virtual_path)
        } else {
            path == granted.virtual_path
        }
    });
    let Some(granted) = covering else {
        return virtual_target(&grant, op, path);
    };

    let mount = ctx
        .store
        .mount(&grant.session_id, &granted.mount_id)
        .map_err(|error| Denial::new("store", error.to_string()))?
        .ok_or_else(|| Denial::new("mount_unavailable", "the conversation's files were not synced"))?;
    match mount.session_state {
        SessionState::Active => {}
        SessionState::Archived => {
            return Err(Denial::new("session_archived", "the conversation is archived"))
        }
        SessionState::Deleted => {
            return Err(Denial::new("session_deleted", "the conversation was deleted"))
        }
    }
    if mount.fingerprint != granted.mount_fingerprint {
        mark_stale(ctx, &grant);
        return Err(Denial::new(
            "stale",
            "the shared folder now points somewhere else; share it again",
        ));
    }
    if mount.status != "available" {
        return Err(Denial::new(
            "mount_unavailable",
            format!("the shared folder is {}", mount.status),
        ));
    }
    let rel = paths::relative_to(&path, &mount.virtual_path)
        .ok_or_else(|| Denial::new("outside_grant", "path is outside its mount"))?
        .to_string();
    if is_sensitive_rel(&rel) {
        return Err(Denial::new(
            "sensitive",
            "credentials and keys are never served over a live share",
        ));
    }
    if op.mutates() && (rel == granted.rel_path) && matches!(op, Op::Delete | Op::Rename) {
        return Err(Denial::new(
            "grant_root",
            "the shared item itself cannot be deleted or renamed",
        ));
    }

    match mount.backing {
        Backing::Dexie => dexie_target(ctx, &grant, &mount, op, path, rel),
        Backing::Disk => disk_target(&grant, &mount, op, path, rel),
    }
}

fn load_live_grant(ctx: &Context<'_>, caller: &Caller) -> Result<Grant, Denial> {
    let grant = ctx
        .store
        .grant(&caller.grant_id)
        .map_err(|error| Denial::new("store", error.to_string()))?
        .ok_or_else(|| Denial::new("grant_inactive", "this share no longer exists"))?;
    if grant.status == GrantStatus::Active && grant.expires_at <= ctx.now {
        if let Ok(true) = ctx.store.set_grant_status(
            &grant.id,
            GrantStatus::Expired,
            Some(crate::model::status_reason::EXPIRED),
            ctx.now,
        ) {
            audit::record(
                ctx.store,
                ctx.now,
                Event {
                    session_id: Some(&grant.session_id),
                    grant_id: Some(&grant.id),
                    principal: "system",
                    action: "grant.expire",
                    ..Event::default()
                },
            );
        }
        return Err(Denial::new("grant_expired", "this share has expired"));
    }
    if grant.status != GrantStatus::Active {
        return Err(Denial::new(
            "grant_inactive",
            format!("this share is {}", grant.status.as_str()),
        ));
    }
    match (&caller.holder, &grant.audience) {
        (Holder::Credential { credential_id, .. }, Audience::Credentials) => {
            let credential = ctx
                .store
                .credential(credential_id)
                .map_err(|error| Denial::new("store", error.to_string()))?;
            match credential {
                Some(row) if row.view.revoked_at.is_none() && row.view.grant_id == grant.id => Ok(grant),
                _ => Err(Denial::new("credential_revoked", "this credential was revoked")),
            }
        }
        (
            Holder::Member {
                org_id,
                collab_session_id,
                user_id,
                role,
            },
            Audience::Collab {
                org_id: granted_org,
                collab_session_id: granted_session,
                user_ids,
                min_role,
            },
        ) => {
            let admitted = org_id == granted_org
                && collab_session_id == granted_session
                && role.rank() >= min_role.rank()
                && user_ids
                    .as_ref()
                    .is_none_or(|ids| ids.iter().any(|id| id == user_id));
            if admitted {
                Ok(grant)
            } else {
                Err(Denial::new("not_admitted", "this share is not for this member"))
            }
        }
        _ => Err(Denial::new("not_admitted", "this share is not for this kind of access")),
    }
}

fn mark_stale(ctx: &Context<'_>, grant: &Grant) {
    if let Ok(true) = ctx.store.set_grant_status(
        &grant.id,
        GrantStatus::Stale,
        Some(crate::model::status_reason::MOUNT_CHANGED),
        ctx.now,
    ) {
        audit::record(
            ctx.store,
            ctx.now,
            Event {
                session_id: Some(&grant.session_id),
                grant_id: Some(&grant.id),
                principal: "system",
                action: "grant.stale",
                reason: Some(crate::model::status_reason::MOUNT_CHANGED),
                ..Event::default()
            },
        );
    }
}

/// The root or an ancestor of granted paths: list-only, showing only what
/// leads to a grant.
fn virtual_target(grant: &Grant, op: Op, path: String) -> Result<Target, Denial> {
    let mut children: BTreeMap<String, bool> = BTreeMap::new();
    for granted in &grant.paths {
        let Some(rest) = paths::relative_to(&granted.virtual_path, &path) else {
            continue;
        };
        if rest.is_empty() {
            continue;
        }
        let (head, deeper) = match rest.split_once('/') {
            Some((head, _)) => (head, true),
            None => (rest, false),
        };
        let is_dir = deeper || granted.is_dir;
        children
            .entry(head.to_string())
            .and_modify(|existing| *existing |= is_dir)
            .or_insert(is_dir);
    }
    if children.is_empty() && path != "/" {
        return Err(Denial::new("outside_grant", "not part of this share"));
    }
    if !matches!(op, Op::List | Op::Stat) {
        return Err(if op.mutates() {
            Denial::new("read_only", "only shared items can be changed")
        } else {
            Denial::new("not_found", "not a file")
        });
    }
    Ok(Target::Virtual {
        path,
        children: children
            .into_iter()
            .map(|(name, is_dir)| VirtualChild { name, is_dir })
            .collect(),
    })
}

fn dexie_target(
    ctx: &Context<'_>,
    grant: &Grant,
    mount: &MountRecord,
    op: Op,
    path: String,
    rel: String,
) -> Result<Target, Denial> {
    if op.mutates() {
        return Err(Denial::new(
            "read_only",
            "uploads and artifacts are read-only over a live share",
        ));
    }
    if rel.is_empty() {
        if op == Op::Read {
            return Err(Denial::new("not_found", "a folder has no contents to read"));
        }
        let entries = ctx
            .store
            .assets(&grant.session_id, &mount.mount_id)
            .map_err(|error| Denial::new("store", error.to_string()))?
            .into_iter()
            .filter(|entry| !cognia_files::files::is_sensitive_workspace_file(&entry.name))
            .collect();
        return Ok(Target::AssetDir {
            session_id: grant.session_id.clone(),
            grant_id: grant.id.clone(),
            path,
            mount_id: mount.mount_id.clone(),
            entries,
        });
    }
    if rel.contains('/') {
        return Err(Denial::new("not_found", "no such file"));
    }
    let entry = ctx
        .store
        .asset(&grant.session_id, &mount.mount_id, &rel)
        .map_err(|error| Denial::new("store", error.to_string()))?
        .ok_or_else(|| Denial::new("not_found", "no such file"))?;
    if op == Op::List {
        return Err(Denial::new("not_found", "not a folder"));
    }
    Ok(Target::Asset {
        session_id: grant.session_id.clone(),
        grant_id: grant.id.clone(),
        path,
        mount_id: mount.mount_id.clone(),
        entry,
    })
}

fn disk_target(
    grant: &Grant,
    mount: &MountRecord,
    op: Op,
    path: String,
    rel: String,
) -> Result<Target, Denial> {
    if op.mutates() && !mount.writable {
        return Err(Denial::new("read_only", "this folder is read-only"));
    }
    let host = mount
        .host_path
        .as_deref()
        .ok_or_else(|| Denial::new("mount_unavailable", "the shared folder has no directory"))?;
    let (root, abs) = cognia_files::files::resolve_confined_workspace_path(host, &rel, op.must_exist())
        .map_err(|error| {
            if error.contains("escapes workspace") {
                Denial::new("outside_grant", "path is outside the shared folder")
            } else if op.must_exist() {
                Denial::new("not_found", "no such file or folder")
            } else {
                Denial::new("invalid_path", error)
            }
        })?;
    if op.mutates() {
        cognia_files::files::reject_symlinked_final_component(&abs)
            .map_err(|_| Denial::new("symlink", "refusing to change a file through a symlink"))?;
    }
    Ok(Target::Disk {
        session_id: grant.session_id.clone(),
        grant_id: grant.id.clone(),
        path,
        mount_id: mount.mount_id.clone(),
        root,
        rel,
        abs,
    })
}

/// The sensitive-file floor for a path inside a mount: credential files and
/// anything under a credential directory (`cognia-files`' rule), and also a
/// credential directory *itself* — `.git`, `.ssh` — which the per-segment
/// rule only catches as a parent. A file with such a name is refused too: a
/// worktree's `.git` is a file pointing at the repository's internals.
pub fn is_sensitive_rel(rel: &str) -> bool {
    if rel.is_empty() {
        return false;
    }
    if cognia_files::files::is_sensitive_workspace_path(rel) {
        return true;
    }
    let (parent, name) = match rel.rsplit_once('/') {
        Some((parent, name)) => (Some(parent.rsplit('/').next().unwrap_or(parent)), name),
        None => (None, rel),
    };
    cognia_files::files::is_sensitive_workspace_directory(parent, name)
}

/// Audit a finished listing or transfer (or a mutation `authorize` allowed).
#[allow(clippy::too_many_arguments)]
pub fn record_transfer(
    store: &Store,
    now: i64,
    caller: &Caller,
    op: Op,
    target: &Target,
    bytes: Option<i64>,
    outcome: Outcome,
    reason: Option<&str>,
) {
    audit::record(
        store,
        now,
        Event {
            session_id: target.session_id(),
            grant_id: Some(&caller.grant_id),
            principal: &caller.principal(),
            channel: Some(caller.channel),
            action: op.action(),
            path: Some(target.path()),
            bytes,
            outcome: Some(outcome),
            reason,
            remote: caller.remote.as_deref(),
        },
    );
}

/// One entry of a disk listing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiskEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified_ms: i64,
}

/// List a disk directory the gateway authorized, minus the sensitive floor
/// and minus symlinks that lead outside the mount.
pub fn list_disk_dir(root: &std::path::Path, rel: &str, abs: &std::path::Path) -> std::io::Result<Vec<DiskEntry>> {
    let root_str = root.to_string_lossy();
    let mut out = Vec::new();
    for entry in std::fs::read_dir(abs)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let child_rel = if rel.is_empty() {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };
        if paths::normalize(&format!("/{child_rel}")).as_deref() != Some(&format!("/{child_rel}")) {
            continue;
        }
        if is_sensitive_rel(&child_rel) {
            continue;
        }
        let Ok((_, resolved)) =
            cognia_files::files::resolve_confined_workspace_path(&root_str, &child_rel, true)
        else {
            continue;
        };
        let Ok(meta) = std::fs::metadata(&resolved) else {
            continue;
        };
        out.push(DiskEntry {
            name,
            is_dir: meta.is_dir(),
            size: if meta.is_dir() { 0 } else { meta.len() },
            modified_ms: modified_ms(&meta),
        });
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    Ok(out)
}

/// Milliseconds since the epoch a file was last modified (0 when unknown).
pub fn modified_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::model::{GrantPath, ProviderKind};
    use crate::mounts;
    use crate::policy::PolicyFields;
    use crate::store::tests::{sample_credential, sample_grant};

    pub(crate) struct Fixture {
        pub dir: tempfile::TempDir,
        pub store: Store,
        pub policy: PolicySnapshot,
        pub root: String,
    }

    pub(crate) fn open_policy() -> PolicySnapshot {
        PolicySnapshot {
            fields: PolicyFields {
                allow_protocol_credentials: true,
                allow_live_write: true,
                ..PolicyFields::default()
            },
            revision: 1,
            ..PolicySnapshot::default()
        }
    }

    pub(crate) fn fixture(permissions: Vec<Permission>, paths: Vec<(&str, &str, bool)>) -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let root_path = dir.path().join("repo");
        std::fs::create_dir_all(root_path.join("src/nested")).unwrap();
        std::fs::create_dir_all(root_path.join(".git")).unwrap();
        std::fs::write(root_path.join("src/a.txt"), "alpha").unwrap();
        std::fs::write(root_path.join("src/.env"), "SECRET=1").unwrap();
        std::fs::write(root_path.join("src/nested/b.txt"), "beta").unwrap();
        std::fs::write(root_path.join("README.md"), "readme").unwrap();
        std::fs::write(root_path.join(".git/config"), "[core]").unwrap();
        let root = root_path.canonicalize().unwrap().to_string_lossy().into_owned();
        let store = Store::open_in_memory().unwrap();
        let workspace = MountRecord {
            session_id: "s1".into(),
            mount_id: "workspace".into(),
            virtual_path: "/workspace".into(),
            backing: Backing::Disk,
            host_path: Some(root.clone()),
            writable: true,
            status: "available".into(),
            fingerprint: mounts::fingerprint("s1", "workspace", &root),
            session_state: SessionState::Active,
            updated_at: 1,
        };
        let uploads = MountRecord {
            mount_id: "uploads".into(),
            virtual_path: "/uploads".into(),
            backing: Backing::Dexie,
            host_path: None,
            writable: false,
            fingerprint: mounts::fingerprint("s1", "uploads", "dexie"),
            ..workspace.clone()
        };
        let assets = vec![
            AssetEntry {
                mount_id: "uploads".into(),
                name: "photo.png".into(),
                size: 5,
                media_type: "image/png".into(),
                modified_at: 9,
                source_id: "m-photo".into(),
            },
            AssetEntry {
                mount_id: "uploads".into(),
                name: "id_rsa".into(),
                size: 5,
                media_type: "text/plain".into(),
                modified_at: 9,
                source_id: "m-key".into(),
            },
        ];
        store
            .replace_session_mounts("s1", SessionState::Active, &[workspace.clone(), uploads.clone()], &assets, 1)
            .unwrap();
        let mut grant = sample_grant("fg_1", "s1");
        grant.permissions = permissions;
        grant.expires_at = i64::MAX / 2;
        grant.created_at = grant.expires_at - 3600 * 1000;
        grant.provider = ProviderKind::Builtin;
        grant.paths = paths
            .into_iter()
            .map(|(mount_id, rel, is_dir)| {
                let mount = if mount_id == "uploads" { &uploads } else { &workspace };
                GrantPath {
                    mount_id: mount_id.into(),
                    rel_path: rel.into(),
                    is_dir,
                    mount_fingerprint: mount.fingerprint.clone(),
                    virtual_path: paths::join(&mount.virtual_path, rel),
                }
            })
            .collect();
        store
            .insert_grant(&grant, &[sample_credential("fc_1", "fg_1", "cg-aaaaaaaaaa")])
            .unwrap();
        Fixture {
            dir,
            store,
            policy: open_policy(),
            root,
        }
    }

    pub(crate) fn caller() -> Caller {
        Caller {
            grant_id: "fg_1".into(),
            holder: Holder::Credential {
                credential_id: "fc_1".into(),
                username: "cg-aaaaaaaaaa".into(),
                protocol: Protocol::Webdav,
            },
            channel: Channel::Webdav,
            remote: Some("10.0.0.9".into()),
        }
    }

    pub(crate) fn member(user_id: &str, role: CollabRole) -> Caller {
        Caller {
            grant_id: "fg_1".into(),
            holder: Holder::Member {
                org_id: "org_1".into(),
                collab_session_id: "ses_1".into(),
                user_id: user_id.into(),
                role,
            },
            channel: Channel::Collab,
            remote: None,
        }
    }

    /// Make the fixture's grant a members' grant.
    pub(crate) fn for_members(f: &Fixture, user_ids: Option<Vec<&str>>, min_role: CollabRole) {
        let mut grant = f.store.grant("fg_1").unwrap().unwrap();
        grant.id = "fg_m".into();
        grant.protocols.clear();
        grant.audience = Audience::Collab {
            org_id: "org_1".into(),
            collab_session_id: "ses_1".into(),
            user_ids: user_ids.map(|ids| ids.into_iter().map(str::to_string).collect()),
            min_role,
        };
        f.store.revoke_credentials_for_grant("fg_1", 0).unwrap();
        f.store.set_grant_status("fg_1", GrantStatus::Revoked, Some("revoked"), 0).unwrap();
        f.store.insert_grant(&grant, &[]).unwrap();
    }

    fn ctx(f: &Fixture) -> Context<'_> {
        Context {
            store: &f.store,
            policy: &f.policy,
            now: 1_000,
        }
    }

    fn denial(f: &Fixture, op: Op, path: &str) -> &'static str {
        authorize(&ctx(f), &caller(), op, path).unwrap_err().reason
    }

    #[test]
    fn the_root_lists_only_what_leads_to_a_grant() {
        let f = fixture(
            vec![Permission::Read, Permission::Download],
            vec![("workspace", "src", true), ("uploads", "", true)],
        );
        let Target::Virtual { children, .. } = authorize(&ctx(&f), &caller(), Op::List, "/").unwrap()
        else {
            panic!("root is virtual");
        };
        assert_eq!(
            children,
            vec![
                VirtualChild { name: "uploads".into(), is_dir: true },
                VirtualChild { name: "workspace".into(), is_dir: true },
            ]
        );
        let Target::Virtual { children, .. } =
            authorize(&ctx(&f), &caller(), Op::List, "/workspace").unwrap()
        else {
            panic!("an ancestor is virtual");
        };
        assert_eq!(children, vec![VirtualChild { name: "src".into(), is_dir: true }]);
        // README.md is in the mount but not in the grant: it does not exist here.
        assert_eq!(denial(&f, Op::Read, "/workspace/README.md"), "outside_grant");
        assert!(Denial::new("outside_grant", "").is_not_found());
        // A read-only credential is refused any write before its path is looked at.
        assert_eq!(denial(&f, Op::Write, "/workspace/new.txt"), "permission");
        assert_eq!(denial(&f, Op::Read, "/"), "not_found");
    }

    #[test]
    fn a_granted_folder_resolves_on_disk_and_hides_the_sensitive_floor() {
        let f = fixture(vec![Permission::Read, Permission::Download], vec![("workspace", "src", true)]);
        let Target::Disk { root, rel, abs, .. } =
            authorize(&ctx(&f), &caller(), Op::List, "/workspace/src").unwrap()
        else {
            panic!("disk target");
        };
        assert_eq!(rel, "src");
        let names: Vec<String> = list_disk_dir(&root, &rel, &abs)
            .unwrap()
            .into_iter()
            .map(|entry| entry.name)
            .collect();
        assert_eq!(names, vec!["nested", "a.txt"], ".env stays hidden");
        assert!(authorize(&ctx(&f), &caller(), Op::Read, "/workspace/src/a.txt").is_ok());
        assert_eq!(denial(&f, Op::Read, "/workspace/src/.env"), "sensitive");
        assert_eq!(denial(&f, Op::Read, "/workspace/src/../README.md"), "invalid_path");
        assert_eq!(denial(&f, Op::Read, "/workspace/src/missing.txt"), "not_found");
    }

    #[test]
    fn a_whole_mount_grant_still_refuses_git_internals() {
        let f = fixture(vec![Permission::Read, Permission::Download], vec![("workspace", "", true)]);
        assert_eq!(denial(&f, Op::Read, "/workspace/.git/config"), "sensitive");
        let Target::Disk { root, rel, abs, .. } =
            authorize(&ctx(&f), &caller(), Op::List, "/workspace").unwrap()
        else {
            panic!("disk target");
        };
        let names: Vec<String> = list_disk_dir(&root, &rel, &abs)
            .unwrap()
            .into_iter()
            .map(|entry| entry.name)
            .collect();
        assert!(!names.contains(&".git".to_string()));
        assert!(names.contains(&"README.md".to_string()));
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_out_of_the_mount_are_neither_listed_nor_served() {
        let f = fixture(vec![Permission::Read, Permission::Download, Permission::Write], vec![("workspace", "", true)]);
        let outside = f.dir.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), "s").unwrap();
        std::os::unix::fs::symlink(&outside, std::path::Path::new(&f.root).join("link")).unwrap();
        std::os::unix::fs::symlink(
            std::path::Path::new(&f.root).join("README.md"),
            std::path::Path::new(&f.root).join("alias.md"),
        )
        .unwrap();
        assert_eq!(denial(&f, Op::Read, "/workspace/link/secret.txt"), "outside_grant");
        assert_eq!(denial(&f, Op::Write, "/workspace/link/new.txt"), "outside_grant");
        // An inside symlink reads, but nothing writes through it.
        assert!(authorize(&ctx(&f), &caller(), Op::Read, "/workspace/alias.md").is_ok());
        assert_eq!(denial(&f, Op::Write, "/workspace/alias.md"), "symlink");
        let Target::Disk { root, rel, abs, .. } =
            authorize(&ctx(&f), &caller(), Op::List, "/workspace").unwrap()
        else {
            panic!("disk target");
        };
        let names: Vec<String> = list_disk_dir(&root, &rel, &abs)
            .unwrap()
            .into_iter()
            .map(|entry| entry.name)
            .collect();
        assert!(!names.contains(&"link".to_string()));
        assert!(names.contains(&"alias.md".to_string()));
    }

    #[test]
    fn permissions_gate_bytes_and_mutations() {
        let f = fixture(vec![Permission::Read], vec![("workspace", "src", true)]);
        assert!(authorize(&ctx(&f), &caller(), Op::List, "/workspace/src").is_ok());
        assert_eq!(denial(&f, Op::Read, "/workspace/src/a.txt"), "permission");
        assert_eq!(denial(&f, Op::Write, "/workspace/src/a.txt"), "permission");

        let f = fixture(
            vec![Permission::Read, Permission::Download, Permission::Write],
            vec![("workspace", "src", true)],
        );
        assert!(authorize(&ctx(&f), &caller(), Op::Write, "/workspace/src/new.txt").is_ok());
        assert!(authorize(&ctx(&f), &caller(), Op::Mkdir, "/workspace/src/dir").is_ok());
        assert!(authorize(&ctx(&f), &caller(), Op::Delete, "/workspace/src/a.txt").is_ok());
        assert_eq!(denial(&f, Op::Delete, "/workspace/src"), "grant_root");
        assert_eq!(denial(&f, Op::Rename, "/workspace/src"), "grant_root");
        assert_eq!(denial(&f, Op::Write, "/workspace/src/.env"), "sensitive");
        let audit = f.store.list_audit(Some("s1"), None, None, 50).unwrap();
        assert!(audit.iter().any(|row| row.action == "fs.mkdir" && row.outcome == "allowed"));
        assert!(audit.iter().any(|row| row.reason.as_deref() == Some("grant_root")));
    }

    #[test]
    fn dexie_mounts_list_and_read_but_never_change() {
        let f = fixture(vec![Permission::Read, Permission::Download, Permission::Write], vec![("uploads", "", true)]);
        let Target::AssetDir { entries, .. } =
            authorize(&ctx(&f), &caller(), Op::List, "/uploads").unwrap()
        else {
            panic!("asset dir");
        };
        assert_eq!(
            entries.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(),
            vec!["photo.png"],
            "a key-shaped upload is hidden"
        );
        let Target::Asset { entry, .. } =
            authorize(&ctx(&f), &caller(), Op::Read, "/uploads/photo.png").unwrap()
        else {
            panic!("asset");
        };
        assert_eq!(entry.source_id, "m-photo");
        assert_eq!(denial(&f, Op::Read, "/uploads/id_rsa"), "sensitive");
        assert_eq!(denial(&f, Op::Write, "/uploads/new.txt"), "read_only");
        assert_eq!(denial(&f, Op::Read, "/uploads/missing.png"), "not_found");
        assert_eq!(denial(&f, Op::Read, "/uploads"), "not_found");
    }

    #[test]
    fn expiry_revocation_and_suspension_end_access() {
        let f = fixture(vec![Permission::Read], vec![("workspace", "src", true)]);
        let late = Context {
            store: &f.store,
            policy: &f.policy,
            now: i64::MAX / 2 + 1,
        };
        assert_eq!(
            authorize(&late, &caller(), Op::List, "/").unwrap_err().reason,
            "grant_expired"
        );
        assert_eq!(f.store.grant("fg_1").unwrap().unwrap().status, GrantStatus::Expired);
        assert_eq!(denial(&f, Op::List, "/"), "grant_inactive");

        let f = fixture(vec![Permission::Read], vec![("workspace", "src", true)]);
        f.store.revoke_credentials_for_grant("fg_1", 5).unwrap();
        assert_eq!(denial(&f, Op::List, "/"), "credential_revoked");

        let f = fixture(vec![Permission::Read], vec![("workspace", "src", true)]);
        f.store
            .set_grant_status("fg_1", GrantStatus::Suspended, Some("owner"), 5)
            .unwrap();
        assert_eq!(denial(&f, Op::List, "/"), "grant_inactive");
    }

    #[test]
    fn a_tightened_policy_applies_to_the_next_request() {
        let mut f = fixture(
            vec![Permission::Read, Permission::Download, Permission::Write],
            vec![("workspace", "src", true)],
        );
        f.policy.fields.allow_live_write = false;
        assert_eq!(denial(&f, Op::List, "/workspace/src"), "policy");
        f.policy = PolicySnapshot::default();
        assert_eq!(denial(&f, Op::List, "/workspace/src"), "policy");
    }

    #[test]
    fn a_retargeted_mount_makes_the_grant_stale() {
        let f = fixture(vec![Permission::Read], vec![("workspace", "src", true)]);
        let mut mounts = f.store.mounts_for_session("s1").unwrap();
        mounts[1].fingerprint = mounts::fingerprint("s1", "workspace", "/elsewhere");
        f.store.replace_session_mounts("s1", SessionState::Active, &mounts, &[], 1).unwrap();
        assert_eq!(denial(&f, Op::List, "/workspace/src"), "stale");
        let grant = f.store.grant("fg_1").unwrap().unwrap();
        assert_eq!(grant.status, GrantStatus::Stale);
        let audit = f.store.list_audit(None, Some("fg_1"), None, 10).unwrap();
        assert!(audit.iter().any(|row| row.action == "grant.stale"));
    }

    #[test]
    fn archived_deleted_and_unavailable_conversations_serve_nothing() {
        let f = fixture(vec![Permission::Read], vec![("workspace", "src", true)]);
        f.store.set_session_state("s1", SessionState::Archived, 5).unwrap();
        assert_eq!(denial(&f, Op::List, "/workspace/src"), "session_archived");
        f.store.set_session_state("s1", SessionState::Deleted, 6).unwrap();
        assert_eq!(denial(&f, Op::List, "/workspace/src"), "session_deleted");

        let f = fixture(vec![Permission::Read], vec![("workspace", "src", true)]);
        let mut mounts = f.store.mounts_for_session("s1").unwrap();
        for mount in &mut mounts {
            mount.status = "offline".into();
        }
        f.store.replace_session_mounts("s1", SessionState::Active, &mounts, &[], 1).unwrap();
        assert_eq!(denial(&f, Op::List, "/workspace/src"), "mount_unavailable");
    }

    #[test]
    fn writable_grants_still_cannot_write_outside_or_above_their_paths() {
        let f = fixture(
            vec![Permission::Read, Permission::Download, Permission::Write],
            vec![("workspace", "src", true)],
        );
        assert_eq!(denial(&f, Op::Write, "/workspace/new.txt"), "outside_grant");
        assert_eq!(denial(&f, Op::Mkdir, "/workspace"), "read_only");
        assert_eq!(denial(&f, Op::Write, "/new.txt"), "outside_grant");
    }

    #[test]
    fn credential_directories_themselves_are_on_the_floor() {
        assert!(is_sensitive_rel(".git"));
        assert!(is_sensitive_rel("pkg/.ssh"));
        assert!(is_sensitive_rel(".config/gh"));
        assert!(is_sensitive_rel("a/.git/config"));
        assert!(!is_sensitive_rel("src"));
        assert!(!is_sensitive_rel(""));
        assert!(!is_sensitive_rel(".env.example"));
    }

    #[test]
    fn a_granted_file_is_served_alone() {
        let f = fixture(vec![Permission::Read, Permission::Download], vec![("workspace", "README.md", false)]);
        let Target::Virtual { children, .. } =
            authorize(&ctx(&f), &caller(), Op::List, "/workspace").unwrap()
        else {
            panic!("virtual");
        };
        assert_eq!(children, vec![VirtualChild { name: "README.md".into(), is_dir: false }]);
        assert!(authorize(&ctx(&f), &caller(), Op::Read, "/workspace/README.md").is_ok());
        assert_eq!(denial(&f, Op::Read, "/workspace/README.md/x"), "outside_grant");
        assert_eq!(denial(&f, Op::Read, "/workspace/src/a.txt"), "outside_grant");
    }

    #[test]
    fn members_are_admitted_by_name_or_role_and_viewers_only_read() {
        let f = fixture(
            vec![Permission::Read, Permission::Download, Permission::Write],
            vec![("workspace", "src", true)],
        );
        for_members(&f, None, CollabRole::Viewer);
        let as_member = |user: &str, role: CollabRole| Caller {
            grant_id: "fg_m".into(),
            ..member(user, role)
        };
        assert!(authorize(&ctx(&f), &as_member("usr_v", CollabRole::Viewer), Op::Read, "/workspace/src/a.txt").is_ok());
        assert_eq!(
            authorize(&ctx(&f), &as_member("usr_v", CollabRole::Viewer), Op::Write, "/workspace/src/n.txt")
                .unwrap_err()
                .reason,
            "permission"
        );
        assert!(authorize(&ctx(&f), &as_member("usr_m", CollabRole::Member), Op::Write, "/workspace/src/n.txt").is_ok());
        // The floor and the grant's paths hold for members as for credentials.
        assert_eq!(
            authorize(&ctx(&f), &as_member("usr_m", CollabRole::Member), Op::Read, "/workspace/src/.env")
                .unwrap_err()
                .reason,
            "sensitive"
        );
        // Another registration's member is not admitted, nor is a credential.
        let elsewhere = Caller {
            holder: Holder::Member {
                org_id: "org_1".into(),
                collab_session_id: "ses_other".into(),
                user_id: "usr_m".into(),
                role: CollabRole::Owner,
            },
            ..as_member("usr_m", CollabRole::Owner)
        };
        assert_eq!(authorize(&ctx(&f), &elsewhere, Op::List, "/").unwrap_err().reason, "not_admitted");
        let credential = Caller {
            grant_id: "fg_m".into(),
            ..caller()
        };
        assert_eq!(authorize(&ctx(&f), &credential, Op::List, "/").unwrap_err().reason, "not_admitted");
        let rows = f.store.list_audit(Some("s1"), Some("fg_m"), None, 20).unwrap();
        assert!(rows.iter().any(|row| row.principal == "member:usr_v" && row.channel == "collab"));

        let f = fixture(vec![Permission::Read], vec![("workspace", "src", true)]);
        for_members(&f, Some(vec!["usr_a"]), CollabRole::Member);
        let named = |user: &str, role: CollabRole| Caller {
            grant_id: "fg_m".into(),
            ..member(user, role)
        };
        assert!(authorize(&ctx(&f), &named("usr_a", CollabRole::Member), Op::List, "/").is_ok());
        assert_eq!(
            authorize(&ctx(&f), &named("usr_b", CollabRole::Owner), Op::List, "/").unwrap_err().reason,
            "not_admitted"
        );
        assert_eq!(
            authorize(&ctx(&f), &named("usr_a", CollabRole::Viewer), Op::List, "/").unwrap_err().reason,
            "not_admitted",
            "a named member below the minimum role is not admitted"
        );
    }

    #[test]
    fn denials_are_audited_with_the_caller_and_reason() {
        let f = fixture(vec![Permission::Read], vec![("workspace", "src", true)]);
        let _ = authorize(&ctx(&f), &caller(), Op::Read, "/workspace/src/a.txt");
        let rows = f.store.list_audit(Some("s1"), None, None, 10).unwrap();
        let row = &rows[0];
        assert_eq!(row.principal, "credential:cg-aaaaaaaaaa");
        assert_eq!(row.channel, "webdav");
        assert_eq!(row.outcome, "denied");
        assert_eq!(row.reason.as_deref(), Some("permission"));
        assert_eq!(row.remote.as_deref(), Some("10.0.0.9"));
    }
}

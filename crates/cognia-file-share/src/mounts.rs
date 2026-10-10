//! Accepting a pushed mount table (ADR-0222 §7.2, §7.5).
//!
//! The WebView (desktop) or brain (headless) resolves a conversation's
//! FileSpace with `lib/filespace/resolve.ts` and pushes it with
//! `file_space_sync`. The host does not take it on trust:
//!
//! - mount ids and virtual paths must be the FileSpace's own shapes;
//! - a disk mount's directory must be one the host registered for workspace
//!   work (the injected [`RootValidator`]: active project roots and managed
//!   workspaces on desktop, the workspaces volume on a headless server), and
//!   is stored canonicalized — a mount the validator refuses is kept but
//!   marked `unregistered`, so nothing is served from it;
//! - Dexie mounts are read-only whatever was pushed.
//!
//! Each mount gets a fingerprint, `sha256(sessionId ‖ mountId ‖ canonical
//! root)`. A grant records it per path; when a later push changes it (the
//! conversation was rebound to another directory), the grant goes `stale`
//! instead of silently serving the new directory.

use std::collections::HashSet;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{FileShareError, FileShareResult};
use crate::model::{AssetEntry, Backing, MountRecord, SessionState};
use crate::paths;

/// Says whether a host directory may back a mount; returns it canonicalized.
pub type RootValidator = Arc<dyn Fn(&str) -> Result<String, String> + Send + Sync>;

/// A validator over a host predicate (the desktop's
/// `cognia_files::files::is_shareable_workspace_path`): the directory must
/// exist, and its canonical form must be one the host registered.
pub fn registered_root_validator(
    is_registered: impl Fn(&str) -> bool + Send + Sync + 'static,
) -> RootValidator {
    Arc::new(move |path: &str| {
        let canonical = std::path::Path::new(path)
            .canonicalize()
            .map_err(|error| format!("{path}: {error}"))?;
        let canonical = canonical.to_string_lossy().into_owned();
        if is_registered(&canonical) {
            Ok(canonical)
        } else {
            Err(format!("{canonical} is not a workspace this host registered"))
        }
    })
}

/// Status given to a disk mount whose directory the host refused.
pub const STATUS_UNREGISTERED: &str = "unregistered";

const MAX_MOUNTS: usize = 64;
const MAX_ASSETS: usize = 10_000;
const MAX_ID_LEN: usize = 512;

/// One conversation's mounts as pushed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMountsInput {
    pub session_id: String,
    pub state: SessionState,
    #[serde(default)]
    pub mounts: Vec<MountInput>,
    #[serde(default)]
    pub assets: Vec<AssetEntry>,
}

/// One mount as pushed (a projection of `FileSpaceMount`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MountInput {
    pub mount_id: String,
    pub virtual_path: String,
    pub backing: Backing,
    #[serde(default)]
    pub host_path: Option<String>,
    pub writable: bool,
    pub status: String,
}

/// Where the host pulls a conversation's mount table from when it needs it
/// fresh: the WebView (desktop) or the brain (headless), over the companion
/// bridge (`companion://filespace-mounts-request`). Pushing
/// (`file_space_sync`) keeps working; pulling is what lets a grant be created
/// from a paired device, which may not push, and what keeps a table current
/// without the app having to notice every change.
#[async_trait::async_trait]
pub trait MountSource: Send + Sync {
    async fn session_mounts(&self, session_id: &str) -> Result<SessionMountsInput, String>;
}

/// The source used before the host installs one: nothing to pull from, so
/// the pushed table is all there is.
pub struct UnavailableMountSource;

#[async_trait::async_trait]
impl MountSource for UnavailableMountSource {
    async fn session_mounts(&self, _session_id: &str) -> Result<SessionMountsInput, String> {
        Err("the app that holds this conversation is not connected".into())
    }
}

pub type SharedMountSource = Arc<dyn MountSource>;

/// The fingerprint of a mount bound to `root` (a canonical host path, or
/// `dexie` for a Dexie mount).
pub fn fingerprint(session_id: &str, mount_id: &str, root: &str) -> String {
    let mut hasher = Sha256::new();
    for part in [session_id, mount_id, root] {
        hasher.update(part.as_bytes());
        hasher.update([0]);
    }
    hex::encode(hasher.finalize())
}

fn mount_id_matches_path(mount_id: &str, virtual_path: &str) -> bool {
    match mount_id {
        "workspace" => virtual_path == "/workspace",
        "uploads" => virtual_path == "/uploads",
        "artifacts" => virtual_path == "/artifacts",
        other => other.strip_prefix("root:").is_some_and(|id| {
            !id.is_empty()
                && virtual_path
                    .strip_prefix("/roots/")
                    .is_some_and(|segment| !segment.is_empty() && !segment.contains('/'))
        }),
    }
}

/// Validate and canonicalize one pushed conversation.
pub fn prepare(
    input: &SessionMountsInput,
    validator: &RootValidator,
    now: i64,
) -> FileShareResult<(Vec<MountRecord>, Vec<AssetEntry>)> {
    let session_id = input.session_id.trim();
    if session_id.is_empty() || session_id.len() > MAX_ID_LEN {
        return Err(FileShareError::invalid("a session id is required"));
    }
    if input.mounts.len() > MAX_MOUNTS {
        return Err(FileShareError::invalid("too many mounts"));
    }
    if input.assets.len() > MAX_ASSETS {
        return Err(FileShareError::invalid("too many upload and artifact entries"));
    }
    let mut seen = HashSet::new();
    let mut dexie_mounts = HashSet::new();
    let mut records = Vec::with_capacity(input.mounts.len());
    for mount in &input.mounts {
        let virtual_path = paths::normalize(&mount.virtual_path)
            .filter(|normalized| normalized == &mount.virtual_path)
            .ok_or_else(|| {
                FileShareError::invalid(format!("not a FileSpace path: {}", mount.virtual_path))
            })?;
        if mount.mount_id.len() > MAX_ID_LEN
            || !mount_id_matches_path(&mount.mount_id, &virtual_path)
        {
            return Err(FileShareError::invalid(format!(
                "mount {} cannot live at {virtual_path}",
                mount.mount_id
            )));
        }
        if !seen.insert(mount.mount_id.clone()) {
            return Err(FileShareError::invalid(format!(
                "mount {} appears twice",
                mount.mount_id
            )));
        }
        let record = match mount.backing {
            Backing::Dexie => {
                if mount.host_path.is_some() {
                    return Err(FileShareError::invalid(
                        "a Dexie-backed mount has no host directory",
                    ));
                }
                dexie_mounts.insert(mount.mount_id.clone());
                MountRecord {
                    session_id: session_id.to_string(),
                    mount_id: mount.mount_id.clone(),
                    virtual_path,
                    backing: Backing::Dexie,
                    host_path: None,
                    writable: false,
                    status: mount.status.clone(),
                    fingerprint: fingerprint(session_id, &mount.mount_id, "dexie"),
                    session_state: input.state,
                    updated_at: now,
                }
            }
            Backing::Disk => {
                let (host_path, status) = match mount.host_path.as_deref() {
                    Some(raw) if !raw.trim().is_empty() => match validator(raw) {
                        Ok(canonical) => (Some(canonical), mount.status.clone()),
                        Err(reason) => {
                            log::warn!(
                                "file-share: mount {} of {session_id} refused: {reason}",
                                mount.mount_id
                            );
                            (Some(raw.to_string()), STATUS_UNREGISTERED.to_string())
                        }
                    },
                    _ => (None, mount.status.clone()),
                };
                let status = if status == "available" && host_path.is_none() {
                    "missing".to_string()
                } else {
                    status
                };
                let root = if status == STATUS_UNREGISTERED {
                    STATUS_UNREGISTERED
                } else {
                    host_path.as_deref().unwrap_or("")
                };
                MountRecord {
                    session_id: session_id.to_string(),
                    mount_id: mount.mount_id.clone(),
                    fingerprint: fingerprint(session_id, &mount.mount_id, root),
                    virtual_path,
                    backing: Backing::Disk,
                    host_path,
                    writable: mount.writable,
                    status,
                    session_state: input.state,
                    updated_at: now,
                }
            }
        };
        records.push(record);
    }
    let mut names = HashSet::new();
    let mut assets = Vec::with_capacity(input.assets.len());
    for asset in &input.assets {
        if !dexie_mounts.contains(&asset.mount_id) {
            return Err(FileShareError::invalid(format!(
                "entry {} names a mount that is not Dexie-backed",
                asset.name
            )));
        }
        let single = format!("/{}", asset.name);
        if asset.name.contains('/') || paths::normalize(&single).as_deref() != Some(&single) {
            return Err(FileShareError::invalid(format!(
                "not a file name: {}",
                asset.name
            )));
        }
        if !names.insert((asset.mount_id.clone(), asset.name.clone())) {
            return Err(FileShareError::invalid(format!(
                "entry {} appears twice",
                asset.name
            )));
        }
        if asset.source_id.is_empty() || asset.source_id.len() > MAX_ID_LEN {
            return Err(FileShareError::invalid("an entry needs its source id"));
        }
        assets.push(asset.clone());
    }
    Ok((records, assets))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn validator() -> RootValidator {
        Arc::new(|path: &str| {
            if path.starts_with("/repo") {
                Ok(path.trim_end_matches('/').to_string())
            } else {
                Err("not registered".to_string())
            }
        })
    }

    #[test]
    fn the_registered_validator_canonicalizes_then_asks_the_host() {
        let dir = tempfile::tempdir().unwrap();
        let canonical = dir.path().canonicalize().unwrap();
        let allowed = registered_root_validator(|path| !path.ends_with("refused"));
        // A trailing separator and a relative hop both resolve to the root.
        let spelled = format!("{}/.", dir.path().display());
        assert_eq!(allowed(&spelled).unwrap(), canonical.to_string_lossy());
        std::fs::create_dir(dir.path().join("refused")).unwrap();
        assert!(allowed(&dir.path().join("refused").to_string_lossy())
            .unwrap_err()
            .contains("not a workspace"));
        assert!(allowed(&dir.path().join("missing").to_string_lossy()).is_err());
    }

    fn disk(mount_id: &str, virtual_path: &str, host: Option<&str>) -> MountInput {
        MountInput {
            mount_id: mount_id.into(),
            virtual_path: virtual_path.into(),
            backing: Backing::Disk,
            host_path: host.map(str::to_string),
            writable: true,
            status: "available".into(),
        }
    }

    fn dexie(mount_id: &str) -> MountInput {
        MountInput {
            mount_id: mount_id.into(),
            virtual_path: format!("/{mount_id}"),
            backing: Backing::Dexie,
            host_path: None,
            writable: true,
            status: "available".into(),
        }
    }

    fn asset(mount_id: &str, name: &str) -> AssetEntry {
        AssetEntry {
            mount_id: mount_id.into(),
            name: name.into(),
            size: 1,
            media_type: "text/plain".into(),
            modified_at: 1,
            source_id: "m1".into(),
        }
    }

    fn input(mounts: Vec<MountInput>, assets: Vec<AssetEntry>) -> SessionMountsInput {
        SessionMountsInput {
            session_id: "s1".into(),
            state: SessionState::Active,
            mounts,
            assets,
        }
    }

    #[test]
    fn a_valid_table_is_canonicalized_and_fingerprinted() {
        let (mounts, assets) = prepare(
            &input(
                vec![
                    disk("workspace", "/workspace", Some("/repo/")),
                    disk("root:pkg", "/roots/pkg", Some("/repo/pkg")),
                    dexie("uploads"),
                ],
                vec![asset("uploads", "a.txt")],
            ),
            &validator(),
            7,
        )
        .unwrap();
        assert_eq!(mounts[0].host_path.as_deref(), Some("/repo"));
        assert_eq!(mounts[0].fingerprint, fingerprint("s1", "workspace", "/repo"));
        assert_eq!(mounts[2].fingerprint, fingerprint("s1", "uploads", "dexie"));
        assert!(!mounts[2].writable, "Dexie mounts are read-only");
        assert_eq!(assets.len(), 1);
        assert!(mounts.iter().all(|mount| mount.updated_at == 7));
    }

    #[test]
    fn a_retargeted_root_changes_the_fingerprint() {
        assert_ne!(
            fingerprint("s1", "workspace", "/repo"),
            fingerprint("s1", "workspace", "/repo-worktree")
        );
        assert_ne!(
            fingerprint("s1", "workspace", "/repo"),
            fingerprint("s2", "workspace", "/repo")
        );
    }

    #[test]
    fn an_unregistered_directory_is_kept_but_never_available() {
        let (mounts, _) = prepare(
            &input(vec![disk("workspace", "/workspace", Some("/etc"))], vec![]),
            &validator(),
            1,
        )
        .unwrap();
        assert_eq!(mounts[0].status, STATUS_UNREGISTERED);
        assert!(!mounts[0].is_available());
        assert_eq!(
            mounts[0].fingerprint,
            fingerprint("s1", "workspace", STATUS_UNREGISTERED)
        );
    }

    #[test]
    fn an_available_disk_mount_without_a_directory_is_missing() {
        let (mounts, _) = prepare(
            &input(vec![disk("workspace", "/workspace", None)], vec![]),
            &validator(),
            1,
        )
        .unwrap();
        assert_eq!(mounts[0].status, "missing");
    }

    #[test]
    fn malformed_tables_are_refused() {
        let v = validator();
        let cases = vec![
            input(vec![disk("workspace", "/uploads", Some("/repo"))], vec![]),
            input(vec![disk("root:", "/roots/", Some("/repo"))], vec![]),
            input(vec![disk("root:a", "/roots/a/b", Some("/repo"))], vec![]),
            input(vec![disk("workspace", "/workspace/", Some("/repo"))], vec![]),
            input(vec![disk("evil", "/evil", Some("/repo"))], vec![]),
            input(
                vec![
                    disk("workspace", "/workspace", Some("/repo")),
                    disk("workspace", "/workspace", Some("/repo")),
                ],
                vec![],
            ),
            input(
                vec![MountInput {
                    host_path: Some("/repo".into()),
                    ..dexie("uploads")
                }],
                vec![],
            ),
            input(
                vec![disk("workspace", "/workspace", Some("/repo"))],
                vec![asset("workspace", "a.txt")],
            ),
            input(vec![dexie("uploads")], vec![asset("uploads", "../a")]),
            input(vec![dexie("uploads")], vec![asset("uploads", "a/b")]),
            input(
                vec![dexie("uploads")],
                vec![asset("uploads", "a"), asset("uploads", "a")],
            ),
        ];
        for case in cases {
            assert!(prepare(&case, &v, 1).is_err(), "{case:?} must be refused");
        }
        let mut no_session = input(vec![], vec![]);
        no_session.session_id = " ".into();
        assert!(prepare(&no_session, &v, 1).is_err());
    }
}

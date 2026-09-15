//! Users and groups as the image defines them (`/etc/passwd`, `/etc/group`).
//!
//! Read from files rather than through NSS: the probe and the init process
//! are static musl binaries running inside someone else's image, so the host
//! libc's `getpwnam` would consult the wrong database, and there may be no
//! libc of ours to call at all.

use std::collections::BTreeSet;
use std::fmt;
use std::path::Path;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

use crate::rootfs;

/// The user the agent should run as, as the driver names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UserSpec {
    Name(String),
    Uid(u32),
}

impl FromStr for UserSpec {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let value = value.trim();
        if !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()) {
            let uid: u32 = value
                .parse()
                .map_err(|_| format!("uid {value} is out of range"))?;
            if uid > i32::MAX as u32 {
                return Err(format!("uid {value} is out of range"));
            }
            return Ok(UserSpec::Uid(uid));
        }
        if is_valid_user_name(value) {
            Ok(UserSpec::Name(value.to_string()))
        } else {
            Err(format!("{value:?} is not a user name or uid"))
        }
    }
}

impl fmt::Display for UserSpec {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            UserSpec::Name(name) => f.write_str(name),
            UserSpec::Uid(uid) => write!(f, "{uid}"),
        }
    }
}

/// POSIX-portable user names, as `cognia-environment`'s `spec.rs` accepts them.
pub fn is_valid_user_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 32
        && (bytes[0].is_ascii_lowercase() || bytes[0] == b'_')
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'_' | b'-'))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswdEntry {
    pub name: String,
    pub uid: u32,
    pub gid: u32,
    pub home: String,
    pub shell: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupEntry {
    pub name: String,
    pub gid: u32,
    pub members: Vec<String>,
}

/// Well-formed lines of a passwd file. Comments, blank and malformed lines are
/// skipped, as libc's parser skips them.
pub fn parse_passwd(text: &str) -> Vec<PasswdEntry> {
    text.lines()
        .filter(|line| !line.trim().is_empty() && !line.starts_with('#'))
        .filter_map(|line| {
            let fields: Vec<&str> = line.split(':').collect();
            if fields.len() != 7 || fields[0].is_empty() {
                return None;
            }
            Some(PasswdEntry {
                name: fields[0].to_string(),
                uid: fields[2].parse().ok()?,
                gid: fields[3].parse().ok()?,
                home: fields[5].to_string(),
                shell: fields[6].to_string(),
            })
        })
        .collect()
}

pub fn parse_group(text: &str) -> Vec<GroupEntry> {
    text.lines()
        .filter(|line| !line.trim().is_empty() && !line.starts_with('#'))
        .filter_map(|line| {
            let fields: Vec<&str> = line.split(':').collect();
            if fields.len() != 4 || fields[0].is_empty() {
                return None;
            }
            Some(GroupEntry {
                name: fields[0].to_string(),
                gid: fields[2].parse().ok()?,
                members: fields[3]
                    .split(',')
                    .map(str::trim)
                    .filter(|member| !member.is_empty())
                    .map(str::to_string)
                    .collect(),
            })
        })
        .collect()
}

/// The user an agent will run as, with everything `setgroups`/`setgid`/`setuid`
/// need already resolved.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedUser {
    /// Absent for a numeric uid the image has no passwd entry for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub uid: u32,
    pub gid: u32,
    /// Supplementary groups, the primary gid included, sorted.
    pub groups: Vec<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub home: Option<String>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum UserError {
    #[error("user {0} does not exist in the image")]
    Missing(String),
}

/// Looks `spec` up in the image under `root`.
///
/// A name must exist: nothing else says which uid it means. A bare uid need
/// not — Kubernetes' `runAsUser` and Docker's `--user 10001` both run fine
/// without a passwd entry — and gets itself as its primary group.
pub fn resolve_user(root: &Path, spec: &UserSpec) -> Result<ResolvedUser, UserError> {
    let passwd = read_image_file(root, "/etc/passwd")
        .map(|text| parse_passwd(&text))
        .unwrap_or_default();
    let groups = read_image_file(root, "/etc/group")
        .map(|text| parse_group(&text))
        .unwrap_or_default();

    let entry = match spec {
        UserSpec::Name(name) => Some(
            passwd
                .iter()
                .find(|entry| &entry.name == name)
                .ok_or_else(|| UserError::Missing(name.clone()))?,
        ),
        UserSpec::Uid(uid) => passwd.iter().find(|entry| entry.uid == *uid),
    };

    let Some(entry) = entry else {
        let UserSpec::Uid(uid) = spec else {
            unreachable!("a missing name returned above")
        };
        return Ok(ResolvedUser {
            name: None,
            uid: *uid,
            gid: *uid,
            groups: vec![*uid],
            home: None,
        });
    };

    let mut supplementary = BTreeSet::from([entry.gid]);
    for group in &groups {
        if group.members.iter().any(|member| member == &entry.name) {
            supplementary.insert(group.gid);
        }
    }
    Ok(ResolvedUser {
        name: Some(entry.name.clone()),
        uid: entry.uid,
        gid: entry.gid,
        groups: supplementary.into_iter().collect(),
        home: (!entry.home.is_empty()).then(|| entry.home.clone()),
    })
}

/// `user` running as the owner of the workspace, the way the devcontainer CLI's
/// `updateRemoteUserUID` rewrites a remote user whose uid differs from the
/// person whose files it will edit (ADR-0183 "Which user the agent runs as").
///
/// The name, home and supplementary groups are kept; the uid becomes the
/// owner's and the primary gid is swapped for the owner's gid. `None` when
/// nothing changes, and when the owner is root: remapping a declared user to
/// uid 0 would hand the agent more than the declaration asked for, so the
/// caller keeps the declared uid and the workspace check refuses instead.
pub fn remap_to_owner(user: &ResolvedUser, owner_uid: u32, owner_gid: u32) -> Option<ResolvedUser> {
    if owner_uid == 0 || (user.uid == owner_uid && user.gid == owner_gid) {
        return None;
    }
    let mut groups: BTreeSet<u32> = user
        .groups
        .iter()
        .copied()
        .filter(|gid| *gid != user.gid)
        .collect();
    groups.insert(owner_gid);
    Some(ResolvedUser {
        name: user.name.clone(),
        uid: owner_uid,
        gid: owner_gid,
        groups: groups.into_iter().collect(),
        home: user.home.clone(),
    })
}

fn read_image_file(root: &Path, path: &str) -> Option<String> {
    let host = rootfs::resolve(root, path).ok()?;
    std::fs::read_to_string(host).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const PASSWD: &str = "\
root:x:0:0:root:/root:/bin/bash
# a comment
daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin
broken line
node:x:1000:1000::/home/node:/bin/bash
vscode:x:1001:1001:,,,:/home/vscode:/bin/zsh
nohome:x:1002:1002:::/bin/sh
";
    const GROUP: &str = "\
root:x:0:
docker:x:998:vscode,node
wheel:x:10: vscode
node:x:1000:
bad:x:notanumber:vscode
";

    fn image() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("etc")).unwrap();
        std::fs::write(dir.path().join("etc/passwd"), PASSWD).unwrap();
        std::fs::write(dir.path().join("etc/group"), GROUP).unwrap();
        dir
    }

    #[test]
    fn parses_user_specs() {
        assert_eq!("node".parse(), Ok(UserSpec::Name("node".into())));
        assert_eq!("10001".parse(), Ok(UserSpec::Uid(10001)));
        assert!("node:node".parse::<UserSpec>().is_err());
        assert!("Node".parse::<UserSpec>().is_err());
        assert!("4294967295".parse::<UserSpec>().is_err());
        assert!("".parse::<UserSpec>().is_err());
    }

    #[test]
    fn skips_comments_and_malformed_lines() {
        let entries = parse_passwd(PASSWD);
        assert_eq!(
            entries
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            ["root", "daemon", "node", "vscode", "nohome"]
        );
        assert_eq!(parse_group(GROUP).len(), 4);
    }

    #[test]
    fn resolves_names_with_their_supplementary_groups() {
        let dir = image();
        assert_eq!(
            resolve_user(dir.path(), &UserSpec::Name("vscode".into())).unwrap(),
            ResolvedUser {
                name: Some("vscode".into()),
                uid: 1001,
                gid: 1001,
                groups: vec![10, 998, 1001],
                home: Some("/home/vscode".into()),
            }
        );
        assert_eq!(
            resolve_user(dir.path(), &UserSpec::Uid(0)).unwrap().name,
            Some("root".into())
        );
        assert_eq!(
            resolve_user(dir.path(), &UserSpec::Name("nohome".into()))
                .unwrap()
                .home,
            None
        );
    }

    #[test]
    fn a_missing_name_is_an_error_but_a_bare_uid_is_not() {
        let dir = image();
        assert_eq!(
            resolve_user(dir.path(), &UserSpec::Name("app".into())),
            Err(UserError::Missing("app".into()))
        );
        assert_eq!(
            resolve_user(dir.path(), &UserSpec::Uid(10001)).unwrap(),
            ResolvedUser {
                name: None,
                uid: 10001,
                gid: 10001,
                groups: vec![10001],
                home: None,
            }
        );
        // An image with no passwd file at all (distroless-style).
        let empty = tempfile::tempdir().unwrap();
        assert!(resolve_user(empty.path(), &UserSpec::Uid(0)).is_ok());
        assert!(resolve_user(empty.path(), &UserSpec::Name("root".into())).is_err());
    }

    #[test]
    fn remaps_a_user_onto_the_workspace_owner_but_never_onto_root() {
        let dir = image();
        let vscode = resolve_user(dir.path(), &UserSpec::Name("vscode".into())).unwrap();

        let remapped = remap_to_owner(&vscode, 10001, 10001).unwrap();
        assert_eq!(remapped.name.as_deref(), Some("vscode"));
        assert_eq!(remapped.home.as_deref(), Some("/home/vscode"));
        assert_eq!((remapped.uid, remapped.gid), (10001, 10001));
        // The old primary group is gone; docker and wheel memberships stay.
        assert_eq!(remapped.groups, vec![10, 998, 10001]);

        assert_eq!(remap_to_owner(&vscode, 1001, 1001), None);
        assert_eq!(remap_to_owner(&vscode, 0, 0), None);
        // Same uid, different primary group: still a remap, of the gid alone.
        assert_eq!(
            remap_to_owner(&vscode, 1001, 50).unwrap().groups,
            vec![10, 50, 998]
        );
    }
}

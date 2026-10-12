//! Where a project's work happens on an always-on host (ADR-0224 A11).
//!
//! A project names its folders as its owner's device sees them
//! (`/Users/me/repo`), and since A11 the repository those folders check out.
//! On the host the folders usually do not exist, so the host works in a clone
//! of the repository instead: supplied through the shared mirror cache
//! ([`crate::remote_source`], ADR-0176) with the git credential a paired
//! device stored for that git host (ADR-0224 A6).
//!
//! The order is fixed: a folder that exists on this host wins (a project
//! created on the host, or a host that shares the disk), then the clone, and
//! a project with neither is an error the caller reports rather than a guess
//! at some other directory.
//!
//! A project's remote reaches here from another device, so it is held to the
//! rule the desktop applies when it records one: https, and no credential in
//! the URL. A token travels only as the host's stored credential.

use std::fmt;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::remote_source::{EnsureRemoteSource, RemoteSourceCheckout};
use crate::types::WorkspaceBaseSpec;

/// Resolve the directory a project's work runs in on this host.
#[derive(Clone, Default, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct EnsureProjectSource {
    /// The project's folders, primary first, as its owner's device recorded
    /// them.
    #[serde(default)]
    pub roots: Vec<String>,
    /// Its repository remote: credential-free https.
    #[serde(default)]
    pub remote_url: Option<String>,
    /// A token for the clone; when absent the host's stored git credential
    /// for the remote's host is used.
    #[serde(default, skip_serializing)]
    pub credential: Option<String>,
}

impl fmt::Debug for EnsureProjectSource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("EnsureProjectSource")
            .field("roots", &self.roots)
            .field("remote_url", &self.remote_url)
            .field(
                "credential",
                &self.credential.as_ref().map(|_| "<redacted>"),
            )
            .finish()
    }
}

/// Where the root came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ProjectSourceKind {
    /// One of the project's own folders exists on this host.
    Local,
    /// A clone of the project's repository.
    Clone,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(transform = cognia_problem::wire_schema::closed_object)]
pub struct ProjectSource {
    /// The directory to work in.
    pub root: String,
    pub source: ProjectSourceKind,
    /// The folder of the project's own this root stands in for, when it is a
    /// clone: paths under that folder map to the same paths under `root`.
    pub stands_for: Option<String>,
    /// The repository cloned, when it is a clone.
    pub remote_url: Option<String>,
}

/// A project remote another device may hand this host: https, with a host,
/// and nothing that could carry a credential or reach git as an option.
pub fn validate_project_remote(raw: &str) -> Result<String, String> {
    let remote = raw.trim();
    let refuse = |why: &str| Err(format!("project_remote_refused: {why}"));
    let Some(rest) = remote.strip_prefix("https://") else {
        return refuse("only https repository remotes are cloned on a host");
    };
    if remote
        .chars()
        .any(|ch| ch.is_whitespace() || ch.is_control())
    {
        return refuse("the remote contains whitespace or control characters");
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if authority.contains('@') {
        return refuse("the remote carries a credential");
    }
    let host = authority.split(':').next().unwrap_or_default();
    if host.is_empty() || host.starts_with('-') || host.starts_with('.') {
        return refuse("the remote names no host");
    }
    let path = &rest[authority.len()..];
    if path.trim_matches('/').is_empty() {
        return refuse("the remote names no repository");
    }
    Ok(remote.to_string())
}

/// The first of `roots` that is a directory on this machine.
pub fn local_project_root(roots: &[String]) -> Option<String> {
    roots
        .iter()
        .map(|root| root.trim())
        .filter(|root| !root.is_empty())
        .find(|root| Path::new(root).is_absolute() && Path::new(root).is_dir())
        .map(str::to_string)
}

/// Resolve the project's root, cloning through `supply` when none of its
/// folders exists here.
pub fn ensure_project_source(
    input: &EnsureProjectSource,
    supply: impl FnOnce(EnsureRemoteSource) -> Result<RemoteSourceCheckout, String>,
) -> Result<ProjectSource, String> {
    if let Some(root) = local_project_root(&input.roots) {
        return Ok(ProjectSource {
            root,
            source: ProjectSourceKind::Local,
            stands_for: None,
            remote_url: None,
        });
    }
    let remote = input
        .remote_url
        .as_deref()
        .map(str::trim)
        .filter(|remote| !remote.is_empty())
        .ok_or(
            "project_source_unavailable: none of this project's folders exists on this host, \
             and it names no repository to clone",
        )?;
    let remote = validate_project_remote(remote)?;
    let checkout = supply(EnsureRemoteSource {
        remote_url: remote.clone(),
        base: WorkspaceBaseSpec::RemoteDefault,
        credential: input.credential.clone(),
    })?;
    Ok(ProjectSource {
        root: checkout.source_root,
        source: ProjectSourceKind::Clone,
        stands_for: input
            .roots
            .iter()
            .map(|root| root.trim())
            .find(|root| !root.is_empty())
            .map(str::to_string),
        remote_url: Some(remote),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn checkout(root: &str) -> RemoteSourceCheckout {
        RemoteSourceCheckout {
            source_root: root.to_string(),
            resolved_ref: None,
            mirror_path: "/mirrors/x".to_string(),
        }
    }

    #[test]
    fn only_a_credential_free_https_remote_is_cloned() {
        assert_eq!(
            validate_project_remote(" https://github.com/acme/app.git ").unwrap(),
            "https://github.com/acme/app.git"
        );
        assert!(validate_project_remote("https://git.example.com:8443/team/app").is_ok());
        for refused in [
            "git@github.com:acme/app.git",
            "ssh://git@github.com/acme/app.git",
            "http://github.com/acme/app.git",
            "file:///srv/app",
            "/srv/app",
            "https://token@github.com/acme/app.git",
            "https://user:pass@github.com/acme/app.git",
            "https://github.com",
            "https:///acme/app",
            "https://-oProxyCommand=x/app",
            "https://github.com/acme/app\n.git",
            "--upload-pack=x",
        ] {
            assert!(validate_project_remote(refused).is_err(), "{refused}");
        }
    }

    #[test]
    fn a_folder_that_exists_here_wins_over_a_clone() {
        let tmp = tempfile::tempdir().unwrap();
        let here = tmp.path().display().to_string();
        let input = EnsureProjectSource {
            roots: vec!["/Users/someone-else/app".into(), here.clone()],
            remote_url: Some("https://github.com/acme/app.git".into()),
            credential: None,
        };
        let source = ensure_project_source(&input, |_| panic!("no clone")).unwrap();
        assert_eq!(source.root, here);
        assert_eq!(source.source, ProjectSourceKind::Local);
        assert_eq!(source.stands_for, None);
        // A relative path is never a folder of this host's.
        assert_eq!(local_project_root(&["relative/dir".into()]), None);
    }

    #[test]
    fn a_project_without_its_folders_is_cloned_from_its_remote() {
        let input = EnsureProjectSource {
            roots: vec!["/Users/me/app".into(), "/Users/me/docs".into()],
            remote_url: Some("https://github.com/acme/app.git".into()),
            credential: Some("token".into()),
        };
        let source = ensure_project_source(&input, |request| {
            assert_eq!(request.remote_url, "https://github.com/acme/app.git");
            assert_eq!(request.base, WorkspaceBaseSpec::RemoteDefault);
            assert_eq!(request.credential.as_deref(), Some("token"));
            Ok(checkout(
                "/data/task-workspaces/sources/github.com/acme/app",
            ))
        })
        .unwrap();
        assert_eq!(source.source, ProjectSourceKind::Clone);
        assert_eq!(
            source.root,
            "/data/task-workspaces/sources/github.com/acme/app"
        );
        assert_eq!(source.stands_for.as_deref(), Some("/Users/me/app"));
        assert_eq!(
            source.remote_url.as_deref(),
            Some("https://github.com/acme/app.git")
        );
    }

    #[test]
    fn neither_a_folder_nor_a_usable_remote_is_an_error() {
        let missing = EnsureProjectSource {
            roots: vec!["/Users/me/app".into()],
            ..EnsureProjectSource::default()
        };
        assert!(ensure_project_source(&missing, |_| panic!("no clone"))
            .unwrap_err()
            .contains("project_source_unavailable"));
        let ssh = EnsureProjectSource {
            roots: vec!["/Users/me/app".into()],
            remote_url: Some("git@github.com:acme/app.git".into()),
            credential: None,
        };
        assert!(ensure_project_source(&ssh, |_| panic!("no clone"))
            .unwrap_err()
            .contains("project_remote_refused"));
        let failing = EnsureProjectSource {
            roots: Vec::new(),
            remote_url: Some("https://github.com/acme/app.git".into()),
            credential: None,
        };
        assert_eq!(
            ensure_project_source(&failing, |_| Err("could not supply a mirror".into()))
                .unwrap_err(),
            "could not supply a mirror"
        );
    }

    #[test]
    fn an_answer_names_every_field_null_or_not() {
        let local = ProjectSource {
            root: "/srv/app".into(),
            source: ProjectSourceKind::Local,
            stands_for: None,
            remote_url: None,
        };
        assert_eq!(
            serde_json::to_value(local).unwrap(),
            serde_json::json!({ "root": "/srv/app", "source": "local", "standsFor": null, "remoteUrl": null })
        );
    }

    #[test]
    fn the_credential_is_never_printed_or_sent_back() {
        let input = EnsureProjectSource {
            roots: Vec::new(),
            remote_url: None,
            credential: Some("secret-token".into()),
        };
        assert!(!format!("{input:?}").contains("secret-token"));
        assert!(!serde_json::to_string(&input)
            .unwrap()
            .contains("secret-token"));
    }
}

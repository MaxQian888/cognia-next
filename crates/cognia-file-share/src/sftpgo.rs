//! The SFTPGo provider (ADR-0222 §7.4).
//!
//! For headless deployments where an SFTPGo service sees the same workspaces
//! volume, a credential can be served by SFTPGo instead of the built-in
//! listeners. Cognia stays the authority: it creates one SFTPGo user per
//! credential, with
//!
//! - a password SFTPGo receives once and hashes itself (Cognia keeps none);
//! - an expiration date equal to the grant's;
//! - one virtual folder per granted path, mapped through the configured
//!   `{hostPrefix → sftpgoPrefix}` list (SFTPGo usually mounts the volume at a
//!   different path). A path no mapping covers — or any upload/artifact, which
//!   lives in the app's database, not on the volume — fails closed with
//!   `sftpgo_path_unmapped`;
//! - per-folder permissions (`list,download`, plus upload/overwrite/delete/
//!   rename/create_dirs for write grants) and a root that only lists;
//! - the sensitive-file floor as denied, hidden name patterns;
//! - only the protocol the credential was issued for.
//!
//! Suspending disables the user, resuming enables it, revoking deletes it and
//! its folders and closes its open connections. A call that fails is queued
//! and retried by maintenance; the grant's local state never waits on SFTPGo.
//!
//! SFTPGo is AGPL-3.0 and is deployed as its own unmodified service
//! (`deploy/compose/compose.sftpgo.yaml`); nothing of it is bundled here.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use schemars::JsonSchema;
use serde_json::{json, Value};

use crate::error::{FileShareError, FileShareResult};
use crate::listener::{Endpoints, SftpEndpoint, SECRET_SERVICE};
use crate::model::{Grant, GrantPath, MountRecord, Permission, Protocol};
use crate::paths;

/// Settings key of the stored [`SftpgoConfig`].
pub const SETTINGS_KEY: &str = "sftpgo";
/// Secret-store account of the admin API key.
pub const API_KEY_ACCOUNT: &str = "sftpgo-admin";

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// One host-to-SFTPGo path prefix translation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PathMapping {
    /// Absolute path prefix as this host sees it (`/srv/cognia/workspaces`).
    pub host_prefix: String,
    /// The same directory as SFTPGo sees it (`/srv/sftpgo/workspaces`).
    pub sftpgo_prefix: String,
}

/// The stored provider settings (the API key lives in the secret store).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SftpgoConfig {
    /// SFTPGo's HTTP base, e.g. `http://sftpgo:8080`.
    pub base_url: String,
    /// Directory SFTPGo creates per-credential home directories under.
    pub home_base: String,
    pub path_mappings: Vec<PathMapping>,
    /// What clients dial, for the result card.
    #[serde(default)]
    pub public_sftp_host: Option<String>,
    #[serde(default)]
    pub public_sftp_port: Option<u16>,
    #[serde(default)]
    pub public_webdav_url: Option<String>,
}

/// What the settings surface sends.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpgoConfigInput {
    #[serde(flatten)]
    pub config: SftpgoConfig,
    /// The admin API key: absent keeps the stored one.
    #[serde(default)]
    pub api_key: Option<String>,
}

/// The provider as the settings surface shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SftpgoStatus {
    pub configured: bool,
    pub config: Option<SftpgoConfig>,
    pub api_key_set: bool,
    pub healthy: Option<bool>,
    pub error: Option<String>,
    /// Where SFTPGo-served credentials dial, as a grant's card would show it.
    pub endpoints: Endpoints,
}

/// The endpoints SFTPGo-served credentials get, or why there are none.
pub fn endpoints_for(config: Option<&SftpgoConfig>) -> Endpoints {
    match config {
        Some(config) => config.endpoints(),
        None => Endpoints {
            unavailable_reason: Some("sftpgo_unconfigured".into()),
            ..Endpoints::default()
        },
    }
}

fn is_absolute_posix(path: &str) -> bool {
    path.starts_with('/') && !path.split('/').any(|segment| segment == "..")
}

impl SftpgoConfig {
    pub fn validate(&self) -> FileShareResult<()> {
        let url = reqwest::Url::parse(&self.base_url)
            .map_err(|_| FileShareError::invalid("SFTPGo's address is not a URL"))?;
        if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
            return Err(FileShareError::invalid("SFTPGo's address must be http(s)"));
        }
        if !is_absolute_posix(&self.home_base) {
            return Err(FileShareError::invalid(
                "the home directory base must be an absolute path",
            ));
        }
        if self.path_mappings.is_empty() {
            return Err(FileShareError::invalid(
                "add at least one path mapping so SFTPGo can find the workspaces",
            ));
        }
        for mapping in &self.path_mappings {
            if !is_absolute_posix(&mapping.host_prefix) || !is_absolute_posix(&mapping.sftpgo_prefix) {
                return Err(FileShareError::invalid(
                    "path mappings must be absolute paths",
                ));
            }
        }
        if let Some(url) = &self.public_webdav_url {
            reqwest::Url::parse(url)
                .map_err(|_| FileShareError::invalid("the public WebDAV address is not a URL"))?;
        }
        Ok(())
    }

    /// Translate a host path, longest prefix first.
    pub fn map_path(&self, host_path: &str) -> Option<String> {
        let host_path = host_path.trim_end_matches('/');
        self.path_mappings
            .iter()
            .filter_map(|mapping| {
                let prefix = mapping.host_prefix.trim_end_matches('/');
                let rest = host_path.strip_prefix(prefix)?;
                (rest.is_empty() || rest.starts_with('/')).then(|| {
                    (
                        prefix.len(),
                        format!("{}{rest}", mapping.sftpgo_prefix.trim_end_matches('/')),
                    )
                })
            })
            .max_by_key(|(len, _)| *len)
            .map(|(_, mapped)| mapped)
    }

    /// The endpoints the result card shows for an SFTPGo credential.
    pub fn endpoints(&self) -> Endpoints {
        let webdav_urls: Vec<String> = self.public_webdav_url.iter().cloned().collect();
        let sftp: Vec<SftpEndpoint> = self
            .public_sftp_host
            .iter()
            .map(|host| SftpEndpoint {
                host: host.clone(),
                port: self.public_sftp_port.unwrap_or(2022),
            })
            .collect();
        // Without a public address the users exist but nobody is told where
        // to dial; say so rather than offer an empty card.
        let unavailable_reason = (webdav_urls.is_empty() && sftp.is_empty())
            .then(|| "sftpgo_no_public_endpoint".to_string());
        Endpoints {
            webdav_urls,
            sftp,
            unavailable_reason,
            ..Endpoints::default()
        }
    }
}

/// One virtual folder of an SFTPGo user.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FolderPlan {
    pub name: String,
    pub mapped_path: String,
    pub virtual_path: String,
    /// For a granted file: the only name visible in its (parent) folder.
    pub only_file: Option<String>,
}

/// Plan the folders of one credential's SFTPGo user, or refuse the grant.
pub fn plan_folders(
    config: &SftpgoConfig,
    username: &str,
    grant: &Grant,
    mounts: &[MountRecord],
) -> FileShareResult<Vec<FolderPlan>> {
    let mut plans = Vec::with_capacity(grant.paths.len());
    for (index, path) in grant.paths.iter().enumerate() {
        plans.push(plan_folder(config, username, index, path, mounts)?);
    }
    Ok(plans)
}

fn plan_folder(
    config: &SftpgoConfig,
    username: &str,
    index: usize,
    path: &GrantPath,
    mounts: &[MountRecord],
) -> FileShareResult<FolderPlan> {
    let unmapped = || {
        FileShareError::new(
            "sftpgo_path_unmapped",
            format!("SFTPGo cannot see {}", path.virtual_path),
        )
    };
    let mount = mounts
        .iter()
        .find(|mount| mount.mount_id == path.mount_id)
        .ok_or_else(unmapped)?;
    let host = mount.host_path.as_deref().ok_or_else(unmapped)?;
    let (dir_rel, only_file) = if path.is_dir {
        (path.rel_path.clone(), None)
    } else {
        let (parent, name) = match path.rel_path.rsplit_once('/') {
            Some((parent, name)) => (parent.to_string(), name.to_string()),
            None => (String::new(), path.rel_path.clone()),
        };
        (parent, Some(name))
    };
    let host_dir = if dir_rel.is_empty() {
        host.to_string()
    } else {
        format!("{}/{dir_rel}", host.trim_end_matches('/'))
    };
    let mapped_path = config.map_path(&host_dir).ok_or_else(unmapped)?;
    let virtual_path = if path.is_dir {
        path.virtual_path.clone()
    } else {
        paths::parent(&path.virtual_path).to_string()
    };
    Ok(FolderPlan {
        name: format!("{username}-{index}"),
        mapped_path,
        virtual_path,
        only_file,
    })
}

/// The sensitive floor as SFTPGo name patterns (case-insensitive there too).
pub fn sensitive_patterns() -> Vec<String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Floor {
        file_names: Vec<String>,
        extensions: Vec<String>,
        directories: Vec<String>,
    }
    let floor: Floor = serde_json::from_str(include_str!(
        "../../cognia-files/fixtures/sensitive-paths.json"
    ))
    .expect("the sensitive floor fixture parses");
    let mut patterns: Vec<String> = Vec::new();
    patterns.extend(floor.file_names.iter().cloned());
    // `.env.*` also hides `.env.example`: SFTPGo patterns have no exception
    // syntax, and over-hiding a template is the safe side.
    patterns.push(".env.*".into());
    patterns.push("id_*".into());
    patterns.extend(floor.extensions.iter().map(|ext| format!("*.{ext}")));
    patterns.extend(floor.directories.iter().cloned());
    patterns.sort();
    patterns.dedup();
    patterns
}

fn folder_permissions(write: bool) -> Vec<&'static str> {
    let mut permissions = vec!["list", "download"];
    if write {
        permissions.extend(["upload", "overwrite", "delete", "rename", "create_dirs"]);
    }
    permissions
}

/// The JSON SFTPGo's `POST /api/v2/users` takes for one credential.
#[allow(clippy::too_many_arguments)]
pub fn user_body(
    config: &SftpgoConfig,
    username: &str,
    password: Option<&str>,
    ssh_public_key: Option<&str>,
    protocol: Protocol,
    grant: &Grant,
    folders: &[FolderPlan],
    enabled: bool,
) -> Value {
    let write = grant.allows(Permission::Write);
    let mut permissions = serde_json::Map::new();
    permissions.insert("/".into(), json!(["list"]));
    let mut patterns = vec![json!({
        "path": "/",
        "denied_patterns": sensitive_patterns(),
        "deny_policy": 1,
    })];
    for folder in folders {
        permissions.insert(folder.virtual_path.clone(), json!(folder_permissions(write)));
        if let Some(name) = &folder.only_file {
            patterns.push(json!({
                "path": folder.virtual_path,
                "allowed_patterns": [name],
                "denied_patterns": sensitive_patterns(),
                "deny_policy": 1,
            }));
        }
    }
    // A credential speaks one protocol; everything else is denied.
    let denied_protocols: Vec<&str> = match protocol {
        Protocol::Sftp => vec!["FTP", "DAV", "HTTP"],
        Protocol::Webdav => vec!["SSH", "FTP", "HTTP"],
    };
    let mut body = json!({
        "status": if enabled { 1 } else { 0 },
        "username": username,
        "description": format!("Cognia live share {} ({})", grant.id, grant.session_id),
        "expiration_date": grant.expires_at,
        "home_dir": format!("{}/{username}", config.home_base.trim_end_matches('/')),
        "permissions": permissions,
        "virtual_folders": folders.iter().map(|folder| json!({
            "name": folder.name,
            "virtual_path": folder.virtual_path,
            "quota_size": -1,
            "quota_files": -1,
        })).collect::<Vec<_>>(),
        "filters": {
            "denied_protocols": denied_protocols,
            "file_patterns": patterns,
        },
    });
    if let Some(password) = password {
        body["password"] = json!(password);
    }
    if let Some(key) = ssh_public_key {
        body["public_keys"] = json!([key]);
    }
    body
}

/// The JSON SFTPGo's `POST /api/v2/folders` takes.
pub fn folder_body(folder: &FolderPlan) -> Value {
    json!({
        "name": folder.name,
        "mapped_path": folder.mapped_path,
        "filesystem": { "provider": 0 },
    })
}

/// A thin client over SFTPGo's admin REST API.
pub struct Client {
    base: String,
    api_key: String,
}

impl Client {
    pub fn new(config: &SftpgoConfig, api_key: String) -> Self {
        Self {
            base: config.base_url.trim_end_matches('/').to_string(),
            api_key,
        }
    }

    fn http(&self) -> FileShareResult<reqwest::Client> {
        cognia_net::proxy_config::managed_client(
            reqwest::Client::builder().timeout(REQUEST_TIMEOUT),
            &self.base,
        )
        .map_err(|error| FileShareError::new("provider_failed", error.to_string()))
    }

    async fn send(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<&Value>,
    ) -> FileShareResult<(reqwest::StatusCode, Value)> {
        let mut request = self
            .http()?
            .request(method, format!("{}{path}", self.base))
            .header("X-SFTPGO-API-KEY", &self.api_key);
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request
            .send()
            .await
            .map_err(|error| FileShareError::new("provider_failed", format!("SFTPGo unreachable: {error}")))?;
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        let value = serde_json::from_str(&text).unwrap_or(Value::String(text));
        Ok((status, value))
    }

    fn check(status: reqwest::StatusCode, body: &Value, what: &str) -> FileShareResult<()> {
        if status.is_success() {
            Ok(())
        } else {
            let detail = body
                .get("error")
                .or_else(|| body.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("");
            Err(FileShareError::new(
                "provider_failed",
                format!("SFTPGo {what} failed ({status}) {detail}").trim().to_string(),
            ))
        }
    }

    /// `GET /healthz` (unauthenticated on SFTPGo's side).
    pub async fn health(&self) -> FileShareResult<()> {
        let (status, body) = self.send(reqwest::Method::GET, "/healthz", None).await?;
        Self::check(status, &body, "health check")
    }

    pub async fn create_folder(&self, folder: &FolderPlan) -> FileShareResult<()> {
        let (status, body) = self
            .send(reqwest::Method::POST, "/api/v2/folders", Some(&folder_body(folder)))
            .await?;
        Self::check(status, &body, "folder create")
    }

    pub async fn delete_folder(&self, name: &str) -> FileShareResult<()> {
        let (status, body) = self
            .send(reqwest::Method::DELETE, &format!("/api/v2/folders/{}", encode(name)), None)
            .await?;
        if status == reqwest::StatusCode::NOT_FOUND {
            return Ok(());
        }
        Self::check(status, &body, "folder delete")
    }

    pub async fn create_user(&self, user: &Value) -> FileShareResult<()> {
        let (status, body) = self.send(reqwest::Method::POST, "/api/v2/users", Some(user)).await?;
        Self::check(status, &body, "user create")
    }

    async fn get_user(&self, username: &str) -> FileShareResult<Option<Value>> {
        let (status, body) = self
            .send(reqwest::Method::GET, &format!("/api/v2/users/{}", encode(username)), None)
            .await?;
        if status == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        Self::check(status, &body, "user read")?;
        Ok(Some(body))
    }

    async fn put_user(&self, username: &str, user: &Value) -> FileShareResult<()> {
        let (status, body) = self
            .send(reqwest::Method::PUT, &format!("/api/v2/users/{}", encode(username)), Some(user))
            .await?;
        Self::check(status, &body, "user update")
    }

    /// Enable or disable a user, keeping everything else.
    pub async fn set_enabled(&self, username: &str, enabled: bool) -> FileShareResult<()> {
        let Some(mut user) = self.get_user(username).await? else {
            return Err(FileShareError::new("provider_failed", format!("SFTPGo has no user {username}")));
        };
        user["status"] = json!(if enabled { 1 } else { 0 });
        self.put_user(username, &user).await?;
        if !enabled {
            self.close_connections(username).await?;
        }
        Ok(())
    }

    /// Replace a user's password, keeping everything else.
    pub async fn set_password(&self, username: &str, password: &str) -> FileShareResult<()> {
        let Some(mut user) = self.get_user(username).await? else {
            return Err(FileShareError::new("provider_failed", format!("SFTPGo has no user {username}")));
        };
        user["password"] = json!(password);
        self.put_user(username, &user).await?;
        self.close_connections(username).await
    }

    /// Delete a user and its folders, closing its open sessions first.
    pub async fn delete_user(&self, username: &str, folders: &[String]) -> FileShareResult<()> {
        self.close_connections(username).await?;
        let (status, body) = self
            .send(reqwest::Method::DELETE, &format!("/api/v2/users/{}", encode(username)), None)
            .await?;
        if status != reqwest::StatusCode::NOT_FOUND {
            Self::check(status, &body, "user delete")?;
        }
        for folder in folders {
            self.delete_folder(folder).await?;
        }
        Ok(())
    }

    /// Close every live session of `username`.
    pub async fn close_connections(&self, username: &str) -> FileShareResult<()> {
        let (status, body) = self.send(reqwest::Method::GET, "/api/v2/connections", None).await?;
        Self::check(status, &body, "connection listing")?;
        let ids: Vec<String> = body
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter(|item| item.get("username").and_then(Value::as_str) == Some(username))
                    .filter_map(|item| item.get("connection_id").and_then(Value::as_str).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        for id in ids {
            let (status, body) = self
                .send(reqwest::Method::DELETE, &format!("/api/v2/connections/{}", encode(&id)), None)
                .await?;
            if status != reqwest::StatusCode::NOT_FOUND {
                Self::check(status, &body, "connection close")?;
            }
        }
        Ok(())
    }
}

fn encode(segment: &str) -> String {
    segment
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

/// The stored admin API key.
pub fn api_key() -> FileShareResult<Option<String>> {
    cognia_secrets::secret_store::get(SECRET_SERVICE, API_KEY_ACCOUNT)
        .map_err(|error| FileShareError::new("secret_store_unavailable", error))
}

pub fn set_api_key(value: Option<&str>) -> FileShareResult<()> {
    match value.map(str::trim) {
        Some(key) if !key.is_empty() => cognia_secrets::secret_store::set(SECRET_SERVICE, API_KEY_ACCOUNT, key),
        _ => cognia_secrets::secret_store::delete(SECRET_SERVICE, API_KEY_ACCOUNT),
    }
    .map_err(|error| FileShareError::new("secret_store_unavailable", error))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::model::{Backing, SessionState};
    use crate::store::tests::sample_grant;
    use std::sync::Arc;

    pub(crate) fn config(base_url: &str) -> SftpgoConfig {
        SftpgoConfig {
            base_url: base_url.into(),
            home_base: "/srv/sftpgo/homes".into(),
            path_mappings: vec![
                PathMapping {
                    host_prefix: "/data/workspaces".into(),
                    sftpgo_prefix: "/srv/sftpgo/workspaces".into(),
                },
                PathMapping {
                    host_prefix: "/data/workspaces/special".into(),
                    sftpgo_prefix: "/mnt/special".into(),
                },
            ],
            public_sftp_host: Some("files.example.com".into()),
            public_sftp_port: Some(2022),
            public_webdav_url: Some("https://files.example.com/dav/".into()),
        }
    }

    fn mount(mount_id: &str, host: Option<&str>, backing: Backing) -> MountRecord {
        MountRecord {
            session_id: "s1".into(),
            mount_id: mount_id.into(),
            virtual_path: if mount_id == "workspace" { "/workspace".into() } else { format!("/{mount_id}") },
            backing,
            host_path: host.map(str::to_string),
            writable: true,
            status: "available".into(),
            fingerprint: "fp".into(),
            session_state: SessionState::Active,
            updated_at: 1,
        }
    }

    #[test]
    fn configuration_is_validated_and_paths_map_by_longest_prefix() {
        let cfg = config("http://sftpgo:8080");
        assert!(cfg.validate().is_ok());
        assert_eq!(cfg.map_path("/data/workspaces/p1"), Some("/srv/sftpgo/workspaces/p1".into()));
        assert_eq!(cfg.map_path("/data/workspaces/special/x"), Some("/mnt/special/x".into()));
        assert_eq!(cfg.map_path("/data/workspaces"), Some("/srv/sftpgo/workspaces".into()));
        assert_eq!(cfg.map_path("/data/workspacesX"), None);
        assert_eq!(cfg.map_path("/elsewhere"), None);
        for bad in [
            SftpgoConfig { base_url: "ftp://x".into(), ..cfg.clone() },
            SftpgoConfig { home_base: "relative".into(), ..cfg.clone() },
            SftpgoConfig { path_mappings: vec![], ..cfg.clone() },
            SftpgoConfig {
                path_mappings: vec![PathMapping { host_prefix: "/a/../b".into(), sftpgo_prefix: "/c".into() }],
                ..cfg.clone()
            },
        ] {
            assert!(bad.validate().is_err());
        }
        let endpoints = cfg.endpoints();
        assert_eq!(endpoints.webdav_urls, vec!["https://files.example.com/dav/"]);
        assert_eq!(endpoints.sftp[0].port, 2022);
        assert!(endpoints.unavailable_reason.is_none());
        let hidden = SftpgoConfig { public_sftp_host: None, public_webdav_url: None, ..cfg.clone() };
        assert_eq!(
            hidden.endpoints().unavailable_reason.as_deref(),
            Some("sftpgo_no_public_endpoint")
        );
        assert_eq!(endpoints_for(Some(&cfg)), cfg.endpoints());
        assert_eq!(endpoints_for(None).unavailable_reason.as_deref(), Some("sftpgo_unconfigured"));
    }

    #[test]
    fn folders_follow_the_grant_and_unmapped_paths_fail_closed() {
        let cfg = config("http://sftpgo:8080");
        let mut grant = sample_grant("fg_1", "s1");
        grant.paths = vec![
            GrantPath { mount_id: "workspace".into(), rel_path: "src".into(), is_dir: true, mount_fingerprint: "fp".into(), virtual_path: "/workspace/src".into() },
            GrantPath { mount_id: "workspace".into(), rel_path: "docs/a.md".into(), is_dir: false, mount_fingerprint: "fp".into(), virtual_path: "/workspace/docs/a.md".into() },
        ];
        let mounts = vec![mount("workspace", Some("/data/workspaces/p1"), Backing::Disk)];
        let plans = plan_folders(&cfg, "cg-abc", &grant, &mounts).unwrap();
        assert_eq!(plans[0], FolderPlan {
            name: "cg-abc-0".into(),
            mapped_path: "/srv/sftpgo/workspaces/p1/src".into(),
            virtual_path: "/workspace/src".into(),
            only_file: None,
        });
        assert_eq!(plans[1].mapped_path, "/srv/sftpgo/workspaces/p1/docs");
        assert_eq!(plans[1].virtual_path, "/workspace/docs");
        assert_eq!(plans[1].only_file.as_deref(), Some("a.md"));

        let outside = vec![mount("workspace", Some("/home/me/repo"), Backing::Disk)];
        assert_eq!(plan_folders(&cfg, "cg-abc", &grant, &outside).unwrap_err().code, "sftpgo_path_unmapped");
        grant.paths = vec![GrantPath { mount_id: "uploads".into(), rel_path: "".into(), is_dir: true, mount_fingerprint: "fp".into(), virtual_path: "/uploads".into() }];
        let dexie = vec![mount("uploads", None, Backing::Dexie)];
        assert_eq!(plan_folders(&cfg, "cg-abc", &grant, &dexie).unwrap_err().code, "sftpgo_path_unmapped");
    }

    #[test]
    fn a_user_body_carries_expiry_permissions_floor_and_one_protocol() {
        let cfg = config("http://sftpgo:8080");
        let mut grant = sample_grant("fg_1", "s1");
        grant.permissions.push(Permission::Write);
        let folders = vec![
            FolderPlan { name: "cg-abc-0".into(), mapped_path: "/m/src".into(), virtual_path: "/workspace/src".into(), only_file: None },
            FolderPlan { name: "cg-abc-1".into(), mapped_path: "/m/docs".into(), virtual_path: "/workspace/docs".into(), only_file: Some("a.md".into()) },
        ];
        let body = user_body(&cfg, "cg-abc", Some("pw"), Some("ssh-ed25519 AAAA k"), Protocol::Sftp, &grant, &folders, true);
        assert_eq!(body["status"], 1);
        assert_eq!(body["expiration_date"], grant.expires_at);
        assert_eq!(body["home_dir"], "/srv/sftpgo/homes/cg-abc");
        assert_eq!(body["permissions"]["/"], json!(["list"]));
        assert!(body["permissions"]["/workspace/src"].as_array().unwrap().contains(&json!("upload")));
        assert_eq!(body["filters"]["denied_protocols"], json!(["FTP", "DAV", "HTTP"]));
        assert_eq!(body["password"], "pw");
        assert_eq!(body["public_keys"], json!(["ssh-ed25519 AAAA k"]));
        let patterns = body["filters"]["file_patterns"].as_array().unwrap();
        assert!(patterns[0]["denied_patterns"].as_array().unwrap().contains(&json!(".env")));
        assert_eq!(patterns[1]["allowed_patterns"], json!(["a.md"]));
        let read_only = sample_grant("fg_2", "s1");
        let body = user_body(&cfg, "cg-x", None, None, Protocol::Webdav, &read_only, &folders, false);
        assert_eq!(body["status"], 0);
        assert!(body.get("password").is_none());
        assert_eq!(body["permissions"]["/workspace/src"], json!(["list", "download"]));
        assert_eq!(body["filters"]["denied_protocols"], json!(["SSH", "FTP", "HTTP"]));
    }

    #[test]
    fn the_floor_patterns_cover_names_extensions_and_directories() {
        let patterns = sensitive_patterns();
        for expected in [".env", ".env.*", "id_*", "*.pem", ".git", ".ssh", ".netrc"] {
            assert!(patterns.contains(&expected.to_string()), "{expected}");
        }
    }

    /// A recording stand-in for SFTPGo's admin API.
    #[derive(Default)]
    pub(crate) struct MockSftpgo {
        pub requests: parking_lot::Mutex<Vec<(String, String, Value)>>,
        pub users: parking_lot::Mutex<std::collections::HashMap<String, Value>>,
        pub fail: std::sync::atomic::AtomicBool,
    }

    pub(crate) async fn serve_mock(mock: Arc<MockSftpgo>) -> String {
        use axum::extract::State;
        use axum::http::{HeaderMap, Method, StatusCode};
        use axum::routing::any;
        async fn handle(
            State(mock): State<Arc<MockSftpgo>>,
            method: Method,
            headers: HeaderMap,
            uri: axum::http::Uri,
            body: axum::body::Bytes,
        ) -> (StatusCode, axum::Json<Value>) {
            let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
            mock.requests.lock().push((method.to_string(), uri.path().to_string(), body.clone()));
            if uri.path() != "/healthz" && headers.get("x-sftpgo-api-key").and_then(|v| v.to_str().ok()) != Some("key") {
                return (StatusCode::UNAUTHORIZED, axum::Json(json!({"error": "bad key"})));
            }
            if mock.fail.load(std::sync::atomic::Ordering::SeqCst) {
                return (StatusCode::INTERNAL_SERVER_ERROR, axum::Json(json!({"error": "down"})));
            }
            let path = uri.path();
            match (method.as_str(), path) {
                ("GET", "/healthz") => (StatusCode::OK, axum::Json(json!("ok"))),
                ("POST", "/api/v2/folders") => (StatusCode::CREATED, axum::Json(body)),
                ("POST", "/api/v2/users") => {
                    let name = body["username"].as_str().unwrap_or_default().to_string();
                    mock.users.lock().insert(name, body.clone());
                    (StatusCode::CREATED, axum::Json(body))
                }
                ("GET", "/api/v2/connections") => (StatusCode::OK, axum::Json(json!([
                    {"username": "cg-live", "connection_id": "SFTP_1"},
                    {"username": "someone", "connection_id": "SFTP_2"}
                ]))),
                ("DELETE", p) if p.starts_with("/api/v2/connections/") => (StatusCode::OK, axum::Json(json!({}))),
                (m, p) if p.starts_with("/api/v2/users/") => {
                    let name = p.trim_start_matches("/api/v2/users/").to_string();
                    let mut users = mock.users.lock();
                    match m {
                        "GET" => match users.get(&name) {
                            Some(user) => {
                                let mut user = user.clone();
                                user.as_object_mut().unwrap().remove("password");
                                (StatusCode::OK, axum::Json(user))
                            }
                            None => (StatusCode::NOT_FOUND, axum::Json(json!({"error": "not found"}))),
                        },
                        "PUT" => { users.insert(name, body.clone()); (StatusCode::OK, axum::Json(json!({}))) }
                        "DELETE" => match users.remove(&name) {
                            Some(_) => (StatusCode::OK, axum::Json(json!({}))),
                            None => (StatusCode::NOT_FOUND, axum::Json(json!({}))),
                        },
                        _ => (StatusCode::METHOD_NOT_ALLOWED, axum::Json(json!({}))),
                    }
                }
                (_, p) if p.starts_with("/api/v2/folders/") => (StatusCode::OK, axum::Json(json!({}))),
                _ => (StatusCode::NOT_FOUND, axum::Json(json!({}))),
            }
        }
        let app = axum::Router::new()
            .fallback(any(handle))
            .with_state(mock);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn the_client_speaks_sftpgo_rest() {
        let _ = cognia_net::proxy_config::apply_current(cognia_net::proxy_config::ProxyConfig::default());
        let mock = Arc::new(MockSftpgo::default());
        let base = serve_mock(mock.clone()).await;
        let client = Client::new(&config(&base), "key".into());
        client.health().await.unwrap();
        let folder = FolderPlan { name: "cg-live-0".into(), mapped_path: "/m".into(), virtual_path: "/workspace".into(), only_file: None };
        client.create_folder(&folder).await.unwrap();
        client.create_user(&json!({"username": "cg-live", "status": 1, "password": "pw"})).await.unwrap();
        client.set_enabled("cg-live", false).await.unwrap();
        assert_eq!(mock.users.lock()["cg-live"]["status"], 0);
        client.set_password("cg-live", "new").await.unwrap();
        assert_eq!(mock.users.lock()["cg-live"]["password"], "new");
        client.delete_user("cg-live", &["cg-live-0".into()]).await.unwrap();
        assert!(mock.users.lock().is_empty());
        let requests = mock.requests.lock().clone();
        let closes: Vec<_> = requests
            .iter()
            .filter(|(m, p, _)| m == "DELETE" && p.starts_with("/api/v2/connections/"))
            .map(|(_, p, _)| p.clone())
            .collect();
        assert!(closes.iter().all(|p| p.ends_with("SFTP_1")), "only the user's own sessions close: {closes:?}");
        assert!(requests.iter().any(|(m, p, _)| m == "DELETE" && p == "/api/v2/folders/cg-live-0"));

        // Deleting what is already gone is fine; a refused key is an error.
        client.delete_user("cg-gone", &[]).await.unwrap();
        let wrong = Client::new(&config(&base), "nope".into());
        assert_eq!(wrong.create_user(&json!({})).await.unwrap_err().code, "provider_failed");
    }
}

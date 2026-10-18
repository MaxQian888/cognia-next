//! Host-owned remote desktop targets (ADR-0234 §1). The JSON file holds only
//! non-secret configuration and the pinned endpoint the user confirmed;
//! credentials live in the Host secret store and are never written here.

use crate::{
    console::ConsoleProfile,
    error::{RemoteDesktopError, Result},
    launch::AppLaunch,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs::{self, File},
    io::{Read, Write},
    net::IpAddr,
    path::{Path, PathBuf},
};

pub const STORE_FILE: &str = "remote-desktop-targets.json";
pub const MAX_TARGETS: usize = 256;
pub const MAX_BINDINGS: usize = 8;
pub const MAX_CONFIG_BYTES: usize = 64 * 1024;
const MAX_STORE_BYTES: u64 = 8 * 1024 * 1024;
const STORE_VERSION: u32 = 1;

/// The Host handshake adapter a binding uses (ADR-0234 §4). Closed list:
/// plugins choose one, they never supply protocol code.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Adapter {
    Vnc,
    None,
}

/// How a client reaches the machine (ADR-0234 Phase 5).
///
/// - `bridge`: the Host connects and bridges the protocol (VNC, raw TCP).
/// - `web-console`: the client opens the user's own Guacamole or MeshCentral
///   page; the provider authenticates and authorizes.
/// - `external-app`: the client hands an ID to a local app (RustDesk).
///
/// Only `bridge` has sessions, a lease or credentials; the others are
/// "permissions managed by the provider".
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Access {
    #[default]
    Bridge,
    WebConsole,
    ExternalApp,
}

impl Access {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Bridge => "bridge",
            Self::WebConsole => "web-console",
            Self::ExternalApp => "external-app",
        }
    }
}

/// A web console binding's page, normalized by [`crate::console::parse`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WebConsole {
    pub url: String,
    pub profile: ConsoleProfile,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EndpointClass {
    Private,
    Public,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Endpoint {
    pub host: String,
    pub port: u16,
    /// The only address the bridge dials. Re-resolution never moves it.
    pub pinned_ip: IpAddr,
    pub class: EndpointClass,
    pub confirmed_at: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    pub id: String,
    pub provider_id: String,
    /// Absent in Phase 2 files, which only had bridged bindings.
    #[serde(default)]
    pub access: Access,
    pub adapter: Adapter,
    pub priority: u32,
    pub enabled: bool,
    /// What the user confirmed reaching. Absent only for `external-app`,
    /// whose app finds the peer itself.
    pub endpoint: Option<Endpoint>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub console: Option<WebConsole>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch: Option<AppLaunch>,
    /// The server enforces a separate view-only password (TigerVNC
    /// `vncpasswd` view password, x11vnc `-viewpasswd`).
    pub view_only: bool,
    #[serde(default)]
    pub config: Value,
    #[serde(default)]
    pub has_control_credential: bool,
    #[serde(default)]
    pub has_view_credential: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTarget {
    pub id: String,
    pub name: String,
    pub bindings: Vec<Binding>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// What a caller may change. Endpoint pinning happens before the store sees it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BindingDraft {
    #[serde(default)]
    pub id: Option<String>,
    pub provider_id: String,
    #[serde(default)]
    pub access: Access,
    pub adapter: Adapter,
    #[serde(default)]
    pub priority: u32,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// `bridge` only: a web console's endpoint comes from its URL, and an
    /// external app has none.
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub console: Option<WebConsole>,
    #[serde(default)]
    pub launch: Option<AppLaunch>,
    #[serde(default)]
    pub view_only: bool,
    #[serde(default)]
    pub config: Value,
    /// The user acknowledged reaching this endpoint (LAN or plaintext
    /// internet). Required whenever the pinned address is new.
    #[serde(default)]
    pub confirm: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TargetDraft {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub bindings: Vec<BindingDraft>,
}

fn default_true() -> bool {
    true
}

#[derive(Serialize, Deserialize)]
struct StoreFile {
    version: u32,
    targets: Vec<RemoteTarget>,
}

pub fn validate_draft(draft: &TargetDraft) -> Result<()> {
    let name = draft.name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(RemoteDesktopError::new("remote_desktop_target_name_invalid"));
    }
    if draft.bindings.is_empty() || draft.bindings.len() > MAX_BINDINGS {
        return Err(RemoteDesktopError::new("remote_desktop_binding_count_invalid"));
    }
    let mut ids = std::collections::HashSet::new();
    for binding in &draft.bindings {
        if let Some(id) = &binding.id {
            if !valid_id(id) || !ids.insert(id.as_str()) {
                return Err(RemoteDesktopError::new("remote_desktop_binding_id_invalid"));
            }
        }
        if !valid_provider_id(&binding.provider_id) {
            return Err(RemoteDesktopError::new("remote_desktop_provider_id_invalid"));
        }
        validate_access(binding)?;
        if binding.view_only && binding.adapter == Adapter::None {
            // A server without authentication cannot tell a view session apart.
            return Err(RemoteDesktopError::new(
                "remote_desktop_binding_cannot_be_read_only",
            ));
        }
        let config = serde_json::to_vec(&binding.config)
            .map_err(|_| RemoteDesktopError::new("remote_desktop_config_invalid"))?;
        if config.len() > MAX_CONFIG_BYTES || !(binding.config.is_null() || binding.config.is_object()) {
            return Err(RemoteDesktopError::new("remote_desktop_config_invalid"));
        }
    }
    Ok(())
}

/// Each access carries exactly its own fields. Non-bridge bindings use
/// adapter `none` (the Host never speaks to them), so they can never be
/// view-only or hold a credential.
fn validate_access(binding: &BindingDraft) -> Result<()> {
    let mismatch = || Err(RemoteDesktopError::new("remote_desktop_binding_access_invalid"));
    match binding.access {
        Access::Bridge => {
            if binding.console.is_some() || binding.launch.is_some() {
                return mismatch();
            }
            let (Some(host), Some(port)) = (&binding.host, binding.port) else {
                return Err(RemoteDesktopError::new("remote_desktop_endpoint_invalid"));
            };
            let host = host.trim();
            if port == 0 || (host.parse::<IpAddr>().is_err() && !cognia_net::egress::is_valid_hostname(host)) {
                return Err(RemoteDesktopError::new("remote_desktop_endpoint_invalid"));
            }
        }
        Access::WebConsole => {
            let Some(console) = &binding.console else {
                return Err(RemoteDesktopError::new("remote_desktop_console_url_invalid"));
            };
            if binding.host.is_some() || binding.port.is_some() || binding.launch.is_some() || binding.adapter != Adapter::None
            {
                return mismatch();
            }
            crate::console::parse(&console.url, console.profile)?;
        }
        Access::ExternalApp => {
            let Some(launch) = &binding.launch else {
                return Err(RemoteDesktopError::new("remote_desktop_launch_peer_invalid"));
            };
            if binding.host.is_some() || binding.port.is_some() || binding.console.is_some() || binding.adapter != Adapter::None
            {
                return mismatch();
            }
            crate::launch::normalize(launch)?;
        }
    }
    Ok(())
}

pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub fn valid_provider_id(id: &str) -> bool {
    let mut chars = id.chars();
    id.len() <= 64
        && chars
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && chars.all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-')
        })
}

/// In-memory view of the Host file. Callers serialize access (one store per
/// Host behind a mutex) and every mutation is written before it returns.
pub struct TargetStore {
    path: PathBuf,
    targets: Vec<RemoteTarget>,
}

impl TargetStore {
    pub fn open(root: &Path) -> Result<Self> {
        let path = root.join(STORE_FILE);
        let targets = match read_store(&path)? {
            Some(file) if file.version == STORE_VERSION => file.targets,
            Some(_) => return Err(RemoteDesktopError::new("remote_desktop_storage_version")),
            None => Vec::new(),
        };
        Ok(Self { path, targets })
    }

    pub fn list(&self) -> &[RemoteTarget] {
        &self.targets
    }

    pub fn get(&self, id: &str) -> Option<&RemoteTarget> {
        self.targets.iter().find(|t| t.id == id)
    }

    pub fn binding(&self, target_id: &str, binding_id: &str) -> Option<&Binding> {
        self.get(target_id)?
            .bindings
            .iter()
            .find(|b| b.id == binding_id)
    }

    /// Replace or insert `target` and persist. Returns the previous version.
    pub fn put(&mut self, target: RemoteTarget) -> Result<Option<RemoteTarget>> {
        let mut next = self.targets.clone();
        let previous = match next.iter_mut().find(|t| t.id == target.id) {
            Some(slot) => Some(std::mem::replace(slot, target)),
            None => {
                if next.len() >= MAX_TARGETS {
                    return Err(RemoteDesktopError::new("remote_desktop_target_limit"));
                }
                next.push(target);
                None
            }
        };
        self.persist(next)?;
        Ok(previous)
    }

    pub fn remove(&mut self, id: &str) -> Result<Option<RemoteTarget>> {
        let mut next = self.targets.clone();
        let Some(index) = next.iter().position(|t| t.id == id) else {
            return Ok(None);
        };
        let removed = next.remove(index);
        self.persist(next)?;
        Ok(Some(removed))
    }

    pub fn set_credential_flag(
        &mut self,
        target_id: &str,
        binding_id: &str,
        view: bool,
        present: bool,
    ) -> Result<()> {
        let mut next = self.targets.clone();
        let binding = next
            .iter_mut()
            .find(|t| t.id == target_id)
            .and_then(|t| t.bindings.iter_mut().find(|b| b.id == binding_id))
            .ok_or_else(|| RemoteDesktopError::new("remote_desktop_binding_not_found"))?;
        if view {
            binding.has_view_credential = present;
        } else {
            binding.has_control_credential = present;
        }
        self.persist(next)
    }

    fn persist(&mut self, targets: Vec<RemoteTarget>) -> Result<()> {
        write_store(
            &self.path,
            &StoreFile {
                version: STORE_VERSION,
                targets: targets.clone(),
            },
        )?;
        self.targets = targets;
        Ok(())
    }
}

fn read_store(path: &Path) -> Result<Option<StoreFile>> {
    if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(RemoteDesktopError::new("remote_desktop_storage_invalid"));
    }
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(RemoteDesktopError::new("remote_desktop_storage_unavailable")),
    };
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(MAX_STORE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| RemoteDesktopError::new("remote_desktop_storage_unavailable"))?;
    if bytes.len() as u64 > MAX_STORE_BYTES {
        return Err(RemoteDesktopError::new("remote_desktop_storage_limit"));
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| RemoteDesktopError::new("remote_desktop_storage_corrupt"))
}

fn write_store(path: &Path, value: &StoreFile) -> Result<()> {
    let unavailable = || RemoteDesktopError::new("remote_desktop_storage_unavailable");
    let parent = path
        .parent()
        .ok_or_else(|| RemoteDesktopError::new("remote_desktop_storage_invalid"))?;
    fs::create_dir_all(parent).map_err(|_| unavailable())?;
    if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(RemoteDesktopError::new("remote_desktop_storage_invalid"));
    }
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|_| RemoteDesktopError::new("remote_desktop_storage_invalid"))?;
    if bytes.len() as u64 > MAX_STORE_BYTES {
        return Err(RemoteDesktopError::new("remote_desktop_storage_limit"));
    }
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|_| unavailable())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temp.as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|_| unavailable())?;
    }
    temp.write_all(&bytes).map_err(|_| unavailable())?;
    temp.as_file().sync_all().map_err(|_| unavailable())?;
    temp.persist(path).map_err(|_| unavailable())?;
    #[cfg(unix)]
    if let Ok(dir) = File::open(parent) {
        let _ = dir.sync_all();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn endpoint() -> Endpoint {
        Endpoint {
            host: "nas.local".into(),
            port: 5900,
            pinned_ip: "192.168.1.20".parse().unwrap(),
            class: EndpointClass::Private,
            confirmed_at: 1,
        }
    }

    fn target(id: &str) -> RemoteTarget {
        RemoteTarget {
            id: id.into(),
            name: "NAS".into(),
            bindings: vec![Binding {
                id: "b1".into(),
                provider_id: "vnc".into(),
                access: Access::Bridge,
                adapter: Adapter::Vnc,
                priority: 0,
                enabled: true,
                endpoint: Some(endpoint()),
                console: None,
                launch: None,
                view_only: false,
                config: Value::Null,
                has_control_credential: false,
                has_view_credential: false,
            }],
            created_at: 1,
            updated_at: 1,
        }
    }

    fn draft() -> TargetDraft {
        TargetDraft {
            id: None,
            name: "NAS".into(),
            bindings: vec![BindingDraft {
                id: None,
                provider_id: "vnc".into(),
                access: Access::Bridge,
                adapter: Adapter::Vnc,
                priority: 0,
                enabled: true,
                host: Some("nas.local".into()),
                port: Some(5900),
                console: None,
                launch: None,
                view_only: false,
                config: Value::Null,
                confirm: true,
            }],
        }
    }

    #[test]
    fn store_round_trips_with_owner_only_permissions_and_no_secret_fields() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = TargetStore::open(dir.path()).unwrap();
        assert!(store.put(target("t1")).unwrap().is_none());
        store.set_credential_flag("t1", "b1", false, true).unwrap();
        let reopened = TargetStore::open(dir.path()).unwrap();
        assert!(reopened.binding("t1", "b1").unwrap().has_control_credential);
        let text = fs::read_to_string(dir.path().join(STORE_FILE)).unwrap();
        assert!(!text.to_lowercase().contains("password"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(dir.path().join(STORE_FILE)).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        assert_eq!(store.remove("t1").unwrap().unwrap().id, "t1");
        assert!(store.remove("t1").unwrap().is_none());
        assert!(TargetStore::open(dir.path()).unwrap().list().is_empty());
    }

    #[test]
    fn store_refuses_corrupt_symlinked_and_future_files() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(STORE_FILE), "{not json").unwrap();
        assert_eq!(
            TargetStore::open(dir.path()).err().unwrap().code,
            "remote_desktop_storage_corrupt"
        );
        fs::write(dir.path().join(STORE_FILE), r#"{"version":9,"targets":[]}"#).unwrap();
        assert_eq!(
            TargetStore::open(dir.path()).err().unwrap().code,
            "remote_desktop_storage_version"
        );
        #[cfg(unix)]
        {
            let link_dir = tempfile::tempdir().unwrap();
            std::os::unix::fs::symlink(
                dir.path().join(STORE_FILE),
                link_dir.path().join(STORE_FILE),
            )
            .unwrap();
            assert_eq!(
                TargetStore::open(link_dir.path()).err().unwrap().code,
                "remote_desktop_storage_invalid"
            );
        }
    }

    #[test]
    fn target_limit_is_enforced_without_partial_writes() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = TargetStore::open(dir.path()).unwrap();
        for n in 0..MAX_TARGETS {
            store.put(target(&format!("t{n}"))).unwrap();
        }
        assert_eq!(
            store.put(target("extra")).unwrap_err().code,
            "remote_desktop_target_limit"
        );
        assert_eq!(TargetStore::open(dir.path()).unwrap().list().len(), MAX_TARGETS);
    }

    #[test]
    fn drafts_are_validated_before_any_resolution() {
        assert!(validate_draft(&draft()).is_ok());
        let code = |edit: fn(&mut TargetDraft)| {
            let mut d = draft();
            edit(&mut d);
            validate_draft(&d).unwrap_err().code
        };
        assert_eq!(code(|d| d.name = "  ".into()), "remote_desktop_target_name_invalid");
        assert_eq!(code(|d| d.bindings.clear()), "remote_desktop_binding_count_invalid");
        assert_eq!(
            code(|d| d.bindings = vec![d.bindings[0].clone(); MAX_BINDINGS + 1]),
            "remote_desktop_binding_count_invalid"
        );
        assert_eq!(code(|d| d.bindings[0].provider_id = "VNC!".into()), "remote_desktop_provider_id_invalid");
        assert_eq!(code(|d| d.bindings[0].port = Some(0)), "remote_desktop_endpoint_invalid");
        assert_eq!(code(|d| d.bindings[0].port = None), "remote_desktop_endpoint_invalid");
        assert_eq!(code(|d| d.bindings[0].host = Some("bad host".into())), "remote_desktop_endpoint_invalid");
        assert_eq!(
            code(|d| {
                d.bindings[0].adapter = Adapter::None;
                d.bindings[0].view_only = true;
            }),
            "remote_desktop_binding_cannot_be_read_only"
        );
        assert_eq!(code(|d| d.bindings[0].config = Value::from(3)), "remote_desktop_config_invalid");
        assert_eq!(
            code(|d| {
                d.bindings[0].config = serde_json::json!({ "x": "y".repeat(MAX_CONFIG_BYTES) })
            }),
            "remote_desktop_config_invalid"
        );
        assert_eq!(
            code(|d| {
                let mut second = d.bindings[0].clone();
                d.bindings[0].id = Some("same".into());
                second.id = Some("same".into());
                d.bindings.push(second);
            }),
            "remote_desktop_binding_id_invalid"
        );
        let mut ip = draft();
        ip.bindings[0].host = Some("10.0.0.2".into());
        assert!(validate_draft(&ip).is_ok());
    }

    fn console_draft() -> TargetDraft {
        let mut d = draft();
        let binding = &mut d.bindings[0];
        binding.access = Access::WebConsole;
        binding.adapter = Adapter::None;
        binding.host = None;
        binding.port = None;
        binding.console = Some(WebConsole {
            url: "https://gw.example.com/#/client/abc".into(),
            profile: ConsoleProfile::Guacamole,
        });
        d
    }

    fn app_draft() -> TargetDraft {
        let mut d = draft();
        let binding = &mut d.bindings[0];
        binding.access = Access::ExternalApp;
        binding.adapter = Adapter::None;
        binding.host = None;
        binding.port = None;
        binding.launch = Some(AppLaunch {
            launcher: crate::launch::Launcher::Rustdesk,
            peer_id: "123 456 789".into(),
            server: None,
            key: None,
        });
        d
    }

    #[test]
    fn each_access_carries_exactly_its_own_fields() {
        assert!(validate_draft(&console_draft()).is_ok());
        assert!(validate_draft(&app_draft()).is_ok());
        let code = |mut d: TargetDraft, edit: fn(&mut BindingDraft)| {
            edit(&mut d.bindings[0]);
            validate_draft(&d).unwrap_err().code
        };
        assert_eq!(
            code(draft(), |b| b.console = console_draft().bindings[0].console.clone()),
            "remote_desktop_binding_access_invalid"
        );
        assert_eq!(code(console_draft(), |b| b.host = Some("gw".into())), "remote_desktop_binding_access_invalid");
        assert_eq!(code(console_draft(), |b| b.adapter = Adapter::Vnc), "remote_desktop_binding_access_invalid");
        assert_eq!(
            code(console_draft(), |b| b.view_only = true),
            "remote_desktop_binding_cannot_be_read_only"
        );
        assert_eq!(code(console_draft(), |b| b.console = None), "remote_desktop_console_url_invalid");
        assert_eq!(
            code(console_draft(), |b| b.console.as_mut().unwrap().url = "https://gw.example.com/".into()),
            "remote_desktop_console_url_invalid"
        );
        assert_eq!(code(app_draft(), |b| b.port = Some(1)), "remote_desktop_binding_access_invalid");
        assert_eq!(code(app_draft(), |b| b.launch = None), "remote_desktop_launch_peer_invalid");
        assert_eq!(
            code(app_draft(), |b| b.launch.as_mut().unwrap().server = Some("bad host".into())),
            "remote_desktop_launch_server_invalid"
        );
    }

    #[test]
    fn phase_two_files_load_as_bridged_bindings() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join(STORE_FILE),
            r#"{"version":1,"targets":[{"id":"t","name":"NAS","createdAt":1,"updatedAt":1,"bindings":[
                {"id":"b","providerId":"vnc","adapter":"vnc","priority":0,"enabled":true,
                 "endpoint":{"host":"nas","port":5900,"pinnedIp":"10.0.0.2","class":"private","confirmedAt":1},
                 "viewOnly":false,"config":null}]}]}"#,
        )
        .unwrap();
        let store = TargetStore::open(dir.path()).unwrap();
        let binding = store.binding("t", "b").unwrap();
        assert_eq!(binding.access, Access::Bridge);
        assert_eq!(binding.endpoint.as_ref().unwrap().port, 5900);
        let saved = serde_json::to_value(binding).unwrap();
        assert_eq!(saved["access"], "bridge");
        assert!(saved.get("console").is_none() && saved.get("launch").is_none());
    }

    #[test]
    fn identifiers_follow_the_closed_shapes() {
        assert!(valid_provider_id("vnc"));
        assert!(valid_provider_id("acme.remote-desktop_2"));
        assert!(!valid_provider_id("-vnc"));
        assert!(!valid_provider_id("Vnc"));
        assert!(!valid_provider_id(""));
        assert!(valid_id("01J-abc_9"));
        assert!(!valid_id("a/b"));
        assert!(!valid_id(&"a".repeat(65)));
    }
}

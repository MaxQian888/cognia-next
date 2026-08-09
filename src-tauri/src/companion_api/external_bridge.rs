//! Host-owned External Bridge configuration and client credential registry.
//!
//! The persisted document contains only non-secret configuration and
//! irreversible SHA-256 credential verifiers. Plaintext credentials are
//! returned exactly once from create/rotate operations.

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
};

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const VALID_SCOPES: &[&str] = &[
    "wiki:cognia",
    "wiki:user-repo",
    "rag:cognia",
    "rag:user-repo",
    "rag:twin",
    "runtime:skills",
    "runtime:characters",
    "runtime:twins",
    "runtime:plugins",
    "runtime:agent-teams",
    "mcp:computer-use",
    "inbox:connectors:read",
    "inbox:connectors:send",
    "agent:dispatch",
    "agent:team",
    "plugin:tools",
    "inbound:write",
    "memory:read",
    "memory:write",
    "workflow:run",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalBridgeConfig {
    pub revision: u64,
    pub enabled_scopes: Vec<String>,
    pub port: u16,
    pub bind_mode: String,
    pub auto_start: bool,
}

impl Default for ExternalBridgeConfig {
    fn default() -> Self {
        Self {
            revision: 1,
            enabled_scopes: vec!["wiki:cognia".into(), "rag:cognia".into()],
            port: 47890,
            bind_mode: "loopback".into(),
            auto_start: false,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalBridgeConfigUpdate {
    pub expected_revision: u64,
    pub enabled_scopes: Vec<String>,
    pub port: u16,
    pub bind_mode: String,
    pub auto_start: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalBridgeClient {
    pub id: String,
    pub name: String,
    pub scopes: Vec<String>,
    pub created_at: u64,
    pub expires_at: Option<u64>,
    pub revoked_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalBridgeClientCredential {
    pub client: ExternalBridgeClient,
    pub credential: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalBridgeStatus {
    pub state: String,
    pub config_revision: u64,
    pub endpoint: Option<String>,
    pub bind_mode: String,
    pub health: String,
    pub sidecar_build: String,
    pub started_at: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedClient {
    #[serde(flatten)]
    public: ExternalBridgeClient,
    verifier: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedBridge {
    #[serde(default)]
    config: ExternalBridgeConfig,
    #[serde(default)]
    clients: Vec<PersistedClient>,
}

#[derive(Default)]
struct RuntimeState {
    state: String,
    error: Option<String>,
}

static RUNTIME: Lazy<Mutex<HashMap<PathBuf, RuntimeState>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static STATE_WRITE_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn root(data_dir: &Path) -> PathBuf {
    data_dir.join("cognia").join("external-bridge")
}

fn state_path(data_dir: &Path) -> PathBuf {
    root(data_dir).join("state.json")
}

fn load(data_dir: &Path) -> Result<PersistedBridge, String> {
    let path = state_path(data_dir);
    if !path.exists() {
        return Ok(PersistedBridge::default());
    }
    let bytes =
        std::fs::read(&path).map_err(|error| format!("read bridge configuration: {error}"))?;
    serde_json::from_slice(&bytes).map_err(|error| format!("parse bridge configuration: {error}"))
}

fn save(data_dir: &Path, value: &PersistedBridge) -> Result<(), String> {
    let directory = root(data_dir);
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("create bridge configuration directory: {error}"))?;
    let path = state_path(data_dir);
    let temporary = directory.join(format!(".state-{}.tmp", Uuid::new_v4()));
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("serialize bridge configuration: {error}"))?;
    std::fs::write(&temporary, bytes)
        .map_err(|error| format!("write bridge configuration: {error}"))?;
    std::fs::rename(&temporary, &path)
        .map_err(|error| format!("commit bridge configuration: {error}"))
}

fn validate_scopes(scopes: &[String]) -> Result<Vec<String>, String> {
    let valid: HashSet<&str> = VALID_SCOPES.iter().copied().collect();
    let mut unique = HashSet::new();
    let mut normalized = Vec::new();
    for scope in scopes {
        if !valid.contains(scope.as_str()) {
            return Err(format!(
                "REMOTE_SCOPE_DENIED: unsupported Bridge scope {scope}"
            ));
        }
        if unique.insert(scope.clone()) {
            normalized.push(scope.clone());
        }
    }
    Ok(normalized)
}

fn new_credential() -> String {
    format!(
        "cognia_{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    )
}

fn verifier(credential: &str) -> String {
    hex::encode(Sha256::digest(credential.as_bytes()))
}

pub fn config_get(data_dir: &Path) -> Result<ExternalBridgeConfig, String> {
    Ok(load(data_dir)?.config)
}

pub fn config_update(
    data_dir: &Path,
    update: ExternalBridgeConfigUpdate,
) -> Result<ExternalBridgeConfig, String> {
    let _write_guard = STATE_WRITE_LOCK.lock();
    if update.bind_mode != "loopback" {
        return Err("REMOTE_FEATURE_UNSUPPORTED: direct LAN/TLS mode is not available".into());
    }
    if update.auto_start {
        return Err(
            "REMOTE_FEATURE_UNSUPPORTED: Bridge auto-start is not available until host secure-storage preflight is configured"
                .into(),
        );
    }
    if update.port == 0 {
        return Err("bridge port must be non-zero in persisted configuration".into());
    }
    let mut persisted = load(data_dir)?;
    if persisted.config.revision != update.expected_revision {
        return Err("REMOTE_RESPONSE_STALE: Bridge configuration revision changed".into());
    }
    persisted.config = ExternalBridgeConfig {
        revision: persisted.config.revision.saturating_add(1),
        enabled_scopes: validate_scopes(&update.enabled_scopes)?,
        port: update.port,
        bind_mode: update.bind_mode,
        auto_start: update.auto_start,
    };
    save(data_dir, &persisted)?;
    Ok(persisted.config)
}

pub fn client_create(
    data_dir: &Path,
    name: String,
    scopes: Vec<String>,
    expires_at: Option<u64>,
) -> Result<ExternalBridgeClientCredential, String> {
    let _write_guard = STATE_WRITE_LOCK.lock();
    let name = name.trim();
    if name.is_empty() || name.len() > 128 {
        return Err("Bridge client name must be between 1 and 128 characters".into());
    }
    if expires_at.is_some_and(|expires_at| expires_at <= now_ms()) {
        return Err("Bridge client expiry must be in the future".into());
    }
    let mut persisted = load(data_dir)?;
    let credential = new_credential();
    let client = ExternalBridgeClient {
        id: Uuid::new_v4().to_string(),
        name: name.into(),
        scopes: validate_scopes(&scopes)?,
        created_at: now_ms(),
        expires_at,
        revoked_at: None,
    };
    persisted.clients.push(PersistedClient {
        public: client.clone(),
        verifier: verifier(&credential),
    });
    save(data_dir, &persisted)?;
    Ok(ExternalBridgeClientCredential { client, credential })
}

pub fn client_list(data_dir: &Path) -> Result<Vec<ExternalBridgeClient>, String> {
    Ok(load(data_dir)?
        .clients
        .into_iter()
        .map(|client| client.public)
        .collect())
}

pub fn client_rotate(
    data_dir: &Path,
    client_id: &str,
) -> Result<ExternalBridgeClientCredential, String> {
    let _write_guard = STATE_WRITE_LOCK.lock();
    let mut persisted = load(data_dir)?;
    let credential = new_credential();
    let client = persisted
        .clients
        .iter_mut()
        .find(|client| client.public.id == client_id)
        .ok_or_else(|| "Bridge client not found".to_string())?;
    if client.public.revoked_at.is_some() {
        return Err("Bridge client is revoked".into());
    }
    client.verifier = verifier(&credential);
    let public = client.public.clone();
    save(data_dir, &persisted)?;
    Ok(ExternalBridgeClientCredential {
        client: public,
        credential,
    })
}

pub fn client_revoke(data_dir: &Path, client_id: &str) -> Result<ExternalBridgeClient, String> {
    let _write_guard = STATE_WRITE_LOCK.lock();
    let mut persisted = load(data_dir)?;
    let client = persisted
        .clients
        .iter_mut()
        .find(|client| client.public.id == client_id)
        .ok_or_else(|| "Bridge client not found".to_string())?;
    client.public.revoked_at.get_or_insert_with(now_ms);
    let public = client.public.clone();
    save(data_dir, &persisted)?;
    Ok(public)
}

pub fn active_clients(
    data_dir: &Path,
) -> Result<Vec<crate::mcp_server::http_server::ClientVerifier>, String> {
    let now = now_ms();
    Ok(load(data_dir)?
        .clients
        .into_iter()
        .filter(|client| {
            client.public.revoked_at.is_none()
                && client
                    .public
                    .expires_at
                    .is_none_or(|expires_at| expires_at > now)
        })
        .map(|client| crate::mcp_server::http_server::ClientVerifier {
            client_id: client.public.id,
            verifier: client.verifier,
            scopes: client.public.scopes,
            expires_at: client.public.expires_at,
        })
        .collect())
}

pub fn set_runtime_state(data_dir: &Path, state: &str, error: Option<String>) {
    RUNTIME.lock().insert(
        root(data_dir),
        RuntimeState {
            state: state.into(),
            error: error.map(|error| sanitize_runtime_error(&error)),
        },
    );
}

fn sanitize_runtime_error(error: &str) -> String {
    let normalized = error.to_ascii_lowercase();
    if normalized.contains("configuration changed") {
        "configuration changed; restart required".into()
    } else if normalized.contains("host-local") && normalized.contains("executor") {
        "host-local executor is unavailable".into()
    } else if normalized.contains("bind") || normalized.contains("address already in use") {
        "configured port or bind address is unavailable".into()
    } else if normalized.contains("sidecar") || normalized.contains("node") {
        "MCP sidecar failed to start or stopped unexpectedly".into()
    } else if normalized.contains("not running") {
        "External Bridge is not running".into()
    } else {
        "External Bridge runtime failure".into()
    }
}

pub fn status(
    data_dir: &Path,
    server: &crate::mcp_server::types::McpServerStatus,
) -> Result<ExternalBridgeStatus, String> {
    let config = config_get(data_dir)?;
    let runtime = RUNTIME.lock();
    let remembered = runtime.get(&root(data_dir));
    let state = remembered
        .map(|runtime| runtime.state.clone())
        .filter(|state| state == "degraded")
        .unwrap_or_else(|| {
            if server.running {
                "running".to_string()
            } else {
                remembered
                    .map(|runtime| runtime.state.clone())
                    .filter(|state| !state.is_empty())
                    .unwrap_or_else(|| "stopped".into())
            }
        });
    Ok(ExternalBridgeStatus {
        state: state.clone(),
        config_revision: config.revision,
        endpoint: server
            .port
            .map(|port| format!("http://127.0.0.1:{port}/mcp/stream")),
        bind_mode: config.bind_mode,
        health: if state == "running" {
            "healthy".into()
        } else if state == "degraded" {
            "unhealthy".into()
        } else {
            "inactive".into()
        },
        sidecar_build: env!("CARGO_PKG_VERSION").into(),
        started_at: server.started_at.clone(),
        error: remembered.and_then(|runtime| runtime.error.clone()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_is_returned_once_and_only_its_verifier_is_persisted() {
        let temp = tempfile::tempdir().unwrap();
        let created = client_create(
            temp.path(),
            "Cursor".into(),
            vec!["wiki:cognia".into()],
            None,
        )
        .unwrap();
        let persisted = std::fs::read_to_string(state_path(temp.path())).unwrap();

        assert!(created.credential.starts_with("cognia_"));
        assert!(!persisted.contains(&created.credential));
        assert!(persisted.contains(&verifier(&created.credential)));
        assert_eq!(client_list(temp.path()).unwrap().len(), 1);
    }

    #[test]
    fn config_update_is_revision_guarded_and_rejects_non_tls_lan_modes() {
        let temp = tempfile::tempdir().unwrap();
        let updated = config_update(
            temp.path(),
            ExternalBridgeConfigUpdate {
                expected_revision: 1,
                enabled_scopes: vec!["wiki:cognia".into()],
                port: 49000,
                bind_mode: "loopback".into(),
                auto_start: false,
            },
        )
        .unwrap();
        assert_eq!(updated.revision, 2);

        let stale = config_update(
            temp.path(),
            ExternalBridgeConfigUpdate {
                expected_revision: 1,
                enabled_scopes: vec![],
                port: 49001,
                bind_mode: "loopback".into(),
                auto_start: false,
            },
        )
        .unwrap_err();
        assert!(stale.starts_with("REMOTE_RESPONSE_STALE"));

        let auto_start = config_update(
            temp.path(),
            ExternalBridgeConfigUpdate {
                expected_revision: 2,
                enabled_scopes: vec![],
                port: 49001,
                bind_mode: "loopback".into(),
                auto_start: true,
            },
        )
        .unwrap_err();
        assert!(auto_start.starts_with("REMOTE_FEATURE_UNSUPPORTED"));
    }

    #[test]
    fn workflow_run_scope_is_accepted_but_not_enabled_by_default() {
        assert!(!ExternalBridgeConfig::default()
            .enabled_scopes
            .contains(&"workflow:run".to_string()));
        assert_eq!(
            validate_scopes(&["workflow:run".to_string()]).unwrap(),
            vec!["workflow:run".to_string()]
        );
    }

    #[test]
    fn revoke_immediately_removes_the_client_verifier() {
        let temp = tempfile::tempdir().unwrap();
        let created =
            client_create(temp.path(), "CLI".into(), vec!["rag:cognia".into()], None).unwrap();
        let active = active_clients(temp.path()).unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].scopes, vec!["rag:cognia"]);
        client_revoke(temp.path(), &created.client.id).unwrap();
        assert!(active_clients(temp.path()).unwrap().is_empty());
    }

    #[test]
    fn runtime_status_never_exposes_absolute_paths_or_raw_process_errors() {
        let temp = tempfile::tempdir().unwrap();
        set_runtime_state(
            temp.path(),
            "degraded",
            Some(
                "failed to spawn sidecar /Users/alice/private/cognia-mcp.mjs: token=secret".into(),
            ),
        );
        let status = status(
            temp.path(),
            &crate::mcp_server::types::McpServerStatus {
                running: false,
                port: None,
                started_at: None,
            },
        )
        .unwrap();

        assert_eq!(
            status.error.as_deref(),
            Some("MCP sidecar failed to start or stopped unexpectedly")
        );
    }

    #[test]
    fn degraded_runtime_state_wins_over_a_live_listener_flag() {
        let temp = tempfile::tempdir().unwrap();
        set_runtime_state(
            temp.path(),
            "degraded",
            Some("host-local executor is unavailable".into()),
        );
        let status = status(
            temp.path(),
            &crate::mcp_server::types::McpServerStatus {
                running: true,
                port: Some(47890),
                started_at: Some("2026-07-29T00:00:00Z".into()),
            },
        )
        .unwrap();

        assert_eq!(status.state, "degraded");
        assert_eq!(status.health, "unhealthy");
    }

    #[test]
    fn concurrent_client_creates_do_not_lose_persisted_state() {
        let temp = tempfile::tempdir().unwrap();
        std::thread::scope(|scope| {
            for index in 0..8 {
                let root = temp.path().to_path_buf();
                scope.spawn(move || {
                    client_create(
                        &root,
                        format!("client-{index}"),
                        vec!["wiki:cognia".into()],
                        None,
                    )
                    .unwrap();
                });
            }
        });

        assert_eq!(client_list(temp.path()).unwrap().len(), 8);
    }
}

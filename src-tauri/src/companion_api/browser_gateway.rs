//! Public browser gateway state and `/ws/browser/{sessionId}` transport.

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query};
use axum::response::IntoResponse;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{broadcast, watch};

#[cfg(feature = "workspace-runtime-exec")]
use crate::external_agent::workspace_runtime_backend::{
    locator_from_env, HttpWorkspaceRuntimeClient, WorkspaceRuntimeClient, WorkspaceRuntimeEndpoint,
    WorkspaceRuntimeLocator,
};

const AGENT_LEASE_MS: i64 = 15_000;
const HUMAN_IDLE_MS: i64 = 30_000;
const HUMAN_RECONNECT_GRACE_MS: i64 = 5_000;
const MAX_SESSIONS_PER_WORKSPACE: usize = 3;
const MAX_VIEWERS_PER_SESSION: usize = 5;
const SESSION_IDLE_MS: i64 = 30 * 60 * 1_000;
const SESSION_MAX_LIFETIME_MS: i64 = 8 * 60 * 60 * 1_000;

/// Named once so the installer's hard failure and the status reason cannot
/// drift apart — a developer reading either one is told about both topologies.
#[cfg(feature = "workspace-runtime-exec")]
const RUNTIME_UNCONFIGURED: &str = "workspace runtime is unconfigured: set \
     COGNIA_WORKSPACE_RUNTIME_URL_TEMPLATE + COGNIA_WORKSPACE_RUNTIME_SECRET_DIR (deployed), or \
     COGNIA_WORKSPACE_RUNTIME_URL + COGNIA_WORKSPACE_RUNTIME_SECRET (loopback runtime)";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BrowserBackend {
    Embedded,
    RemoteChromium,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPageSummary {
    pub id: String,
    pub url: String,
    pub title: String,
    pub active: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserController {
    pub kind: String,
    pub id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserLease {
    pub epoch: u64,
    pub controller: BrowserController,
    pub expires_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSessionSummary {
    pub id: String,
    pub chat_session_id: String,
    pub workspace_id: String,
    pub backend: BrowserBackend,
    pub state: String,
    pub pages: Vec<BrowserPageSummary>,
    pub active_page_id: Option<String>,
    pub profile_id: Option<String>,
    pub controller: Option<BrowserLease>,
    pub capabilities: BrowserCapabilities,
    pub created_at: i64,
    pub last_activity_at: i64,
    pub idle_expires_at: i64,
    pub max_expires_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCapabilities {
    pub multi_page: bool,
    pub screencast: bool,
    pub file_upload: bool,
    pub downloads: bool,
    pub persistent_profile: bool,
}

/// Structured remote-browser process status. `healthy` is true only after a
/// live workspace-runtime health request; compile flags and environment
/// presence alone never count as runtime health.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserRuntimeStatus {
    pub compiled: bool,
    pub enabled: bool,
    pub configured: bool,
    pub healthy: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Clone, Debug)]
pub struct EnsureBrowserSession {
    pub account_id: String,
    pub device_id: String,
    pub chat_session_id: String,
    pub parent_chat_session_id: Option<String>,
    pub workspace_id: String,
    pub backend: BrowserBackend,
    pub profile_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BrowserGatewayError {
    pub code: String,
    pub message: String,
}

impl BrowserGatewayError {
    fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

struct LeaseState {
    epoch: u64,
    controller: BrowserController,
    expires_at: i64,
    disconnected_at: Option<i64>,
}

struct BrowserSessionRecord {
    account_id: String,
    device_id: String,
    summary: BrowserSessionSummary,
    viewers: usize,
    frame_tx: watch::Sender<Option<Arc<Vec<u8>>>>,
    input_tx: broadcast::Sender<BrowserInputCommand>,
    event_tx: broadcast::Sender<Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserInputCommand {
    pub session_id: String,
    pub device_id: String,
    pub epoch: u64,
    pub input: Value,
}

type Clock = dyn Fn() -> i64 + Send + Sync;

pub struct BrowserGateway {
    now: Arc<Clock>,
    /// Serializes every mutation that spans the session map and its secondary indexes.
    session_mutations: Mutex<()>,
    sessions: Mutex<HashMap<String, BrowserSessionRecord>>,
    session_ids_by_chat: Mutex<HashMap<String, String>>,
    profile_owners: Mutex<HashMap<String, String>>,
    leases: Mutex<HashMap<String, LeaseState>>,
}

impl BrowserGateway {
    pub fn with_clock(now: impl Fn() -> i64 + Send + Sync + 'static) -> Self {
        Self {
            now: Arc::new(now),
            session_mutations: Mutex::new(()),
            sessions: Mutex::new(HashMap::new()),
            session_ids_by_chat: Mutex::new(HashMap::new()),
            profile_owners: Mutex::new(HashMap::new()),
            leases: Mutex::new(HashMap::new()),
        }
    }

    pub fn new() -> Self {
        Self::with_clock(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as i64
        })
    }

    pub fn ensure_session(
        &self,
        input: EnsureBrowserSession,
    ) -> Result<BrowserSessionSummary, BrowserGatewayError> {
        let _mutation = self.session_mutations.lock();
        let owner_chat = input
            .parent_chat_session_id
            .as_deref()
            .unwrap_or(&input.chat_session_id);
        let chat_key = format!(
            "{}\0{}\0{}",
            input.account_id, input.workspace_id, owner_chat
        );
        let existing_id = self.session_ids_by_chat.lock().get(&chat_key).cloned();
        if let Some(id) = existing_id {
            let existing = self
                .sessions
                .lock()
                .get(&id)
                .map(|record| (record.device_id.clone(), record.summary.clone()));
            if let Some((device_id, summary)) = existing {
                if matches!(
                    summary.state.as_str(),
                    "creating" | "ready" | "recovering" | "closing"
                ) {
                    if device_id != input.device_id {
                        return Err(BrowserGatewayError::new(
                            "browser_session_forbidden",
                            "browser session belongs to another device",
                        ));
                    }
                    return Ok(summary);
                }
                self.remove_session_locked(&id);
            }
        }
        let active = self
            .sessions
            .lock()
            .values()
            .filter(|record| {
                record.account_id == input.account_id
                    && record.summary.workspace_id == input.workspace_id
                    && !matches!(record.summary.state.as_str(), "closed" | "failed")
            })
            .count();
        if active >= MAX_SESSIONS_PER_WORKSPACE {
            return Err(BrowserGatewayError::new(
                "browser_session_quota_exceeded",
                "browser session quota exceeded",
            ));
        }
        if let Some(profile_id) = input.profile_id.as_deref() {
            let profile_key = format!(
                "{}\0{}\0{}",
                input.account_id, input.workspace_id, profile_id
            );
            if self.profile_owners.lock().contains_key(&profile_key) {
                return Err(BrowserGatewayError::new(
                    "browser_profile_in_use",
                    "browser profile is in use",
                ));
            }
        }
        let now = (self.now)();
        let id = uuid::Uuid::now_v7().to_string();
        let summary = BrowserSessionSummary {
            id: id.clone(),
            chat_session_id: owner_chat.to_string(),
            workspace_id: input.workspace_id.clone(),
            backend: input.backend,
            state: "creating".into(),
            pages: Vec::new(),
            active_page_id: None,
            profile_id: input.profile_id.clone(),
            controller: None,
            capabilities: BrowserCapabilities {
                multi_page: true,
                screencast: true,
                file_upload: true,
                downloads: true,
                persistent_profile: true,
            },
            created_at: now,
            last_activity_at: now,
            idle_expires_at: now + SESSION_IDLE_MS,
            max_expires_at: now + SESSION_MAX_LIFETIME_MS,
        };
        let (frame_tx, _) = watch::channel(None);
        let (input_tx, _) = broadcast::channel(64);
        let (event_tx, _) = broadcast::channel(64);
        self.sessions.lock().insert(
            id.clone(),
            BrowserSessionRecord {
                account_id: input.account_id.clone(),
                device_id: input.device_id,
                summary: summary.clone(),
                viewers: 0,
                frame_tx,
                input_tx,
                event_tx,
            },
        );
        self.session_ids_by_chat.lock().insert(chat_key, id.clone());
        if let Some(profile_id) = input.profile_id {
            self.profile_owners.lock().insert(
                format!(
                    "{}\0{}\0{}",
                    input.account_id, input.workspace_id, profile_id
                ),
                id,
            );
        }
        Ok(summary)
    }

    pub fn set_ready(
        &self,
        session_id: &str,
        pages: Vec<BrowserPageSummary>,
        active_page_id: Option<String>,
    ) -> Result<BrowserSessionSummary, BrowserGatewayError> {
        let mut sessions = self.sessions.lock();
        let record = sessions.get_mut(session_id).ok_or_else(|| {
            BrowserGatewayError::new("browser_session_not_found", "browser session not found")
        })?;
        record.summary.state = "ready".into();
        record.summary.pages = pages;
        record.summary.active_page_id = active_page_id;
        let now = (self.now)();
        record.summary.last_activity_at = now;
        record.summary.idle_expires_at = (now + SESSION_IDLE_MS).min(record.summary.max_expires_at);
        let _ = record.event_tx.send(json!({
            "kind": "session.ready",
            "session": record.summary,
        }));
        Ok(record.summary.clone())
    }

    pub fn update_pages(
        &self,
        session_id: &str,
        pages: Vec<BrowserPageSummary>,
    ) -> Result<(), BrowserGatewayError> {
        let mut sessions = self.sessions.lock();
        let record = sessions.get_mut(session_id).ok_or_else(|| {
            BrowserGatewayError::new("browser_session_not_found", "browser session not found")
        })?;
        record.summary.active_page_id = pages
            .iter()
            .find(|page| page.active)
            .map(|page| page.id.clone());
        record.summary.pages = pages;
        let _ = record.event_tx.send(json!({
            "kind": "pages.changed",
            "pages": record.summary.pages,
            "activePageId": record.summary.active_page_id,
        }));
        Ok(())
    }

    pub fn mark_failed(&self, session_id: &str) {
        let _mutation = self.session_mutations.lock();
        let failed = if let Some(record) = self.sessions.lock().get_mut(session_id) {
            record.summary.state = "failed".into();
            record.summary.controller = None;
            let _ = record.event_tx.send(json!({
                "kind": "session.failed",
                "sessionId": session_id,
            }));
            true
        } else {
            false
        };
        if failed {
            self.session_ids_by_chat
                .lock()
                .retain(|_, id| id != session_id);
            self.profile_owners.lock().retain(|_, id| id != session_id);
        }
        self.leases.lock().remove(session_id);
    }

    pub fn close_session(
        &self,
        account_id: &str,
        device_id: &str,
        session_id: &str,
    ) -> Result<(), BrowserGatewayError> {
        self.session_for_principal(account_id, device_id, session_id)?;
        self.remove_session(session_id).ok_or_else(|| {
            BrowserGatewayError::new("browser_session_not_found", "browser session not found")
        })?;
        Ok(())
    }

    fn remove_session(&self, session_id: &str) -> Option<BrowserSessionSummary> {
        let _mutation = self.session_mutations.lock();
        self.remove_session_locked(session_id)
    }

    fn remove_session_locked(&self, session_id: &str) -> Option<BrowserSessionSummary> {
        let record = self.sessions.lock().remove(session_id)?;
        self.session_ids_by_chat
            .lock()
            .retain(|_, id| id != session_id);
        self.profile_owners.lock().retain(|_, id| id != session_id);
        self.leases.lock().remove(session_id);
        Some(record.summary)
    }

    pub fn touch_session(&self, session_id: &str) {
        let now = (self.now)();
        if let Some(record) = self.sessions.lock().get_mut(session_id) {
            record.summary.last_activity_at = now;
            record.summary.idle_expires_at =
                (now + SESSION_IDLE_MS).min(record.summary.max_expires_at);
        }
    }

    pub fn drain_expired(&self) -> Vec<BrowserSessionSummary> {
        let now = (self.now)();
        let expired = self
            .sessions
            .lock()
            .iter()
            .filter(|(_, record)| {
                now > record.summary.idle_expires_at || now > record.summary.max_expires_at
            })
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        expired
            .iter()
            .filter_map(|id| self.remove_session(id))
            .collect()
    }

    pub fn session_for_account(
        &self,
        account_id: &str,
        session_id: &str,
    ) -> Result<BrowserSessionSummary, BrowserGatewayError> {
        let sessions = self.sessions.lock();
        let record = sessions.get(session_id).ok_or_else(|| {
            BrowserGatewayError::new("browser_session_not_found", "browser session not found")
        })?;
        if record.account_id != account_id {
            return Err(BrowserGatewayError::new(
                "browser_session_forbidden",
                "browser session belongs to another account",
            ));
        }
        Ok(record.summary.clone())
    }

    pub fn session_for_principal(
        &self,
        account_id: &str,
        device_id: &str,
        session_id: &str,
    ) -> Result<BrowserSessionSummary, BrowserGatewayError> {
        let sessions = self.sessions.lock();
        let record = sessions.get(session_id).ok_or_else(|| {
            BrowserGatewayError::new("browser_session_not_found", "browser session not found")
        })?;
        if record.account_id != account_id || record.device_id != device_id {
            return Err(BrowserGatewayError::new(
                "browser_session_forbidden",
                "browser session belongs to another principal",
            ));
        }
        Ok(record.summary.clone())
    }

    #[cfg(feature = "workspace-runtime-exec")]
    fn has_session(&self, session_id: &str) -> bool {
        self.sessions.lock().contains_key(session_id)
    }

    #[cfg(feature = "workspace-runtime-exec")]
    fn is_stream_active(&self, session_id: &str) -> bool {
        self.sessions
            .lock()
            .get(session_id)
            .is_some_and(|record| !matches!(record.summary.state.as_str(), "closed" | "failed"))
    }

    pub fn acquire_agent_lease(
        &self,
        session_id: &str,
        agent_id: &str,
    ) -> Result<BrowserLease, BrowserGatewayError> {
        self.lease(session_id, "agent", agent_id, AGENT_LEASE_MS, false)
    }

    pub fn takeover(
        &self,
        session_id: &str,
        device_id: &str,
    ) -> Result<BrowserLease, BrowserGatewayError> {
        self.lease(session_id, "human", device_id, HUMAN_IDLE_MS, true)
    }

    pub fn takeover_and_cancel(
        &self,
        session_id: &str,
        device_id: &str,
    ) -> Result<BrowserLease, BrowserGatewayError> {
        let lease = self.takeover(session_id, device_id)?;
        self.publish_input(BrowserInputCommand {
            session_id: session_id.to_string(),
            device_id: device_id.to_string(),
            epoch: lease.epoch,
            input: json!({ "kind": "cancel" }),
        })?;
        Ok(lease)
    }

    fn lease(
        &self,
        session_id: &str,
        kind: &str,
        id: &str,
        duration_ms: i64,
        preempt: bool,
    ) -> Result<BrowserLease, BrowserGatewayError> {
        if !self.sessions.lock().contains_key(session_id) {
            return Err(BrowserGatewayError::new(
                "browser_session_not_found",
                "browser session not found",
            ));
        }
        let now = (self.now)();
        let mut leases = self.leases.lock();
        if !preempt {
            if let Some(current) = leases.get(session_id) {
                if current.controller.kind == "human" && now <= current.expires_at {
                    return Err(BrowserGatewayError::new(
                        "browser_control_held_by_human",
                        "browser control is held by a human",
                    ));
                }
            }
        }
        let epoch = leases.get(session_id).map_or(1, |lease| lease.epoch + 1);
        let controller = BrowserController {
            kind: kind.to_string(),
            id: id.to_string(),
        };
        let expires_at = now + duration_ms;
        leases.insert(
            session_id.to_string(),
            LeaseState {
                epoch,
                controller: controller.clone(),
                expires_at,
                disconnected_at: None,
            },
        );
        let lease = BrowserLease {
            epoch,
            controller,
            expires_at,
        };
        if let Some(record) = self.sessions.lock().get_mut(session_id) {
            record.summary.controller = Some(lease.clone());
            record.summary.last_activity_at = now;
            record.summary.idle_expires_at =
                (now + SESSION_IDLE_MS).min(record.summary.max_expires_at);
            let _ = record.event_tx.send(json!({
                "kind": "control.changed",
                "lease": lease,
            }));
        }
        Ok(lease)
    }

    pub fn validate_input(&self, session_id: &str, epoch: u64, controller_id: &str) -> bool {
        let now = (self.now)();
        let mut leases = self.leases.lock();
        let Some(lease) = leases.get(session_id) else {
            return false;
        };
        let reconnect_expired = lease
            .disconnected_at
            .is_some_and(|at| now > at + HUMAN_RECONNECT_GRACE_MS);
        if now > lease.expires_at || reconnect_expired {
            leases.remove(session_id);
            if let Some(record) = self.sessions.lock().get_mut(session_id) {
                record.summary.controller = None;
            }
            return false;
        }
        lease.epoch == epoch && lease.controller.id == controller_id
    }

    pub fn disconnect_human(&self, session_id: &str, device_id: &str) {
        if let Some(lease) = self.leases.lock().get_mut(session_id) {
            if lease.controller.kind == "human" && lease.controller.id == device_id {
                lease.disconnected_at = Some((self.now)());
            }
        }
    }

    fn enter_viewer(&self, session_id: &str) -> Result<(), BrowserGatewayError> {
        let mut sessions = self.sessions.lock();
        let record = sessions.get_mut(session_id).ok_or_else(|| {
            BrowserGatewayError::new("browser_session_not_found", "browser session not found")
        })?;
        if record.viewers >= MAX_VIEWERS_PER_SESSION {
            return Err(BrowserGatewayError::new(
                "browser_viewer_quota_exceeded",
                "browser viewer quota exceeded",
            ));
        }
        record.viewers += 1;
        let now = (self.now)();
        record.summary.last_activity_at = now;
        record.summary.idle_expires_at = (now + SESSION_IDLE_MS).min(record.summary.max_expires_at);
        Ok(())
    }

    fn leave_viewer(&self, session_id: &str) {
        if let Some(record) = self.sessions.lock().get_mut(session_id) {
            record.viewers = record.viewers.saturating_sub(1);
        }
    }

    pub fn publish_frame(
        &self,
        session_id: &str,
        frame: Vec<u8>,
    ) -> Result<(), BrowserGatewayError> {
        let mut sessions = self.sessions.lock();
        let record = sessions.get_mut(session_id).ok_or_else(|| {
            BrowserGatewayError::new("browser_session_not_found", "browser session not found")
        })?;
        let now = (self.now)();
        record.summary.last_activity_at = now;
        record.summary.idle_expires_at = (now + SESSION_IDLE_MS).min(record.summary.max_expires_at);
        record.frame_tx.send_replace(Some(Arc::new(frame)));
        Ok(())
    }

    pub fn subscribe_frames(
        &self,
        session_id: &str,
    ) -> Result<watch::Receiver<Option<Arc<Vec<u8>>>>, BrowserGatewayError> {
        self.sessions
            .lock()
            .get(session_id)
            .map(|record| record.frame_tx.subscribe())
            .ok_or_else(|| {
                BrowserGatewayError::new("browser_session_not_found", "browser session not found")
            })
    }

    pub fn subscribe_input(
        &self,
        session_id: &str,
    ) -> Result<broadcast::Receiver<BrowserInputCommand>, BrowserGatewayError> {
        self.sessions
            .lock()
            .get(session_id)
            .map(|record| record.input_tx.subscribe())
            .ok_or_else(|| {
                BrowserGatewayError::new("browser_session_not_found", "browser session not found")
            })
    }

    pub fn subscribe_events(
        &self,
        session_id: &str,
    ) -> Result<broadcast::Receiver<Value>, BrowserGatewayError> {
        self.sessions
            .lock()
            .get(session_id)
            .map(|record| record.event_tx.subscribe())
            .ok_or_else(|| {
                BrowserGatewayError::new("browser_session_not_found", "browser session not found")
            })
    }

    fn publish_input(&self, command: BrowserInputCommand) -> Result<(), BrowserGatewayError> {
        let sessions = self.sessions.lock();
        let record = sessions.get(&command.session_id).ok_or_else(|| {
            BrowserGatewayError::new("browser_session_not_found", "browser session not found")
        })?;
        let _ = record.input_tx.send(command);
        Ok(())
    }
}

impl Default for BrowserGateway {
    fn default() -> Self {
        Self::new()
    }
}

static GATEWAY: once_cell::sync::Lazy<BrowserGateway> =
    once_cell::sync::Lazy::new(BrowserGateway::new);

pub fn gateway() -> &'static BrowserGateway {
    &GATEWAY
}

pub const BROWSER_RPC_COMMANDS: &[&str] = &[
    "browser_capability",
    "browser_runtime_status",
    "browser_session_ensure",
    "browser_session_get",
    "browser_session_close",
    "browser_navigate",
    "browser_snapshot",
    "browser_act",
    "browser_drag",
    "browser_press_key",
    "browser_scroll",
    "browser_evaluate",
    "browser_read_console",
    "browser_read_network",
    "browser_back",
    "browser_forward",
    "browser_reload",
    "browser_stop",
    "browser_get_page",
    "browser_handle_dialog",
    "browser_pages",
    "browser_new_page",
    "browser_switch_page",
    "browser_close_page",
    "browser_wait_for",
    "browser_wait_for_load",
    "browser_screenshot",
    "browser_set_files",
    "browser_downloads",
    "browser_set_zoom",
    "browser_find",
    "browser_find_clear",
];

pub fn is_browser_rpc(name: &str) -> bool {
    BROWSER_RPC_COMMANDS.contains(&name)
}

#[cfg(feature = "workspace-runtime-exec")]
struct WorkspaceRuntimeBrowserControl {
    locator: Arc<dyn WorkspaceRuntimeLocator>,
    client: Arc<dyn WorkspaceRuntimeClient>,
    endpoints: Mutex<HashMap<String, WorkspaceRuntimeEndpoint>>,
}

#[cfg(feature = "workspace-runtime-exec")]
impl WorkspaceRuntimeBrowserControl {
    async fn located_endpoint(
        &self,
        workspace_id: &str,
    ) -> Result<WorkspaceRuntimeEndpoint, BrowserGatewayError> {
        if let Some(endpoint) = self.endpoints.lock().get(workspace_id).cloned() {
            return Ok(endpoint);
        }
        let endpoint = self
            .locator
            .locate(workspace_id)
            .await
            .map_err(|error| BrowserGatewayError::new("browser_runtime_unavailable", error))?;
        self.endpoints
            .lock()
            .insert(workspace_id.to_string(), endpoint.clone());
        Ok(endpoint)
    }

    async fn probe(
        &self,
        workspace_id: &str,
    ) -> Result<WorkspaceRuntimeEndpoint, BrowserGatewayError> {
        let endpoint = self.located_endpoint(workspace_id).await?;
        if !self
            .client
            .healthy(&endpoint)
            .await
            .map_err(|error| BrowserGatewayError::new("browser_runtime_unavailable", error))?
        {
            self.endpoints.lock().remove(workspace_id);
            return Err(BrowserGatewayError::new(
                "browser_runtime_unhealthy",
                "workspace runtime health probe failed",
            ));
        }
        Ok(endpoint)
    }

    async fn endpoint(
        &self,
        workspace_id: &str,
    ) -> Result<WorkspaceRuntimeEndpoint, BrowserGatewayError> {
        self.probe(workspace_id).await
    }

    async fn call(
        &self,
        workspace_id: &str,
        operation: &str,
        payload: Value,
    ) -> Result<Value, BrowserGatewayError> {
        let endpoint = self.endpoint(workspace_id).await?;
        self.client
            .control(&endpoint, operation, payload)
            .await
            .map_err(|error| {
                let code = error
                    .strip_prefix("runtime_code=")
                    .and_then(|value| value.split(';').next())
                    .unwrap_or("browser_runtime_error");
                BrowserGatewayError::new(code, "workspace runtime rejected the browser operation")
            })
    }

    async fn start_streams(
        &self,
        workspace_id: String,
        session_id: String,
    ) -> Result<(), BrowserGatewayError> {
        let endpoint = self.endpoint(&workspace_id).await?;
        self.client
            .control(
                &endpoint,
                "browser.screencast.start",
                json!({ "sessionId": session_id, "quality": 70 }),
            )
            .await
            .map_err(|error| BrowserGatewayError::new("browser_runtime_error", error))?;

        let media_client = Arc::clone(&self.client);
        let media_endpoint = endpoint.clone();
        let media_session = session_id.clone();
        tokio::spawn(async move {
            let mut cursor = 0;
            let mut failures = 0;
            loop {
                match media_client
                    .media(&media_endpoint, &media_session, cursor)
                    .await
                {
                    Ok(Some((sequence, bytes))) => {
                        cursor = sequence;
                        failures = 0;
                        if gateway().publish_frame(&media_session, bytes).is_err() {
                            break;
                        }
                        let _ = media_client
                            .control(
                                &media_endpoint,
                                "browser.screencast.ack",
                                json!({ "sessionId": media_session, "sequence": sequence }),
                            )
                            .await;
                    }
                    Ok(None) => {
                        if !gateway().has_session(&media_session) {
                            break;
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                    }
                    Err(_) => {
                        failures += 1;
                        if failures >= 3 {
                            gateway().mark_failed(&media_session);
                            break;
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    }
                }
            }
        });

        let mut input = gateway().subscribe_input(&session_id)?;
        let input_client = Arc::clone(&self.client);
        let input_session = session_id;
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    received = input.recv() => {
                        let Ok(command) = received else { break };
                        let operation =
                            if command.input.get("kind").and_then(Value::as_str) == Some("cancel") {
                                "browser.cancel"
                            } else {
                                "browser.input"
                            };
                        let _ = input_client
                            .control(
                                &endpoint,
                                operation,
                                if operation == "browser.cancel" {
                                    json!({ "sessionId": command.session_id })
                                } else {
                                    json!({ "sessionId": command.session_id, "input": command.input })
                                },
                            )
                            .await;
                    }
                    _ = tokio::time::sleep(std::time::Duration::from_millis(250)) => {
                        if !gateway().is_stream_active(&input_session) {
                            break;
                        }
                    }
                }
            }
        });
        Ok(())
    }
}

#[cfg(feature = "workspace-runtime-exec")]
static RUNTIME_CONTROL: once_cell::sync::OnceCell<Arc<WorkspaceRuntimeBrowserControl>> =
    once_cell::sync::OnceCell::new();

#[cfg(feature = "workspace-runtime-exec")]
pub fn install_workspace_runtime_control_from_env() -> Result<bool, String> {
    if std::env::var("COGNIA_REMOTE_BROWSER_ENABLED")
        .unwrap_or_else(|_| "false".into())
        .to_ascii_lowercase()
        != "true"
    {
        return Ok(false);
    }
    let locator = locator_from_env()?.ok_or_else(|| RUNTIME_UNCONFIGURED.to_string())?;
    let control = Arc::new(WorkspaceRuntimeBrowserControl {
        locator,
        client: HttpWorkspaceRuntimeClient::new(),
        endpoints: Mutex::new(HashMap::new()),
    });
    let reaper_control = Arc::clone(&control);
    RUNTIME_CONTROL
        .set(control)
        .map_err(|_| "workspace runtime browser control already installed".to_string())?;
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
        interval.tick().await;
        loop {
            interval.tick().await;
            for summary in gateway().drain_expired() {
                let _ = reaper_control
                    .call(
                        &summary.workspace_id,
                        "browser.session.close",
                        json!({ "sessionId": summary.id }),
                    )
                    .await;
            }
        }
    });
    Ok(true)
}

#[cfg(feature = "workspace-runtime-exec")]
pub async fn browser_runtime_status(workspace_id: Option<&str>) -> BrowserRuntimeStatus {
    let enabled = std::env::var("COGNIA_REMOTE_BROWSER_ENABLED")
        .ok()
        .is_some_and(|value| value.eq_ignore_ascii_case("true"));
    // One reader for "how is a runtime addressed", shared with the installer
    // and the exec backend: a status that answered from its own copy of the
    // env rules would report `configured` for a configuration the installer
    // then rejects.
    let configuration = locator_from_env();
    let configured = matches!(configuration, Ok(Some(_)));
    let base = BrowserRuntimeStatus {
        compiled: true,
        enabled,
        configured,
        healthy: false,
        workspace_id: workspace_id.map(str::to_string),
        reason: None,
    };
    if !enabled {
        return BrowserRuntimeStatus {
            reason: Some("COGNIA_REMOTE_BROWSER_ENABLED is not true".into()),
            ..base
        };
    }
    if !configured {
        return BrowserRuntimeStatus {
            reason: Some(match configuration {
                Err(error) => error,
                _ => RUNTIME_UNCONFIGURED.to_string(),
            }),
            ..base
        };
    }
    let Some(control) = RUNTIME_CONTROL.get() else {
        return BrowserRuntimeStatus {
            reason: Some("workspace runtime browser control is not initialized".into()),
            ..base
        };
    };
    let Some(workspace_id) = workspace_id.filter(|value| !value.trim().is_empty()) else {
        return BrowserRuntimeStatus {
            reason: Some("workspaceId is required for a dynamic health probe".into()),
            ..base
        };
    };
    match control.probe(workspace_id).await {
        Ok(_) => BrowserRuntimeStatus {
            healthy: true,
            ..base
        },
        Err(error) => BrowserRuntimeStatus {
            reason: Some(format!("{}: {}", error.code, error.message)),
            ..base
        },
    }
}

#[cfg(not(feature = "workspace-runtime-exec"))]
pub fn install_workspace_runtime_control_from_env() -> Result<bool, String> {
    if std::env::var("COGNIA_REMOTE_BROWSER_ENABLED")
        .ok()
        .is_some_and(|value| value.eq_ignore_ascii_case("true"))
    {
        return Err(
            "COGNIA_REMOTE_BROWSER_ENABLED=true but workspace-runtime-exec is not compiled".into(),
        );
    }
    Ok(false)
}

#[cfg(not(feature = "workspace-runtime-exec"))]
pub async fn browser_runtime_status(workspace_id: Option<&str>) -> BrowserRuntimeStatus {
    let enabled = std::env::var("COGNIA_REMOTE_BROWSER_ENABLED")
        .ok()
        .is_some_and(|value| value.eq_ignore_ascii_case("true"));
    BrowserRuntimeStatus {
        compiled: false,
        enabled,
        configured: false,
        healthy: false,
        workspace_id: workspace_id.map(str::to_string),
        reason: Some("workspace-runtime-exec is not compiled".into()),
    }
}

#[cfg(feature = "workspace-runtime-exec")]
fn required_string(args: &Value, key: &str) -> Result<String, BrowserGatewayError> {
    args.get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            BrowserGatewayError::new("browser_invalid_request", format!("missing {key}"))
        })
}

#[cfg(any(feature = "workspace-runtime-exec", test))]
fn browser_operation(
    name: &str,
    args: &Value,
) -> Result<(&'static str, bool), BrowserGatewayError> {
    match name {
        "browser_navigate" => Ok(("browser.navigate", true)),
        "browser_snapshot" => Ok(("browser.snapshot", false)),
        "browser_act" => Ok(("browser.act", true)),
        "browser_drag" => Ok(("browser.drag", true)),
        "browser_press_key" => Ok(("browser.press-key", true)),
        "browser_scroll" => Ok(("browser.scroll", true)),
        "browser_evaluate" => Ok(("browser.evaluate", true)),
        "browser_read_console" => Ok(("browser.console", false)),
        "browser_read_network" => Ok(("browser.network", false)),
        "browser_back" => Ok(("browser.back", true)),
        "browser_forward" => Ok(("browser.forward", true)),
        "browser_reload" => Ok(("browser.reload", true)),
        "browser_stop" => Ok(("browser.stop", true)),
        "browser_get_page" => Ok(("browser.page", false)),
        "browser_handle_dialog" => Ok(("browser.dialog.handle", true)),
        "browser_pages" => Ok(("browser.pages", false)),
        "browser_new_page" => Ok(("browser.page.create", true)),
        "browser_switch_page" => Ok(("browser.page.activate", true)),
        "browser_close_page" => Ok(("browser.page.close", true)),
        "browser_wait_for_load" => Ok(("browser.wait.load", false)),
        "browser_screenshot" => Ok(("browser.screenshot", false)),
        "browser_set_files" => Ok(("browser.files.set", true)),
        "browser_downloads" => Ok(("browser.downloads", false)),
        "browser_set_zoom" => Ok(("browser.set-zoom", true)),
        "browser_find" => Ok(("browser.find", false)),
        "browser_find_clear" => Ok(("browser.find.clear", false)),
        "browser_wait_for" => {
            let operation = if args.get("networkIdle").and_then(Value::as_bool) == Some(true) {
                "browser.wait.network-idle"
            } else if args.get("selector").is_some() {
                "browser.wait.selector"
            } else {
                "browser.wait.text"
            };
            Ok((operation, false))
        }
        _ => Err(BrowserGatewayError::new(
            "browser_command_unknown",
            "unknown browser command",
        )),
    }
}

#[cfg(any(feature = "workspace-runtime-exec", test))]
fn browser_operation_refreshes_pages(name: &str) -> bool {
    matches!(
        name,
        "browser_navigate"
            | "browser_act"
            | "browser_drag"
            | "browser_back"
            | "browser_forward"
            | "browser_reload"
            | "browser_switch_page"
            | "browser_close_page"
            | "browser_new_page"
            | "browser_handle_dialog"
    )
}

#[cfg(feature = "workspace-runtime-exec")]
pub async fn dispatch_browser_rpc(
    name: &str,
    args: Value,
    account_id: &str,
    device_id: &str,
) -> Result<Value, BrowserGatewayError> {
    if name == "browser_runtime_status" {
        let workspace_id = args.get("workspaceId").and_then(Value::as_str);
        return serde_json::to_value(browser_runtime_status(workspace_id).await).map_err(|error| {
            BrowserGatewayError::new("browser_status_serialize", error.to_string())
        });
    }
    let control = RUNTIME_CONTROL.get().ok_or_else(|| {
        BrowserGatewayError::new(
            "browser_disabled",
            "remote browser server gate is disabled or runtime is unavailable",
        )
    })?;
    if name == "browser_capability" {
        if args.get("userEnabled").and_then(Value::as_bool) != Some(true) {
            return Ok(json!({ "capabilities": [] }));
        }
        let workspace_id = required_string(&args, "workspaceId")?;
        control.probe(&workspace_id).await?;
        return Ok(json!({
            "capabilities": ["browser"],
            "backend": "remote-chromium",
            "runtimeHealthy": true
        }));
    }
    if name == "browser_session_ensure" {
        if args.get("userEnabled").and_then(Value::as_bool) != Some(true) {
            return Err(BrowserGatewayError::new(
                "browser_disabled",
                "remote browser experiment is disabled for this user",
            ));
        }
        let backend = match args.get("backendPreference").and_then(Value::as_str) {
            Some("embedded") => BrowserBackend::Embedded,
            _ => BrowserBackend::RemoteChromium,
        };
        if backend != BrowserBackend::RemoteChromium {
            return Err(BrowserGatewayError::new(
                "browser_backend_invalid",
                "cognia-server only hosts remote-chromium sessions",
            ));
        }
        let grants = args
            .get("domainGrants")
            .and_then(Value::as_array)
            .map(|values| values.iter().filter_map(Value::as_str).collect::<Vec<_>>())
            .unwrap_or_default();
        let summary = gateway().ensure_session(EnsureBrowserSession {
            account_id: account_id.to_string(),
            device_id: device_id.to_string(),
            chat_session_id: required_string(&args, "chatSessionId")?,
            parent_chat_session_id: args
                .get("parentChatSessionId")
                .and_then(Value::as_str)
                .map(str::to_string),
            workspace_id: required_string(&args, "workspaceId")?,
            backend,
            profile_id: args
                .get("profileId")
                .and_then(Value::as_str)
                .map(str::to_string),
        })?;
        let created = control
            .call(
                &summary.workspace_id,
                "browser.session.create",
                json!({
                    "id": summary.id,
                    "profileId": summary.profile_id,
                    "grants": grants,
                }),
            )
            .await;
        let created = match created {
            Ok(value) => value,
            Err(error) => {
                gateway().mark_failed(&summary.id);
                return Err(error);
            }
        };
        let pages: Vec<BrowserPageSummary> =
            serde_json::from_value(created.get("pages").cloned().unwrap_or_else(|| json!([])))
                .map_err(|error| {
                    BrowserGatewayError::new("browser_runtime_error", error.to_string())
                })?;
        let ready = gateway().set_ready(
            &summary.id,
            pages,
            created
                .get("activePageId")
                .and_then(Value::as_str)
                .map(str::to_string),
        )?;
        if let Err(error) = control
            .start_streams(ready.workspace_id.clone(), ready.id.clone())
            .await
        {
            let _ = control
                .call(
                    &ready.workspace_id,
                    "browser.session.close",
                    json!({ "sessionId": ready.id }),
                )
                .await;
            gateway().mark_failed(&ready.id);
            return Err(error);
        }
        return serde_json::to_value(ready)
            .map_err(|error| BrowserGatewayError::new("browser_runtime_error", error.to_string()));
    }

    let session_id = required_string(&args, "browserSessionId")?;
    let summary = gateway().session_for_principal(account_id, device_id, &session_id)?;
    gateway().touch_session(&session_id);
    if name == "browser_session_get" {
        return serde_json::to_value(gateway().session_for_principal(
            account_id,
            device_id,
            &session_id,
        )?)
        .map_err(|error| BrowserGatewayError::new("browser_runtime_error", error.to_string()));
    }
    if name == "browser_session_close" {
        let runtime_close = control
            .call(
                &summary.workspace_id,
                "browser.session.close",
                json!({ "sessionId": session_id }),
            )
            .await;
        gateway().close_session(account_id, device_id, &session_id)?;
        runtime_close?;
        return Ok(json!({ "closed": true }));
    }

    let mut payload = args.clone();
    if let Some(object) = payload.as_object_mut() {
        object.insert("sessionId".into(), Value::String(session_id.clone()));
        object.remove("browserSessionId");
    }
    let (operation, mutating) = browser_operation(name, &args)?;
    if mutating {
        gateway().acquire_agent_lease(&session_id, &format!("agent:{device_id}"))?;
    }
    let result = control
        .call(&summary.workspace_id, operation, payload)
        .await?;
    if browser_operation_refreshes_pages(name) {
        if let Ok(value) = control
            .call(
                &summary.workspace_id,
                "browser.pages",
                json!({ "sessionId": session_id }),
            )
            .await
        {
            if let Ok(pages) = serde_json::from_value::<Vec<BrowserPageSummary>>(value) {
                let _ = gateway().update_pages(&session_id, pages);
            }
        }
    }
    Ok(result)
}

#[cfg(not(feature = "workspace-runtime-exec"))]
pub async fn dispatch_browser_rpc(
    name: &str,
    args: Value,
    _account_id: &str,
    _device_id: &str,
) -> Result<Value, BrowserGatewayError> {
    if name == "browser_runtime_status" {
        let workspace_id = args.get("workspaceId").and_then(Value::as_str);
        return serde_json::to_value(browser_runtime_status(workspace_id).await).map_err(|error| {
            BrowserGatewayError::new("browser_status_serialize", error.to_string())
        });
    }
    Err(BrowserGatewayError::new(
        "browser_disabled",
        "remote browser support is not compiled",
    ))
}

#[derive(Deserialize)]
pub struct StreamQuery {
    ticket: String,
}

pub async fn browser_ws_handler(
    Path(session_id): Path<String>,
    Query(query): Query<StreamQuery>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    let path = format!("/ws/browser/{session_id}");
    let Some(store) = super::security_store::security_store() else {
        return super::api::public_error_response(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "security_store_unavailable",
            "the security database is unavailable",
            true,
            json!({}),
        );
    };
    let identity =
        match store.redeem_socket_ticket(&query.ticket, &path, "browser", unix_time_secs()) {
            Ok(identity) => identity,
            Err(_) => {
                return super::api::public_error_response(
                    axum::http::StatusCode::UNAUTHORIZED,
                    "invalid_socket_ticket",
                    "the browser socket ticket is invalid, expired, or already used",
                    false,
                    json!({}),
                );
            }
        };
    match gateway().session_for_principal(&identity.tenant_id, &identity.device_id, &session_id) {
        Ok(_) => ws
            .on_upgrade(move |socket| {
                handle_browser_socket(socket, session_id, identity.tenant_id, identity.device_id)
            })
            .into_response(),
        Err(error) => super::api::public_error_response(
            axum::http::StatusCode::UNAUTHORIZED,
            error.code,
            error.message,
            false,
            json!({}),
        ),
    }
}

fn unix_time_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

async fn handle_browser_socket(
    mut socket: WebSocket,
    session_id: String,
    tenant_id: String,
    device_id: String,
) {
    if gateway().enter_viewer(&session_id).is_err() {
        let _ = socket
            .send(Message::Text(
                json!({ "version": 1, "type": "error", "payload": { "code": "browser_viewer_quota_exceeded" } })
                    .to_string()
                    .into(),
            ))
            .await;
        return;
    }
    let mut frames = match gateway().subscribe_frames(&session_id) {
        Ok(receiver) => receiver,
        Err(_) => {
            gateway().leave_viewer(&session_id);
            return;
        }
    };
    let mut events = match gateway().subscribe_events(&session_id) {
        Ok(receiver) => receiver,
        Err(_) => {
            gateway().leave_viewer(&session_id);
            return;
        }
    };
    let connected = json!({
        "version": 1,
        "type": "connected",
        "payload": { "sessionId": session_id }
    });
    if socket
        .send(Message::Text(connected.to_string().into()))
        .await
        .is_err()
    {
        gateway().leave_viewer(&session_id);
        return;
    }
    // Re-check authorization once a second. Until this existed the browser
    // stream was authorized exactly once, at ticket redemption, and then ran
    // for as long as the client kept it open — so suspending or revoking a
    // device left its live screen share running. Matches the cadence
    // `/ws/terminal` and `/ws/worker` already use.
    let mut authorization = tokio::time::interval(std::time::Duration::from_secs(1));
    authorization.tick().await;
    loop {
        tokio::select! {
            _ = authorization.tick() => {
                if !super::device_lifecycle::still_authorized(&tenant_id, &device_id) {
                    let reason = super::device_lifecycle::close_reason(&tenant_id, &device_id);
                    let _ = socket
                        .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                            code: 1008,
                            reason: reason.into(),
                        })))
                        .await;
                    break;
                }
            }
            event = events.recv() => {
                if let Ok(payload) = event {
                    let outgoing = json!({ "version": 1, "type": "event", "payload": payload });
                    if socket.send(Message::Text(outgoing.to_string().into())).await.is_err() {
                        break;
                    }
                }
            }
            changed = frames.changed() => {
                if changed.is_err() { break; }
                let frame = frames.borrow_and_update().clone();
                if let Some(frame) = frame {
                    if socket.send(Message::Binary(frame.as_slice().to_vec().into())).await.is_err() {
                        break;
                    }
                }
            }
            message = socket.recv() => {
                let Some(Ok(message)) = message else { break; };
                match message {
                    Message::Text(text) => {
                        let Ok(envelope) = serde_json::from_str::<Value>(&text) else { continue; };
                        if envelope.get("version").and_then(Value::as_u64) != Some(1) { continue; }
                        let kind = envelope.get("type").and_then(Value::as_str).unwrap_or_default();
                        let payload = envelope.get("payload").cloned().unwrap_or(Value::Null);
                        let response = match kind {
                            "control.takeover" => gateway().takeover_and_cancel(&session_id, &device_id)
                                .map(|lease| json!({ "lease": lease })),
                            "input" => {
                                let epoch = payload.get("epoch").and_then(Value::as_u64).unwrap_or_default();
                                if !gateway().validate_input(&session_id, epoch, &device_id) {
                                    Err(BrowserGatewayError::new("browser_stale_lease", "browser lease epoch is stale"))
                                } else {
                                    let command = BrowserInputCommand {
                                        session_id: session_id.clone(),
                                        device_id: device_id.clone(),
                                        epoch,
                                        input: payload.get("input").cloned().unwrap_or(Value::Null),
                                    };
                                    gateway().publish_input(command).map(|_| json!({ "accepted": true }))
                                }
                            }
                            "frame.ack" => Ok(json!({ "accepted": true })),
                            _ => Err(BrowserGatewayError::new("browser_message_unknown", "unknown browser message")),
                        };
                        let outgoing = match response {
                            Ok(payload) => json!({ "version": 1, "type": "result", "payload": payload }),
                            Err(error) => json!({ "version": 1, "type": "error", "payload": { "code": error.code, "message": error.message } }),
                        };
                        if socket.send(Message::Text(outgoing.to_string().into())).await.is_err() { break; }
                    }
                    Message::Ping(bytes) => {
                        if socket.send(Message::Pong(bytes)).await.is_err() { break; }
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
        }
    }
    gateway().disconnect_human(&session_id, &device_id);
    gateway().leave_viewer(&session_id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicI64, Ordering};
    use std::sync::Barrier;

    #[test]
    fn browser_rpc_catalog_includes_advanced_control_commands() {
        for (command, operation) in [
            ("browser_new_page", "browser.page.create"),
            ("browser_drag", "browser.drag"),
            ("browser_handle_dialog", "browser.dialog.handle"),
        ] {
            assert!(
                is_browser_rpc(command),
                "missing browser RPC command: {command}"
            );
            assert_eq!(
                browser_operation(command, &Value::Null).unwrap(),
                (operation, true)
            );
            assert!(browser_operation_refreshes_pages(command));
        }
        assert_eq!(
            browser_operation("browser_evaluate", &Value::Null).unwrap(),
            ("browser.evaluate", true)
        );
    }

    #[cfg(feature = "workspace-runtime-exec")]
    use std::sync::atomic::AtomicUsize;

    fn fixture() -> (BrowserGateway, Arc<AtomicI64>) {
        let now = Arc::new(AtomicI64::new(1_000));
        let clock = Arc::clone(&now);
        (
            BrowserGateway::with_clock(move || clock.load(Ordering::Relaxed)),
            now,
        )
    }

    #[cfg(feature = "workspace-runtime-exec")]
    struct MockRuntimeLocator;

    #[cfg(feature = "workspace-runtime-exec")]
    #[async_trait::async_trait]
    impl WorkspaceRuntimeLocator for MockRuntimeLocator {
        async fn locate(&self, workspace_id: &str) -> Result<WorkspaceRuntimeEndpoint, String> {
            Ok(WorkspaceRuntimeEndpoint {
                base_url: format!("http://runtime/{workspace_id}"),
                secret: "test-secret".into(),
            })
        }
    }

    #[cfg(feature = "workspace-runtime-exec")]
    #[derive(Default)]
    struct MockRuntimeClient {
        media_calls: AtomicUsize,
        operations: Mutex<Vec<String>>,
    }

    #[cfg(feature = "workspace-runtime-exec")]
    #[async_trait::async_trait]
    impl WorkspaceRuntimeClient for MockRuntimeClient {
        async fn control(
            &self,
            _endpoint: &WorkspaceRuntimeEndpoint,
            operation: &str,
            _payload: Value,
        ) -> Result<Value, String> {
            self.operations.lock().push(operation.to_string());
            Ok(Value::Null)
        }

        async fn events(
            &self,
            _endpoint: &WorkspaceRuntimeEndpoint,
            _after: u64,
        ) -> Result<
            Vec<crate::external_agent::workspace_runtime_backend::WorkspaceRuntimeEvent>,
            String,
        > {
            Ok(Vec::new())
        }

        async fn media(
            &self,
            _endpoint: &WorkspaceRuntimeEndpoint,
            _session_id: &str,
            _after: u64,
        ) -> Result<Option<(u64, Vec<u8>)>, String> {
            match self.media_calls.fetch_add(1, Ordering::SeqCst) {
                0 => Ok(Some((1, vec![1, 2, 3]))),
                _ => Err("stream failed".into()),
            }
        }
    }

    #[cfg(feature = "workspace-runtime-exec")]
    #[tokio::test]
    async fn workspace_runtime_stream_failure_marks_failed_and_stops_pumps() {
        let unique = uuid::Uuid::new_v4().to_string();
        let session = gateway()
            .ensure_session(EnsureBrowserSession {
                account_id: format!("acct-{unique}"),
                device_id: format!("device-{unique}"),
                chat_session_id: format!("chat-{unique}"),
                parent_chat_session_id: None,
                workspace_id: format!("workspace-{unique}"),
                backend: BrowserBackend::RemoteChromium,
                profile_id: None,
            })
            .expect("seed global browser session");
        let mut frames = gateway()
            .subscribe_frames(&session.id)
            .expect("subscribe before stream starts");
        let client = Arc::new(MockRuntimeClient::default());
        let control = WorkspaceRuntimeBrowserControl {
            locator: Arc::new(MockRuntimeLocator),
            client: client.clone(),
            endpoints: Mutex::new(HashMap::new()),
        };

        control
            .start_streams(session.workspace_id.clone(), session.id.clone())
            .await
            .expect("start mocked streams");
        tokio::time::timeout(std::time::Duration::from_secs(2), frames.changed())
            .await
            .expect("frame timeout")
            .expect("frame channel");
        assert_eq!(
            frames.borrow().as_deref().map(Vec::as_slice),
            Some(&[1, 2, 3][..])
        );

        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                let failed = gateway()
                    .session_for_account(&format!("acct-{unique}"), &session.id)
                    .is_ok_and(|summary| summary.state == "failed");
                if failed && Arc::strong_count(&client) == 2 {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("media and input pumps must terminate after failure");
        let operations = client.operations.lock().clone();
        assert!(operations.contains(&"browser.screencast.start".to_string()));
        assert!(operations.contains(&"browser.screencast.ack".to_string()));
    }

    #[test]
    fn concurrent_session_creation_atomically_enforces_workspace_quota() {
        let (gateway, _) = fixture();
        let gateway = Arc::new(gateway);
        let barrier = Arc::new(Barrier::new(12));
        let handles = (0..12)
            .map(|index| {
                let gateway = Arc::clone(&gateway);
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    gateway.ensure_session(EnsureBrowserSession {
                        account_id: "acct-1".into(),
                        device_id: format!("device-{index}"),
                        chat_session_id: format!("chat-{index}"),
                        parent_chat_session_id: None,
                        workspace_id: "workspace-1".into(),
                        backend: BrowserBackend::RemoteChromium,
                        profile_id: None,
                    })
                })
            })
            .collect::<Vec<_>>();
        let results = handles
            .into_iter()
            .map(|handle| handle.join().expect("worker"))
            .collect::<Vec<_>>();

        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 3);
        assert!(results
            .iter()
            .filter_map(|result| result.as_ref().err())
            .all(|error| error.code == "browser_session_quota_exceeded"));
        assert_eq!(gateway.sessions.lock().len(), 3);
    }

    #[test]
    fn concurrent_same_chat_and_profile_creation_reuses_or_rejects_atomically() {
        let (gateway, _) = fixture();
        let gateway = Arc::new(gateway);
        let barrier = Arc::new(Barrier::new(8));
        let handles = (0..8)
            .map(|_| {
                let gateway = Arc::clone(&gateway);
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    gateway.ensure_session(EnsureBrowserSession {
                        account_id: "acct-1".into(),
                        device_id: "device-shared".into(),
                        chat_session_id: "chat-shared".into(),
                        parent_chat_session_id: None,
                        workspace_id: "workspace-1".into(),
                        backend: BrowserBackend::RemoteChromium,
                        profile_id: Some("profile-1".into()),
                    })
                })
            })
            .collect::<Vec<_>>();
        let session_ids = handles
            .into_iter()
            .map(|handle| handle.join().expect("worker").expect("reused session").id)
            .collect::<std::collections::HashSet<_>>();

        assert_eq!(session_ids.len(), 1);
        assert_eq!(gateway.sessions.lock().len(), 1);
        assert_eq!(gateway.profile_owners.lock().len(), 1);
    }

    #[test]
    fn browser_session_is_bound_to_its_creating_principal() {
        let (gateway, _) = fixture();
        let session = gateway
            .ensure_session(EnsureBrowserSession {
                account_id: "acct-1".into(),
                device_id: "device-1".into(),
                chat_session_id: "chat-1".into(),
                parent_chat_session_id: None,
                workspace_id: "workspace-1".into(),
                backend: BrowserBackend::RemoteChromium,
                profile_id: None,
            })
            .expect("session");
        assert!(gateway
            .session_for_principal("acct-1", "device-1", &session.id)
            .is_ok());
        assert_eq!(
            gateway
                .session_for_principal("acct-2", "device-1", &session.id)
                .unwrap_err()
                .code,
            "browser_session_forbidden"
        );
        assert_eq!(
            gateway
                .session_for_principal("acct-1", "device-2", &session.id)
                .unwrap_err()
                .code,
            "browser_session_forbidden"
        );
    }

    #[test]
    fn active_session_cannot_be_reused_by_another_device() {
        let (gateway, _) = fixture();
        let session = gateway
            .ensure_session(EnsureBrowserSession {
                account_id: "acct-1".into(),
                device_id: "device-1".into(),
                chat_session_id: "chat-1".into(),
                parent_chat_session_id: None,
                workspace_id: "workspace-1".into(),
                backend: BrowserBackend::RemoteChromium,
                profile_id: None,
            })
            .unwrap();
        let reused = gateway.ensure_session(EnsureBrowserSession {
            account_id: "acct-1".into(),
            device_id: "device-2".into(),
            chat_session_id: "chat-1".into(),
            parent_chat_session_id: None,
            workspace_id: "workspace-1".into(),
            backend: BrowserBackend::RemoteChromium,
            profile_id: None,
        });

        assert_eq!(reused.unwrap_err().code, "browser_session_forbidden");
        assert_eq!(
            gateway
                .session_for_principal("acct-1", "device-1", &session.id)
                .unwrap()
                .id,
            session.id
        );
    }

    #[test]
    fn human_takeover_preempts_agent_and_stale_epochs_are_rejected() {
        let (gateway, now) = fixture();
        let session = gateway
            .ensure_session(EnsureBrowserSession {
                account_id: "acct-1".into(),
                device_id: "device-1".into(),
                chat_session_id: "chat-1".into(),
                parent_chat_session_id: None,
                workspace_id: "workspace-1".into(),
                backend: BrowserBackend::RemoteChromium,
                profile_id: None,
            })
            .unwrap();
        let mut events = gateway.subscribe_events(&session.id).unwrap();
        let agent = gateway.acquire_agent_lease(&session.id, "agent-1").unwrap();
        assert_eq!(events.try_recv().unwrap()["kind"], "control.changed");
        let mut cancellations = gateway.subscribe_input(&session.id).unwrap();
        let human = gateway
            .takeover_and_cancel(&session.id, "device-1")
            .unwrap();
        assert!(human.epoch > agent.epoch);
        let cancellation = cancellations.try_recv().unwrap();
        assert_eq!(cancellation.epoch, human.epoch);
        assert_eq!(cancellation.input["kind"], "cancel");
        let control_event = events.try_recv().unwrap();
        assert_eq!(control_event["kind"], "control.changed");
        assert_eq!(control_event["lease"]["epoch"], human.epoch);
        assert!(!gateway.validate_input(&session.id, agent.epoch, "agent-1"));
        assert!(gateway.validate_input(&session.id, human.epoch, "device-1"));

        now.store(31_001, Ordering::Relaxed);
        assert!(!gateway.validate_input(&session.id, human.epoch, "device-1"));
    }

    #[test]
    fn parent_chat_reuses_binding_and_workspace_quota_is_enforced() {
        let (gateway, _) = fixture();
        let base = EnsureBrowserSession {
            account_id: "acct-1".into(),
            device_id: "device-1".into(),
            chat_session_id: "chat-parent".into(),
            parent_chat_session_id: None,
            workspace_id: "workspace-1".into(),
            backend: BrowserBackend::RemoteChromium,
            profile_id: None,
        };
        let parent = gateway.ensure_session(base.clone()).unwrap();
        let child = gateway
            .ensure_session(EnsureBrowserSession {
                chat_session_id: "chat-child".into(),
                parent_chat_session_id: Some("chat-parent".into()),
                ..base.clone()
            })
            .unwrap();
        assert_eq!(child.id, parent.id);

        for chat in ["chat-2", "chat-3"] {
            gateway
                .ensure_session(EnsureBrowserSession {
                    chat_session_id: chat.into(),
                    ..base.clone()
                })
                .unwrap();
        }
        assert_eq!(
            gateway
                .ensure_session(EnsureBrowserSession {
                    chat_session_id: "chat-4".into(),
                    ..base
                })
                .unwrap_err()
                .code,
            "browser_session_quota_exceeded"
        );
    }

    #[test]
    fn runtime_failure_releases_profile_and_parent_binding() {
        let (gateway, _) = fixture();
        let input = EnsureBrowserSession {
            account_id: "acct-1".into(),
            device_id: "device-1".into(),
            chat_session_id: "chat-1".into(),
            parent_chat_session_id: None,
            workspace_id: "workspace-1".into(),
            backend: BrowserBackend::RemoteChromium,
            profile_id: Some("qa-login".into()),
        };
        let failed = gateway.ensure_session(input.clone()).unwrap();
        gateway.mark_failed(&failed.id);

        let replacement = gateway.ensure_session(input).unwrap();
        assert_ne!(replacement.id, failed.id);
    }

    #[test]
    fn session_activity_renews_idle_ttl_but_never_exceeds_max_lifetime() {
        let (gateway, now) = fixture();
        let session = gateway
            .ensure_session(EnsureBrowserSession {
                account_id: "acct-1".into(),
                device_id: "device-1".into(),
                chat_session_id: "chat-1".into(),
                parent_chat_session_id: None,
                workspace_id: "workspace-1".into(),
                backend: BrowserBackend::RemoteChromium,
                profile_id: Some("profile-1".into()),
            })
            .unwrap();

        now.store(1_700_000, Ordering::Relaxed);
        gateway.touch_session(&session.id);
        now.store(1_801_001, Ordering::Relaxed);
        assert!(gateway.drain_expired().is_empty());

        now.store(28_801_001, Ordering::Relaxed);
        let expired = gateway.drain_expired();
        assert_eq!(expired.len(), 1);
        assert_eq!(expired[0].id, session.id);

        let replacement = gateway
            .ensure_session(EnsureBrowserSession {
                account_id: "acct-1".into(),
                device_id: "device-1".into(),
                chat_session_id: "chat-1".into(),
                parent_chat_session_id: None,
                workspace_id: "workspace-1".into(),
                backend: BrowserBackend::RemoteChromium,
                profile_id: Some("profile-1".into()),
            })
            .unwrap();
        assert_ne!(replacement.id, session.id);
    }

    #[tokio::test]
    async fn runtime_status_never_claims_health_without_a_live_probe() {
        let status = browser_runtime_status(Some("workspace-status-test")).await;
        assert_eq!(status.compiled, cfg!(feature = "workspace-runtime-exec"));
        assert!(!status.healthy);
        assert_eq!(
            status.workspace_id.as_deref(),
            Some("workspace-status-test")
        );
        assert!(status.reason.is_some());
    }
}

//! Selkies stream grants for local Docker CUA desktops (ADR-0234 Phase 4).
//!
//! An opt-in image variant runs Selkies beside the desktop in Secure Mode. The
//! Host owns its session table: every viewer gets a fresh view-only token, and
//! only the viewer holding the fenced control lease is ever handed a
//! controller token (`mk_control`). Selkies replaces the whole table on each
//! `POST /api/tokens`, so this module is the table's single writer per
//! connection, behind its own mutex: opening a viewer never waits behind an
//! agent action that holds the desktop guard.
//!
//! Giving control up is ordered. The controller token leaves the table, then
//! the Host confirms through `GET /api/sessions` that no controller session is
//! still connected, closing any that linger. Only a confirmed revocation lets
//! the lease be released or the agent act. A revocation that cannot be
//! confirmed keeps the desktop refused to the agent and is retried on every
//! admission.
//!
//! Input sent through Selkies never passes through the Host, so the per-input
//! audit rows of the polled viewer do not exist for it. Grants and
//! revocations are audited instead, by role only, never by token or URL.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use cognia_remote_desktop::audit;
use serde::Serialize;
use serde_json::{json, Map, Value};
use tokio::sync::Mutex;

use super::lifecycle::{docker_stream_endpoint, StreamEndpoint};
use super::CuaSandboxRegistry;
use crate::automation::types::{AutomationError, Result};

/// Viewer grants per connection; the oldest viewer is evicted beyond this.
pub const MAX_VIEWERS: usize = 8;
/// The refusal a renderer reads as "this desktop has no stream".
pub const STREAM_UNAVAILABLE: &str = "sandbox_stream_unavailable";
const PRINCIPAL: &str = "local-owner";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StreamRole {
    Viewer,
    Controller,
}

/// What a viewer loads: the Selkies page on loopback with its session token.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamGrant {
    pub viewer_id: String,
    pub url: String,
    pub role: StreamRole,
}

/// One connected Selkies page, as `GET /api/sessions` lists it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SelkiesSession {
    pub id: String,
    pub role: String,
}

#[async_trait]
pub(crate) trait SelkiesApi: Send + Sync {
    /// `POST /api/tokens`: replace the whole session table.
    async fn replace_tokens(&self, table: &Value) -> Result<()>;
    /// `GET /api/sessions`.
    async fn sessions(&self) -> Result<Vec<SelkiesSession>>;
    /// `DELETE /api/sessions/{id}`.
    async fn disconnect(&self, session_id: &str) -> Result<()>;
}

/// How the registry finds a container's stream and talks to it. Docker and
/// HTTP in the app; a fake in tests.
#[async_trait]
pub(crate) trait StreamBackend: Send + Sync {
    async fn endpoint(&self, container: &str) -> Result<Option<StreamEndpoint>>;
    fn api(&self, endpoint: &StreamEndpoint) -> Result<Arc<dyn SelkiesApi>>;
}

#[derive(Clone)]
pub(crate) struct StreamBackendHandle(pub(crate) Arc<dyn StreamBackend>);

impl Default for StreamBackendHandle {
    fn default() -> Self {
        Self(Arc::new(DockerStreamBackend))
    }
}

struct DockerStreamBackend;

#[async_trait]
impl StreamBackend for DockerStreamBackend {
    async fn endpoint(&self, container: &str) -> Result<Option<StreamEndpoint>> {
        docker_stream_endpoint(container).await
    }
    fn api(&self, endpoint: &StreamEndpoint) -> Result<Arc<dyn SelkiesApi>> {
        Ok(Arc::new(HttpSelkies::new(endpoint)?))
    }
}

struct HttpSelkies {
    base: String,
    master: String,
    client: reqwest::Client,
}

impl HttpSelkies {
    fn new(endpoint: &StreamEndpoint) -> Result<Self> {
        let base = format!("http://127.0.0.1:{}", endpoint.port);
        let builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(5));
        let client = cognia_net::proxy_config::managed_client(builder, &base)
            .map_err(|_| backend("could not prepare the desktop stream client"))?;
        Ok(Self {
            base,
            master: endpoint.master_token.clone(),
            client,
        })
    }
    fn bearer(&self) -> Result<reqwest::header::HeaderValue> {
        let mut value = reqwest::header::HeaderValue::from_str(&format!("Bearer {}", self.master))
            .map_err(|_| backend("invalid desktop stream credential"))?;
        value.set_sensitive(true);
        Ok(value)
    }
}

#[async_trait]
impl SelkiesApi for HttpSelkies {
    async fn replace_tokens(&self, table: &Value) -> Result<()> {
        let response = self
            .client
            .post(format!("{}/api/tokens", self.base))
            .header(reqwest::header::AUTHORIZATION, self.bearer()?)
            .json(table)
            .send()
            .await
            .map_err(|_| backend("the desktop stream is not answering"))?;
        if !response.status().is_success() {
            return Err(backend(format!(
                "the desktop stream refused its session table ({})",
                response.status().as_u16()
            )));
        }
        Ok(())
    }
    async fn sessions(&self) -> Result<Vec<SelkiesSession>> {
        let response = self
            .client
            .get(format!("{}/api/sessions", self.base))
            .header(reqwest::header::AUTHORIZATION, self.bearer()?)
            .send()
            .await
            .map_err(|_| backend("the desktop stream is not answering"))?;
        if !response.status().is_success() {
            return Err(backend("the desktop stream refused its session list"));
        }
        let body = response
            .bytes()
            .await
            .map_err(|_| backend("the desktop stream session list was cut off"))?;
        if body.len() > 256 * 1024 {
            return Err(backend("the desktop stream session list is too large"));
        }
        parse_sessions(&body)
    }
    async fn disconnect(&self, session_id: &str) -> Result<()> {
        let mut url = reqwest::Url::parse(&format!("{}/api/sessions/", self.base))
            .map_err(|_| backend("invalid desktop stream address"))?;
        url.path_segments_mut()
            .map_err(|_| backend("invalid desktop stream address"))?
            .pop_if_empty()
            .push(session_id);
        let response = self
            .client
            .delete(url)
            .header(reqwest::header::AUTHORIZATION, self.bearer()?)
            .send()
            .await
            .map_err(|_| backend("the desktop stream is not answering"))?;
        // Gone already is what a disconnect wants.
        if response.status().is_success() || response.status().as_u16() == 404 {
            return Ok(());
        }
        Err(backend("the desktop stream refused to close a session"))
    }
}

fn parse_sessions(body: &[u8]) -> Result<Vec<SelkiesSession>> {
    let value: Value =
        serde_json::from_slice(body).map_err(|_| backend("invalid desktop stream session list"))?;
    let sessions = value
        .get("sessions")
        .and_then(Value::as_array)
        .ok_or_else(|| backend("invalid desktop stream session list"))?;
    Ok(sessions
        .iter()
        .filter_map(|session| {
            Some(SelkiesSession {
                id: session.get("id")?.as_str()?.to_owned(),
                role: session.get("role")?.as_str()?.to_owned(),
            })
        })
        .collect())
}

/// How long revocation waits for Selkies to drop a controller session.
#[derive(Clone, Copy, Debug)]
pub(crate) struct ConfirmTiming {
    pub poll: Duration,
    pub before_disconnect: Duration,
    pub after_disconnect: Duration,
}

impl Default for ConfirmTiming {
    fn default() -> Self {
        Self {
            poll: Duration::from_millis(100),
            before_disconnect: Duration::from_secs(3),
            after_disconnect: Duration::from_secs(2),
        }
    }
}

struct Viewer {
    id: String,
    token: String,
    role: StreamRole,
}

/// The table this Host provisioned, and what it is still unsure of.
#[derive(Default)]
pub(crate) struct StreamState {
    endpoint: Option<StreamEndpoint>,
    viewers: Vec<Viewer>,
    /// A controller token left the table; its session is not yet confirmed gone.
    revoke_pending: bool,
    pub(crate) timing: ConfirmTiming,
}

fn backend(message: impl Into<String>) -> AutomationError {
    AutomationError::BackendError {
        message: message.into(),
    }
}
fn denied(reason: impl Into<String>) -> AutomationError {
    AutomationError::PermissionDenied {
        reason: reason.into(),
    }
}
fn secret() -> String {
    hex::encode(rand::random::<[u8; 32]>())
}

impl StreamState {
    /// The whole table, as Selkies takes it.
    fn table(&self) -> Value {
        let mut table = Map::new();
        for viewer in &self.viewers {
            let grant = match viewer.role {
                StreamRole::Viewer => json!({"role": "viewer", "slot": null}),
                StreamRole::Controller => {
                    json!({"role": "controller", "slot": null, "mk_control": true})
                }
            };
            table.insert(viewer.token.clone(), grant);
        }
        Value::Object(table)
    }

    fn grant(&self, viewer: &Viewer) -> Result<StreamGrant> {
        let endpoint = self
            .endpoint
            .as_ref()
            .ok_or_else(|| backend(STREAM_UNAVAILABLE))?;
        Ok(StreamGrant {
            viewer_id: viewer.id.clone(),
            url: format!("http://127.0.0.1:{}/?token={}", endpoint.port, viewer.token),
            role: viewer.role,
        })
    }

    pub(crate) fn needs_settling(&self) -> bool {
        self.revoke_pending || self.viewers.iter().any(|v| v.role == StreamRole::Controller)
    }

    async fn open(&mut self, api: &dyn SelkiesApi) -> Result<StreamGrant> {
        if self.viewers.len() >= MAX_VIEWERS {
            if let Some(at) = self
                .viewers
                .iter()
                .position(|v| v.role == StreamRole::Viewer)
            {
                self.viewers.remove(at);
            } else {
                return Err(denied("too many desktop stream viewers"));
            }
        }
        let viewer = Viewer {
            id: uuid::Uuid::new_v4().to_string(),
            token: secret(),
            role: StreamRole::Viewer,
        };
        self.viewers.push(viewer);
        if let Err(error) = api.replace_tokens(&self.table()).await {
            self.viewers.pop();
            return Err(error);
        }
        self.grant(self.viewers.last().expect("pushed above"))
    }

    /// Hand the controller role to one viewer. Any other controller is
    /// revoked and confirmed first, so two never coexist.
    async fn claim(&mut self, api: &dyn SelkiesApi, viewer_id: &str) -> Result<StreamGrant> {
        if !self.viewers.iter().any(|v| v.id == viewer_id) {
            return Err(denied("desktop stream viewer is not open"));
        }
        if self
            .viewers
            .iter()
            .any(|v| v.role == StreamRole::Controller && v.id != viewer_id)
            || self.revoke_pending
        {
            self.revoke(api).await?;
        }
        let at = self
            .viewers
            .iter()
            .position(|v| v.id == viewer_id)
            .ok_or_else(|| denied("desktop stream viewer is not open"))?;
        // A fresh token: the viewer token this page held never gains control.
        let previous = std::mem::replace(
            &mut self.viewers[at],
            Viewer {
                id: viewer_id.to_owned(),
                token: secret(),
                role: StreamRole::Controller,
            },
        );
        if let Err(error) = api.replace_tokens(&self.table()).await {
            self.viewers[at] = previous;
            return Err(error);
        }
        self.grant(&self.viewers[at])
    }

    /// Take the controller token out of the table and confirm its session is
    /// gone. Errors leave `revoke_pending` set, which keeps the agent out.
    async fn revoke(&mut self, api: &dyn SelkiesApi) -> Result<bool> {
        let had_controller = self.viewers.iter().any(|v| v.role == StreamRole::Controller);
        if !had_controller && !self.revoke_pending {
            return Ok(false);
        }
        self.viewers.retain(|v| v.role != StreamRole::Controller);
        self.revoke_pending = true;
        api.replace_tokens(&self.table()).await?;
        self.confirm(api).await?;
        self.revoke_pending = false;
        Ok(had_controller)
    }

    async fn confirm(&self, api: &dyn SelkiesApi) -> Result<()> {
        let timing = self.timing;
        if wait_for_no_controller(api, timing.poll, timing.before_disconnect).await? {
            return Ok(());
        }
        for session in api.sessions().await? {
            if session.role == "controller" {
                api.disconnect(&session.id).await?;
            }
        }
        if wait_for_no_controller(api, timing.poll, timing.after_disconnect).await? {
            return Ok(());
        }
        Err(denied(
            "the desktop stream still has a controller connected; control stays with the human until it is confirmed gone",
        ))
    }

    async fn close(&mut self, api: &dyn SelkiesApi, viewer_id: &str) -> Result<()> {
        let Some(at) = self.viewers.iter().position(|v| v.id == viewer_id) else {
            return Ok(());
        };
        if self.viewers[at].role == StreamRole::Controller {
            self.revoke(api).await?;
            return Ok(());
        }
        let removed = self.viewers.remove(at);
        if let Err(error) = api.replace_tokens(&self.table()).await {
            self.viewers.insert(at, removed);
            return Err(error);
        }
        Ok(())
    }

    /// Empty the table: nothing provisioned before this point keeps a session.
    async fn reset(&mut self, api: &dyn SelkiesApi) -> Result<()> {
        self.viewers.clear();
        self.revoke_pending = true;
        api.replace_tokens(&Value::Object(Map::new())).await?;
        self.confirm(api).await?;
        self.revoke_pending = false;
        Ok(())
    }
}

async fn wait_for_no_controller(
    api: &dyn SelkiesApi,
    poll: Duration,
    budget: Duration,
) -> Result<bool> {
    let deadline = tokio::time::Instant::now() + budget;
    loop {
        if !api.sessions().await?.iter().any(|s| s.role == "controller") {
            return Ok(true);
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(false);
        }
        tokio::time::sleep(poll).await;
    }
}

fn audit_stream(target: &str, kind: &str, decision: &str, fence: u64, role: Option<StreamRole>) {
    audit::record_background(
        kind,
        "sandbox",
        target,
        PRINCIPAL,
        decision,
        fence,
        match role {
            Some(role) => json!({ "role": role }),
            None => json!({}),
        },
    );
}

pub(crate) type StreamSlots = Arc<Mutex<HashMap<String, Arc<Mutex<StreamState>>>>>;

impl CuaSandboxRegistry {
    async fn stream_slot(&self, id: &str) -> Arc<Mutex<StreamState>> {
        self.streams
            .lock()
            .await
            .entry(id.to_owned())
            .or_default()
            .clone()
    }

    /// The live stream of a running connection, resolved once per container
    /// lifetime. A first resolution empties whatever table Selkies kept.
    async fn stream_ready(
        &self,
        id: &str,
        state: &mut StreamState,
    ) -> Result<Arc<dyn SelkiesApi>> {
        if let Some(endpoint) = &state.endpoint {
            return self.stream_backend.0.api(endpoint);
        }
        let (name, _) = self.require_running(id).await?;
        let endpoint = self
            .stream_backend
            .0
            .endpoint(&name)
            .await?
            .ok_or_else(|| backend(STREAM_UNAVAILABLE))?;
        let api = self.stream_backend.0.api(&endpoint)?;
        state.endpoint = Some(endpoint);
        if let Err(error) = state.reset(api.as_ref()).await {
            state.endpoint = None;
            return Err(error);
        }
        Ok(api)
    }

    /// A view-only grant for one more viewer.
    pub async fn stream_open(&self, id: &str) -> Result<StreamGrant> {
        let slot = self.stream_slot(id).await;
        let mut state = slot.lock().await;
        let api = self.stream_ready(id, &mut state).await?;
        let grant = state.open(api.as_ref()).await?;
        audit_stream(id, "remote_desktop.stream.open", "allowed", 0, Some(grant.role));
        Ok(grant)
    }

    /// The controller role for the viewer of the human holding the lease.
    pub async fn stream_claim(
        &self,
        id: &str,
        viewer_id: &str,
        token: &str,
        fence: u64,
    ) -> Result<StreamGrant> {
        let mut desktop = self.desktop_guard(id).await;
        desktop.require_control_lease(token, fence)?;
        let slot = self.stream_slot(id).await;
        let mut state = slot.lock().await;
        let api = self.stream_ready(id, &mut state).await?;
        match state.claim(api.as_ref(), viewer_id).await {
            Ok(grant) => {
                audit_stream(id, "remote_desktop.stream.claim", "allowed", fence, Some(grant.role));
                Ok(grant)
            }
            Err(error) => {
                if state.revoke_pending {
                    audit_stream(id, "remote_desktop.stream.revoke_unconfirmed", "refused", fence, None);
                }
                Err(error)
            }
        }
    }

    pub async fn stream_close(&self, id: &str, viewer_id: &str) -> Result<()> {
        let slot = self.stream_slot(id).await;
        let mut state = slot.lock().await;
        let Some(endpoint) = state.endpoint.clone() else {
            return Ok(());
        };
        let api = self.stream_backend.0.api(&endpoint)?;
        let was_controller = state.needs_settling();
        let result = state.close(api.as_ref(), viewer_id).await;
        if was_controller && !state.needs_settling() {
            audit_stream(id, "remote_desktop.stream.revoke", "allowed", 0, None);
        }
        result
    }

    /// Revoke any controller grant and confirm it, before the lease is
    /// released or the agent is admitted. Called with the desktop guard held.
    pub(crate) async fn stream_settle(&self, id: &str, fence: u64) -> Result<()> {
        let slot = self.stream_slot(id).await;
        let mut state = slot.lock().await;
        if !state.needs_settling() {
            return Ok(());
        }
        let Some(endpoint) = state.endpoint.clone() else {
            // Nothing was ever provisioned in this process for this container.
            state.revoke_pending = false;
            state.viewers.clear();
            return Ok(());
        };
        let api = self.stream_backend.0.api(&endpoint)?;
        match state.revoke(api.as_ref()).await {
            Ok(_) => {
                audit_stream(id, "remote_desktop.stream.revoke", "allowed", fence, None);
                Ok(())
            }
            Err(error) => {
                audit_stream(id, "remote_desktop.stream.revoke_unconfirmed", "refused", fence, None);
                Err(error)
            }
        }
    }

    /// Lifecycle changed the container: forget the grants and endpoint.
    pub(crate) async fn stream_forget(&self, id: &str) {
        let slot = self.stream_slot(id).await;
        let mut state = slot.lock().await;
        let timing = state.timing;
        *state = StreamState {
            timing,
            ..StreamState::default()
        };
    }

    /// After a (re)connect, empty any table a running Selkies kept from before,
    /// such as one provisioned by a previous app run. A Selkies that is not
    /// up yet has no table to empty; the first viewer resets it anyway.
    pub(crate) async fn stream_reset_on_connect(&self, id: &str, container: &str) {
        let slot = self.stream_slot(id).await;
        let mut state = slot.lock().await;
        // A driver reconnect while viewers are live must not cut them off.
        if state.endpoint.is_some() {
            return;
        }
        let endpoint = match self.stream_backend.0.endpoint(container).await {
            Ok(Some(endpoint)) => endpoint,
            Ok(None) => return,
            Err(error) => {
                log::warn!("desktop stream endpoint unavailable after connect: {error}");
                return;
            }
        };
        let Ok(api) = self.stream_backend.0.api(&endpoint) else {
            return;
        };
        match state.reset(api.as_ref()).await {
            Ok(()) => state.endpoint = Some(endpoint),
            Err(error) => log::debug!("desktop stream table not reset on connect: {error}"),
        }
    }
}

#[cfg(test)]
pub(crate) mod testing {
    use super::*;
    use std::sync::Mutex as StdMutex;

    /// A Selkies that records every table and drops removed controllers after
    /// `lingering` session listings.
    #[derive(Default)]
    pub(crate) struct FakeSelkies {
        pub tables: StdMutex<Vec<Value>>,
        pub sessions: StdMutex<Vec<SelkiesSession>>,
        pub disconnected: StdMutex<Vec<String>>,
        pub lingering: StdMutex<usize>,
        pub refuse_disconnect_effect: bool,
        pub fail_replace: StdMutex<bool>,
    }

    #[async_trait]
    impl SelkiesApi for FakeSelkies {
        async fn replace_tokens(&self, table: &Value) -> Result<()> {
            if *self.fail_replace.lock().unwrap() {
                return Err(backend("down"));
            }
            self.tables.lock().unwrap().push(table.clone());
            if !table
                .as_object()
                .unwrap()
                .values()
                .any(|grant| grant["role"] == "controller")
            {
                let lingering = self.lingering.lock().unwrap();
                if *lingering == 0 {
                    self.sessions.lock().unwrap().retain(|s| s.role != "controller");
                }
            }
            Ok(())
        }
        async fn sessions(&self) -> Result<Vec<SelkiesSession>> {
            let mut lingering = self.lingering.lock().unwrap();
            if *lingering > 0 {
                *lingering -= 1;
                if *lingering == 0 {
                    self.sessions.lock().unwrap().retain(|s| s.role != "controller");
                }
            }
            Ok(self.sessions.lock().unwrap().clone())
        }
        async fn disconnect(&self, session_id: &str) -> Result<()> {
            self.disconnected.lock().unwrap().push(session_id.into());
            if !self.refuse_disconnect_effect {
                self.sessions.lock().unwrap().retain(|s| s.id != session_id);
            }
            Ok(())
        }
    }

    /// Every container has the same fake stream.
    pub(crate) struct FakeBackend(pub Arc<FakeSelkies>);

    #[async_trait]
    impl StreamBackend for FakeBackend {
        async fn endpoint(&self, _container: &str) -> Result<Option<StreamEndpoint>> {
            Ok(Some(endpoint()))
        }
        fn api(&self, _endpoint: &StreamEndpoint) -> Result<Arc<dyn SelkiesApi>> {
            Ok(self.0.clone())
        }
    }

    pub(crate) fn endpoint() -> StreamEndpoint {
        StreamEndpoint {
            port: 49_000,
            master_token: "m".repeat(64),
        }
    }

    impl CuaSandboxRegistry {
        /// Route this registry's streams to a fake, with the endpoint of `id`
        /// already resolved so no Docker call is needed.
        pub(crate) async fn with_fake_stream(mut self, id: &str, api: Arc<FakeSelkies>) -> Self {
            self.stream_backend = StreamBackendHandle(Arc::new(FakeBackend(api)));
            let slot = self.stream_slot(id).await;
            let mut state = slot.lock().await;
            state.endpoint = Some(endpoint());
            state.timing = ConfirmTiming {
                poll: Duration::from_millis(1),
                before_disconnect: Duration::from_millis(5),
                after_disconnect: Duration::from_millis(5),
            };
            drop(state);
            self
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testing::FakeSelkies;
    use super::*;

    fn fast() -> ConfirmTiming {
        ConfirmTiming {
            poll: Duration::from_millis(1),
            before_disconnect: Duration::from_millis(5),
            after_disconnect: Duration::from_millis(5),
        }
    }

    fn state() -> StreamState {
        StreamState {
            endpoint: Some(StreamEndpoint {
                port: 49_000,
                master_token: "m".repeat(64),
            }),
            timing: fast(),
            ..StreamState::default()
        }
    }

    fn roles(table: &Value) -> Vec<String> {
        let mut roles: Vec<String> = table
            .as_object()
            .unwrap()
            .values()
            .map(|g| g["role"].as_str().unwrap().to_owned())
            .collect();
        roles.sort();
        roles
    }

    #[tokio::test]
    async fn viewers_get_fresh_view_only_tokens_and_the_whole_table_is_posted() {
        let api = FakeSelkies::default();
        let mut state = state();
        let first = state.open(&api).await.unwrap();
        let second = state.open(&api).await.unwrap();
        assert_eq!(first.role, StreamRole::Viewer);
        assert!(first.url.starts_with("http://127.0.0.1:49000/?token="));
        assert_ne!(first.url, second.url);
        let tables = api.tables.lock().unwrap();
        assert_eq!(roles(&tables[1]), ["viewer", "viewer"]);
        assert!(tables[1].as_object().unwrap().values().all(|g| g["slot"].is_null()));
    }

    #[tokio::test]
    async fn the_oldest_viewer_is_evicted_past_the_cap() {
        let api = FakeSelkies::default();
        let mut state = state();
        let first = state.open(&api).await.unwrap();
        for _ in 1..MAX_VIEWERS {
            state.open(&api).await.unwrap();
        }
        state.open(&api).await.unwrap();
        assert_eq!(state.viewers.len(), MAX_VIEWERS);
        assert!(!state.viewers.iter().any(|v| v.id == first.viewer_id));
    }

    #[tokio::test]
    async fn claiming_mints_a_new_controller_token_and_drops_the_viewer_one() {
        let api = FakeSelkies::default();
        let mut state = state();
        let viewer = state.open(&api).await.unwrap();
        let other = state.open(&api).await.unwrap();
        let controller = state.claim(&api, &viewer.viewer_id).await.unwrap();
        assert_eq!(controller.role, StreamRole::Controller);
        assert_eq!(controller.viewer_id, viewer.viewer_id);
        assert_ne!(controller.url, viewer.url);
        let table = api.tables.lock().unwrap().last().unwrap().clone();
        assert_eq!(roles(&table), ["controller", "viewer"]);
        let old_token = viewer.url.split("token=").nth(1).unwrap();
        assert!(table.get(old_token).is_none(), "the view token never gains control");
        let controller_grant = table
            .get(controller.url.split("token=").nth(1).unwrap())
            .unwrap();
        assert_eq!(controller_grant["mk_control"], true);
        assert!(state.claim(&api, "nobody").await.is_err());
        // A second claim moves control; the first controller is revoked first.
        state.claim(&api, &other.viewer_id).await.unwrap();
        let table = api.tables.lock().unwrap().last().unwrap().clone();
        assert_eq!(roles(&table), ["controller"]);
    }

    #[tokio::test]
    async fn revocation_waits_for_the_controller_session_to_leave() {
        let api = FakeSelkies::default();
        let mut state = state();
        let viewer = state.open(&api).await.unwrap();
        state.claim(&api, &viewer.viewer_id).await.unwrap();
        api.sessions.lock().unwrap().push(SelkiesSession {
            id: "s1".into(),
            role: "controller".into(),
        });
        *api.lingering.lock().unwrap() = 2;
        assert!(state.revoke(&api).await.unwrap());
        assert!(!state.needs_settling());
        assert!(api.disconnected.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_lingering_controller_is_disconnected_then_confirmed() {
        let api = FakeSelkies::default();
        let mut state = state();
        let viewer = state.open(&api).await.unwrap();
        state.claim(&api, &viewer.viewer_id).await.unwrap();
        api.sessions.lock().unwrap().push(SelkiesSession {
            id: "s1".into(),
            role: "controller".into(),
        });
        *api.lingering.lock().unwrap() = 10_000;
        state.revoke(&api).await.unwrap();
        assert_eq!(*api.disconnected.lock().unwrap(), ["s1"]);
        assert!(!state.needs_settling());
    }

    #[tokio::test]
    async fn an_unconfirmed_revocation_stays_pending() {
        let api = FakeSelkies {
            refuse_disconnect_effect: true,
            ..FakeSelkies::default()
        };
        let mut state = state();
        let viewer = state.open(&api).await.unwrap();
        state.claim(&api, &viewer.viewer_id).await.unwrap();
        api.sessions.lock().unwrap().push(SelkiesSession {
            id: "s1".into(),
            role: "controller".into(),
        });
        *api.lingering.lock().unwrap() = 10_000;
        assert!(state.revoke(&api).await.is_err());
        assert!(state.needs_settling());
        // A claim cannot hand out control while the old one may still be live.
        let next = state.open(&api).await.unwrap();
        assert!(state.claim(&api, &next.viewer_id).await.is_err());
        // Once the session is gone, the next attempt confirms.
        api.sessions.lock().unwrap().clear();
        *api.lingering.lock().unwrap() = 0;
        state.revoke(&api).await.unwrap();
        assert!(!state.needs_settling());
    }

    #[tokio::test]
    async fn closing_a_viewer_or_the_controller_updates_the_table() {
        let api = FakeSelkies::default();
        let mut state = state();
        let viewer = state.open(&api).await.unwrap();
        let controller = state.open(&api).await.unwrap();
        state.claim(&api, &controller.viewer_id).await.unwrap();
        state.close(&api, &viewer.viewer_id).await.unwrap();
        assert_eq!(roles(api.tables.lock().unwrap().last().unwrap()), ["controller"]);
        state.close(&api, &controller.viewer_id).await.unwrap();
        assert!(api.tables.lock().unwrap().last().unwrap().as_object().unwrap().is_empty());
        state.close(&api, "unknown").await.unwrap();
    }

    #[tokio::test]
    async fn a_refused_table_rolls_the_grant_back() {
        let api = FakeSelkies::default();
        let mut state = state();
        let viewer = state.open(&api).await.unwrap();
        *api.fail_replace.lock().unwrap() = true;
        assert!(state.open(&api).await.is_err());
        assert_eq!(state.viewers.len(), 1);
        assert!(state.claim(&api, &viewer.viewer_id).await.is_err());
        assert_eq!(state.viewers[0].role, StreamRole::Viewer);
    }

    #[tokio::test]
    async fn reset_empties_the_table_and_confirms() {
        let api = FakeSelkies::default();
        let mut state = state();
        state.open(&api).await.unwrap();
        state.reset(&api).await.unwrap();
        assert!(state.viewers.is_empty());
        assert!(api.tables.lock().unwrap().last().unwrap().as_object().unwrap().is_empty());
    }

    #[test]
    fn session_lists_parse_leniently_but_need_the_envelope() {
        let sessions = parse_sessions(
            br#"{"sessions":[{"id":"a","role":"viewer","slot":null},{"id":"b","role":"controller"},{"role":"x"}]}"#,
        )
        .unwrap();
        assert_eq!(
            sessions,
            [
                SelkiesSession { id: "a".into(), role: "viewer".into() },
                SelkiesSession { id: "b".into(), role: "controller".into() },
            ]
        );
        assert!(parse_sessions(b"[]").is_err());
    }
}

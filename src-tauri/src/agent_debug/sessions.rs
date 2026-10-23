//! Desktop debug protocol admission. Lease and dedup semantics stay with their
//! existing owners; this adapter binds them to webview requests and snapshots.
use cognia_companion_security::idempotency::{IdempotencyCache, IdempotencyDecision};
use cognia_remote_desktop::control::{ControlLease, ControlLeaseCore};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

pub type Fault = (&'static str, &'static str);
pub type Result<T> = std::result::Result<T, Fault>;
const METHOD: &str = "agent-debug.operation";

#[derive(Clone, Debug)]
pub enum Identity {
    Owner,
    Client(String),
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Writer {
    pub token: String,
    pub fence: u64,
    pub operation_id: String,
}

#[derive(Clone, Debug)]
pub struct Context {
    pub identity: Identity,
    pub writer: Option<Writer>,
    pub expected_document: Option<String>,
    pub timeout_ms: Option<u64>,
}
impl Context {
    pub fn client(&self) -> Result<&str> {
        match &self.identity {
            Identity::Client(id) => Ok(id),
            Identity::Owner => Err(("client_session_required", "attach a scoped client session")),
        }
    }
}

struct Client {
    token: String,
    windows: HashSet<String>,
    write: bool,
    idle_timeout: Duration,
    touched: Instant,
}
struct Snapshot {
    document: String,
    generation: u64,
    revision: u64,
    refs: HashSet<String>,
    at: Instant,
    actionable: bool,
}
struct State {
    clients: HashMap<String, Client>,
    snapshots: HashMap<(String, String), Snapshot>,
    lease: ControlLeaseCore,
    in_flight: Option<(String, String)>,
    revision: u64,
    quarantined: bool,
    workflow_deadline: Option<Instant>,
    held_input: HashSet<String>,
    draining: bool,
    capturing: HashSet<String>,
    epoch: u64,
    recovering: bool,
    retired: HashSet<String>,
    ledger: IdempotencyCache,
}

impl Default for State {
    fn default() -> Self {
        Self {
            clients: HashMap::new(),
            snapshots: HashMap::new(),
            lease: ControlLeaseCore::default(),
            in_flight: None,
            revision: 0,
            quarantined: false,
            workflow_deadline: None,
            held_input: HashSet::new(),
            draining: false,
            capturing: HashSet::new(),
            epoch: 0,
            recovering: false,
            retired: HashSet::new(),
            ledger: IdempotencyCache::retaining_pending(128, Duration::from_secs(600)),
        }
    }
}
#[derive(Default)]
pub struct Sessions {
    state: Mutex<State>,
}

/// Removing credentials never proves that an already dispatched operation stopped.
fn revoke(state: &mut State, id: &str) -> bool {
    // status() hides expired leases; retained input still belongs to their principal.
    let owns_lease = state
        .lease
        .lease
        .as_ref()
        .is_some_and(|lease| lease.principal == id);
    let unknown = state
        .in_flight
        .as_ref()
        .is_some_and(|(owner, _)| owner == id)
        || state.capturing.contains(id)
        || (owns_lease && !state.held_input.is_empty());
    state.quarantined |= unknown;
    if owns_lease && !unknown {
        state.lease.invalidate();
    }
    let removed = state.clients.remove(id).is_some();
    if removed {
        state.retired.insert(id.to_owned());
    }
    state.snapshots.retain(|(owner, _), _| owner != id);
    removed
}
fn prune(state: &mut State) {
    let expired: Vec<_> = state
        .clients
        .iter()
        .filter(|(_, c)| c.touched.elapsed() >= c.idle_timeout)
        .map(|(id, _)| id.clone())
        .collect();
    for id in expired {
        revoke(state, &id);
    }
}
pub fn shared() -> bool {
    std::env::var("COGNIA_AGENT_DEBUG_SHARED").as_deref() == Ok("1")
}
pub fn manager() -> &'static Sessions {
    static MANAGER: OnceLock<Sessions> = OnceLock::new();
    MANAGER.get_or_init(Sessions::default)
}
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

fn save_snapshot(
    state: &mut State,
    client: &str,
    window: &str,
    value: &mut Value,
    actionable: bool,
) {
    let key = (client.to_owned(), window.to_owned());
    let generation = value["generation"].as_u64().unwrap_or(0);
    let document = value["documentId"].as_str().unwrap_or_default();
    let newer = state
        .snapshots
        .get(&key)
        .is_some_and(|old| old.document == document && old.generation > generation);
    value["actionable"] = json!(actionable && !newer);
    value["appRevision"] = json!(state.revision);
    if newer {
        return;
    }
    let snapshot = Snapshot {
        document: value["documentId"].as_str().unwrap_or_default().into(),
        generation,
        revision: state.revision,
        refs: value["nodes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|node| node["ref"].as_str().map(str::to_owned))
            .collect(),
        at: Instant::now(),
        actionable,
    };
    state.snapshots.insert(key, snapshot);
}

fn reference_document(
    state: &State,
    client: &str,
    window: &str,
    reference: &str,
    for_action: bool,
) -> Result<String> {
    let snapshot = state
        .snapshots
        .get(&(client.into(), window.into()))
        .ok_or(("stale_ref", "snapshot this session and window first"))?;
    if !snapshot.refs.contains(reference) || snapshot.at.elapsed() >= Duration::from_secs(60) {
        return Err((
            "stale_ref",
            "ref is expired or belongs to another snapshot/session",
        ));
    }
    if for_action
        && (!snapshot.actionable
            || snapshot.revision != state.revision
            || state.in_flight.is_some())
    {
        return Err((
            "stale_snapshot",
            "observe again after acquiring the app writer",
        ));
    }
    Ok(snapshot.document.clone())
}

impl Sessions {
    #[cfg(test)]
    pub fn open(&self, windows: Vec<String>, write: bool) -> Result<Value> {
        self.open_with_timeout(windows, write, None)
    }
    pub fn open_with_timeout(
        &self,
        windows: Vec<String>,
        write: bool,
        idle_timeout_ms: Option<u64>,
    ) -> Result<Value> {
        let timeout = idle_timeout_ms.unwrap_or(300_000);
        if !(1_000..=1_800_000).contains(&timeout) {
            return Err((
                "invalid_idle_timeout",
                "idleTimeoutMs must be between 1000 and 1800000",
            ));
        }
        if windows.is_empty()
            || windows.len() > 16
            || windows.iter().any(|w| w.is_empty() || w.len() > 128)
        {
            return Err(("invalid_windows", "supply 1 to 16 valid window labels"));
        }
        let mut state = self.state.lock().unwrap();
        prune(&mut state);
        if state.recovering || state.quarantined {
            return Err(("recovery_in_progress", "wait for owner recovery"));
        }
        if state.clients.len() >= 16 {
            return Err(("session_capacity", "at most 16 sessions may attach"));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        state.clients.insert(
            id.clone(),
            Client {
                token: token.clone(),
                windows: windows.iter().cloned().collect(),
                write,
                idle_timeout: Duration::from_millis(timeout),
                touched: Instant::now(),
            },
        );
        Ok(
            json!({"clientSessionId": id, "token": token, "windows": windows, "canWrite": write, "idleTimeoutMs":timeout}),
        )
    }
    pub fn authenticate(
        &self,
        token: &str,
        equals: impl Fn(&[u8], &[u8]) -> bool,
    ) -> Option<Identity> {
        let mut state = self.state.lock().unwrap();
        prune(&mut state);
        state
            .clients
            .iter_mut()
            .find(|(_, c)| equals(token.as_bytes(), c.token.as_bytes()))
            .map(|(id, c)| {
                c.touched = Instant::now();
                Identity::Client(id.clone())
            })
    }
    pub fn authorize(&self, context: &Context, window: &str) -> Result<()> {
        let state = self.state.lock().unwrap();
        let client = state
            .clients
            .get(context.client()?)
            .ok_or(("session_closed", "client session is closed"))?;
        if !client.windows.contains(window) {
            return Err(("window_scope_denied", "window is outside this session"));
        }
        Ok(())
    }
    /// Reuse the same authorization boundary around an asynchronous observation.
    pub async fn observe<T>(
        &self,
        context: &Context,
        window: &str,
        read: impl std::future::Future<Output = T>,
    ) -> Result<T> {
        self.authorize(context, window)?;
        let result = read.await;
        self.authorize(context, window)?;
        Ok(result)
    }
    pub fn windows(&self, context: &Context) -> Result<Vec<String>> {
        let state = self.state.lock().unwrap();
        Ok(state
            .clients
            .get(context.client()?)
            .ok_or(("session_closed", "session is closed"))?
            .windows
            .iter()
            .cloned()
            .collect())
    }
    pub fn acquire(&self, context: &Context) -> Result<ControlLease> {
        let id = context.client()?;
        let mut state = self.state.lock().unwrap();
        if !state.clients.get(id).is_some_and(|c| c.write) {
            return Err(("write_scope_denied", "session is observe-only"));
        }
        state.lease.expire();
        if state.lease.status().lease.is_none() && !state.held_input.is_empty() {
            state.quarantined = true;
        }
        if state.quarantined {
            return Err((
                "target_quarantined",
                "previous execution cleanup is unconfirmed",
            ));
        }
        if state.in_flight.is_some() || state.lease.status().lease.is_some() {
            return Err(("writer_busy", "another workflow holds the app writer"));
        }
        state.workflow_deadline = Some(Instant::now() + Duration::from_secs(120));
        Ok(state
            .lease
            .issue(id, now_ms(), now_ms().saturating_add(120_000)))
    }
    pub fn renew(&self, context: &Context, token: &str, fence: u64) -> Result<ControlLease> {
        let mut state = self.state.lock().unwrap();
        let remaining = state
            .workflow_deadline
            .map(|deadline| {
                deadline
                    .saturating_duration_since(Instant::now())
                    .as_millis() as i64
            })
            .unwrap_or(0);
        state
            .lease
            .renew(
                context.client()?,
                token,
                fence,
                now_ms(),
                now_ms().saturating_add(remaining),
            )
            .map_err(|_| {
                (
                    "lease_lost",
                    "writer lease expired or belongs to another session",
                )
            })
    }
    pub fn owned_lease(&self, context: &Context) -> Result<Option<ControlLease>> {
        let id = context.client()?;
        let state = self.state.lock().unwrap();
        Ok(state
            .lease
            .status()
            .lease
            .filter(|lease| lease.principal == id)
            .map(|lease| lease.dto.clone()))
    }
    pub fn drain<'a>(
        &'a self,
        context: &Context,
        token: &str,
        fence: u64,
    ) -> Result<ReleaseGuard<'a>> {
        let mut state = self.state.lock().unwrap();
        state
            .lease
            .require_lease(context.client()?, token, fence)
            .map_err(|_| ("lease_lost", "writer lease is not owned by this session"))?;
        if state.draining || state.in_flight.is_some() {
            return Err((
                "operation_in_flight",
                "wait for terminal execution before cleanup",
            ));
        }
        state.draining = true;
        Ok(ReleaseGuard {
            manager: self,
            epoch: state.epoch,
        })
    }
    pub fn release(&self, context: &Context, token: &str, fence: u64) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        state
            .lease
            .require_lease(context.client()?, token, fence)
            .map_err(|_| ("lease_lost", "writer lease is not owned by this session"))?;
        if state.in_flight.is_some() {
            return Err((
                "operation_in_flight",
                "wait for terminal execution before releasing",
            ));
        }
        if !state.held_input.is_empty() {
            return Err((
                "input_cleanup_required",
                "input release has not been confirmed",
            ));
        }
        state.lease.invalidate();
        Ok(())
    }
    pub fn detach(&self, context: &Context) -> Result<()> {
        let id = context.client()?;
        let mut state = self.state.lock().unwrap();
        if state
            .in_flight
            .as_ref()
            .is_some_and(|(owner, _)| owner == id)
        {
            return Err((
                "operation_in_flight",
                "session cannot detach before execution settles",
            ));
        }
        if state
            .lease
            .status()
            .lease
            .is_some_and(|l| l.principal == id)
        {
            return Err(("writer_busy", "release the writer before detaching"));
        }
        state.clients.remove(id);
        state.capturing.remove(id);
        state.snapshots.retain(|(owner, _), _| owner != id);
        Ok(())
    }
    pub fn retired(&self) -> Vec<String> {
        let mut state = self.state.lock().unwrap();
        prune(&mut state);
        state.retired.iter().cloned().collect()
    }
    pub fn retired_dispatched(&self, id: &str) {
        self.state.lock().unwrap().retired.remove(id);
    }
    pub fn list(&self) -> Value {
        let mut state = self.state.lock().unwrap();
        prune(&mut state);
        json!(state
            .clients
            .iter()
            .map(|(id, c)| json!({"clientSessionId":id,"windows":c.windows,
            "canWrite":c.write,"idleTimeoutMs":c.idle_timeout.as_millis(),
            "idleForMs":c.touched.elapsed().as_millis()}))
            .collect::<Vec<_>>())
    }
    pub fn revoke(&self, id: &str) -> Value {
        let mut state = self.state.lock().unwrap();
        let removed = revoke(&mut state, id);
        json!({"revoked":removed,"recoveryRequired":state.quarantined})
    }
    pub fn recover(&self) -> Result<RecoveryGuard<'_>> {
        let mut state = self.state.lock().unwrap();
        if state.recovering {
            return Err(("recovery_in_progress", "another recovery is active"));
        }
        state.epoch += 1;
        state.revision += 1;
        state.recovering = true;
        state.quarantined = true;
        state.clients.clear();
        state.snapshots.clear();
        state.lease.invalidate();
        Ok(RecoveryGuard {
            manager: self,
            epoch: state.epoch,
        })
    }
    pub fn status(&self) -> Value {
        let mut state = self.state.lock().unwrap();
        prune(&mut state);
        json!({"revision": state.revision, "writerActive": state.in_flight.is_some(),
            "quarantined": state.quarantined, "recovering":state.recovering, "epoch":state.epoch, "sessions": state.clients.len()})
    }
    pub fn input_dirty(&self, window: &str) -> bool {
        self.state.lock().unwrap().held_input.contains(window)
    }
    pub fn capture_snapshot<'a>(&'a self, context: &Context) -> Result<SnapshotCapture<'a>> {
        let id = context.client()?;
        let mut state = self.state.lock().unwrap();
        if !state.clients.contains_key(id) || state.recovering {
            return Err(("session_closed", "session is closed"));
        }
        if state.capturing.contains(id)
            || state
                .in_flight
                .as_ref()
                .is_some_and(|(owner, _)| owner == id)
        {
            return Err((
                "concurrent_operation",
                "this session is already capturing or executing; use another observer session",
            ));
        }
        let before = (
            state.revision,
            state.in_flight.is_none() && !state.quarantined,
        );
        state.capturing.insert(id.to_owned());
        Ok(SnapshotCapture {
            manager: self,
            client: id.into(),
            epoch: state.epoch,
            before,
        })
    }
    pub fn snapshot_start(&self) -> (u64, bool) {
        let state = self.state.lock().unwrap();
        (
            state.revision,
            state.in_flight.is_none() && !state.quarantined,
        )
    }
    pub fn record_snapshot(
        &self,
        context: &Context,
        window: &str,
        value: &mut Value,
        before: (u64, bool),
    ) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        if !state
            .clients
            .get(context.client()?)
            .is_some_and(|c| c.windows.contains(window))
        {
            return Err((
                "session_closed",
                "session closed or window is outside its scope",
            ));
        }
        let actionable = before.1
            && before.0 == state.revision
            && state.in_flight.is_none()
            && !state.quarantined;
        save_snapshot(&mut state, context.client()?, window, value, actionable);
        Ok(())
    }
    pub fn reference_document(
        &self,
        context: &Context,
        window: &str,
        reference: &str,
        for_action: bool,
    ) -> Result<String> {
        let state = self.state.lock().unwrap();
        reference_document(&state, context.client()?, window, reference, for_action)
    }

    pub fn begin<'a>(&'a self, context: &Context, params: &Value) -> Result<Admission<'a>> {
        let id = context.client()?;
        let writer = context
            .writer
            .as_ref()
            .ok_or(("writer_required", "acquire the app writer before mutation"))?;
        if writer.operation_id.is_empty() || writer.operation_id.len() > 128 {
            return Err((
                "invalid_operation_id",
                "operation ID must contain 1 to 128 bytes",
            ));
        }
        let mut state = self.state.lock().unwrap();
        if !state.clients.get(id).is_some_and(|c| c.write) {
            return Err(("write_scope_denied", "session cannot mutate"));
        }
        if state.quarantined {
            return Err((
                "target_quarantined",
                "previous execution cleanup is unconfirmed",
            ));
        }
        state
            .lease
            .require_lease(id, &writer.token, writer.fence)
            .map_err(|_| ("lease_lost", "writer lease is no longer valid"))?;
        if state.in_flight.is_some() {
            return Err((
                "concurrent_operation",
                "only one operation may execute, including within one lease",
            ));
        }
        if state.capturing.contains(id) {
            return Err((
                "concurrent_operation",
                "wait for this session's snapshot to settle",
            ));
        }
        if state.draining && params["helper"] != "releaseInput" {
            return Err(("writer_releasing", "writer cleanup is in progress"));
        }
        let retained = state
            .ledger
            .lookup(id, METHOD, &writer.operation_id, params)
            .map_err(|_| ("operation_capacity", "operation ledger unavailable"))?;
        let document = if retained.is_none() {
            params["reference"]
                .as_str()
                .map(|reference| {
                    reference_document(
                        &state,
                        id,
                        params["window"].as_str().unwrap_or_default(),
                        reference,
                        true,
                    )
                })
                .transpose()?
        } else {
            None
        };
        let decision = match retained {
            Some(decision) => decision,
            None => state
                .ledger
                .begin(id, METHOD, &writer.operation_id, params)
                .map_err(|_| ("operation_capacity", "operation ledger is full"))?,
        };
        match decision {
            IdempotencyDecision::Cached(value) => return Ok(Admission::Cached(value)),
            IdempotencyDecision::Conflict => {
                return Err((
                    "operation_conflict",
                    "operation ID was reused with different arguments",
                ))
            }
            IdempotencyDecision::Indeterminate => {
                return Err((
                    "outcome_unknown",
                    "inspect the previous operation; it will not be replayed",
                ))
            }
            IdempotencyDecision::Execute => {}
        }
        state.revision += 1;
        state.in_flight = Some((id.into(), writer.operation_id.clone()));
        let input_window = (matches!(
            params["helper"].as_str(),
            Some("keyboard" | "mouse" | "releaseInput")
        ) || (params["operation"] == "action" && params["name"] == "keyboard"))
            .then(|| params["window"].as_str().unwrap_or_default().to_owned());
        Ok(Admission::Execute(Operation {
            manager: self,
            client: id.into(),
            id: writer.operation_id.clone(),
            settled: false,
            epoch: state.epoch,
            input_window,
            release_input: params["helper"] == "releaseInput",
            window: params["window"].as_str().unwrap_or_default().into(),
            document,
        }))
    }
}
pub struct SnapshotCapture<'a> {
    manager: &'a Sessions,
    client: String,
    epoch: u64,
    pub before: (u64, bool),
}
impl SnapshotCapture<'_> {
    pub fn validate(&self) -> Result<()> {
        let state = self.manager.state.lock().unwrap();
        if state.epoch != self.epoch || !state.clients.contains_key(&self.client) {
            return Err(("session_closed", "snapshot belongs to a retired session"));
        }
        Ok(())
    }
    pub fn complete(self) {
        self.manager
            .state
            .lock()
            .unwrap()
            .capturing
            .remove(&self.client);
    }
    // If the native future drops, queued JS may still replace that session's
    // refs. Keep only this client's capture blocked until it detaches.
}
pub struct ReleaseGuard<'a> {
    manager: &'a Sessions,
    epoch: u64,
}
impl Drop for ReleaseGuard<'_> {
    fn drop(&mut self) {
        let mut state = self.manager.state.lock().unwrap();
        if state.epoch == self.epoch {
            state.draining = false;
        }
    }
}
pub enum Admission<'a> {
    Cached(Value),
    Execute(Operation<'a>),
}
pub struct Operation<'a> {
    manager: &'a Sessions,
    client: String,
    id: String,
    settled: bool,
    epoch: u64,
    input_window: Option<String>,
    release_input: bool,
    window: String,
    pub document: Option<String>,
}
impl Operation<'_> {
    pub fn validate(&self) -> Result<()> {
        let state = self.manager.state.lock().unwrap();
        if state.epoch != self.epoch
            || !state.clients.contains_key(&self.client)
            || state.recovering
        {
            return Err(("session_closed", "operation belongs to a retired session"));
        }
        Ok(())
    }
    pub fn finish(mut self, value: &mut Value) -> Result<()> {
        let mut state = self.manager.state.lock().unwrap();
        if state.epoch != self.epoch || !state.clients.contains_key(&self.client) {
            self.settled = true;
            return Err((
                "session_closed",
                "late result from a retired session was discarded",
            ));
        }
        state.revision += 1;
        if value["snapshot"].is_object() {
            save_snapshot(
                &mut state,
                &self.client,
                &self.window,
                &mut value["snapshot"],
                true,
            );
        }
        state
            .ledger
            .complete(&self.client, METHOD, &self.id, value)
            .map_err(|_| ("outcome_unknown", "could not retain operation outcome"))?;
        if let Some(window) = &self.input_window {
            if self.release_input {
                state.held_input.remove(window);
            } else {
                state.held_input.insert(window.clone());
            }
        }
        state.in_flight = None;
        self.settled = true;
        Ok(())
    }
}
impl Drop for Operation<'_> {
    fn drop(&mut self) {
        if !self.settled {
            // Cancelling a native future never proves that queued JS stopped.
            let mut state = self.manager.state.lock().unwrap();
            if state.epoch == self.epoch {
                state.quarantined = true;
            }
        }
    }
}

/// Dropping a recovery only releases its ownership; admission remains closed.
pub struct RecoveryGuard<'a> {
    manager: &'a Sessions,
    epoch: u64,
}
impl RecoveryGuard<'_> {
    pub fn finish(self) -> Result<()> {
        let mut state = self.manager.state.lock().unwrap();
        if state.epoch != self.epoch || !state.recovering {
            return Err(("recovery_superseded", "recovery no longer owns admission"));
        }
        state.in_flight = None;
        state.capturing.clear();
        state.retired.clear();
        state.held_input.clear();
        state.draining = false;
        state.workflow_deadline = None;
        state.ledger = IdempotencyCache::retaining_pending(128, Duration::from_secs(600));
        state.quarantined = false;
        state.recovering = false;
        Ok(())
    }
}
impl Drop for RecoveryGuard<'_> {
    fn drop(&mut self) {
        let mut state = self.manager.state.lock().unwrap();
        if state.epoch == self.epoch {
            state.recovering = false;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn client(manager: &Sessions, write: bool) -> Context {
        let record = manager.open(vec!["main".into()], write).unwrap();
        Context {
            identity: Identity::Client(record["clientSessionId"].as_str().unwrap().into()),
            writer: None,
            expected_document: None,
            timeout_ms: None,
        }
    }
    fn writer(manager: &Sessions, client: &Context, id: &str) -> Context {
        let lease = manager.acquire(client).unwrap();
        Context {
            identity: client.identity.clone(),
            writer: Some(Writer {
                token: lease.token,
                fence: lease.fence,
                operation_id: id.into(),
            }),
            expected_document: None,
            timeout_ms: None,
        }
    }
    #[tokio::test]
    async fn observer_cannot_publish_after_revoke_or_recovery() {
        for recover in [false, true] {
            let manager = Sessions::default();
            let context = client(&manager, false);
            let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
            let (result_tx, result_rx) = tokio::sync::oneshot::channel();
            let observation = manager.observe(&context, "main", async {
                entered_tx.send(()).unwrap();
                result_rx.await.unwrap()
            });
            let retire = async {
                entered_rx.await.unwrap();
                if recover {
                    manager.recover().unwrap().finish().unwrap();
                } else {
                    manager.revoke(context.client().unwrap());
                }
                let fresh = client(&manager, false);
                manager.authorize(&fresh, "main").unwrap();
                result_tx.send(json!({"content":"new document"})).unwrap();
            };
            let (result, ()) = tokio::join!(observation, retire);
            assert_eq!(result.unwrap_err().0, "session_closed");
        }
    }
    #[tokio::test]
    async fn observer_checks_scope_before_polling_and_preserves_live_results() {
        let manager = Sessions::default();
        let context = client(&manager, false);
        assert_eq!(
            manager
                .observe(&context, "foreign", async { panic!("must not dispatch") })
                .await
                .unwrap_err()
                .0,
            "window_scope_denied"
        );
        assert_eq!(
            manager
                .observe(&context, "main", async { 42 })
                .await
                .unwrap(),
            42
        );
    }
    #[test]
    fn composite_keyboard_replays_whole_arguments_and_requires_input_cleanup() {
        let manager = Sessions::default();
        let context = writer(&manager, &client(&manager, true), "composite");
        let params = json!({"window":"main","operation":"action","name":"keyboard","args":{"operation":"type","args":{"text":"aa","delay":1}}});
        let Admission::Execute(operation) = manager.begin(&context, &params).unwrap() else {
            panic!()
        };
        operation.finish(&mut json!(true)).unwrap();
        assert!(matches!(
            manager.begin(&context, &params).unwrap(),
            Admission::Cached(_)
        ));
        let mut changed = params;
        changed["args"]["args"]["text"] = json!("ab");
        assert_eq!(
            manager.begin(&context, &changed).err().unwrap().0,
            "operation_conflict"
        );
        assert!(manager.input_dirty("main"));
        let lease = context.writer.as_ref().unwrap();
        assert_eq!(
            manager
                .release(&context, &lease.token, lease.fence)
                .unwrap_err()
                .0,
            "input_cleanup_required"
        );
    }
    #[test]
    fn recovery_fences_an_old_snapshot_capture_before_dispatch() {
        let manager = Sessions::default();
        let a = client(&manager, false);
        let capture = manager.capture_snapshot(&a).unwrap();
        manager.recover().unwrap().finish().unwrap();
        assert_eq!(capture.validate().unwrap_err().0, "session_closed");
        let b = client(&manager, false);
        let fresh = manager.capture_snapshot(&b).unwrap();
        capture.complete();
        assert!(manager
            .state
            .lock()
            .unwrap()
            .capturing
            .contains(b.client().unwrap()));
        fresh.complete();
    }
    #[test]
    fn revoking_an_expired_input_holder_reports_recovery_required() {
        let manager = Sessions::default();
        let a = writer(&manager, &client(&manager, true), "input");
        let Admission::Execute(op) = manager
            .begin(&a, &json!({"helper":"keyboard","window":"main"}))
            .unwrap()
        else {
            panic!()
        };
        op.finish(&mut json!(true)).unwrap();
        manager
            .state
            .lock()
            .unwrap()
            .lease
            .lease
            .as_mut()
            .unwrap()
            .deadline = Instant::now();
        assert_eq!(
            manager.revoke(a.client().unwrap())["recoveryRequired"],
            true
        );
        assert_eq!(manager.status()["quarantined"], true);
    }
    #[test]
    fn idle_sessions_reclaim_capacity_without_exposing_tokens() {
        let manager = Sessions::default();
        let a = client(&manager, false);
        let id = a.client().unwrap();
        let token = manager.state.lock().unwrap().clients[id].token.clone();
        assert!(!manager.list().to_string().contains(&token));
        manager
            .state
            .lock()
            .unwrap()
            .clients
            .get_mut(id)
            .unwrap()
            .touched = Instant::now() - Duration::from_secs(301);
        assert!(manager.authenticate(&token, |a, b| a == b).is_none());
        assert_eq!(manager.status()["sessions"], 0);
        assert!(manager
            .open_with_timeout(vec!["main".into()], false, Some(999))
            .is_err());
    }
    #[test]
    fn revoke_and_recovery_fence_late_results_and_old_drops() {
        let manager = Sessions::default();
        let a = writer(&manager, &client(&manager, true), "old");
        let Admission::Execute(old) = manager.begin(&a, &json!({"window":"main"})).unwrap() else {
            panic!()
        };
        assert_eq!(
            manager.revoke(a.client().unwrap())["recoveryRequired"],
            true
        );
        let recovery = manager.recover().unwrap();
        assert!(manager.open(vec!["main".into()], true).is_err());
        recovery.finish().unwrap();
        let b = writer(&manager, &client(&manager, true), "new");
        let Admission::Execute(new) = manager.begin(&b, &json!({"window":"main"})).unwrap() else {
            panic!()
        };
        assert_eq!(
            old.finish(&mut json!({"snapshot":{"nodes":[{"ref":"old"}]}}))
                .unwrap_err()
                .0,
            "session_closed"
        );
        assert_eq!(manager.status()["writerActive"], true);
        assert_eq!(manager.status()["quarantined"], false);
        new.finish(&mut json!(true)).unwrap();
        assert_eq!(manager.status()["writerActive"], false);
    }
    #[test]
    fn recovery_cancellation_stays_quarantined_and_drain_is_epoch_fenced() {
        let manager = Sessions::default();
        let a = client(&manager, true);
        let lease = manager.acquire(&a).unwrap();
        let old_drain = manager.drain(&a, &lease.token, lease.fence).unwrap();
        drop(manager.recover().unwrap());
        assert_eq!(manager.status()["quarantined"], true);
        manager.recover().unwrap().finish().unwrap();
        let b = client(&manager, true);
        let lease = manager.acquire(&b).unwrap();
        let new_drain = manager.drain(&b, &lease.token, lease.fence).unwrap();
        drop(old_drain);
        assert!(manager.state.lock().unwrap().draining);
        drop(new_drain);
        assert!(!manager.state.lock().unwrap().draining);
    }
    #[test]
    fn a_revoked_snapshot_cannot_be_published_and_expired_writer_is_not_replayed() {
        let manager = Sessions::default();
        let a = client(&manager, true);
        let before = manager.snapshot_start();
        manager.revoke(a.client().unwrap());
        assert_eq!(
            manager
                .record_snapshot(&a, "main", &mut json!({"nodes":[]}), before)
                .unwrap_err()
                .0,
            "session_closed"
        );
        let a = writer(&manager, &client(&manager, true), "pending");
        let Admission::Execute(old) = manager.begin(&a, &json!({"window":"main"})).unwrap() else {
            panic!()
        };
        manager
            .state
            .lock()
            .unwrap()
            .clients
            .get_mut(a.client().unwrap())
            .unwrap()
            .touched = Instant::now() - Duration::from_secs(301);
        assert_eq!(manager.list().as_array().unwrap().len(), 0);
        assert!(old.validate().is_err());
        drop(old);
        assert_eq!(manager.status()["quarantined"], true);
    }
    #[test]
    fn ref_replay_precedes_freshness_checks_and_publishes_terminal_snapshot() {
        let manager = Sessions::default();
        let a = client(&manager, true);
        let mut initial = json!({"documentId":"doc","generation":1,"nodes":[{"ref":"old"}]});
        manager
            .record_snapshot(&a, "main", &mut initial, manager.snapshot_start())
            .unwrap();
        let mut a = writer(&manager, &a, "act");
        let params = json!({"window":"main","reference":"old","action":"click"});
        let Admission::Execute(op) = manager.begin(&a, &params).unwrap() else {
            panic!()
        };
        assert_eq!(op.document.as_deref(), Some("doc"));
        let mut result = json!({"result":true,"snapshot":{"documentId":"doc","generation":2,"nodes":[{"ref":"new"}]}});
        op.finish(&mut result).unwrap();
        assert_eq!(result["snapshot"]["actionable"], true);
        let Admission::Cached(cached) = manager.begin(&a, &params).unwrap() else {
            panic!()
        };
        assert_eq!(cached, result);
        a.writer.as_mut().unwrap().operation_id = "new-attempt".into();
        assert_eq!(manager.begin(&a, &params).err().unwrap().0, "stale_ref");
        assert_eq!(
            manager.reference_document(&a, "main", "new", true).unwrap(),
            "doc"
        );
    }

    #[test]
    fn own_snapshot_capture_and_mutation_cannot_replace_each_others_refs() {
        let manager = Sessions::default();
        let a = client(&manager, true);
        let b = client(&manager, false);
        let a = writer(&manager, &a, "act");
        let capture = manager.capture_snapshot(&a).unwrap();
        assert_eq!(
            manager.begin(&a, &json!({})).err().unwrap().0,
            "concurrent_operation"
        );
        assert!(manager.capture_snapshot(&a).is_err());
        capture.complete();
        let Admission::Execute(op) = manager.begin(&a, &json!({})).unwrap() else {
            panic!()
        };
        assert!(manager.capture_snapshot(&a).is_err());
        let observer = manager.capture_snapshot(&b).unwrap();
        assert!(!observer.before.1);
        observer.complete();
        op.finish(&mut json!(true)).unwrap();
    }

    #[test]
    fn input_cleanup_drains_the_writer_before_handoff_or_detach() {
        let manager = Sessions::default();
        let a = client(&manager, true);
        let b = client(&manager, true);
        let mut a = writer(&manager, &a, "down");
        let Admission::Execute(op) = manager
            .begin(&a, &json!({"helper":"keyboard","window":"main"}))
            .unwrap()
        else {
            panic!()
        };
        op.finish(&mut json!(true)).unwrap();
        assert_eq!(manager.detach(&a).unwrap_err().0, "writer_busy");
        let proof = a.writer.as_ref().unwrap().clone();
        let drain = manager.drain(&a, &proof.token, proof.fence).unwrap();
        assert_eq!(
            manager.begin(&a, &json!({"click":1})).err().unwrap().0,
            "writer_releasing"
        );
        assert_eq!(
            manager
                .release(&a, &proof.token, proof.fence)
                .unwrap_err()
                .0,
            "input_cleanup_required"
        );
        a.writer.as_mut().unwrap().operation_id = "cleanup".into();
        let Admission::Execute(op) = manager
            .begin(&a, &json!({"helper":"releaseInput","window":"main"}))
            .unwrap()
        else {
            panic!()
        };
        op.finish(&mut json!(true)).unwrap();
        manager.release(&a, &proof.token, proof.fence).unwrap();
        drop(drain);
        manager.detach(&a).unwrap();
        assert!(manager.acquire(&b).is_ok());
    }

    #[test]
    fn reordered_snapshot_completion_cannot_publish_an_older_ref_generation() {
        let manager = Sessions::default();
        let a = client(&manager, true);
        let before = manager.snapshot_start();
        let mut newer = json!({"documentId":"doc","generation":2,"nodes":[{"ref":"new"}]});
        let mut older = json!({"documentId":"doc","generation":1,"nodes":[{"ref":"old"}]});
        manager
            .record_snapshot(&a, "main", &mut newer, before)
            .unwrap();
        manager
            .record_snapshot(&a, "main", &mut older, before)
            .unwrap();
        assert_eq!(older["actionable"], false);
        assert_eq!(
            manager.reference_document(&a, "main", "new", true).unwrap(),
            "doc"
        );
        assert!(manager
            .reference_document(&a, "main", "old", false)
            .is_err());
    }

    #[test]
    fn independent_sessions_and_scopes() {
        let manager = Sessions::default();
        let a = client(&manager, false);
        let b = client(&manager, true);
        assert_ne!(a.client().unwrap(), b.client().unwrap());
        assert_eq!(manager.acquire(&a).unwrap_err().0, "write_scope_denied");
        assert_eq!(
            manager.authorize(&a, "foreign").unwrap_err().0,
            "window_scope_denied"
        );
    }
    #[test]
    fn app_writer_excludes_other_sessions_and_same_lease_concurrency() {
        let manager = Sessions::default();
        let a = client(&manager, true);
        let b = client(&manager, true);
        let a = writer(&manager, &a, "one");
        assert_eq!(manager.acquire(&b).unwrap_err().0, "writer_busy");
        let Admission::Execute(op) = manager.begin(&a, &json!({"click":1})).unwrap() else {
            panic!()
        };
        assert_eq!(
            manager.begin(&a, &json!({})).err().unwrap().0,
            "concurrent_operation"
        );
        op.finish(&mut json!({"ok":true})).unwrap();
        assert!(matches!(
            manager.begin(&a, &json!({"click":1})).unwrap(),
            Admission::Cached(_)
        ));
        assert_eq!(
            manager.begin(&a, &json!({"click":2})).err().unwrap().0,
            "operation_conflict"
        );
    }
    #[test]
    fn observations_during_writes_never_become_actionable() {
        let manager = Sessions::default();
        let a = client(&manager, true);
        let b = client(&manager, true);
        let a = writer(&manager, &a, "one");
        let Admission::Execute(op) = manager.begin(&a, &json!({})).unwrap() else {
            panic!()
        };
        let before = manager.snapshot_start();
        let mut snapshot = json!({"documentId":"doc", "nodes":[{"ref":"g1e1"}]});
        manager
            .record_snapshot(&b, "main", &mut snapshot, before)
            .unwrap();
        op.finish(&mut json!({"ok":true})).unwrap();
        assert_eq!(snapshot["actionable"], false);
        assert_eq!(
            manager
                .reference_document(&b, "main", "g1e1", true)
                .unwrap_err()
                .0,
            "stale_snapshot"
        );
        assert_eq!(
            manager
                .reference_document(&a, "main", "g1e1", false)
                .unwrap_err()
                .0,
            "stale_ref"
        );
    }
    #[test]
    fn cancelled_native_future_quarantines_the_target() {
        let manager = Sessions::default();
        let a = client(&manager, true);
        let a = writer(&manager, &a, "one");
        let Admission::Execute(op) = manager.begin(&a, &json!({})).unwrap() else {
            panic!()
        };
        drop(op);
        assert_eq!(manager.status()["quarantined"], true);
        assert_eq!(
            manager.begin(&a, &json!({})).err().unwrap().0,
            "target_quarantined"
        );
    }

    #[test]
    fn foreign_session_cannot_renew_or_release_another_writers_token() {
        let manager = Sessions::default();
        let a = client(&manager, true);
        let b = client(&manager, true);
        let a = writer(&manager, &a, "one");
        let lease = a.writer.as_ref().unwrap();
        assert_eq!(
            manager.renew(&b, &lease.token, lease.fence).unwrap_err().0,
            "lease_lost"
        );
        assert_eq!(
            manager
                .release(&b, &lease.token, lease.fence)
                .unwrap_err()
                .0,
            "lease_lost"
        );
        assert!(manager.begin(&a, &json!({})).is_ok());
    }

    #[test]
    fn writes_invalidate_settled_snapshots_across_all_windows() {
        let manager = Sessions::default();
        let a = client(&manager, true);
        let b = client(&manager, true);
        let mut snapshot = json!({"documentId":"doc", "nodes":[{"ref":"g1e1"}]});
        manager
            .record_snapshot(&b, "main", &mut snapshot, manager.snapshot_start())
            .unwrap();
        let a = writer(&manager, &a, "one");
        let Admission::Execute(op) = manager
            .begin(&a, &json!({"window":"pet", "click":1}))
            .unwrap()
        else {
            panic!()
        };
        op.finish(&mut json!({"ok":true})).unwrap();
        assert_eq!(
            manager
                .reference_document(&b, "main", "g1e1", true)
                .unwrap_err()
                .0,
            "stale_snapshot"
        );
        assert_eq!(
            manager
                .reference_document(&b, "main", "g1e1", false)
                .unwrap(),
            "doc"
        );
    }

    #[test]
    fn expired_owner_with_unclean_input_cannot_hand_off() {
        let manager = Sessions::default();
        let a = client(&manager, true);
        let b = client(&manager, true);
        let a = writer(&manager, &a, "one");
        let Admission::Execute(op) = manager
            .begin(&a, &json!({"helper":"keyboard","window":"main"}))
            .unwrap()
        else {
            panic!()
        };
        op.finish(&mut json!(true)).unwrap();
        manager
            .state
            .lock()
            .unwrap()
            .lease
            .lease
            .as_mut()
            .unwrap()
            .deadline = Instant::now();
        assert_eq!(manager.acquire(&b).unwrap_err().0, "target_quarantined");
    }
}

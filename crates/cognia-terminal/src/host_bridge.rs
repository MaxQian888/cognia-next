//! Tauri bridge to the durable terminal host (`cognia-server desktop-host`).
//!
//! The public command names intentionally remain the existing `terminal_*`
//! surface; this module forwards them over one authenticated native
//! connection to the host, which owns the PTYs. `src-tauri`'s
//! `terminal_host_bridge` glob-re-exports this module (and `host_client`) so
//! `generate_handler!` and `crate::terminal_host_bridge::…` paths resolve
//! unchanged (ADR-0196). The one command left there is the
//! `terminal_host_service` shell, which needs the companion server's state
//! for its LAN URL fallback; its body is [`run_terminal_host_service`].

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use crate::host::HostSessionInfo;
use crate::host::HostTransportState;
use crate::host_client::*;
use crate::host_wire::{read_frame, write_frame};
use crate::osc633::IntegrationEvent;
use crate::protocol::{FrameKind, TerminalFrame, MAX_FRAME_PAYLOAD};
use crate::session::SpawnRequest;
use crate::ssh::{forget_host_key, SshSpawnRequest};
use crate::ssh_forward::ForwardStatus;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, Runtime, State};
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

use crate::terminal_host_service::{
    connect_terminal_host, default_terminal_host_endpoint, load_terminal_host_settings,
    provision_terminal_host_descriptor, save_terminal_host_settings,
    set_terminal_host_login_service, ssh_known_hosts_path, TerminalHostSettings,
};

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HostChannelEvent {
    Data {
        bytes: Vec<u8>,
    },
    Integration {
        event: IntegrationEvent,
    },
    Exit {
        code: Option<u32>,
    },
    ReplayGap {
        requested_after: u64,
        first_available: u64,
        last_available: u64,
    },
    ControllerChanged {
        controller: Option<String>,
    },
    /// Transport health for this session — today, whether the host has parked
    /// the producer because some attached client asked it to.
    TransportState {
        state: HostTransportState,
        message: Option<String>,
    },
    /// An unsolicited session snapshot (sequence 0) — the host re-sends it
    /// whenever the attachment roster or the controller lease changes, so the
    /// renderer's `info.participants` stays current (ADR-0133).
    SessionSnapshot {
        session: Box<HostSessionInfo>,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostSeqEvent {
    pub seq: u64,
    pub event: HostChannelEvent,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnResult {
    pub session: HostSessionInfo,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshSpawnResult {
    pub session: HostSessionInfo,
    pub host_key_status: String,
    pub host_key_fingerprint: String,
}

#[derive(Debug, Deserialize)]
struct ExitPayload {
    code: Option<u32>,
}

/// Hello ack. `protocolFeatures` is absent on hosts older than this build, so
/// it defaults to empty and every gated command degrades to a clean error.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AckPayload {
    #[serde(default)]
    protocol_features: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct ControllerPayload {
    controller: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransportStatePayload {
    state: HostTransportState,
    #[serde(default)]
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReplayGapPayload {
    requested_after: u64,
    first_available: u64,
    last_available: u64,
}

type PendingResponse = oneshot::Sender<Result<TerminalFrame, String>>;

struct BridgeClient {
    writer: mpsc::Sender<TerminalFrame>,
    pending: Mutex<HashMap<u64, PendingResponse>>,
    channels: Mutex<HashMap<String, Channel<HostSeqEvent>>>,
    next_sequence: AtomicU64,
    closed: AtomicBool,
    /// `protocolFeatures` from the hello ack. Empty until the handshake lands,
    /// and empty forever against a host old enough not to send the field —
    /// which is exactly the case [`BridgeClient::supports`] exists to detect,
    /// since the bridge happily reuses an already-running host binary that may
    /// predate this build (start-at-login login service).
    features: Mutex<Vec<String>>,
}

impl BridgeClient {
    async fn connect(endpoint: &str) -> Result<Arc<Self>, String> {
        let stream = connect_terminal_host(endpoint).await?;
        let (mut reader, mut writer) = tokio::io::split(stream);
        let (writer_tx, mut writer_rx) = mpsc::channel::<TerminalFrame>(256);
        let client = Arc::new(Self {
            writer: writer_tx,
            pending: Mutex::new(HashMap::new()),
            channels: Mutex::new(HashMap::new()),
            next_sequence: AtomicU64::new(1),
            closed: AtomicBool::new(false),
            features: Mutex::new(Vec::new()),
        });

        let writer_client = Arc::clone(&client);
        tauri::async_runtime::spawn(async move {
            while let Some(frame) = writer_rx.recv().await {
                if let Err(error) = write_frame(&mut writer, &frame).await {
                    writer_client.fail(error);
                    break;
                }
            }
        });

        let reader_client = Arc::clone(&client);
        tauri::async_runtime::spawn(async move {
            loop {
                match read_frame(&mut reader).await {
                    Ok(Some(frame)) => reader_client.dispatch(frame),
                    Ok(None) => {
                        reader_client.fail("terminal host connection closed".into());
                        break;
                    }
                    Err(error) => {
                        reader_client.fail(error);
                        break;
                    }
                }
            }
        });
        Ok(client)
    }

    fn is_open(&self) -> bool {
        !self.closed.load(Ordering::SeqCst)
    }

    /// Whether the connected host advertised `feature` in its hello ack.
    /// Callers of post-1.0 frame kinds must gate on this — an older host
    /// answers an unknown kind with `invalid_request`, and a *much* older one
    /// would not decode the frame at all.
    fn supports(&self, feature: &str) -> bool {
        self.features.lock().iter().any(|known| known == feature)
    }

    fn set_features(&self, features: Vec<String>) {
        *self.features.lock() = features;
    }

    async fn request(
        &self,
        kind: FrameKind,
        session_id: Uuid,
        payload: Vec<u8>,
    ) -> Result<TerminalFrame, String> {
        if !self.is_open() {
            return Err("terminal host connection is closed".into());
        }
        if payload.len() > MAX_FRAME_PAYLOAD {
            return Err(format!(
                "terminal request payload exceeds {MAX_FRAME_PAYLOAD} bytes"
            ));
        }
        let sequence = self.next_sequence.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().insert(sequence, sender);
        if self
            .writer
            .send(TerminalFrame::command(kind, session_id, sequence, payload))
            .await
            .is_err()
        {
            self.pending.lock().remove(&sequence);
            return Err("terminal host writer is closed".into());
        }
        let frame = self
            .await_response(sequence, receiver, REQUEST_TIMEOUT)
            .await?;
        if frame.kind == FrameKind::Error {
            let error: ErrorPayload = serde_json::from_slice(&frame.payload)
                .map_err(|decode| format!("terminal host returned an invalid error: {decode}"))?;
            return Err(format!(
                "{}: {}",
                error_code_name(error.code),
                error.message
            ));
        }
        Ok(frame)
    }

    async fn await_response(
        &self,
        sequence: u64,
        receiver: oneshot::Receiver<Result<TerminalFrame, String>>,
        timeout: Duration,
    ) -> Result<TerminalFrame, String> {
        match tokio::time::timeout(timeout, receiver).await {
            Ok(Ok(response)) => response,
            Ok(Err(_)) => {
                self.pending.lock().remove(&sequence);
                Err("terminal host response channel closed".into())
            }
            Err(_) => {
                self.pending.lock().remove(&sequence);
                Err("terminal host request timed out".into())
            }
        }
    }

    async fn request_json<T: Serialize>(
        &self,
        kind: FrameKind,
        session_id: Uuid,
        payload: &T,
    ) -> Result<TerminalFrame, String> {
        let payload = serde_json::to_vec(payload)
            .map_err(|error| format!("terminal request serialization failed: {error}"))?;
        self.request(kind, session_id, payload).await
    }

    fn register_channel(&self, session_id: &str, channel: Channel<HostSeqEvent>) {
        self.channels.lock().insert(session_id.to_string(), channel);
    }

    fn remove_channel(&self, session_id: &str) {
        self.channels.lock().remove(session_id);
    }

    fn dispatch(&self, frame: TerminalFrame) {
        if is_response_kind(frame.kind) && frame.sequence != 0 {
            if let Some(sender) = self.pending.lock().remove(&frame.sequence) {
                let _ = sender.send(Ok(frame));
                return;
            }
        }
        let session_id = frame.session_id.to_string();
        let seq = frame.sequence;
        let event = channel_event_for(frame);
        if let Some(event) = event {
            if let Some(channel) = self.channels.lock().get(&session_id).cloned() {
                let _ = channel.send(HostSeqEvent { seq, event });
            }
        }
    }

    fn fail(&self, error: String) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        let pending = std::mem::take(&mut *self.pending.lock());
        for (_, sender) in pending {
            let _ = sender.send(Err(error.clone()));
        }
    }
}

/// Project an unsolicited host frame onto the per-session Tauri channel event.
/// Response kinds addressed to a pending caller never reach here (see
/// `dispatch`); a `SessionSnapshot` here is therefore the host's unsolicited
/// roster/lease refresh. `None` for kinds the channel does not carry.
fn channel_event_for(frame: TerminalFrame) -> Option<HostChannelEvent> {
    match frame.kind {
        FrameKind::Stdout => Some(HostChannelEvent::Data {
            bytes: frame.payload,
        }),
        FrameKind::Integration => serde_json::from_slice(&frame.payload)
            .ok()
            .map(|event| HostChannelEvent::Integration { event }),
        FrameKind::Exit => serde_json::from_slice::<ExitPayload>(&frame.payload)
            .ok()
            .map(|payload| HostChannelEvent::Exit { code: payload.code }),
        FrameKind::ControllerChanged => serde_json::from_slice::<ControllerPayload>(&frame.payload)
            .ok()
            .map(|payload| HostChannelEvent::ControllerChanged {
                controller: payload.controller,
            }),
        // Only the unsolicited (sequence 0) snapshot reaches here — replies
        // to Attach/List were routed to their pending caller above.
        FrameKind::SessionSnapshot => serde_json::from_slice::<HostSessionInfo>(&frame.payload)
            .ok()
            .map(|session| HostChannelEvent::SessionSnapshot {
                session: Box::new(session),
            }),
        FrameKind::ReplayGap => serde_json::from_slice::<ReplayGapPayload>(&frame.payload)
            .ok()
            .map(|payload| HostChannelEvent::ReplayGap {
                requested_after: payload.requested_after,
                first_available: payload.first_available,
                last_available: payload.last_available,
            }),
        FrameKind::TransportState => {
            serde_json::from_slice::<TransportStatePayload>(&frame.payload)
                .ok()
                .map(|payload| HostChannelEvent::TransportState {
                    state: payload.state,
                    message: payload.message,
                })
        }
        _ => None,
    }
}

#[derive(Default)]
pub struct TerminalHostBridgeState {
    client: tokio::sync::Mutex<Option<Arc<BridgeClient>>>,
}

impl TerminalHostBridgeState {
    pub fn new() -> Self {
        Self::default()
    }

    async fn client<R: Runtime>(&self, app: &AppHandle<R>) -> Result<Arc<BridgeClient>, String> {
        let mut slot = self.client.lock().await;
        if let Some(client) = slot.as_ref().filter(|client| client.is_open()) {
            return Ok(Arc::clone(client));
        }
        let endpoint = default_terminal_host_endpoint();
        if let Ok(client) = BridgeClient::connect(&endpoint).await {
            send_hello(&client, app).await;
            *slot = Some(Arc::clone(&client));
            return Ok(client);
        }
        let resource_dir = terminal_resources(app.path().resource_dir().ok().as_deref());
        spawn_terminal_host_async(endpoint.clone(), resource_dir).await?;
        let mut last_error = "terminal host did not start".to_string();
        for _ in 0..START_RETRY_COUNT {
            tokio::time::sleep(START_RETRY_DELAY).await;
            match BridgeClient::connect(&endpoint).await {
                Ok(client) => {
                    send_hello(&client, app).await;
                    *slot = Some(Arc::clone(&client));
                    return Ok(client);
                }
                Err(error) => last_error = error,
            }
        }
        Err(last_error)
    }

    /// The already-connected client, or `None`.
    ///
    /// Never starts the host: background readers (the managed-process sampler)
    /// must not spawn a terminal host the user never asked for. Uses
    /// `try_lock`, so a concurrent connect attempt yields `None` rather than
    /// blocking a sampler tick.
    fn existing_client(&self) -> Option<Arc<BridgeClient>> {
        let slot = self.client.try_lock().ok()?;
        slot.as_ref()
            .filter(|client| client.is_open())
            .map(Arc::clone)
    }
}

/// Push the app's view of the terminal host's PATH and record the host's
/// advertised capabilities. Best-effort: a host that rejects or ignores the
/// hello still serves terminals, just without the app-managed CLI directories.
async fn send_hello<R: Runtime>(client: &BridgeClient, app: &AppHandle<R>) {
    let payload = serde_json::json!({
        "pathInjection": path_injection_payload(&crate::commands::build_cli_path_injection(app)),
    });
    match client
        .request_json(FrameKind::Hello, Uuid::nil(), &payload)
        .await
    {
        Ok(frame) => {
            if let Ok(ack) = serde_json::from_slice::<AckPayload>(&frame.payload) {
                client.set_features(ack.protocol_features);
            }
        }
        Err(error) => {
            log::warn!("terminal host hello failed: {error}");
        }
    }
}

/// Re-push the PATH view after the in-app CLI download registers a new managed
/// directory, so the running host resolves `cognia` for the *next* shell
/// without an app restart.
///
/// Already-running shells keep their old PATH — a PTY's environment is fixed at
/// `execve`, and rewriting it would mean injecting `export PATH=` into the
/// user's live shell.
pub async fn resync_terminal_host_path<R: Runtime>(app: &AppHandle<R>) {
    let Some(state) = app.try_state::<TerminalHostBridgeState>() else {
        return;
    };
    let Some(client) = state.existing_client() else {
        return;
    };
    send_hello(&client, app).await;
}

/// Wire form of a [`PathInjection`], dropping directories that are not valid
/// UTF-8. Serde's `PathBuf` impl errors on those, which would fail the entire
/// hello — config, profiles and all — over one odd `$HOME`.
fn path_injection_payload(path: &crate::session::PathInjection) -> serde_json::Value {
    fn encode(dirs: &[PathBuf]) -> Vec<String> {
        dirs.iter()
            .filter_map(|dir| match dir.to_str() {
                Some(text) => Some(text.to_string()),
                None => {
                    log::warn!(
                        "terminal host PATH entry {} is not valid UTF-8; skipping",
                        dir.display()
                    );
                    None
                }
            })
            .collect()
    }
    serde_json::json!({
        "prepend": encode(&path.prepend),
        "append": encode(&path.append),
    })
}

fn parse_session(frame: TerminalFrame) -> Result<HostSessionInfo, String> {
    serde_json::from_slice(&frame.payload)
        .map_err(|error| format!("terminal session response is invalid: {error}"))
}

#[tauri::command]
pub async fn terminal_spawn<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, TerminalHostBridgeState>,
    req: SpawnRequest,
    profile_id: Option<String>,
    on_event: Channel<HostSeqEvent>,
) -> Result<SpawnResult, String> {
    let client = state.client(&app).await?;
    let profile_id = profile_id
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "default".into());
    let response = client
        .request_json(
            FrameKind::Spawn,
            Uuid::nil(),
            &serde_json::json!({ "profileId": profile_id, "request": req }),
        )
        .await?;
    let session = parse_session(response)?;
    client.register_channel(&session.id, on_event);
    client
        .request_json(
            FrameKind::Attach,
            parse_session_id(&session.id)?,
            &serde_json::json!({ "resumeAfter": 0 }),
        )
        .await?;
    Ok(SpawnResult { session })
}

#[tauri::command]
pub async fn ssh_terminal_spawn<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, TerminalHostBridgeState>,
    req: SshSpawnRequest,
    on_event: Channel<HostSeqEvent>,
) -> Result<SshSpawnResult, String> {
    let client = state.client(&app).await?;
    let response = client
        .request_json(
            FrameKind::Spawn,
            Uuid::nil(),
            &serde_json::json!({
                "profileId": req.profile_id,
                "sshRequest": req,
            }),
        )
        .await?;
    let session = parse_session(response)?;
    let host_key_status = session
        .ssh_host_key_status
        .clone()
        .ok_or_else(|| "terminal host omitted the SSH host-key status".to_string())?;
    let host_key_fingerprint = session
        .ssh_host_key_fingerprint
        .clone()
        .ok_or_else(|| "terminal host omitted the SSH host-key fingerprint".to_string())?;
    client.register_channel(&session.id, on_event);
    client
        .request_json(
            FrameKind::Attach,
            parse_session_id(&session.id)?,
            &serde_json::json!({ "resumeAfter": 0 }),
        )
        .await?;
    Ok(SshSpawnResult {
        session,
        host_key_status,
        host_key_fingerprint,
    })
}

#[tauri::command]
pub async fn terminal_reattach<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, TerminalHostBridgeState>,
    id: String,
    on_event: Channel<HostSeqEvent>,
    resume_from: u64,
) -> Result<HostSessionInfo, String> {
    let client = state.client(&app).await?;
    client.register_channel(&id, on_event);
    let response = client
        .request_json(
            FrameKind::Attach,
            parse_session_id(&id)?,
            &serde_json::json!({ "resumeAfter": resume_from }),
        )
        .await?;
    parse_session(response)
}

#[tauri::command]
pub async fn terminal_write<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, TerminalHostBridgeState>,
    id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let client = state.client(&app).await?;
    let session_id = parse_session_id(&id)?;
    for chunk in data.chunks(MAX_FRAME_PAYLOAD) {
        client
            .request(FrameKind::Stdin, session_id, chunk.to_vec())
            .await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_terminal_write<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, TerminalHostBridgeState>,
    id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    terminal_write(app, state, id, data).await
}

#[tauri::command]
pub async fn terminal_resize<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, TerminalHostBridgeState>,
    id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let client = state.client(&app).await?;
    client
        .request_json(
            FrameKind::Resize,
            parse_session_id(&id)?,
            &serde_json::json!({ "rows": rows.max(1), "cols": cols.max(1) }),
        )
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn ssh_terminal_resize<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, TerminalHostBridgeState>,
    id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    terminal_resize(app, state, id, rows, cols).await
}

#[tauri::command]
pub async fn terminal_detach<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, TerminalHostBridgeState>,
    id: String,
) -> Result<(), String> {
    let client = state.client(&app).await?;
    client
        .request(FrameKind::Detach, parse_session_id(&id)?, Vec::new())
        .await?;
    client.remove_channel(&id);
    Ok(())
}

#[tauri::command]
pub async fn terminal_take_control<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, TerminalHostBridgeState>,
    id: String,
) -> Result<(), String> {
    state
        .client(&app)
        .await?
        .request(FrameKind::TakeControl, parse_session_id(&id)?, Vec::new())
        .await?;
    Ok(())
}

/// Ask the host to park (or resume) a session's producer.
///
/// Issued by the renderer's xterm backpressure watermarks. Gated on the host
/// advertising `flowControl` so a login-service host older than this build
/// fails with a clear message instead of an opaque `invalid_request` — the
/// renderer latches the capability off on the first refusal.
#[tauri::command]
pub async fn terminal_set_flow_control<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, TerminalHostBridgeState>,
    id: String,
    paused: bool,
) -> Result<(), String> {
    let client = state.client(&app).await?;
    if !client.supports("flowControl") {
        return Err("terminal host does not support flow control".into());
    }
    client
        .request_json(
            FrameKind::FlowControl,
            parse_session_id(&id)?,
            &serde_json::json!({ "paused": paused }),
        )
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn terminal_release_control<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, TerminalHostBridgeState>,
    id: String,
) -> Result<(), String> {
    state
        .client(&app)
        .await?
        .request(
            FrameKind::ReleaseControl,
            parse_session_id(&id)?,
            Vec::new(),
        )
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn terminal_kill<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, TerminalHostBridgeState>,
    id: String,
) -> Result<(), String> {
    let client = state.client(&app).await?;
    client
        .request(FrameKind::Kill, parse_session_id(&id)?, Vec::new())
        .await?;
    client.remove_channel(&id);
    Ok(())
}

#[tauri::command]
pub async fn ssh_terminal_kill<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, TerminalHostBridgeState>,
    id: String,
) -> Result<(), String> {
    terminal_kill(app, state, id).await
}

/// Drop the trusted key for `host:port` so the next connection re-learns it.
///
/// Runs in the app process rather than over the host socket: it edits a local
/// file both processes agree on ([`ssh_known_hosts_path`]), and a new host
/// frame kind would need protocol negotiation (ADR-0033) to carry an operation
/// that never touches a session.
///
/// Being a `#[tauri::command]` on the main webview *is* the local-identity gate
/// required by ADR-0082 §8.3 — remote and mobile clients reach the terminal
/// through the host socket and have no path to this surface, so they cannot
/// re-trust a server on the desktop's behalf.
#[tauri::command]
pub async fn ssh_forget_host_key(host: String, port: u16) -> Result<usize, String> {
    let host = host.trim().to_string();
    if host.is_empty() || host.chars().any(char::is_whitespace) {
        return Err("SSH host is invalid".into());
    }
    if port == 0 {
        return Err("SSH port is invalid".into());
    }
    tokio::task::spawn_blocking(move || {
        let path = ssh_known_hosts_path();
        if !path.exists() {
            return Ok(0);
        }
        forget_host_key(&host, port, &path)
    })
    .await
    .map_err(|error| format!("SSH known_hosts task failed: {error}"))?
}

async fn ssh_forward_control<R: Runtime>(
    app: &AppHandle<R>,
    state: &TerminalHostBridgeState,
    id: &str,
    action: serde_json::Value,
) -> Result<Vec<ForwardStatus>, String> {
    let response = state
        .client(app)
        .await?
        .request_json(FrameKind::SshForwardControl, parse_session_id(id)?, &action)
        .await?;
    let value: serde_json::Value = serde_json::from_slice(&response.payload)
        .map_err(|error| format!("SSH forwarding snapshot is invalid: {error}"))?;
    serde_json::from_value(value.get("forwards").cloned().unwrap_or_default())
        .map_err(|error| format!("SSH forwarding snapshot is invalid: {error}"))
}

/// Live state of a session's SSH tunnels.
///
/// Pull-only by design: the forwarding panel asks while it is open rather than
/// being pushed at, so a host that gained forwarding never sends an older
/// client a frame kind it cannot decode (ADR-0033).
#[tauri::command]
pub async fn ssh_terminal_forward_status<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, TerminalHostBridgeState>,
    id: String,
) -> Result<Vec<ForwardStatus>, String> {
    ssh_forward_control(&app, &state, &id, serde_json::json!({ "kind": "status" })).await
}

/// Start or stop one forward on a running session, and read the result back.
///
/// The host refuses this from any non-local identity: enabling a rule opens a
/// listening socket on the desktop, or asks the remote server to open one
/// pointing back at it, and neither is a phone's decision (ADR-0082 §8.3).
#[tauri::command]
pub async fn ssh_terminal_set_forward_enabled<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, TerminalHostBridgeState>,
    id: String,
    forward_id: String,
    enabled: bool,
) -> Result<Vec<ForwardStatus>, String> {
    if forward_id.trim().is_empty() {
        return Err("SSH forward id is required".into());
    }
    ssh_forward_control(
        &app,
        &state,
        &id,
        serde_json::json!({
            "kind": "setEnabled",
            "forwardId": forward_id,
            "enabled": enabled,
        }),
    )
    .await
}

async fn list_sessions<R: Runtime>(
    app: &AppHandle<R>,
    state: &TerminalHostBridgeState,
) -> Result<Vec<HostSessionInfo>, String> {
    let response = state
        .client(app)
        .await?
        .request(FrameKind::List, Uuid::nil(), Vec::new())
        .await?;
    let value: serde_json::Value = serde_json::from_slice(&response.payload)
        .map_err(|error| format!("terminal host snapshot is invalid: {error}"))?;
    serde_json::from_value(value.get("sessions").cloned().unwrap_or_default())
        .map_err(|error| format!("terminal session list is invalid: {error}"))
}

#[tauri::command]
pub async fn terminal_list_all<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, TerminalHostBridgeState>,
) -> Result<Vec<HostSessionInfo>, String> {
    list_sessions(&app, &state).await
}

#[tauri::command]
pub async fn terminal_list_for_project<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, TerminalHostBridgeState>,
    project_id: String,
) -> Result<Vec<HostSessionInfo>, String> {
    Ok(list_sessions(&app, &state)
        .await?
        .into_iter()
        .filter(|session| session.project_id.as_deref() == Some(&project_id))
        .collect())
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TerminalHostServiceAction {
    Status,
    Provision {
        #[serde(rename = "deviceId")]
        device_id: String,
        #[serde(rename = "devicePublicKey")]
        device_public_key: String,
        #[serde(rename = "lanUrl")]
        lan_url: Option<String>,
        #[serde(rename = "signalingRoomId")]
        signaling_room_id: Option<String>,
    },
    Configure {
        settings: TerminalHostSettings,
    },
    SyncProfiles {
        profiles: Vec<TerminalHostProfile>,
        #[serde(default)]
        ssh_profiles: Vec<TerminalHostSshProfile>,
    },
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalHostProfile {
    profile_id: String,
    request: SpawnRequest,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalHostSshProfile {
    profile_id: String,
    request: SshSpawnRequest,
}

async fn terminal_host_blocking<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(|error| format!("terminal host blocking task failed: {error}"))?
}

/// Body of the `terminal_host_service` command. The Tauri shell stays in the
/// app (`src-tauri/src/terminal_host_bridge.rs`) because the LAN URL a
/// provisioned descriptor falls back to comes from the companion server's
/// state, which this crate cannot see; the shell passes it in as
/// `lan_url_fallback`, evaluated only when a `provision` action omits `lanUrl`.
pub async fn run_terminal_host_service<R, F>(
    app: &AppHandle<R>,
    state: &TerminalHostBridgeState,
    action: TerminalHostServiceAction,
    lan_url_fallback: F,
) -> Result<TerminalHostStatus, String>
where
    R: Runtime,
    F: FnOnce() -> Option<String> + Send,
{
    let endpoint = terminal_host_blocking(|| Ok(default_terminal_host_endpoint())).await?;
    let client = state.client(app).await?;
    let mut settings = terminal_host_blocking(load_terminal_host_settings).await?;
    let descriptor = match action {
        TerminalHostServiceAction::Status => None,
        TerminalHostServiceAction::Provision {
            device_id,
            device_public_key,
            lan_url,
            signaling_room_id,
        } => {
            let lan_url = lan_url.or_else(lan_url_fallback);
            Some(
                terminal_host_blocking(move || {
                    provision_terminal_host_descriptor(
                        &device_id,
                        &device_public_key,
                        lan_url,
                        signaling_room_id,
                    )
                })
                .await?,
            )
        }
        TerminalHostServiceAction::Configure { settings: updated } => {
            let config = updated.host_config()?;
            client
                .request_json(
                    FrameKind::Hello,
                    Uuid::nil(),
                    &serde_json::json!({ "config": config }),
                )
                .await?;
            let setup_endpoint = endpoint.clone();
            let start_at_login = updated.start_at_login;
            let binary_result = terminal_host_blocking(move || {
                let binary = resolve_server_binary()?;
                set_terminal_host_login_service(start_at_login, &binary, &setup_endpoint)?;
                Ok(binary)
            })
            .await;
            let binary = match binary_result {
                Ok(binary) => binary,
                Err(error) => {
                    if let Ok(previous) = settings.host_config() {
                        let _ = client
                            .request_json(
                                FrameKind::Hello,
                                Uuid::nil(),
                                &serde_json::json!({ "config": previous }),
                            )
                            .await;
                    }
                    return Err(error);
                }
            };
            let persisted = updated.clone();
            if let Err(error) =
                terminal_host_blocking(move || save_terminal_host_settings(&persisted)).await
            {
                if let Ok(previous) = settings.host_config() {
                    let _ = client
                        .request_json(
                            FrameKind::Hello,
                            Uuid::nil(),
                            &serde_json::json!({ "config": previous }),
                        )
                        .await;
                }
                let rollback_start_at_login = settings.start_at_login;
                let rollback_endpoint = endpoint.clone();
                let _ = terminal_host_blocking(move || {
                    set_terminal_host_login_service(
                        rollback_start_at_login,
                        &binary,
                        &rollback_endpoint,
                    )
                })
                .await;
                return Err(error);
            }
            settings = updated;
            None
        }
        TerminalHostServiceAction::SyncProfiles {
            profiles,
            ssh_profiles,
        } => {
            client
                .request_json(
                    FrameKind::Hello,
                    Uuid::nil(),
                    &serde_json::json!({
                        "profiles": profiles,
                        "sshProfiles": ssh_profiles,
                    }),
                )
                .await?;
            None
        }
    };
    Ok(TerminalHostStatus {
        running: true,
        endpoint,
        settings,
        descriptor,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One non-UTF-8 directory must not take the whole hello down with it —
    /// serde's `PathBuf` impl errors on those, and the hello also carries the
    /// host config and the profile table.
    #[test]
    fn path_injection_payload_skips_non_utf8_directories() {
        let mut prepend = vec![PathBuf::from("/opt/cognia/bin")];
        #[cfg(unix)]
        {
            use std::ffi::OsString;
            use std::os::unix::ffi::OsStringExt;
            prepend.push(PathBuf::from(OsString::from_vec(vec![0x2f, 0xff, 0xfe])));
        }
        let payload = path_injection_payload(&crate::session::PathInjection {
            prepend,
            append: vec![PathBuf::from("/home/dev/.cargo/bin")],
        });
        assert_eq!(payload["prepend"], serde_json::json!(["/opt/cognia/bin"]));
        assert_eq!(
            payload["append"],
            serde_json::json!(["/home/dev/.cargo/bin"])
        );
    }

    /// Capability gating is what lets this build talk to an already-running
    /// host binary that predates the feature.
    #[test]
    fn features_from_the_hello_ack_gate_post_release_commands() {
        let (writer, _reader) = mpsc::channel(1);
        let client = BridgeClient {
            writer,
            pending: Mutex::new(HashMap::new()),
            channels: Mutex::new(HashMap::new()),
            next_sequence: AtomicU64::new(1),
            closed: AtomicBool::new(false),
            features: Mutex::new(Vec::new()),
        };
        assert!(!client.supports("flowControl"));
        client.set_features(vec!["pathInjection".into(), "flowControl".into()]);
        assert!(client.supports("flowControl"));
        assert!(!client.supports("history"));
    }

    /// An older host answers the hello without `protocolFeatures`; that must
    /// deserialize to an empty list rather than failing the handshake.
    #[test]
    fn ack_without_protocol_features_degrades_to_an_empty_list() {
        let ack: AckPayload = serde_json::from_slice(br#"{"ok":true,"hostId":"h"}"#).unwrap();
        assert!(ack.protocol_features.is_empty());
    }

    #[tokio::test]
    async fn timed_out_requests_are_removed_from_the_pending_map() {
        let (writer, _reader) = mpsc::channel(1);
        let client = BridgeClient {
            writer,
            pending: Mutex::new(HashMap::new()),
            channels: Mutex::new(HashMap::new()),
            next_sequence: AtomicU64::new(1),
            closed: AtomicBool::new(false),
            features: Mutex::new(Vec::new()),
        };
        let (sender, receiver) = oneshot::channel();
        client.pending.lock().insert(7, sender);

        let error = client
            .await_response(7, receiver, Duration::ZERO)
            .await
            .unwrap_err();

        assert_eq!(error, "terminal host request timed out");
        assert!(!client.pending.lock().contains_key(&7));
    }

    #[test]
    fn unsolicited_session_snapshots_reach_the_channel_as_roster_refreshes() {
        // The host re-sends `SessionSnapshot` (sequence 0) whenever the
        // participant roster or the controller lease changes (ADR-0133). The
        // bridge must surface it as a `session_snapshot` channel event
        // carrying the full `HostSessionInfo`, not drop it as an unknown kind.
        let session_id = Uuid::new_v4();
        let info = serde_json::json!({
            "id": session_id.to_string(),
            "hostId": "host-1",
            "kind": "localPty",
            "profileId": "default",
            "projectId": null,
            "extensionId": null,
            "origin": "local",
            "shell": "/bin/zsh",
            "createdAt": 1,
            "lastActivityAt": 2,
            "currentController": "desktop",
            "attachedClients": 2,
            "participants": [
                { "clientId": "companion:dev-1", "deviceId": "dev-1", "local": false, "role": "viewer" },
                { "clientId": "desktop", "deviceId": null, "local": true, "role": "controller" }
            ],
            "alive": true,
            "sandboxed": false,
            "integrationCapabilities": {
                "osc633": true, "commandStatus": true, "cwdTracking": true, "degradedReason": null
            },
            "replay": { "firstSequence": 0, "lastSequence": 0, "retainedBytes": 0, "truncated": false }
        });
        let frame = TerminalFrame::command(
            FrameKind::SessionSnapshot,
            session_id,
            0,
            serde_json::to_vec(&info).unwrap(),
        );
        match channel_event_for(frame) {
            Some(HostChannelEvent::SessionSnapshot { session }) => {
                assert_eq!(session.id, session_id.to_string());
                assert_eq!(session.participants.len(), 2);
                assert_eq!(session.participants[0].client_id, "companion:dev-1");
                assert_eq!(session.current_controller.as_deref(), Some("desktop"));
            }
            other => panic!("expected a session_snapshot event, got {other:?}"),
        }

        // A malformed snapshot is dropped rather than poisoning the channel.
        let bad = TerminalFrame::command(FrameKind::SessionSnapshot, session_id, 0, b"{".to_vec());
        assert!(channel_event_for(bad).is_none());
        // Kinds the channel does not carry map to nothing.
        let ack = TerminalFrame::command(FrameKind::Ack, session_id, 0, Vec::new());
        assert!(channel_event_for(ack).is_none());
    }

    #[test]
    fn service_actions_decode_without_a_protocol_version() {
        let action: TerminalHostServiceAction =
            serde_json::from_value(serde_json::json!({ "kind": "status" })).unwrap();
        assert!(matches!(action, TerminalHostServiceAction::Status));
        let provision: TerminalHostServiceAction = serde_json::from_value(serde_json::json!({
            "kind": "provision",
            "deviceId": "device-a",
            "devicePublicKey": "public-a"
        }))
        .unwrap();
        assert!(matches!(
            provision,
            TerminalHostServiceAction::Provision { .. }
        ));
        let configure: TerminalHostServiceAction = serde_json::from_value(serde_json::json!({
            "kind": "configure",
            "settings": {
                "allowRemoteAccess": true,
                "startAtLogin": true,
                "diagnostics": false,
                "maxSessions": 32,
                "maxRemoteSessionsPerDevice": 8,
                "replayBytesPerSession": 8388608,
                "totalReplayBytes": 134217728
            }
        }))
        .unwrap();
        assert!(matches!(
            configure,
            TerminalHostServiceAction::Configure { .. }
        ));
    }
}

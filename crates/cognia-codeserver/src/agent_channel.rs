//! Loopback control channel between the app and the companion VS Code extension
//! side-loaded into code-server (Pro IDE Phase 2 — agent↔IDE bidirectional).
//!
//! # Why a dedicated channel
//!
//! code-server's own CLI (`--reuse-window <file>:<line>:<col>`) can only open and
//! reveal — it cannot apply an undo-able edit or read the active editor back. Those
//! need to run *inside* the VS Code extension host, so the app talks to a companion
//! extension (`sidecar/codeserver-agent-ext/`) over this channel. It is hosted here
//! in the `codeserver` module — not the opt-in `companion_api` server — so a core
//! editor feature never depends on remote-access being enabled: it comes up and tears
//! down with the code-server processes it drives.
//!
//! # Transport
//!
//! JSON-RPC 2.0 with LSP-style `Content-Length` framing over a loopback TCP socket
//! (`127.0.0.1`). The protocol major is negotiated in the hello
//! ([`super::broker_protocol::negotiate_protocol`]). Anything that does not open
//! with a `Content-Length` header (the retired newline protocol included) is
//! answered with `IDE_BROKER_PROTOCOL_INCOMPATIBLE` and closed.
//!
//! # Topology
//!
//! There is exactly ONE loopback TCP server per app (lazily bound to `127.0.0.1:0`).
//! Each spawned code-server instance is `register`ed here, which writes a
//! single-use bootstrap credential file for that instance's canonical project
//! root (see [`super::credential`]). Only the file's *path* and the port go into
//! the code-server child's environment (`process.rs`, `remote.rs`); the companion
//! extension reads and unlinks the file, connects, and authenticates. The server
//! maps the credential back to the root and stores the connection, so
//! [`AgentChannel::send`] can address a request "to the editor serving root X".
//!
//! # Handshake
//!
//! ```text
//! ext → app  cognia/auth/challenge { tokenId, clientNonce }
//! app → ext  { challenge }                       // the server nonce
//! ext → app  cognia/hello { tokenId, proof = HMAC(secret, challenge), protocolVersions, … }
//! app → ext  { protocolVersion, generation, sessionId, capabilities, … }
//! ```
//!
//! `tokenId` names either the instance's unconsumed bootstrap credential or its
//! current session. A successful hello consumes a bootstrap, and both sides
//! derive the next session key from the presented secret and the two nonces, so
//! the key itself never crosses the wire. Reconnects present the session; every
//! successful hello rotates it.
//!
//! The newest authenticated connection for a root replaces the previous one,
//! and the replaced socket is closed. Replacement therefore needs proof of the
//! current session or of a bootstrap the host minted itself (initial spawn, an
//! extension-host restart, or a re-mint after the last connection dropped).
//!
//! A bootstrap proven again while the connection that consumed it is still
//! alive means two parties read the same file. That trips the instance: every
//! connection for the root is closed, the session is revoked, a fresh bootstrap
//! is minted, and [`CODESERVER_BROKER_ISSUE_EVENT`] tells the renderer. A
//! session reconnect withdraws any unused bootstrap (other than one minted for
//! a restart the app is driving), so no valid credential file sits beside a
//! live connection.
//!
//! # Messages
//!
//! The editor verbs (`openFile`, `applyEdit`, `readActive`, `saveAll`, `showDiff`,
//! `revealInExplorer`, `runInTerminal`, `notify`, `workspaceSnapshot`) are app →
//! extension requests. The extension reports editor changes as `cognia/event`
//! notifications, re-emitted to the renderer as [`CODESERVER_EDITOR_EVENT`], and
//! forwards generated-proxy callbacks as requests the renderer answers through
//! [`AgentChannel::respond`].

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path as AxumPath, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::routing::{get, put};
use axum::{Json, Router};
use hmac::{Hmac, KeyInit, Mac};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot, Notify, OnceCell};
use uuid::Uuid;

use super::broker_protocol::{
    capability, encode_content_length, extension_request_deadlines, host_request_deadline,
    is_content_length_prefix, negotiate_protocol, read_content_length_value, BROKER_CAPABILITIES,
    CODE_API_VERSION, DEFAULT_CATALOG_HASH, MAX_PROGRESS_EXTENSION, SUPPORTED_PROTOCOL_VERSIONS,
};
use super::credential::{
    content_bearer, credential_file_path, derive_session_key, remove_credential_file,
    secrets_equal, write_credential_file, BootstrapCredential,
};
use super::profile::IdeProfile;

/// Depth of a connection's outbound frame queue. Frames are tiny and infrequent
/// (one per agent editor action), so a small bound is plenty and still applies
/// backpressure rather than growing without limit.
const OUTBOUND_CHANNEL_CAPACITY: usize = 32;
const CONTENT_HANDLE_TTL: Duration = Duration::from_secs(30);
const MAX_CONTENT_HANDLE_BYTES: usize = 64 * 1024 * 1024;
const MAX_CONTENT_HANDLE_COUNT: usize = 128;
const MAX_CONTENT_STORE_BYTES: usize = 128 * 1024 * 1024;
/// How often the channel checks that every disconnected instance still has a
/// bootstrap credential file to find.
const CREDENTIAL_MAINTENANCE_INTERVAL: Duration = Duration::from_secs(5);
/// A bootstrap whose file vanished is only re-minted once it is this old, so an
/// extension that has read the file and is mid-handshake is not raced.
const BOOTSTRAP_REMINT_GRACE: Duration = Duration::from_secs(10);
/// Bounds on the extension's handshake nonce.
const MIN_CLIENT_NONCE_LEN: usize = 16;
const MAX_CLIENT_NONCE_LEN: usize = 256;
/// How long an unauthenticated socket may take to complete the handshake.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// JSON-RPC error code for a client whose framing or protocol major the host
/// cannot speak.
const PROTOCOL_INCOMPATIBLE_CODE: i64 = -32001;
type AuthenticationFailure = (Option<Value>, i64, String);

/// Renderer event carrying an editor change pushed by the companion extension.
pub const CODESERVER_EDITOR_EVENT: &str = "codeserver://editor-event";
/// Renderer event carrying a provider callback from a generated managed proxy.
pub const CODESERVER_BROKER_REQUEST_EVENT: &str = "codeserver://broker-request";
/// Renderer event carrying a cancellation or other one-way broker notification.
pub const CODESERVER_BROKER_NOTIFICATION_EVENT: &str = "codeserver://broker-notification";
/// Renderer event raised when the broker for a workspace hits a problem the
/// user should hear about (see [`BrokerIssue`]).
pub const CODESERVER_BROKER_ISSUE_EVENT: &str = "codeserver://broker-issue";

// ── Renderer payloads ────────────────────────────────────────────────────────

/// Payload of [`CODESERVER_EDITOR_EVENT`]. `root` is the canonical project root the
/// reporting instance serves, so a renderer hosting two panes can tell them apart.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeServerEditorEvent {
    pub root: String,
    pub name: String,
    pub payload: Value,
}

/// A JSON-RPC callback initiated by a generated proxy extension. The renderer
/// routes it into the Cognia plugin runtime, then answers through
/// [`AgentChannel::respond`]. `generation` prevents a stale response from a
/// replaced extension host being delivered to the new one.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeServerBrokerRequest {
    pub root: String,
    pub generation: u64,
    pub id: Value,
    pub method: String,
    pub params: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeServerBrokerNotification {
    pub root: String,
    pub generation: u64,
    pub method: String,
    pub params: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentHandle {
    #[serde(rename = "$type")]
    pub kind: String,
    pub id: String,
    pub size: usize,
    pub sha256: String,
    pub media_type: String,
    pub expires_at_ms: u64,
}

/// Payload of [`CODESERVER_BROKER_ISSUE_EVENT`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeServerBrokerIssueEvent {
    pub root: String,
    pub issue: BrokerIssue,
}

/// A broker-level problem the IDE surfaces instead of failing silently. Each
/// one is emitted as [`CODESERVER_BROKER_ISSUE_EVENT`] when recorded.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BrokerIssue {
    /// The extension offered no protocol major this host speaks.
    ProtocolIncompatible,
    /// The bundled broker extension could not be verified or installed.
    InstallFailed,
    /// The broker's credential file could not be written, so the workbench
    /// started without the broker.
    RegistrationFailed,
    /// A bootstrap credential was presented twice while its first user was live.
    CredentialReplayed,
}

/// Why a managed workbench is running without its broker.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BrokerDisabledReason {
    /// The operator set the managed-IDE kill switch.
    AdminDisabled,
    InstallFailed,
    RegistrationFailed,
    ProtocolIncompatible,
}

/// Whether agent drive is available in a managed workbench, and if not, why.
///
/// Carried on every status so the desktop and a companion host describe the
/// same degraded state the same way: the workbench runs, the broker does not.
/// `None` for the native profile, which never has a broker.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerStatus {
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<BrokerDisabledReason>,
}

/// The broker status for a workbench in `profile` given the kill switch and
/// the issue last recorded for its root.
pub fn broker_status_from(
    profile: IdeProfile,
    platform_enabled: bool,
    issue: Option<BrokerIssue>,
) -> Option<BrokerStatus> {
    if !profile.allows_broker() {
        return None;
    }
    let reason = if !platform_enabled {
        Some(BrokerDisabledReason::AdminDisabled)
    } else {
        match issue {
            Some(BrokerIssue::InstallFailed) => Some(BrokerDisabledReason::InstallFailed),
            Some(BrokerIssue::RegistrationFailed) => Some(BrokerDisabledReason::RegistrationFailed),
            Some(BrokerIssue::ProtocolIncompatible) => {
                Some(BrokerDisabledReason::ProtocolIncompatible)
            }
            // A replay re-mints the credential; the broker keeps serving.
            Some(BrokerIssue::CredentialReplayed) | None => None,
        }
    };
    Some(BrokerStatus {
        enabled: reason.is_none(),
        reason,
    })
}

/// What [`AgentChannel::register_instance_for_host`] hands the spawn path.
#[derive(Debug, Clone)]
pub struct BrokerRegistration {
    pub port: u16,
    pub content_port: u16,
    /// Path of the bootstrap credential file. Goes into the child's environment
    /// under [`super::credential::CREDENTIAL_FILE_ENV`]; the secret does not.
    pub credential_file: PathBuf,
}

// ── Channel state ────────────────────────────────────────────────────────────

/// One connected extension's outbound queue, tagged with a monotonic connection
/// id so a stale close only evicts its own entry (not a fresher reconnect).
struct Conn {
    conn_id: u64,
    tx: mpsc::Sender<Vec<u8>>,
    /// Capabilities both sides offered in the hello.
    capabilities: Vec<String>,
    /// Wakes the connection task so a replaced or revoked socket is actually
    /// closed rather than left to notice on its next inbound frame.
    close: Arc<Notify>,
}

struct PendingRequest {
    root: String,
    conn_id: u64,
    responder: oneshot::Sender<Result<Value, String>>,
    /// Woken by a `$/progress` report for this request, which renews its
    /// deadline on a connection that negotiated [`capability::PROGRESS`].
    progress: Arc<Notify>,
}

#[derive(Default)]
struct Registry {
    /// canonical project root → credential state of the instance serving it.
    instances: HashMap<String, InstanceAuth>,
    /// canonical project root → live extension connection.
    conns: HashMap<String, Conn>,
    /// canonical project root → the last broker problem worth surfacing.
    issues: HashMap<String, BrokerIssue>,
}

/// Credential state for one registered instance. See the module docs.
struct InstanceAuth {
    host_id: String,
    credential_file: PathBuf,
    /// The bootstrap waiting to be consumed, if any.
    bootstrap: Option<PendingBootstrap>,
    /// The bootstrap the current session came from, and the connection that
    /// consumed it. Presenting it again while that connection lives trips the
    /// instance.
    consumed: Option<ConsumedBootstrap>,
    session: Option<SessionCredential>,
}

struct PendingBootstrap {
    credential: BootstrapCredential,
    minted: Instant,
    /// Minted for an extension-host restart the app is driving. It must
    /// survive the old host's session reconnects until the new host uses it;
    /// any other bootstrap is withdrawn as soon as a session reconnects, so no
    /// unused credential sits on disk next to a live connection.
    for_restart: bool,
}

impl PendingBootstrap {
    fn new(credential: BootstrapCredential, for_restart: bool) -> Self {
        Self {
            credential,
            minted: Instant::now(),
            for_restart,
        }
    }
}

struct ConsumedBootstrap {
    token_id: String,
    secret: String,
    conn_id: u64,
}

#[derive(Clone)]
struct SessionCredential {
    session_id: String,
    key: [u8; 32],
}

/// The credential a challenge named, resolved to the secret the proof must use.
#[derive(Clone)]
struct ChallengeScope {
    root: String,
    host_id: String,
    token_id: String,
    kind: CredentialKind,
    secret: Vec<u8>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum CredentialKind {
    Bootstrap,
    Session,
    /// A consumed bootstrap presented again while its consumer is connected.
    /// Still challenged, so only a holder of the secret can trip the instance.
    Replayed,
}

/// Outcome of a successful handshake once committed to the registry.
struct CommittedConnection {
    conn_id: u64,
    session_id: String,
    close: Arc<Notify>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ContentDirection {
    ToRuntime,
    ToExtension,
}

struct ContentRecord {
    handle: ContentHandle,
    root: String,
    generation: u64,
    plugin_id: String,
    provider_id: String,
    permission: Option<String>,
    direction: ContentDirection,
    expires_at: Instant,
    bytes: Vec<u8>,
}

/// Sole owner of the loopback agent-control socket. See the module docs.
pub struct AgentChannel {
    port: OnceCell<u16>,
    content_port: OnceCell<u16>,
    credential_dir: PathBuf,
    /// Serializes credential-file writes and removals with the registry state
    /// they mirror, so the file on disk always names the bootstrap the
    /// registry holds. Always taken before `registry`, never while holding it.
    credential_files: Mutex<()>,
    registry: Mutex<Registry>,
    content: Mutex<HashMap<String, ContentRecord>>,
    pending: Mutex<HashMap<u64, PendingRequest>>,
    next_request_id: AtomicU64,
    next_conn_id: AtomicU64,
    /// Set on the first `register_instance`, so pushed editor events can be
    /// re-emitted to the renderer. `None` in unit tests (and before any spawn),
    /// where an event simply has nowhere to go.
    #[cfg(feature = "tauri-host")]
    app: Mutex<Option<tauri::AppHandle>>,
    /// Headless companion equivalent of `app`: broker callbacks are published
    /// onto the authenticated companion event stream and answered through RPC.
    event_bus: Mutex<Option<Arc<cognia_companion_bus::event_bus::EventBus>>>,
}

impl AgentChannel {
    fn new() -> Self {
        Self::with_credential_dir(super::credential::default_credential_dir())
    }

    fn with_credential_dir(credential_dir: PathBuf) -> Self {
        Self {
            port: OnceCell::new(),
            content_port: OnceCell::new(),
            credential_dir,
            credential_files: Mutex::new(()),
            registry: Mutex::new(Registry::default()),
            content: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            next_request_id: AtomicU64::new(1),
            next_conn_id: AtomicU64::new(1),
            #[cfg(feature = "tauri-host")]
            app: Mutex::new(None),
            event_bus: Mutex::new(None),
        }
    }

    /// Register a freshly-spawned local code-server instance. See
    /// [`Self::register_instance_for_host`].
    pub async fn register_instance(
        self: &Arc<Self>,
        root: &str,
    ) -> Result<BrokerRegistration, String> {
        self.register_instance_for_host(root, "local").await
    }

    /// Register an instance owned by a specific Cognia host: write its first
    /// bootstrap credential file and return what the spawn path injects. Starts
    /// the loopback servers on first call.
    ///
    /// A prior registration for the same root is dropped first — a respawn must
    /// invalidate the dead instance's credentials and connection so nothing the
    /// old instance held can address the new editor. The host id is
    /// authenticated during the hello, so a credential copied from another
    /// paired host cannot attach to this one.
    pub async fn register_instance_for_host(
        self: &Arc<Self>,
        root: &str,
        host_id: &str,
    ) -> Result<BrokerRegistration, String> {
        let port = self.ensure_server().await?;
        let content_port = self.ensure_content_server().await?;
        let credential_file = credential_file_path(&self.credential_dir, root, host_id);
        let bootstrap = BootstrapCredential::mint();
        let replaced = {
            let _files = self.lock_credential_files();
            write_credential_file(&credential_file, &bootstrap)?;
            let (replaced, stale_file) = {
                let mut reg = self.lock_registry();
                reg.issues.remove(root);
                let replaced = reg.conns.remove(root);
                let stale_file = reg
                    .instances
                    .get(root)
                    .map(|previous| previous.credential_file.clone())
                    .filter(|previous| *previous != credential_file);
                reg.instances.insert(
                    root.to_string(),
                    InstanceAuth {
                        host_id: host_id.to_string(),
                        credential_file: credential_file.clone(),
                        bootstrap: Some(PendingBootstrap::new(bootstrap, false)),
                        consumed: None,
                        session: None,
                    },
                );
                (replaced, stale_file)
            };
            if let Some(path) = stale_file {
                remove_credential_file(&path);
            }
            replaced
        };
        if let Some(conn) = replaced {
            conn.close.notify_one();
            self.fail_pending_for_connection(
                root,
                conn.conn_id,
                "Pro IDE extension instance was replaced",
            );
        }
        Ok(BrokerRegistration {
            port,
            content_port,
            credential_file,
        })
    }

    /// Mint a fresh bootstrap for an extension host the app is about to
    /// restart. The live connection stays up until the new host replaces it.
    pub fn prepare_extension_host_restart(&self, root: &str) -> Result<(), String> {
        self.remint_bootstrap(root, true)
    }

    /// Restart the extension host serving `root`, minting the bootstrap the
    /// new host will authenticate with first. The old host is torn down while
    /// it handles the request, so its reply rarely arrives and is not awaited
    /// for success; callers wait for the next generation instead.
    pub async fn restart_extension_host(&self, root: &str) -> Result<(), String> {
        self.prepare_extension_host_restart(root)?;
        let _ = self
            .send(root, "restartManagedExtensionHost", serde_json::json!({}))
            .await;
        Ok(())
    }

    /// Record a broker problem for `root` and tell the renderer. The spawn
    /// paths use this for install and registration failures; the channel uses
    /// it for protocol refusals and the replay tripwire. Cleared by the next
    /// successful handshake or registration.
    pub fn record_issue(&self, root: &str, issue: BrokerIssue) {
        self.lock_registry().issues.insert(root.to_string(), issue);
        if let Ok(payload) = serde_json::to_value(CodeServerBrokerIssueEvent {
            root: root.to_string(),
            issue,
        }) {
            self.emit_renderer(CODESERVER_BROKER_ISSUE_EVENT, payload);
        }
    }

    /// The broker status for the workbench at canonical `root`.
    pub fn broker_status(&self, root: &str, profile: IdeProfile) -> Option<BrokerStatus> {
        let issue = self.lock_registry().issues.get(root).copied();
        broker_status_from(profile, super::managed_platform_enabled(), issue)
    }

    pub async fn content_port(self: &Arc<Self>) -> Result<u16, String> {
        self.ensure_content_server().await
    }

    // Every field participates in content-handle authorization and integrity;
    // keeping them explicit makes accidental scope loss visible at call sites.
    #[allow(clippy::too_many_arguments)]
    pub fn create_content_handle(
        &self,
        root: &str,
        generation: u64,
        plugin_id: &str,
        provider_id: &str,
        permission: Option<String>,
        media_type: String,
        bytes: Vec<u8>,
    ) -> Result<ContentHandle, String> {
        if !self.is_current_connection(root, generation) {
            return Err("stale Pro IDE broker connection generation".to_string());
        }
        self.insert_content(
            root,
            generation,
            plugin_id,
            provider_id,
            permission,
            media_type,
            ContentDirection::ToExtension,
            bytes,
        )
    }

    pub fn redeem_content_handle(
        &self,
        root: &str,
        generation: u64,
        plugin_id: &str,
        provider_id: &str,
        permission: Option<&str>,
        handle_id: &str,
    ) -> Result<Vec<u8>, String> {
        self.take_content(
            root,
            generation,
            plugin_id,
            provider_id,
            permission,
            ContentDirection::ToRuntime,
            handle_id,
        )
    }

    /// Give the channel the handle it needs to re-emit pushed editor events to the
    /// renderer. Called from the spawn path; first caller wins, and subsequent
    /// calls are no-ops.
    ///
    /// Separate from [`Self::register_instance`] rather than a parameter of it so the
    /// registry, framing and correlation logic stay drivable from unit tests, which
    /// have no `AppHandle` to hand over.
    #[cfg(feature = "tauri-host")]
    pub fn attach_app(&self, app: &tauri::AppHandle) {
        let mut slot = self.app.lock().unwrap_or_else(|p| p.into_inner());
        if slot.is_none() {
            *slot = Some(app.clone());
        }
    }

    /// Attach the no-Tauri companion event stream. Unlike editor snapshots,
    /// broker requests must fail when neither runtime surface is attached.
    pub fn attach_event_bus(&self, event_bus: Arc<cognia_companion_bus::event_bus::EventBus>) {
        let mut slot = self.event_bus.lock().unwrap_or_else(|p| p.into_inner());
        *slot = Some(event_bus);
    }

    pub fn connection_generation(&self, root: &str) -> Option<u64> {
        self.lock_registry()
            .conns
            .get(root)
            .map(|connection| connection.conn_id)
    }

    pub async fn wait_for_new_generation(
        &self,
        root: &str,
        previous: u64,
        timeout: Duration,
    ) -> Result<u64, String> {
        let started = Instant::now();
        loop {
            if let Some(generation) = self.connection_generation(root) {
                if generation > previous {
                    return Ok(generation);
                }
            }
            if started.elapsed() >= timeout {
                return Err("managed extension host restart timed out".to_string());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    /// Forget an instance (explicit stop / kill-switch): drop its credentials,
    /// its credential file and any live connection. Idempotent.
    pub fn deregister(&self, root: &str) {
        let (removed_conn, credential_file) = {
            let mut reg = self.lock_registry();
            reg.issues.remove(root);
            let instance = reg.instances.remove(root);
            (
                reg.conns.remove(root),
                instance.map(|instance| instance.credential_file),
            )
        };
        if let Some(path) = credential_file {
            remove_credential_file(&path);
        }
        if let Some(conn) = removed_conn {
            conn.close.notify_one();
            self.fail_pending_for_connection(
                root,
                conn.conn_id,
                "Pro IDE extension instance was deregistered",
            );
        }
    }

    /// Send `method` to the editor serving `root` and await its response. Errors
    /// when no extension is connected for that root (caller degrades to the CLI /
    /// disk-reload path) or the request times out.
    ///
    /// The deadline comes from [`host_request_deadline`]. On a connection that
    /// negotiated [`capability::PROGRESS`], each progress report for this
    /// request renews it, up to [`MAX_PROGRESS_EXTENSION`] after the start. On
    /// one that negotiated [`capability::CANCEL`], a request that times out is
    /// withdrawn with `$/cancelRequest` so the editor stops working on it.
    pub async fn send(&self, root: &str, method: &str, params: Value) -> Result<Value, String> {
        let (tx, conn_id, capabilities) = {
            let reg = self.lock_registry();
            reg.conns
                .get(root)
                .map(|conn| (conn.tx.clone(), conn.conn_id, conn.capabilities.clone()))
                .ok_or_else(|| "Pro IDE extension is not connected for this project".to_string())?
        };
        if method == "managedProxyHandshake"
            && !capabilities
                .iter()
                .any(|cap| cap == capability::CONTRIBUTION_TRANSACTIONS)
        {
            return Err(
                "IDE_CONTRIBUTION_TRANSACTIONS_UNSUPPORTED: the connected broker did not negotiate proxy activation"
                    .to_string(),
            );
        }
        let supports = |name: &str| capabilities.iter().any(|cap| cap == name);

        let id = self.next_request_id.fetch_add(1, Ordering::Relaxed);
        let (response_tx, mut response_rx) = oneshot::channel();
        let progress = Arc::new(Notify::new());
        self.lock_pending().insert(
            id,
            PendingRequest {
                root: root.to_string(),
                conn_id,
                responder: response_tx,
                progress: Arc::clone(&progress),
            },
        );

        let bytes = match encode_content_length(&serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        })) {
            Ok(bytes) => bytes,
            Err(error) => {
                self.lock_pending().remove(&id);
                return Err(error);
            }
        };

        let started = tokio::time::Instant::now();
        let step = host_request_deadline(method);
        let ceiling = started + MAX_PROGRESS_EXTENSION;
        let mut deadline = started + step;
        let outcome = async {
            match tokio::time::timeout_at(deadline, tx.send(bytes)).await {
                Ok(Ok(())) => {}
                Ok(Err(_)) => return Some(Err("Pro IDE extension connection closed".to_string())),
                Err(_) => return None,
            }
            loop {
                tokio::select! {
                    response = &mut response_rx => {
                        return Some(response.unwrap_or_else(|_| {
                            Err("Pro IDE extension dropped the request".to_string())
                        }));
                    }
                    () = progress.notified(), if supports(capability::PROGRESS) => {
                        deadline = (tokio::time::Instant::now() + step).min(ceiling);
                    }
                    () = tokio::time::sleep_until(deadline) => return None,
                }
            }
        }
        .await;
        match outcome {
            Some(result) => result,
            None => {
                self.lock_pending().remove(&id);
                if supports(capability::CANCEL) {
                    if let Ok(cancel) = encode_content_length(&serde_json::json!({
                        "jsonrpc": "2.0",
                        "method": "$/cancelRequest",
                        "params": { "id": id },
                    })) {
                        // Best effort: a full queue means the editor is not
                        // reading, and the request is already forgotten here.
                        let _ = tx.try_send(cancel);
                    }
                }
                Err(format!("Pro IDE extension request timed out: {method}"))
            }
        }
    }

    /// Whether the live connection for `root` negotiated `name`.
    pub fn connection_supports(&self, root: &str, name: &str) -> bool {
        self.lock_registry()
            .conns
            .get(root)
            .is_some_and(|conn| conn.capabilities.iter().any(|cap| cap == name))
    }

    /// Renew the deadline of a pending request the extension reported progress
    /// on. Only the connection the request was sent on can renew it.
    fn renew_pending(&self, root: &str, conn_id: u64, token: &Value) -> bool {
        let Some(id) = token
            .as_u64()
            .or_else(|| token.as_str().and_then(|text| text.parse().ok()))
        else {
            return false;
        };
        let pending = self.lock_pending();
        match pending.get(&id) {
            Some(request) if request.root == root && request.conn_id == conn_id => {
                request.progress.notify_one();
                true
            }
            _ => false,
        }
    }

    /// Answer a callback initiated by a managed proxy extension.
    ///
    /// Responses are scoped to the exact connection generation that originated
    /// the request. Actions are never replayed across reconnects.
    pub async fn respond(
        &self,
        root: &str,
        generation: u64,
        id: Value,
        result: Option<Value>,
        error: Option<Value>,
    ) -> Result<(), String> {
        let tx = {
            let reg = self.lock_registry();
            let conn = reg
                .conns
                .get(root)
                .ok_or_else(|| "Pro IDE extension is not connected for this project".to_string())?;
            if conn.conn_id != generation {
                return Err("stale Pro IDE broker connection generation".to_string());
            }
            conn.tx.clone()
        };
        let response = match error {
            Some(error) => serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": error,
            }),
            None => serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": result.unwrap_or(Value::Null),
            }),
        };
        let bytes = encode_content_length(&response)?;
        tx.send(bytes)
            .await
            .map_err(|_| "Pro IDE extension connection closed".to_string())
    }

    /// Deliver a one-way provider event to the current managed extension host.
    /// Events are state refresh signals and are never replayed after reconnect.
    pub async fn notify_provider(
        &self,
        root: &str,
        generation: u64,
        params: Value,
    ) -> Result<(), String> {
        let tx = {
            let reg = self.lock_registry();
            let conn = reg
                .conns
                .get(root)
                .ok_or_else(|| "Pro IDE extension is not connected for this project".to_string())?;
            if conn.conn_id != generation {
                return Err("stale Pro IDE broker connection generation".to_string());
            }
            conn.tx.clone()
        };
        let bytes = encode_content_length(&serde_json::json!({
            "jsonrpc": "2.0",
            "method": "cognia/provider/event",
            "params": params,
        }))?;
        tx.send(bytes)
            .await
            .map_err(|_| "Pro IDE extension connection closed".to_string())
    }

    // ── internals ────────────────────────────────────────────────────────────

    /// Bind the loopback server once and return its port. Subsequent calls
    /// return the cached port. Requires a tokio runtime (always present under the
    /// Tauri async runtime that spawns code-server). Also starts the credential
    /// maintenance tick (see [`Self::maintain_credentials`]).
    async fn ensure_server(self: &Arc<Self>) -> Result<u16, String> {
        let port = self
            .port
            .get_or_try_init(|| async {
                let listener = TcpListener::bind("127.0.0.1:0")
                    .await
                    .map_err(|e| format!("bind agent channel: {e}"))?;
                let addr = listener
                    .local_addr()
                    .map_err(|e| format!("read agent channel port: {e}"))?;
                let maintained = Arc::downgrade(self);
                tokio::spawn(async move {
                    let mut tick = tokio::time::interval(CREDENTIAL_MAINTENANCE_INTERVAL);
                    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                    loop {
                        tick.tick().await;
                        let Some(channel) = maintained.upgrade() else {
                            break;
                        };
                        channel.maintain_credentials();
                    }
                });
                let channel = Arc::clone(self);
                tokio::spawn(async move {
                    loop {
                        match listener.accept().await {
                            Ok((stream, peer)) => {
                                // The listener binds loopback; reject anything else defensively.
                                if !is_loopback(&peer) {
                                    continue;
                                }
                                tokio::spawn(handle_conn(stream, Arc::clone(&channel)));
                            }
                            Err(e) => {
                                log::warn!("codeserver agent_channel accept error: {e}");
                            }
                        }
                    }
                });
                Ok::<u16, String>(addr.port())
            })
            .await?;
        Ok(*port)
    }

    async fn ensure_content_server(self: &Arc<Self>) -> Result<u16, String> {
        let port = self
            .content_port
            .get_or_try_init(|| async {
                let listener = TcpListener::bind("127.0.0.1:0")
                    .await
                    .map_err(|error| format!("bind content handle server: {error}"))?;
                let port = listener
                    .local_addr()
                    .map_err(|error| format!("read content handle port: {error}"))?
                    .port();
                let router = Router::new()
                    .route("/v1/content", put(upload_content))
                    .route("/v1/content/{id}", get(download_content))
                    .layer(DefaultBodyLimit::max(MAX_CONTENT_HANDLE_BYTES))
                    .with_state(Arc::clone(self));
                tokio::spawn(async move {
                    if let Err(error) = axum::serve(listener, router).await {
                        log::warn!("codeserver content handle server stopped: {error}");
                    }
                });
                Ok::<u16, String>(port)
            })
            .await?;
        Ok(*port)
    }

    /// Resolve a challenge's `tokenId` to the credential it names.
    ///
    /// A consumed bootstrap whose consumer is still connected resolves as
    /// [`CredentialKind::Replayed`]: it is challenged like any other, and only
    /// a correct proof trips the instance (see [`Self::commit_authentication`]),
    /// so knowing a token id alone cannot disconnect the IDE. One whose
    /// consumer is gone is merely refused.
    fn resolve_challenge(&self, token_id: &str) -> Result<ChallengeScope, String> {
        let reg = self.lock_registry();
        for (root, instance) in &reg.instances {
            let scope = |kind, token_id: &str, secret: &[u8]| ChallengeScope {
                root: root.clone(),
                host_id: instance.host_id.clone(),
                token_id: token_id.to_string(),
                kind,
                secret: secret.to_vec(),
            };
            if let Some(pending) = &instance.bootstrap {
                if pending.credential.token_id == token_id {
                    return Ok(scope(
                        CredentialKind::Bootstrap,
                        &pending.credential.token_id,
                        pending.credential.secret.as_bytes(),
                    ));
                }
            }
            if let Some(session) = &instance.session {
                if session.session_id == token_id {
                    return Ok(scope(
                        CredentialKind::Session,
                        &session.session_id,
                        &session.key,
                    ));
                }
            }
            if let Some(consumed) = &instance.consumed {
                if consumed.token_id == token_id {
                    let consumer_live = reg
                        .conns
                        .get(root)
                        .is_some_and(|conn| conn.conn_id == consumed.conn_id);
                    if consumer_live {
                        return Ok(scope(
                            CredentialKind::Replayed,
                            &consumed.token_id,
                            consumed.secret.as_bytes(),
                        ));
                    }
                    return Err("broker credential was already used".to_string());
                }
            }
        }
        Err("invalid broker token id".to_string())
    }

    /// Publish an authenticated connection: consume or rotate the credential it
    /// presented, derive the next session, and replace any previous connection.
    ///
    /// Re-checks under the registry lock that the credential is still the one
    /// the challenge resolved, so a re-mint or trip that raced the handshake
    /// wins. A proven bootstrap that a live connection already consumed — a
    /// replay, or the loser of two parties racing one file — trips the
    /// instance instead of connecting.
    fn commit_authentication(
        &self,
        scope: &ChallengeScope,
        server_nonce: &str,
        client_nonce: &str,
        tx: mpsc::Sender<Vec<u8>>,
        capabilities: Vec<String>,
    ) -> Result<CommittedConnection, String> {
        enum Outcome {
            Committed {
                replaced: Option<Conn>,
                withdrawn_bootstrap: bool,
            },
            Trip,
            Revoked,
        }
        let key = derive_session_key(&scope.secret, server_nonce, client_nonce);
        let session = SessionCredential {
            session_id: Uuid::new_v4().to_string(),
            key,
        };
        let close = Arc::new(Notify::new());
        let conn_id = self.next_conn_id.fetch_add(1, Ordering::Relaxed);
        let outcome = {
            let mut reg = self.lock_registry();
            let consumer_live = |reg: &Registry, consumed: &ConsumedBootstrap| {
                reg.conns
                    .get(&scope.root)
                    .is_some_and(|conn| conn.conn_id == consumed.conn_id)
            };
            match reg.instances.get(&scope.root) {
                None => Outcome::Revoked,
                Some(instance) if instance.host_id != scope.host_id => Outcome::Revoked,
                Some(instance) => {
                    let replayed = instance.consumed.as_ref().is_some_and(|consumed| {
                        consumed.token_id == scope.token_id
                            && secrets_equal(consumed.secret.as_bytes(), &scope.secret)
                            && consumer_live(&reg, consumed)
                    });
                    let still_current = match scope.kind {
                        CredentialKind::Bootstrap => {
                            instance.bootstrap.as_ref().is_some_and(|pending| {
                                pending.credential.token_id == scope.token_id
                                    && secrets_equal(
                                        pending.credential.secret.as_bytes(),
                                        &scope.secret,
                                    )
                            })
                        }
                        CredentialKind::Session => {
                            instance.session.as_ref().is_some_and(|current| {
                                current.session_id == scope.token_id
                                    && secrets_equal(&current.key, &scope.secret)
                            })
                        }
                        CredentialKind::Replayed => false,
                    };
                    if replayed && scope.kind != CredentialKind::Session {
                        Outcome::Trip
                    } else if !still_current {
                        Outcome::Revoked
                    } else {
                        let instance = reg
                            .instances
                            .get_mut(&scope.root)
                            .expect("instance was looked up above");
                        let mut withdrawn_bootstrap = false;
                        match scope.kind {
                            CredentialKind::Bootstrap => {
                                instance.bootstrap = None;
                                instance.consumed = Some(ConsumedBootstrap {
                                    token_id: scope.token_id.clone(),
                                    secret: String::from_utf8_lossy(&scope.secret).into_owned(),
                                    conn_id,
                                });
                                withdrawn_bootstrap = true;
                            }
                            CredentialKind::Session => {
                                // A reconnect proved the session: an unused
                                // reconnect bootstrap must not stay valid on
                                // disk next to this live connection.
                                if instance
                                    .bootstrap
                                    .as_ref()
                                    .is_some_and(|pending| !pending.for_restart)
                                {
                                    instance.bootstrap = None;
                                    withdrawn_bootstrap = true;
                                }
                                if let Some(consumed) = instance.consumed.as_mut() {
                                    consumed.conn_id = conn_id;
                                }
                            }
                            CredentialKind::Replayed => unreachable!("replays never commit"),
                        }
                        instance.session = Some(session.clone());
                        reg.issues.remove(&scope.root);
                        let replaced = reg.conns.insert(
                            scope.root.clone(),
                            Conn {
                                conn_id,
                                tx,
                                capabilities,
                                close: Arc::clone(&close),
                            },
                        );
                        Outcome::Committed {
                            replaced,
                            withdrawn_bootstrap,
                        }
                    }
                }
            }
        };
        match outcome {
            Outcome::Trip => {
                self.trip(&scope.root, BrokerIssue::CredentialReplayed);
                Err("broker credential was already used".to_string())
            }
            Outcome::Revoked => Err("broker credential was revoked".to_string()),
            Outcome::Committed {
                replaced,
                withdrawn_bootstrap,
            } => {
                if withdrawn_bootstrap {
                    self.remove_withdrawn_credential_file(&scope.root);
                }
                if let Some(previous) = replaced {
                    previous.close.notify_one();
                    self.fail_pending_for_connection(
                        &scope.root,
                        previous.conn_id,
                        "Pro IDE extension connection was replaced",
                    );
                }
                Ok(CommittedConnection {
                    conn_id,
                    session_id: session.session_id,
                    close,
                })
            }
        }
    }

    /// Remove `root`'s credential file once the registry no longer holds a
    /// bootstrap for it. Re-checked under the file lock: a re-mint that landed
    /// in between owns the file now and keeps it.
    fn remove_withdrawn_credential_file(&self, root: &str) {
        let _files = self.lock_credential_files();
        let path = {
            let reg = self.lock_registry();
            reg.instances
                .get(root)
                .filter(|instance| instance.bootstrap.is_none())
                .map(|instance| instance.credential_file.clone())
        };
        if let Some(path) = path {
            remove_credential_file(&path);
        }
    }

    /// Two parties held one bootstrap: close every connection for `root`,
    /// revoke its session, mint a fresh bootstrap and tell the renderer.
    fn trip(&self, root: &str, reason: BrokerIssue) {
        let removed = {
            let _files = self.lock_credential_files();
            let (removed, credential) = {
                let mut reg = self.lock_registry();
                let removed = reg.conns.remove(root);
                let credential = reg.instances.get_mut(root).map(|instance| {
                    let bootstrap = BootstrapCredential::mint();
                    instance.session = None;
                    instance.consumed = None;
                    instance.bootstrap = Some(PendingBootstrap::new(bootstrap.clone(), false));
                    (instance.credential_file.clone(), bootstrap)
                });
                (removed, credential)
            };
            if let Some((path, bootstrap)) = credential {
                if let Err(error) = write_credential_file(&path, &bootstrap) {
                    log::warn!("codeserver broker: re-mint after replay failed: {error}");
                }
            }
            removed
        };
        if let Some(conn) = removed {
            conn.close.notify_one();
            self.fail_pending_for_connection(
                root,
                conn.conn_id,
                "Pro IDE broker credential was replayed",
            );
        }
        log::warn!(
            "codeserver broker: bootstrap credential for {root} was presented twice; instance revoked"
        );
        self.record_issue(root, reason);
    }

    /// Replace `root`'s bootstrap with a fresh one and rewrite its file.
    fn remint_bootstrap(&self, root: &str, for_restart: bool) -> Result<(), String> {
        let bootstrap = BootstrapCredential::mint();
        let _files = self.lock_credential_files();
        let path = {
            let mut reg = self.lock_registry();
            let instance = reg
                .instances
                .get_mut(root)
                .ok_or_else(|| "Pro IDE instance is not registered".to_string())?;
            instance.bootstrap = Some(PendingBootstrap::new(bootstrap.clone(), for_restart));
            instance.credential_file.clone()
        };
        write_credential_file(&path, &bootstrap)
    }

    /// Keep a bootstrap file on disk for every instance with no live
    /// connection, so an extension host restart nobody told us about (a
    /// browser reload, a crash after reading the file) can still connect.
    fn maintain_credentials(&self) {
        let candidates: Vec<(String, PathBuf)> = {
            let reg = self.lock_registry();
            reg.instances
                .iter()
                .filter(|(root, instance)| {
                    !reg.conns.contains_key(*root)
                        && instance.bootstrap.as_ref().is_none_or(|pending| {
                            pending.minted.elapsed() >= BOOTSTRAP_REMINT_GRACE
                        })
                })
                .map(|(root, instance)| (root.clone(), instance.credential_file.clone()))
                .collect()
        };
        for (root, path) in candidates {
            if path.exists() {
                continue;
            }
            if let Err(error) = self.remint_bootstrap(&root, false) {
                log::warn!("codeserver broker: re-mint for {root} failed: {error}");
            }
        }
    }

    /// Resolve a content-endpoint bearer (`<sessionId>.<HMAC(session, "content")>`)
    /// to the root and generation of the live connection it belongs to.
    fn current_scope_for_bearer(&self, bearer: &str) -> Option<(String, u64)> {
        let (session_id, presented) = bearer.split_once('.')?;
        let reg = self.lock_registry();
        reg.instances.iter().find_map(|(root, instance)| {
            let session = instance.session.as_ref()?;
            if !secrets_equal(session.session_id.as_bytes(), session_id.as_bytes()) {
                return None;
            }
            let expected = content_bearer(&session.key);
            if !secrets_equal(expected.as_bytes(), presented.as_bytes()) {
                return None;
            }
            reg.conns
                .get(root)
                .map(|connection| (root.clone(), connection.conn_id))
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn insert_content(
        &self,
        root: &str,
        generation: u64,
        plugin_id: &str,
        provider_id: &str,
        permission: Option<String>,
        media_type: String,
        direction: ContentDirection,
        bytes: Vec<u8>,
    ) -> Result<ContentHandle, String> {
        if bytes.len() > MAX_CONTENT_HANDLE_BYTES {
            return Err(format!(
                "IDE_CONTENT_TOO_LARGE: {} exceeds {MAX_CONTENT_HANDLE_BYTES}",
                bytes.len()
            ));
        }
        let now = Instant::now();
        let mut content = self.content.lock().unwrap_or_else(|p| p.into_inner());
        content.retain(|_, record| record.expires_at > now);
        let total = content
            .values()
            .map(|record| record.bytes.len())
            .sum::<usize>();
        if content.len() >= MAX_CONTENT_HANDLE_COUNT
            || total.saturating_add(bytes.len()) > MAX_CONTENT_STORE_BYTES
        {
            return Err("IDE_CONTENT_STORE_SATURATED".to_string());
        }
        let id = Uuid::new_v4().to_string();
        let digest = Sha256::digest(&bytes);
        let handle = ContentHandle {
            kind: "ContentHandle".to_string(),
            id: id.clone(),
            size: bytes.len(),
            sha256: hex::encode(digest),
            media_type,
            expires_at_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .saturating_add(CONTENT_HANDLE_TTL)
                .as_millis() as u64,
        };
        content.insert(
            id,
            ContentRecord {
                handle: handle.clone(),
                root: root.to_string(),
                generation,
                plugin_id: plugin_id.to_string(),
                provider_id: provider_id.to_string(),
                permission,
                direction,
                expires_at: now + CONTENT_HANDLE_TTL,
                bytes,
            },
        );
        Ok(handle)
    }

    #[allow(clippy::too_many_arguments)]
    fn take_content(
        &self,
        root: &str,
        generation: u64,
        plugin_id: &str,
        provider_id: &str,
        permission: Option<&str>,
        direction: ContentDirection,
        handle_id: &str,
    ) -> Result<Vec<u8>, String> {
        let mut content = self.content.lock().unwrap_or_else(|p| p.into_inner());
        let record = content
            .get(handle_id)
            .ok_or_else(|| "IDE_CONTENT_HANDLE_NOT_FOUND".to_string())?;
        if record.expires_at <= Instant::now() {
            content.remove(handle_id);
            return Err("IDE_CONTENT_HANDLE_EXPIRED".to_string());
        }
        if record.root != root
            || record.generation != generation
            || record.plugin_id != plugin_id
            || record.provider_id != provider_id
            || record.permission.as_deref() != permission
            || record.direction != direction
        {
            return Err("IDE_CONTENT_HANDLE_SCOPE_MISMATCH".to_string());
        }
        let record = content
            .remove(handle_id)
            .expect("content handle was checked above");
        let digest = Sha256::digest(&record.bytes);
        if hex::encode(digest) != record.handle.sha256 || record.bytes.len() != record.handle.size {
            return Err("IDE_CONTENT_HANDLE_INTEGRITY_FAILED".to_string());
        }
        Ok(record.bytes)
    }

    /// Drop `root`'s connection only if it is still the one identified by
    /// `conn_id` (a later reconnect for the same root must survive this one's
    /// close). Losing the live connection re-mints a bootstrap so whatever
    /// extension host comes next can find a credential file.
    fn detach_conn(&self, root: &str, conn_id: u64) {
        let (removed, needs_bootstrap) = {
            let mut reg = self.lock_registry();
            if reg
                .conns
                .get(root)
                .is_some_and(|conn| conn.conn_id == conn_id)
            {
                reg.conns.remove(root);
                // A fresh bootstrap (one minted for a restart the new host may
                // already be reading) stays; replacing it would fail that host.
                let needs_bootstrap = reg.instances.get(root).is_some_and(|instance| {
                    instance
                        .bootstrap
                        .as_ref()
                        .is_none_or(|pending| pending.minted.elapsed() >= BOOTSTRAP_REMINT_GRACE)
                });
                (true, needs_bootstrap)
            } else {
                (false, false)
            }
        };
        if removed {
            self.fail_pending_for_connection(root, conn_id, "Pro IDE extension connection closed");
        }
        if needs_bootstrap {
            if let Err(error) = self.remint_bootstrap(root, false) {
                log::warn!("codeserver broker: re-mint after disconnect failed: {error}");
            }
        }
    }

    fn fail_pending_for_connection(&self, root: &str, conn_id: u64, reason: &str) {
        let mut pending = self.lock_pending();
        let ids: Vec<u64> = pending
            .iter()
            .filter_map(|(id, request)| {
                (request.root == root && request.conn_id == conn_id).then_some(*id)
            })
            .collect();
        for id in ids {
            if let Some(request) = pending.remove(&id) {
                let _ = request.responder.send(Err(reason.to_string()));
            }
        }
    }

    fn is_current_connection(&self, root: &str, conn_id: u64) -> bool {
        self.lock_registry()
            .conns
            .get(root)
            .is_some_and(|conn| conn.conn_id == conn_id)
    }

    /// Fire the responder for a correlated response id. Unknown ids (already
    /// timed out) are a silent no-op.
    fn resolve(&self, root: &str, conn_id: u64, id: u64, outcome: Result<Value, String>) {
        let mut pending = self.lock_pending();
        let matches_connection = pending
            .get(&id)
            .is_some_and(|request| request.root == root && request.conn_id == conn_id);
        if matches_connection {
            if let Some(request) = pending.remove(&id) {
                let _ = request.responder.send(outcome);
            }
        }
    }

    /// Re-emit a pushed editor event to the renderer.
    ///
    /// Best-effort and silent: an event describes current state, so a drop (no app
    /// handle yet, no listener, a closing window) is superseded by the next one and
    /// is never worth failing the connection over.
    fn forward_event(&self, root: &str, name: String, payload: Option<Value>) {
        let event = CodeServerEditorEvent {
            root: root.to_string(),
            name,
            payload: payload.unwrap_or(Value::Null),
        };
        if let Ok(value) = serde_json::to_value(event) {
            self.emit_renderer(CODESERVER_EDITOR_EVENT, value);
        }
    }

    /// Best-effort fan-out of a renderer event to the Tauri app and the
    /// headless companion event stream, whichever are attached.
    fn emit_renderer(&self, event: &str, value: Value) {
        #[cfg(feature = "tauri-host")]
        {
            use tauri::Emitter as _;
            let app = {
                let slot = self.app.lock().unwrap_or_else(|p| p.into_inner());
                slot.clone()
            };
            if let Some(app) = app {
                let _ = app.emit(event, value.clone());
            }
        }
        if let Some(bus) = self
            .event_bus
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
        {
            bus.publish(event.to_string(), value);
        }
    }

    fn forward_broker_request(
        &self,
        root: &str,
        generation: u64,
        id: Value,
        method: String,
        params: Value,
    ) -> Result<(), String> {
        #[cfg(feature = "tauri-host")]
        use tauri::Emitter as _;
        let request = CodeServerBrokerRequest {
            root: root.to_string(),
            generation,
            id,
            method,
            params,
        };
        #[cfg(feature = "tauri-host")]
        let app = {
            let slot = self.app.lock().unwrap_or_else(|p| p.into_inner());
            slot.clone()
        };
        #[cfg(feature = "tauri-host")]
        if let Some(app) = app {
            return app
                .emit(CODESERVER_BROKER_REQUEST_EVENT, request)
                .map_err(|error| format!("emit broker request: {error}"));
        }
        let bus = self
            .event_bus
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
            .ok_or_else(|| "Cognia broker runtime is not attached".to_string())?;
        let value = serde_json::to_value(request)
            .map_err(|error| format!("serialize broker request: {error}"))?;
        bus.publish(CODESERVER_BROKER_REQUEST_EVENT.to_string(), value);
        Ok(())
    }

    fn forward_broker_notification(
        &self,
        root: &str,
        generation: u64,
        method: String,
        params: Value,
    ) -> Result<(), String> {
        #[cfg(feature = "tauri-host")]
        use tauri::Emitter as _;
        let notification = CodeServerBrokerNotification {
            root: root.to_string(),
            generation,
            method,
            params,
        };
        #[cfg(feature = "tauri-host")]
        let app = {
            let slot = self.app.lock().unwrap_or_else(|p| p.into_inner());
            slot.clone()
        };
        #[cfg(feature = "tauri-host")]
        if let Some(app) = app {
            return app
                .emit(CODESERVER_BROKER_NOTIFICATION_EVENT, notification)
                .map_err(|error| format!("emit broker notification: {error}"));
        }
        let bus = self
            .event_bus
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
            .ok_or_else(|| "Cognia broker runtime is not attached".to_string())?;
        let value = serde_json::to_value(notification)
            .map_err(|error| format!("serialize broker notification: {error}"))?;
        bus.publish(CODESERVER_BROKER_NOTIFICATION_EVENT.to_string(), value);
        Ok(())
    }

    fn lock_credential_files(&self) -> std::sync::MutexGuard<'_, ()> {
        self.credential_files
            .lock()
            .unwrap_or_else(|p| p.into_inner())
    }

    fn lock_registry(&self) -> std::sync::MutexGuard<'_, Registry> {
        self.registry.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn lock_pending(&self) -> std::sync::MutexGuard<'_, HashMap<u64, PendingRequest>> {
        self.pending.lock().unwrap_or_else(|p| p.into_inner())
    }
}

static AGENT_CHANNEL: Lazy<Arc<AgentChannel>> = Lazy::new(|| Arc::new(AgentChannel::new()));

/// The process-wide agent control channel.
pub fn global() -> Arc<AgentChannel> {
    Arc::clone(&AGENT_CHANNEL)
}

/// The agent-drive verbs, as free functions over an already-canonical root.
///
/// They live here rather than on a host state because neither host contributes
/// anything to them. `CodeServerState` and `RemoteCodeServerState` both did
/// nothing but canonicalize a root and forward to the channel above, which is
/// process-global and keyed by that root. Keeping the verb names and parameter
/// shapes in one place is the point: the desktop and the headless host used to
/// be the only caller and the only non-caller respectively, which is how a
/// desktop driving a remote workbench ended up sending `openFile` to its own
/// machine.
///
/// Canonicalization stays with the caller. The two hosts resolve a workspace
/// root differently (one against the filesystem, one against the set of roots a
/// device is allowed to reach), and collapsing that here would quietly widen
/// what a remote caller can address.
pub mod verbs {
    use super::global;
    use serde_json::{json, Value};

    pub async fn open(
        canonical: &str,
        path: &str,
        line: Option<u32>,
        column: Option<u32>,
    ) -> Result<Value, String> {
        global()
            .send(
                canonical,
                "openFile",
                json!({ "path": path, "line": line, "column": column }),
            )
            .await
    }

    pub async fn apply_edit(
        canonical: &str,
        path: &str,
        line: Option<u32>,
        column: Option<u32>,
    ) -> Result<Value, String> {
        global()
            .send(
                canonical,
                "applyEdit",
                json!({ "path": path, "line": line, "column": column }),
            )
            .await
    }

    pub async fn read_active(canonical: &str) -> Result<Value, String> {
        global().send(canonical, "readActive", json!({})).await
    }

    pub async fn save_all(canonical: &str, path: Option<&str>) -> Result<Value, String> {
        global()
            .send(canonical, "saveAll", json!({ "path": path }))
            .await
    }

    pub async fn show_diff(
        canonical: &str,
        path: &str,
        content: &str,
        title: Option<&str>,
    ) -> Result<Value, String> {
        global()
            .send(
                canonical,
                "showDiff",
                json!({ "path": path, "content": content, "title": title }),
            )
            .await
    }

    pub async fn reveal(canonical: &str, path: &str) -> Result<Value, String> {
        global()
            .send(canonical, "revealInExplorer", json!({ "path": path }))
            .await
    }

    pub async fn run_in_terminal(
        canonical: &str,
        command: &str,
        cwd: Option<&str>,
        name: Option<&str>,
    ) -> Result<Value, String> {
        global()
            .send(
                canonical,
                "runInTerminal",
                json!({ "command": command, "cwd": cwd, "name": name }),
            )
            .await
    }

    pub async fn notify(
        canonical: &str,
        message: &str,
        kind: Option<&str>,
    ) -> Result<Value, String> {
        global()
            .send(
                canonical,
                "notify",
                json!({ "message": message, "kind": kind }),
            )
            .await
    }

    pub async fn workspace_snapshot(canonical: &str, snapshot: Value) -> Result<Value, String> {
        global()
            .send(canonical, "workspaceSnapshot", snapshot)
            .await
    }
}

async fn upload_content(
    State(channel): State<Arc<AgentChannel>>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Result<Json<ContentHandle>, (StatusCode, String)> {
    let credential = bearer_credential(&headers)?;
    let (root, generation) = channel
        .current_scope_for_bearer(credential)
        .ok_or_else(|| unauthorized("invalid or disconnected broker credential"))?;
    let plugin_id = required_content_header(&headers, "x-cognia-plugin-id")?;
    let provider_id = required_content_header(&headers, "x-cognia-provider-id")?;
    let permission = optional_content_header(&headers, "x-cognia-permission")?;
    let media_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    channel
        .insert_content(
            &root,
            generation,
            plugin_id,
            provider_id,
            permission.map(str::to_string),
            media_type,
            ContentDirection::ToRuntime,
            bytes.to_vec(),
        )
        .map(Json)
        .map_err(content_error)
}

async fn download_content(
    State(channel): State<Arc<AgentChannel>>,
    AxumPath(id): AxumPath<String>,
    headers: HeaderMap,
) -> Result<(HeaderMap, Vec<u8>), (StatusCode, String)> {
    let credential = bearer_credential(&headers)?;
    let (root, generation) = channel
        .current_scope_for_bearer(credential)
        .ok_or_else(|| unauthorized("invalid or disconnected broker credential"))?;
    let plugin_id = required_content_header(&headers, "x-cognia-plugin-id")?;
    let provider_id = required_content_header(&headers, "x-cognia-provider-id")?;
    let permission = optional_content_header(&headers, "x-cognia-permission")?;
    let bytes = channel
        .take_content(
            &root,
            generation,
            plugin_id,
            provider_id,
            permission,
            ContentDirection::ToExtension,
            &id,
        )
        .map_err(content_error)?;
    let mut response_headers = HeaderMap::new();
    response_headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    response_headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok((response_headers, bytes))
}

fn bearer_credential(headers: &HeaderMap) -> Result<&str, (StatusCode, String)> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|value| !value.is_empty())
        .ok_or_else(|| unauthorized("missing bearer credential"))
}

fn required_content_header<'a>(
    headers: &'a HeaderMap,
    name: &'static str,
) -> Result<&'a str, (StatusCode, String)> {
    optional_content_header(headers, name)?
        .ok_or_else(|| (StatusCode::BAD_REQUEST, format!("missing {name}")))
}

fn optional_content_header<'a>(
    headers: &'a HeaderMap,
    name: &'static str,
) -> Result<Option<&'a str>, (StatusCode, String)> {
    headers
        .get(name)
        .map(|value| {
            value
                .to_str()
                .map_err(|_| (StatusCode::BAD_REQUEST, format!("invalid {name}")))
        })
        .transpose()
}

fn unauthorized(message: &str) -> (StatusCode, String) {
    (StatusCode::UNAUTHORIZED, message.to_string())
}

fn content_error(message: String) -> (StatusCode, String) {
    let status = if message.contains("SATURATED") {
        StatusCode::TOO_MANY_REQUESTS
    } else if message.contains("TOO_LARGE") {
        StatusCode::PAYLOAD_TOO_LARGE
    } else if message.contains("NOT_FOUND") || message.contains("EXPIRED") {
        StatusCode::NOT_FOUND
    } else {
        StatusCode::FORBIDDEN
    };
    (status, message)
}

/// Whether a peer address is loopback. Extracted (and unit-tested) so the source
/// gate is provable without a live socket. The server binds `127.0.0.1` so this is
/// defence-in-depth against any future non-loopback bind.
fn is_loopback(addr: &SocketAddr) -> bool {
    addr.ip().is_loopback()
}

/// One task per extension connection. The first frames must complete the
/// challenge/hello handshake before the connection is published to callers.
async fn handle_conn(stream: TcpStream, channel: Arc<AgentChannel>) {
    if !stream.peer_addr().map(|a| is_loopback(&a)).unwrap_or(false) {
        return;
    }
    let (read_half, mut write_half) = stream.into_split();
    let mut reader = BufReader::new(read_half);
    let prefix = tokio::time::timeout(HANDSHAKE_TIMEOUT, reader.fill_buf()).await;
    match prefix.unwrap_or(Ok(&[])) {
        Ok([]) => return,
        Ok(prefix) if !is_content_length_prefix(prefix) => {
            // The retired newline bridge (or anything else that is not a
            // `Content-Length` frame). Say so in a frame a current client can
            // read, then close; the unauthenticated peer has no root to blame.
            log::warn!("codeserver broker: refused a connection that is not Content-Length framed");
            let response = jsonrpc_error(
                Value::Null,
                PROTOCOL_INCOMPATIBLE_CODE,
                "IDE_BROKER_PROTOCOL_INCOMPATIBLE: the broker speaks JSON-RPC with Content-Length framing",
                Some(serde_json::json!({ "supportedVersions": SUPPORTED_PROTOCOL_VERSIONS })),
            );
            if let Ok(bytes) = encode_content_length(&response) {
                let _ = write_half.write_all(&bytes).await;
            }
            return;
        }
        Ok(_) => {}
        Err(_) => return,
    }
    let first =
        match tokio::time::timeout(HANDSHAKE_TIMEOUT, read_content_length_value(&mut reader)).await
        {
            Ok(Ok(Some(value))) => value,
            _ => return,
        };

    let (outbound_tx, mut outbound_rx) = mpsc::channel::<Vec<u8>>(OUTBOUND_CHANNEL_CAPACITY);
    let authentication = match tokio::time::timeout(
        HANDSHAKE_TIMEOUT,
        authenticate_jsonrpc_handshake(&channel, &mut reader, &mut write_half, first, outbound_tx),
    )
    .await
    {
        Ok(authentication) => authentication,
        Err(_) => Err((None, -32600, "broker handshake timed out".to_string())),
    };
    let authenticated = match authentication {
        Ok(authenticated) => authenticated,
        Err((id, code, message)) => {
            let response = jsonrpc_error(id.unwrap_or(Value::Null), code, &message, None);
            if let Ok(bytes) = encode_content_length(&response) {
                let _ = write_half.write_all(&bytes).await;
            }
            return;
        }
    };
    let root = authenticated.root;
    let conn_id = authenticated.connection.conn_id;
    let close = authenticated.connection.close;
    let response = serde_json::json!({
        "jsonrpc": "2.0",
        "id": authenticated.hello_id,
        "result": {
            "protocolVersion": authenticated.protocol_version,
            "codeApiVersion": CODE_API_VERSION,
            "catalogHash": DEFAULT_CATALOG_HASH,
            "generation": conn_id,
            "sessionId": authenticated.connection.session_id,
            "capabilities": authenticated.capabilities,
            "requestDeadlinesMs": extension_request_deadlines(),
        }
    });
    let Ok(bytes) = encode_content_length(&response) else {
        channel.detach_conn(&root, conn_id);
        return;
    };
    if write_half.write_all(&bytes).await.is_err() {
        channel.detach_conn(&root, conn_id);
        return;
    }

    loop {
        tokio::select! {
            () = close.notified() => break,
            frame = outbound_rx.recv() => {
                match frame {
                    Some(bytes) => {
                        if write_half.write_all(&bytes).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                }
            }
            incoming = read_content_length_value(&mut reader) => {
                let value = match incoming {
                    Ok(Some(value)) => value,
                    Ok(None) | Err(_) => break,
                };
                if !channel.is_current_connection(&root, conn_id) {
                    break;
                }
                if let Err(reason) = handle_authenticated_frame(&channel, &root, conn_id, value) {
                    log::warn!("codeserver broker frame rejected: {reason}");
                }
            }
        }
    }

    let _ = write_half.shutdown().await;
    channel.detach_conn(&root, conn_id);
}

/// A connection that completed the handshake and is now published.
struct AuthenticatedConnection {
    root: String,
    hello_id: Value,
    protocol_version: String,
    capabilities: Vec<String>,
    connection: CommittedConnection,
}

async fn authenticate_jsonrpc_handshake<R, W>(
    channel: &AgentChannel,
    reader: &mut R,
    writer: &mut W,
    challenge_request: Value,
    outbound_tx: mpsc::Sender<Vec<u8>>,
) -> Result<AuthenticatedConnection, AuthenticationFailure>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let challenge_id = challenge_request.get("id").cloned();
    if challenge_request.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
        || challenge_request.get("method").and_then(Value::as_str) != Some("cognia/auth/challenge")
        || challenge_id.is_none()
    {
        return Err((
            challenge_id,
            -32600,
            "first request must be cognia/auth/challenge".to_string(),
        ));
    }
    let params = challenge_request.get("params").and_then(Value::as_object);
    let token_id = params
        .and_then(|params| params.get("tokenId"))
        .and_then(Value::as_str)
        .ok_or_else(|| {
            (
                challenge_id.clone(),
                -32602,
                "challenge tokenId is required".to_string(),
            )
        })?;
    let client_nonce = params
        .and_then(|params| params.get("clientNonce"))
        .and_then(Value::as_str)
        .filter(|nonce| (MIN_CLIENT_NONCE_LEN..=MAX_CLIENT_NONCE_LEN).contains(&nonce.len()))
        .ok_or_else(|| {
            (
                challenge_id.clone(),
                -32602,
                format!(
                    "challenge clientNonce must be {MIN_CLIENT_NONCE_LEN}..={MAX_CLIENT_NONCE_LEN} characters"
                ),
            )
        })?
        .to_string();
    let scope = channel
        .resolve_challenge(token_id)
        .map_err(|message| (challenge_id.clone(), -32002, message))?;
    let challenge = random_nonce();
    let response = serde_json::json!({
        "jsonrpc": "2.0",
        "id": challenge_id,
        "result": { "challenge": challenge }
    });
    let bytes = encode_content_length(&response).map_err(|message| (None, -32603, message))?;
    writer
        .write_all(&bytes)
        .await
        .map_err(|error| (None, -32603, format!("write broker challenge: {error}")))?;

    let hello = read_content_length_value(reader)
        .await
        .map_err(|message| (None, -32600, message))?
        .ok_or_else(|| (None, -32600, "connection closed before hello".to_string()))?;
    let negotiated = validate_jsonrpc_hello(channel, &hello, &scope, &challenge)?;
    let hello_id = hello.get("id").cloned().unwrap_or(Value::Null);
    let connection = channel
        .commit_authentication(
            &scope,
            &challenge,
            &client_nonce,
            outbound_tx,
            negotiated.capabilities.clone(),
        )
        .map_err(|message| (Some(hello_id.clone()), -32002, message))?;
    Ok(AuthenticatedConnection {
        root: scope.root,
        hello_id,
        protocol_version: negotiated.protocol_version,
        capabilities: negotiated.capabilities,
        connection,
    })
}

struct NegotiatedHello {
    protocol_version: String,
    capabilities: Vec<String>,
}

fn validate_jsonrpc_hello(
    channel: &AgentChannel,
    value: &Value,
    scope: &ChallengeScope,
    challenge: &str,
) -> Result<NegotiatedHello, AuthenticationFailure> {
    let id = value.get("id").cloned();
    if value.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
        || value.get("method").and_then(Value::as_str) != Some("cognia/hello")
        || id.is_none()
    {
        return Err((
            id,
            -32600,
            "second request must be cognia/hello".to_string(),
        ));
    }
    let params = value
        .get("params")
        .and_then(Value::as_object)
        .ok_or_else(|| (id.clone(), -32602, "hello params are required".to_string()))?;
    if params.get("tokenId").and_then(Value::as_str) != Some(scope.token_id.as_str()) {
        return Err((id, -32002, "hello token id changed".to_string()));
    }
    let proof = params
        .get("proof")
        .and_then(Value::as_str)
        .ok_or_else(|| (id.clone(), -32602, "hello proof is required".to_string()))?;
    verify_challenge_proof(&scope.secret, challenge, proof)
        .map_err(|message| (id.clone(), -32002, message))?;

    let versions = params
        .get("protocolVersions")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            (
                id.clone(),
                -32602,
                "protocolVersions are required".to_string(),
            )
        })?
        .iter()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>();
    let Some(protocol_version) = negotiate_protocol(&versions, SUPPORTED_PROTOCOL_VERSIONS) else {
        channel.record_issue(&scope.root, BrokerIssue::ProtocolIncompatible);
        return Err((
            id,
            PROTOCOL_INCOMPATIBLE_CODE,
            format!(
                "IDE_BROKER_PROTOCOL_INCOMPATIBLE: host supports {}",
                SUPPORTED_PROTOCOL_VERSIONS.join(", ")
            ),
        ));
    };
    if params.get("codeApiVersion").and_then(Value::as_str) != Some(CODE_API_VERSION) {
        return Err((
            id,
            PROTOCOL_INCOMPATIBLE_CODE,
            format!("code API mismatch; expected {CODE_API_VERSION}"),
        ));
    }
    if params.get("catalogHash").and_then(Value::as_str) != Some(DEFAULT_CATALOG_HASH) {
        return Err((
            id,
            PROTOCOL_INCOMPATIBLE_CODE,
            format!("capability catalog mismatch; expected {DEFAULT_CATALOG_HASH}"),
        ));
    }
    if params.get("hostId").and_then(Value::as_str) != Some(scope.host_id.as_str()) {
        return Err((
            id,
            -32002,
            "hello host does not match token scope".to_string(),
        ));
    }
    let capabilities = params
        .get("capabilities")
        .and_then(Value::as_array)
        .ok_or_else(|| (id.clone(), -32602, "capabilities are required".to_string()))?
        .iter()
        .filter_map(Value::as_str)
        .filter(|capability| BROKER_CAPABILITIES.contains(capability))
        .map(str::to_string)
        .collect::<Vec<_>>();
    if let Some(workspace) = params.get("workspace").and_then(Value::as_str) {
        if !workspace.is_empty() && workspace != scope.root {
            return Err((
                id,
                -32002,
                "hello workspace does not match token scope".to_string(),
            ));
        }
    }
    Ok(NegotiatedHello {
        protocol_version,
        capabilities,
    })
}

fn verify_challenge_proof(secret: &[u8], challenge: &str, proof: &str) -> Result<(), String> {
    let proof = hex::decode(proof).map_err(|_| "invalid broker challenge proof".to_string())?;
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(secret)
        .map_err(|_| "invalid broker challenge secret".to_string())?;
    mac.update(challenge.as_bytes());
    mac.verify_slice(&proof)
        .map_err(|_| "invalid broker challenge proof".to_string())
}

fn random_nonce() -> String {
    let mut bytes = [0_u8; 32];
    rand::fill(&mut bytes);
    hex::encode(bytes)
}

fn handle_authenticated_frame(
    channel: &AgentChannel,
    root: &str,
    conn_id: u64,
    value: Value,
) -> Result<(), String> {
    if value.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Err("missing jsonrpc 2.0 marker".to_string());
    }
    if let Some(method) = value.get("method").and_then(Value::as_str) {
        match method {
            "cognia/event" => {
                let params = value.get("params").and_then(Value::as_object);
                let name = params
                    .and_then(|params| params.get("name"))
                    .and_then(Value::as_str)
                    .ok_or_else(|| "event name is required".to_string())?;
                let payload = params.and_then(|params| params.get("payload")).cloned();
                channel.forward_event(root, name.to_string(), payload);
                return Ok(());
            }
            "$/progress" => {
                if !channel.connection_supports(root, capability::PROGRESS) {
                    return Err("progress was not negotiated on this connection".to_string());
                }
                let params = value.get("params").cloned().unwrap_or(Value::Null);
                let token = params.get("token").cloned().unwrap_or(Value::Null);
                if !channel.renew_pending(root, conn_id, &token) {
                    return Err(
                        "progress for a request this connection is not answering".to_string()
                    );
                }
                channel.forward_event(root, "brokerProgress".to_string(), Some(params));
                return Ok(());
            }
            "$/cancelRequest" => {
                if !channel.connection_supports(root, capability::CANCEL) {
                    return Err("cancellation was not negotiated on this connection".to_string());
                }
                if value.get("id").is_some() {
                    return Err("$/cancelRequest must be a notification".to_string());
                }
                return channel.forward_broker_notification(
                    root,
                    conn_id,
                    method.to_string(),
                    value.get("params").cloned().unwrap_or(Value::Null),
                );
            }
            "cognia/provider/cancel"
            | "cognia/provider/approvalResponse"
            | "cognia/protocol/cancel" => {
                if value.get("id").is_some() {
                    return Err("broker control message must be a notification".to_string());
                }
                return channel.forward_broker_notification(
                    root,
                    conn_id,
                    method.to_string(),
                    value.get("params").cloned().unwrap_or(Value::Null),
                );
            }
            _ => {
                let id = value
                    .get("id")
                    .cloned()
                    .ok_or_else(|| format!("unsupported broker notification: {method}"))?;
                return channel.forward_broker_request(
                    root,
                    conn_id,
                    id,
                    method.to_string(),
                    value.get("params").cloned().unwrap_or(Value::Null),
                );
            }
        }
    }
    if let Some(id) = value.get("id").and_then(Value::as_u64) {
        let outcome = if let Some(error) = value.get("error") {
            let code = error.get("code").and_then(Value::as_i64).unwrap_or(-32603);
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Pro IDE extension error");
            Err(format!("JSON-RPC {code}: {message}"))
        } else {
            Ok(value.get("result").cloned().unwrap_or(Value::Null))
        };
        channel.resolve(root, conn_id, id, outcome);
        return Ok(());
    }
    Err("JSON-RPC frame has neither response nor method".to_string())
}

fn jsonrpc_error(id: Value, code: i64, message: &str, data: Option<Value>) -> Value {
    let mut error = serde_json::json!({ "code": code, "message": message });
    if let Some(data) = data {
        error["data"] = data;
    }
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": error,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
    use std::path::Path;

    fn is_connected(channel: &AgentChannel, root: &str) -> bool {
        channel.lock_registry().conns.contains_key(root)
    }

    /// A channel whose credential files land in a private temp dir.
    fn test_channel() -> (Arc<AgentChannel>, tempfile::TempDir) {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("cgncs").join("broker");
        (Arc::new(AgentChannel::with_credential_dir(dir)), temp)
    }

    fn read_bootstrap(path: &Path) -> BootstrapCredential {
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
    }

    fn challenge_proof(secret: &[u8], challenge: &str) -> String {
        let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(secret).unwrap();
        mac.update(challenge.as_bytes());
        hex::encode(mac.finalize().into_bytes())
    }

    fn all_caps() -> Vec<String> {
        BROKER_CAPABILITIES
            .iter()
            .map(|cap| cap.to_string())
            .collect()
    }

    /// Attach a connection the way a completed handshake does, without a socket.
    fn attach(channel: &AgentChannel, root: &str) -> (u64, mpsc::Receiver<Vec<u8>>) {
        attach_with(channel, root, all_caps())
    }

    fn attach_with(
        channel: &AgentChannel,
        root: &str,
        capabilities: Vec<String>,
    ) -> (u64, mpsc::Receiver<Vec<u8>>) {
        let scope = channel
            .resolve_challenge(&current_bootstrap(channel, root).token_id)
            .unwrap();
        let (tx, rx) = mpsc::channel::<Vec<u8>>(8);
        let committed = channel
            .commit_authentication(
                &scope,
                "server-nonce",
                "client-nonce-0000",
                tx,
                capabilities,
            )
            .unwrap();
        (committed.conn_id, rx)
    }

    /// Decode the next frame a test connection's outbound queue received.
    async fn next_frame(rx: &mut mpsc::Receiver<Vec<u8>>) -> Value {
        let bytes = rx.recv().await.expect("an outbound frame");
        let mut reader = BufReader::new(bytes.as_slice());
        read_content_length_value(&mut reader)
            .await
            .unwrap()
            .unwrap()
    }

    fn current_bootstrap(channel: &AgentChannel, root: &str) -> BootstrapCredential {
        channel.lock_registry().instances[root]
            .bootstrap
            .as_ref()
            .unwrap()
            .credential
            .clone()
    }

    fn has_bootstrap(channel: &AgentChannel, root: &str) -> bool {
        channel.lock_registry().instances[root].bootstrap.is_some()
    }

    #[test]
    fn broker_status_says_why_a_managed_workbench_has_no_broker() {
        use BrokerDisabledReason as R;
        let status = |platform, issue| broker_status_from(IdeProfile::Managed, platform, issue);
        assert_eq!(
            status(true, None),
            Some(BrokerStatus {
                enabled: true,
                reason: None
            })
        );
        assert_eq!(
            status(true, Some(BrokerIssue::CredentialReplayed)),
            Some(BrokerStatus {
                enabled: true,
                reason: None
            })
        );
        for (issue, reason) in [
            (BrokerIssue::InstallFailed, R::InstallFailed),
            (BrokerIssue::RegistrationFailed, R::RegistrationFailed),
            (BrokerIssue::ProtocolIncompatible, R::ProtocolIncompatible),
        ] {
            assert_eq!(
                status(true, Some(issue)),
                Some(BrokerStatus {
                    enabled: false,
                    reason: Some(reason)
                })
            );
        }
        // The kill switch outranks whatever else went wrong.
        assert_eq!(
            status(false, Some(BrokerIssue::InstallFailed)),
            Some(BrokerStatus {
                enabled: false,
                reason: Some(R::AdminDisabled)
            })
        );
        assert_eq!(broker_status_from(IdeProfile::Native, true, None), None);
        assert_eq!(
            serde_json::to_value(status(false, None)).unwrap(),
            serde_json::json!({ "enabled": false, "reason": "admin-disabled" })
        );
        assert_eq!(
            serde_json::to_value(status(true, None)).unwrap(),
            serde_json::json!({ "enabled": true })
        );
    }

    #[tokio::test]
    async fn broker_status_follows_the_recorded_issue_until_the_extension_connects() {
        let channel = AgentChannel::new();
        channel.record_issue("/w", BrokerIssue::ProtocolIncompatible);
        assert_eq!(
            channel
                .broker_status("/w", IdeProfile::Managed)
                .map(|s| s.reason),
            Some(Some(BrokerDisabledReason::ProtocolIncompatible))
        );
        channel.deregister("/w");
        assert_eq!(
            channel
                .broker_status("/w", IdeProfile::Managed)
                .map(|s| s.enabled),
            Some(true)
        );
    }

    fn issue_of(channel: &AgentChannel, root: &str) -> Option<BrokerIssue> {
        channel.lock_registry().issues.get(root).copied()
    }

    /// Age `root`'s pending bootstrap past the re-mint grace period.
    fn age_bootstrap(channel: &AgentChannel, root: &str) {
        if let Some(pending) = channel
            .lock_registry()
            .instances
            .get_mut(root)
            .unwrap()
            .bootstrap
            .as_mut()
        {
            pending.minted = Instant::now() - BOOTSTRAP_REMINT_GRACE;
        }
    }

    struct Client {
        reader: BufReader<tokio::net::tcp::OwnedReadHalf>,
        writer: tokio::net::tcp::OwnedWriteHalf,
    }

    impl Client {
        async fn connect(port: u16) -> Self {
            let stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            let (read_half, writer) = stream.into_split();
            Self {
                reader: BufReader::new(read_half),
                writer,
            }
        }

        async fn write(&mut self, value: Value) {
            self.writer
                .write_all(&encode_content_length(&value).unwrap())
                .await
                .unwrap();
        }

        async fn read(&mut self) -> Option<Value> {
            tokio::time::timeout(
                Duration::from_secs(2),
                read_content_length_value(&mut self.reader),
            )
            .await
            .expect("broker frame timed out")
            .unwrap()
        }

        /// Run the challenge/hello handshake and return the hello reply.
        async fn handshake(&mut self, token_id: &str, secret: &[u8], versions: &[&str]) -> Value {
            self.write(json!({
                "jsonrpc": "2.0",
                "id": "challenge",
                "method": "cognia/auth/challenge",
                "params": { "tokenId": token_id, "clientNonce": "client-nonce-0001" }
            }))
            .await;
            let reply = self.read().await.unwrap();
            let Some(challenge) = reply["result"]["challenge"].as_str() else {
                return reply;
            };
            let challenge = challenge.to_string();
            self.write(json!({
                "jsonrpc": "2.0",
                "id": "hello",
                "method": "cognia/hello",
                "params": {
                    "tokenId": token_id,
                    "proof": challenge_proof(secret, &challenge),
                    "protocolVersions": versions,
                    "codeApiVersion": CODE_API_VERSION,
                    "catalogHash": DEFAULT_CATALOG_HASH,
                    "hostId": "local",
                    "workspace": "",
                    "capabilities": ["cancel", "structured-errors"]
                }
            }))
            .await;
            let mut hello = self.read().await.unwrap();
            hello["challenge"] = json!(challenge);
            hello
        }
    }

    async fn wait_until(mut condition: impl FnMut() -> bool) {
        for _ in 0..200 {
            if condition() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("condition never became true");
    }

    #[test]
    fn managed_agent_approval_response_is_a_one_way_broker_control_message() {
        let channel = AgentChannel::new();
        let frame = json!({
            "jsonrpc": "2.0",
            "method": "cognia/provider/approvalResponse",
            "params": {
                "invocationId": "invoke-1",
                "requestId": "approval-1",
                "pluginId": "acme.tools",
                "providerId": "cognia.acme.tools.assistant",
                "decision": "allow"
            }
        });
        let error =
            handle_authenticated_frame(&channel, "/work/project", 7, frame.clone()).unwrap_err();
        assert_eq!(error, "Cognia broker runtime is not attached");

        let mut request = frame;
        request["id"] = json!(1);
        let error = handle_authenticated_frame(&channel, "/work/project", 7, request).unwrap_err();
        assert_eq!(error, "broker control message must be a notification");
    }

    #[test]
    fn forwarding_an_event_without_an_app_handle_is_a_silent_no_op() {
        // Unit tests (and the window between process start and the first spawn) have
        // no AppHandle; a pushed event must not panic there.
        let channel = AgentChannel::new();
        channel.forward_event("/work/a", "activeEditorChanged".to_string(), None);
    }

    #[tokio::test]
    async fn registration_writes_a_bootstrap_file_and_never_returns_the_secret() {
        let (channel, _temp) = test_channel();
        let registration = channel.register_instance("/work/a").await.unwrap();
        let bootstrap = read_bootstrap(&registration.credential_file);
        assert_eq!(current_bootstrap(&channel, "/work/a"), bootstrap);
        let rendered = format!("{registration:?}");
        assert!(!rendered.contains(&bootstrap.secret));
    }

    #[tokio::test]
    async fn a_newline_framed_peer_is_told_the_protocol_is_incompatible() {
        let (channel, _temp) = test_channel();
        let registration = channel.register_instance("/work/legacy").await.unwrap();
        let mut stream = TcpStream::connect(("127.0.0.1", registration.port))
            .await
            .unwrap();
        stream
            .write_all(b"{\"type\":\"hello\",\"token\":\"anything\"}\n")
            .await
            .unwrap();
        let mut reader = BufReader::new(stream);
        let reply = tokio::time::timeout(
            Duration::from_secs(2),
            read_content_length_value(&mut reader),
        )
        .await
        .unwrap()
        .unwrap()
        .unwrap();
        assert_eq!(reply["error"]["code"], PROTOCOL_INCOMPATIBLE_CODE);
        assert!(reply["error"]["message"]
            .as_str()
            .unwrap()
            .starts_with("IDE_BROKER_PROTOCOL_INCOMPATIBLE"));
        assert!(!is_connected(&channel, "/work/legacy"));
    }

    #[tokio::test]
    async fn bootstrap_handshake_negotiates_and_correlates_a_request() {
        let (channel, _temp) = test_channel();
        let registration = channel.register_instance("/work/rpc").await.unwrap();
        let bootstrap = read_bootstrap(&registration.credential_file);
        let mut client = Client::connect(registration.port).await;
        let hello = client
            .handshake(&bootstrap.token_id, bootstrap.secret.as_bytes(), &["1.0"])
            .await;
        assert_eq!(hello["id"], "hello");
        assert_eq!(hello["result"]["protocolVersion"], "1.0");
        assert!(hello["result"]["generation"].as_u64().unwrap() > 0);
        assert!(hello["result"]["sessionId"].is_string());
        assert_eq!(
            hello["result"]["capabilities"],
            json!(["cancel", "structured-errors"])
        );
        assert_eq!(hello["result"]["requestDeadlinesMs"]["default"], 30_000);

        let request = {
            let channel = Arc::clone(&channel);
            tokio::spawn(async move { channel.send("/work/rpc", "readActive", json!({})).await })
        };
        let outbound = client.read().await.unwrap();
        assert_eq!(outbound["method"], "readActive");
        let id = outbound["id"].as_u64().unwrap();
        client
            .write(json!({ "jsonrpc": "2.0", "id": id, "result": { "path": "/a.ts" } }))
            .await;
        assert_eq!(request.await.unwrap().unwrap()["path"], "/a.ts");
    }

    #[tokio::test]
    async fn a_hello_with_no_shared_major_is_refused_and_recorded() {
        let (channel, _temp) = test_channel();
        let registration = channel.register_instance("/work/old").await.unwrap();
        let bootstrap = read_bootstrap(&registration.credential_file);
        let mut client = Client::connect(registration.port).await;
        let reply = client
            .handshake(&bootstrap.token_id, bootstrap.secret.as_bytes(), &["0.2"])
            .await;
        assert_eq!(reply["error"]["code"], PROTOCOL_INCOMPATIBLE_CODE);
        assert_eq!(
            issue_of(&channel, "/work/old"),
            Some(BrokerIssue::ProtocolIncompatible)
        );
        assert!(!is_connected(&channel, "/work/old"));
        // A failed hello does not consume the bootstrap.
        assert_eq!(current_bootstrap(&channel, "/work/old"), bootstrap);
    }

    #[tokio::test]
    async fn a_bootstrap_is_single_use_and_reconnects_use_the_derived_session() {
        let (channel, _temp) = test_channel();
        let registration = channel.register_instance("/work/session").await.unwrap();
        let bootstrap = read_bootstrap(&registration.credential_file);
        let mut first = Client::connect(registration.port).await;
        let hello = first
            .handshake(&bootstrap.token_id, bootstrap.secret.as_bytes(), &["1.0"])
            .await;
        let session_id = hello["result"]["sessionId"].as_str().unwrap().to_string();
        let challenge = hello["challenge"].as_str().unwrap().to_string();
        let session_key =
            derive_session_key(bootstrap.secret.as_bytes(), &challenge, "client-nonce-0001");
        drop(first);
        wait_until(|| !is_connected(&channel, "/work/session")).await;

        // The consumed bootstrap no longer authenticates (its consumer is gone,
        // so this is a plain refusal rather than a trip).
        let mut replay = Client::connect(registration.port).await;
        let refused = replay
            .handshake(&bootstrap.token_id, bootstrap.secret.as_bytes(), &["1.0"])
            .await;
        assert_eq!(refused["error"]["code"], -32002);
        assert_eq!(issue_of(&channel, "/work/session"), None);

        // The disconnect re-minted a bootstrap file for whoever comes next…
        wait_until(|| registration.credential_file.exists()).await;
        assert!(has_bootstrap(&channel, "/work/session"));

        // …but the derived session reconnects, rotates, and withdraws it, so no
        // unused credential sits on disk beside the live connection.
        let mut second = Client::connect(registration.port).await;
        let rehello = second.handshake(&session_id, &session_key, &["1.0"]).await;
        assert_eq!(rehello["result"]["protocolVersion"], "1.0");
        assert_ne!(rehello["result"]["sessionId"].as_str().unwrap(), session_id);
        wait_until(|| is_connected(&channel, "/work/session")).await;
        assert!(!has_bootstrap(&channel, "/work/session"));
        assert!(!registration.credential_file.exists());
    }

    #[tokio::test]
    async fn losing_the_connection_re_mints_a_bootstrap_file() {
        let (channel, _temp) = test_channel();
        let registration = channel.register_instance("/work/remint").await.unwrap();
        let bootstrap = read_bootstrap(&registration.credential_file);
        // The extension unlinks the file as soon as it has read it.
        std::fs::remove_file(&registration.credential_file).unwrap();
        let mut client = Client::connect(registration.port).await;
        client
            .handshake(&bootstrap.token_id, bootstrap.secret.as_bytes(), &["1.0"])
            .await;
        wait_until(|| is_connected(&channel, "/work/remint")).await;
        assert!(!registration.credential_file.exists());

        drop(client);
        wait_until(|| registration.credential_file.exists()).await;
        let reminted = read_bootstrap(&registration.credential_file);
        assert_ne!(reminted, bootstrap);
        assert_eq!(current_bootstrap(&channel, "/work/remint"), reminted);
    }

    #[tokio::test]
    async fn replaying_a_bootstrap_while_its_consumer_is_live_trips_the_instance() {
        let (channel, _temp) = test_channel();
        let registration = channel.register_instance("/work/trip").await.unwrap();
        let bootstrap = read_bootstrap(&registration.credential_file);
        let mut legitimate = Client::connect(registration.port).await;
        legitimate
            .handshake(&bootstrap.token_id, bootstrap.secret.as_bytes(), &["1.0"])
            .await;
        wait_until(|| is_connected(&channel, "/work/trip")).await;

        let mut thief = Client::connect(registration.port).await;
        let refused = thief
            .handshake(&bootstrap.token_id, bootstrap.secret.as_bytes(), &["1.0"])
            .await;
        assert_eq!(refused["error"]["code"], -32002);
        assert_eq!(
            issue_of(&channel, "/work/trip"),
            Some(BrokerIssue::CredentialReplayed)
        );
        // Every connection for the root is closed and the session is revoked…
        assert!(!is_connected(&channel, "/work/trip"));
        assert!(legitimate.read().await.is_none());
        assert!(channel.lock_registry().instances["/work/trip"]
            .session
            .is_none());
        // …and a fresh bootstrap is waiting on disk.
        let reminted = read_bootstrap(&registration.credential_file);
        assert_ne!(reminted.token_id, bootstrap.token_id);
    }

    #[tokio::test]
    async fn a_host_driven_restart_bootstrap_replaces_the_live_connection() {
        let (channel, _temp) = test_channel();
        let registration = channel.register_instance("/work/restart").await.unwrap();
        let bootstrap = read_bootstrap(&registration.credential_file);
        let mut old_host = Client::connect(registration.port).await;
        old_host
            .handshake(&bootstrap.token_id, bootstrap.secret.as_bytes(), &["1.0"])
            .await;
        wait_until(|| is_connected(&channel, "/work/restart")).await;
        let old_generation = channel.connection_generation("/work/restart").unwrap();

        channel
            .prepare_extension_host_restart("/work/restart")
            .unwrap();
        let fresh = read_bootstrap(&registration.credential_file);
        let mut new_host = Client::connect(registration.port).await;
        let hello = new_host
            .handshake(&fresh.token_id, fresh.secret.as_bytes(), &["1.0"])
            .await;
        assert!(hello["result"]["generation"].as_u64().unwrap() > old_generation);
        // The replaced socket is closed, not left to notice on its next frame.
        assert!(old_host.read().await.is_none());
    }

    #[tokio::test]
    async fn a_session_reconnect_without_proof_cannot_take_over() {
        let (channel, _temp) = test_channel();
        let registration = channel.register_instance("/work/takeover").await.unwrap();
        let bootstrap = read_bootstrap(&registration.credential_file);
        let mut legitimate = Client::connect(registration.port).await;
        let hello = legitimate
            .handshake(&bootstrap.token_id, bootstrap.secret.as_bytes(), &["1.0"])
            .await;
        let session_id = hello["result"]["sessionId"].as_str().unwrap().to_string();
        let generation = channel.connection_generation("/work/takeover").unwrap();

        // Knowing the session id (it is not secret) without the key fails.
        let mut intruder = Client::connect(registration.port).await;
        let refused = intruder
            .handshake(&session_id, b"guessed-session-key", &["1.0"])
            .await;
        assert_eq!(refused["error"]["code"], -32002);
        assert_eq!(
            channel.connection_generation("/work/takeover"),
            Some(generation)
        );
    }

    #[tokio::test]
    async fn content_bearers_are_derived_from_the_live_session() {
        let (channel, _temp) = test_channel();
        let registration = channel.register_instance("/work/content").await.unwrap();
        let bootstrap = read_bootstrap(&registration.credential_file);
        let mut client = Client::connect(registration.port).await;
        let hello = client
            .handshake(&bootstrap.token_id, bootstrap.secret.as_bytes(), &["1.0"])
            .await;
        let session_id = hello["result"]["sessionId"].as_str().unwrap();
        let challenge = hello["challenge"].as_str().unwrap();
        let key = derive_session_key(bootstrap.secret.as_bytes(), challenge, "client-nonce-0001");
        let bearer = format!("{session_id}.{}", content_bearer(&key));
        let generation = channel.connection_generation("/work/content").unwrap();
        assert_eq!(
            channel.current_scope_for_bearer(&bearer),
            Some(("/work/content".to_string(), generation))
        );
        // The raw bootstrap no longer works as a bearer, and neither does a
        // bearer for the right session with the wrong MAC.
        assert_eq!(
            channel
                .current_scope_for_bearer(&format!("{}.{}", bootstrap.token_id, bootstrap.secret)),
            None
        );
        assert_eq!(
            channel.current_scope_for_bearer(&format!("{session_id}.{}", "0".repeat(64))),
            None
        );
        drop(client);
        wait_until(|| !is_connected(&channel, "/work/content")).await;
        assert_eq!(channel.current_scope_for_bearer(&bearer), None);
    }

    #[tokio::test]
    async fn maintenance_re_mints_a_vanished_bootstrap_after_the_grace_period() {
        let (channel, _temp) = test_channel();
        let registration = channel.register_instance("/work/maintain").await.unwrap();
        let bootstrap = read_bootstrap(&registration.credential_file);
        std::fs::remove_file(&registration.credential_file).unwrap();
        // Inside the grace period an extension may be mid-handshake: leave it.
        channel.maintain_credentials();
        assert!(!registration.credential_file.exists());

        age_bootstrap(&channel, "/work/maintain");
        channel.maintain_credentials();
        let reminted = read_bootstrap(&registration.credential_file);
        assert_ne!(reminted, bootstrap);
    }

    #[tokio::test]
    async fn two_parties_racing_one_bootstrap_trip_the_instance() {
        // Both challenge before either hello commits: the loser must not be a
        // silent refusal that strands the real extension.
        let (channel, _temp) = test_channel();
        channel.register_instance("/work/race").await.unwrap();
        let bootstrap = current_bootstrap(&channel, "/work/race");
        let first = channel.resolve_challenge(&bootstrap.token_id).unwrap();
        let second = channel.resolve_challenge(&bootstrap.token_id).unwrap();
        let (tx1, _rx1) = mpsc::channel::<Vec<u8>>(1);
        let (tx2, _rx2) = mpsc::channel::<Vec<u8>>(1);
        channel
            .commit_authentication(&first, "server-nonce", "client-nonce-0000", tx1, all_caps())
            .unwrap();
        assert_eq!(
            channel
                .commit_authentication(
                    &second,
                    "server-nonce-2",
                    "client-nonce-0001",
                    tx2,
                    all_caps(),
                )
                .err()
                .as_deref(),
            Some("broker credential was already used")
        );
        assert_eq!(
            issue_of(&channel, "/work/race"),
            Some(BrokerIssue::CredentialReplayed)
        );
        assert!(!is_connected(&channel, "/work/race"));
        assert_ne!(current_bootstrap(&channel, "/work/race"), bootstrap);
    }

    #[tokio::test]
    async fn a_replayed_token_id_without_the_secret_does_not_trip() {
        // The token id alone (no proof) must not be able to disconnect the IDE.
        let (channel, _temp) = test_channel();
        let registration = channel.register_instance("/work/noproof").await.unwrap();
        let bootstrap = read_bootstrap(&registration.credential_file);
        let mut legitimate = Client::connect(registration.port).await;
        legitimate
            .handshake(&bootstrap.token_id, bootstrap.secret.as_bytes(), &["1.0"])
            .await;
        wait_until(|| is_connected(&channel, "/work/noproof")).await;

        let mut guesser = Client::connect(registration.port).await;
        let refused = guesser
            .handshake(&bootstrap.token_id, b"not-the-secret", &["1.0"])
            .await;
        assert_eq!(refused["error"]["code"], -32002);
        assert_eq!(issue_of(&channel, "/work/noproof"), None);
        assert!(is_connected(&channel, "/work/noproof"));
    }

    #[tokio::test]
    async fn a_restart_bootstrap_survives_the_old_host_reconnecting() {
        let (channel, _temp) = test_channel();
        let registration = channel.register_instance("/work/keep").await.unwrap();
        let bootstrap = read_bootstrap(&registration.credential_file);
        let mut old_host = Client::connect(registration.port).await;
        let hello = old_host
            .handshake(&bootstrap.token_id, bootstrap.secret.as_bytes(), &["1.0"])
            .await;
        let session_id = hello["result"]["sessionId"].as_str().unwrap().to_string();
        let key = derive_session_key(
            bootstrap.secret.as_bytes(),
            hello["challenge"].as_str().unwrap(),
            "client-nonce-0001",
        );
        channel
            .prepare_extension_host_restart("/work/keep")
            .unwrap();
        let fresh = read_bootstrap(&registration.credential_file);

        // The old host blips and reconnects with its session before going away.
        let mut reconnect = Client::connect(registration.port).await;
        reconnect.handshake(&session_id, &key, &["1.0"]).await;
        assert_eq!(current_bootstrap(&channel, "/work/keep"), fresh);
        assert!(registration.credential_file.exists());
    }

    #[tokio::test]
    async fn a_disconnect_keeps_a_fresh_restart_bootstrap() {
        let (channel, _temp) = test_channel();
        channel.register_instance("/work/fresh").await.unwrap();
        let (generation, _rx) = attach(&channel, "/work/fresh");
        channel
            .prepare_extension_host_restart("/work/fresh")
            .unwrap();
        let fresh = current_bootstrap(&channel, "/work/fresh");
        // The old host's socket closes after the new host may have read the
        // file: replacing the bootstrap now would fail the new host.
        channel.detach_conn("/work/fresh", generation);
        assert_eq!(current_bootstrap(&channel, "/work/fresh"), fresh);
    }

    #[tokio::test(start_paused = true)]
    async fn a_timed_out_request_is_withdrawn_when_cancel_was_negotiated() {
        let (channel, _temp) = test_channel();
        channel.register_instance("/work/cancel").await.unwrap();
        let (_generation, mut rx) = attach(&channel, "/work/cancel");
        let request = {
            let channel = Arc::clone(&channel);
            tokio::spawn(async move { channel.send("/work/cancel", "openFile", json!({})).await })
        };
        let sent = next_frame(&mut rx).await;
        tokio::time::advance(host_request_deadline("openFile") + Duration::from_millis(1)).await;
        let error = request.await.unwrap().unwrap_err();
        assert!(error.contains("timed out: openFile"));
        let cancel = next_frame(&mut rx).await;
        assert_eq!(cancel["method"], "$/cancelRequest");
        assert_eq!(cancel["params"]["id"], sent["id"]);
        assert!(cancel.get("id").is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn no_cancel_is_sent_on_a_connection_that_did_not_negotiate_it() {
        let (channel, _temp) = test_channel();
        channel.register_instance("/work/nocancel").await.unwrap();
        let (_generation, mut rx) =
            attach_with(&channel, "/work/nocancel", vec!["structured-errors".into()]);
        let request = {
            let channel = Arc::clone(&channel);
            tokio::spawn(async move { channel.send("/work/nocancel", "openFile", json!({})).await })
        };
        next_frame(&mut rx).await;
        tokio::time::advance(host_request_deadline("openFile") + Duration::from_millis(1)).await;
        assert!(request.await.unwrap().is_err());
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn progress_renews_a_deadline_up_to_the_ceiling() {
        let (channel, _temp) = test_channel();
        channel.register_instance("/work/progress").await.unwrap();
        let (generation, mut rx) = attach(&channel, "/work/progress");
        let request = {
            let channel = Arc::clone(&channel);
            tokio::spawn(async move { channel.send("/work/progress", "saveAll", json!({})).await })
        };
        let id = next_frame(&mut rx).await["id"].as_u64().unwrap();
        let step = host_request_deadline("saveAll");
        let report = |token: Value| {
            json!({
                "jsonrpc": "2.0",
                "method": "$/progress",
                "params": { "token": token, "value": { "kind": "report", "operation": "saveAll" } }
            })
        };
        // Report twice, each time just before the deadline: still pending.
        for _ in 0..2 {
            tokio::time::advance(step - Duration::from_millis(10)).await;
            handle_authenticated_frame(&channel, "/work/progress", generation, report(json!(id)))
                .unwrap();
            tokio::task::yield_now().await;
        }
        assert!(!request.is_finished());
        // A token for nobody's request is refused rather than renewing anything.
        assert!(handle_authenticated_frame(
            &channel,
            "/work/progress",
            generation,
            report(json!(9999))
        )
        .is_err());
        // Keep reporting: the ceiling still ends the request.
        for _ in 0..20 {
            tokio::time::advance(step - Duration::from_millis(10)).await;
            let _ = handle_authenticated_frame(
                &channel,
                "/work/progress",
                generation,
                report(json!(id.to_string())),
            );
            tokio::task::yield_now().await;
        }
        let error = request.await.unwrap().unwrap_err();
        assert!(error.contains("timed out"));
    }

    #[tokio::test]
    async fn progress_and_cancel_frames_need_their_capability() {
        let (channel, _temp) = test_channel();
        channel.register_instance("/work/caps").await.unwrap();
        let (generation, _rx) = attach_with(&channel, "/work/caps", vec![]);
        let progress =
            json!({ "jsonrpc": "2.0", "method": "$/progress", "params": { "token": 1 } });
        assert!(
            handle_authenticated_frame(&channel, "/work/caps", generation, progress)
                .unwrap_err()
                .contains("not negotiated")
        );
        let cancel =
            json!({ "jsonrpc": "2.0", "method": "$/cancelRequest", "params": { "id": "proxy:1" } });
        assert!(
            handle_authenticated_frame(&channel, "/work/caps", generation, cancel)
                .unwrap_err()
                .contains("not negotiated")
        );
    }

    #[tokio::test]
    async fn an_extension_cancel_reaches_the_broker_runtime() {
        let (channel, _temp) = test_channel();
        let bus = cognia_companion_bus::event_bus::EventBus::new();
        channel.attach_event_bus(Arc::clone(&bus));
        channel.register_instance("/work/xcancel").await.unwrap();
        let (generation, _rx) = attach(&channel, "/work/xcancel");
        let mut receiver = match bus.subscribe(None, 0) {
            cognia_companion_bus::event_bus::SubscribeResult::Ok { receiver, .. } => receiver,
            _ => panic!("subscribe"),
        };
        let cancel =
            json!({ "jsonrpc": "2.0", "method": "$/cancelRequest", "params": { "id": "proxy:7" } });
        handle_authenticated_frame(&channel, "/work/xcancel", generation, cancel).unwrap();
        let frame = receiver.recv().await.unwrap();
        assert_eq!(frame.event_type, CODESERVER_BROKER_NOTIFICATION_EVENT);
        assert_eq!(frame.payload["method"], "$/cancelRequest");
        assert_eq!(frame.payload["params"]["id"], "proxy:7");
        assert_eq!(frame.payload["generation"], generation);
    }

    #[tokio::test]
    async fn proxy_activation_needs_contribution_transactions() {
        let (channel, _temp) = test_channel();
        channel.register_instance("/work/tx").await.unwrap();
        attach_with(&channel, "/work/tx", vec!["cancel".into()]);
        let error = channel
            .send("/work/tx", "managedProxyHandshake", json!({}))
            .await
            .unwrap_err();
        assert!(error.starts_with("IDE_CONTRIBUTION_TRANSACTIONS_UNSUPPORTED"));
    }

    #[test]
    fn challenge_proofs_are_hmac_bound_and_constant_time_verified() {
        let proof = challenge_proof(b"secret", "nonce");
        verify_challenge_proof(b"secret", "nonce", &proof).unwrap();
        assert!(verify_challenge_proof(b"secret", "other", &proof).is_err());
        assert!(verify_challenge_proof(b"forged", "nonce", &proof).is_err());
        assert!(verify_challenge_proof(b"secret", "nonce", "not-hex").is_err());
    }

    #[tokio::test]
    async fn deregister_drops_credentials_files_and_conns_for_a_root() {
        let (channel, _temp) = test_channel();
        let a = channel.register_instance("/work/a").await.unwrap();
        let b = channel.register_instance("/work/b").await.unwrap();
        let _conn = attach(&channel, "/work/a");
        assert!(is_connected(&channel, "/work/a"));

        channel.deregister("/work/a");
        assert!(!is_connected(&channel, "/work/a"));
        assert!(!a.credential_file.exists());
        assert!(!channel.lock_registry().instances.contains_key("/work/a"));
        // Unrelated root untouched.
        assert!(b.credential_file.exists());
        assert!(channel.lock_registry().instances.contains_key("/work/b"));
    }

    #[tokio::test]
    async fn detach_conn_only_evicts_the_matching_connection() {
        let (channel, _temp) = test_channel();
        channel.register_instance("/work/a").await.unwrap();
        let (first, _rx1) = attach(&channel, "/work/a");
        channel.prepare_extension_host_restart("/work/a").unwrap();
        let (second, _rx2) = attach(&channel, "/work/a");
        assert_ne!(first, second);

        // The stale first connection closing must NOT evict the live second one.
        channel.detach_conn("/work/a", first);
        assert!(is_connected(&channel, "/work/a"));

        // The current connection closing does evict.
        channel.detach_conn("/work/a", second);
        assert!(!is_connected(&channel, "/work/a"));
    }

    #[tokio::test]
    async fn waits_for_a_strictly_new_extension_host_generation() {
        let (channel, _temp) = test_channel();
        channel.register_instance("/work/reload").await.unwrap();
        let (first, _first_rx) = attach(&channel, "/work/reload");
        let waiter = {
            let channel = Arc::clone(&channel);
            tokio::spawn(async move {
                channel
                    .wait_for_new_generation("/work/reload", first, Duration::from_secs(1))
                    .await
            })
        };
        channel
            .prepare_extension_host_restart("/work/reload")
            .unwrap();
        let (second, _second_rx) = attach(&channel, "/work/reload");
        assert!(second > first);
        assert_eq!(waiter.await.unwrap().unwrap(), second);
    }

    #[test]
    fn resolve_fires_the_pending_responder_and_ignores_unknown_ids() {
        let channel = AgentChannel::new();
        let (tx, rx) = oneshot::channel();
        channel.lock_pending().insert(
            42,
            PendingRequest {
                root: "/work/a".to_string(),
                conn_id: 7,
                responder: tx,
                progress: Arc::new(Notify::new()),
            },
        );

        // Each binding dimension is independently load-bearing.
        channel.resolve("/work/a", 8, 42, Ok(json!({ "wrong_conn": true })));
        assert!(channel.lock_pending().contains_key(&42));
        channel.resolve("/work/b", 7, 42, Ok(json!({ "wrong_root": true })));
        assert!(channel.lock_pending().contains_key(&42));

        channel.resolve("/work/a", 7, 42, Ok(json!({ "ok": 1 })));
        assert_eq!(rx.blocking_recv().unwrap().unwrap()["ok"], 1);

        // Unknown id — no panic, no effect.
        channel.resolve("/work/a", 7, 999, Ok(Value::Null));
    }

    #[tokio::test]
    async fn content_handles_are_scoped_integrity_checked_and_one_shot() {
        let (channel, _temp) = test_channel();
        channel.register_instance("/work/a").await.unwrap();
        let (generation, _rx) = attach(&channel, "/work/a");
        let handle = channel
            .insert_content(
                "/work/a",
                generation,
                "acme",
                "cognia.acme.fs",
                Some("filesystem:write".to_string()),
                "application/octet-stream".to_string(),
                ContentDirection::ToRuntime,
                vec![1, 2, 3],
            )
            .unwrap();

        assert!(channel
            .redeem_content_handle(
                "/work/a",
                generation,
                "other",
                "cognia.acme.fs",
                Some("filesystem:write"),
                &handle.id,
            )
            .is_err());
        assert_eq!(
            channel
                .redeem_content_handle(
                    "/work/a",
                    generation,
                    "acme",
                    "cognia.acme.fs",
                    Some("filesystem:write"),
                    &handle.id,
                )
                .unwrap(),
            vec![1, 2, 3]
        );
        assert!(channel
            .redeem_content_handle(
                "/work/a",
                generation,
                "acme",
                "cognia.acme.fs",
                Some("filesystem:write"),
                &handle.id,
            )
            .unwrap_err()
            .contains("NOT_FOUND"));
    }

    #[tokio::test]
    async fn send_errors_when_no_extension_is_connected() {
        let channel = AgentChannel::new();
        let err = channel
            .send("/work/absent", "openFile", json!({}))
            .await
            .unwrap_err();
        assert!(err.contains("not connected"));
    }

    #[test]
    fn loopback_gate_accepts_localhost_and_rejects_public() {
        assert!(is_loopback(&SocketAddr::new(
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            5555
        )));
        assert!(is_loopback(&SocketAddr::new(
            IpAddr::V6(Ipv6Addr::LOCALHOST),
            5555
        )));
        assert!(!is_loopback(&SocketAddr::new(
            IpAddr::V4(Ipv4Addr::new(203, 0, 113, 7)),
            5555
        )));
    }

    #[tokio::test]
    async fn a_response_from_an_unauthenticated_socket_cannot_consume_a_request() {
        let (channel, _temp) = test_channel();
        let registration = channel.register_instance("/work/auth").await.unwrap();
        let bootstrap = read_bootstrap(&registration.credential_file);
        let mut legitimate = Client::connect(registration.port).await;
        legitimate
            .handshake(&bootstrap.token_id, bootstrap.secret.as_bytes(), &["1.0"])
            .await;

        let request = {
            let channel = Arc::clone(&channel);
            tokio::spawn(async move { channel.send("/work/auth", "readActive", json!({})).await })
        };
        let id = legitimate.read().await.unwrap()["id"].as_u64().unwrap();

        let mut unauthenticated = Client::connect(registration.port).await;
        unauthenticated
            .write(json!({ "jsonrpc": "2.0", "id": id, "result": "forged" }))
            .await;
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!request.is_finished());

        legitimate
            .write(json!({ "jsonrpc": "2.0", "id": id, "result": "real" }))
            .await;
        assert_eq!(request.await.unwrap().unwrap(), json!("real"));
    }

    #[tokio::test]
    async fn malformed_and_oversized_frames_close_the_connection() {
        let (channel, _temp) = test_channel();
        let registration = channel.register_instance("/work/frames").await.unwrap();

        let mut malformed = TcpStream::connect(("127.0.0.1", registration.port))
            .await
            .unwrap();
        malformed
            .write_all(b"Content-Length: 5\r\n\r\n{nope")
            .await
            .unwrap();
        let mut reader = BufReader::new(malformed);
        let eof = tokio::time::timeout(
            Duration::from_secs(2),
            read_content_length_value(&mut reader),
        )
        .await
        .unwrap();
        assert!(matches!(eof, Ok(None)));

        let mut oversized = TcpStream::connect(("127.0.0.1", registration.port))
            .await
            .unwrap();
        oversized
            .write_all(
                format!(
                    "Content-Length: {}\r\n\r\n",
                    super::super::broker_protocol::MAX_FRAME_BYTES + 1
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        let mut reader = BufReader::new(oversized);
        let eof = tokio::time::timeout(
            Duration::from_secs(2),
            read_content_length_value(&mut reader),
        )
        .await
        .unwrap();
        assert!(matches!(eof, Ok(None)));
        assert!(!is_connected(&channel, "/work/frames"));
    }

    #[tokio::test]
    async fn a_challenge_without_a_client_nonce_is_refused() {
        let (channel, _temp) = test_channel();
        let registration = channel.register_instance("/work/nonce").await.unwrap();
        let bootstrap = read_bootstrap(&registration.credential_file);
        let mut client = Client::connect(registration.port).await;
        client
            .write(json!({
                "jsonrpc": "2.0",
                "id": "challenge",
                "method": "cognia/auth/challenge",
                "params": { "tokenId": bootstrap.token_id }
            }))
            .await;
        let reply = client.read().await.unwrap();
        assert_eq!(reply["error"]["code"], -32602);
    }
}

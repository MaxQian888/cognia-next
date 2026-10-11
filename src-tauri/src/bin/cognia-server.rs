//! `cognia-server` — headless deployment of the cognia companion API.
//!
//! # What this binary does
//!
//! - Opens (or creates) a SQLite-backed `AppStore` at
//!   `$COGNIA_DATA_DIR/cognia-server.sqlite`. There is no `--data-dir` flag on
//!   this binary: the directory comes from the `COGNIA_DATA_DIR` environment
//!   variable (`scripts/dev/headless.mjs` accepts `--data-dir` and translates
//!   it into that variable).
//! - Loads or generates the TLS material in the same directory so the
//!   self-signed cert is stable across restarts.
//! - Exposes two subcommands:
//!   - `cognia-server pair --device-name <name>` asks the running server for a
//!     one-time Owner invitation and prints its `cgnp4|<base64>` relay payload
//!     with a terminal QR code (ADR-0224 A2); `--direct` accepts a relay-less
//!     `cgnp3|<base64>` instead.
//!   - `cognia-server serve --port <port>` boots the axum HTTPS server, the
//!     `SecurityStore`, the `EventBus`, all four bridges and the signaling hub,
//!     and supervises the Node brain that owns the data plane.
//!
//! # How it serves without an AppHandle
//!
//! `companion_api::server::spawn_server` used to require a `SharedState`
//! carrying a `tauri::AppHandle`, and every mutating RPC round-tripped through
//! the WebView. That is no longer true, and this docblock claimed it was long
//! after the milestone it called "next" had shipped.
//!
//! `companion_api::dispatch_host::DispatchHost` is the seam: it is either
//! `Tauri(AppHandle)` or `Headless(Arc<HeadlessServices>)`, and every arm asks
//! it for what it needs rather than reaching for `app.state::<T>()`.
//! `headless::HeadlessServices` is the process-global registry standing in for
//! Tauri's managed state, and `headless::brain` supervises the Node process
//! that answers the data plane over `/internal/bridge`. An arm that genuinely
//! requires one host says so with `tauri_app(name)` or `headless()`, and the
//! refusal names which host it needed.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use app_lib::companion_api::{
    data_plane::install_headless_store,
    deny_list::DenyList,
    desktop_messages_bridge::DesktopMessagesBridge,
    desktop_writes_bridge::DesktopWritesBridge,
    device_grants::{DeviceGrantStore, FileDeviceGrantStore, GrantKind},
    event_bus::EventBus,
    idempotency::IdempotencyCache,
    lark_entry,
    push::PushTokenRegistry,
    push_creds::{self, FilePushCredStore},
    rate_limit::RateLimiter,
    secret,
    security_store::{install_security_store, SecurityStore},
    server, set_advertised_port, set_tls_fingerprint,
    signaling::{self, registration_store::SignalingRegistrationStore, SignalingHub},
    store::{sqlite::SqliteAppStore, AppStore},
    sync_bridge::SyncBridge,
    sync_registry::SyncTableRegistry,
    tls, CompanionState, SharedState,
};
use app_lib::headless::{
    backup, brain, exec_backend_from_env, generate_master_key, headless_services,
    init_secret_store, install_headless_services, kill_sidecar, parse_master_key,
    rotate_master_key, spawn_sidecar, ApiKeyState, HeadlessServices, HeadlessSidecarHost,
    SpawnPolicy, MASTER_KEY_ENV, SIDECAR_SCRIPT_ENV,
};
use parking_lot::RwLock;

use clap::{Parser, Subcommand};

/// Fallback local account for a deployment that names none.
///
/// Kept as a literal because the Node brain's own account registry defaults to
/// the same id (`HEADLESS_LOCAL_ACCOUNT_ID` in `cli/src/serve/account.ts`); the
/// two must agree or `desktop-sync-source` rejects the brain's pulls. It is a
/// local account *namespace*, not a tenant — the tenant now comes from the host
/// binding this id is bound to at startup.
const HEADLESS_LOCAL_ACCOUNT_ID: &str = "local_acct_a";

/// cognia-server — headless cognia companion API.
///
/// Set `COGNIA_DATA_DIR` to override the platform data dir; the SQLite
/// store, TLS cert, and push-credential files all live there.
#[derive(Debug, Parser)]
#[command(name = "cognia-server", version, about, long_about = None)]
struct Cli {
    /// Local account this deployment serves. A command line is a legitimate
    /// trust root here — unlike the desktop, there is no renderer to lie about
    /// it — so this value is bound directly, without a password verifier.
    ///
    /// Defaults to `COGNIA_LOCAL_ACCOUNT_ID`, else the historical
    /// `local_acct_a`, which is also the id the Node brain creates in its own
    /// account registry (`cli/src/serve/account.ts`). The two must agree or the
    /// brain's sync pulls are rejected.
    #[arg(long, global = true)]
    local_account_id: Option<String>,

    #[command(subcommand)]
    command: CliCommand,
}

#[derive(Debug, Subcommand)]
enum CliCommand {
    /// Run only the durable integrated-terminal host. No brain, AI sidecar,
    /// gateway, browser, or general companion services are started.
    DesktopHost {
        /// Owner-only Unix socket path or Windows named-pipe name.
        #[arg(long)]
        endpoint: Option<String>,
        /// Allow credential prompts for an explicit desktop recovery request.
        #[arg(long)]
        authorize_credentials: bool,
    },
    /// Issue a one-shot Owner invitation through the running server and print
    /// the `cgnp4` relay invitation (with a QR code) the app scans or pastes.
    /// Refuses a relay-less invitation, and says why, unless `--direct`.
    Pair {
        /// Human label for the device being paired.
        #[arg(long, default_value = "headless-pair")]
        device_name: String,
        /// Base URL encoded into the pair payload (what the phone will
        /// dial). Defaults to `COGNIA_PUBLIC_URL`, else
        /// `https://127.0.0.1:<port>`.
        #[arg(long)]
        advertise_url: Option<String>,
        /// Port of the running server to ask for the invitation, also used for
        /// the default advertise URL. Defaults to `COGNIA_PORT`, else 27890.
        #[arg(long)]
        port: Option<u16>,
        /// Tenant/organization encoded into the cgnp3 payload. Defaults to the
        /// tenant this host is bound to.
        #[arg(long)]
        tenant_id: Option<String>,
        /// Accept an invitation without a relay room: the device must reach
        /// the advertise URL directly (same network, or a public URL).
        #[arg(long, default_value_t = false)]
        direct: bool,
        /// Print only the invitation string, without the terminal QR code.
        #[arg(long, default_value_t = false)]
        no_qr: bool,
    },
    /// Boot the HTTPS companion server. Binds 0.0.0.0:<port> by default.
    Serve {
        #[arg(long, default_value_t = app_lib::companion_api::server::DEFAULT_PORT)]
        port: u16,
        /// Public base URL advertised in pair payloads/logs. Defaults to
        /// `COGNIA_PUBLIC_URL`, else `https://127.0.0.1:<bound port>`.
        #[arg(long)]
        advertise_url: Option<String>,
        /// Persistently enable remote terminal socket tickets for paired
        /// devices that also hold the terminal control grant.
        #[arg(long, default_value_t = false)]
        allow_remote_terminal: bool,
        /// Bind only to 127.0.0.1. Intended for process-local development
        /// and automatic local-debug authentication.
        #[arg(long, default_value_t = false)]
        bind_loopback: bool,
        /// Also bind the plaintext, **loopback-only** browser listener on this
        /// port (27891 is the conventional one — `browser_access`).
        ///
        /// A browser cannot pin this Host's self-signed certificate, so the
        /// HTTPS listener is unreachable from a tab without a manual
        /// certificate interstitial. `http://127.0.0.1` needs no chain at all,
        /// which makes it the one address a browser reaches unaided.
        ///
        /// Off unless passed. Deliberately a flag and not an environment
        /// variable: the listener is hard-bound to loopback, so it is only
        /// meaningful when the browser runs on this same machine — which a
        /// containerised deployment never is.
        ///
        /// Requires `COGNIA_ALLOWED_WEB_ORIGINS`; a listener with an empty
        /// allowlist refuses every browser request.
        #[arg(long)]
        browser_listener_port: Option<u16>,
        /// Do not advertise this Host as `_cognia._tcp` over mDNS.
        ///
        /// A LAN-bound server advertises by default so the mobile app's
        /// "Find your desktop" scan lists it, exactly as the desktop does. Pass
        /// this where multicast has no meaning or must not leak the host's
        /// presence (a container, a shared network). A `--bind-loopback`
        /// server never advertises: nothing off-host could connect to it.
        #[arg(long, default_value_t = false)]
        no_mdns: bool,
    },
    /// Re-encrypt the secret store under a new master key (ADR-0059 R9).
    /// The old key comes from COGNIA_MASTER_KEY(_FILE); stored values —
    /// including the JWT signing secret, so paired devices stay paired —
    /// are unchanged. Update the env to the new key before the next boot.
    RotateMasterKey {
        /// The new 64-hex-char key. Omit to generate one (printed to stdout).
        #[arg(long)]
        new_key: Option<String>,
    },
    /// Create a consistent, encrypted recovery point and upload it to the
    /// configured S3-compatible object store.
    Backup {
        #[arg(long)]
        id: String,
    },
    /// Restore a recovery point into a new directory. Existing/live data is
    /// never overwritten.
    Restore {
        #[arg(long)]
        recovery_point: String,
        #[arg(long)]
        destination_volume: PathBuf,
        #[arg(long, default_value_t = false)]
        read_only_smoke: bool,
    },
    /// Rotate to a master-key version already provisioned by SecretProvider.
    RotateKey {
        #[arg(long)]
        version: String,
    },
    /// Verify a newly restored volume without starting the server.
    VerifyRestore {
        #[arg(long)]
        data_dir: PathBuf,
    },
    /// Print a service-scope JWT (24h) for the local account. Service tokens
    /// are honored ONLY from loopback, so the value is useless off-host;
    /// still treat it as a secret. Used by the tier-2 smoke to drive the
    /// service-only external-agent arms from inside the container.
    IssueServiceToken,
    /// Provider Profile Store administration (ADR-0090 Phase 1). The store
    /// is secret-free by construction: exports carry credential REFERENCES
    /// only, and imports refuse inline secret material.
    Profiles {
        #[command(subcommand)]
        command: ProfilesCommand,
    },
    /// Headless LLM Gateway administration (ADR-0090 Phase 2). `serve`
    /// starts the gateway when its persisted config is enabled (or
    /// COGNIA_GATEWAY=1); these subcommands manage the gateway API keys a
    /// client needs, without a renderer.
    Gateway {
        #[command(subcommand)]
        command: GatewayCommand,
    },
    /// Per-device capability grants (ADR-0097).
    ///
    /// A paired device gets read-only sync and baseline chat for free.
    /// Everything elevated is granted per device, and on the desktop that
    /// happens through the paired-devices toggles. A headless host has no
    /// renderer, so before this existed nothing could populate the allow list
    /// and every elevated command was unreachable here no matter what.
    ///
    /// Grants take effect at the next `serve`.
    Devices {
        #[command(subcommand)]
        command: DevicesCommand,
    },
    /// Create this host's master key file (`<data dir>/master.key`, 0600)
    /// unless one exists. `serve` reads it when no other key source is set
    /// (ADR-0224 A1). An existing key is never replaced.
    Init {
        /// Store a new key in the platform credential store instead
        /// (`COGNIA_MASTER_KEY_SOURCE=keychain`). Not for a LaunchDaemon,
        /// which has no login Keychain.
        #[arg(long, default_value_t = false)]
        keychain: bool,
    },
    /// Run this host as an always-on OS service: a LaunchDaemon or LaunchAgent
    /// on macOS, a systemd unit on Linux (ADR-0224 A1).
    Service {
        #[command(subcommand)]
        command: ServiceCommand,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
enum ServiceScopeArg {
    /// Starts at boot without a login; needs sudo; runs as `--run-as`.
    System,
    /// Starts when this user logs in.
    User,
}

impl From<ServiceScopeArg> for cognia_host_service::ServiceScope {
    fn from(value: ServiceScopeArg) -> Self {
        match value {
            ServiceScopeArg::System => cognia_host_service::ServiceScope::System,
            ServiceScopeArg::User => cognia_host_service::ServiceScope::User,
        }
    }
}

#[derive(Debug, Subcommand)]
enum ServiceCommand {
    /// Install and start the service from this host install directory.
    Install {
        #[arg(long, value_enum, default_value_t = ServiceScopeArg::System)]
        scope: ServiceScopeArg,
        /// Host install directory (`<root>/bin/cognia-server`). Defaults to
        /// the one this binary belongs to.
        #[arg(long)]
        install_root: Option<PathBuf>,
        /// Defaults to the service account's own `cognia-server` data dir.
        #[arg(long)]
        data_dir: Option<PathBuf>,
        #[arg(long, default_value_t = app_lib::companion_api::server::DEFAULT_PORT)]
        port: u16,
        /// Written as `COGNIA_PUBLIC_URL`. Optional: devices pair over the relay.
        #[arg(long)]
        public_url: Option<String>,
        /// Account a system service runs as. Defaults to the user who ran sudo.
        #[arg(long)]
        run_as: Option<String>,
        /// Do not advertise the host over mDNS.
        #[arg(long, default_value_t = false)]
        no_mdns: bool,
    },
    /// Stop the service and remove its definition. Data and keys are kept.
    Uninstall {
        #[arg(long, value_enum, default_value_t = ServiceScopeArg::System)]
        scope: ServiceScopeArg,
    },
    /// Whether the service is installed and running, and whether the server
    /// answers ready on its loopback port.
    Status {
        #[arg(long, value_enum, default_value_t = ServiceScopeArg::System)]
        scope: ServiceScopeArg,
        /// Port the service was installed with.
        #[arg(long, default_value_t = app_lib::companion_api::server::DEFAULT_PORT)]
        port: u16,
    },
}

#[derive(Debug, Subcommand)]
enum DevicesCommand {
    /// Create a one-time Companion API Owner invitation. This command is
    /// the single-user trust root and must be run by an OS-authorized operator.
    InviteOwner {
        /// Defaults to the tenant this host is bound to.
        #[arg(long)]
        tenant_id: Option<String>,
        #[arg(long, default_value_t = 600)]
        ttl_seconds: i64,
    },
    /// Mint a one-time browser-companion enrollment and print it as JSON.
    ///
    /// The headless counterpart of the desktop settings card. Until this
    /// existed `create_browser_enrollment` had exactly one caller — a Tauri
    /// command — so a host with no renderer could not enrol the extension at
    /// all, and the invitation `pair` prints is a different code entirely
    /// (`cgnp3|`, the Owner invitation the app's pair screen consumes).
    ///
    /// What this prints is the *issue*, not the `cgnb1|…` string the user
    /// pastes. That encoder lives in `@cognia/companion-client` beside the
    /// decoder that has to agree with it byte for byte; a second copy here
    /// would be a wire format free to drift. `pnpm dev:headless browser-enroll`
    /// encodes this JSON.
    EnrollBrowser {
        /// The plaintext loopback listener the extension will dial — the port
        /// `serve --browser-listener-port` bound. Defaults to the conventional
        /// one, and is verified to be live before anything is minted.
        #[arg(long, default_value_t = app_lib::companion_api::browser_access::DEFAULT_BROWSER_PORT)]
        browser_listener_port: u16,
        /// Defaults to the tenant this host is bound to.
        #[arg(long)]
        tenant_id: Option<String>,
        /// Five minutes by default, matching the desktop card: this code is
        /// carried from a terminal to a side panel that is already open, not
        /// to another machine.
        #[arg(long, default_value_t = 300)]
        ttl_seconds: i64,
    },
    /// List Companion API devices for a tenant.
    List {
        /// Defaults to the tenant this host is bound to.
        #[arg(long)]
        tenant_id: Option<String>,
    },
    /// Revoke a Companion API device through the local OS trust root.
    ///
    /// Unlike the remote Owner API, this may revoke the last Owner so a lost
    /// deployment can be recovered with a fresh invitation.
    RevokeDevice {
        device_id: String,
        /// Defaults to the tenant this host is bound to.
        #[arg(long)]
        tenant_id: Option<String>,
    },
    /// Print the current canonical SecurityStore grants.
    Grants {
        /// Defaults to the tenant this host is bound to.
        #[arg(long)]
        tenant_id: Option<String>,
    },
    /// Grant a device an elevated capability. Pass at least one of the flags.
    Grant {
        /// Device id from the pair response (`cognia-server devices grants`
        /// shows the ones already granted).
        device_id: String,
        /// Steer sessions, write files, commit and push.
        #[arg(long)]
        control: bool,
        /// Start and drive external agents on this host. This is process
        /// execution: the spawn policy still restricts which binaries, which
        /// working directories and which environment variables are allowed,
        /// but within that the device chooses what runs.
        #[arg(long = "agent-control")]
        agent_control: bool,
        /// Create, attach to, and control interactive terminal sessions.
        #[arg(long)]
        terminal: bool,
        /// Browse and transfer files over the SSH profiles this host has
        /// synchronized (ADR-0162). This is read and write of the target
        /// machine as the profile's user, with no path confinement, because
        /// SFTP names that machine's absolute paths and it resolves its own
        /// symlinks.
        #[arg(long = "ssh-files")]
        ssh_files: bool,
        /// Defaults to the tenant this host is bound to.
        #[arg(long)]
        tenant_id: Option<String>,
    },
    /// Revoke an elevated capability.
    Revoke {
        device_id: String,
        #[arg(long)]
        control: bool,
        #[arg(long = "agent-control")]
        agent_control: bool,
        #[arg(long)]
        terminal: bool,
        #[arg(long = "ssh-files")]
        ssh_files: bool,
        /// Defaults to the tenant this host is bound to.
        #[arg(long)]
        tenant_id: Option<String>,
    },
}

#[derive(Debug, Subcommand)]
enum GatewayCommand {
    /// Print status (running is always false here — this inspects config/keys).
    Status,
    /// Create a gateway API key; prints the FULL secret once.
    KeyCreate {
        #[arg(long, default_value = "headless")]
        name: String,
    },
    /// List keys (redacted).
    KeyList,
    /// Revoke (delete) a key by id.
    KeyRevoke { id: String },
    /// List route tickets (redacted metadata, never secrets).
    TicketList,
    /// Revoke a route ticket by id. The running listener refuses it on its
    /// next request; the secret is dropped here.
    TicketRevoke { id: String },
}

#[derive(Debug, Subcommand)]
enum ProfilesCommand {
    /// Print the redacted profile document set as JSON on stdout.
    Export,
    /// Validate and apply a redacted export file (replaces the whole set,
    /// bumps the CAS profileVersion).
    Import {
        /// Path to the JSON payload produced by `profiles export`.
        file: PathBuf,
    },
    /// Print the current CAS profileVersion.
    Version,
    /// Store the provider credential a profile's
    /// `{"kind":"secret-store","secretId":"<id>"}` reference resolves to. The
    /// value is read from stdin (never argv, so it stays out of shell history
    /// and the process list) and encrypted under the server master key. It
    /// never leaves this Host: paired devices only ever see provider and model
    /// names. Restart `serve` to apply.
    CredentialSet {
        /// The `secretId` the deployment's credential reference names.
        #[arg(long)]
        id: String,
    },
    /// Delete a stored provider credential. Idempotent.
    CredentialDelete {
        #[arg(long)]
        id: String,
    },
    /// List stored provider credential ids (never values).
    CredentialList,
}

/// Resolve the advertised base URL: explicit flag → `COGNIA_PUBLIC_URL` →
/// loopback default for `port`. The old skeleton hardcoded
/// `https://127.0.0.1:<DEFAULT_PORT>` regardless of the actual port.
/// Headless half of the push fan-out.
///
/// The desktop wakes backgrounded phones through one Tauri listener per
/// push-worthy channel (`commands::register_default_event_channels`). A
/// headless server has no Tauri event loop: the same events reach its
/// `EventBus` — sidecar frames through `HeadlessSidecarHost`, brain frames
/// through the `companion_event_publish` bridge route — and until this
/// subscriber existed they stopped there. Push credentials were installed at
/// boot (`push_creds::reinstall_persisted_dispatchers`) and never used, so a
/// phone attached to a cloud Host got an "approval needed" alert only while
/// its socket was open, which is exactly when it did not need one.
///
/// Subscribes once at the current high-water mark (no replay: a restart must
/// not re-push last night's events) and filters on the shared
/// `PUSH_TRIGGER_CHANNELS` table, so the two hosts cannot drift on which
/// channels are push-worthy. A lagged receiver skips the missed frames rather
/// than dying — the bus is bursty under a sync storm and a push is
/// best-effort by contract.
fn spawn_headless_push_triggers(shared: app_lib::companion_api::SharedState) {
    use app_lib::companion_api::commands::{fan_out_push, PUSH_TRIGGER_CHANNELS};
    use app_lib::companion_api::event_bus::SubscribeResult;

    let now = chrono::Utc::now().timestamp_millis();
    let SubscribeResult::Ok { mut receiver, .. } = shared.event_bus.subscribe(None, now) else {
        // `since: None` anchors at the high-water mark and cannot demand a
        // resync; this arm is unreachable but must not panic if the bus ever
        // changes its mind.
        log::warn!("push triggers: event bus refused a live subscription");
        return;
    };
    tokio::spawn(async move {
        loop {
            let frame = match receiver.recv().await {
                Ok(frame) => frame,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                    log::warn!("push triggers: lagged behind the event bus by {skipped} frames");
                    continue;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            };
            let Some(channel) = PUSH_TRIGGER_CHANNELS
                .iter()
                .copied()
                .find(|channel| *channel == frame.event_type)
            else {
                continue;
            };
            let raw = frame.payload.to_string();
            fan_out_push(
                Arc::clone(&shared.push_tokens),
                app_lib::companion_api::push_dispatchers(),
                channel,
                &raw,
            )
            .await;
        }
        log::info!("push triggers: event bus closed");
    });
}

/// Whether `serve` advertises over mDNS: on unless opted out, and never for a
/// loopback-only listener, which no device that found it could reach.
fn should_advertise_mdns(requested: bool, bind_loopback: bool) -> bool {
    requested && !bind_loopback
}

/// The mDNS instance name, derived from the TLS fingerprint so it is stable
/// across restarts (a scanner shows the same Host, not a new one per boot) and
/// distinct between Hosts on the same LAN.
fn mdns_instance_name(fingerprint: &str) -> String {
    let suffix: String = fingerprint
        .chars()
        .filter(char::is_ascii_hexdigit)
        .take(6)
        .collect::<String>()
        .to_ascii_lowercase();
    if suffix.is_empty() {
        "cognia-headless".to_string()
    } else {
        format!("cognia-{suffix}")
    }
}

/// The running server `pair` asks: `--port`, else `COGNIA_PORT`, else the
/// default port.
fn resolve_pair_port(flag: Option<u16>, env: Option<&str>) -> u16 {
    flag.or_else(|| env.and_then(|value| value.trim().parse().ok()))
        .unwrap_or(app_lib::companion_api::server::DEFAULT_PORT)
}

fn resolve_advertise_url(flag: Option<String>, port: u16) -> String {
    flag.or_else(|| std::env::var("COGNIA_PUBLIC_URL").ok())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| format!("https://127.0.0.1:{port}"))
}

/// Report the Lark entry environment, refusing to start when any issue is
/// fatal.
///
/// Warnings are reported and startup continues — they describe a configuration
/// that works but not for the deployment it looks like (a loopback public
/// base, a web base with no companion behind it). A fatal issue is a value
/// that cannot work at all, and letting the server start with one only moves
/// the discovery to a user inside a Feishu client.
///
/// The sink is injected as a record emitter rather than a byte writer so the
/// issue's own severity picks the log level — production hands it straight to
/// `log`, which is what puts these on the one timestamped, coloured stream.
fn report_lark_env(
    emit: &mut dyn FnMut(log::Level, String),
    issues: &[lark_entry::LarkEnvIssue],
) -> Result<(), String> {
    for issue in issues {
        let level = if issue.fatal {
            log::Level::Error
        } else {
            log::Level::Warn
        };
        emit(level, format!("lark: {}", issue.message));
    }
    let fatal = issues.iter().filter(|issue| issue.fatal).count();
    if fatal == 0 {
        return Ok(());
    }
    Err(format!(
        "{fatal} invalid COGNIA_LARK_* value(s); fix them or unset them to disable the Lark entry surfaces"
    ))
}

/// Install the live file-share service (ADR-0222) for this server's one local
/// account. A mount may point only where the spawn policy lets an agent work
/// (the workspaces volume and the managed task worktrees), and `/uploads`,
/// `/artifacts` and mount tables are read from the brain over its bridge
/// socket. The listener starts only if its saved settings enable it; the brain
/// pushes the policy once it connects.
async fn install_file_share(data_dir: &Path, local_account_id: &str, shared: &SharedState) {
    let Some(services) = headless_services() else {
        return;
    };
    let policy = services.spawn_policy.clone();
    let service = cognia_file_share::service::install(
        data_dir.to_path_buf(),
        Arc::new(move |path: &str| {
            policy
                .validate_workspace_root(path)
                .map_err(|violation| violation.to_string())
        }),
    );
    let bridge = Arc::new(cognia_companion::filespace_bridge::BridgeFileSpaceSource::brain(
        Arc::clone(&shared.desktop_messages_bridge),
    ));
    service.set_asset_reader(bridge.clone());
    service.set_mount_source(bridge);
    // The one account this server serves; the brain may confirm it, never
    // choose another.
    service.bind_account(Some(local_account_id.to_string())).await;
}

/// `cognia-server init`: create the master key this data dir boots with.
fn run_init(dir: &std::path::Path, keychain: bool) -> Result<(), String> {
    if keychain {
        cognia_secrets::secret_store::create_server_keychain_master_key()?;
        println!(
            "Stored a new master key in the {} Keychain item. Start the host with \
             COGNIA_MASTER_KEY_SOURCE=keychain.",
            cognia_secrets::secret_store::SERVER_KEYCHAIN_SERVICE
        );
        return Ok(());
    }
    let path = dir.join(cognia_host_service::server::MASTER_KEY_FILE_NAME);
    match cognia_host_service::server::ensure_master_key_file(&path, None)? {
        cognia_host_service::server::MasterKeyFile::Created => println!(
            "Created {}. Back it up: without it this host's secrets cannot be read.",
            path.display()
        ),
        cognia_host_service::server::MasterKeyFile::Existing => {
            println!("{} already exists; it was left untouched.", path.display())
        }
    }
    Ok(())
}

/// `cognia-server service install|uninstall|status`.
async fn run_service_command(
    command: &ServiceCommand,
    local_account_id: Option<String>,
) -> Result<(), String> {
    use cognia_host_service::{server, InstallerContext, ServicePlatform, SystemIo};
    let ctx = InstallerContext::current().map_err(|e| e.to_string())?;
    let platform = ServicePlatform::current().map_err(|e| e.to_string())?;
    match command {
        ServiceCommand::Install {
            scope,
            install_root,
            data_dir,
            port,
            public_url,
            run_as,
            no_mdns,
        } => {
            let exists = |path: &std::path::Path| path.exists();
            let env = server::InstallEnvironment::current(&ctx, &exists, &server::lookup_account)
                .map_err(|e| e.to_string())?;
            let request = server::InstallRequest {
                scope: (*scope).into(),
                install_root: install_root.clone(),
                data_dir: data_dir.clone(),
                port: *port,
                public_url: public_url.clone(),
                run_as: run_as.clone(),
                mdns: !no_mdns,
                local_account_id: local_account_id.clone(),
            };
            let report =
                server::install_server_service(&request, &env, &SystemIo).map_err(|e| e.to_string())?;
            println!("Installed {}", report.definition_path.display());
            println!("Data dir:   {}", report.data_dir.display());
            println!(
                "Master key: {}{}",
                report.master_key.display(),
                if report.master_key_created {
                    " (new; back it up: without it this host's secrets cannot be read)"
                } else {
                    " (existing)"
                }
            );
            if let Some(user) = &report.run_as {
                println!("Runs as:    {user}");
            }
            for note in &report.notes {
                println!("Note: {note}");
            }
            // A root-only systemd credential is piped in: the service account
            // cannot read the key file, and `pair` opens the secret store.
            let key_pipe = if report.master_key_root_only {
                format!("sudo cat \"{}\" | ", report.master_key.display())
            } else {
                String::new()
            };
            let key_env = if report.master_key_root_only {
                format!("{}=/dev/stdin ", app_lib::headless::MASTER_KEY_FILE_ENV)
            } else {
                String::new()
            };
            let prefix = report
                .run_as
                .as_ref()
                .map(|user| format!("sudo -u {user} "))
                .unwrap_or_default();
            let account = local_account_id
                .as_ref()
                .map(|id| format!("COGNIA_LOCAL_ACCOUNT_ID={id} "))
                .unwrap_or_default();
            // `pair` asks the running server on its port for a relay invitation.
            let port_arg = if *port == app_lib::companion_api::server::DEFAULT_PORT {
                String::new()
            } else {
                format!(" --port {port}")
            };
            println!(
                "Pair a device: {key_pipe}{prefix}{key_env}{account}COGNIA_DATA_DIR=\"{}\" \"{}\" pair{port_arg}",
                report.data_dir.display(),
                report.server_binary.display()
            );
            Ok(())
        }
        ServiceCommand::Uninstall { scope } => {
            let plan = cognia_host_service::uninstall(
                &server::server_service_identity(),
                (*scope).into(),
                platform,
                &ctx,
                &SystemIo,
            )
            .map_err(|e| e.to_string())?;
            println!(
                "Removed {} (data and master key were kept).",
                plan.definition_path.display()
            );
            Ok(())
        }
        ServiceCommand::Status { scope, port } => {
            let status = cognia_host_service::status(
                &server::server_service_identity(),
                (*scope).into(),
                platform,
                &ctx,
                &SystemIo,
            );
            println!(
                "{}: {}, {}",
                status.definition_path.display(),
                if status.installed { "installed" } else { "not installed" },
                if status.running { "running" } else { "not running" }
            );
            println!("Readiness:  {}", probe_readyz(*port).await);
            Ok(())
        }
    }
}

/// `GET /readyz` on the loopback port. The host's certificate is self-signed,
/// so the probe skips verification; it only ever talks to 127.0.0.1.
async fn probe_readyz(port: u16) -> String {
    let client = match reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(std::time::Duration::from_secs(5))
        .no_proxy()
        .build()
    {
        Ok(client) => client,
        Err(error) => return format!("unknown (no loopback client: {error})"),
    };
    let url = format!("https://127.0.0.1:{port}/readyz");
    let response = match client.get(&url).send().await {
        Ok(response) => response,
        Err(error) => return format!("no answer on 127.0.0.1:{port} ({error})"),
    };
    let http_status = response.status();
    let body = response.json::<serde_json::Value>().await.unwrap_or(serde_json::Value::Null);
    describe_readiness(http_status.is_success(), &body)
}

/// One line for `service status` from a `/readyz` answer: ready, or the
/// checks that are holding it back.
fn describe_readiness(ok: bool, body: &serde_json::Value) -> String {
    let mut failing: Vec<&str> = body
        .get("checks")
        .and_then(serde_json::Value::as_object)
        .map(|checks| {
            checks
                .iter()
                .filter(|(name, value)| match name.as_str() {
                    "draining" => value.as_bool() == Some(true),
                    _ => value.as_bool() == Some(false),
                })
                .map(|(name, _)| name.as_str())
                .collect()
        })
        .unwrap_or_default();
    failing.sort_unstable();
    let summary = match (ok, failing.is_empty()) {
        (true, true) => "ready".to_owned(),
        (_, false) => format!("not ready ({})", failing.join(", ")),
        (false, true) => "not ready".to_owned(),
    };
    match describe_brain_refusal(body) {
        Some(refusal) => format!("{summary}; {refusal}"),
        None => summary,
    }
}

/// Why the server refused the brain, from `/readyz`'s `brainRefusal`. A
/// refused brain will not become ready by waiting: the install's server and
/// brain come from different builds (ADR-0224 A10).
fn describe_brain_refusal(body: &serde_json::Value) -> Option<String> {
    let refusal = body.get("brainRefusal")?;
    let side = |name: &str| {
        let side = &refusal[name];
        format!(
            "{name} {} contract {}",
            side["version"].as_str().unwrap_or("unknown"),
            side["contractVersion"]
                .as_u64()
                .map_or_else(|| "?".to_owned(), |v| v.to_string()),
        )
    };
    Some(format!(
        "the server refused the brain ({}: {}, {}); update the host so both come from one build",
        refusal["reason"].as_str().unwrap_or("mismatch"),
        side("brain"),
        side("server"),
    ))
}

fn data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("COGNIA_DATA_DIR") {
        return PathBuf::from(dir);
    }
    dirs::data_dir()
        .map(|d| d.join("cognia-server"))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Re-evaluate the data dir for callers inside `run_serve` (which don't
/// have it threaded as a parameter). Cheap — same env-var read + dirs
/// lookup as the top-level boot, so the location stays consistent.
fn store_data_dir() -> PathBuf {
    data_dir()
}

/// Minimal stderr logger. Without an installed `log` backend every
/// supervisor line — including the piped brain/sidecar output — is silently
/// dropped, which makes a headless install undebuggable. `COGNIA_LOG`
/// (error|warn|info|debug) tunes the level; default info.
///
/// This binary is the *only* terminal-facing sink on the headless path: the
/// brain and the sidecar are children whose stdout is piped in here, so the
/// clock, the level tag and the colour are decided here and nowhere else.
/// Children emit a bare `[LEVEL] [module] message` (`packages/logging`'s
/// console transport drops its own clock and icon the moment it sees a piped
/// stdout) and `headless::brain` re-stamps each line at the level it claimed
/// instead of flattening the lot to INFO.
struct StderrLogger;

const ANSI_RESET: &str = "\x1b[0m";
const ANSI_DIM: &str = "\x1b[2m";

/// SGR colour for a level tag.
fn level_color(level: log::Level) -> &'static str {
    match level {
        log::Level::Error => "\x1b[1;31m",
        log::Level::Warn => "\x1b[33m",
        log::Level::Info => "\x1b[34m",
        log::Level::Debug => "\x1b[36m",
        log::Level::Trace => "\x1b[90m",
    }
}

/// Colour is a property of the sink, not of the message. `NO_COLOR` (set to
/// anything) wins outright; `FORCE_COLOR` / `CLICOLOR_FORCE` turn colour on
/// for pipes and `docker logs` (anything but `0`); otherwise it follows
/// whether stderr is a terminal.
fn color_enabled(var: impl Fn(&str) -> Option<String>, stderr_is_tty: bool) -> bool {
    if var("NO_COLOR").is_some() {
        return false;
    }
    for name in ["FORCE_COLOR", "CLICOLOR_FORCE"] {
        if let Some(value) = var(name) {
            return value != "0";
        }
    }
    stderr_is_tty
}

/// `HH:MM:SS.mmm [LEVEL]  message` — the level tag is padded so the messages
/// of adjacent lines line up regardless of level width.
fn format_log_line(time: &str, level: log::Level, message: &str, color: bool) -> String {
    let tag = format!("[{level}]");
    if color {
        format!(
            "{ANSI_DIM}{time}{ANSI_RESET} {}{tag:<7}{ANSI_RESET} {message}",
            level_color(level)
        )
    } else {
        format!("{time} {tag:<7} {message}")
    }
}

static STDERR_LOGGER: StderrLogger = StderrLogger;

/// Resolved once in [`init_logger`]; `log` gives us no place to hang state.
static STDERR_COLOR: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

impl log::Log for StderrLogger {
    fn enabled(&self, _metadata: &log::Metadata) -> bool {
        true
    }

    fn log(&self, record: &log::Record) {
        if self.enabled(record.metadata()) {
            let time = chrono::Local::now().format("%H:%M:%S%.3f").to_string();
            eprintln!(
                "{}",
                format_log_line(
                    &time,
                    record.level(),
                    &record.args().to_string(),
                    *STDERR_COLOR.get().unwrap_or(&false),
                )
            );
        }
    }

    fn flush(&self) {}
}

fn init_logger() {
    use std::io::IsTerminal;

    let _ = STDERR_COLOR.set(color_enabled(
        |name| std::env::var(name).ok(),
        std::io::stderr().is_terminal(),
    ));
    let level = match std::env::var("COGNIA_LOG").as_deref() {
        Ok("error") => log::LevelFilter::Error,
        Ok("warn") => log::LevelFilter::Warn,
        Ok("debug") => log::LevelFilter::Debug,
        Ok("trace") => log::LevelFilter::Trace,
        _ => log::LevelFilter::Info,
    };
    if log::set_logger(&STDERR_LOGGER).is_ok() {
        log::set_max_level(level);
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    init_logger();
    // Installed once, before any TLS connector is built: `reqwest` resolves the
    // process-wide provider at `Client` construction — and
    // `init_structured_tracing` builds one (the OTLP exporter under
    // `otel-export`), so the provider must land first or that client panics.
    rustls::crypto::ring::default_provider()
        .install_default()
        .map_err(|_| "a rustls crypto provider was already installed")?;
    if !app_lib::init_structured_tracing() {
        log::warn!("headless structured tracing subscriber was not installed");
    }
    // Headless deployments do not consume desktop Dexie settings. The policy
    // comes from the container's HTTPS_PROXY / NO_PROXY, the way every other
    // server process is configured, and is published as the explicit runtime
    // policy: managed outbound clients (the LLM gateway's upstream hop
    // included) then route through it on purpose, with the loopback set and
    // NO_PROXY bypassed, instead of inheriting ambient variables. A proxy
    // that cannot be dialled fails startup here rather than every request.
    let proxy_policy = app_lib::apply_proxy_policy_from_environment()?;
    if proxy_policy.is_active() {
        log::info!(
            "outbound proxy from environment: {:?}://{}:{} (bypass: {})",
            proxy_policy.protocol,
            proxy_policy.host,
            proxy_policy.port,
            proxy_policy.bypass.join(",")
        );
    }
    let cli = Cli::parse();

    if let CliCommand::DesktopHost {
        endpoint,
        authorize_credentials,
    } = &cli.command
    {
        let result = async {
            if *authorize_credentials {
                // Keep the granted credential in this very process: a one-shot
                // helper would lose a one-time Keychain Allow when it exited.
                tokio::task::spawn_blocking(
                    app_lib::terminal_host_service::authorize_terminal_host_credentials,
                )
                .await
                .map_err(|error| {
                    format!("terminal credential authorization task failed: {error}")
                })??;
            }
            let endpoint = endpoint
                .clone()
                .unwrap_or_else(app_lib::terminal_host_service::default_terminal_host_endpoint);
            log::info!("terminal host endpoint: {endpoint}");
            app_lib::terminal_host_service::run_terminal_host(endpoint).await
        }
        .await;
        if let Err(error) = &result {
            if let Some(code) =
                app_lib::terminal_host_service::terminal_host_startup_exit_code(error)
            {
                // This failure precedes the listener and all PTY sessions. The
                // client consumes only the exit status, never log contents.
                log::error!("{error}");
                std::process::exit(code);
            }
        }
        return result.map_err(Into::into);
    }

    if let CliCommand::Service { command } = &cli.command {
        // The installed service serves the account named here, if any.
        let local_account_id = cli
            .local_account_id
            .clone()
            .or_else(|| std::env::var("COGNIA_LOCAL_ACCOUNT_ID").ok())
            .filter(|id| !id.trim().is_empty());
        return run_service_command(command, local_account_id).await.map_err(Into::into);
    }
    if let CliCommand::Init { keychain } = &cli.command {
        return run_init(&data_dir(), *keychain).map_err(Into::into);
    }

    let dir = data_dir();
    std::fs::create_dir_all(&dir)?;

    // Maintenance commands run before normal service initialization so they
    // do not create new state while producing or verifying a recovery point.
    match &cli.command {
        CliCommand::Backup { id } => {
            let result = backup::create_backup(&dir, id)
                .await
                .map_err(std::io::Error::other)?;
            println!("{}", serde_json::to_string(&result)?);
            return Ok(());
        }
        CliCommand::Restore {
            recovery_point,
            destination_volume,
            read_only_smoke,
        } => {
            let result =
                backup::restore_backup(&dir, recovery_point, destination_volume, *read_only_smoke)
                    .await
                    .map_err(std::io::Error::other)?;
            println!("{}", serde_json::to_string(&result)?);
            return Ok(());
        }
        CliCommand::RotateKey { version } => {
            let key_dir = std::env::var("COGNIA_MASTER_KEY_DIR")
                .map(PathBuf::from)
                .map_err(|_| {
                    std::io::Error::other(
                        "COGNIA_MASTER_KEY_DIR is required for versioned key rotation",
                    )
                })?;
            let key_path = key_dir.join(format!("{version}.key"));
            let new_key = std::fs::read_to_string(&key_path)
                .map_err(|error| format!("read master key {}: {error}", key_path.display()))?;
            return run_rotate_master_key(&dir, Some(new_key.trim()));
        }
        CliCommand::VerifyRestore { data_dir } => {
            let result = backup::verify_data_directory(data_dir).map_err(std::io::Error::other)?;
            println!("{}", serde_json::to_string(&result)?);
            return Ok(());
        }
        _ => {}
    }

    // Key rotation runs BEFORE the strict init (it re-opens the store file
    // itself with the explicit old key) and exits.
    if let CliCommand::RotateMasterKey { new_key } = &cli.command {
        return run_rotate_master_key(&dir, new_key.as_deref());
    }

    // Strict secret-store init (ADR-0059 R9): master key from
    // COGNIA_MASTER_KEY(_FILE), fatal without one, keyring + legacy
    // migration disabled. MUST precede any secret access — the companion
    // signing key, push creds, and provider vault all live in this store.
    init_secret_store(&dir).map_err(|e| format!("secret store init: {e}"))?;

    // Boot the store unconditionally — every subcommand benefits from
    // verifying the schema is current.
    let store_path = dir.join("cognia-server.sqlite");
    let store = SqliteAppStore::open(&store_path)?;
    install_security_store(Some(SecurityStore::open(&store_path)?));
    signaling::registration_store::install(Some(SignalingRegistrationStore::open(
        dir.join("companion-signaling.sqlite"),
    )?));

    // Bind before anything resolves a tenant. Every `host_identity` reader
    // below (the CLI tenant fallback, the service token, the brain's env) is a
    // no-op-to-sentinel until this runs, so ordering it after
    // `install_security_store` and before the first command is what makes the
    // headless host serve a real account instead of the unclaimed bucket.
    let local_account_id = cli
        .local_account_id
        .clone()
        .or_else(|| std::env::var("COGNIA_LOCAL_ACCOUNT_ID").ok())
        .filter(|id| !id.trim().is_empty())
        .unwrap_or_else(|| HEADLESS_LOCAL_ACCOUNT_ID.to_string());
    if let Err(error) =
        app_lib::companion_api::host_identity::bind_local_account_from_operator(&local_account_id)
    {
        // Fatal: continuing would silently serve a different tenant than the
        // operator named, which is exactly the confusion this replaces.
        return Err(format!("local account binding failed: {error}").into());
    }

    // Secrets a device sealed here do not outlive its revocation, including
    // one made by this binary's `devices revoke-device` while the server was
    // down or beside it (ADR-0224 A6).
    if matches!(&cli.command, CliCommand::Serve { .. }) {
        let swept = app_lib::companion_api::device_lifecycle::sweep_revoked_device_secrets(
            &resolve_tenant(None),
        );
        if swept > 0 {
            log::info!("removed the host secrets of {swept} revoked device(s)");
        }
    }

    // One tenant owns one Headless data volume and exactly one live server
    // process. The OS releases this advisory lock after a crash, while the
    // retained metadata file explains the previous owner during recovery.
    // Acquire before TLS generation, supervisors, or public listeners mutate
    // state; administrative offline commands remain intentionally lock-free.
    let _tenant_lease = matches!(&cli.command, CliCommand::Serve { .. })
        .then(|| {
            app_lib::headless::tenant_lease::acquire(
                &dir,
                &app_lib::companion_api::host_identity::current_tenant_or_unbound(),
            )
        })
        .transpose()?;

    let tls_material = tls::ensure_certificate(&dir)?;

    match cli.command {
        CliCommand::Pair {
            device_name,
            advertise_url,
            port,
            tenant_id,
            direct,
            no_qr,
        } => {
            let port = resolve_pair_port(port, std::env::var("COGNIA_PORT").ok().as_deref());
            let base_url = resolve_advertise_url(advertise_url, port);
            let tenant_id = resolve_tenant(tenant_id);
            let options = PairOptions {
                port,
                direct,
                qr: !no_qr,
            };
            run_pair(
                &store,
                &tls_material,
                &device_name,
                &base_url,
                &tenant_id,
                &options,
            )
            .await
        }
        CliCommand::Serve {
            port,
            advertise_url,
            allow_remote_terminal,
            bind_loopback,
            browser_listener_port,
            no_mdns,
        } => {
            if allow_remote_terminal {
                let mut settings = app_lib::terminal_host_service::load_terminal_host_settings()?;
                settings.allow_remote_access = true;
                app_lib::terminal_host_service::save_terminal_host_settings(&settings)?;
            }
            run_serve(
                &store,
                &tls_material,
                port,
                advertise_url,
                bind_loopback,
                browser_listener_port,
                !no_mdns,
            )
            .await
        }
        CliCommand::IssueServiceToken => {
            let signing_secret = secret::load_or_generate()?;
            // The `account` claim on a companion JWT is a *tenant*, so this
            // must be the bound tenant and not the local account namespace.
            let (token, exp) = app_lib::companion_api::jwt::issue_service_jwt(
                &signing_secret,
                &app_lib::companion_api::host_identity::current_tenant_or_unbound(),
            )?;
            // Token on stdout (script-friendly), metadata on stderr.
            println!("{token}");
            eprintln!("[cognia-server] service token expires_at={exp} (loopback-only)");
            Ok(())
        }
        CliCommand::Profiles { command } => run_profiles(&dir, command),
        CliCommand::Gateway { command } => run_gateway_admin(&dir, command),
        CliCommand::Devices { command } => run_devices_admin(command).await,
        CliCommand::DesktopHost { .. } | CliCommand::Service { .. } | CliCommand::Init { .. } => {
            unreachable!("handled before headless initialization")
        }
        CliCommand::RotateMasterKey { .. }
        | CliCommand::Backup { .. }
        | CliCommand::Restore { .. }
        | CliCommand::RotateKey { .. }
        | CliCommand::VerifyRestore { .. } => unreachable!("handled above"),
    }
}

/// `cognia-server gateway status|key-create|key-list|key-revoke` — gateway
/// admin without a renderer. Keys persist through the same encrypted secret
/// store the desktop uses (strict headless init already ran).
/// Selected capabilities, or an error when the operator named none — silently
/// doing nothing would read as success and leave them believing a device is
/// granted.
fn selected_kinds(
    control: bool,
    agent_control: bool,
    terminal: bool,
    ssh_files: bool,
) -> Result<Vec<GrantKind>, String> {
    let mut kinds = Vec::new();
    if control {
        kinds.push(GrantKind::Control);
    }
    if agent_control {
        kinds.push(GrantKind::AgentControl);
    }
    if terminal {
        kinds.push(GrantKind::Terminal);
    }
    if ssh_files {
        kinds.push(GrantKind::SshFiles);
    }
    if kinds.is_empty() {
        return Err("pass --control, --agent-control, --terminal, and/or --ssh-files".to_string());
    }
    Ok(kinds)
}

/// The tenant a `devices` subcommand addresses.
///
/// `--tenant-id` used to default to the `local_acct_a` literal, which meant an
/// operator who omitted the flag silently addressed a *different* tenant than
/// the one this host actually serves once it is bound to an account. Falling
/// back to the binding keeps the flagless form pointed at the running host.
fn resolve_tenant(requested: Option<String>) -> String {
    requested
        .filter(|tenant| !tenant.trim().is_empty())
        .unwrap_or_else(app_lib::companion_api::host_identity::current_tenant_or_unbound)
}

/// The plaintext loopback origin a browser enrollment advertises.
///
/// `127.0.0.1` is not a parameter because it is not a choice:
/// `server::spawn_browser_listener` binds `Ipv4Addr::LOCALHOST`, and
/// `decodeBrowserEnrollmentPayload` refuses any code whose base is not an
/// `http://` loopback origin. Anything else would be a code the extension
/// rejects on paste.
fn browser_plane_base_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// Refuse to mint a code that cannot connect.
///
/// The desktop command reads `state.browser_port()` and refuses when the
/// listener is not bound. A separate CLI process cannot see that state, so it
/// asks the plane itself: `/healthz` is public, and a request carrying no
/// `Origin` is `Native` to the origin layer, so no credential is involved.
///
/// It compares `server_id`, not just reachability. That id is derived from the
/// signing secret *this* data directory holds, which is what turns "something
/// is listening on 27891" — a stray dev process satisfies that — into "the
/// server this enrollment will be written for is listening on 27891".
async fn ensure_browser_plane_is_live(
    base_url: &str,
    expected_server_id: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    // `no_proxy`: reqwest honours an ambient `HTTP_PROXY` by default, and a
    // loopback probe routed through a proxy would answer for the wrong host.
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(3))
        .build()?;
    let response = client
        .get(format!("{base_url}/healthz"))
        .send()
        .await
        .map_err(|error| {
            format!(
                "the browser listener is not reachable at {base_url} ({error}); start the host \
                 with `cognia-server serve --browser-listener-port <port>` and \
                 COGNIA_ALLOWED_WEB_ORIGINS set, then retry"
            )
        })?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "{base_url}/healthz answered {status}; that port is held by something other than \
             this host"
        )
        .into());
    }
    let body = response
        .json::<serde_json::Value>()
        .await
        .map_err(|error| {
            format!(
                "{base_url}/healthz did not return JSON ({error}); that port is held by something \
             other than this host"
            )
        })?;
    let reported = body
        .get("server_id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    if reported != expected_server_id {
        return Err(format!(
            "the listener at {base_url} belongs to a different deployment (server_id \
             {reported:?}, expected {expected_server_id:?}); point --data-dir at the host that \
             is actually running"
        )
        .into());
    }
    Ok(())
}

async fn run_devices_admin(command: DevicesCommand) -> Result<(), Box<dyn std::error::Error>> {
    let security = app_lib::companion_api::security_store::security_store()
        .ok_or("security store is not initialized")?;
    match command {
        DevicesCommand::InviteOwner {
            tenant_id,
            ttl_seconds,
        } => {
            let tenant_id = resolve_tenant(tenant_id);
            if ttl_seconds <= 0 || ttl_seconds > 3_600 {
                return Err("ttl-seconds must be between 1 and 3600".into());
            }
            let now = chrono::Utc::now().timestamp();
            let invitation = security.create_owner_invitation(
                &tenant_id,
                "local-cli-trust-root",
                now,
                ttl_seconds,
            )?;
            println!("{invitation}");
            eprintln!(
                "[cognia-server] owner invitation tenant={tenant_id} expires_at={}",
                now.saturating_add(ttl_seconds)
            );
            Ok(())
        }
        DevicesCommand::EnrollBrowser {
            browser_listener_port,
            tenant_id,
            ttl_seconds,
        } => {
            let tenant_id = resolve_tenant(tenant_id);
            if !(1..=3_600).contains(&ttl_seconds) {
                return Err("ttl-seconds must be between 1 and 3600".into());
            }
            let base_url = browser_plane_base_url(browser_listener_port);
            // Probe before minting, never after. A single-use row spent on a
            // code that could never connect is strictly worse than no code:
            // the operator retries, gets a second one, and still has no idea
            // the listener is the problem.
            let signing_secret = secret::load_or_generate()?;
            ensure_browser_plane_is_live(
                &base_url,
                &app_lib::companion_api::healthz::derive_server_id(&signing_secret),
            )
            .await?;
            let now = chrono::Utc::now().timestamp();
            let enrollment = security.create_browser_enrollment(
                &tenant_id,
                "local-cli-trust-root",
                now,
                ttl_seconds,
            )?;
            // The struct the desktop command returns, reused rather than
            // re-declared: two producers of one JSON shape is how the field a
            // consumer reads gets renamed under it.
            let issue = app_lib::companion_api::commands::BrowserEnrollmentIssue {
                enrollment,
                expires_at_ms: now.saturating_add(ttl_seconds) * 1_000,
                base_url,
                tenant_id: tenant_id.clone(),
            };
            // Issue on stdout (script-friendly), metadata on stderr — the same
            // split `issue-service-token` uses.
            println!("{}", serde_json::to_string(&issue)?);
            eprintln!(
                "[cognia-server] browser enrollment tenant={tenant_id} base_url={} expires_at={}",
                issue.base_url,
                now.saturating_add(ttl_seconds)
            );
            Ok(())
        }
        DevicesCommand::List { tenant_id } => {
            let tenant_id = resolve_tenant(tenant_id);
            println!(
                "{}",
                serde_json::to_string_pretty(&security.list_devices(&tenant_id)?)?
            );
            Ok(())
        }
        DevicesCommand::RevokeDevice {
            device_id,
            tenant_id,
        } => {
            let tenant_id = resolve_tenant(tenant_id);
            security.revoke_device(
                &tenant_id,
                "local-cli-trust-root",
                &device_id,
                true,
                chrono::Utc::now().timestamp(),
            )?;
            if let Some(registrations) = signaling::registration_store::installed() {
                if let Some(key_ref) = registrations.remove_device(&device_id)? {
                    app_lib::companion_api::signaling::envelope::clear_signaling_key(&key_ref)?;
                }
            }
            // The secrets it sealed here go with it (ADR-0224 A6). A server
            // running beside this command still holds them in its cache; it
            // drops them at its next sweep (before it lists or loads secrets,
            // and at boot), because the device is revoked in the database.
            app_lib::companion_api::device_lifecycle::forget_device_secrets(&device_id);
            println!("revoked device {device_id} for tenant {tenant_id}");
            Ok(())
        }
        DevicesCommand::Grants { tenant_id } => {
            let tenant_id = resolve_tenant(tenant_id);
            println!(
                "{}",
                serde_json::to_string_pretty(&security.list_devices(&tenant_id)?)?
            );
            Ok(())
        }
        DevicesCommand::Grant {
            device_id,
            control,
            agent_control,
            terminal,
            ssh_files,
            tenant_id,
        } => {
            let tenant_id = resolve_tenant(tenant_id);
            let mut capabilities = security
                .capability_snapshot(&tenant_id, &device_id)?
                .ok_or("device is unknown or revoked")?
                .into_iter()
                .collect::<std::collections::BTreeSet<_>>();
            for kind in selected_kinds(control, agent_control, terminal, ssh_files)? {
                let before = capabilities.len();
                capabilities.extend(
                    grant_kind_capabilities(kind)
                        .iter()
                        .map(|value| value.to_string()),
                );
                println!(
                    "{} {} for {device_id}",
                    if capabilities.len() != before {
                        "granted"
                    } else {
                        "already granted"
                    },
                    kind.as_str()
                );
            }
            security.replace_device_capabilities(
                &tenant_id,
                "local-cli-trust-root",
                &device_id,
                &capabilities.into_iter().collect::<Vec<_>>(),
                chrono::Utc::now().timestamp(),
            )?;
            Ok(())
        }
        DevicesCommand::Revoke {
            device_id,
            control,
            agent_control,
            terminal,
            ssh_files,
            tenant_id,
        } => {
            let tenant_id = resolve_tenant(tenant_id);
            let mut capabilities = security
                .capability_snapshot(&tenant_id, &device_id)?
                .ok_or("device is unknown or revoked")?
                .into_iter()
                .collect::<std::collections::BTreeSet<_>>();
            for kind in selected_kinds(control, agent_control, terminal, ssh_files)? {
                let mut changed = false;
                for capability in grant_kind_capabilities(kind) {
                    // Do not short-circuit: revoking a grant kind must remove
                    // every capability in that kind.
                    changed |= capabilities.remove(*capability);
                }
                println!(
                    "{} {} for {device_id}",
                    if changed {
                        "revoked"
                    } else {
                        "was not granted"
                    },
                    kind.as_str()
                );
            }
            security.replace_device_capabilities(
                &tenant_id,
                "local-cli-trust-root",
                &device_id,
                &capabilities.into_iter().collect::<Vec<_>>(),
                chrono::Utc::now().timestamp(),
            )?;
            Ok(())
        }
    }
}

/// Delegates to the shared mapping so this CLI and the desktop paired-devices
/// toggles cannot grant different capability sets for the same named grant.
fn grant_kind_capabilities(kind: GrantKind) -> &'static [&'static str] {
    kind.capabilities()
}

fn run_gateway_admin(
    data_dir: &std::path::Path,
    command: GatewayCommand,
) -> Result<(), Box<dyn std::error::Error>> {
    let state = app_lib::gateway::GatewayState::new();
    // Same file `run_serve` hydrates from, so the ticket metadata store this
    // reads is the one the running listener writes.
    state.hydrate_from_disk(data_dir.join(".cognia").join("gateway-config.json"));
    match command {
        GatewayCommand::Status => {
            println!("{}", serde_json::to_string_pretty(&state.status())?);
            Ok(())
        }
        GatewayCommand::KeyCreate { name } => {
            let key = state.create_key(name, vec![], None, None, None)?;
            println!("{}", key.secret);
            eprintln!(
                "[cognia-server] gateway key id={} (secret shown once)",
                key.id
            );
            Ok(())
        }
        GatewayCommand::KeyList => {
            println!("{}", serde_json::to_string_pretty(&state.list_keys())?);
            Ok(())
        }
        GatewayCommand::KeyRevoke { id } => {
            state.delete_key(&id)?;
            eprintln!("[cognia-server] gateway key {id} revoked");
            Ok(())
        }
        GatewayCommand::TicketList => {
            println!(
                "{}",
                serde_json::to_string_pretty(&state.list_route_tickets())?
            );
            Ok(())
        }
        GatewayCommand::TicketRevoke { id } => {
            if state.revoke_route_ticket(&id) {
                eprintln!("[cognia-server] route ticket {id} revoked");
                Ok(())
            } else {
                Err(format!("no route ticket with id {id}").into())
            }
        }
    }
}

/// `cognia-server profiles export|import|version` — admin surface over the
/// headless Provider Profile Store (same SQLite file `run_serve` uses via
/// `HeadlessServices`).
fn run_profiles(
    data_dir: &std::path::Path,
    command: ProfilesCommand,
) -> Result<(), Box<dyn std::error::Error>> {
    use app_lib::gateway::credentials::SecretStoreResolver;
    use app_lib::provider_profiles::{
        headless_store_path, ProviderProfileStore, SqliteProfileStore,
    };
    let store = SqliteProfileStore::open(headless_store_path(data_dir))?;
    match command {
        ProfilesCommand::Export => {
            let exported = store.export_redacted()?;
            println!("{}", serde_json::to_string_pretty(&exported)?);
            Ok(())
        }
        ProfilesCommand::Import { file } => {
            let raw = std::fs::read_to_string(&file)?;
            let payload: serde_json::Value = serde_json::from_str(&raw)?;
            let version = store.import(&payload)?;
            eprintln!("[cognia-server] profiles imported; profileVersion={version}");
            Ok(())
        }
        ProfilesCommand::Version => {
            println!("{}", store.profile_version()?);
            Ok(())
        }
        ProfilesCommand::CredentialSet { id } => {
            let mut secret = String::new();
            std::io::Read::read_to_string(&mut std::io::stdin(), &mut secret)?;
            SecretStoreResolver::provider_credentials()
                .store(&id, &secret)
                .map_err(|error| error.to_string())?;
            eprintln!("[cognia-server] provider credential {id} stored; restart serve to apply");
            Ok(())
        }
        ProfilesCommand::CredentialDelete { id } => {
            SecretStoreResolver::provider_credentials()
                .delete(&id)
                .map_err(|error| error.to_string())?;
            eprintln!("[cognia-server] provider credential {id} deleted; restart serve to apply");
            Ok(())
        }
        ProfilesCommand::CredentialList => {
            let ids = SecretStoreResolver::provider_credentials()
                .ids()
                .map_err(|error| error.to_string())?;
            println!("{}", serde_json::to_string_pretty(&ids)?);
            Ok(())
        }
    }
}

/// `cognia-server rotate-master-key [--new-key <64hex>]`.
fn run_rotate_master_key(
    data_dir: &std::path::Path,
    new_key_hex: Option<&str>,
) -> Result<(), Box<dyn std::error::Error>> {
    let old_key =
        cognia_secrets::secret_store::resolve_headless_master_key(data_dir)?.ok_or_else(|| {
            format!(
                "current master key not found: set {MASTER_KEY_ENV}(_FILE), or keep it in {}",
                data_dir
                    .join(cognia_secrets::secret_store::DATA_DIR_MASTER_KEY_FILE)
                    .display()
            )
        })?;
    let (new_key, generated) = match new_key_hex {
        Some(raw) => (parse_master_key(raw)?, false),
        None => (generate_master_key(), true),
    };
    rotate_master_key(data_dir, old_key, new_key)?;
    println!("[cognia-server] secret store re-encrypted.");
    if generated {
        println!("\nNew master key (store it in your secret manager NOW):\n");
        println!("    {}\n", hex::encode(new_key));
    }
    let key_file =
        cognia_secrets::secret_store::rotate_data_dir_master_key_file(data_dir, old_key, new_key)?;
    if let Some(path) = &key_file {
        println!("Wrote the new key to {}.", path.display());
    }
    let configured = [MASTER_KEY_ENV, app_lib::headless::MASTER_KEY_FILE_ENV]
        .iter()
        .any(|name| std::env::var_os(name).is_some_and(|value| !value.is_empty()));
    if key_file.is_none() || configured {
        println!(
            "Update {MASTER_KEY_ENV} (or the {0} file) to the new key before the next boot — \
             the old key no longer decrypts the store.",
            app_lib::headless::MASTER_KEY_FILE_ENV
        );
    }
    Ok(())
}

/// How `pair` asks for and prints an invitation.
struct PairOptions {
    /// Port of the running server.
    port: u16,
    /// Accept an invitation the device must redeem by reaching `base_url`.
    direct: bool,
    /// Draw a terminal QR code next to the string.
    qr: bool,
}

/// Print an invitation: the string, its QR code and when it expires.
fn print_pair_invitation(encoded: &str, expires_at_ms: i64, qr: bool) {
    use cognia_companion_rpc::pair_invitation::{describe_expiry, render_terminal_qr};
    println!("    {encoded}\n");
    if qr {
        match render_terminal_qr(encoded) {
            Ok(art) => println!("{art}"),
            Err(error) => println!("({error}; paste the string instead.)\n"),
        }
    }
    if expires_at_ms > 0 {
        let now_ms = chrono::Utc::now().timestamp_millis();
        println!("The invitation {}.", describe_expiry(expires_at_ms, now_ms));
    }
}

/// What `pair` does with the running server's answer: `Ok(None)` prints the
/// invitation it issued, `Ok(Some(reason))` issues a standalone direct one
/// (only under `--direct`), `Err` refuses a relay-less invitation.
fn pair_decision(running: &RunningPair, direct: bool, base_url: &str) -> Result<Option<String>, String> {
    match running {
        RunningPair::Issued {
            relay_unavailable: Some(reason),
            ..
        } if !direct => Err(relay_refusal(reason, base_url)),
        RunningPair::Issued { .. } => Ok(None),
        RunningPair::NotRunning(reason) if !direct => Err(relay_refusal(
            &format!(
                "{reason}; start the host (`cognia-server serve`, or `cognia-server service install`) first"
            ),
            base_url,
        )),
        RunningPair::Failed(reason) if !direct => Err(relay_refusal(reason, base_url)),
        RunningPair::NotRunning(reason) | RunningPair::Failed(reason) => Ok(Some(reason.clone())),
    }
}

/// A refusal meant for the operator: `main` prints errors with `{:?}`, which
/// would quote the message and escape its line breaks.
struct OperatorError(String);

impl std::fmt::Debug for OperatorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::fmt::Display for OperatorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for OperatorError {}

/// Why `pair` will not print a relay-less invitation unless asked to.
fn relay_refusal(reason: &str, base_url: &str) -> String {
    format!(
        "no relay invitation: {reason}.\n\
         A device can only redeem an invitation without a relay room by reaching {base_url} \
         directly. Fix the cause and run `pair` again, or pass --direct to issue that \
         invitation anyway."
    )
}

async fn run_pair(
    store: &std::sync::Arc<SqliteAppStore>,
    tls: &tls::TlsMaterial,
    device_name: &str,
    base_url: &str,
    tenant_id: &str,
    options: &PairOptions,
) -> Result<(), Box<dyn std::error::Error>> {
    // Make sure the store opens cleanly — a successful list_sessions also
    // exercises the schema migration on first run.
    let page = store.list_sessions(1, 0, None).await?;
    log::info!(
        "store ready ({} session{} total)",
        page.total,
        if page.total == 1 { "" } else { "s" }
    );
    log::info!("tls fingerprint: {}", tls.fingerprint_sha256);

    // ADR-0170: a running `serve` can open a relay pairing room that this
    // process cannot (the room's signaling client must live where the server
    // does). Ask it first over the loopback service plane. ADR-0224 A2: an
    // invitation without a relay room is refused, with the reason, unless the
    // operator asked for a direct one; the standalone cgnp3 below is only
    // issued under `--direct` when nothing is listening.
    let running = pair_through_running_server(options.port, base_url).await;
    let standalone_reason =
        pair_decision(&running, options.direct, base_url).map_err(OperatorError)?;
    if let RunningPair::Issued {
        encoded,
        has_relay,
        expires_at_ms,
        ..
    } = running
    {
        if has_relay {
            println!("\nPair invitation for device \"{device_name}\" (with relay):\n");
        } else {
            println!("\nDirect pair invitation for device \"{device_name}\" (no relay):\n");
        }
        print_pair_invitation(&encoded, expires_at_ms, options.qr);
        if has_relay {
            println!(
                "Scan or paste it on the app's pair screen. It works from any network."
            );
        } else {
            println!(
                "Scan or paste it on the app's pair screen. The device must reach {base_url} directly."
            );
        }
        return Ok(());
    }

    const INVITATION_TTL_SECS: i64 = 5 * 60;
    let now = chrono::Utc::now().timestamp();
    let expires_at_ms = now.saturating_add(INVITATION_TTL_SECS) * 1_000;
    let security = app_lib::companion_api::security_store::security_store()
        .ok_or("security store is not initialized")?;
    let mode = app_lib::companion_api::deployment::deployment_mode();
    let invitation = if mode == app_lib::companion_api::deployment::DeploymentMode::SingleUser {
        Some(security.create_owner_invitation(
            tenant_id,
            "local-cli-trust-root",
            now,
            INVITATION_TTL_SECS,
        )?)
    } else {
        None
    };
    let signing_secret = secret::load_or_generate()?;
    let encoded = encode_pair_invitation_payload(
        base_url,
        invitation.as_deref(),
        &app_lib::companion_api::healthz::derive_server_id(&signing_secret),
        tenant_id,
        expires_at_ms,
        env!("CARGO_PKG_VERSION"),
        &tls.fingerprint_sha256,
        if invitation.is_some() {
            "owner-invitation"
        } else {
            "oidc"
        },
    );

    println!("\nDirect pair invitation for device \"{device_name}\" (no relay):\n");
    print_pair_invitation(&encoded, expires_at_ms, options.qr);
    println!("Scan or paste it on the app's pair screen once the host is serving.");
    println!(
        "It has no relay room ({}): the device must reach {base_url} directly.",
        standalone_reason.as_deref().unwrap_or("no running server answered")
    );
    Ok(())
}

/// What the running `serve` said when `pair` asked it for an invitation.
#[derive(Debug, PartialEq)]
enum RunningPair {
    /// It issued one. `relay_unavailable` says why `encoded` is a relay-less
    /// `cgnp3` when it is one.
    Issued {
        encoded: String,
        has_relay: bool,
        relay_unavailable: Option<String>,
        expires_at_ms: i64,
    },
    /// No server answered on the port.
    NotRunning(String),
    /// Something answered, or could not be asked, but no invitation came back.
    Failed(String),
}

/// Ask a running `cognia-server serve` on this machine for an invitation
/// through `companion_create_owner_invitation` on the loopback service plane
/// (ADR-0170) on `port`.
async fn pair_through_running_server(port: u16, advertised_base_url: &str) -> RunningPair {
    let signing_secret = match secret::load_or_generate() {
        Ok(secret) => secret,
        Err(error) => {
            return RunningPair::Failed(format!("no service signing secret ({error})"));
        }
    };
    let tenant = app_lib::companion_api::host_identity::current_tenant_or_unbound();
    let token = match app_lib::companion_api::jwt::issue_service_jwt(&signing_secret, &tenant) {
        Ok((token, _)) => token,
        Err(error) => {
            return RunningPair::Failed(format!("could not mint a service token ({error})"));
        }
    };
    // The issuer waits for the relay to accept the pairing room, so allow for
    // its timeout on top of the loopback round trip.
    let timeout = app_lib::companion_api::commands::PAIRING_ROOM_READY_TIMEOUT
        + std::time::Duration::from_secs(5);
    let client = match reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(timeout)
        .no_proxy()
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            return RunningPair::Failed(format!("could not build the loopback client ({error})"));
        }
    };
    let url = format!("https://127.0.0.1:{port}/internal/_rpc/companion_create_owner_invitation");
    let response = match client
        .post(&url)
        .bearer_auth(token)
        .header("Idempotency-Key", uuid::Uuid::new_v4().to_string())
        .json(&serde_json::json!({}))
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            return RunningPair::NotRunning(format!(
                "no running server answered on 127.0.0.1:{port} ({error})"
            ));
        }
    };
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        let detail = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|problem| {
                problem
                    .get("detail")
                    .or_else(|| problem.get("message"))
                    .or_else(|| problem.get("error"))
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| body.chars().take(300).collect());
        return RunningPair::Failed(format!(
            "the running server on 127.0.0.1:{port} refused the invitation request ({status}{})",
            if detail.trim().is_empty() {
                String::new()
            } else {
                format!(": {}", detail.trim())
            }
        ));
    }
    let body: serde_json::Value = match response.json().await {
        Ok(body) => body,
        Err(error) => {
            return RunningPair::Failed(format!(
                "the running server answered with an unreadable body ({error})"
            ));
        }
    };
    let issue = body.get("result").cloned().unwrap_or(body);
    running_pair_from_issue(&issue, advertised_base_url)
}

/// Classify a running server's invitation answer.
fn running_pair_from_issue(issue: &serde_json::Value, advertised_base_url: &str) -> RunningPair {
    let Some(encoded) = encode_running_pair_invitation(issue, advertised_base_url) else {
        return RunningPair::Failed(
            "the running server's invitation is missing a required field".to_string(),
        );
    };
    let has_relay = issue.get("relay").is_some_and(|relay| !relay.is_null());
    RunningPair::Issued {
        encoded,
        has_relay,
        relay_unavailable: if has_relay {
            None
        } else {
            Some(
                issue
                    .get("relayUnavailable")
                    .and_then(serde_json::Value::as_str)
                    // A server older than ADR-0224 A2 does not say why.
                    .unwrap_or("the running server did not open a relay room")
                    .to_string(),
            )
        },
        expires_at_ms: issue
            .get("expiresAtMs")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or_default(),
    }
}

fn encode_running_pair_invitation(
    issue: &serde_json::Value,
    advertised_base_url: &str,
) -> Option<String> {
    // Keep the CLI's resolved --advertise-url / COGNIA_PUBLIC_URL, just as the
    // standalone issuer does; the running host may advertise a different listener.
    let mut payload = serde_json::json!({
        "base": advertised_base_url,
        "host": issue.get("hostId")?,
        "tenant": issue.get("tenantId")?,
        "exp": issue.get("expiresAtMs")?,
        "ver": issue.get("appVersion")?,
        "fp": issue.get("fingerprint").cloned().unwrap_or(serde_json::Value::String(String::new())),
        "mode": "owner-invitation",
        "invitation": issue.get("invitation")?,
    });
    let version = match issue.get("relay") {
        Some(relay) if !relay.is_null() => {
            payload["relay"] = relay.clone();
            4
        }
        _ => 3,
    };
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    Some(format!(
        "cgnp{version}|{}",
        URL_SAFE_NO_PAD.encode(payload.to_string().as_bytes())
    ))
}

// Each argument is an independently named field in the cgnp3 invitation wire contract.
#[allow(clippy::too_many_arguments)]
fn encode_pair_invitation_payload(
    base_url: &str,
    invitation: Option<&str>,
    host_id: &str,
    tenant_id: &str,
    expires_at_ms: i64,
    server_version: &str,
    fingerprint: &str,
    mode: &str,
) -> String {
    let mut payload = serde_json::json!({
        "base": base_url,
        "host": host_id,
        "tenant": tenant_id,
        "exp": expires_at_ms,
        "ver": server_version,
        "fp": fingerprint,
        "mode": mode,
    });
    if let Some(invitation) = invitation {
        payload["invitation"] = serde_json::Value::String(invitation.to_string());
    }
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    format!(
        "cgnp3|{}",
        URL_SAFE_NO_PAD.encode(payload.to_string().as_bytes())
    )
}

/// Resolve the headless sidecar script: `COGNIA_SIDECAR_SCRIPT` env, with a
/// dev-checkout fallback (`<repo>/sidecar/claude-host.mjs`) so a hand-run
/// `cargo run --bin cognia-server serve` works without extra setup.
fn resolve_sidecar_script_path() -> Option<PathBuf> {
    if let Ok(raw) = std::env::var(SIDECAR_SCRIPT_ENV) {
        if !raw.trim().is_empty() {
            return Some(PathBuf::from(raw));
        }
    }
    let dev_fallback = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()?
        .join("sidecar")
        .join("claude-host.mjs");
    dev_fallback.exists().then_some(dev_fallback)
}

/// Resolve the brain entry (`COGNIA_BRAIN_ENTRY`). No dev fallback — the
/// brain bundle is a build artifact (`scripts/build/build-cli.mjs`), so its
/// absence is reported instead of guessed.
fn resolve_brain_entry() -> Option<PathBuf> {
    std::env::var(brain::BRAIN_ENTRY_ENV)
        .ok()
        .filter(|raw| !raw.trim().is_empty())
        .map(PathBuf::from)
}

fn plugin_storage_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(".cognia").join("plugins")
}

fn agent_session_store_path(data_dir: &Path) -> PathBuf {
    data_dir.join("cognia").join("agent-sessions.sqlite")
}

/// How this host is installed, for its updater (ADR-0224 A10).
fn detect_host_install() -> app_lib::companion_api::host_update::HostInstall {
    use app_lib::companion_api::host_update;
    let exe = std::env::current_exe().ok();
    let image_target = std::env::var(host_update::HOST_TARGET_ENV).ok();
    let agent_socket = std::env::var_os(host_update::UPDATE_AGENT_SOCKET_ENV)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    host_update::HostInstall::detect(&host_update::DetectInput {
        current_exe: exe.as_deref(),
        service_managed: std::env::var(host_update::SERVICE_MANAGED_ENV)
            .is_ok_and(|value| value == "1"),
        image_target: image_target.as_deref(),
        update_agent_socket: agent_socket.as_deref(),
        compiled_version: env!("CARGO_PKG_VERSION"),
    })
}

/// A pending update decides, before anything starts, whether this process is
/// a new version on trial or a failed one that must hand back to the old.
fn boot_host_update(
    install: &app_lib::companion_api::host_update::HostInstall,
) -> Result<Option<cognia_host_service::install_home::PendingUpdate>, String> {
    use app_lib::companion_api::host_update::InstallKind;
    use cognia_host_service::install_home::BootDecision;
    let InstallKind::Native(home) = &install.kind else {
        return Ok(None);
    };
    match home.boot(&install.version, chrono::Utc::now().timestamp_millis()) {
        Ok(BootDecision::Steady) => Ok(None),
        Ok(BootDecision::Trial(pending)) => {
            log::info!(
                "host update: {} → {} on trial (boot {})",
                pending.from,
                pending.to,
                pending.boots
            );
            Ok(Some(pending))
        }
        Ok(BootDecision::RolledBack(outcome)) => Err(format!(
            "host update: {} was rolled back to {} ({}); restarting into it",
            outcome.to,
            outcome.from,
            outcome.reason.unwrap_or_default()
        )),
        Err(error) => {
            log::warn!("host update: could not read the pending update: {error}");
            Ok(None)
        }
    }
}

/// Start this host's updater: automatic checks on the owner's channel, and
/// installs once idle. `restart` asks `run_serve` to shut down so the service
/// manager starts the swapped-in version.
fn start_host_updater(
    data_dir: &Path,
    install: app_lib::companion_api::host_update::HostInstall,
    trial: Option<cognia_host_service::install_home::PendingUpdate>,
    restart: tokio::sync::watch::Sender<bool>,
) {
    use app_lib::companion_api::host_update::{
        self, idle::LiveIdleProbe, network::HttpUpdateNetwork, updater, HostUpdater,
        HostUpdaterDeps, InstallKind,
    };
    let base_url = host_update::network::update_url();
    let home = match &install.kind {
        InstallKind::Native(home) => Some(home.clone()),
        InstallKind::Compose(_) | InstallKind::Unmanaged(_) => None,
    };
    let updater = HostUpdater::new(
        data_dir,
        install,
        host_update::trust_root(),
        HostUpdaterDeps {
            network: Arc::new(HttpUpdateNetwork::new(base_url)),
            idle: Arc::new(LiveIdleProbe::new(Arc::new(|| {
                cognia_jobs::host::supervisor()
                    .map(|jobs| u32::try_from(jobs.running_count()).unwrap_or(u32::MAX))
                    .unwrap_or(0)
            }))),
            writes: Arc::new(updater::LiveWriteGate),
            restart: Arc::new(move || {
                let _ = restart.send(true);
            }),
            clock: Arc::new(|| chrono::Utc::now().timestamp_millis()),
        },
    );
    host_update::install(Arc::clone(&updater));
    if let (Some(pending), Some(home)) = (trial, home) {
        tokio::spawn(Arc::clone(&updater).supervise_trial(
            home,
            pending,
            Arc::new(updater::LiveTrialHealth),
            std::time::Duration::from_secs(2),
            updater::TRIAL_SETTLE,
        ));
    }
    tokio::spawn(updater.run());
}

async fn run_serve(
    store: &std::sync::Arc<SqliteAppStore>,
    tls_material: &tls::TlsMaterial,
    port: u16,
    advertise_url: Option<String>,
    bind_loopback: bool,
    browser_listener_port: Option<u16>,
    mdns_requested: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    // ADR-0224 A10: before anything starts, settle a pending update.
    let host_install = detect_host_install();
    let host_update_trial = boot_host_update(&host_install)?;
    let (restart_for_update, mut restart_requested) = tokio::sync::watch::channel(false);

    // Config validation BEFORE anything is installed: a typo'd Lark base
    // would otherwise only surface as a 503 to a user inside a Feishu client.
    report_lark_env(
        &mut |level, message| log::log!(level, "{message}"),
        &lark_entry::lark_env_issues(|var| std::env::var(var).ok()),
    )?;

    // Same rule for the browser plane: resolve its origin policy before the
    // first listener binds, so a missing allowlist is a usage error at the
    // command line rather than a half-started server.
    let browser_plane = match browser_listener_port {
        Some(browser_port) => {
            let policy = app_lib::companion_api::web_origin::WebOriginPolicy::from_env()
                .allowing_private_network();
            if !policy.allows_any_origin() {
                return Err(
                    "--browser-listener-port needs at least one allowed browser \
                     origin; set COGNIA_ALLOWED_WEB_ORIGINS (for example \
                     http://localhost:3000,http://127.0.0.1:3000)"
                        .into(),
                );
            }
            Some((browser_port, policy))
        }
        // ADR-0170: without the flag, honour the saved browser-access config
        // that `companion_browser_access_set` writes over the host-admin
        // plane, so a decision taken from the Connectivity settings survives
        // a restart exactly as it does on the desktop.
        None => {
            let saved = app_lib::companion_api::browser_access::load(Some(&store_data_dir()));
            if saved.enabled && !saved.allowed_origins.is_empty() {
                let policy =
                    app_lib::companion_api::web_origin::WebOriginPolicy::from_env_and_config(
                        &saved,
                    )
                    .allowing_private_network();
                if policy.allows_any_origin() {
                    log::info!(
                        "browser listener enabled from the saved browser-access config (port {})",
                        saved.port
                    );
                    Some((saved.port, policy))
                } else {
                    None
                }
            } else {
                None
            }
        }
    };

    // Install the headless AppStore — the DEGRADED data plane, serving only
    // while no brain is connected (ADR-0059 D3/R4).
    install_headless_store(Some(store.clone() as Arc<dyn AppStore>));

    // Install the headless push-credential store (JSON file beside the
    // SQLite store) and reinstate any FCM/APNs dispatchers from a prior
    // configure command. Failures are logged but don't block startup —
    // a missing file just means no provider is configured yet.
    let data_dir = store_data_dir();
    app_lib::configure_agent_session_store_path(agent_session_store_path(&data_dir));
    app_lib::task_workspace::install(data_dir.clone())
        .map_err(|error| format!("task workspace: {error}"))?;
    app_lib::task_workspace::start_workspace_maintenance();
    // The headless host serves the same sidecar `host_rpc` protocol as the
    // desktop. Install the shared Rust supervisor before the sidecar can
    // accept its first request, so background commands and durable monitors
    // have identical ownership, persistence, and boot-reconcile semantics.
    let job_supervisor = app_lib::jobs::install(data_dir.join("cognia"))
        .map_err(|error| format!("background-job supervisor: {error}"))?;
    job_supervisor.on_exit(Arc::new(|exit| {
        if let Some(services) = headless_services() {
            services.event_bus.publish(
                "jobs://exited".to_string(),
                serde_json::to_value(exit).unwrap_or_default(),
            );
        }
    }));
    if let Some(monitors) = app_lib::jobs::monitors() {
        monitors.on_fired(Arc::new(|monitor| {
            if let Some(services) = headless_services() {
                services.event_bus.publish(
                    "jobs://monitor-fired".to_string(),
                    serde_json::to_value(monitor).unwrap_or_default(),
                );
            }
        }));
    }
    push_creds::install(FilePushCredStore::new(&data_dir));
    if let Err(err) = push_creds::reinstall_persisted_dispatchers() {
        log::warn!("push-creds reinstall: {err}");
    }

    // One-time import from the retired JSON projection. The SQLite marker is
    // committed with the grants, so a later revocation can never be undone by
    // importing the same legacy file again on restart.
    let legacy = FileDeviceGrantStore::new(&data_dir).load()?;
    let security = app_lib::companion_api::security_store::security_store()
        .ok_or("security store is not initialized")?;
    let imported = security.migrate_legacy_device_grants(
        &legacy.control.into_iter().collect::<Vec<_>>(),
        &legacy.agent_control.into_iter().collect::<Vec<_>>(),
        &legacy.terminal.into_iter().collect::<Vec<_>>(),
        chrono::Utc::now().timestamp(),
    )?;
    if imported {
        log::info!("imported legacy device grants into SecurityStore");
    }

    // Publish the TLS fingerprint for the whoami handler (P0.3).
    set_tls_fingerprint(tls_material.fingerprint_sha256.clone());
    let idempotency = IdempotencyCache::open(data_dir.join("companion-idempotency.sqlite"))
        .map_err(|error| format!("idempotency store: {error}"))?;

    // Build a SharedState with `renderer: None`; dispatch resolves the
    // headless services registry instead (ADR-0059 R5/R7).
    let signing_secret = secret::load_or_generate()?;
    // Rebuild the deny-list cache from the store before the listener starts.
    // It lives in process memory, so a restart without this served every
    // revoked and suspended device again.
    let deny_list = Arc::new(DenyList::new());
    match deny_list.seed_from_store() {
        Some(loaded) => {
            log::info!("deny-list seeded: {loaded} inactive device(s)")
        }
        None => log::warn!(
            "deny-list could not be seeded; the security store remains \
             authoritative for every authorization decision"
        ),
    }
    let shared: SharedState = Arc::new(CompanionState {
        secret: RwLock::new(signing_secret),
        deny_list,
        renderer: None,
        runtime: app_lib::companion_api::wiring::runtime(),
        idempotency: Arc::new(idempotency),
        event_bus: EventBus::new(),
        sync_bridge: SyncBridge::new(),
        desktop_messages_bridge: DesktopMessagesBridge::new(),
        desktop_writes_bridge: DesktopWritesBridge::new(),
        sync_registry: SyncTableRegistry::with_defaults(),
        rate_limiter: RateLimiter::with_defaults(),
        // Persisted like the desktop's (`CompanionServerState::new`): a phone
        // registers its APNs/FCM token once, and an in-memory registry forgot
        // every token on each restart — so a redeployed cloud Host could not
        // wake a single device until each one re-registered.
        push_tokens: PushTokenRegistry::with_persistence(&data_dir),
    });
    spawn_headless_push_triggers(Arc::clone(&shared));
    let signaling_hub = SignalingHub::new();
    // ADR-0170: a relay/signaling patch saved over the host-admin plane is
    // reapplied before the hub binds, so the first client task already dials
    // the configured rendezvous with the configured ICE servers.
    if let Some(patch) = app_lib::companion_api::signaling_config::load(Some(&data_dir)) {
        log::info!(
            "signaling config restored from disk ({})",
            patch.signaling_url
        );
        signaling_hub.apply_patch(patch);
    }
    signaling::install_hub(Some(&signaling_hub));
    signaling_hub.bind(Arc::clone(&shared));
    signaling::refresh_installed_hub()
        .map_err(|error| format!("restore signaling registrations: {error}"))?;

    // Headless services registry (R7): the sidecar supervisor + provider-env
    // store the claude_* dispatch arms resolve. The sidecar script comes from
    // COGNIA_SIDECAR_SCRIPT (or the dev checkout); without one, chat arms
    // fail at spawn time with a clear path error rather than at boot.
    let api_keys = ApiKeyState::new();
    let sidecar_script = resolve_sidecar_script_path().unwrap_or_else(|| {
        log::warn!("no sidecar script found (set {SIDECAR_SCRIPT_ENV}); claude_send will fail");
        PathBuf::from("claude-host.mjs")
    });
    if let Some(directory) = sidecar_script.parent() {
        if let Err(error) = cognia_sidecar::SIDECAR.install(directory.to_path_buf()) {
            log::warn!("install headless sidecar directory: {error}");
        }
    }
    let sidecar_host = Arc::new(HeadlessSidecarHost::new(
        sidecar_script,
        Arc::clone(&shared.event_bus),
        api_keys.clone(),
    ));
    // Execution plane (R10/R13): local processes by default;
    // COGNIA_EXEC_BACKEND=container routes external agents into per-workspace
    // runner containers. A misconfigured container mode is fatal — degrading
    // to in-container local processes would silently void the T2 isolation.
    // The deployment id scopes runner ownership to THIS server + data volume.
    // Several deployments can share one daemon or namespace, and without it
    // the orphan sweep below would remove their live runners too.
    let deployment_id = app_lib::headless::deployment_id::resolve(&data_dir)
        .map_err(|e| format!("deployment id: {e}"))?;
    log::info!("deployment id: {deployment_id}");
    let exec = exec_backend_from_env(&deployment_id).map_err(|e| format!("exec backend: {e}"))?;
    // ADR-0182/0183 — runtime environment sandboxes, in front of whatever the
    // line above resolved. Off unless this deployment enabled the pool, and
    // then it hands the same backend straight back; a deployment that DID
    // enable it and cannot get a sandbox is refused here rather than served by
    // the legacy runner it asked to stop using.
    let pool = cognia_sandbox_pool::boot::install(exec, &data_dir, &deployment_id)
        .map_err(|e| format!("sandbox pool: {e}"))?;
    let exec = pool.backend;
    // The companion API serves the catalog, the approvals and the driver
    // status out of what the pool installed, so `environment.*` answers
    // `sandbox_pool_disabled` on a deployment that never opted in rather than
    // opening a store of its own.
    if let Some(services) = pool.services {
        app_lib::companion_api::environment_pool::install(services);
    }
    log::info!(
        "exec backend: {} (runtime environment sandboxes: {})",
        exec.kind(),
        if exec.routes_sandboxes() { "on" } else { "off" }
    );
    // Reap what a previous run left behind. A container outlives the process
    // that started it, so a crash used to leak one per agent with no way to
    // find them again — the in-process registry was the only record that they
    // were ours. They now carry an owner label, so the daemon can be asked.
    // Best-effort: an unreachable daemon must not block boot, and the exec
    // backend itself already failed loudly above if it is misconfigured.
    match exec.reap_orphans().await {
        Ok(reaped) if !reaped.is_empty() => {
            log::info!(
                "reaped {} orphaned runner(s) from a previous run",
                reaped.len()
            );
        }
        Ok(_) => {}
        Err(error) => {
            log::warn!("orphan reap skipped: {error}");
        }
    }
    app_lib::companion_api::browser_gateway::install_workspace_runtime_control_from_env()
        .map_err(|error| format!("remote browser: {error}"))?;
    let remote_browser =
        app_lib::companion_api::browser_gateway::browser_runtime_status(None).await;
    log::info!(
        "remote browser status: {}",
        serde_json::to_string(&remote_browser)
            .unwrap_or_else(|error| format!("{{\"serializationError\":\"{error}\"}}"))
    );
    let local_account_id = app_lib::companion_api::host_identity::current()
        .map(|context| context.local_account_namespace)
        .map_err(|error| format!("resolve headless local account: {error}"))?;
    let services = HeadlessServices::new_with_exec(
        sidecar_host,
        api_keys,
        Arc::clone(&shared.event_bus),
        SpawnPolicy::from_env(&data_dir),
        exec,
        plugin_storage_dir(&data_dir),
    )
    .map_err(|error| format!("headless services: {error}"))?;
    services
        .plugin_runtime
        .activate_account(&local_account_id)
        .map_err(|error| format!("activate headless plugin account: {error}"))?;
    install_headless_services(Some(services));
    install_file_share(&data_dir, &local_account_id, &shared).await;
    if let Some(services) = headless_services() {
        // Degraded, not dead: a missing or broken sidecar script must not abort
        // boot. The data plane, sync, and every non-claude arm keep serving,
        // `/readyz` reports the sidecar as not ready, and the claude_* arms
        // fail at spawn time with the path error — which is what the
        // resolve_sidecar_script_path warning above already promises.
        if let Err(error) =
            spawn_sidecar(Arc::clone(&services.sidecar_host), services.sidecar.clone()).await
        {
            log::warn!(
                "headless sidecar startup failed; claude_* arms will fail until it recovers: {error}"
            );
        }
    }

    // Audit trail for the RCE-grade external-agent arms (ADR-0059 R11) —
    // append-only JSONL beside the SQLite store.
    app_lib::companion_api::audit::install(&data_dir);

    // ADR-0090 Phase 2 — headless LLM Gateway. The SAME crate/state the
    // desktop manages; snapshots are the Provider Profile Store projection
    // (authority: profile-store) refreshed on every profileVersion bump, so
    // the gateway serves the last valid profile set with no renderer.
    if let Some(services) = headless_services() {
        let gateway = Arc::clone(&services.gateway);
        gateway.hydrate_from_disk(data_dir.join(".cognia").join("gateway-config.json"));
        // ADR-0188 D9/D36: the Run API, the `cognia/*` models and the
        // passthrough ledger reach the connected brain over its
        // `/internal/bridge` socket, and the brain publishes the account's
        // gateway switches back. Every projection below is committed through
        // this handle so a profile change never drops them. Installing switches
        // nothing on: both surfaces stay off until the brain says otherwise.
        let router_fusion =
            app_lib::companion_api::gateway_brain::HeadlessRouterFusionGateway::install(
                Arc::clone(&shared),
                Arc::clone(&gateway),
            );

        let profiles = Arc::clone(&services.profiles);
        let publish = {
            let router_fusion = Arc::clone(&router_fusion);
            let profiles = Arc::clone(&profiles);
            move || {
                let docs = match profiles.load_all() {
                    Ok(docs) => docs,
                    Err(error) => {
                        log::warn!("profile load for gateway projection failed: {error}");
                        return;
                    }
                };
                let version = profiles.profile_version().unwrap_or(0);
                let now = chrono::Utc::now().timestamp_millis();
                let snapshot_json = app_lib::provider_profiles::gateway_snapshot_json(
                    &docs,
                    version,
                    now,
                    &app_lib::provider_profiles::resolve_credential_ref,
                );
                match serde_json::from_value(snapshot_json) {
                    Ok(snapshot) => match router_fusion.project_snapshot(snapshot) {
                        Ok(_) => {
                            log::info!("gateway snapshot projected (profileVersion {version})")
                        }
                        Err(error) => log::warn!("gateway snapshot rejected: {error}"),
                    },
                    Err(error) => log::warn!("gateway snapshot deserialize failed: {error}"),
                }
            }
        };
        publish();
        let mut version_rx = profiles.subscribe();
        let publish_on_change = publish.clone();
        tokio::spawn(async move {
            while version_rx.changed().await.is_ok() {
                publish_on_change();
            }
        });

        let env_enabled = std::env::var("COGNIA_GATEWAY").is_ok_and(|v| v == "1" || v == "true");
        if gateway.config().enabled || env_enabled {
            let host: Arc<dyn app_lib::gateway::host::GatewayHost> =
                Arc::new(app_lib::headless::gateway_host::HeadlessGatewayHost {
                    event_bus: Arc::clone(&shared.event_bus),
                });
            match gateway.start(host).await {
                Ok(()) => log::info!(
                    "LLM gateway listening on port {:?}",
                    gateway.status().bound_port
                ),
                Err(error) => log::warn!("LLM gateway not started: {error}"),
            }
        }
    }

    // /metrics uptime baseline (D9) — anchor before the server starts.
    app_lib::companion_api::metrics::init();

    // Production/headless deployments remain LAN-bound by default. Local
    // debugging opts into loopback so its ephemeral credential cannot be
    // presented over a remote socket.
    let handle = server::spawn_server(
        port,
        bind_loopback,
        tls_material.clone(),
        Arc::clone(&shared),
    )
    .await?;
    // Publish the bind port for the public /healthz endpoint so emulator
    // probes can confirm the right server (matches the test+production
    // path used by CompanionServerState::start in mod.rs).
    set_advertised_port(handle.bound_port);
    app_lib::companion_api::set_bind_loopback_only(bind_loopback);
    let public_url = resolve_advertise_url(advertise_url, handle.bound_port);
    let bind_host = if bind_loopback {
        "127.0.0.1"
    } else {
        "0.0.0.0"
    };
    log::info!(
        "HTTPS listening on https://{bind_host}:{}",
        handle.bound_port
    );
    log::info!("advertised base URL: {public_url}");
    log::info!("fingerprint: {}", tls_material.fingerprint_sha256);

    // LAN discovery, the same `_cognia._tcp` advertisement the desktop starts
    // once its listener is up. Held until shutdown; dropping it unregisters.
    // A failure (no usable interface, multicast refused) costs discovery only,
    // so it is logged and the server keeps serving.
    let mdns = app_lib::companion_api::mdns::BroadcasterState::new();
    if should_advertise_mdns(mdns_requested, bind_loopback) {
        match mdns.start_auto(app_lib::companion_api::mdns::AutoStartConfig {
            instance_name: mdns_instance_name(&tls_material.fingerprint_sha256),
            port: handle.bound_port,
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            tls_fingerprint: tls_material.fingerprint_sha256.clone(),
        }) {
            Ok(fullname) => log::info!("mDNS: advertising {fullname}"),
            Err(error) => log::warn!("mDNS advertisement unavailable: {error}"),
        }
    }

    // Opt-in plaintext loopback plane for browsers (`browser_access`). The
    // desktop reads its allowlist from a saved config because a GUI-launched
    // process inherits no shell environment; a headless deployment is
    // configured by environment, so the env policy is the whole policy here.
    //
    // An empty allowlist is refused rather than bound: every request a browser
    // makes carries an `Origin`, so such a listener would answer `403
    // web_origin_forbidden` to all of them while looking, from the outside,
    // exactly like a working port.
    let browser_handle = match browser_plane {
        Some((browser_port, policy)) => {
            // A bind failure must not take the HTTPS listener down with it:
            // the port may simply be taken, and every already-paired client
            // depends on the server that just came up.
            match server::spawn_browser_listener(browser_port, Arc::clone(&shared), policy).await {
                Ok(handle) => {
                    log::info!(
                        "browser listener on http://127.0.0.1:{} (plaintext, loopback only)",
                        handle.bound_port
                    );
                    app_lib::companion_api::set_browser_advertised_port(handle.bound_port);
                    // The listener alone is not browser access: `browser_context_submit`
                    // / `_cancel` are gated on this switch before dispatch, and the
                    // desktop flips it in `CompanionServerState::start`. Without it a
                    // headless plane lets the extension enrol and read but refuses every
                    // submission with `browser_submissions_disabled` — a port that looks
                    // live and is not.
                    app_lib::companion_api::browser_access::set_submissions_enabled(true);
                    Some(handle)
                }
                Err(error) => {
                    log::warn!("browser listener could not start: {error}");
                    None
                }
            }
        }
        None => None,
    };

    // Brain supervisor (R8): spawn `node $COGNIA_BRAIN_ENTRY serve` against
    // the bound port and keep it alive. Without an entry the server still
    // runs — the degraded store serves reads and /healthz reports
    // `brain.configured: false`.
    let mut brain_supervisor: Option<Arc<brain::BrainSupervisor>> = None;
    match resolve_brain_entry() {
        Some(entry) => {
            let brain_local_account_id = local_account_id.clone();
            let account_content_key =
                app_lib::headless::get_or_create_account_content_key(&brain_local_account_id)
                    .map_err(|error| format!("account content key: {error}"))?;
            let config = brain::BrainConfig::for_port(
                entry,
                handle.bound_port,
                data_dir.clone(),
                // The brain creates this id in its own account registry
                // (`cli/src/serve/account.ts`), so it must be the local account
                // *namespace* — deliberately not the tenant. Read back from the
                // binding rather than threaded through, so there is one answer
                // to "which account does this host serve".
                brain_local_account_id,
                account_content_key,
                headless_services()
                    .map(|services| services.code_server.host_id().to_string())
                    .unwrap_or_else(|| "headless".to_string()),
                tls_material.fingerprint_sha256.clone(),
                Some(tls_material.cert_pem_path.clone()),
            );
            let supervisor = brain::BrainSupervisor::new(config, Arc::clone(&shared));
            brain::install_brain(Some(Arc::clone(&supervisor)));
            supervisor.start();
            log::info!("brain supervisor started");
            brain_supervisor = Some(supervisor);
        }
        None => {
            log::warn!(
                "{} not set — running without a brain (degraded data plane only)",
                brain::BRAIN_ENTRY_ENV
            );
        }
    }
    start_host_updater(
        &data_dir,
        host_install,
        host_update_trial,
        restart_for_update,
    );
    log::info!("press Ctrl-C (or send SIGTERM) to stop.");

    // Block until SIGINT / SIGTERM (Ctrl-C on Windows), or until the updater
    // swapped in a new version (ADR-0224 A10), then trigger graceful
    // shutdown: brain + sidecar first (children), then the HTTP listener.
    // `SIGTERM` matters more than Ctrl-C here — it is what systemd, Docker and
    // `kill <pid>` send, and with no handler the kernel default hard-kills the
    // process mid-drain, orphaning the brain and sidecar children. After an
    // update the service manager starts `current` again.
    let restarting = tokio::select! {
        () = app_lib::shutdown::wait_for_signal() => false,
        _ = restart_requested.wait_for(|restart| *restart) => true,
    };
    log::info!(
        "{}",
        if restarting {
            "restarting into the updated host…"
        } else {
            "shutting down…"
        }
    );
    // Withdraw the advertisement first so no scanner offers a Host that is
    // already refusing connections.
    mdns.stop();
    // Escape hatch: the drain below is bounded but a wedged child can still
    // hold it for a long time. A second signal force-exits instead of leaving
    // the operator with a process that ignores every further Ctrl-C.
    tokio::spawn(async {
        app_lib::shutdown::wait_for_signal().await;
        log::warn!("second shutdown signal — forcing exit");
        std::process::exit(app_lib::shutdown::SIGNAL_EXIT_CODE);
    });
    app_lib::companion_api::server::begin_draining();
    if let Some(supervisor) = brain_supervisor {
        supervisor.shutdown();
    }
    if let Some(services) = headless_services() {
        if let Err(error) = cognia_plugin_runtime::teardown_account_runtimes(
            &services.plugin_runtime,
            &services.python_plugins,
            &services.wasm_plugins,
            &services.vscode_plugins,
        )
        .await
        {
            log::warn!("headless plugin teardown failed: {error}");
        }
        services.code_server.stop_all().await;
        let _ = services.gateway.stop();
        kill_sidecar(services.sidecar.clone()).await;
    }
    if let Some(supervisor) = app_lib::jobs::supervisor() {
        if let Err(error) = supervisor.shutdown().await {
            log::warn!("jobs: headless shutdown failed: {error}");
        }
    }
    // Ends every live WebDAV/SFTP session and the file-share tunnel.
    if let Some(file_share) = cognia_file_share::service::get() {
        file_share.shutdown().await;
    }
    if let Some(browser_handle) = browser_handle {
        app_lib::companion_api::browser_access::set_submissions_enabled(false);
        let mut browser_terminated = browser_handle.terminated.clone();
        let _ = browser_handle.shutdown.send(());
        let browser_drained =
            tokio::time::timeout(std::time::Duration::from_secs(30), async move {
                while !*browser_terminated.borrow() {
                    if browser_terminated.changed().await.is_err() {
                        break;
                    }
                }
            })
            .await;
        if browser_drained.is_err() {
            log::warn!("companion browser listener drain exceeded 30 seconds; forcing shutdown");
        }
    }
    let mut terminated = handle.terminated.clone();
    let _ = handle.shutdown.send(());
    let drained = tokio::time::timeout(std::time::Duration::from_secs(300), async {
        while !*terminated.borrow() {
            if terminated.changed().await.is_err() {
                break;
            }
        }
    })
    .await;
    if drained.is_err() {
        log::warn!("companion API drain exceeded 300 seconds; forcing shutdown");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn mdns_is_advertised_only_for_a_reachable_listener_that_did_not_opt_out() {
        assert!(super::should_advertise_mdns(true, false));
        assert!(!super::should_advertise_mdns(false, false));
        assert!(!super::should_advertise_mdns(true, true));
        assert!(!super::should_advertise_mdns(false, true));
    }

    #[test]
    fn mdns_instance_name_is_stable_per_fingerprint() {
        let fingerprint = "61195BE979b8564b5a86c5c52a39d17da2999ef7c5b457ecf952dd1ce619a24b";
        assert_eq!(super::mdns_instance_name(fingerprint), "cognia-61195b");
        assert_eq!(
            super::mdns_instance_name(fingerprint),
            super::mdns_instance_name(fingerprint)
        );
        assert_eq!(super::mdns_instance_name("ab:CD:ef:01"), "cognia-abcdef");
        assert_eq!(super::mdns_instance_name(""), "cognia-headless");
    }

    use super::{
        agent_session_store_path, browser_plane_base_url, color_enabled,
        encode_pair_invitation_payload, encode_running_pair_invitation, format_log_line,
        lark_entry, plugin_storage_dir, report_lark_env, run_devices_admin, Cli, CliCommand,
        DevicesCommand, ProfilesCommand,
    };
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    use clap::Parser;
    use std::path::Path;

    /// Colour is decided by the sink, so every knob is exercised against a
    /// stubbed environment rather than the ambient one.
    fn env_of<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |name| {
            pairs
                .iter()
                .find(|(k, _)| *k == name)
                .map(|(_, v)| (*v).to_string())
        }
    }

    #[test]
    fn color_follows_the_terminal_when_nothing_is_forced() {
        assert!(color_enabled(env_of(&[]), true));
        assert!(!color_enabled(env_of(&[]), false));
    }

    #[test]
    fn no_color_beats_a_terminal_and_a_force_flag() {
        assert!(!color_enabled(env_of(&[("NO_COLOR", "")]), true));
        assert!(!color_enabled(
            env_of(&[("NO_COLOR", "1"), ("FORCE_COLOR", "1")]),
            true
        ));
    }

    #[test]
    fn force_color_turns_colour_on_for_a_pipe_and_zero_turns_it_off() {
        // `docker logs` / a supervisor pipe is not a tty; this is the knob
        // that keeps the level colours in a container's log stream.
        assert!(color_enabled(env_of(&[("FORCE_COLOR", "1")]), false));
        assert!(color_enabled(env_of(&[("CLICOLOR_FORCE", "1")]), false));
        assert!(!color_enabled(env_of(&[("FORCE_COLOR", "0")]), true));
    }

    #[test]
    fn plain_lines_carry_one_clock_and_a_padded_level_tag() {
        assert_eq!(
            format_log_line("12:34:56.789", log::Level::Info, "brain ready", false),
            "12:34:56.789 [INFO]  brain ready"
        );
        // ERROR is the widest tag, so it sets the column the others pad to.
        assert_eq!(
            format_log_line("12:34:56.789", log::Level::Error, "boom", false),
            "12:34:56.789 [ERROR] boom"
        );
    }

    #[test]
    fn coloured_lines_wrap_the_level_tag_and_always_reset() {
        let line = format_log_line("12:34:56.789", log::Level::Warn, "slow", true);
        assert!(
            line.contains("\x1b[33m[WARN]"),
            "warn tag is yellow: {line}"
        );
        assert!(line.ends_with(" slow"), "message stays unstyled: {line}");
        // Two resets: one closing the dim clock, one closing the level tag.
        assert_eq!(line.matches("\x1b[0m").count(), 2, "{line}");
    }

    #[test]
    fn plugin_storage_is_scoped_beneath_the_server_data_directory() {
        assert_eq!(
            plugin_storage_dir(Path::new("/srv/cognia")),
            Path::new("/srv/cognia/.cognia/plugins")
        );
    }

    #[test]
    fn agent_session_store_is_scoped_beneath_the_server_data_directory() {
        assert_eq!(
            agent_session_store_path(Path::new("/srv/cognia")),
            Path::new("/srv/cognia/cognia/agent-sessions.sqlite")
        );
    }

    #[test]
    fn profiles_admin_path_matches_the_headless_services_derivation() {
        // HeadlessServices derives the store from the plugin dir's PARENT;
        // the `profiles` subcommands use `headless_store_path`. Pin the two
        // to the same file so admin edits are visible to the running server.
        let data = Path::new("/srv/cognia");
        let from_plugin_parent = plugin_storage_dir(data)
            .parent()
            .unwrap()
            .join("provider-profiles.sqlite");
        assert_eq!(
            app_lib::provider_profiles::headless_store_path(data),
            from_plugin_parent
        );
    }

    #[test]
    fn lark_env_report_warns_but_only_refuses_to_start_on_a_fatal_value() {
        let mut quiet: Vec<(log::Level, String)> = Vec::new();
        assert!(report_lark_env(&mut |level, message| quiet.push((level, message)), &[]).is_ok());
        assert!(quiet.is_empty());

        let mut warned: Vec<(log::Level, String)> = Vec::new();
        let warning = lark_entry::LarkEnvIssue {
            var: lark_entry::ENV_PUBLIC_BASE,
            fatal: false,
            message: "points at loopback".into(),
        };
        assert!(report_lark_env(
            &mut |level, message| warned.push((level, message)),
            std::slice::from_ref(&warning)
        )
        .is_ok());
        // A non-fatal issue reports at WARN, so the shared sink colours it as
        // one instead of spelling the severity into the message text.
        assert_eq!(
            warned,
            vec![(log::Level::Warn, "lark: points at loopback".to_string())]
        );

        let mut failed: Vec<(log::Level, String)> = Vec::new();
        let error = report_lark_env(
            &mut |level, message| failed.push((level, message)),
            &[
                warning,
                lark_entry::LarkEnvIssue {
                    var: lark_entry::ENV_WEB_BASE,
                    fatal: true,
                    message: "COGNIA_LARK_WEB_BASE is set but must be https://".into(),
                },
            ],
        )
        .expect_err("a fatal issue must abort startup");
        assert!(error.contains('1'), "{error}");
        // Both issues are reported even though only one is fatal — an operator
        // fixing the refusal should see the warning in the same output — and
        // each carries its own level.
        assert_eq!(
            failed,
            vec![
                (log::Level::Warn, "lark: points at loopback".to_string()),
                (
                    log::Level::Error,
                    "lark: COGNIA_LARK_WEB_BASE is set but must be https://".to_string()
                ),
            ]
        );
    }

    #[test]
    fn desktop_host_mode_parses_without_headless_service_flags() {
        let cli = Cli::try_parse_from([
            "cognia-server",
            "desktop-host",
            "--endpoint",
            "/tmp/cognia-terminal.sock",
        ])
        .unwrap();
        assert!(matches!(
            cli.command,
            CliCommand::DesktopHost { endpoint: Some(value), authorize_credentials: false }
                if value == "/tmp/cognia-terminal.sock"
        ));
    }

    #[test]
    fn desktop_host_credential_authorization_requires_an_explicit_flag() {
        let cli = Cli::try_parse_from(["cognia-server", "desktop-host", "--authorize-credentials"])
            .unwrap();
        assert!(matches!(
            cli.command,
            CliCommand::DesktopHost {
                endpoint: None,
                authorize_credentials: true,
            }
        ));
        assert!(
            Cli::try_parse_from(["cognia-server", "serve", "--authorize-credentials",]).is_err()
        );
    }

    #[test]
    fn serve_can_explicitly_enable_remote_terminal_access() {
        let cli =
            Cli::try_parse_from(["cognia-server", "serve", "--allow-remote-terminal"]).unwrap();
        assert!(matches!(
            cli.command,
            CliCommand::Serve {
                allow_remote_terminal: true,
                ..
            }
        ));
    }

    #[test]
    fn serve_can_bind_to_loopback_for_local_debugging() {
        let cli = Cli::try_parse_from(["cognia-server", "serve", "--bind-loopback"]).unwrap();
        assert!(matches!(
            cli.command,
            CliCommand::Serve {
                bind_loopback: true,
                ..
            }
        ));
    }

    #[test]
    fn serve_advertises_over_mdns_unless_opted_out() {
        let default = Cli::try_parse_from(["cognia-server", "serve"]).unwrap();
        assert!(matches!(
            default.command,
            CliCommand::Serve { no_mdns: false, .. }
        ));
        let opted_out = Cli::try_parse_from(["cognia-server", "serve", "--no-mdns"]).unwrap();
        assert!(matches!(
            opted_out.command,
            CliCommand::Serve { no_mdns: true, .. }
        ));
    }

    #[test]
    fn serve_leaves_the_browser_listener_off_unless_a_port_is_named() {
        let cli = Cli::try_parse_from(["cognia-server", "serve"]).unwrap();
        assert!(matches!(
            cli.command,
            CliCommand::Serve {
                browser_listener_port: None,
                ..
            }
        ));
    }

    #[test]
    fn serve_binds_the_browser_listener_on_the_named_port() {
        let cli =
            Cli::try_parse_from(["cognia-server", "serve", "--browser-listener-port", "27891"])
                .unwrap();
        assert!(matches!(
            cli.command,
            CliCommand::Serve {
                browser_listener_port: Some(27891),
                ..
            }
        ));
    }

    #[test]
    fn pair_payload_uses_cgnp3_invitation_schema_without_bearer_credentials() {
        let encoded = encode_pair_invitation_payload(
            "https://host.example",
            Some("one-time-owner-invitation"),
            "host-a",
            "tenant-a",
            1_900_000_000_000,
            "1.2.3",
            "sha256-fingerprint",
            "owner-invitation",
        );
        let body = encoded.strip_prefix("cgnp3|").expect("cgnp3 prefix");
        let decoded = URL_SAFE_NO_PAD.decode(body).expect("base64url payload");
        let payload: serde_json::Value = serde_json::from_slice(&decoded).expect("JSON payload");

        assert_eq!(payload["base"], "https://host.example");
        assert_eq!(payload["invitation"], "one-time-owner-invitation");
        assert_eq!(payload["host"], "host-a");
        assert_eq!(payload["tenant"], "tenant-a");
        assert_eq!(payload["exp"], 1_900_000_000_000i64);
        assert_eq!(payload["ver"], "1.2.3");
        assert_eq!(payload["fp"], "sha256-fingerprint");
        assert_eq!(payload["mode"], "owner-invitation");
        assert!(payload.get("pairJwt").is_none());
        assert!(payload.get("deviceJwt").is_none());
    }

    #[test]
    fn running_pair_payload_honors_advertised_url_and_preserves_the_issued_credentials() {
        for relay in [
            serde_json::Value::Null,
            serde_json::json!({ "url": "wss://relay.example/signaling", "room": { "roomId": "pairing-room" }, "mobilePrivateKeyJwk": { "d": "one-shot-key" } }),
        ] {
            let issue = serde_json::json!({
                "baseUrl": "https://127.0.0.1:27890",
                "hostId": "host-a",
                "tenantId": "tenant-a",
                "expiresAtMs": 1_900_000_000_000i64,
                "appVersion": "1.2.3",
                "fingerprint": "sha256-fingerprint",
                "invitation": "one-time-owner-invitation",
                "relay": relay,
            });
            let encoded = encode_running_pair_invitation(&issue, "http://127.0.0.1:27891")
                .expect("running server invitation");
            let (header, body) = encoded.split_once('|').unwrap();
            assert_eq!(header, if relay.is_null() { "cgnp3" } else { "cgnp4" });
            let payload: serde_json::Value =
                serde_json::from_slice(&URL_SAFE_NO_PAD.decode(body).unwrap()).unwrap();
            assert_eq!(payload["base"], "http://127.0.0.1:27891");
            assert_eq!(payload["host"], issue["hostId"]);
            assert_eq!(payload["tenant"], issue["tenantId"]);
            assert_eq!(payload["exp"], issue["expiresAtMs"]);
            assert_eq!(payload["ver"], issue["appVersion"]);
            assert_eq!(payload["fp"], issue["fingerprint"]);
            assert_eq!(payload["invitation"], issue["invitation"]);
            assert_eq!(payload["mode"], "owner-invitation");
            if relay.is_null() {
                assert!(payload.get("relay").is_none());
            } else {
                assert_eq!(payload["relay"], relay);
            }
        }
    }

    #[test]
    fn a_running_server_answer_says_whether_it_carries_a_relay_and_why_not() {
        let issue = |relay: serde_json::Value, reason: Option<&str>| {
            let mut issue = serde_json::json!({
                "hostId": "host-a",
                "tenantId": "tenant-a",
                "expiresAtMs": 1_900_000_000_000i64,
                "appVersion": "1.2.3",
                "invitation": "one-time-owner-invitation",
                "relay": relay,
            });
            if let Some(reason) = reason {
                issue["relayUnavailable"] = serde_json::json!(reason);
            }
            issue
        };
        let relay = serde_json::json!({ "url": "wss://relay.example/signaling", "room": { "roomId": "r" } });
        match super::running_pair_from_issue(&issue(relay, None), "https://127.0.0.1:27890") {
            super::RunningPair::Issued {
                encoded,
                has_relay,
                relay_unavailable,
                expires_at_ms,
            } => {
                assert!(encoded.starts_with("cgnp4|"));
                assert!(has_relay);
                assert_eq!(relay_unavailable, None);
                assert_eq!(expires_at_ms, 1_900_000_000_000);
            }
            other => panic!("expected an issued invitation, got {other:?}"),
        }
        let refused = super::running_pair_from_issue(
            &issue(serde_json::Value::Null, Some("the relay at wss://r did not accept the pairing room")),
            "https://127.0.0.1:27890",
        );
        assert!(matches!(
            &refused,
            super::RunningPair::Issued { has_relay: false, relay_unavailable: Some(reason), .. }
                if reason.contains("did not accept")
        ));
        // A server from before ADR-0224 A2 sends no reason; there still is one.
        let old = super::running_pair_from_issue(&issue(serde_json::Value::Null, None), "https://h");
        assert!(matches!(
            old,
            super::RunningPair::Issued { relay_unavailable: Some(_), .. }
        ));
        let mut broken = issue(serde_json::Value::Null, None);
        broken.as_object_mut().unwrap().remove("invitation");
        assert!(matches!(
            super::running_pair_from_issue(&broken, "https://h"),
            super::RunningPair::Failed(reason) if reason.contains("missing a required field")
        ));
    }

    #[test]
    fn pair_refuses_a_relay_less_invitation_unless_direct() {
        let base = "https://127.0.0.1:27890";
        let relayed = super::RunningPair::Issued {
            encoded: "cgnp4|x".into(),
            has_relay: true,
            relay_unavailable: None,
            expires_at_ms: 1,
        };
        assert_eq!(super::pair_decision(&relayed, false, base), Ok(None));

        let relay_less = super::RunningPair::Issued {
            encoded: "cgnp3|x".into(),
            has_relay: false,
            relay_unavailable: Some("the relay is switched off".into()),
            expires_at_ms: 1,
        };
        let refusal = super::pair_decision(&relay_less, false, base).unwrap_err();
        assert!(refusal.contains("the relay is switched off"));
        assert!(refusal.contains("--direct"));
        assert!(refusal.contains(base));
        assert_eq!(super::pair_decision(&relay_less, true, base), Ok(None));

        let nothing = super::RunningPair::NotRunning("no running server answered on 127.0.0.1:27890".into());
        let refusal = super::pair_decision(&nothing, false, base).unwrap_err();
        assert!(refusal.contains("service install"));
        assert_eq!(
            super::pair_decision(&nothing, true, base),
            Ok(Some("no running server answered on 127.0.0.1:27890".into()))
        );

        // A server that answered with an error is running: no "start it" advice.
        let failed = super::RunningPair::Failed("the running server refused (500: boom)".into());
        let refusal = super::pair_decision(&failed, false, base).unwrap_err();
        assert!(refusal.contains("500: boom"));
        assert!(!refusal.contains("service install"));
        assert_eq!(format!("{:?}", super::OperatorError(refusal.clone())), refusal);
    }

    #[test]
    fn pair_asks_the_port_it_was_given_before_cognia_port() {
        let default = app_lib::companion_api::server::DEFAULT_PORT;
        assert_eq!(super::resolve_pair_port(Some(27990), Some("27991")), 27990);
        assert_eq!(super::resolve_pair_port(None, Some(" 27991 ")), 27991);
        assert_eq!(super::resolve_pair_port(None, Some("not-a-port")), default);
        assert_eq!(super::resolve_pair_port(None, None), default);
        let cli = Cli::try_parse_from(["cognia-server", "pair", "--port", "27990", "--direct", "--no-qr"])
            .expect("pair flags parse");
        assert!(matches!(
            cli.command,
            CliCommand::Pair { port: Some(27990), direct: true, no_qr: true, .. }
        ));
    }

    #[test]
    fn oidc_pair_payload_never_contains_an_owner_invitation() {
        let encoded = encode_pair_invitation_payload(
            "https://host.example",
            None,
            "host-a",
            "tenant-a",
            1_900_000_000_000,
            "1.2.3",
            "sha256-fingerprint",
            "oidc",
        );
        let body = encoded.strip_prefix("cgnp3|").unwrap();
        let decoded = URL_SAFE_NO_PAD.decode(body).unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&decoded).unwrap();
        assert_eq!(payload["mode"], "oidc");
        assert!(payload.get("invitation").is_none());
    }

    #[test]
    fn service_status_names_the_readiness_checks_that_fail() {
        let ready = serde_json::json!({
            "status": "ready",
            "checks": { "draining": false, "storage": true, "brain": true },
        });
        assert_eq!(super::describe_readiness(true, &ready), "ready");
        let held = serde_json::json!({
            "status": "not_ready",
            "checks": { "draining": true, "storage": true, "brain": false, "sidecar": false },
        });
        assert_eq!(super::describe_readiness(false, &held), "not ready (brain, draining, sidecar)");
        assert_eq!(super::describe_readiness(false, &serde_json::Value::Null), "not ready");
        let refused = serde_json::json!({
            "checks": { "brain": false },
            "brainRefusal": {
                "reason": "contract_mismatch",
                "brain": { "version": "0.2.0", "contractVersion": 4 },
                "server": { "version": "0.1.0", "contractVersion": 3 },
            },
        });
        assert_eq!(
            super::describe_readiness(false, &refused),
            "not ready (brain); the server refused the brain (contract_mismatch: brain 0.2.0 \
             contract 4, server 0.1.0 contract 3); update the host so both come from one build"
        );
    }

    #[test]
    fn maintenance_commands_accept_only_typed_paths_and_identifiers() {
        let backup = Cli::try_parse_from(["cognia-server", "backup", "--id", "backup-1"])
            .expect("backup arguments");
        assert!(matches!(
            backup.command,
            CliCommand::Backup { id } if id == "backup-1"
        ));

        let restore = Cli::try_parse_from([
            "cognia-server",
            "restore",
            "--recovery-point",
            "backup-1",
            "--destination-volume",
            "/restore/tenant-1",
            "--read-only-smoke",
        ])
        .expect("restore arguments");
        assert!(matches!(
            restore.command,
            CliCommand::Restore {
                read_only_smoke: true,
                ..
            }
        ));
    }

    /// Provider credentials are written by id with the value on stdin; the
    /// command line never carries the secret, so there is no value flag.
    #[test]
    fn provider_credentials_are_managed_by_id_with_the_secret_off_argv() {
        let cli =
            Cli::try_parse_from(["cognia-server", "profiles", "credential-set", "--id", "k1"])
                .expect("credential-set arguments");
        assert!(matches!(
            cli.command,
            CliCommand::Profiles {
                command: ProfilesCommand::CredentialSet { ref id }
            } if id == "k1"
        ));
        assert!(Cli::try_parse_from([
            "cognia-server",
            "profiles",
            "credential-set",
            "--id",
            "k1",
            "--value",
            "sk-secret",
        ])
        .is_err());
        assert!(matches!(
            Cli::try_parse_from([
                "cognia-server",
                "profiles",
                "credential-delete",
                "--id",
                "k1"
            ])
            .expect("credential-delete arguments")
            .command,
            CliCommand::Profiles {
                command: ProfilesCommand::CredentialDelete { .. }
            }
        ));
        assert!(matches!(
            Cli::try_parse_from(["cognia-server", "profiles", "credential-list"])
                .expect("credential-list arguments")
                .command,
            CliCommand::Profiles {
                command: ProfilesCommand::CredentialList
            }
        ));
    }

    #[test]
    fn a_browser_enrollment_defaults_to_the_conventional_loopback_plane() {
        let cli = Cli::try_parse_from(["cognia-server", "devices", "enroll-browser"])
            .expect("enroll-browser arguments");
        let CliCommand::Devices {
            command:
                DevicesCommand::EnrollBrowser {
                    browser_listener_port,
                    tenant_id,
                    ttl_seconds,
                },
        } = cli.command
        else {
            panic!("expected devices enroll-browser");
        };
        // The port `dev:web-headless` binds and `DEFAULT_BROWSER_PORT` names.
        assert_eq!(browser_listener_port, 27891);
        // Unset means "the tenant this host is bound to", resolved at run time.
        assert_eq!(tenant_id, None);
        // Five minutes, matching the desktop settings card.
        assert_eq!(ttl_seconds, 300);
    }

    #[test]
    fn a_browser_enrollment_takes_an_explicit_port_tenant_and_ttl() {
        let cli = Cli::try_parse_from([
            "cognia-server",
            "devices",
            "enroll-browser",
            "--browser-listener-port",
            "28901",
            "--tenant-id",
            "tenant-a",
            "--ttl-seconds",
            "60",
        ])
        .expect("enroll-browser arguments");
        assert!(matches!(
            cli.command,
            CliCommand::Devices {
                command: DevicesCommand::EnrollBrowser {
                    browser_listener_port: 28901,
                    tenant_id: Some(ref tenant),
                    ttl_seconds: 60,
                },
            } if tenant == "tenant-a"
        ));
    }

    #[test]
    fn the_browser_plane_url_is_always_a_plaintext_loopback_origin() {
        // `decodeBrowserEnrollmentPayload` refuses anything else, so a code
        // built on any other shape is one the extension rejects on paste.
        assert_eq!(browser_plane_base_url(27891), "http://127.0.0.1:27891");
        assert_eq!(browser_plane_base_url(1), "http://127.0.0.1:1");
    }

    #[test]
    fn the_browser_enrollment_json_carries_the_field_names_the_dev_script_reads() {
        // `scripts/dev/headless.mjs` parses this and encodes it into `cgnb1|…`;
        // the desktop settings card serializes the same struct. Pin the wire
        // names so neither producer can rename a field out from under the
        // consumer — a rename would surface as a `cgnb1|` code with an
        // `undefined` field inside, which decodes as "invalid" in the
        // extension and says nothing about where it came from.
        let issue = app_lib::companion_api::commands::BrowserEnrollmentIssue {
            enrollment: "9f1c.aa22".to_string(),
            expires_at_ms: 1_700_000_300_000,
            base_url: "http://127.0.0.1:27891".to_string(),
            tenant_id: "tenant-a".to_string(),
        };
        assert_eq!(
            serde_json::to_value(&issue).expect("serializes"),
            serde_json::json!({
                "enrollment": "9f1c.aa22",
                "expiresAtMs": 1_700_000_300_000_i64,
                "baseUrl": "http://127.0.0.1:27891",
                "tenantId": "tenant-a",
            })
        );
    }

    /// Parse a `cognia-server devices …` line the way `main` does and run it.
    async fn devices(args: &[&str]) -> Result<(), Box<dyn std::error::Error>> {
        let cli = Cli::try_parse_from(
            ["cognia-server", "devices"]
                .iter()
                .chain(args.iter())
                .copied()
                .collect::<Vec<_>>(),
        )
        .expect("devices arguments");
        let CliCommand::Devices { command } = cli.command else {
            panic!("expected a devices command");
        };
        run_devices_admin(command).await
    }

    /// `cognia-server devices grant|revoke` writes the store directly, with no
    /// device console in between to hide the switches on a browser row. The
    /// store has to refuse every grant kind for a browser companion, and the
    /// operator has to be told why.
    ///
    /// The only test in this binary that installs the process-global store, so
    /// it needs no lock of its own; the library's `test_guard` is not visible
    /// from a bin crate.
    #[tokio::test]
    async fn the_devices_cli_cannot_grant_a_browser_device_anything_outside_its_class() {
        use app_lib::companion_api::security_store::{
            install_security_store, SecurityStore, SecurityStoreError,
        };
        let store = SecurityStore::in_memory().expect("in-memory store");
        install_security_store(Some(store.clone()));
        let challenge = store.issue_challenge("tenant-a", 100, 60).unwrap();
        let invitation = store
            .create_owner_invitation("tenant-a", "local-cli-trust-root", 100, 60)
            .unwrap();
        store
            .register_owner_device(
                "tenant-a",
                &invitation,
                &challenge.id,
                &challenge.nonce,
                "owner-a",
                "Owner phone",
                "-----BEGIN PUBLIC KEY-----\nowner\n-----END PUBLIC KEY-----",
                "thumb-owner-a",
                100,
            )
            .unwrap();
        let challenge = store.issue_challenge("tenant-a", 100, 60).unwrap();
        let enrollment = store
            .create_browser_enrollment("tenant-a", "local-cli-trust-root", 100, 60)
            .unwrap();
        store
            .register_browser_device(
                "tenant-a",
                &enrollment,
                &challenge.id,
                &challenge.nonce,
                "browser-a",
                "Chrome",
                "pem",
                "thumb-browser-a",
                "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
                100,
            )
            .unwrap();
        let class = || {
            store
                .capability_snapshot("tenant-a", "browser-a")
                .unwrap()
                .unwrap()
        };

        for flag in ["--control", "--agent-control", "--terminal", "--ssh-files"] {
            let error = devices(&["grant", "browser-a", flag, "--tenant-id", "tenant-a"])
                .await
                .expect_err(flag);
            assert!(
                matches!(
                    error.downcast_ref::<SecurityStoreError>(),
                    Some(SecurityStoreError::CapabilityOutsideDeviceClass)
                ),
                "{flag}: {error}"
            );
        }
        assert!(!store
            .has_capability("tenant-a", "browser-a", "terminal.open")
            .unwrap());
        assert_eq!(class(), vec!["browser.read-own", "browser.submit"]);

        // Revoking writes the browser's own class back, which must still work.
        devices(&[
            "revoke",
            "browser-a",
            "--terminal",
            "--tenant-id",
            "tenant-a",
        ])
        .await
        .expect("revoke on a browser device");
        assert_eq!(class(), vec!["browser.read-own", "browser.submit"]);

        // The owner phone is unaffected.
        devices(&["revoke", "owner-a", "--terminal", "--tenant-id", "tenant-a"])
            .await
            .expect("revoke on an owner device");
        devices(&["grant", "owner-a", "--terminal", "--tenant-id", "tenant-a"])
            .await
            .expect("grant on an owner device");
        assert!(store
            .has_capability("tenant-a", "owner-a", "terminal.open")
            .unwrap());

        install_security_store(None);
    }
}

//! `cognia-server` — headless deployment of the cognia companion API
//! (Phase D skeleton).
//!
//! # What this binary does today
//!
//! - Opens (or creates) a SQLite-backed `AppStore` at
//!   `--data-dir/cognia-server.sqlite`.
//! - Loads / generates the TLS material in the same `--data-dir` so the
//!   self-signed cert is stable across restarts.
//! - Exposes two subcommands:
//!   - `cognia-server pair --device-name <name>` — issues a one-time Owner
//!     invitation and prints a `cgnp3|<base64>` payload the user can paste into the
//!     mobile app (no QR display in this skeleton — a UTF-8 QR renderer
//!     is a follow-up).
//!   - `cognia-server serve --port <port>` — boots the axum HTTPS server
//!     (Phase D follow-up will rewire RPC handlers to consume `AppStore`
//!     instead of the Tauri-WebView bridges; today this command logs the
//!     intended state and exits).
//!
//! # What's deliberately left for follow-up
//!
//! The existing `companion_api::server::spawn_server` expects a
//! `SharedState` containing a `tauri::AppHandle`, and many RPC handlers
//! round-trip mutations through the WebView via the desktop_messages /
//! sync / desktop_writes bridges. Wiring an `AppHandle`-free serving path
//! that consumes `AppStore` for those mutations is the next milestone.
//! This skeleton proves that the abstraction compiles and is exercisable
//! from a standalone binary; ADR-0014 follow-up tracks the rewrite.

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
    resolve_master_key_from_env, rotate_master_key, spawn_sidecar, ApiKeyState, HeadlessServices,
    HeadlessSidecarHost, SpawnPolicy, MASTER_KEY_ENV, SIDECAR_SCRIPT_ENV,
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
    },
    /// Issue a one-shot Owner invitation and print the cgnp3 payload the mobile
    /// app scans or pastes.
    Pair {
        /// Human label for the device being paired.
        #[arg(long, default_value = "headless-pair")]
        device_name: String,
        /// Base URL encoded into the pair payload (what the phone will
        /// dial). Defaults to `COGNIA_PUBLIC_URL`, else
        /// `https://127.0.0.1:<port>`.
        #[arg(long)]
        advertise_url: Option<String>,
        /// Port used for the default advertise URL when neither
        /// `--advertise-url` nor `COGNIA_PUBLIC_URL` is set.
        #[arg(long, default_value_t = app_lib::companion_api::server::DEFAULT_PORT)]
        port: u16,
        /// Tenant/organization encoded into the cgnp3 payload. Defaults to the
        /// tenant this host is bound to.
        #[arg(long)]
        tenant_id: Option<String>,
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
}

/// Resolve the advertised base URL: explicit flag → `COGNIA_PUBLIC_URL` →
/// loopback default for `port`. The old skeleton hardcoded
/// `https://127.0.0.1:<DEFAULT_PORT>` regardless of the actual port.
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
    if !app_lib::init_structured_tracing() {
        log::warn!("headless structured tracing subscriber was not installed");
    }
    // Headless deployments do not consume desktop Dexie settings. Publish an
    // explicit direct policy so shared outbound clients disable ambient proxy
    // variables without binding to renderer initialization.
    app_lib::clear_inherited_proxy_environment();
    app_lib::apply_current_proxy_config(Default::default())?;
    let cli = Cli::parse();

    if let CliCommand::DesktopHost { endpoint } = &cli.command {
        let endpoint = endpoint
            .clone()
            .unwrap_or_else(app_lib::terminal_host_service::default_terminal_host_endpoint);
        log::info!("terminal host endpoint: {endpoint}");
        return app_lib::terminal_host_service::run_terminal_host(endpoint)
            .await
            .map_err(Into::into);
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
        } => {
            let base_url = resolve_advertise_url(advertise_url, port);
            let tenant_id = resolve_tenant(tenant_id);
            run_pair(&store, &tls_material, &device_name, &base_url, &tenant_id).await
        }
        CliCommand::Serve {
            port,
            advertise_url,
            allow_remote_terminal,
            bind_loopback,
            browser_listener_port,
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
        CliCommand::Gateway { command } => run_gateway_admin(command),
        CliCommand::Devices { command } => run_devices_admin(command).await,
        CliCommand::DesktopHost { .. } => unreachable!("handled before headless initialization"),
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
    if kinds.is_empty() {
        return Err("pass --control, --agent-control, and/or --terminal".to_string());
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
            tenant_id,
        } => {
            let tenant_id = resolve_tenant(tenant_id);
            let mut capabilities = security
                .capability_snapshot(&tenant_id, &device_id)?
                .ok_or("device is unknown or revoked")?
                .into_iter()
                .collect::<std::collections::BTreeSet<_>>();
            for kind in selected_kinds(control, agent_control, terminal)? {
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
            tenant_id,
        } => {
            let tenant_id = resolve_tenant(tenant_id);
            let mut capabilities = security
                .capability_snapshot(&tenant_id, &device_id)?
                .ok_or("device is unknown or revoked")?
                .into_iter()
                .collect::<std::collections::BTreeSet<_>>();
            for kind in selected_kinds(control, agent_control, terminal)? {
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

fn run_gateway_admin(command: GatewayCommand) -> Result<(), Box<dyn std::error::Error>> {
    let state = app_lib::gateway::GatewayState::new();
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
    }
}

/// `cognia-server profiles export|import|version` — admin surface over the
/// headless Provider Profile Store (same SQLite file `run_serve` uses via
/// `HeadlessServices`).
fn run_profiles(
    data_dir: &std::path::Path,
    command: ProfilesCommand,
) -> Result<(), Box<dyn std::error::Error>> {
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
    }
}

/// `cognia-server rotate-master-key [--new-key <64hex>]`.
fn run_rotate_master_key(
    data_dir: &std::path::Path,
    new_key_hex: Option<&str>,
) -> Result<(), Box<dyn std::error::Error>> {
    let old_key = resolve_master_key_from_env()?
        .ok_or_else(|| format!("current master key not found: set {MASTER_KEY_ENV}(_FILE)"))?;
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
    println!(
        "Update {MASTER_KEY_ENV} (or the {0} file) to the new key before the next boot — \
         the old key no longer decrypts the store.",
        app_lib::headless::MASTER_KEY_FILE_ENV
    );
    Ok(())
}

async fn run_pair(
    store: &std::sync::Arc<SqliteAppStore>,
    tls: &tls::TlsMaterial,
    device_name: &str,
    base_url: &str,
    tenant_id: &str,
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

    println!("\nPair invitation for device \"{device_name}\":\n");
    println!("    {encoded}\n");
    println!("Expires at: {expires_at_ms} (epoch milliseconds)\n");
    println!("Scan / paste the cgnp3|… string into the mobile app's pair screen.");
    Ok(())
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

async fn run_serve(
    store: &std::sync::Arc<SqliteAppStore>,
    tls_material: &tls::TlsMaterial,
    port: u16,
    advertise_url: Option<String>,
    bind_loopback: bool,
    browser_listener_port: Option<u16>,
) -> Result<(), Box<dyn std::error::Error>> {
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
        None => None,
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

    // Build a SharedState with `app_handle: None`; dispatch resolves the
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
        app_handle: None,
        idempotency: Arc::new(idempotency),
        event_bus: EventBus::new(),
        sync_bridge: SyncBridge::new(),
        desktop_messages_bridge: DesktopMessagesBridge::new(),
        desktop_writes_bridge: DesktopWritesBridge::new(),
        sync_registry: SyncTableRegistry::with_defaults(),
        rate_limiter: RateLimiter::with_defaults(),
        push_tokens: PushTokenRegistry::new(),
    });
    let signaling_hub = SignalingHub::new();
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
    let sidecar_host = Arc::new(HeadlessSidecarHost::new(
        sidecar_script,
        Arc::clone(&shared.event_bus),
        api_keys.clone(),
    ));
    // Execution plane (R10/R13): local processes by default;
    // COGNIA_EXEC_BACKEND=container routes external agents into per-workspace
    // runner containers. A misconfigured container mode is fatal — degrading
    // to in-container local processes would silently void the T2 isolation.
    let exec = exec_backend_from_env().map_err(|e| format!("exec backend: {e}"))?;
    log::info!("exec backend: {}", exec.kind());
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
    if let Some(services) = headless_services() {
        spawn_sidecar(Arc::clone(&services.sidecar_host), services.sidecar.clone())
            .await
            .map_err(|error| format!("headless sidecar startup: {error}"))?;
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

        let profiles = Arc::clone(&services.profiles);
        let publish = {
            let gateway = Arc::clone(&gateway);
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
                    Ok(snapshot) => match gateway.try_set_snapshot(snapshot) {
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
            let account_id = local_account_id.clone();
            let account_content_key =
                app_lib::headless::get_or_create_account_content_key(&account_id)
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
                account_id,
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
    log::info!("press Ctrl-C to stop.");

    // Block until Ctrl-C, then trigger graceful shutdown: brain + sidecar
    // first (children), then the HTTP listener.
    tokio::signal::ctrl_c()
        .await
        .map_err(|e| format!("ctrl-c handler: {e}"))?;
    log::info!("shutting down…");
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
    if let Some(browser_handle) = browser_handle {
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
    use super::{
        agent_session_store_path, browser_plane_base_url, color_enabled,
        encode_pair_invitation_payload, format_log_line, lark_entry, plugin_storage_dir,
        report_lark_env, Cli, CliCommand, DevicesCommand,
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
            CliCommand::DesktopHost { endpoint: Some(value) }
                if value == "/tmp/cognia-terminal.sock"
        ));
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
}

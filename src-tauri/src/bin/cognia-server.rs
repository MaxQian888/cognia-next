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
//!   - `cognia-server pair --device-name <name>` — issues a pair JWT and
//!     prints a `cgnp2|<base64>` payload the user can paste into the
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

use std::path::PathBuf;
use std::sync::Arc;

use app_lib::companion_api::{
    data_plane::install_headless_store,
    deny_list::DenyList,
    desktop_messages_bridge::DesktopMessagesBridge,
    desktop_writes_bridge::DesktopWritesBridge,
    event_bus::EventBus,
    idempotency::IdempotencyCache,
    pair_code_lru::PairCodeLru,
    push::PushTokenRegistry,
    push_creds::{self, FilePushCredStore},
    rate_limit::RateLimiter,
    redemption_lru::RedemptionLru,
    secret, server, set_advertised_port, set_tls_fingerprint,
    store::{sqlite::SqliteAppStore, AppStore},
    sync_bridge::SyncBridge,
    sync_registry::SyncTableRegistry,
    tls, CompanionState, SharedState,
};
use app_lib::headless::{
    brain, exec_backend_from_env, generate_master_key, headless_services, init_secret_store,
    install_headless_services, kill_sidecar, parse_master_key, resolve_master_key_from_env,
    rotate_master_key, ApiKeyState, HeadlessServices, HeadlessSidecarHost, SpawnPolicy,
    MASTER_KEY_ENV, SIDECAR_SCRIPT_ENV,
};
use parking_lot::RwLock;

use clap::{Parser, Subcommand};

const HEADLESS_LOCAL_ACCOUNT_ID: &str = "local_acct_a";

/// cognia-server — headless cognia companion API.
///
/// Set `COGNIA_DATA_DIR` to override the platform data dir; the SQLite
/// store, TLS cert, and push-credential files all live there.
#[derive(Debug, Parser)]
#[command(name = "cognia-server", version, about, long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: CliCommand,
}

#[derive(Debug, Subcommand)]
enum CliCommand {
    /// Issue a one-shot pair token + print the cgnp2 payload the mobile
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
    },
    /// Boot the HTTPS companion server. Binds 0.0.0.0:<port>.
    Serve {
        #[arg(long, default_value_t = app_lib::companion_api::server::DEFAULT_PORT)]
        port: u16,
        /// Public base URL advertised in pair payloads/logs. Defaults to
        /// `COGNIA_PUBLIC_URL`, else `https://127.0.0.1:<bound port>`.
        #[arg(long)]
        advertise_url: Option<String>,
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
    /// Print a service-scope JWT (24h) for the local account. Service tokens
    /// are honored ONLY from loopback, so the value is useless off-host;
    /// still treat it as a secret. Used by the tier-2 smoke to drive the
    /// service-only external-agent arms from inside the container.
    IssueServiceToken,
}

/// Resolve the advertised base URL: explicit flag → `COGNIA_PUBLIC_URL` →
/// loopback default for `port`. The old skeleton hardcoded
/// `https://127.0.0.1:<DEFAULT_PORT>` regardless of the actual port.
fn resolve_advertise_url(flag: Option<String>, port: u16) -> String {
    flag.or_else(|| std::env::var("COGNIA_PUBLIC_URL").ok())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| format!("https://127.0.0.1:{port}"))
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
struct StderrLogger;

impl log::Log for StderrLogger {
    fn enabled(&self, _metadata: &log::Metadata) -> bool {
        true
    }

    fn log(&self, record: &log::Record) {
        if self.enabled(record.metadata()) {
            eprintln!("[{}] {}", record.level(), record.args());
        }
    }

    fn flush(&self) {}
}

static STDERR_LOGGER: StderrLogger = StderrLogger;

fn init_logger() {
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
    let cli = Cli::parse();

    let dir = data_dir();
    std::fs::create_dir_all(&dir)?;

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

    let tls_material = tls::ensure_certificate(&dir)?;

    match cli.command {
        CliCommand::Pair {
            device_name,
            advertise_url,
            port,
        } => {
            let base_url = resolve_advertise_url(advertise_url, port);
            run_pair(&store, &tls_material, &device_name, &base_url).await
        }
        CliCommand::Serve {
            port,
            advertise_url,
        } => run_serve(&store, &tls_material, port, advertise_url).await,
        CliCommand::IssueServiceToken => {
            let signing_secret = secret::load_or_generate()?;
            let (token, exp) = app_lib::companion_api::jwt::issue_service_jwt(
                &signing_secret,
                HEADLESS_LOCAL_ACCOUNT_ID,
            )?;
            // Token on stdout (script-friendly), metadata on stderr.
            println!("{token}");
            eprintln!("[cognia-server] service token expires_at={exp} (loopback-only)");
            Ok(())
        }
        CliCommand::RotateMasterKey { .. } => unreachable!("handled above"),
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
) -> Result<(), Box<dyn std::error::Error>> {
    // Make sure the store opens cleanly — a successful list_sessions also
    // exercises the schema migration on first run.
    let page = store.list_sessions(1, 0, None).await?;
    eprintln!(
        "[cognia-server] store ready ({} session{} total)",
        page.total,
        if page.total == 1 { "" } else { "s" }
    );
    eprintln!(
        "[cognia-server] tls fingerprint: {}",
        tls.fingerprint_sha256
    );

    let signing_secret = secret::load_or_generate()?;
    let (pair_jwt, expires_at_s) =
        app_lib::companion_api::jwt::issue_pair_jwt(&signing_secret, HEADLESS_LOCAL_ACCOUNT_ID)?;

    // Build the same v2 pair payload the desktop QR code uses
    // (cgnp2|<base64>) so the mobile client can decode it unchanged.
    let payload = serde_json::json!({
        "baseUrl": base_url,
        "pairJwt": pair_jwt,
        "accountId": HEADLESS_LOCAL_ACCOUNT_ID,
        "fingerprint": tls.fingerprint_sha256,
        "version": "headless-0.1",
    });
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    let encoded = URL_SAFE_NO_PAD.encode(payload.to_string().as_bytes());

    println!("\nPair token for device \"{device_name}\":\n");
    println!("    cgnp2|{encoded}\n");
    println!("Expires at: {expires_at_s} (epoch seconds)\n");
    println!("Scan / paste the cgnp2|… string into the mobile app's pair screen.");
    Ok(())
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

async fn run_serve(
    store: &std::sync::Arc<SqliteAppStore>,
    tls_material: &tls::TlsMaterial,
    port: u16,
    advertise_url: Option<String>,
) -> Result<(), Box<dyn std::error::Error>> {
    // Install the headless AppStore — the DEGRADED data plane, serving only
    // while no brain is connected (ADR-0059 D3/R4).
    install_headless_store(Some(store.clone() as Arc<dyn AppStore>));

    // Install the headless push-credential store (JSON file beside the
    // SQLite store) and reinstate any FCM/APNs dispatchers from a prior
    // configure command. Failures are logged but don't block startup —
    // a missing file just means no provider is configured yet.
    let data_dir = store_data_dir();
    app_lib::task_workspace::install(data_dir.clone())
        .map_err(|error| format!("task workspace: {error}"))?;
    push_creds::install(FilePushCredStore::new(&data_dir));
    if let Err(err) = push_creds::reinstall_persisted_dispatchers() {
        eprintln!("[cognia-server] push-creds reinstall: {err}");
    }

    // Publish the TLS fingerprint for the whoami handler (P0.3).
    set_tls_fingerprint(tls_material.fingerprint_sha256.clone());

    // Build a SharedState with `app_handle: None`; dispatch resolves the
    // headless services registry instead (ADR-0059 R5/R7).
    let signing_secret = secret::load_or_generate()?;
    let shared: SharedState = Arc::new(CompanionState {
        secret: RwLock::new(signing_secret),
        redemption_lru: RedemptionLru::new(),
        pair_code_lru: Arc::new(PairCodeLru::new()),
        deny_list: Arc::new(DenyList::new()),
        app_handle: None,
        idempotency: Arc::new(IdempotencyCache::new()),
        event_bus: EventBus::new(),
        sync_bridge: SyncBridge::new(),
        desktop_messages_bridge: DesktopMessagesBridge::new(),
        desktop_writes_bridge: DesktopWritesBridge::new(),
        sync_registry: SyncTableRegistry::with_defaults(),
        rate_limiter: RateLimiter::with_defaults(),
        push_tokens: PushTokenRegistry::new(),
    });

    // Headless services registry (R7): the sidecar supervisor + provider-env
    // store the claude_* dispatch arms resolve. The sidecar script comes from
    // COGNIA_SIDECAR_SCRIPT (or the dev checkout); without one, chat arms
    // fail at spawn time with a clear path error rather than at boot.
    let api_keys = ApiKeyState::new();
    let sidecar_script = resolve_sidecar_script_path().unwrap_or_else(|| {
        eprintln!(
            "[cognia-server] warning: no sidecar script found (set {SIDECAR_SCRIPT_ENV}); claude_send will fail",
        );
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
    eprintln!("[cognia-server] exec backend: {}", exec.kind());
    install_headless_services(Some(HeadlessServices::new_with_exec(
        sidecar_host,
        api_keys,
        Arc::clone(&shared.event_bus),
        SpawnPolicy::from_env(&data_dir),
        exec,
    )));

    // Audit trail for the RCE-grade external-agent arms (ADR-0059 R11) —
    // append-only JSONL beside the SQLite store.
    app_lib::companion_api::audit::install(&data_dir);

    // /metrics uptime baseline (D9) — anchor before the server starts.
    app_lib::companion_api::metrics::init();

    // LAN bind (false) so the headless server is reachable on every
    // interface — the typical deployment puts this behind a reverse proxy
    // or VPN; binding to loopback in a server context defeats the purpose.
    let handle =
        server::spawn_server(port, false, tls_material.clone(), Arc::clone(&shared)).await?;
    // Publish the bind port for the public /healthz endpoint so emulator
    // probes can confirm the right server (matches the test+production
    // path used by CompanionServerState::start in mod.rs).
    set_advertised_port(handle.bound_port);
    let public_url = resolve_advertise_url(advertise_url, handle.bound_port);
    println!(
        "[cognia-server] HTTPS listening on https://0.0.0.0:{}",
        handle.bound_port
    );
    println!("[cognia-server] advertised base URL: {public_url}");
    println!(
        "[cognia-server] fingerprint: {}",
        tls_material.fingerprint_sha256
    );

    // Brain supervisor (R8): spawn `node $COGNIA_BRAIN_ENTRY serve` against
    // the bound port and keep it alive. Without an entry the server still
    // runs — the degraded store serves reads and /healthz reports
    // `brain.configured: false`.
    let mut brain_supervisor: Option<Arc<brain::BrainSupervisor>> = None;
    match resolve_brain_entry() {
        Some(entry) => {
            let config = brain::BrainConfig::for_port(
                entry,
                handle.bound_port,
                data_dir.clone(),
                HEADLESS_LOCAL_ACCOUNT_ID.to_string(),
                tls_material.fingerprint_sha256.clone(),
                Some(tls_material.cert_pem_path.clone()),
            );
            let supervisor = brain::BrainSupervisor::new(config, Arc::clone(&shared));
            brain::install_brain(Some(Arc::clone(&supervisor)));
            supervisor.start();
            println!("[cognia-server] brain supervisor started");
            brain_supervisor = Some(supervisor);
        }
        None => {
            eprintln!(
                "[cognia-server] warning: {} not set — running without a brain (degraded data plane only)",
                brain::BRAIN_ENTRY_ENV
            );
        }
    }
    println!("[cognia-server] press Ctrl-C to stop.");

    // Block until Ctrl-C, then trigger graceful shutdown: brain + sidecar
    // first (children), then the HTTP listener.
    tokio::signal::ctrl_c()
        .await
        .map_err(|e| format!("ctrl-c handler: {e}"))?;
    println!("[cognia-server] shutting down…");
    if let Some(supervisor) = brain_supervisor {
        supervisor.shutdown();
    }
    if let Some(services) = headless_services() {
        kill_sidecar(services.sidecar.clone()).await;
    }
    let _ = handle.shutdown.send(());
    // Brief grace period so axum-server's graceful_shutdown(Some(10s)) has
    // time to drain in-flight requests and the children observe their kills.
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    Ok(())
}

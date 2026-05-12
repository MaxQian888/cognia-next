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
    push::PushTokenRegistry,
    push_creds::{self, FilePushCredStore},
    rate_limit::RateLimiter,
    redemption_lru::RedemptionLru,
    secret, server,
    set_tls_fingerprint,
    store::{sqlite::SqliteAppStore, AppStore},
    sync_bridge::SyncBridge,
    sync_registry::SyncTableRegistry,
    tls, CompanionState, SharedState,
};
use parking_lot::RwLock;

use clap::{Parser, Subcommand};

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
    },
    /// Boot the HTTPS companion server. Binds 0.0.0.0:<port>.
    Serve {
        #[arg(long, default_value_t = 7890)]
        port: u16,
    },
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

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();

    let dir = data_dir();
    std::fs::create_dir_all(&dir)?;

    // Boot the store unconditionally — every subcommand benefits from
    // verifying the schema is current.
    let store_path = dir.join("cognia-server.sqlite");
    let store = SqliteAppStore::open(&store_path)?;

    let tls_material = tls::ensure_certificate(&dir)?;

    match cli.command {
        CliCommand::Pair { device_name } => run_pair(&store, &tls_material, &device_name).await,
        CliCommand::Serve { port } => run_serve(&store, &tls_material, port).await,
    }
}

async fn run_pair(
    store: &std::sync::Arc<SqliteAppStore>,
    tls: &tls::TlsMaterial,
    device_name: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    // Make sure the store opens cleanly — a successful list_sessions also
    // exercises the schema migration on first run.
    let page = store.list_sessions(1, 0, None).await?;
    eprintln!(
        "[cognia-server] store ready ({} session{} total)",
        page.total,
        if page.total == 1 { "" } else { "s" }
    );
    eprintln!("[cognia-server] tls fingerprint: {}", tls.fingerprint_sha256);

    let signing_secret = secret::load_or_generate()?;
    let (pair_jwt, expires_at_s) =
        app_lib::companion_api::jwt::issue_pair_jwt(&signing_secret)?;

    // Build the same v2 pair payload the desktop QR code uses
    // (cgnp2|<base64>) so the mobile client can decode it unchanged.
    let payload = serde_json::json!({
        "baseUrl": format!("https://127.0.0.1:7890"),
        "pairJwt": pair_jwt,
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

async fn run_serve(
    store: &std::sync::Arc<SqliteAppStore>,
    tls_material: &tls::TlsMaterial,
    port: u16,
) -> Result<(), Box<dyn std::error::Error>> {
    // Install the headless AppStore so every DataPlane::pick lands on the
    // Direct variant (Phase D RPC handler rewrite).
    install_headless_store(Some(store.clone() as Arc<dyn AppStore>));

    // Install the headless push-credential store (JSON file beside the
    // SQLite store) and reinstate any FCM/APNs dispatchers from a prior
    // configure command. Failures are logged but don't block startup —
    // a missing file just means no provider is configured yet.
    let data_dir = store_data_dir();
    push_creds::install(FilePushCredStore::new(&data_dir));
    if let Err(err) = push_creds::reinstall_persisted_dispatchers() {
        eprintln!("[cognia-server] push-creds reinstall: {err}");
    }

    // Publish the TLS fingerprint for the whoami handler (P0.3).
    set_tls_fingerprint(tls_material.fingerprint_sha256.clone());

    // Build a SharedState with `app_handle: None` — the bridges remain
    // instantiated but the DataPlane never picks them in headless mode.
    let signing_secret = secret::load_or_generate()?;
    let shared: SharedState = Arc::new(CompanionState {
        secret: RwLock::new(signing_secret),
        redemption_lru: RedemptionLru::new(),
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

    // LAN bind (false) so the headless server is reachable on every
    // interface — the typical deployment puts this behind a reverse proxy
    // or VPN; binding to loopback in a server context defeats the purpose.
    let handle = server::spawn_server(port, false, tls_material.clone(), shared).await?;
    println!(
        "[cognia-server] HTTPS listening on https://0.0.0.0:{}",
        handle.bound_port
    );
    println!("[cognia-server] fingerprint: {}", tls_material.fingerprint_sha256);
    println!("[cognia-server] press Ctrl-C to stop.");

    // Block until Ctrl-C, then trigger graceful shutdown.
    tokio::signal::ctrl_c()
        .await
        .map_err(|e| format!("ctrl-c handler: {e}"))?;
    println!("[cognia-server] shutting down…");
    let _ = handle.shutdown.send(());
    // Brief grace period so axum-server's graceful_shutdown(Some(10s)) has
    // time to drain in-flight requests.
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    Ok(())
}

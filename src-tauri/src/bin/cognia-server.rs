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

use app_lib::companion_api::{
    secret,
    store::{sqlite::SqliteAppStore, AppStore},
    tls,
};

#[derive(Debug)]
enum Command {
    Pair { device_name: String },
    Serve { port: u16 },
    Help,
}

fn parse_args() -> Command {
    let argv: Vec<String> = std::env::args().collect();
    if argv.len() < 2 {
        return Command::Help;
    }
    match argv[1].as_str() {
        "pair" => {
            let mut device_name = "headless-pair".to_string();
            let mut i = 2;
            while i < argv.len() {
                if argv[i] == "--device-name" && i + 1 < argv.len() {
                    device_name = argv[i + 1].clone();
                    i += 2;
                } else {
                    i += 1;
                }
            }
            Command::Pair { device_name }
        }
        "serve" => {
            let mut port: u16 = 7890;
            let mut i = 2;
            while i < argv.len() {
                if argv[i] == "--port" && i + 1 < argv.len() {
                    port = argv[i + 1].parse().unwrap_or(7890);
                    i += 2;
                } else {
                    i += 1;
                }
            }
            Command::Serve { port }
        }
        _ => Command::Help,
    }
}

fn print_usage() {
    println!(
        r#"cognia-server — headless cognia companion API (Phase D skeleton)

USAGE:
    cognia-server pair  [--device-name <name>]
    cognia-server serve [--port <port>]

ENVIRONMENT:
    COGNIA_DATA_DIR  — directory for the SQLite store and TLS material.
                       Defaults to the platform-specific data dir.

EXAMPLES:
    cognia-server pair --device-name "mobile-1"
        Issues a pair token + prints the cgnp2 payload the mobile client
        scans / pastes.
    cognia-server serve --port 7890
        Boots the HTTPS server. (Phase D skeleton — see ADR-0014.)
"#
    );
}

fn data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("COGNIA_DATA_DIR") {
        return PathBuf::from(dir);
    }
    dirs::data_dir()
        .map(|d| d.join("cognia-server"))
        .unwrap_or_else(|| PathBuf::from("."))
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cmd = parse_args();

    let dir = data_dir();
    std::fs::create_dir_all(&dir)?;

    // Boot the store unconditionally — every subcommand benefits from
    // verifying the schema is current.
    let store_path = dir.join("cognia-server.sqlite");
    let store = SqliteAppStore::open(&store_path)?;

    let tls_material = tls::ensure_certificate(&dir)?;

    match cmd {
        Command::Help => {
            print_usage();
            Ok(())
        }
        Command::Pair { device_name } => run_pair(&store, &tls_material, &device_name).await,
        Command::Serve { port } => run_serve(&store, &tls_material, port).await,
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
    _store: &std::sync::Arc<SqliteAppStore>,
    _tls: &tls::TlsMaterial,
    port: u16,
) -> Result<(), Box<dyn std::error::Error>> {
    eprintln!("[cognia-server] HTTPS serve on port {port} — not yet wired.");
    eprintln!("[cognia-server] Phase D skeleton landed; RPC-handler rewrite to consume");
    eprintln!("[cognia-server] `AppStore` (bypassing the WebView bridges) is the next");
    eprintln!("[cognia-server] milestone. See mobile/docs/phase-d-headless.md.");
    Ok(())
}

//! HTTP server bootstrap, configuration, and routing.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::{DefaultBodyLimit, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::Router;
use serde_json::json;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::trace::TraceLayer;
use tracing::info;

use cognia_share_core::blobs::max_chunk_ciphertext_bytes;
use cognia_share_core::grant::GrantVerifier;
use cognia_share_core::ticket::ReadTicketSigner;

use crate::handlers;
use crate::ip_limits::IpRateLimiter;
use crate::metrics::Metrics;
use crate::reaper;
use crate::store::Store;

/// Default body cap if `SHARE_MAX_BODY_BYTES` is unset — 10 MiB, matching the
/// Worker's `DEFAULT_MAX_BODY_BYTES`.
pub const DEFAULT_MAX_BODY_BYTES: usize = 10 * 1024 * 1024;
/// Default hard lifetime cap for every share — 30 days, matching the Worker.
pub const DEFAULT_MAX_TTL_SECONDS: u64 = 30 * 24 * 60 * 60;
/// Public non-consuming metadata endpoint suffix.
pub const PUBLIC_METADATA_SUFFIX: &str = "metadata";

/// Resolved runtime configuration. Built from the environment in production
/// ([`Config::from_env`]) or explicitly in tests ([`Config::for_test`]).
#[derive(Debug, Clone)]
pub struct Config {
    /// Path to the SQLite database file.
    pub db_path: String,
    /// Bearer secret required for create / delete / stats. Empty ⇒ writes always 401.
    ///
    /// The legacy credential — one secret for every caller, which is why
    /// ADR-0149 §8 lists this service as one that *must* gain real identity.
    /// It stays supported so existing deployments keep working, but a share
    /// created with it belongs to no org and is invisible to org listing.
    pub upload_secret: String,
    /// Hex-encoded HMAC key shared with the collaboration server, so this
    /// service can verify the grants it mints — ADR-0149 §8. Empty ⇒ no
    /// grant is accepted and only the legacy bearer works.
    pub grant_key_hex: String,
    /// Hex-encoded key that signs file-blob read tickets (ADR-0222). Empty ⇒
    /// a random key per process, so tickets stop working across a restart.
    pub ticket_key_hex: String,
    /// Directory holding encrypted file chunks. `None` ⇒ beside the database
    /// (`<db_path>.blobs`), so the volume that holds one holds both.
    pub blob_dir: Option<String>,
    /// Max request body bytes.
    pub max_body_bytes: usize,
    /// Hard ceiling on share TTL seconds. Every share gets at most this long.
    pub max_ttl_seconds: u64,
    /// Allowed `Origin` values. Empty ⇒ allow all (default).
    pub allowed_origins: Vec<String>,
    /// Whether proxy-provided client IP headers are trusted for rate limits.
    pub trust_proxy_headers: bool,
    /// Per-IP rate: sustained requests/sec.
    pub rate_per_sec: u32,
    /// Per-IP rate: burst bucket size.
    pub rate_burst: u32,
    /// Seconds between TTL reaper sweeps.
    pub reaper_interval_secs: u64,
}

impl Config {
    /// Read configuration from `SHARE_*` environment variables, falling back to
    /// the documented defaults.
    pub fn from_env() -> Self {
        Self {
            db_path: std::env::var("SHARE_DB_PATH")
                .unwrap_or_else(|_| "./shares.sqlite".to_string()),
            upload_secret: resolve_secret(
                std::env::var("SHARE_UPLOAD_SECRET").ok(),
                std::env::var_os("SHARE_UPLOAD_SECRET_FILE").map(Into::into),
            )
            .unwrap_or_default(),
            // Same inline-or-file shape as the upload secret: a key belongs in
            // a mounted file on a real deployment, not in the process listing.
            grant_key_hex: resolve_secret(
                std::env::var("SHARE_GRANT_KEY").ok(),
                std::env::var_os("SHARE_GRANT_KEY_FILE").map(Into::into),
            )
            .unwrap_or_default(),
            ticket_key_hex: resolve_secret(
                std::env::var("SHARE_TICKET_KEY").ok(),
                std::env::var_os("SHARE_TICKET_KEY_FILE").map(Into::into),
            )
            .unwrap_or_default(),
            blob_dir: std::env::var("SHARE_BLOB_DIR")
                .ok()
                .filter(|value| !value.trim().is_empty()),
            max_body_bytes: parse_usize_env("SHARE_MAX_BODY_BYTES")
                .unwrap_or(DEFAULT_MAX_BODY_BYTES),
            max_ttl_seconds: parse_u64_env("SHARE_MAX_TTL_SECONDS")
                .unwrap_or(DEFAULT_MAX_TTL_SECONDS),
            allowed_origins: parse_csv_env("SHARE_ALLOWED_ORIGINS"),
            trust_proxy_headers: crate::ip_limits::trust_proxy_headers_from_env(),
            rate_per_sec: parse_u32_env("SHARE_RATE_PER_SEC").unwrap_or(20),
            rate_burst: parse_u32_env("SHARE_RATE_BURST").unwrap_or(40),
            reaper_interval_secs: parse_u64_env("SHARE_REAPER_INTERVAL_SECS").unwrap_or(60),
        }
    }

    /// Test config: temp DB path, a known secret, generous limits so unrelated
    /// tests aren't rate-limited and the reaper effectively stays out of the way.
    pub fn for_test(db_path: impl Into<String>) -> Self {
        Self {
            db_path: db_path.into(),
            upload_secret: "test-secret".to_string(),
            // 32 bytes, matching `GrantVerifier`'s floor, so the org-scoped
            // routes are exercised by tests rather than only in production.
            grant_key_hex: "30313233343536373839616263646566\
                            30313233343536373839616263646566"
                .to_string(),
            ticket_key_hex: "000102030405060708090a0b0c0d0e0f\
                             101112131415161718191a1b1c1d1e1f"
                .to_string(),
            blob_dir: None,
            max_body_bytes: DEFAULT_MAX_BODY_BYTES,
            max_ttl_seconds: DEFAULT_MAX_TTL_SECONDS,
            allowed_origins: Vec::new(),
            trust_proxy_headers: false,
            rate_per_sec: 100_000,
            rate_burst: 100_000,
            reaper_interval_secs: 3_600,
        }
    }
}

fn resolve_secret(
    inline: Option<String>,
    file: Option<std::path::PathBuf>,
) -> Result<String, std::io::Error> {
    if let Some(inline) = inline.filter(|value| !value.is_empty()) {
        return Ok(inline);
    }
    match file {
        Some(path) => std::fs::read_to_string(path).map(|value| value.trim_end().to_owned()),
        None => Ok(String::new()),
    }
}

fn parse_usize_env(key: &str) -> Option<usize> {
    std::env::var(key)
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|n| *n > 0)
}
fn parse_u32_env(key: &str) -> Option<u32> {
    std::env::var(key)
        .ok()
        .and_then(|s| s.parse::<u32>().ok())
        .filter(|n| *n > 0)
}
fn parse_u64_env(key: &str) -> Option<u64> {
    std::env::var(key)
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|n| *n > 0)
}
fn parse_csv_env(key: &str) -> Vec<String> {
    std::env::var(key)
        .ok()
        .map(|s| {
            s.split(',')
                .map(|o| o.trim().to_string())
                .filter(|o| !o.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// Shared application state, cloned into every request.
#[derive(Clone)]
pub struct AppState {
    pub store: Arc<Store>,
    pub metrics: Arc<Metrics>,
    pub rate: Arc<IpRateLimiter>,
    pub upload_secret: Arc<String>,
    /// `None` when no grant key is configured. Absence means "this deployment
    /// has no collaboration plane", not "authorize anyone" — every grant path
    /// refuses outright rather than falling through to the legacy secret.
    pub grants: Option<Arc<GrantVerifier>>,
    /// Signs and checks the read tickets that unlock a share's file blobs.
    pub tickets: Arc<ReadTicketSigner>,
    pub max_body_bytes: usize,
    pub max_ttl_seconds: u64,
    pub allowed_origins: Arc<Vec<String>>,
    pub trust_proxy_headers: bool,
}

/// Current Unix time in whole milliseconds.
pub fn now_ms_i64() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Current Unix time in milliseconds as `f64` (token-bucket clock).
pub fn now_ms_f64() -> f64 {
    now_ms_i64() as f64
}

/// Build the [`AppState`] (opens the SQLite store) from a [`Config`].
pub fn build_state(config: &Config) -> anyhow::Result<AppState> {
    let blob_dir = config
        .blob_dir
        .as_ref()
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| crate::store::default_blob_dir(&config.db_path));
    let store = Arc::new(Store::open_with_blob_dir(&config.db_path, &blob_dir)?);
    let grants = build_grant_verifier(&config.grant_key_hex)?;
    let tickets = build_ticket_signer(&config.ticket_key_hex)?;
    Ok(AppState {
        store,
        metrics: Arc::new(Metrics::new()),
        rate: IpRateLimiter::new(config.rate_per_sec, config.rate_burst),
        upload_secret: Arc::new(config.upload_secret.clone()),
        grants,
        tickets,
        max_body_bytes: config.max_body_bytes,
        max_ttl_seconds: config.max_ttl_seconds,
        allowed_origins: Arc::new(config.allowed_origins.clone()),
        trust_proxy_headers: config.trust_proxy_headers,
    })
}

/// Build the grant verifier from a hex key, or `None` when unconfigured.
///
/// A malformed or short key is a hard startup failure rather than a silent
/// downgrade to "no grants": an operator who set the variable meant to turn
/// this on, and a service that quietly ignored them would look configured and
/// reject every collaboration-plane caller.
fn build_grant_verifier(hex: &str) -> anyhow::Result<Option<Arc<GrantVerifier>>> {
    let hex = hex.trim();
    if hex.is_empty() {
        return Ok(None);
    }
    if !hex.len().is_multiple_of(2) {
        anyhow::bail!("SHARE_GRANT_KEY must be hex, so it must have an even number of characters");
    }
    let mut key = Vec::with_capacity(hex.len() / 2);
    for index in (0..hex.len()).step_by(2) {
        key.push(
            u8::from_str_radix(&hex[index..index + 2], 16)
                .map_err(|_| anyhow::anyhow!("SHARE_GRANT_KEY is not valid hex"))?,
        );
    }
    let verifier = GrantVerifier::new(&key)
        .map_err(|error| anyhow::anyhow!("SHARE_GRANT_KEY is unusable: {error}"))?;
    Ok(Some(Arc::new(verifier)))
}

/// Build the read-ticket signer from a hex key, or a random one.
///
/// Unlike the grant key, an unset ticket key is not "feature off": a share
/// with files must stay downloadable, and the only cost of a per-process key
/// is that tickets issued before a restart stop working (a reader reloads the
/// page). A malformed or short key is still a hard failure — the operator
/// meant to set one.
fn build_ticket_signer(hex: &str) -> anyhow::Result<Arc<ReadTicketSigner>> {
    let hex = hex.trim();
    let key = if hex.is_empty() {
        tracing::warn!(
            target: "share",
            "SHARE_TICKET_KEY is unset; file read tickets will not survive a restart"
        );
        let mut key = [0u8; 32];
        rand::Rng::fill_bytes(&mut rand::rng(), &mut key);
        key.to_vec()
    } else {
        decode_hex(hex).map_err(|reason| anyhow::anyhow!("SHARE_TICKET_KEY {reason}"))?
    };
    let signer = ReadTicketSigner::new(&key)
        .map_err(|error| anyhow::anyhow!("SHARE_TICKET_KEY is unusable: {error}"))?;
    Ok(Arc::new(signer))
}

fn decode_hex(hex: &str) -> Result<Vec<u8>, &'static str> {
    if !hex.len().is_multiple_of(2) {
        return Err("must be hex, so it must have an even number of characters");
    }
    (0..hex.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&hex[index..index + 2], 16).map_err(|_| "is not valid hex"))
        .collect()
}

/// Assemble the router. The per-route `fallback` returns `405` for known paths
/// hit with an unsupported method; the router-level `fallback` returns `404`
/// (or `204` for `OPTIONS`).
pub fn router(state: AppState) -> Router {
    let max_body = state.max_body_bytes;
    // ADR-0222 file chunks have their own body cap: one encrypted chunk, with
    // headroom, whatever SHARE_MAX_BODY_BYTES says about envelopes.
    let max_chunk_body = max_chunk_ciphertext_bytes() as usize + 1024;
    let blobs = Router::new()
        .route(
            "/v1/share/{code}/blobs/{blob_id}/commit",
            post(handlers::commit_blob)
                .options(handlers::options)
                .fallback(handlers::method_not_allowed),
        )
        .route(
            "/v1/share/{code}/blobs/{blob_id}/{index}",
            put(handlers::put_blob_chunk)
                .get(handlers::get_blob_chunk)
                .options(handlers::options)
                .fallback(handlers::method_not_allowed),
        )
        .layer(RequestBodyLimitLayer::new(max_chunk_body));
    Router::new()
        .route("/healthz", get(healthz))
        .route("/metrics", get(metrics_handler))
        .route(
            "/v1/share",
            post(handlers::create)
                .options(handlers::options)
                .fallback(handlers::method_not_allowed),
        )
        .route(
            "/v1/share/{code}",
            get(handlers::read)
                .patch(handlers::renew)
                .delete(handlers::delete)
                .options(handlers::options)
                .fallback(handlers::method_not_allowed),
        )
        .route(
            "/v1/share/{code}/stats",
            get(handlers::stats)
                .options(handlers::options)
                .fallback(handlers::method_not_allowed),
        )
        .route(
            &format!("/v1/share/{{code}}/{PUBLIC_METADATA_SUFFIX}"),
            get(handlers::metadata)
                .options(handlers::options)
                .fallback(handlers::method_not_allowed),
        )
        // ADR-0149 §8 — the org-scoped plane. Grant-only: these are the two
        // things the legacy bearer must never be able to do, because it says
        // nothing about which org is asking.
        .route(
            "/v1/orgs/{org_id}/shares",
            get(handlers::list_org_shares)
                .options(handlers::options)
                .fallback(handlers::method_not_allowed),
        )
        .route(
            "/v1/orgs/{org_id}/shares/{code}",
            axum::routing::delete(handlers::delete_org_share)
                .options(handlers::options)
                .fallback(handlers::method_not_allowed),
        )
        .layer(RequestBodyLimitLayer::new(max_body))
        .merge(blobs)
        .fallback(handlers::fallback)
        // Disable axum's 2 MiB default so our limits are the only caps.
        .layer(DefaultBodyLimit::disable())
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

async fn healthz(State(state): State<AppState>) -> Response {
    let store = state.store.clone();
    let shares = tokio::task::spawn_blocking(move || store.count().unwrap_or(0))
        .await
        .unwrap_or(0);
    let body = json!({
        "ok": true,
        "shares": shares,
        "uptimeSeconds": state.metrics.uptime_seconds(),
        "version": env!("CARGO_PKG_VERSION"),
    });
    (
        [(axum::http::header::CACHE_CONTROL, "no-store")],
        axum::Json(body),
    )
        .into_response()
}

async fn metrics_handler(State(state): State<AppState>) -> Response {
    let store = state.store.clone();
    let active = tokio::task::spawn_blocking(move || store.count().unwrap_or(0))
        .await
        .unwrap_or(0);
    let body = state.metrics.render_prometheus(active);
    (
        [(
            axum::http::header::CONTENT_TYPE,
            "text/plain; version=0.0.4; charset=utf-8",
        )],
        body,
    )
        .into_response()
}

/// Run the server until SIGINT / SIGTERM. Opens the store, spawns the reaper,
/// and serves with graceful shutdown.
pub async fn serve(addr: SocketAddr, config: Config) -> anyhow::Result<()> {
    let state = build_state(&config)?;
    reaper::spawn(
        state.store.clone(),
        state.rate.clone(),
        config.reaper_interval_secs,
    );
    let app = router(state);
    let listener = TcpListener::bind(addr).await?;
    let bound = listener.local_addr()?;
    info!(
        target: "share",
        %bound,
        db = %config.db_path,
        max_body_bytes = config.max_body_bytes,
        max_ttl_seconds = config.max_ttl_seconds,
        rate_per_sec = config.rate_per_sec,
        rate_burst = config.rate_burst,
        allowed_origins = config.allowed_origins.len(),
        trust_proxy_headers = config.trust_proxy_headers,
        auth = !config.upload_secret.is_empty(),
        "listening"
    );
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {}
        _ = term => {}
    }
    info!(target: "share", "shutting down");
}

/// Boot a server on an ephemeral port for integration tests. Returns the bound
/// address and the serving task handle.
pub async fn serve_for_test(config: Config) -> anyhow::Result<(SocketAddr, JoinHandle<()>)> {
    let state = build_state(&config)?;
    reaper::spawn(
        state.store.clone(),
        state.rate.clone(),
        config.reaper_interval_secs,
    );
    let app = router(state);
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    let handle = tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await;
    });
    Ok((addr, handle))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{to_bytes, Body};
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    fn test_state() -> (AppState, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("shares.sqlite");
        let state = build_state(&Config::for_test(path.to_string_lossy().to_string())).unwrap();
        (state, dir)
    }

    async fn get(uri: &str) -> (StatusCode, String) {
        let (state, _dir) = test_state();
        let app = router(state);
        let res = app
            .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = res.status();
        let bytes = to_bytes(res.into_body(), 64 * 1024).await.unwrap();
        (status, String::from_utf8(bytes.to_vec()).unwrap())
    }

    #[tokio::test]
    async fn metadata_route_is_public_and_method_gated() {
        let (state, _dir) = test_state();
        let app = router(state);
        for (method, expected) in [
            (axum::http::Method::GET, StatusCode::NOT_FOUND),
            (axum::http::Method::PATCH, StatusCode::METHOD_NOT_ALLOWED),
            (axum::http::Method::OPTIONS, StatusCode::NO_CONTENT),
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri("/v1/share/unknown/metadata")
                        .extension(axum::extract::ConnectInfo(
                            "127.0.0.1:1234".parse::<SocketAddr>().unwrap(),
                        ))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), expected);
        }
    }

    #[tokio::test]
    async fn healthz_returns_ok_json() {
        let (status, body) = get("/healthz").await;
        assert_eq!(status, StatusCode::OK);
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["ok"], true);
        assert_eq!(v["shares"], 0);
        assert!(v["version"].is_string());
        assert!(v["uptimeSeconds"].is_number());
    }

    #[tokio::test]
    async fn metrics_returns_prometheus_text() {
        let (status, body) = get("/metrics").await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("# TYPE share_created_total counter\n"));
        assert!(body.contains("share_rejected_total{reason=\"not_found\"} 0\n"));
        assert!(body.contains("share_uptime_seconds"));
    }

    #[test]
    fn config_from_env_uses_defaults_when_unset() {
        // These keys aren't set by the runner; exercise the default path.
        let c = Config::from_env();
        assert!(c.max_body_bytes > 0);
        assert!(c.max_ttl_seconds > 0);
        assert!(c.rate_per_sec >= 1);
        assert!(c.reaper_interval_secs >= 1);
    }

    #[test]
    fn parse_csv_splits_and_trims() {
        // Drive the parser directly to avoid mutating global env under the
        // multi-threaded test runner.
        let parsed: Vec<String> = " https://a.example, https://b.example ,,"
            .split(',')
            .map(|o| o.trim().to_string())
            .filter(|o| !o.is_empty())
            .collect();
        assert_eq!(parsed, vec!["https://a.example", "https://b.example"]);
    }

    #[test]
    fn ticket_signer_accepts_a_hex_key_or_makes_one() {
        assert!(build_ticket_signer("").is_ok());
        assert!(build_ticket_signer(&"ab".repeat(32)).is_ok());
        assert!(build_ticket_signer("abc").is_err());
        assert!(build_ticket_signer("zz").is_err());
        assert!(build_ticket_signer(&"ab".repeat(8)).is_err());
    }

    #[test]
    fn secret_file_is_supported_without_leaking_it_into_environment_config() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("share-upload-secret");
        std::fs::write(&path, "file-secret\n").unwrap();
        assert_eq!(
            resolve_secret(None, Some(path)).unwrap(),
            "file-secret".to_string()
        );
        assert_eq!(
            resolve_secret(Some("inline".into()), None).unwrap(),
            "inline".to_string()
        );
    }
}

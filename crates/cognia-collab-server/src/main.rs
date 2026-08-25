//! Binary entry point for the collaboration plane.

use std::sync::Arc;

use clap::Parser;
use cognia_collab_server::{router, AppState, PgStore};
use cognia_tenant_auth::grant::GrantSigner;
use tracing_subscriber::EnvFilter;

#[derive(Debug, Parser)]
#[command(name = "cognia-collab-server", about = "Cognia collaboration plane")]
struct Args {
    #[arg(long, env = "COLLAB_BIND", default_value = "0.0.0.0:8080")]
    bind: String,
    #[arg(long, env = "COLLAB_DATABASE_URL")]
    database_url: String,
    #[arg(long, env = "COLLAB_DB_MAX_CONNECTIONS", default_value_t = 16)]
    db_max_connections: usize,
    /// Hex-encoded HMAC key for grant signing, at least 32 bytes.
    #[arg(long, env = "COLLAB_GRANT_KEY")]
    grant_key: String,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    // Installed once, before any TLS connector is built. `PgStore::connect`
    // builds a rustls `ClientConfig`, which needs a process-wide provider.
    rustls::crypto::ring::default_provider()
        .install_default()
        .map_err(|_| anyhow::anyhow!("a rustls crypto provider was already installed"))?;

    let args = Args::parse();
    let key = decode_hex(&args.grant_key)
        .ok_or_else(|| anyhow::anyhow!("COLLAB_GRANT_KEY must be hex-encoded"))?;
    let signer = GrantSigner::new(&key)?;

    let store = PgStore::connect(&args.database_url, args.db_max_connections).await?;
    let state = AppState::new(Arc::new(store), signer);

    let listener = tokio::net::TcpListener::bind(&args.bind).await?;
    tracing::info!(bind = %args.bind, "collaboration plane listening");
    axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown())
        .await?;
    Ok(())
}

/// Decode without pulling in `hex` for one call site.
fn decode_hex(value: &str) -> Option<Vec<u8>> {
    let value = value.trim();
    if !value.len().is_multiple_of(2) || value.is_empty() {
        return None;
    }
    (0..value.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&value[index..index + 2], 16).ok())
        .collect()
}

async fn shutdown() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("shutting down");
}

#[cfg(test)]
mod tests {
    use super::decode_hex;

    #[test]
    fn hex_decoding_refuses_the_shapes_a_misconfiguration_produces() {
        assert_eq!(decode_hex("00ff10"), Some(vec![0, 255, 16]));
        // An odd length is a truncated secret, not a short one.
        assert_eq!(decode_hex("abc"), None);
        assert_eq!(decode_hex(""), None);
        assert_eq!(decode_hex("zz"), None);
        assert_eq!(decode_hex("  00ff  "), Some(vec![0, 255]));
    }
}

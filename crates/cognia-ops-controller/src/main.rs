use clap::Parser;
use cognia_ops_controller::{router, AppState, OidcAuthenticator, OidcConfig, PgStore};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;
use tracing::info;
use tracing_subscriber::EnvFilter;

#[derive(Parser)]
struct Args {
    #[arg(long, env = "COGNIA_OPS_LISTEN", default_value = "0.0.0.0:8080")]
    listen: SocketAddr,
    #[arg(long, env = "DATABASE_URL")]
    database_url: String,
    #[arg(long, env = "COGNIA_OPS_OIDC_ISSUER")]
    oidc_issuer: String,
    #[arg(long, env = "COGNIA_OPS_OIDC_AUDIENCE")]
    oidc_audience: String,
    #[arg(
        long,
        env = "COGNIA_OPS_OIDC_TENANT_CLAIM",
        default_value = "organization_id"
    )]
    oidc_tenant_claim: String,
    #[arg(long, env = "COGNIA_OPS_DATABASE_CONNECTIONS", default_value_t = 16)]
    database_connections: usize,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();
    let args = Args::parse();
    let store = Arc::new(PgStore::connect(&args.database_url, args.database_connections).await?);
    let auth = Arc::new(OidcAuthenticator::new(OidcConfig {
        issuer: args.oidc_issuer,
        audience: args.oidc_audience,
        tenant_claim: args.oidc_tenant_claim,
        jwks_ttl: Duration::from_secs(600),
    })?);
    let listener = TcpListener::bind(args.listen).await?;
    info!(address = %listener.local_addr()?, "cognia ops controller listening");
    axum::serve(listener, router(AppState::new(store, auth)))
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            signal.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}

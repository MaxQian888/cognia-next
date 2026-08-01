use clap::Parser;
use cognia_ops_controller::{
    router, AppState, OidcAuthenticator, OidcConfig, OperationSigner, PgStore,
    RcgenCertificateIssuer,
};
use std::net::SocketAddr;
use std::path::PathBuf;
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
    #[arg(long, env = "COGNIA_OPS_AGENT_CA_CERT")]
    agent_ca_certificate: PathBuf,
    #[arg(long, env = "COGNIA_OPS_AGENT_CA_KEY")]
    agent_ca_private_key: PathBuf,
    #[arg(long, env = "COGNIA_OPS_SIGNING_KEY")]
    operation_signing_key: String,
    #[arg(
        long,
        env = "COGNIA_OPS_SIGNING_KEY_ID",
        default_value = "controller-primary"
    )]
    operation_signing_key_id: String,
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
    let ca_certificate_pem = tokio::fs::read_to_string(args.agent_ca_certificate).await?;
    let ca_private_key_pem = tokio::fs::read_to_string(args.agent_ca_private_key).await?;
    let certificate_issuer = RcgenCertificateIssuer::from_pem(
        ca_certificate_pem,
        &ca_private_key_pem,
        chrono::Duration::hours(24),
    )?;
    let operation_signer =
        OperationSigner::from_base64(args.operation_signing_key_id, &args.operation_signing_key)?;
    let listener = TcpListener::bind(args.listen).await?;
    info!(address = %listener.local_addr()?, "cognia ops controller listening");
    let state = AppState::new(store, auth)
        .with_certificate_issuer(certificate_issuer)
        .with_operation_signer(operation_signer);
    axum::serve(listener, router(state))
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

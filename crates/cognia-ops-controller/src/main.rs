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
    #[arg(long, env = "DATABASE_URL", conflicts_with = "database_url_file")]
    database_url: Option<String>,
    #[arg(long, env = "DATABASE_URL_FILE", conflicts_with = "database_url")]
    database_url_file: Option<PathBuf>,
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
    #[arg(long, env = "COGNIA_OPS_SIGNING_KEY_FILE")]
    operation_signing_key_file: PathBuf,
    #[arg(long, env = "COGNIA_OPS_AGENT_PROXY_TOKEN_FILE")]
    agent_proxy_token_file: PathBuf,
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
    let database_url =
        read_value(args.database_url, args.database_url_file, "database URL").await?;
    let store = Arc::new(PgStore::connect(&database_url, args.database_connections).await?);
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
    let operation_signing_key = tokio::fs::read_to_string(args.operation_signing_key_file).await?;
    let operation_signer =
        OperationSigner::from_base64(args.operation_signing_key_id, operation_signing_key.trim())?;
    let agent_proxy_token = tokio::fs::read(args.agent_proxy_token_file).await?;
    let agent_proxy_token = trim_ascii_whitespace(&agent_proxy_token);
    if agent_proxy_token.is_empty() {
        anyhow::bail!("agent proxy authentication token is empty");
    }
    let listener = TcpListener::bind(args.listen).await?;
    info!(address = %listener.local_addr()?, "cognia ops controller listening");
    let state = AppState::new(store, auth)
        .with_certificate_issuer(certificate_issuer)
        .with_operation_signer(operation_signer)
        .with_agent_proxy_token(agent_proxy_token.to_vec());
    axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn read_value(
    inline: Option<String>,
    file: Option<PathBuf>,
    label: &str,
) -> anyhow::Result<String> {
    let value = match (inline, file) {
        (Some(value), None) => value,
        (None, Some(path)) => tokio::fs::read_to_string(path).await?,
        _ => anyhow::bail!("exactly one {label} source must be configured"),
    };
    let value = value.trim().to_owned();
    if value.is_empty() {
        anyhow::bail!("{label} is empty");
    }
    Ok(value)
}

fn trim_ascii_whitespace(mut value: &[u8]) -> &[u8] {
    while value.first().is_some_and(u8::is_ascii_whitespace) {
        value = &value[1..];
    }
    while value.last().is_some_and(u8::is_ascii_whitespace) {
        value = &value[..value.len() - 1];
    }
    value
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

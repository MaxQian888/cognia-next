use std::{sync::Arc, time::Duration};

use anyhow::Context;
use cognia_diagnostic_server::{
    build_router, AppState, ArtifactStore, DiagnosticRepository, GrantSigner, PrivacyGate,
    ServerConfig,
};
use sqlx::postgres::PgPoolOptions;
use tokio::net::TcpListener;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "cognia_diagnostic_server=info,tower_http=info".into()),
        )
        .with(tracing_subscriber::fmt::layer().json())
        .init();

    let config = Arc::new(ServerConfig::from_env()?);
    let pool = PgPoolOptions::new()
        .max_connections(config.database_max_connections)
        .acquire_timeout(Duration::from_secs(10))
        .connect(&config.database_url)
        .await
        .context("connect to diagnostic PostgreSQL")?;
    sqlx::migrate!()
        .run(&pool)
        .await
        .context("run migrations")?;

    let repository = DiagnosticRepository::new(pool);
    let artifacts = ArtifactStore::from_config(&config)?;
    let signer = GrantSigner::new(config.grant_signing_key.as_bytes())?;
    let state = AppState::new(
        config.clone(),
        repository,
        artifacts,
        signer,
        PrivacyGate::v1(),
    );
    let listener = TcpListener::bind(config.bind_address)
        .await
        .context("bind diagnostic service")?;
    tracing::info!(address = %config.bind_address, "diagnostic service listening");
    axum::serve(listener, build_router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("serve diagnostic API")
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("install Ctrl+C handler");
    };
    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("install SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
}

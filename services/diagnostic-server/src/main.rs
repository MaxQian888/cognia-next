use std::{sync::Arc, time::Duration};

use anyhow::Context;
use cognia_diagnostic_server::{
    build_processor, build_router, AppState, ArtifactStore, DiagnosticRepository, GrantSigner,
    PrivacyGate, RetentionWorker, ServerConfig,
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
    if config.migrate_only {
        tracing::info!("diagnostic database migrations completed");
        return Ok(());
    }

    let repository = DiagnosticRepository::new(pool);
    let artifacts = ArtifactStore::from_config(&config, repository.clone())?;
    let signer = GrantSigner::new(config.grant_signing_key.as_bytes())?;
    let privacy = PrivacyGate::v1();
    let processor = config
        .processing_enabled
        .then(|| {
            build_processor(
                repository.clone(),
                artifacts.clone(),
                privacy.clone(),
                &config,
            )
        })
        .transpose()?;
    let retention = config.retention_enabled.then(|| {
        RetentionWorker::new(
            repository.clone(),
            artifacts.clone(),
            config.retention_interval,
            config.retention_batch_size,
        )
    });
    let state = AppState::new(config.clone(), repository, artifacts, signer, privacy);
    let listener = TcpListener::bind(config.bind_address)
        .await
        .context("bind diagnostic service")?;
    tracing::info!(address = %config.bind_address, "diagnostic service listening");
    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
    let mut worker_handles = Vec::new();
    if let Some(processor) = processor {
        worker_handles.push(tokio::spawn(processor.run(shutdown_rx.clone())));
    }
    if let Some(retention) = retention {
        worker_handles.push(tokio::spawn(retention.run(shutdown_rx)));
    }
    let shutdown_signal_tx = shutdown_tx.clone();
    let server_result = axum::serve(listener, build_router(state))
        .with_graceful_shutdown(async move {
            shutdown_signal().await;
            let _ = shutdown_signal_tx.send(true);
        })
        .await;
    let _ = shutdown_tx.send(true);
    for mut handle in worker_handles {
        if tokio::time::timeout(Duration::from_secs(5), &mut handle)
            .await
            .is_err()
        {
            tracing::warn!("diagnostic worker drain timed out; unfinished work remains queued");
            handle.abort();
        }
    }
    server_result.context("serve diagnostic API")
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

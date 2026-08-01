use clap::Parser;
use cognia_deploy_agent::{
    decode_verifying_key, AgentConfig, AgentExecutor, AgentRuntime, PlatformDriver, StateStore,
};
use std::path::PathBuf;
use std::sync::Arc;
use tracing_subscriber::EnvFilter;

#[derive(Parser)]
struct Args {
    #[arg(
        long,
        env = "COGNIA_DEPLOY_AGENT_CONFIG",
        default_value = "/etc/cognia/deploy-agent.yaml"
    )]
    config: PathBuf,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();
    let args = Args::parse();
    let config = AgentConfig::load(&args.config).await?;
    let verifying_key = decode_verifying_key(&config.controller_signing_key)?;
    let driver = Arc::new(PlatformDriver::from_config(config.platform.clone())?);
    let executor = Arc::new(AgentExecutor::new(
        config.target_id.clone(),
        verifying_key,
        StateStore::new(config.state_file.clone()),
        driver,
    ));
    AgentRuntime::new(config, executor).run().await
}

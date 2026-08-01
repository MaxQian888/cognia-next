use clap::{Parser, Subcommand};
use cognia_deploy_agent::{
    decode_verifying_key, enroll, AgentConfig, AgentExecutor, AgentRuntime, EnrollmentOptions,
    PlatformDriver, StateStore,
};
use std::path::PathBuf;
use std::sync::Arc;
use tracing_subscriber::EnvFilter;

#[derive(Parser)]
struct Args {
    #[command(subcommand)]
    command: Option<Command>,
    #[arg(
        long,
        env = "COGNIA_DEPLOY_AGENT_CONFIG",
        default_value = "/etc/cognia/deploy-agent.yaml"
    )]
    config: PathBuf,
}

#[derive(Subcommand)]
enum Command {
    Run,
    Enroll {
        #[arg(long)]
        controller_url: url::Url,
        #[arg(long)]
        token: String,
        #[arg(long)]
        agent_id: String,
        #[arg(long)]
        output_directory: PathBuf,
        #[arg(long)]
        controller_ca_file: Option<PathBuf>,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();
    let args = Args::parse();
    if let Some(Command::Enroll {
        controller_url,
        token,
        agent_id,
        output_directory,
        controller_ca_file,
    }) = args.command
    {
        let bundle = enroll(EnrollmentOptions {
            controller_url,
            token,
            agent_id,
            output_directory,
            controller_ca_file,
        })
        .await?;
        println!("{}", bundle.display());
        return Ok(());
    }
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

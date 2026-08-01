use clap::{Args as ClapArgs, Parser, Subcommand};
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
    Enroll(Box<EnrollArgs>),
}

#[derive(ClapArgs)]
struct EnrollArgs {
    #[arg(long)]
    controller_url: url::Url,
    #[arg(
        long,
        conflicts_with = "token_file",
        required_unless_present = "token_file"
    )]
    token: Option<String>,
    /// Read the single-use enrollment token from an owner-only file so it
    /// never appears in process arguments or shell history.
    #[arg(long, conflicts_with = "token")]
    token_file: Option<PathBuf>,
    #[arg(long)]
    agent_id: String,
    #[arg(long)]
    output_directory: PathBuf,
    #[arg(long)]
    controller_ca_file: Option<PathBuf>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();
    let args = Args::parse();
    if let Some(Command::Enroll(args)) = args.command {
        let EnrollArgs {
            controller_url,
            token,
            token_file,
            agent_id,
            output_directory,
            controller_ca_file,
        } = *args;
        let token = match (token, token_file) {
            (Some(token), None) => token,
            (None, Some(path)) => tokio::fs::read_to_string(path).await?.trim().to_owned(),
            _ => unreachable!("clap enforces exactly one enrollment token source"),
        };
        if token.is_empty() {
            anyhow::bail!("enrollment token must not be empty");
        }
        let result = enroll(EnrollmentOptions {
            controller_url,
            token,
            agent_id,
            output_directory,
            controller_ca_file,
        })
        .await?;
        println!("{}", result.bundle_file.display());
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

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[test]
    fn enrollment_accepts_an_owner_only_token_file() {
        let args = Args::try_parse_from([
            "cognia-deploy-agent",
            "enroll",
            "--controller-url",
            "https://ops.example.com",
            "--token-file",
            "/run/secrets/enrollment-token",
            "--agent-id",
            "staging-agent",
            "--output-directory",
            "/var/lib/cognia-agent/credentials",
        ])
        .expect("token-file enrollment arguments");
        assert!(matches!(
            args.command,
            Some(Command::Enroll(args)) if matches!(*args, EnrollArgs {
                token: None,
                token_file: Some(_),
                ..
            })
        ));
    }

    #[test]
    fn enrollment_rejects_missing_or_ambiguous_token_sources() {
        let base = [
            "cognia-deploy-agent",
            "enroll",
            "--controller-url",
            "https://ops.example.com",
            "--agent-id",
            "staging-agent",
            "--output-directory",
            "/tmp/credentials",
        ];
        assert!(Args::try_parse_from(base).is_err());
        assert!(Args::try_parse_from([
            "cognia-deploy-agent",
            "enroll",
            "--controller-url",
            "https://ops.example.com",
            "--token",
            "one-time",
            "--token-file",
            "/run/secrets/enrollment-token",
            "--agent-id",
            "staging-agent",
            "--output-directory",
            "/tmp/credentials",
        ])
        .is_err());
    }
}

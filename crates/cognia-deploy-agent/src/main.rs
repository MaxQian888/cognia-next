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
    /// Standalone host mode: update one always-on Compose host (ADR-0224 A10).
    #[cfg(unix)]
    HostUpdates(HostUpdatesArgs),
}

#[cfg(unix)]
#[derive(ClapArgs)]
struct HostUpdatesArgs {
    #[command(subcommand)]
    action: HostUpdatesAction,
    /// The Compose project the server runs in (`COGNIA_INSTANCE`).
    #[arg(long, env = "COGNIA_HOST_UPDATES_PROJECT", default_value = "cognia")]
    project: String,
    /// The server's Compose service.
    #[arg(
        long,
        env = "COGNIA_HOST_UPDATES_SERVICE",
        default_value = "cognia-server"
    )]
    service: String,
    /// Where the server asks; a volume only the two containers share.
    #[arg(long, env = "COGNIA_HOST_UPDATES_SOCKET", default_value = cognia_host_service::update_agent::DEFAULT_SOCKET_PATH)]
    socket: PathBuf,
    /// The swap in progress and the catalog trust state.
    #[arg(
        long,
        env = "COGNIA_HOST_UPDATES_STATE_DIR",
        default_value = "/var/lib/cognia-host-updates"
    )]
    state_dir: PathBuf,
    #[arg(long, env = "COGNIA_HOST_UPDATES_DOCKER", default_value = "docker")]
    docker: PathBuf,
    /// `/readyz` as seen from inside the server container.
    #[arg(
        long,
        env = "COGNIA_HOST_UPDATES_READY_URL",
        default_value = "https://localhost:27890/readyz"
    )]
    ready_url: String,
    /// Peers allowed on the socket; the server image runs as 10001.
    #[arg(
        long = "allowed-uid",
        env = "COGNIA_HOST_UPDATES_ALLOWED_UIDS",
        value_delimiter = ',',
        default_value = "10001"
    )]
    allowed_uids: Vec<u32>,
}

#[cfg(unix)]
#[derive(Subcommand)]
enum HostUpdatesAction {
    /// Serve the server's update requests, finishing any swap in progress.
    Run,
    /// Pin the image the server runs now in the project's env file.
    Adopt,
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

    // Installed once, before any TLS connector is built: `reqwest` resolves the
    // process-wide provider at `Client` construction.
    rustls::crypto::ring::default_provider()
        .install_default()
        .map_err(|_| anyhow::anyhow!("a rustls crypto provider was already installed"))?;

    let args = Args::parse();
    #[cfg(unix)]
    if let Some(Command::HostUpdates(args)) = args.command {
        return run_host_updates(args).await;
    }
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

#[cfg(unix)]
async fn run_host_updates(args: HostUpdatesArgs) -> anyhow::Result<()> {
    use cognia_deploy_agent::host_updates::{
        socket, DockerCli, HostUpdateAgent, StateFile, Timing,
    };
    use cognia_update_catalog::client::{self, HttpUpdateNetwork};

    let root = client::trust_root();
    if root.is_none() {
        tracing::warn!(
            "no update trust root (COGNIA_UPDATE_TRUST_ROOT); this agent will refuse every update"
        );
    }
    let agent = HostUpdateAgent::new(
        Arc::new(DockerCli::new(
            args.docker,
            args.project,
            args.service,
            args.ready_url,
        )),
        Arc::new(HttpUpdateNetwork::new(client::update_url())),
        root,
        StateFile::new(args.state_dir),
        Timing::default(),
        Arc::new(|| chrono::Utc::now().timestamp_millis()),
    );
    match args.action {
        HostUpdatesAction::Adopt => {
            let report = agent.adopt().await.map_err(anyhow::Error::msg)?;
            println!("{}", serde_json::to_string_pretty(&report)?);
            Ok(())
        }
        HostUpdatesAction::Run => {
            let listener = socket::bind(&args.socket).map_err(anyhow::Error::msg)?;
            tracing::info!(socket = %args.socket.display(), "host updates listening");
            let resuming = Arc::clone(&agent);
            tokio::spawn(async move {
                resuming.resume().await;
            });
            tokio::select! {
                result = socket::serve(agent, listener, Arc::new(args.allowed_uids)) => {
                    result.map_err(anyhow::Error::msg)
                }
                _ = tokio::signal::ctrl_c() => Ok(()),
            }
        }
    }
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

    #[cfg(unix)]
    #[test]
    fn host_updates_defaults_fit_the_compose_overlay() {
        let args = Args::try_parse_from(["cognia-deploy-agent", "host-updates", "run"])
            .expect("host-updates arguments");
        let Some(Command::HostUpdates(args)) = args.command else {
            panic!("host-updates subcommand");
        };
        assert!(matches!(args.action, HostUpdatesAction::Run));
        assert_eq!(args.service, "cognia-server");
        assert_eq!(
            args.socket,
            PathBuf::from(cognia_host_service::update_agent::DEFAULT_SOCKET_PATH)
        );
        assert_eq!(args.allowed_uids, vec![10001]);

        let args = Args::try_parse_from([
            "cognia-deploy-agent",
            "host-updates",
            "--project",
            "home",
            "--allowed-uid",
            "10001,10002",
            "adopt",
        ])
        .expect("adopt arguments");
        let Some(Command::HostUpdates(args)) = args.command else {
            panic!("host-updates subcommand");
        };
        assert!(matches!(args.action, HostUpdatesAction::Adopt));
        assert_eq!(args.project, "home");
        assert_eq!(args.allowed_uids, vec![10001, 10002]);
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

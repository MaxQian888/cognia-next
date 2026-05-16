//! Entry point for the cognia signaling rendezvous server.
//!
//! ADR-0021: this is a standalone, stateless WebSocket router for WebRTC
//! signaling between paired mobile clients and their home desktop. It must
//! be deployable to any plain TCP host (Fly.io, Railway, a VPS, …) with
//! TLS terminated by the platform.

use std::net::SocketAddr;

use clap::Parser;
use cognia_signaling_server::serve;
use tracing_subscriber::EnvFilter;

#[derive(Debug, Parser)]
#[command(name = "cognia-signaling-server", version, about)]
struct Args {
    /// Address (host:port) to bind. Defaults to 0.0.0.0:$PORT or
    /// 0.0.0.0:7892 if PORT is unset. Most PaaS providers inject PORT.
    #[arg(long, env = "BIND_ADDR")]
    bind: Option<SocketAddr>,

    /// Convenience shortcut for `--bind 0.0.0.0:<port>`. Used by Fly.io /
    /// Railway / Render where only `PORT` is configurable.
    #[arg(long, env = "PORT")]
    port: Option<u16>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info,signaling=info")),
        )
        .with_target(false)
        .init();

    let args = Args::parse();
    let addr = match (args.bind, args.port) {
        (Some(a), _) => a,
        (None, Some(p)) => SocketAddr::from(([0, 0, 0, 0], p)),
        (None, None) => SocketAddr::from(([0, 0, 0, 0], 7892)),
    };

    serve(addr).await
}

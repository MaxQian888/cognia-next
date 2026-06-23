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
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,signaling=info")),
        )
        .with_target(false)
        .init();

    let args = Args::parse();
    serve(resolve_addr(args.bind, args.port)).await
}

/// Resolve the bind address. `--bind` wins outright; otherwise `--port`
/// (or `$PORT`) binds `0.0.0.0:<port>`; otherwise the `0.0.0.0:7892` default.
fn resolve_addr(bind: Option<SocketAddr>, port: Option<u16>) -> SocketAddr {
    match (bind, port) {
        (Some(a), _) => a,
        (None, Some(p)) => SocketAddr::from(([0, 0, 0, 0], p)),
        (None, None) => SocketAddr::from(([0, 0, 0, 0], 7892)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bind_wins_over_port() {
        let bind: SocketAddr = "127.0.0.1:9000".parse().unwrap();
        assert_eq!(resolve_addr(Some(bind), Some(1234)), bind);
    }

    #[test]
    fn port_binds_all_interfaces() {
        assert_eq!(
            resolve_addr(None, Some(8080)),
            SocketAddr::from(([0, 0, 0, 0], 8080))
        );
    }

    #[test]
    fn default_is_7892() {
        assert_eq!(
            resolve_addr(None, None),
            SocketAddr::from(([0, 0, 0, 0], 7892))
        );
    }
}

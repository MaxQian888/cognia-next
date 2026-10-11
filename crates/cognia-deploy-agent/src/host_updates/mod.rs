//! Standalone host mode: update one always-on Compose host (ADR-0224 A10).
//!
//! A personal always-on host run with Docker Compose cannot replace its own
//! image, and it has no Ops Controller to send signed deployment operations.
//! `cognia-deploy-agent host-updates run` sits beside it instead: it holds the
//! Docker socket the server never sees, listens on a Unix socket only the
//! server container shares, and swaps the server image when the server asks,
//! after checking the signed catalog and the rollout gate itself.
//!
//! * [`agent`]: the check, pull, switch and proof, and `adopt`.
//! * [`docker`]: the Compose stack, found through its own labels.
//! * [`env_file`]: the one `.env` line the agent pins the image in.
//! * [`socket`]: the server's way in.
//! * [`state`]: the swap in progress, kept across restarts.
//!
//! The server side is `cognia_companion::host_update` (`InstallKind::Compose`),
//! and the wire format is `cognia_host_service::update_agent`.

pub mod agent;
pub mod docker;
pub mod env_file;
pub mod socket;
pub mod state;

pub use agent::{AdoptReport, HostUpdateAgent, Timing};
pub use docker::{ComposeHost, DockerCli, Readiness, ServerContainer};
pub use state::StateFile;

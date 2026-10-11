//! The Docker API proxy an always-on host reaches the daemon through
//! (ADR-0224 A8).
//!
//! The host runs agent work in containers from its sandbox pool, so it needs
//! the Docker API, and the Docker API is root on the machine. A URL-prefix
//! filter (the `docker-socket-proxy` image this replaces) cannot tell a
//! hardened agent container from a privileged one with the host's root
//! filesystem mounted: both are `POST /containers/create`. This proxy reads
//! the bodies:
//!
//! - [`policy`] decides from the request alone (route, create bodies, list
//!   scoping);
//! - [`proxy`] forwards to the daemon's Unix socket once the daemon confirms
//!   that a named container, exec or volume carries this deployment's labels,
//!   and pipes the hijacked `attach` / `exec start` streams;
//! - [`config`] reads the Compose environment.

pub mod config;
pub mod policy;
pub mod proxy;

#[cfg(test)]
mod tests {
    use crate::policy::{DEPLOYMENT_LABEL, OWNER_LABEL, OWNER_VALUE};

    /// The proxy's labels are the ones the container backend stamps; a rename
    /// on one side without the other would refuse every container the pool
    /// creates.
    #[test]
    fn label_constants_match_the_container_backend() {
        use cognia_external_agent::container_backend as backend;
        assert_eq!(OWNER_LABEL, backend::OWNER_LABEL);
        assert_eq!(OWNER_VALUE, backend::OWNER_VALUE);
        assert_eq!(DEPLOYMENT_LABEL, backend::DEPLOYMENT_LABEL);
    }
}

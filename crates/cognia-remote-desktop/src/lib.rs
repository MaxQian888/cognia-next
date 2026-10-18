//! Host-owned remote desktop control primitives (ADR-0234).
pub mod audit;
pub mod bridge;
pub mod commands;
pub mod control;
pub mod credentials;
pub mod endpoint;
pub mod error;
pub mod host;
pub mod rfb;
pub mod session;
pub mod target;

#[cfg(test)]
mod tests {
    #[test]
    fn fresh_control_is_observer_only() {
        assert!(super::control::ControlLeaseCore::default()
            .status()
            .lease
            .is_none());
    }
}

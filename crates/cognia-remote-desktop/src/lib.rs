//! Host-owned remote desktop control primitives (ADR-0234).
pub mod audit;
pub mod control;

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
